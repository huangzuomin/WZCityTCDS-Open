import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, avg, count, desc, eq, gt, inArray, isNull, like, sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import { linkedCategoryIds } from '../../common/dataset-categories';
import {
  acEntityHits,
  acExtractionContexts,
  acScanJobs,
  categories,
  entities,
  entityAliases,
  sourceArticleBodies,
  sourceArticles,
} from '../../db/schema';
import { AhoCorasick, type AcHit } from '../../common/aho-corasick';
import type { ListContextsDto, ListHitsDto, RunScanDto } from './acscan.dto';

/** 每页读取的文章数（id 游标分页，避免一次性加载全部正文） */
const ARTICLE_PAGE = 500;
/** 上下文/命中落库批量 */
const FLUSH_BATCH = 1000;
/** 每扫描多少篇刷新一次 job 进度（供前端轮询） */
const PROGRESS_EVERY = 500;
/** 句子窗口向两侧扩展的字符上限 */
const SENTENCE_CAP = 200;
/** 句子终止符（sliceBody 以 \n 分段，天然是句子边界） */
const TERMINATORS = new Set(['。', '！', '？', '；', '!', '?', ';', '\n']);

interface KeptHit {
  hit: AcHit;
  entityName: string;
  categoryCode: string;
  ws: number;
  we: number;
  suspect: boolean;
}

interface PendingHit {
  contextKey: string | null;
  values: Omit<typeof acEntityHits.$inferInsert, 'contextId'>;
}

@Injectable()
export class AcScanService {
  /** 运行中的任务 id（同时只允许一个扫描） */
  private runningJobId: number | null = null;

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  // ---------------------------------------------------------------- 触发扫描

  async startRun(dto: RunScanDto) {
    if (this.runningJobId) throw new ConflictException('已有扫描任务在运行，请等待完成');

    const [{ value: total }] = await this.db
      .select({ value: count() })
      .from(sourceArticles)
      .where(eq(sourceArticles.datasetId, dto.datasetId));
    if (!total) throw new BadRequestException('该语料域没有文章');

    const res = (await this.db.insert(acScanJobs).values({
      datasetId: dto.datasetId,
      triggerType: 'manual',
      status: 'running',
      articleTotal: dto.limit ? Math.min(dto.limit, Number(total)) : Number(total),
      startedAt: new Date(),
    })) as unknown as { insertId?: number };

    let jobId = Number(res?.insertId ?? 0);
    if (!jobId) {
      const [row] = await this.db
        .select({ id: acScanJobs.id })
        .from(acScanJobs)
        .orderBy(desc(acScanJobs.id))
        .limit(1);
      jobId = row?.id ?? 0;
    }

    this.runningJobId = jobId;
    // 后台执行，接口立即返回 jobId 供轮询
    void this.executeScan(jobId, dto.datasetId, dto.limit).catch(async (e: unknown) => {
      await this.db
        .update(acScanJobs)
        .set({ status: 'failed', errorMsg: String((e as Error)?.message ?? e), finishedAt: new Date() })
        .where(eq(acScanJobs.id, jobId));
      if (this.runningJobId === jobId) this.runningJobId = null;
    });

    return { jobId, articleTotal: dto.limit ? Math.min(dto.limit, Number(total)) : Number(total) };
  }

  // ---------------------------------------------------------------- 扫描执行

