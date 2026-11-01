import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, count, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import {
  entities,
  events,
  facts,
  probeQuestions,
  probeResults,
  probeRuns,
  sourceArticles,
} from '../../db/schema';
import { ProbeModelConfigService } from './probe-model-config.service';
import type {
  CitedStatus,
  ObservatoryEventTrack,
  ObservatoryMetrics,
  ObservatoryQuestionRow,
  ObservatorySnapshot,
  ObservatoryWeekStat,
  ProbeModelConfig,
} from './observatory.types';

type ProbeQuestionRow = typeof probeQuestions.$inferSelect;
type ProbeResultRow = typeof probeResults.$inferSelect;

export interface ListQuestionQuery {
  page?: number;
  pageSize?: number;
  status?: 'active' | 'disabled';
  category?: string;
  keyword?: string;
}

@Injectable()
export class ObservatoryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly config: ConfigService,
    private readonly modelConfig: ProbeModelConfigService,
  ) {}

  // ---------------------------------------------------------------- 问题管理

  async listQuestions(query: ListQuestionQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const conditions = [
      query.status ? eq(probeQuestions.status, query.status) : null,
      query.category ? eq(probeQuestions.category, query.category as ProbeQuestionRow['category']) : null,
      query.keyword ? like(probeQuestions.question, `%${query.keyword}%`) : null,
    ].filter((c): c is NonNullable<typeof c> => c != null);
    const where = conditions.length ? and(...conditions) : undefined;
    const [{ value: total }] = await this.db
      .select({ value: count() })
      .from(probeQuestions)
      .where(where);
    const items = await this.db
      .select()
      .from(probeQuestions)
      .where(where)
      .orderBy(desc(probeQuestions.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { items, total, page, pageSize };
  }

  async createQuestion(dto: Record<string, unknown>): Promise<ProbeQuestionRow> {
    const [ins] = await this.db.insert(probeQuestions).values({
      question: String(dto.question ?? ''),
      expectedAnswer: String(dto.expectedAnswer ?? ''),
      category: (dto.category as ProbeQuestionRow['category']) ?? 'fact',
      status: (dto.status as 'active' | 'disabled') ?? 'active',
      factId: dto.factId != null ? Number(dto.factId) : null,
      entityId: dto.entityId != null ? Number(dto.entityId) : null,
    } as typeof probeQuestions.$inferInsert);
    const [row] = await this.db.select().from(probeQuestions).where(eq(probeQuestions.id, Number(ins.insertId))).limit(1);
    return row;
  }

  async updateQuestion(id: number, dto: Record<string, unknown>): Promise<ProbeQuestionRow> {
    const patch: Record<string, unknown> = {};
    if (dto.question !== undefined) patch.question = String(dto.question);
    if (dto.expectedAnswer !== undefined) patch.expectedAnswer = String(dto.expectedAnswer);
    if (dto.category !== undefined) patch.category = dto.category;
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.factId !== undefined) patch.factId = dto.factId != null ? Number(dto.factId) : null;
    if (dto.entityId !== undefined) patch.entityId = dto.entityId != null ? Number(dto.entityId) : null;
    if (Object.keys(patch).length) {
      await this.db
        .update(probeQuestions)
        .set(patch as unknown as Partial<typeof probeQuestions.$inferInsert>)
        .where(eq(probeQuestions.id, id));
    }
    const [row] = await this.db.select().from(probeQuestions).where(eq(probeQuestions.id, id)).limit(1);
    return row;
  }

  async deleteQuestion(id: number): Promise<{ deleted: boolean }> {
    await this.db.delete(probeQuestions).where(eq(probeQuestions.id, id));
    return { deleted: true };
  }

  /** 某题的「大模型回答记录」：按探测时间倒序返回各模型原文与引用判定 */
  async getQuestionAnswers(questionId: number) {
    const models = await this.modelConfig.list();
    const enabledIds = new Set(models.filter((m) => m.enabled).map((m) => m.id));
    // websearch 子通道标签：websearch-unified:doubao -> 豆包（配置里只有父模型）
    const CH_LABELS: Record<string, string> = { doubao: '豆包', yuanbao: '元宝', trae: '字节TRAE', codebuddy: '腾讯CodeBuddy', unified: '统一联网搜索' };
    const labelOf = (id: string) => {
      if (models.some((m) => m.id === id)) return models.find((m) => m.id === id)!.label;
      const idx = id.indexOf(':');
      if (idx > 0) {
        const parent = id.slice(0, idx);
        const ch = id.slice(idx + 1);
        // 已知通道取中文名；服务端新增的未知通道按原名展示（父模型仍在配置里才计）
        if (enabledIds.has(parent)) return CH_LABELS[ch] ?? ch;
      }
      return null; // 已删除的模型 -> 过滤
    };
    const rows = await this.db
      .select()
      .from(probeResults)
      .where(eq(probeResults.questionId, questionId))
      .orderBy(desc(probeResults.probedAt));
    return rows
      .map((r) => ({
        runId: r.runId,
        modelId: r.modelId,
        modelLabel: labelOf(r.modelId),
        cited: r.cited,
        matchMethod: r.matchMethod,
        sourceUrls: r.sourceUrls,
        matchedUrl: r.matchedUrl,
        excerpt: r.excerpt,
        rawAnswer: r.rawAnswer,
        probedAt: r.probedAt,
      }))
      .filter((a): a is NonNullable<typeof a> => a.modelLabel != null);
  }

  // ---------------------------------------------------------------- 快照聚合

  async getSnapshot(): Promise<ObservatorySnapshot> {
    const models: ProbeModelConfig[] = await this.modelConfig.list();
    const CH_LABELS: Record<string, string> = { doubao: '豆包', yuanbao: '元宝', trae: '字节TRAE', codebuddy: '腾讯CodeBuddy', unified: '统一联网搜索' };
    // 列头按「具体大模型/子通道」动态展开：websearch 类模型拆成 豆包/元宝/字节TRAE/腾讯CodeBuddy 各一列，
    // 其它模型保留其 label。colId 取父:通道（如 websearch-unified:doubao），列头直接用通道名（不再带"统一联网搜索"）。
    const WS_CHANNEL_KEYS = ['doubao', 'yuanbao', 'trae', 'codebuddy'];
    const modelColumns: { id: string; label: string }[] = [];
    for (const m of models) {
      if (m.id.startsWith('websearch')) {
        for (const c of WS_CHANNEL_KEYS) modelColumns.push({ id: `${m.id}:${c}`, label: CH_LABELS[c] ?? c });
      } else {
        modelColumns.push({ id: m.id, label: m.label });
      }
    }
    const modelLabelOf = (id: string) => {
      const idx = id.indexOf(':');
      if (idx > 0) return CH_LABELS[id.slice(idx + 1)] ?? id.slice(idx + 1); // 子通道 → 直接用"豆包/元宝"等
      return models.find((m) => m.id === id)?.label ?? id;
    };

    const questions = await this.db
      .select()
      .from(probeQuestions)
      .where(eq(probeQuestions.status, 'active'))
      .orderBy(desc(probeQuestions.id))
      .limit(50);

    const results = await this.db.select().from(probeResults).orderBy(desc(probeResults.probedAt));
    // websearch 子通道（modelId 形如 websearch-unified:doubao）归并到父模型列：
    // 取「命中判定最优」的一条（fact_page > same_domain > other > none）
    const CIT_RANK: Record<string, number> = { fact_page: 3, same_domain: 2, other: 1, none: 0 };
    const parentOf = (id: string) => (id.indexOf(':') > 0 ? id.slice(0, id.indexOf(':')) : id);
    const latest = new Map<string, ProbeResultRow>();
    for (const r of results) {
      const key = `${r.questionId}|${r.modelId}`; // 完整 modelId（含 :doubao 子通道），各通道独立保存
      const cur = latest.get(key);
      if (!cur || (CIT_RANK[r.cited] ?? 0) > (CIT_RANK[cur.cited] ?? 0)) latest.set(key, r);
    }

    // ---- 固定问题集表格（按模型回答次数倒序）
    const answerCountByQ = new Map<number, number>();
    for (const r of results) {
      const pid = parentOf(r.modelId);
      answerCountByQ.set(r.questionId, (answerCountByQ.get(r.questionId) ?? 0) + 1);
    }
    const questionRows: ObservatoryQuestionRow[] = questions
      .map((q) => {
        const byModel: Record<string, CitedStatus> = {};
        for (const col of modelColumns) {
          const r = latest.get(`${q.id}|${col.id}`);
          byModel[col.id] = r ? r.cited : 'none';
        }
        return {
          id: q.id,
          question: q.question,
          expectedAnswer: q.expectedAnswer,
          byModel,
          answerCount: answerCountByQ.get(q.id) ?? 0,
        };
      })
      .sort((a, b) => b.answerCount - a.answerCount);

    // ---- 指标
    const total = questions.length;
    const citedQuestions = new Set<number>();
    for (const r of latest.values()) {
      if (r.cited === 'fact_page' || r.cited === 'same_domain') citedQuestions.add(r.questionId);
    }
    const citationRate = total ? citedQuestions.size / total : null;

    // ---- 近 4 周引用变化（真实探测数据）：按 7 天分桶，取每周去重问题的命中率
    // 3=最近一周(0~6 天前) … 0=最早一周(21~27 天前)；无样本的周 rate=null
    const DAY_MS = 86_400_000;
    const nowMs = Date.now();
    const weekBuckets = [0, 1, 2, 3].map((i) => ({ label: `W${i + 1}`, hit: new Set<number>(), all: new Set<number>() }));
    for (const r of results) {
      if (!r.probedAt) continue;
      const daysAgo = Math.floor((nowMs - new Date(r.probedAt).getTime()) / DAY_MS);
      const idx = 3 - Math.floor(daysAgo / 7);
      if (idx < 0 || idx > 3) continue;
      weekBuckets[idx].all.add(r.questionId);
      if (r.cited === 'fact_page' || r.cited === 'same_domain') weekBuckets[idx].hit.add(r.questionId);
    }
    const weeklyStats: ObservatoryWeekStat[] = weekBuckets.map((b) => ({
      label: b.label,
      rate: b.all.size ? b.hit.size / b.all.size : null,
      base: b.all.size,
    }));

    const runs = await this.db.select().from(probeRuns).orderBy(desc(probeRuns.id)).limit(10);
    let citationRateDeltaPp: number | null = null;
    if (runs.length >= 2) {
      const rateOf = async (runId: number): Promise<number> => {
        const rs = await this.db
          .select({ cited: probeResults.cited, qid: probeResults.questionId })
          .from(probeResults)
          .where(eq(probeResults.runId, runId));
        const qs = new Set(rs.map((x) => x.qid));
        if (!qs.size) return 0;
        const hit = new Set<number>();
        for (const x of rs) if (x.cited === 'fact_page' || x.cited === 'same_domain') hit.add(x.qid);
        return hit.size / qs.size;
      };
      citationRateDeltaPp = Math.round((await rateOf(runs[0].id) - (await rateOf(runs[1].id))) * 100);
    }

    // 问题 → 实体/事实 映射（仅取 latest 涉及到的题，减少查询）
    const neededQids = [...new Set([...latest.values()].map((r) => r.questionId))];
    const qMetaRows = neededQids.length
      ? await this.db
          .select({
            id: probeQuestions.id,
            question: probeQuestions.question,
            factId: probeQuestions.factId,
            entityId: probeQuestions.entityId,
          })
          .from(probeQuestions)
          .where(inArray(probeQuestions.id, neededQids))
      : [];
    const qMeta = new Map(qMetaRows.map((q) => [q.id, q]));

    const factIds = [...new Set(qMetaRows.map((q) => q.factId).filter((v): v is number => v != null))];
    const factRows = factIds.length
      ? await this.db
          .select({
            id: facts.id,
            code: facts.code,
            statement: facts.statement,
            dimension: facts.dimension,
            entityId: facts.entityId,
            entityName: entities.name,
            lastVerifiedAt: facts.lastVerifiedAt,
            createdAt: facts.createdAt,
          })
          .from(facts)
          .leftJoin(entities, eq(facts.entityId, entities.id))
          .where(inArray(facts.id, factIds))
      : [];
    const factMap = new Map(factRows.map((f) => [f.id, f]));

    const base = this.config.get<string>('FACT_PAGE_BASE_URL') ?? 'https://www.66wz.com';
    const factUrl = (factId: number | null, fallbackId: number): string => {
      const f = factId ? factMap.get(factId) : undefined;
      const seg = f?.code ? `/fact/${f.code}` : `/fact/${fallbackId}`;
      return base + seg;
    };
    const factLabel = (factId: number | null): string => {
      const f = factId ? factMap.get(factId) : undefined;
      return f?.code ?? `fact:${factId ?? '?'}`;
    };

    // AI Freshness Lag：最近一次「采用」（事实页或同域内容）→ 相对该 fact 的最近核实/入库时间
    // 说明：fact_page 与 same_domain 都算采用（与 Citation Rate 口径一致），否则真实数据里几乎恒为空
    const adoptedRows = [...latest.values()].filter(
      (r) => (r.cited === 'fact_page' || r.cited === 'same_domain') && r.probedAt,
    );
    /** fact 的时间锚点：lastVerifiedAt 早于入库时间视为脏数据（多为原文里的日期），按入库时间算 */
    const anchorOf = (questionId: number): Date | null => {
      const meta = qMeta.get(questionId);
      const f = meta?.factId ? factMap.get(meta.factId) : undefined;
      const verified = f?.lastVerifiedAt ? new Date(f.lastVerifiedAt) : null;
      const created = f?.createdAt ? new Date(f.createdAt) : null;
      if (verified && created && verified.getTime() < created.getTime()) return created;
      return verified ?? created;
    };
    let aiFreshnessLagMin: number | null = null;
    // 只在「事实先入库、后被引」的记录里取值：探测早于 fact 入库（如 facts 事后重新导入）时
    // 滞后会为负，这种记录不可比，直接置 null（显示 —），而不是用 Math.max(0,...) 伪装成 0 分钟
    const measurable = adoptedRows
      .map((r) => {
        const anchor = anchorOf(r.questionId);
        if (!anchor || !r.probedAt) return null;
        return { at: r.probedAt, lag: Math.round((r.probedAt.getTime() - anchor.getTime()) / 60000) };
      })
      .filter((x): x is { at: Date; lag: number } => x != null && x.lag >= 0)
      .sort((a, b) => b.at.getTime() - a.at.getTime());
    if (measurable.length) aiFreshnessLagMin = measurable[0].lag;

    // 最近一次引用：URL 用「真正被命中的那条」（同域新闻页 ≠ 事实页），避免把新闻页计入事实页功劳
    const lc = adoptedRows.slice().sort((a, b) => (b.probedAt!.getTime() - a.probedAt!.getTime()))[0];
    const lastCitation: ObservatoryMetrics['lastCitation'] = lc
      ? {
          at: lc.probedAt!,
          model: modelLabelOf(lc.modelId),
          question: qMeta.get(lc.questionId)?.question ?? '',
          cited: lc.cited as 'fact_page' | 'same_domain',
          url: lc.matchedUrl ?? '',
          factUrl: factUrl(qMeta.get(lc.questionId)?.factId ?? null, lc.questionId),
        }
      : null;

    // Discovery Lag：无搜索收录监测源，置灰占位
    const discoveryLagMin: number | null = null;

    const metrics: ObservatoryMetrics = {
      discoveryLagMin,
      aiFreshnessLagMin,
      citationRate,
      citationRateBase: total,
      citationRateDeltaPp,
      lastCitation,
    };

    // ---- Event Tracking
    const evRows = await this.db
      .select({
        id: events.id,
        subject: events.subject,
        description: events.description,
        timeStart: events.timeStart,
        entityId: events.entityId,
        articleTitle: sourceArticles.title,
        articleUrl: sourceArticles.url,
        articlePublishedAt: sourceArticles.publishedAt,
      })
      .from(events)
      .leftJoin(sourceArticles, eq(events.articleId, sourceArticles.id))
      .where(eq(events.status, 'active'))
      .orderBy(desc(events.timeStart))
      .limit(50);

    const entityQ = new Map<number, number[]>();
    for (const m of qMeta.values()) {
      if (m.entityId == null) continue;
      const arr = entityQ.get(m.entityId) ?? [];
      arr.push(m.id);
      entityQ.set(m.entityId, arr);
    }

    const eventsTrack: ObservatoryEventTrack[] = evRows.map((ev) => {
      const qids = entityQ.get(ev.entityId) ?? [];
      let adoptedAt: Date | null = null;
      for (const qid of qids) {
        for (const m of models) {
          const r = latest.get(`${qid}|${m.id}`);
          if (r && (r.cited === 'fact_page' || r.cited === 'same_domain') && r.probedAt) {
            if (!adoptedAt || r.probedAt > adoptedAt) adoptedAt = r.probedAt;
          }
        }
      }
      const firstQid = qids[0];
      const factId = firstQid != null ? qMeta.get(firstQid)?.factId ?? null : null;
      if (factId == null) return null; // 只列出关联到 fact 的新闻，过滤掉 fact:? 的孤立新闻
      const publishedAt = ev.articlePublishedAt ? new Date(ev.articlePublishedAt) : null;

      const f = factMap.get(factId);
      return {
        id: String(ev.id),
        title: ev.articleTitle ?? ev.subject ?? ev.description ?? `事件 ${ev.id}`,
        newsUrl: ev.articleUrl ?? '',
        factId: factLabel(factId),
        factUrl: factUrl(factId, ev.id),
        factStatement: f?.statement ?? null,
        factEntity: f?.entityName ?? null,
        factDimension: f?.dimension ?? null,
        isDemo: false,
        nodes: [
          { label: '新闻发布', at: publishedAt, state: publishedAt ? 'done' : 'pending' },
          { label: 'Fast Lane 推送（IndexNow + 百度）', at: null, state: 'planned' },
          { label: 'Search 首次发现（待接入搜索收录监测）', at: null, state: 'planned' },
          {
            label: 'AI 采用（引用我方内容）',
            at: adoptedAt,
            state: adoptedAt ? 'done' : 'pending',
          },
        ],
      };
    }).filter((e): e is ObservatoryEventTrack => e != null).slice(0, 10);

    return { metrics, events: eventsTrack, questions: questionRows, modelColumns, weeklyStats, generatedAt: new Date() };
  }

  /** 执行记录列表（任务计划/手动跑批的每一次执行），含命中率统计 */
  async listRuns(page = 1, pageSize = 20): Promise<{
    total: number;
    items: {
      runId: number;
      modelId: string;
      questionCount: number;
      status: string;
      startedAt: Date | null;
      finishedAt: Date | null;
      durationSec: number | null;
      hitRate: number | null;
      answerCount: number;
      factPage: number;
      sameDomain: number;
      other: number;
      none: number;
    }[];
  }> {
    const offset = Math.max(0, (page - 1) * pageSize);
    const runs = await this.db
      .select()
      .from(probeRuns)
      .orderBy(desc(probeRuns.id))
      .limit(pageSize)
      .offset(offset);
    const [{ total }] = await this.db.select({ total: count() }).from(probeRuns);
    const ids = runs.map((r) => r.id);
    const stats = ids.length
      ? await this.db
          .select({
            runId: probeResults.runId,
            rows: count(),
            questions: sql<number>`COUNT(DISTINCT ${probeResults.questionId})`,
            // 命中率按「被命中的去重问题数 / 总问题数」计，避免一题被多通道命中时超 100%
            hitQuestions: sql<number>`COUNT(DISTINCT CASE WHEN ${probeResults.cited} IN ('fact_page','same_domain') THEN ${probeResults.questionId} END)`,
            factPage: sql<number>`SUM(${probeResults.cited} = 'fact_page')`,
            sameDomain: sql<number>`SUM(${probeResults.cited} = 'same_domain')`,
            otherCnt: sql<number>`SUM(${probeResults.cited} = 'other')`,
            noneCnt: sql<number>`SUM(${probeResults.cited} = 'none')`,
          })
          .from(probeResults)
          .where(inArray(probeResults.runId, ids))
          .groupBy(probeResults.runId)
      : [];
    const statsMap = new Map(stats.map((s) => [Number(s.runId), s]));
    const items = runs.map((r) => {
      const s = statsMap.get(r.id);
      const questions = s ? Number(s.questions) : 0;
      const hit = s ? Number(s.hitQuestions) : 0;
      const hitRate = questions ? Math.round((hit / questions) * 100) : null;
      const durationSec = r.startedAt && r.finishedAt ? Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000) : null;
      return {
        runId: r.id,
        modelId: r.modelId,
        questionCount: r.questionCount,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        durationSec,
        hitRate,
        answerCount: s ? Number(s.rows) : 0,
        factPage: s ? Number(s.factPage) : 0,
        sameDomain: s ? Number(s.sameDomain) : 0,
        other: s ? Number(s.otherCnt) : 0,
        none: s ? Number(s.noneCnt) : 0,
      };
    });
    return { total: Number(total), items };
  }

  /** 单次执行的明细：每题 × 每个模型通道的引用判定与原文 */
  async getRunDetail(runId: number): Promise<{
    run: typeof probeRuns.$inferSelect;
    questions: {
      id: number;
      question: string;
      expectedAnswer: string;
      factId: number | null;
      answers: {
        modelId: string;
        modelLabel: string;
        cited: string;
        matchMethod: string;
        sourceUrls: string[] | null;
        matchedUrl: string | null;
        excerpt: string | null;
        rawAnswer: string | null;
        probedAt: Date | null;
      }[];
    }[];
  } | null> {
    const run = await this.db.select().from(probeRuns).where(eq(probeRuns.id, runId)).limit(1);
    if (!run.length) return null;
    const results = await this.db
      .select()
      .from(probeResults)
      .where(eq(probeResults.runId, runId))
      .orderBy(desc(probeResults.probedAt));
    const qids = [...new Set(results.map((r) => r.questionId))];
    const qs = qids.length ? await this.db.select().from(probeQuestions).where(inArray(probeQuestions.id, qids)) : [];
    const qMap = new Map(qs.map((q) => [q.id, q]));
    const models = await this.modelConfig.list();
    const enabledIds = new Set(models.filter((m) => m.enabled).map((m) => m.id));
    const CH_LABELS: Record<string, string> = {
      doubao: '豆包',
      yuanbao: '元宝',
      trae: '字节TRAE',
      codebuddy: '腾讯CodeBuddy',
      unified: '统一联网搜索',
    };
    const labelOf = (id: string): string | null => {
      if (models.some((m) => m.id === id)) return models.find((m) => m.id === id)!.label;
      const idx = id.indexOf(':');
      if (idx > 0) {
        const parent = id.slice(0, idx);
        const ch = id.slice(idx + 1);
        if (enabledIds.has(parent)) return CH_LABELS[ch] ?? ch;
      }
      return null;
    };
    const byQ = new Map<number, (typeof results)[number][]>();
    for (const r of results) {
      const arr = byQ.get(r.questionId) ?? [];
      arr.push(r);
      byQ.set(r.questionId, arr);
    }
    const questions = [...byQ.entries()].map(([qid, rows]) => ({
      id: qid,
      question: qMap.get(qid)?.question ?? '',
      expectedAnswer: qMap.get(qid)?.expectedAnswer ?? '',
      factId: qMap.get(qid)?.factId ?? null,
      answers: rows.map((r) => ({
        modelId: r.modelId,
        modelLabel: labelOf(r.modelId) ?? r.modelId,
        cited: r.cited,
        matchMethod: r.matchMethod,
        sourceUrls: r.sourceUrls,
        matchedUrl: r.matchedUrl,
        excerpt: r.excerpt,
        rawAnswer: r.rawAnswer,
        probedAt: r.probedAt,
      })),
    }));
    return { run: run[0], questions };
  }
}
