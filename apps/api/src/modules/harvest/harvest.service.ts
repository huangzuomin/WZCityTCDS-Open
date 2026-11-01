/**
 * harvest.service.ts —— 任务计划：新闻源持续更新
 *
 * 执行链（一次 run）：
 *   发布实体 → websearch（site: 域名 + 实体名/别名，多变体，2s 限速）
 *   → URL 规范化去重（剥跟踪参数）→ 过滤已在库语料
 *   → 采集页面（标题/日期/正文）→ 语料入库（incremental + 倒排召回）
 *   → 规则抽取器跑草稿 → draft 模式待人工审核 / auto 模式校验全过自动应用
 *
 * 调度：每分钟 tick 一次，扫描 enabled 且 nextRunAt 到期的任务。
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import { linkedCategoryIds } from '../../common/dataset-categories';
import { Inject } from '@nestjs/common';
import {
  entityAliases,
  entities,
  harvestRuns,
  harvestTasks,
  sourceArticles,
  systemSettings,
} from '../../db/schema';
import { ArticleService } from '../article/article.service';
import { websearch, tokenInfo, WebsearchTokenExpiredError, type WebsearchReference } from './websearch';
import { fetchPage } from './page-collector';

const TOKEN_KEY = 'websearch_token';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date();
const ts = () => new Date().toTimeString().slice(0, 8);

export interface HarvestTaskDto {
  id: number;
  datasetId: number;
  name: string;
  siteDomains: string;
  queriesPerEntity: number;
  applyMode: 'draft' | 'auto';
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
}

@Injectable()
export class HarvestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HarvestService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 运行中守卫：同任务不并发 */
  private readonly activeTasks = new Set<number>();

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly articleService: ArticleService,
  ) {}

  // ---------------------------------------------------------------- 调度

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 60_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    try {
      const due = await this.db
        .select()
        .from(harvestTasks)
        .where(and(eq(harvestTasks.enabled, true), lte(harvestTasks.nextRunAt, now())))
        .limit(10);
      for (const task of due) {
        if (this.activeTasks.has(task.id)) continue;
        // 先推进 nextRunAt，防止下一分钟重复触发
        await this.db
          .update(harvestTasks)
          .set({ nextRunAt: new Date(Date.now() + task.intervalMinutes * 60_000) })
          .where(eq(harvestTasks.id, task.id));
        void this.execute(task.id, 'schedule').catch((err: Error) =>
          this.logger.error(`任务 ${task.id} 定时执行失败：${err.message}`),
        );
      }
    } catch (err) {
      this.logger.warn(`调度 tick 异常：${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- 任务 CRUD

  async listTasks(datasetId?: number) {
    const rows = await this.db
      .select()
      .from(harvestTasks)
      .where(datasetId ? eq(harvestTasks.datasetId, datasetId) : undefined)
      .orderBy(desc(harvestTasks.id))
      .limit(100);
    // 附最后一次运行摘要
    const ids = rows.map((r) => r.id);
    const lastRuns = ids.length
      ? await this.db
          .select({
            taskId: harvestRuns.taskId,
            id: harvestRuns.id,
            status: harvestRuns.status,
            startedAt: harvestRuns.startedAt,
            finishedAt: harvestRuns.finishedAt,
            statsJson: harvestRuns.statsJson,
          })
          .from(harvestRuns)
          .where(inArray(harvestRuns.taskId, ids))
          .orderBy(desc(harvestRuns.id))
          .limit(500)
      : [];
    const lastByTask = new Map<number, (typeof lastRuns)[number]>();
    for (const r of lastRuns) if (!lastByTask.has(r.taskId)) lastByTask.set(r.taskId, r);
    return rows.map((r) => ({ ...r, lastRun: lastByTask.get(r.id) ?? null }));
  }

  async createTask(
    dto: {
      datasetId: number;
      name: string;
      siteDomains?: string;
      queriesPerEntity?: number;
      applyMode?: 'draft' | 'auto';
      intervalMinutes?: number;
      enabled?: boolean;
    },
    userId?: number,
  ) {
    const [ins] = await this.db.insert(harvestTasks).values({
      datasetId: dto.datasetId,
      name: dto.name,
      siteDomains: dto.siteDomains ?? '66wz.com',
      queriesPerEntity: dto.queriesPerEntity ?? 3,
      applyMode: dto.applyMode ?? 'draft',
      intervalMinutes: dto.intervalMinutes ?? 1440,
      enabled: dto.enabled ?? true,
      nextRunAt: new Date(Date.now() + 5 * 60_000),
      createdBy: userId ?? null,
    });
    return this.getTask(Number(ins.insertId));
  }

  async updateTask(
    id: number,
    dto: Partial<{
      name: string;
      siteDomains: string;
      queriesPerEntity: number;
      applyMode: 'draft' | 'auto';
      intervalMinutes: number;
      enabled: boolean;
    }>,
  ) {
    const [row] = await this.db.select().from(harvestTasks).where(eq(harvestTasks.id, id)).limit(1);
    if (!row) throw new NotFoundException('任务不存在');
    await this.db
      .update(harvestTasks)
      .set({
        name: dto.name ?? row.name,
        siteDomains: dto.siteDomains ?? row.siteDomains,
        queriesPerEntity: dto.queriesPerEntity ?? row.queriesPerEntity,
        applyMode: dto.applyMode ?? row.applyMode,
        intervalMinutes: dto.intervalMinutes ?? row.intervalMinutes,
        enabled: dto.enabled ?? row.enabled,
      })
      .where(eq(harvestTasks.id, id));
    return this.getTask(id);
  }

  async deleteTask(id: number) {
    await this.db.delete(harvestTasks).where(eq(harvestTasks.id, id));
    await this.db.delete(harvestRuns).where(eq(harvestRuns.taskId, id));
    return { deleted: true };
  }

  async getTask(id: number) {
    const [row] = await this.db.select().from(harvestTasks).where(eq(harvestTasks.id, id)).limit(1);
    if (!row) throw new NotFoundException('任务不存在');
    return row;
  }

  // ---------------------------------------------------------------- token 配置

  private async getToken(): Promise<{ token: string | null; source: 'db' | 'env' | 'none' }> {
    const [row] = await this.db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.skey, TOKEN_KEY))
      .limit(1);
    if (row?.svalue) return { token: row.svalue, source: 'db' };
    const env = process.env.TRAE_IDE_TOKEN;
    if (env) return { token: env, source: 'env' };
    return { token: null, source: 'none' };
  }

  async getConfig() {
    const { token, source } = await this.getToken();
    if (!token) return { tokenSet: false, source, expired: null, daysLeft: null, exp: null, preview: null };
    const info = tokenInfo(token);
    return {
      tokenSet: true,
      source,
      ...info,
      preview: `${token.slice(0, 24)}…${token.slice(-12)}`,
    };
  }

  async saveToken(token: string) {
    const t = token.trim();
    if (!t || t.split('.').length !== 3) throw new BadRequestException('token 格式不像 JWT（应为三段式）');
    await this.db
      .insert(systemSettings)
      .values({ skey: TOKEN_KEY, svalue: t })
      .onDuplicateKeyUpdate({ set: { svalue: t } });
    return this.getConfig();
  }

  async testToken(query = '温州 瓯菜') {
    const { token } = await this.getToken();
    if (!token) throw new BadRequestException('尚未配置 token');
    const refs = await websearch(`site:66wz.com ${query}`, token);
    return {
      ok: true,
      count: refs.length,
      refs: refs.slice(0, 5).map((r) => ({ title: r.title, uri: r.uri })),
    };
  }

  // ---------------------------------------------------------------- 运行记录

  async listRuns(taskId?: number, page = 1, pageSize = 20) {
    const where = taskId ? eq(harvestRuns.taskId, taskId) : undefined;
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(harvestRuns)
        .where(where)
        .orderBy(desc(harvestRuns.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ total: sql<number>`count(*)` }).from(harvestRuns).where(where),
    ]);
    return { items: rows, total: Number(total) };
  }

  async getRun(id: number) {
    const [row] = await this.db.select().from(harvestRuns).where(eq(harvestRuns.id, id)).limit(1);
    if (!row) throw new NotFoundException('运行记录不存在');
    return row;
  }

  /** 手动触发：立即执行一次（不影响 nextRunAt 节奏） */
  async triggerRun(taskId: number, userId?: number) {
    const task = await this.getTask(taskId);
    if (this.activeTasks.has(task.id)) throw new BadRequestException('该任务正在运行中');
    const runId = await this.execute(task.id, 'manual', userId).catch(async (err: Error) => {
      // execute 内部已落 run 失败态；这里兜底 rethrow
      throw err;
    });
    return { runId };
  }

  // ---------------------------------------------------------------- 执行链

  private async execute(taskId: number, trigger: 'schedule' | 'manual', userId?: number): Promise<number> {
    const task = await this.getTask(taskId);
    this.activeTasks.add(task.id);

    const log: string[] = [];
    const stats: {
      trigger: string; entities: number; searchCalls: number; refsTotal: number; newUrls: number;
      pagesOk: number; pagesFail: number; articlesInserted: number; hits: number;
      drafts: number; autoApproved: number; extractionRunId: number | null;
    } = { trigger, entities: 0, searchCalls: 0, refsTotal: 0, newUrls: 0, pagesOk: 0, pagesFail: 0, articlesInserted: 0, hits: 0, drafts: 0, autoApproved: 0, extractionRunId: null };
    const pushLog = (m: string) => {
      log.push(`[${ts()}] ${m}`);
      this.logger.log(`harvest#${taskId} ${m}`);
    };

    const [runIns] = await this.db.insert(harvestRuns).values({
      taskId: task.id,
      triggerType: trigger,
      status: 'running',
      startedAt: now(),
      statsJson: stats,
      logJson: log,
    });
    const runId = Number(runIns.insertId);
    const finish = async (status: 'succeeded' | 'failed', errorMsg?: string) => {
      await this.db
        .update(harvestRuns)
        .set({ status, statsJson: stats, logJson: log.slice(-500), errorMsg: errorMsg ?? null, finishedAt: now() })
        .where(eq(harvestRuns.id, runId));
      await this.db.update(harvestTasks).set({ lastRunAt: now() }).where(eq(harvestTasks.id, task.id));
      this.activeTasks.delete(task.id);
    };

    try {
      // ---- 0. 前置：token
      const { token } = await this.getToken();
      if (!token) throw new BadRequestException('尚未配置 websearch token');
      const domains = task.siteDomains.split(',').map((d) => d.trim()).filter(Boolean);
      if (!domains.length) throw new BadRequestException('site_domains 为空');
      pushLog(`开始：域 ${domains.join(',')} · 模式 ${task.applyMode}`);

      // ---- 1. 发布实体 + 别名
      const pubEntities = await this.db
        .select({ id: entities.id, name: entities.name })
        .from(entities)
        .where(
          and(
            inArray(entities.categoryId, await linkedCategoryIds(this.db, task.datasetId)),
            eq(entities.status, 'published'),
          ),
        )
        .limit(500);
      if (!pubEntities.length) throw new BadRequestException('该语料域没有已发布实体');
      stats.entities = pubEntities.length;
      const aliasRows = await this.db
        .select({ entityId: entityAliases.entityId, alias: entityAliases.alias })
        .from(entityAliases)
        .where(inArray(entityAliases.entityId, pubEntities.map((e) => e.id)));
      const aliasMap = new Map<number, string[]>();
      for (const a of aliasRows) {
        const list = aliasMap.get(a.entityId) ?? [];
        list.push(a.alias);
        aliasMap.set(a.entityId, list);
      }
      pushLog(`发布实体 ${pubEntities.length} 个（含别名 ${aliasRows.length} 条）`);

      // ---- 2. websearch（每实体多变体，2s 限速）
      const refMap = new Map<string, WebsearchReference>();
      for (const ent of pubEntities) {
        const variants = [ent.name, ...(aliasMap.get(ent.id) ?? []), `温州 ${ent.name}`]
          .slice(0, Math.max(1, task.queriesPerEntity));
        for (const v of variants) {
          for (const domain of domains) {
            try {
              const refs = await websearch(`site:${domain} ${v}`, token);
              stats.searchCalls += 1;
              stats.refsTotal += refs.length;
              for (const r of refs) refMap.set(normalizeUrl(r.uri), r);
              pushLog(`搜索「site:${domain} ${v}」→ ${refs.length} 条`);
            } catch (err) {
              if (err instanceof WebsearchTokenExpiredError) throw err;
              pushLog(`搜索失败「${v}」：${(err as Error).message.slice(0, 80)}`);
            }
            await sleep(2000); // 风控限速
          }
        }
      }
      if (!refMap.size) {
        pushLog('未命中任何结果，结束');
        await finish('succeeded');
        return runId;
      }

      // ---- 3. 域名过滤 + 在库去重
      const candidates = [...refMap.values()].filter((r) => matchDomains(r.uri, domains));
      const urls = candidates.map((r) => normalizeUrl(r.uri));
      const existing = urls.length
        ? await this.db
            .select({ url: sourceArticles.url })
            .from(sourceArticles)
            .where(and(eq(sourceArticles.datasetId, task.datasetId), inArray(sourceArticles.url, urls)))
        : [];
      const existingSet = new Set(existing.map((e) => e.url));
      const fresh = candidates.filter((r) => !existingSet.has(normalizeUrl(r.uri)));
      stats.newUrls = fresh.length;
      pushLog(`命中 ${candidates.length} 条（域过滤后），已在库 ${existingSet.size} 条，待采集 ${fresh.length} 条`);
      if (!fresh.length) {
        pushLog('没有新语料，结束');
        await finish('succeeded');
        return runId;
      }

      // ---- 4. 采集页面（1s 限速）
      const pages: { url: string; title: string; text: string; pubDate: string | null; sourceName: string | null; externalId: string | null }[] = [];
      for (const r of fresh) {
        try {
          const page = await fetchPage(r.uri);
          if (page.text.length < 120) {
            stats.pagesFail += 1;
            pushLog(`正文过短丢弃：${page.title.slice(0, 30) || r.uri}`);
          } else {
            stats.pagesOk += 1;
            pages.push({
              url: normalizeUrl(page.url),
              title: page.title || r.title,
              text: page.text,
              pubDate: page.pubDate,
              sourceName: page.sourceName,
              externalId: extractArticleId(page.url),
            });
          }
        } catch (err) {
          stats.pagesFail += 1;
          pushLog(`采集失败：${(err as Error).message.slice(0, 60)} ${r.uri}`);
        }
        await sleep(1000);
      }
      pushLog(`采集完成：成功 ${stats.pagesOk} · 失败 ${stats.pagesFail}`);
      if (!pages.length) {
        await finish('succeeded');
        return runId;
      }

      // ---- 5. 语料入库（增量批次 + 倒排召回）
      const imported = await this.articleService.importArticles({
        datasetId: task.datasetId,
        batch: 'incremental',
        dedupeTitleDay: true,
        fuzzyDedupe: { enabled: true, bodyThreshold: 0.8, titleThreshold: 0.9, lookbackDays: 7 },
        buildHits: true,
        items: pages.map((p) => ({
          title: p.title,
          url: p.url,
          text: p.text,
          sourceOrg: p.sourceName ?? '温州网',
          sourceSite: domains[0]?.replace(/\./g, '') ?? '66wz',
          publishedAt: p.pubDate,
          externalId: p.externalId ?? undefined,
          quality: 'B',
        })),
      });
      stats.articlesInserted = imported.inserted;
      stats.hits = imported.hits;
      pushLog(`语料入库：新增 ${imported.inserted}（URL 重复 ${imported.duplicateUrl} · 正文重复 ${imported.duplicateContent}）· 倒排 ${imported.hits}`);
      if (!imported.insertedIds.length) {
        pushLog('没有新文章入库，结束');
        await finish('succeeded');
        return runId;
      }

      // ---- 6. 抽取交给生产线（发现审核 → 实体/事实草稿）
      // 采集只负责「采集 + 语料入库」；抽取由「生产线」菜单里的 discovery 队列负责：
      // 语料入队（POST /discovery/queue）→ 跑批（POST /discovery/run），草稿进入「发现审核」。
      pushLog(`语料入库 ${imported.insertedIds.length} 篇，请到「生产线」抽样入队后跑批抽取（旧规则抽取管线已下线）`);
      stats.drafts = 0;

      await finish('succeeded');
      return runId;
    } catch (err) {
      const msg = err instanceof WebsearchTokenExpiredError ? err.message : (err as Error).message;
      pushLog(`失败：${msg}`);
      await finish('failed', msg);
      throw err;
    }
  }
}

// ---------------------------------------------------------------- URL 工具

/** 规范化：剥 query/hash（66wz 跟踪参数 ?_t_t_t=）、主机小写 */
export function normalizeUrl(uri: string): string {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname}`.replace(/\/$/, '');
  } catch {
    return uri.trim();
  }
}

/** 域名白名单（子域算命中） */
export function matchDomains(uri: string, domains: string[]): boolean {
  try {
    const host = new URL(uri).host.toLowerCase();
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** 从 URL 提取文章 ID（66wz 形如 /system/2026/04/02/105734433.shtml → 105734433） */
export function extractArticleId(uri: string): string | null {
  const m = uri.match(/(\d{6,})\.shtml/i) ?? uri.match(/(\d{6,})(?:[/?#]|$)/);
  return m?.[1] ?? null;
}