  private async executeScan(jobId: number, datasetId: number, limit?: number) {
    const counters = {
      articleScanned: 0,
      hitArticles: 0,
      rawHits: 0,
      keptHits: 0,
      overlapFiltered: 0,
      suspects: 0,
      contexts: 0,
    };

    // ---- 1. 实体 + 别名 + 类别 → 建树
    const entRows = await this.db
      .select({ id: entities.id, name: entities.name, categoryId: entities.categoryId })
      .from(entities)
      .where(
        and(
          inArray(entities.categoryId, await linkedCategoryIds(this.db, datasetId)),
          isNull(entities.deletedAt),
        ),
      );
    if (!entRows.length) throw new BadRequestException('该语料域没有实体');

    const catRows = await this.db.select({ id: categories.id, code: categories.code }).from(categories);
    const catById = new Map(catRows.map((c) => [c.id, c.code]));
    const entById = new Map(entRows.map((e) => [e.id, e]));

    const aliasRows = await this.db
      .select({ entityId: entityAliases.entityId, alias: entityAliases.alias })
      .from(entityAliases)
      .where(inArray(entityAliases.entityId, entRows.map((e) => e.id)));

    const t0 = Date.now();
    const ac = new AhoCorasick();
    const patternSet = new Set<string>();
    for (const e of entRows) {
      if (e.name) {
        patternSet.add(e.name);
        ac.addPattern(e.name, e.id);
      }
    }
    for (const a of aliasRows) {
      if (a.alias && entById.has(a.entityId)) {
        patternSet.add(a.alias);
        ac.addPattern(a.alias, a.entityId);
      }
    }
    ac.build();
    const buildMs = Date.now() - t0;

    // ---- 2. 游标分页扫正文（bodySlice 已归一化，与证据引句回查同一口径）
    const scanStart = Date.now();
    let lastId = 0;
    const contextRows: (typeof acExtractionContexts.$inferInsert)[] = [];
    const hitRows: PendingHit[] = [];

    const flushContexts = async () => {
      for (let i = 0; i < contextRows.length; i += FLUSH_BATCH) {
        await this.db.insert(acExtractionContexts).values(contextRows.slice(i, i + FLUSH_BATCH));
      }
      contextRows.length = 0;
    };

    const saveProgress = async () => {
      await this.db
        .update(acScanJobs)
        .set({
          articleScanned: counters.articleScanned,
          hitArticleCount: counters.hitArticles,
          rawHitCount: counters.rawHits,
          keptHitCount: counters.keptHits,
          overlapFiltered: counters.overlapFiltered,
          suspectHitCount: counters.suspects,
          contextCount: counters.contexts,
          patternCount: patternSet.size,
          buildMs,
        })
        .where(eq(acScanJobs.id, jobId));
    };

    scanLoop: while (true) {
      const page = await this.db
        .select({ id: sourceArticles.id, bodySlice: sourceArticleBodies.bodySlice })
        .from(sourceArticles)
        .innerJoin(sourceArticleBodies, eq(sourceArticleBodies.articleId, sourceArticles.id))
        .where(and(eq(sourceArticles.datasetId, datasetId), gt(sourceArticles.id, lastId)))
        .orderBy(sourceArticles.id)
        .limit(ARTICLE_PAGE);
      if (!page.length) break;

      for (const row of page) {
        lastId = row.id;
        counters.articleScanned += 1;
        const text = row.bodySlice ?? '';
        if (text) this.scanArticle(jobId, row.id, text, ac, entById, catById, counters, contextRows, hitRows);
        if (limit && counters.articleScanned >= limit) break scanLoop;
      }

      await flushContexts();
      await saveProgress();
    }

    await flushContexts();

    // ---- 3. 回查 context id，回填到命中明细
    const ctxIdByKey = new Map<string, number>();
    const ctxRows = await this.db
      .select({ id: acExtractionContexts.id, articleId: acExtractionContexts.articleId, startPos: acExtractionContexts.startPos })
      .from(acExtractionContexts)
      .where(eq(acExtractionContexts.jobId, jobId));
    for (const c of ctxRows) ctxIdByKey.set(`${c.articleId}:${c.startPos}`, c.id);

    const hitValues = hitRows.map((h) => ({
      ...h.values,
      contextId: h.contextKey ? (ctxIdByKey.get(h.contextKey) ?? null) : null,
    }));
    for (let i = 0; i < hitValues.length; i += FLUSH_BATCH) {
      await this.db.insert(acEntityHits).values(hitValues.slice(i, i + FLUSH_BATCH));
    }

    // ---- 4. 收尾
    await this.db
      .update(acScanJobs)
      .set({
        status: 'succeeded',
        articleScanned: counters.articleScanned,
        hitArticleCount: counters.hitArticles,
        rawHitCount: counters.rawHits,
        keptHitCount: counters.keptHits,
        overlapFiltered: counters.overlapFiltered,
        suspectHitCount: counters.suspects,
        contextCount: counters.contexts,
        patternCount: patternSet.size,
        buildMs,
        scanMs: Date.now() - scanStart,
        finishedAt: new Date(),
      })
      .where(eq(acScanJobs.id, jobId));

    if (this.runningJobId === jobId) this.runningJobId = null;
    return { jobId };
  }

  /** 单篇：AC 扫描 → 去重 → 最长匹配过滤 → 句子窗口 → 按类别合并 */
  private scanArticle(
    jobId: number,
    articleId: number,
    text: string,
    ac: AhoCorasick,
    entById: Map<number, { id: number; name: string; categoryId: number }>,
    catById: Map<number, string>,
    counters: { hitArticles: number; rawHits: number; keptHits: number; overlapFiltered: number; suspects: number; contexts: number },
    contextRows: (typeof acExtractionContexts.$inferInsert)[],
    hitRows: PendingHit[],
  ) {
    // AC 一遍扫描：拿到全部命中（含嵌套重叠，如 大黄鱼 ⊂ 鹿西大黄鱼）
    const raw = ac.search(text);
    counters.rawHits += raw.length;
    if (!raw.length) return;

    // 同实体同位置去重（名称+别名完全相同会重复入树）
    const seen = new Set<string>();
    const uniq: AcHit[] = [];
    for (const h of raw) {
      const key = `${h.entityId}:${h.start}:${h.end}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniq.push(h);
      }
    }

    // 最长匹配过滤：按 start 升序、长度降序；end 覆盖即视为嵌套短词
    uniq.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept: AcHit[] = [];
    let container: AcHit | null = null;
    for (const h of uniq) {
      const sameSpan = container && h.start === container.start && h.end === container.end;
      if (container && h.end <= container.end && !sameSpan) {
        counters.overlapFiltered += 1;
        const ent = entById.get(h.entityId);
        hitRows.push({
          contextKey: null,
          values: {
            jobId,
            articleId,
            entityId: h.entityId,
            entityName: ent?.name ?? h.pattern,
            categoryCode: ent ? (catById.get(ent.categoryId) ?? 'unknown') : 'unknown',
            mention: h.pattern,
            startPos: h.start,
            endPos: h.end,
            isKept: false,
            rejectReason: 'overlap_short',
          },
        });
      } else {
        kept.push(h);
        container = h;
      }
    }
    if (!kept.length) return;
    counters.keptHits += kept.length;
    counters.hitArticles += 1;

    // 保留命中 → 句子窗口（按实体类别分组）
    const byCat = new Map<string, KeptHit[]>();
    for (const h of kept) {
      const ent = entById.get(h.entityId);
      if (!ent) continue;
      const categoryCode = catById.get(ent.categoryId) ?? 'unknown';
      const { ws, we } = this.windowOf(text, h.start, h.end);
      const suspect = this.boundarySuspect(text, h.start, h.end, h.pattern);
      if (suspect) counters.suspects += 1;
      const item: KeptHit = { hit: h, entityName: ent.name, categoryCode, ws, we, suspect };
      const list = byCat.get(categoryCode);
      if (list) list.push(item);
      else byCat.set(categoryCode, [item]);
    }

    // 同类别重叠窗口合并 → 一个上下文（LLM 聚合调用单元）
    for (const [categoryCode, items] of byCat) {
      items.sort((a, b) => a.ws - b.ws);
      let cur = { ws: items[0].ws, we: items[0].we, items: [items[0]] };
      const merged = [cur];
      for (let i = 1; i < items.length; i += 1) {
        const it = items[i];
        if (it.ws <= cur.we) {
          cur.we = Math.max(cur.we, it.we);
          cur.items.push(it);
        } else {
          cur = { ws: it.ws, we: it.we, items: [it] };
          merged.push(cur);
        }
      }
      for (const m of merged) {
        const key = `${articleId}:${m.ws}`;
        contextRows.push({
          jobId,
          articleId,
          categoryCode,
          entityIds: [...new Set(m.items.map((x) => x.hit.entityId))],
          entityNames: [...new Set(m.items.map((x) => x.entityName))],
          hitCount: m.items.length,
          windowText: text.slice(m.ws, m.we),
          startPos: m.ws,
          endPos: m.we,
          windowChars: m.we - m.ws,
          mergeCount: m.items.length,
          status: 'pending_llm',
        });
        counters.contexts += 1;
        // 命中明细此时才知道归属窗口，在合并结果里直接带 key 落行
        for (const it of m.items) {
          hitRows.push({
            contextKey: key,
            values: {
              jobId,
              articleId,
              entityId: it.hit.entityId,
              entityName: it.entityName,
              categoryCode,
              mention: it.hit.pattern,
              startPos: it.hit.start,
              endPos: it.hit.end,
              isKept: true,
              rejectReason: it.suspect ? 'boundary_suspect' : null,
            },
          });
        }
      }
    }
  }

  /** 命中位置 → 完整句子窗口（含句读；两侧上限 SENTENCE_CAP 字符） */
  private windowOf(text: string, start: number, end: number): { ws: number; we: number } {
    let ws = start;
    const backLimit = Math.max(0, start - SENTENCE_CAP);
    while (ws > backLimit && !TERMINATORS.has(text[ws - 1])) ws -= 1;

    let we = end;
    const fwdLimit = Math.min(text.length, end + SENTENCE_CAP);
    while (we < fwdLimit && !TERMINATORS.has(text[we])) we += 1;
    if (we < text.length && TERMINATORS.has(text[we])) we += 1;

    return { ws, we };
  }

  /**
   * 边界校验：中文无分词边界不做判断；含字母数字的词条（型号/缩写）
   * 要求两侧不是字母数字，避免 G20 命中 G2000 之类的子串误报。
   */
  private boundarySuspect(text: string, start: number, end: number, pattern: string): boolean {
    if (!/[A-Za-z0-9]/.test(pattern)) return false;
    const bad = /[A-Za-z0-9]/;
    const prev = start > 0 ? text[start - 1] : '';
    const next = end < text.length ? text[end] : '';
    return bad.test(prev) || bad.test(next);
  }

  // ---------------------------------------------------------------- 查询

  async latestJob() {
    const [job] = await this.db.select().from(acScanJobs).orderBy(desc(acScanJobs.id)).limit(1);
    return job ?? null;
  }

  private async resolveJobId(jobId?: number): Promise<number> {
    if (jobId) return jobId;
    const job = await this.latestJob();
    if (!job) throw new NotFoundException('还没有扫描任务，请先触发一次全量扫描');
    return job.id;
  }

  async stats(jobId?: number) {
    const id = await this.resolveJobId(jobId);
    const [job] = await this.db.select().from(acScanJobs).where(eq(acScanJobs.id, id)).limit(1);
    if (!job) throw new NotFoundException('任务不存在');

    const catCtx = await this.db
      .select({
        categoryCode: acExtractionContexts.categoryCode,
        contexts: count(),
        avgChars: avg(acExtractionContexts.windowChars),
        avgMerge: avg(acExtractionContexts.mergeCount),
      })
      .from(acExtractionContexts)
      .where(eq(acExtractionContexts.jobId, id))
      .groupBy(acExtractionContexts.categoryCode);

    const catHits = await this.db
      .select({ categoryCode: acEntityHits.categoryCode, hits: count() })
      .from(acEntityHits)
      .where(and(eq(acEntityHits.jobId, id), eq(acEntityHits.isKept, true)))
      .groupBy(acEntityHits.categoryCode);

    const topEntities = await this.db
      .select({ entityId: acEntityHits.entityId, entityName: acEntityHits.entityName, categoryCode: acEntityHits.categoryCode, hits: count() })
      .from(acEntityHits)
      .where(and(eq(acEntityHits.jobId, id), eq(acEntityHits.isKept, true)))
      .groupBy(acEntityHits.entityId, acEntityHits.entityName, acEntityHits.categoryCode)
      .orderBy(desc(count()))
      .limit(15);

    const statusDist = await this.db
      .select({ status: acExtractionContexts.status, cnt: count() })
      .from(acExtractionContexts)
      .where(eq(acExtractionContexts.jobId, id))
      .groupBy(acExtractionContexts.status);

    const lenDist = await this.db
      .select({
        bucket: sql<string>`CASE WHEN window_chars <= 60 THEN 'a' WHEN window_chars <= 120 THEN 'b' WHEN window_chars <= 200 THEN 'c' ELSE 'd' END`,
        cnt: count(),
      })
      .from(acExtractionContexts)
      .where(eq(acExtractionContexts.jobId, id))
      .groupBy(sql`1`);

    return {
      job,
      categories: catCtx.map((c) => ({
        categoryCode: c.categoryCode,
        contexts: Number(c.contexts),
        avgWindowChars: Math.round(Number(c.avgChars ?? 0)),
        avgMerge: Number(Number(c.avgMerge ?? 0).toFixed(2)),
        hits: Number(catHits.find((h) => h.categoryCode === c.categoryCode)?.hits ?? 0),
      })),
      topEntities: topEntities.map((t) => ({ ...t, hits: Number(t.hits) })),
      statusDist: statusDist.map((s) => ({ ...s, cnt: Number(s.cnt) })),
      lenDist: ['a', 'b', 'c', 'd'].map((k) => ({
        bucket: { a: '≤60字', b: '61-120字', c: '121-200字', d: '200+字' }[k] as string,
        cnt: Number(lenDist.find((l) => l.bucket === k)?.cnt ?? 0),
      })),
    };
  }

  async listHits(query: ListHitsDto) {
    const jobId = await this.resolveJobId(query.jobId);
    const where = and(
      eq(acEntityHits.jobId, jobId),
      query.filter === 'kept' ? eq(acEntityHits.isKept, true) : undefined,
      query.filter === 'rejected' ? eq(acEntityHits.isKept, false) : undefined,
      query.category ? eq(acEntityHits.categoryCode, query.category) : undefined,
      query.entityId ? eq(acEntityHits.entityId, query.entityId) : undefined,
      query.articleId ? eq(acEntityHits.articleId, query.articleId) : undefined,
    );

    const [{ value: total }] = await this.db.select({ value: count() }).from(acEntityHits).where(where);
    const rows = await this.db
      .select({
        id: acEntityHits.id,
        articleId: acEntityHits.articleId,
        articleTitle: sourceArticles.title,
        entityId: acEntityHits.entityId,
        entityName: acEntityHits.entityName,
        categoryCode: acEntityHits.categoryCode,
        mention: acEntityHits.mention,
        startPos: acEntityHits.startPos,
        endPos: acEntityHits.endPos,
        isKept: acEntityHits.isKept,
        rejectReason: acEntityHits.rejectReason,
        contextId: acEntityHits.contextId,
      })
      .from(acEntityHits)
      .leftJoin(sourceArticles, eq(acEntityHits.articleId, sourceArticles.id))
      .where(where)
      .orderBy(desc(acEntityHits.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return { items: rows, total: Number(total), page: query.page, pageSize: query.pageSize, jobId };
  }

  async listContexts(query: ListContextsDto) {
    const jobId = await this.resolveJobId(query.jobId);
    const entitySub = query.entityId
      ? sql`${acExtractionContexts.id} IN (SELECT context_id FROM ac_entity_hit WHERE entity_id = ${query.entityId} AND is_kept = 1 AND context_id IS NOT NULL)`
      : undefined;
    const where = and(
      eq(acExtractionContexts.jobId, jobId),
      query.category ? eq(acExtractionContexts.categoryCode, query.category) : undefined,
      query.articleId ? eq(acExtractionContexts.articleId, query.articleId) : undefined,
      query.keyword ? like(acExtractionContexts.windowText, `%${query.keyword}%`) : undefined,
      entitySub,
    );

    const [{ value: total }] = await this.db
      .select({ value: count() })
      .from(acExtractionContexts)
      .where(where);
    const rows = await this.db
      .select({
        id: acExtractionContexts.id,
        articleId: acExtractionContexts.articleId,
        articleTitle: sourceArticles.title,
        publishedAt: sourceArticles.publishedAt,
        sourceOrg: sourceArticles.sourceOrg,
        categoryCode: acExtractionContexts.categoryCode,
        entityIds: acExtractionContexts.entityIds,
        entityNames: acExtractionContexts.entityNames,
        hitCount: acExtractionContexts.hitCount,
        windowText: acExtractionContexts.windowText,
        startPos: acExtractionContexts.startPos,
        endPos: acExtractionContexts.endPos,
        windowChars: acExtractionContexts.windowChars,
        mergeCount: acExtractionContexts.mergeCount,
        status: acExtractionContexts.status,
      })
      .from(acExtractionContexts)
      .leftJoin(sourceArticles, eq(acExtractionContexts.articleId, sourceArticles.id))
      .where(where)
      .orderBy(desc(acExtractionContexts.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return { items: rows, total: Number(total), page: query.page, pageSize: query.pageSize, jobId };
  }

  async contextDetail(id: number) {
    const [ctx] = await this.db.select().from(acExtractionContexts).where(eq(acExtractionContexts.id, id)).limit(1);
    if (!ctx) throw new NotFoundException('上下文不存在');
    const [article] = await this.db
      .select({ id: sourceArticles.id, title: sourceArticles.title, url: sourceArticles.url, sourceOrg: sourceArticles.sourceOrg, publishedAt: sourceArticles.publishedAt })
      .from(sourceArticles)
      .where(eq(sourceArticles.id, ctx.articleId))
      .limit(1);
    const hits = await this.db
      .select({
        id: acEntityHits.id,
        entityId: acEntityHits.entityId,
        entityName: acEntityHits.entityName,
        categoryCode: acEntityHits.categoryCode,
        mention: acEntityHits.mention,
        startPos: acEntityHits.startPos,
        endPos: acEntityHits.endPos,
      })
      .from(acEntityHits)
      .where(and(eq(acEntityHits.contextId, id), eq(acEntityHits.isKept, true)))
      .orderBy(acEntityHits.startPos);
    return { ...ctx, article: article ?? null, hits };
  }
}
