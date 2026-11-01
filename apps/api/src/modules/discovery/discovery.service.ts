import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { buildUrn } from '@ssot/shared';
import { DRIZZLE, type Db } from '../../db/db.module';
import { fetchLatest, hitToDoc, loadEsConfig } from '../news/news-es';
import { sha256 } from '../../common/crypto';
import { locateQuote, sentenceAt, resolveRelativeTime, concreteTimeText } from '../../common/text';
import {
  alignTasks,
  categories,
  categoryDimensions,
  datasetCategories,
  datasets,
  entities,
  entityAliases,
  entityEmbeddings,
  entityRelations,
  evidences,
  extractTasks,
  extractionDrafts,
  extractionRuns,
  factDimensions,
  factEvidences,
  facts,
  llmCallLogs,
  llmSettings,
  predicateMaps,
  relationRejectSamples,
  relationSchemas,
  sourceArticleBodies,
  sourceArticles,
} from '../../db/schema';
import { EntityService } from '../entity/entity.service';
import { FieldDefService } from '../field-def/field-def.service';
import { LlmConfigService } from '../llm-config/llm-config.service';
import { LlmLogService } from '../llm-log/llm-log.service';
import { PipelineService } from '../pipeline/pipeline.service';
import { blocking, preAlign, roleConflict, type AlignTarget } from './align';
import { embedTexts, entityEmbedText, setVectorConfig, setZhipuApiKey } from './embed.client';
import { extractJson, gazetteerHit, geoAnchor, norm } from './lexicon';
import {
  chat,
  checkRelationSchemaGate,
  stageAudit,
  stageDiscover,
  stageFactRelations,
  stageFacts,
  stageFactsBatch,
  stageNormalizePredicates,
  stageRelations,
  stageVerifyRelations,
  RELATION_HINTS,
  GENERIC_RELATION_PREDICATES,
  usableRelationHints,
  PREDICATE_SYNONYMS,
  type AuditResult,
  type CategoryHint,
  type FactCandidate,
  type FactRelationCandidate,
  type FactRelationReject,
  type EventCandidate,
  type LlmCfg,
  type LlmUsage,
  type RawEntity,
  type RelationCandidate,
  type RelationReject,
  type RelationDirectionFix,
  type RelationSchemaLine,
  type RelationVerifyInput,
  type RelationVerdict,
  type RejectSampleLike,
  normalizeInversePair,
} from './stages';

/** 生产线上的一个模型槽位：后台「文本模型」里启用并设为生产线的配置（concurrency = 该渠道并发数） */
export interface ModelSlot {
  settingId: number | null;
  settingName: string;
  concurrency: number;
  cfg: LlmCfg;
}

// ---------------------------------------------------------------- 多模型结果合并

export const entityKey = (name: string, type: string) => `${norm(name)}::${type}`;

/** 审核判定 / 处置动作的中文说明（报告用） */
const VERDICT_TEXT: Record<string, string> = {
  accept: '通过（收录）',
  c_layer: 'C 层（仅入库不立档）',
  reject: '驳回',
};
/** 实体自动合并阈值：候选 top1 相似度 ≥ 该值 → 自动合并写别名；< 该值 → 自动收录新实体 */
const AUTO_MERGE_TOP1 = 0.95;

const ACTION_TEXT: Record<string, string> = {
  exact_hit: '直接命中已有实体',
  alias_hit: '别名命中已有实体',
  review: '待人工裁决（合并建议）',
  judge_conflict: 'LLM 判同但身份冲突 → 待人工裁决',
  score_merge: `分数自动合并(≥${AUTO_MERGE_TOP1})`,
  score_new: `分数自动收录(<${AUTO_MERGE_TOP1})`,
  new: '新建实体',
};

/** 关系唯一键：head|predicate|tail 归一后比较 */
function relationKey(r: { head: string; predicate: string; tail: string }) {
  return `${norm(r.head)}|${norm(r.predicate)}|${norm(r.tail)}`;
}

/** 列表用的精简计数（不返回完整抽取报告） */
function pickStats(stats: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    'entitiesCreated',
    'entitiesMerged',
    'entitiesExact',
    'alignPending',
    'cLayer',
    'rejected',
    'factDrafts',
    'eventDrafts',
    'relationDrafts',
    'factFailures',
    'factRetries',
    'tokens',
  ];
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = Number(stats[k] ?? 0);
  return out;
}

/** 明细用：统计一次审核调用里各 verdict 的数量 */
function tallyVerdicts(results: AuditResult[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const r of results) t[r.verdict] = (t[r.verdict] ?? 0) + 1;
  return t;
}

/**
 * 实体发现与对齐管线（新模式）：
 *   语料(oucai.news) → 队列(断点续跑) → 发现 → 入库审核 → 对齐 → 事实抽取(草稿)
 *
 * 与旧模式（预置实体 + AC 匹配 + 按实体抽事实）的区别：
 * - 实体由模型从文章发现，不再依赖预置清单
 * - 新提及先过「确定性规则 + 词典 + 属性比对」，只有真正拿不准才调 LLM 判决
 * - 人工裁决沉淀成别名 / 谓词映射 / 种子词典，同类问题下次零成本命中
 */
@Injectable()
export class DiscoveryService implements OnModuleInit {
  private readonly logger = new Logger(DiscoveryService.name);
  private readonly running = new Set<number>();
  /** 取消排队标志（按 dataset）：置位后跑批 worker 不再取新任务 */
  private readonly cancelFlags = new Set<number>();
  /** 每轮跑批的取消控制器（按 dataset）：取消时中断在途 LLM 调用 */
  private readonly runSignals = new Map<number, AbortController>();

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly llmConfigService: LlmConfigService,
    private readonly llmLogService: LlmLogService,
    private readonly entityService: EntityService,
    private readonly fieldDefService: FieldDefService,
    private readonly pipelineService: PipelineService,
  ) {}

  /** 自动批准草稿：失败留 pending（人工兜底），绝不打爆任务 */
  private async autoApproveDraft(id: number): Promise<boolean> {
    try {
      await this.pipelineService.approveDraft(id, {}, undefined);
      return true;
    } catch (err) {
      this.logger.warn(`[discovery] 自动批准草稿 #${id} 失败：${(err as Error).message}`);
      return false;
    }
  }

  /**
   * 按篇即时审批：对某篇文章涉及的实体，审批其合格的事实草稿并发布实体（含新增候选尾实体关系）。
   * 与队尾 autoPublish（全库兜底）核心逻辑一致，但只作用于传入的实体 id 集合，
   * 使「生产完一篇就入档一篇」，无需等整批跑批结束。
   */
  private async autoApproveByEntityIds(datasetId: number, entityIds: number[]) {
    if (!entityIds.length) return { factApproved: 0, entityPublished: 0 };

    let factApproved = 0;
    // ① 审批该批实体下「待审、置信≥0.85、有陈述、引句≥4字」的事实草稿
    const factDrafts = await this.db
      .select({ id: extractionDrafts.id, payloadJson: extractionDrafts.payloadJson })
      .from(extractionDrafts)
      .where(
        and(
          eq(extractionDrafts.targetType, 'fact'),
          eq(extractionDrafts.status, 'pending'),
          inArray(extractionDrafts.entityId, entityIds),
        ),
      );
    for (const d of factDrafts) {
      const p = (d.payloadJson ?? {}) as {
        confidence?: number | string;
        statement?: string;
        evidence?: { quote?: string };
      };
      const conf = Number(p.confidence ?? 0);
      const quote = (p.evidence?.quote ?? '').trim();
      if (conf >= 0.85 && p.statement?.trim() && quote.length >= 4) {
        if (await this.autoApproveDraft(d.id)) factApproved += 1;
      }
    }

    // ② 发布「本篇文章新建/命中且有事实草稿」的 draft 实体（规则同 autoPublish：有事实草稿即发布）
    let entityPublished = 0;
    if (factApproved > 0 || entityIds.length) {
      const cats = await this.linkedCategoryIdsByDs(datasetId);
      const candidates = await this.db
        .selectDistinct({ entityId: extractionDrafts.entityId })
        .from(extractionDrafts)
        .where(
          and(
            eq(extractionDrafts.targetType, 'fact'),
            inArray(extractionDrafts.entityId, entityIds),
          ),
        );
      const withFactIds = candidates.map((r) => r.entityId).filter((v): v is number => v != null);
      const publishable = await this.db
        .select({ id: entities.id })
        .from(entities)
        .where(
          and(
            eq(entities.status, 'draft'),
            isNull(entities.deletedAt),
            inArray(entities.id, withFactIds),
            cats.length ? inArray(entities.categoryId, cats) : undefined,
          ),
        );
      for (const e of publishable) {
        try {
          await this.entityService.update(e.id, { status: 'published' } as never);
          entityPublished += 1;
        } catch {
          /* 单条失败跳过 */
        }
      }
    }
    return { factApproved, entityPublished };
  }

  /** 某语料域关联分类 id（即时审批实体发布用） */
  private async linkedCategoryIdsByDs(datasetId: number): Promise<number[]> {
    const rows = await this.db
      .select({ categoryId: datasetCategories.categoryId })
      .from(datasetCategories)
      .where(eq(datasetCategories.datasetId, datasetId));
    return rows.map((r) => Number(r.categoryId));
  }

  // ---------------------------------------------------------------- 事实→图谱（Fact → KG 边派生）

  /** 事实→图谱派生统计 */
  async deriveRelationsFromFacts(input: {
    datasetId: number;
    /** 参与派生的主体实体 id（有 active 事实的实体） */
    entityIds: number[];
    /** 生产线渠道（单元素 = 单渠道处理；多元素 = 依次尝试取首个成功） */
    models: ModelSlot[];
    runId?: number | null;
    taskId?: number | null;
    signal?: AbortSignal;
  }): Promise<{
    entities: number;
    candidates: number;
    drafts: number;
    approved: number;
    dupSkipped: number;
    rejected: number;
    errors: string[];
  }> {
    const stats = { entities: 0, candidates: 0, drafts: 0, approved: 0, dupSkipped: 0, rejected: 0, errors: [] as string[] };
    if (!input.entityIds.length || !input.models.length) return stats;
    const { datasetId, signal } = input;

    // ① 主体实体（带类型）+ 已入档 active 事实（挂第一条支撑证据；无证据/无引句的事实不参与派生）
    const ents = await this.loadRelationEntities(datasetId, input.entityIds);
    if (!ents.length) return stats;
    const entById = new Map(ents.map((e) => [Number(e.id), e]));
    const factRows = await this.db
      .select({
        factId: facts.id,
        entityId: facts.entityId,
        dimension: facts.dimension,
        statement: facts.statement,
        evQuote: evidences.quote,
        evSpanStart: evidences.spanStart,
        evSpanEnd: evidences.spanEnd,
        evGrade: evidences.qualityGrade,
        evBatch: evidences.batch,
        evArticleId: evidences.articleId,
        evPublishedAt: evidences.publishedAt,
      })
      .from(facts)
      .innerJoin(factEvidences, eq(factEvidences.factId, facts.id))
      .innerJoin(evidences, eq(evidences.id, factEvidences.evidenceId))
      .where(and(inArray(facts.entityId, [...entById.keys()]), eq(facts.status, 'active')));
    const factsByEntity = new Map<number, { dimension: string; statement: string; factId: number; evidence: { quote: string; spanStart: number; spanEnd: number; grade: 'A' | 'B' | 'C' | 'D'; batch: 'baseline' | 'incremental'; articleId: number; publishedAt: string | null } }[]>();
    const factsSeen = new Set<number>(); // 一条事实多条证据只取第一条
    for (const r of factRows) {
      const eid = Number(r.entityId);
      if (!entById.has(eid) || factsSeen.has(Number(r.factId))) continue;
      const quote = String(r.evQuote ?? '').trim();
      if (!quote) continue; // 无引句的事实不派生（证据链是事实的生命线）
      factsSeen.add(Number(r.factId));
      const arr = factsByEntity.get(eid) ?? [];
      arr.push({
        dimension: r.dimension ?? '事实',
        statement: r.statement,
        factId: Number(r.factId),
        evidence: {
          quote,
          spanStart: Number(r.evSpanStart ?? 0),
          spanEnd: Number(r.evSpanEnd ?? 0),
          grade: (r.evGrade ?? 'B') as 'A' | 'B' | 'C' | 'D',
          batch: (r.evBatch ?? 'baseline') as 'baseline' | 'incremental',
          articleId: Number(r.evArticleId),
          publishedAt: r.evPublishedAt ?? null,
        },
      });
      factsByEntity.set(eid, arr);
    }
    const entityFacts = [...factsByEntity.entries()]
      .filter(([, list]) => list.length)
      .map(([eid, list]) => ({ name: entById.get(eid)!.name, type: entById.get(eid)!.type, entityId: eid, facts: list }));
    stats.entities = entityFacts.length;
    if (!entityFacts.length) return stats;

    // ② 该语料域关联分类（tail_type 提示词）+ 主体已有边（双向）——注入 prompt 层防重
    const catRows = await this.db
      .select({ code: categories.code, name: categories.name, description: categories.description })
      .from(datasetCategories)
      .innerJoin(categories, eq(datasetCategories.categoryId, categories.id))
      .where(and(eq(datasetCategories.datasetId, datasetId), eq(categories.status, 'active')))
      .orderBy(asc(datasetCategories.sort));
    const catTypeList: CategoryHint[] = catRows.map((c) => ({ code: c.code, name: c.name, description: c.description }));
    const ids = entityFacts.map((e) => e.entityId);
    const edgeRows = await this.db
      .select({
        headEntityId: entityRelations.headEntityId,
        tailEntityId: entityRelations.tailEntityId,
        tailText: entityRelations.tailText,
        predicate: entityRelations.predicate,
      })
      .from(entityRelations)
      .where(
        and(
          eq(entityRelations.status, 'active'),
          or(
            inArray(entityRelations.headEntityId, ids),
            inArray(entityRelations.tailEntityId, ids),
          ),
        ),
      );
    const nameById = new Map([...entById.entries()].map(([id, e]) => [id, e.name]));
    const edgeNames = [...new Set(edgeRows.flatMap((r) => [Number(r.headEntityId), Number(r.tailEntityId ?? 0)]).filter(Boolean))];
    if (edgeNames.length) {
      const extra = await this.db
        .select({ id: entities.id, name: entities.name })
        .from(entities)
        .where(inArray(entities.id, edgeNames));
      for (const e of extra) nameById.set(Number(e.id), e.name);
    }
    const existingEdges = edgeRows.map(
      (r) => `${nameById.get(Number(r.headEntityId)) ?? '?'} -${r.predicate}-> ${r.tailText}`,
    );

    // ③ LLM 派生：依次尝试各渠道，取首个成功（生产线为单渠道，兼容多渠道容灾）
    let raw: FactRelationCandidate[] = [];
    let rejectedList: FactRelationReject[] = [];
    let usedModel = '';
    for (const m of input.models) {
      if (signal?.aborted) break;
      const t0 = Date.now();
      const r = await stageFactRelations({ ...m.cfg, signal }, entityFacts, catTypeList, existingEdges);
      const pt = r.usage?.promptTokens ?? 0;
      const ct = r.usage?.completionTokens ?? 0;
      await this.llmLogService.logCall({
        settingId: m.settingId,
        model: m.cfg.model,
        endpoint: m.cfg.baseUrl,
        purpose: 'fact_graph',
        promptTokens: pt,
        completionTokens: ct,
        totalTokens: pt + ct,
        latencyMs: Date.now() - t0,
        status: r.error ? 'error' : 'success',
        errorMessage: r.error ?? null,
        taskId: input.taskId ?? null,
        articleId: null,
        detailJson: { stage: 'fact_graph', entities: entityFacts.length, candidates: r.relations.length, rejected: r.rejected.length },
        createdBy: null,
      });
      if (!r.error) {
        raw = r.relations;
        rejectedList = r.rejected;
        usedModel = m.cfg.model;
        break;
      }
      stats.errors.push(r.error);
    }
    stats.rejected = rejectedList.length;
    if (!raw.length) return stats;

    // ④ 谓词归一先行（规则 + predicate_map，剩余新词批量 LLM 判决沉淀）——归一后才能做同义/反向去重
    const rawPreds = [...new Set(raw.map((r) => String(r.predicate ?? '').trim()).filter(Boolean))];
    if (rawPreds.length) {
      const knownPreds = usableRelationHints();
      const pendingPreds = await this.collectPendingPredicates(datasetId, rawPreds, knownPreds);
      if (pendingPreds.length && input.models[0]) {
        const nr = await stageNormalizePredicates({ ...input.models[0].cfg, signal }, pendingPreds, knownPreds, 'relation');
        if (!nr.error) await this.applyPredicateMapping(datasetId, nr.mapping);
      }
    }
    const canonCache = new Map<string, string>();
    const canonOf = async (p: string) => {
      const k = String(p ?? '').trim();
      if (!canonCache.has(k)) canonCache.set(k, await this.normalizeRelationPredicate(datasetId, k));
      return canonCache.get(k)!;
    };

    // ⑤ 库级查重表：主体相关已有边按「无序对 + 归一谓词」建索引（借鉴开源系统 _pair_key：
    //    A→B 与 B→A 同键；谓词逐条归一后再比较，专治存量「举行/举办」不同形同义）
    const tailKeyOf = (tailEntityId: number | null, tailText: string) =>
      tailEntityId != null ? `e${tailEntityId}` : `t${norm(tailText)}`;
    const pairCanon = new Map<string, Set<string>>();
    for (const r of edgeRows) {
      const hKey = `e${Number(r.headEntityId)}`;
      const tKey = tailKeyOf(r.tailEntityId == null ? null : Number(r.tailEntityId), r.tailText);
      const key = [hKey, tKey].sort().join('\u0000');
      const canon = await canonOf(r.predicate);
      const set = pairCanon.get(key) ?? new Set<string>();
      set.add(canon);
      pairCanon.set(key, set);
    }

    // ⑥ 候选后处理：尾实体解析 → 自环拦截 → 谓词归一 → 库级同义查重 → 批内无序对去重
    const nameToId = await this.loadEntityNameIndex(datasetId);
    const entityCats = await this.db
      .select({ id: entities.id, code: categories.code })
      .from(entities)
      .innerJoin(categories, eq(entities.categoryId, categories.id))
      .where(inArray(entities.id, ids));
    const catById = new Map<number, string>(entityCats.map((r) => [Number(r.id), r.code]));
    // 实体类型方向序（与 Stage 3 同谓词反向去重同规则）：人物→机构→活动/产品/食物→地点
    const typeRank = (code?: string | null): number => {
      const c = code ?? '';
      if (c.includes('person')) return 10;
      if (c.includes('org')) return 8;
      if (c.includes('event') || c.includes('activity')) return 6;
      if (c.includes('work') || c.includes('product') || c.includes('food') || c.includes('dish')) return 5;
      if (c.includes('place') || c.includes('site')) return 4;
      return 2;
    };
    const cands: {
      headId: number; headName: string; headRank: number; tailRank: number; conf: number;
      tailText: string; tailId: number | null; tailType: string | null; canon: string; rawPred: string;
      factId: number; evidence: { quote: string; spanStart: number; spanEnd: number; grade: 'A' | 'B' | 'C' | 'D'; batch: 'baseline' | 'incremental'; articleId: number; publishedAt: string | null };
    }[] = [];
    const pairToCands = new Map<string, number[]>();
    for (const x of raw) {
      const entityName = String(x?.entity ?? '').trim();
      const owner = entityFacts.find((e) => e.name === entityName);
      if (!owner) continue;
      const headId = owner.entityId;
      const tailRaw = String(x?.tail ?? '').trim().replace(/[《》【】〈〉«»""'']/g, ''); // 尾文本去书名号/引号（防同实体两条边）
      if (!tailRaw) continue;
      // 尾实体解析：先库内实体（resolveTailEntity 含前缀/后缀归一），尾类型未知时用主体事实推断
      const tailResolved = await this.resolveTailEntity(datasetId, tailRaw);
      const tailId = tailResolved?.id ?? nameToId.get(norm(tailRaw)) ?? null;
      if (tailId != null && tailId === headId) continue; // 自环拦截（显示名不同但同 id）
      const canon = await canonOf(String(x?.predicate ?? ''));
      const tailType = (x?.tail_type ? String(x.tail_type) : null) ?? null;
      const tailRank = typeRank(tailId != null ? catById.get(tailId) : tailType);
      const headRank = typeRank(catById.get(headId));
      const hKey = `e${headId}`;
      const tKey = tailKeyOf(tailId, tailRaw);
      const pairKey = `${canon}\u0000${[hKey, tKey].sort().join('\u0000')}`;
      // 库级同义查重：同无序对 + 归一后同谓词 → 已有边（含反向/同义形）视为重复，跳过
      if (pairCanon.get(pairKey.slice(canon.length + 1))?.has(canon)) {
        stats.dupSkipped += 1;
        continue;
      }
      const arr = pairToCands.get(pairKey) ?? [];
      arr.push(cands.length);
      pairToCands.set(pairKey, arr);
      cands.push({
        headId, headName: entById.get(headId)!.name, headRank, tailRank,
        conf: Number(x?.confidence ?? 0.85),
        tailText: tailResolved?.name ?? tailRaw, tailId, tailType, canon, rawPred: String(x?.predicate ?? ''),
        factId: owner.facts.find((f) => f.statement.includes(tailRaw) || f.statement.includes(tailResolved?.name ?? tailRaw))?.factId ?? owner.facts[0].factId,
        evidence:
          owner.facts.find((f) => f.statement.includes(tailRaw) || f.statement.includes(tailResolved?.name ?? tailRaw))?.evidence ??
          owner.facts[0].evidence,
      });
    }
    stats.candidates = cands.length;

    // 批内无序对去重：同 canon 同无序对出现多条（不同实体互指，如 A合作B 与 B合作A）时，
    // 只保留方向符合类型序（rankDiff 更大）的那条；同档比置信度
    const dropIdx = new Set<number>();
    for (const idxs of pairToCands.values()) {
      if (idxs.length < 2) continue;
      let win = -1;
      let winDiff = -Infinity;
      let winConf = 0;
      for (const ci of idxs) {
        const c = cands[ci];
        const d = c.headRank - c.tailRank;
        if (d > winDiff || (d === winDiff && c.conf > winConf)) {
          win = ci;
          winDiff = d;
          winConf = c.conf;
        }
      }
      for (const ci of idxs) if (ci !== win) dropIdx.add(ci);
      stats.dupSkipped += idxs.length - 1;
    }

    // ⑦ 落草稿 + 自动批准（复用 approveRelationDraft：行锁事务、同向 merge corroborate、反向丢弃、概念节点承接）
    for (let i = 0; i < cands.length; i += 1) {
      if (dropIdx.has(i)) continue;
      const c = cands[i];
      const [ins] = await this.db.insert(extractionDrafts).values({
        runId: input.runId ?? 0,
        entityId: c.headId,
        targetType: 'relation',
        payloadJson: {
          kind: 'relation',
          headEntityId: c.headId,
          headEntityName: c.headName,
          predicate: c.canon,
          predicateRaw: c.rawPred,
          tailEntityId: c.tailId,
          tailText: c.tailText,
          tailType: c.tailType,
          statement: `${c.headName} ${c.canon} ${c.tailText}`,
          confidence: c.conf,
          origin: 'fact',
          articleId: c.evidence.articleId,
          publishedAt: c.evidence.publishedAt,
          fromModels: usedModel ? [usedModel] : [],
          // 证据复用事实的原证据（quote/span 原样 → evidenceService 按同 (article, span_hash) 命中已有证据，不新建）
          evidence: {
            quote: c.evidence.quote,
            spanStart: c.evidence.spanStart,
            spanEnd: c.evidence.spanEnd,
            qualityGrade: c.evidence.grade,
            batch: c.evidence.batch,
          },
          sourceFactId: c.factId,
          dedupeKey: sha256(`relation|${c.headId}|${c.canon}|${norm(c.tailText)}|fact`),
        },
        status: 'pending',
      });
      stats.drafts += 1;
      if (await this.autoApproveDraft(Number(ins.insertId))) stats.approved += 1;
    }
    return stats;
  }

  /** 最近 N 条关系驳回样本（供验证器 few-shot 反例） */
  private async loadRejectSamples(datasetId: number, n = 8): Promise<RejectSampleLike[]> {
    const rows = await this.db
      .select({ head: relationRejectSamples.head, predicate: relationRejectSamples.predicate, tail: relationRejectSamples.tail, quote: relationRejectSamples.quote, reason: relationRejectSamples.reason })
      .from(relationRejectSamples)
      .where(eq(relationRejectSamples.datasetId, datasetId))
      .orderBy(desc(relationRejectSamples.id))
      .limit(n);
    return rows;
  }

  /**
   * 启动自愈：跑批在进程内执行，进程没了跑批也没了，但跑批开始时写入的 status='running'
   * 不会自动收尾。若不清理，生产线页面会长期显示「进行中」（哪怕已是几天前的记录）。
   * 这些任务重跑是安全的（runQueue 按断点续跑，done 的不会重复处理），故重置为 pending。
   */
  async onModuleInit() {
    try {
      const res = (await this.db
        .update(extractTasks)
        .set({ status: 'pending', errorMsg: '执行被中断（应用重启）' })
        .where(eq(extractTasks.status, 'running'))) as unknown;
      const affected = Array.isArray(res) ? Number((res[0] as { affectedRows?: number })?.affectedRows ?? 0) : 0;
      if (affected) this.logger.warn(`[discovery] 清理僵死 running 任务 ${affected} 条 → pending`);
    } catch (e) {
      this.logger.error(`[discovery] 僵死任务清理失败：${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- 队列

  /**
   * 从 ES 新闻源取最新 N 条建队列（生产线菜单的抽样入口）。
   * 实时新闻的增量入库走 NewsService.ingest → createQueueFromDocs。
   */
  async buildQueue(
    datasetId: number,
    limit = 100,
    opts: {
      batch?: 'baseline' | 'incremental';
    } = {},
  ) {
    const cfg = await loadEsConfig(this.db);
    const hits = await fetchLatest(cfg, Math.min(Math.max(limit, 1), 1000));
    return this.createQueueFromDocs(datasetId, hits.map(hitToDoc), opts.batch ?? 'incremental');
  }

  /**
   * 把 ES 新闻文档落库建队列：同时把语料落到 source_article（供证据锚点与档案页引用）。
   * 幂等：extract_task 的 (dataset_id, external_key) 唯一，重复调用不会重复建任务。
   */
  async createQueueFromDocs(
    datasetId: number,
    docs: {
      assetId: string;
      title: string | null;
      sourceName: string | null;
      pubDate: string | null;
      sourceUrl: string | null;
      contentText: string;
    }[],
    batch: 'baseline' | 'incremental' = 'incremental',
    /** 是否抽取关系图谱（由任务计划传入）；落库到行，跑批失败/取消后重跑仍沿用 */
    extractRelations = true,
  ) {
    // 已存在的 external_key，避免重复建任务
    const existing = await this.db
      .select({ key: extractTasks.externalKey })
      .from(extractTasks)
      .where(eq(extractTasks.datasetId, datasetId));
    const known = new Set(existing.map((e) => e.key));

    let created = 0;
    let skipped = 0;
    // 入队顺序决定跑批处理顺序（runQueue 按 extract_task.id 升序取任务）：
    // 按报道发布日期升序入队，保证「早的报道先入档」，避免后发生的报道先被当成基线。
    // 无发布日期的文档排到最后（按原顺序稳定保留）。
    const ordered = [...docs].sort((a, b) => {
      const da = a.pubDate ? String(a.pubDate) : '';
      const db = b.pubDate ? String(b.pubDate) : '';
      if (da === db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da < db ? -1 : 1;
    });
    for (const r of ordered) {
      if (known.has(r.assetId)) {
        skipped += 1;
        continue;
      }
      const url = r.sourceUrl || `urn:es:news:${r.assetId}`;
      const urlHash = sha256(url);
      const title = (r.title || '无题').slice(0, 500);

      // 语料入库（url_hash 唯一，重复语料跳过）
      const [dup] = await this.db
        .select({ id: sourceArticles.id })
        .from(sourceArticles)
        .where(eq(sourceArticles.urlHash, urlHash))
        .limit(1);
      let articleId = dup?.id;
      if (!articleId) {
        const [ins] = await this.db.insert(sourceArticles).values({
          datasetId,
          sourceSite: 'news.66wz.com',
          sourceOrg: r.sourceName ?? null,
          title,
          url,
          urlHash,
          externalId: r.assetId,
          publishedAt: r.pubDate ? String(r.pubDate).slice(0, 10) : null,
          batch,
          contentHash: sha256(r.contentText),
          quality: 'B',
          status: 'cleaned',
          fetchedAt: new Date(),
        });
        articleId = Number(ins.insertId);
        await this.db.insert(sourceArticleBodies).values({
          articleId,
          bodyRaw: r.contentText,
          bodySlice: r.contentText,
          sliceRule: 'full',
        });
      }

      // 唯一键 (dataset_id, external_key)：同一批内出现重复 doc_id 或并发入库时，
      // onDuplicateKeyUpdate 静默跳过而非抛错中断整批
      const [ins] = await this.db
        .insert(extractTasks)
        .values({
          datasetId,
          externalKey: r.assetId,
          articleId,
          title,
          sourceOrg: r.sourceName ?? null,
          pubDate: r.pubDate ? String(r.pubDate).slice(0, 10) : null,
          bodyChars: r.contentText.length,
          extractRelations,
          stage: 'pending',
          status: 'pending',
        })
        .onDuplicateKeyUpdate({ set: { updatedAt: new Date() } });
      // MySQL：ON DUPLICATE KEY UPDATE 时 affectedRows=1 为新增，=2 为更新（重复跳过）
      if (Number((ins as { affectedRows?: number }).affectedRows ?? 0) === 1) created += 1;
      else skipped += 1;
    }

    return { sampled: docs.length, created, skipped, datasetId };
  }

  /** 队列状态概览（支持断点续跑的进度查看） */
  async queueStatus(datasetId: number) {
    const rows = await this.db
      .select({ status: extractTasks.status, n: count() })
      .from(extractTasks)
      .where(eq(extractTasks.datasetId, datasetId))
      .groupBy(extractTasks.status);
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = Number(r.n);

    const alignRows = await this.db
      .select({ kind: alignTasks.kind, n: count() })
      .from(alignTasks)
      .where(and(eq(alignTasks.datasetId, datasetId), eq(alignTasks.status, 'pending')))
      .groupBy(alignTasks.kind);
    const pendingAlign: Record<string, number> = {};
    for (const r of alignRows) pendingAlign[r.kind] = Number(r.n);

    return { byStatus, pendingAlign };
  }

  /**
   * 取消排队（温和）：置取消标志让 worker 不再取新任务 + 把**未开始**的 pending 置为 skipped。
   * 已被取走、正在处理中的单篇会跑完（不中断在途 LLM 调用）。
   * 需要连在途一起停下时用 terminateQueue。
   */
  async cancelQueue(datasetId: number) {
    this.cancelFlags.add(datasetId);
    const res = (await this.db
      .update(extractTasks)
      .set({ status: 'skipped', errorMsg: '手动取消排队' })
      .where(and(eq(extractTasks.datasetId, datasetId), eq(extractTasks.status, 'pending')))) as unknown;
    const affected = Array.isArray(res) ? Number((res[0] as { affectedRows?: number })?.affectedRows ?? 0) : 0;
    this.logger.warn(`[discovery] 取消排队 dataset=${datasetId}：跳过排队 ${affected} 条（在途的会跑完）`);
    return { cancelled: affected, datasetId };
  }

  /**
   * 终止任务（强制）：中断在途 LLM 调用 + 把 pending/running 全部置为 skipped。
   * 在途任务被 abort 后由 processTask 自行收尾为 skipped，状态与实际执行保持一致。
   */
  async terminateQueue(datasetId: number) {
    this.cancelFlags.add(datasetId);
    this.runSignals.get(datasetId)?.abort(); // 立即中断在途请求
    const res = (await this.db
      .update(extractTasks)
      .set({ status: 'skipped', errorMsg: '手动终止任务' })
      .where(
        and(eq(extractTasks.datasetId, datasetId), inArray(extractTasks.status, ['pending', 'running'])),
      )) as unknown;
    const affected = Array.isArray(res) ? Number((res[0] as { affectedRows?: number })?.affectedRows ?? 0) : 0;
    this.logger.warn(`[discovery] 终止任务 dataset=${datasetId}：终止 ${affected} 条（含在途）`);
    return { terminated: affected, datasetId };
  }

  // ---------------------------------------------------------------- 跑批

  /**
   * 跑队列：3 通道 × 每通道 2 并发 = 6。
   * 断点续跑：只取 pending/running 的任务，上次中断的 running 会重新跑；已 done 的绝不重复调用 LLM。
   */
  async runQueue(datasetId: number, limit = 0) {
    // 生产线渠道：后台「大模型设置 → 文本模型」里启用 + 设为生产线的全部配置。
    // 多条 = 多个处理渠道，用于**并发提速**：每篇文章只由一个渠道完整处理，不做跨渠道投票/合并。
    // 每个渠道的并发数来自「大模型设置」里的「并发数」字段（默认 10）。
    const settings = await this.llmConfigService.getProductionSettings();
    if (!settings.length) {
      throw new NotFoundException('未配置生产线模型（后台「大模型设置 → 文本模型」需至少一条启用并设为生产线）');
    }
    // 同语料域互斥：避免两次跑批并发（会互相覆盖取消控制器、重复处理同一队列）
    if (this.runSignals.has(datasetId)) {
      throw new BadRequestException('该语料域已有跑批在执行中，请先等待结束或取消排队');
    }
    const models: ModelSlot[] = settings.map((s) => ({
      settingId: s.id,
      settingName: s.name,
      concurrency: Math.min(Math.max(Number(s.concurrency ?? 10), 1), 50),
      cfg: {
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        model: s.model,
        temperature: Number(s.temperature ?? 0.2),
        maxTokens: s.maxTokens ?? 4096,
      },
    }));
    const setting = settings[0];

    // embedding 走 zhipu 时：优先用后台「向量生产线」配置（model/dim/useDefaultDim/key），
    // 否则 key 回落 生产线 GLM key / ZHIPU_API_KEY env
    const vcfg = await this.llmConfigService.getActiveVectorConfig();
    setVectorConfig(vcfg
      ? { apiKey: vcfg.apiKey, model: vcfg.model, dimensions: vcfg.dimensions, useDefaultDim: vcfg.useDefaultDim }
      : null);
    setZhipuApiKey(process.env.ZHIPU_API_KEY || setting.apiKey);
    console.log(`[production] 生产线模型 ${models.length} 条：${models.map((m) => `${m.settingName}/${m.cfg.model}`).join(' + ')}`);
    console.log(`[embed][run] provider=${vcfg ? 'vector-config(zhipu)' : (process.env.EMBED_PROVIDER ?? '(unset)')} zhipuEnv=${process.env.ZHIPU_API_KEY ? process.env.ZHIPU_API_KEY.slice(0,8) : '(unset)'} fallback=${setting.apiKey.slice(0,8)}`);

    // 新一轮开始，清掉上次遗留的取消标志
    this.cancelFlags.delete(datasetId);

    // 重跑：把上次「手动取消排队」留下的 skipped 任务重置回 pending，
    // 否则它们（status=skipped）永远不会被下面的队列选中，重跑等于空转
    await this.db
      .update(extractTasks)
      .set({ status: 'pending', errorMsg: null, attempts: 0 })
      .where(and(eq(extractTasks.datasetId, datasetId), eq(extractTasks.status, 'skipped')));

    // 本轮取消控制器：取消排队时立即中断所有在途 LLM 调用
    const runCtrl = new AbortController();
    this.runSignals.set(datasetId, runCtrl);

    const pending = await this.db
      .select()
      .from(extractTasks)
      .where(
        and(
          eq(extractTasks.datasetId, datasetId),
          // failed 也纳入重跑（本次修复前的任务会因历史 bug 处于 failed），但用 attempts 封顶防止无限重试
          inArray(extractTasks.status, ['pending', 'running', 'failed']),
          lt(extractTasks.attempts, 3),
        ),
      )
      .orderBy(asc(extractTasks.id))
      .limit(limit > 0 ? limit : 1_000_000); // limit<=0 视为不限制，一次性取全部待处理

    const queue = [...pending];
    const stats = {
      total: queue.length,
      models: models.map((m) => ({ settingId: m.settingId, name: m.settingName, model: m.cfg.model })),
      done: 0,
      failed: 0,
      entitiesCreated: 0,
      entitiesMerged: 0,
      entitiesExact: 0,
      cLayer: 0,
      rejected: 0,
      alignPending: 0,
      factDrafts: 0,
      tokens: 0,
      cancelled: false,
    };

    // v2 修复：跑批建立 extraction_run 记录并回填任务 run_id。
    // 草稿/调用日志按 run 归属，发现审核页「按语料域过滤草稿」依赖 run → dataset 关联；
    // 此前不建 run 导致草稿 run_id=0，前端按库过滤全部落空。
    let runId: number | null = null;
    if (queue.length) {
      const [runIns] = await this.db.insert(extractionRuns).values({
        datasetId,
        batchType: 'incremental',
        model: models.map((m) => m.cfg.model).join('+'),
        articleCount: queue.length,
        status: 'running',
        startedAt: new Date(),
      });
      runId = Number(runIns.insertId);
      await this.db
        .update(extractTasks)
        .set({ runId })
        .where(inArray(extractTasks.id, queue.map((t) => t.id)));
    }

    const worker = async (channel: ModelSlot) => {
      while (queue.length) {
        if (this.cancelFlags.has(datasetId)) return; // 已被取消排队：不再取新任务
        const task = queue.shift();
        if (!task) return;
        if (this.running.has(task.id)) continue;
        this.running.add(task.id);
        // 单任务看门狗：每任务独立超时。LLM 慢/挂死时 abort 在途调用并标记 failed（可重跑），
        // 避免一个任务无限拖住整轮 runQueue → 任务计划永远「执行中」。
        const watchdogMs = Math.max(Number(process.env.TASK_WATCHDOG_MS ?? 1_800_000), 60_000);
        const taskCtrl = new AbortController();
        const taskTimer = setTimeout(() => taskCtrl.abort(), watchdogMs);
        const onRunAbort = () => taskCtrl.abort();
        runCtrl.signal.addEventListener('abort', onRunAbort, { once: true });
        try {
          const r = await this.processTask(task.id, channel, taskCtrl.signal);
          if (taskCtrl.signal.aborted && !runCtrl.signal.aborted) {
            // 单任务超时：processTask 已按 signal.aborted 收尾为 skipped，覆盖为 failed 便于重跑
            await this.db
              .update(extractTasks)
              .set({ status: 'failed', errorMsg: `任务超时(${watchdogMs}ms)未完成` })
              .where(eq(extractTasks.id, task.id));
            stats.failed += 1;
          } else {
            stats.done += 1;
            stats.entitiesCreated += r.entitiesCreated;
            stats.entitiesMerged += r.entitiesMerged;
            stats.entitiesExact += r.entitiesExact;
            stats.cLayer += r.cLayer;
            stats.rejected += r.rejected;
            stats.alignPending += r.alignPending;
            stats.factDrafts += r.factDrafts;
            stats.tokens += r.tokens;
          }
        } catch (err) {
          stats.failed += 1;
          const msg = (err as Error).message;
          this.logger.error(`任务 #${task.id} 失败：${msg}`);
          // 收尾：异常必须落库为 failed，否则任务会永远停在 running（前端看不到、也不会被重跑）
          try {
            await this.db
              .update(extractTasks)
              .set({ status: 'failed', errorMsg: msg.slice(0, 500) })
              .where(eq(extractTasks.id, task.id));
          } catch (e2) {
            this.logger.error(`任务 #${task.id} 失败状态写入失败：${(e2 as Error).message}`);
          }
        } finally {
          clearTimeout(taskTimer);
          runCtrl.signal.removeEventListener('abort', onRunAbort);
          this.running.delete(task.id);
        }
      }
    };

    const workers: Promise<void>[] = [];
    // worker 池：每个渠道按自身「并发数」展开固定数量的 worker（渠道 2 条 × 并发 10 = 20 个 worker 并行消化队列）
    for (const m of models) {
      for (let i = 0; i < m.concurrency; i += 1) workers.push(worker(m));
    }
    console.log(
      `[production] 并发 worker 共 ${workers.length} 个：${models.map((m) => `${m.settingName}×${m.concurrency}`).join(' + ')}`,
    );
    await Promise.all(workers);
    this.runSignals.delete(datasetId);

    const cancelled = this.cancelFlags.has(datasetId);
    this.cancelFlags.delete(datasetId);
    if (cancelled) this.logger.warn(`[discovery] 跑批被取消：已处理 ${stats.done}/${stats.total}`);

    // 抽取完成后自动审核收尾（无需后台再点「自动审批」：
    //   单篇 processTask 已自动批准置信>0.9的事实、全部事件、验证通过的关系；
    //   这里补充 —— ① 发布「有事实草稿」的 draft 实体；② 补批剩余高置信(>=0.85)事实草稿。
    // 事件/已批准的事实/关系不在本步重复处理（autoPublish/autoReviewHighConfidence 均幂等）。
    if (!cancelled) {
      try {
        const pub = await this.entityService.autoPublish(datasetId);
        if (Number(pub?.published ?? 0) > 0) this.logger.log(`[discovery] 自动发布实体 ${pub.published} 个`);
      } catch (e) {
        this.logger.warn(`[discovery] 自动发布实体失败：${(e as Error).message}`);
      }
      try {
        const rv = await this.pipelineService.autoReviewHighConfidence(0.85);
        if (Number(rv?.autoApproved ?? 0) > 0) this.logger.log(`[discovery] 跑批后自动审批事实草稿 ${rv.autoApproved} 条`);
      } catch (e) {
        this.logger.warn(`[discovery] 跑批后自动审批事实失败：${(e as Error).message}`);
      }
    }

    // 收尾 run 记录（发现审核页/生产线记录页按 run 统计与过滤）
    if (runId != null) {
      await this.db
        .update(extractionRuns)
        .set({
          status: stats.total > 0 && stats.failed === stats.total ? 'failed' : 'succeeded',
          finishedAt: new Date(),
          statsJson: { ...stats, runId } as unknown as Record<string, unknown>,
        })
        .where(eq(extractionRuns.id, runId));
    }

    return { ...stats, cancelled, runId };
  }

  // ---------------------------------------------------------------- 单篇处理

  /**
   * 单篇处理。channel 为本任务绑定的生产线渠道（模型配置）：
   * 一个任务只由这一个渠道从发现到关系抽取完整跑一遍，逐次落调用日志（可在生产线页面按任务查看）。
   * 多渠道并发提速发生在 runQueue 的 worker 分配层，这里不做跨渠道合并/投票。
   */
  async processTask(taskId: number, channel: ModelSlot, signal?: AbortSignal) {
    const [task] = await this.db.select().from(extractTasks).where(eq(extractTasks.id, taskId)).limit(1);
    if (!task) throw new NotFoundException('任务不存在');
    if (!channel) throw new NotFoundException('未配置生产线模型');
    const models: ModelSlot[] = [channel]; // 本任务仅由绑定渠道处理（runStage/报告沿用单元素数组）

    await this.db
      .update(extractTasks)
      .set({ status: 'running', attempts: task.attempts + 1, stage: 'discover' })
      .where(eq(extractTasks.id, taskId));

    /** 阶段回写：让 extract_task.stage 随真实阶段推进（discover→audit→align→fact→done）；纯观测字段，失败不影响主流程 */
    const setStage = async (s: 'audit' | 'align' | 'fact') => {
      try {
        await this.db.update(extractTasks).set({ stage: s }).where(eq(extractTasks.id, taskId));
      } catch {
        /* 观测字段，失败可忽略 */
      }
    };

    const [bodyRow] = task.articleId
      ? await this.db
          .select({ body: sourceArticleBodies.bodySlice })
          .from(sourceArticleBodies)
          .where(eq(sourceArticleBodies.articleId, task.articleId))
          .limit(1)
      : [undefined];
    const body = (bodyRow?.body ?? '').slice(0, 3000);
    if (!body) {
      await this.db
        .update(extractTasks)
        .set({ status: 'failed', errorMsg: '正文缺失' })
        .where(eq(extractTasks.id, taskId));
      throw new Error('正文缺失');
    }

    const out = {
      entitiesCreated: 0, entitiesMerged: 0, entitiesExact: 0,
      cLayer: 0, rejected: 0, alignPending: 0, factDrafts: 0, eventDrafts: 0, relationDrafts: 0, tokens: 0,
      /** 关系被证据硬校验驳回的条数（head/tail 未逐字出现在引句里等） */
      relationsRejected: 0,
      /** 方向被自动纠正的条数（第 1 层连写语序纠偏 + 第 2 层互逆谓词归一） */
      relationsDirectionFixed: 0,
      /** facts 阶段调用/解析失败次数；factRetries = 收尾补跑涉及的实体数 */
      factFailures: 0, factRetries: 0,
      /** 自动审批统计（source=system） */
      factAutoApproved: 0, eventAutoApproved: 0, relationApproved: 0, relationVerifyFailed: 0,
      /** 按篇即时审批（非队尾全库兜底）统计 */
      instantFactAutoApproved: 0, instantEntityPublished: 0,
      /** 事实→图谱派生统计（Stage 4）：参与实体/落草稿/批准入图/查重跳过 */
      factGraphEntities: 0, factGraphDrafts: 0, factGraphApproved: 0, factGraphDupSkipped: 0,
      /** 关系 schema 代码级校验未通过（谓词不在该类型组合词表）→ 不自动批准、留待人工 */
      relationsSchemaFlagged: 0,
    };

    /** 整体抽取报告：阶段流水 + 抽到的实体/事实/事件/关系 + 每一步处置，落到 extract_task.stats_json.report */
    const report: {
      article: Record<string, unknown>;
      stages: {
        stage: string;
        calls: number;
        tokens: number;
        latencyMs: number;
        models: { model: string; ok: boolean; result: string; latencyMs: number; tokens: number }[];
      }[];
      entities: Record<string, unknown>[];
      facts: Record<string, unknown>[];
      events: Record<string, unknown>[];
      relations: Record<string, unknown>[];
      /** 证据硬校验（①号判据）驳回的关系：引句不支持，故未落草稿；留档便于追溯与调参 */
      relationsRejected: Record<string, unknown>[];
      /** 方向被自动纠正的关系（第 1 层连写语序纠偏 + 第 2 层互逆谓词归一）：留档便于追溯 */
      relationsDirectionFixed: Record<string, unknown>[];
      /** 判别式验证未通过 → 降级草稿待人工的关系（带原因） */
      relationsVerifyFailed: Record<string, unknown>[];
      /** schema 代码级校验未通过（谓词不在类型组合词表）→ 留待人工的关系 */
      relationsSchemaFlagged: Record<string, unknown>[];
    } = {
      article: {
        taskId,
        articleId: task.articleId ?? null,
        title: task.title ?? null,
        sourceOrg: task.sourceOrg ?? null,
        pubDate: task.pubDate ?? null,
        bodyChars: body.length,
        bodyPreview: body.slice(0, 800),
      },
      stages: [],
      entities: [],
      facts: [],
      events: [],
      relations: [],
      relationsRejected: [],
      relationsDirectionFixed: [],
      relationsVerifyFailed: [],
      relationsSchemaFlagged: [],
    };
    const brief = (d: Record<string, unknown>) =>
      Object.entries(d)
        .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object')
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');

    /**
     * 一个阶段 = 本任务绑定的渠道调用一次。
     * 每次调用都落 llm_call_log（带 task_id + 明细），供生产线页面「处理记录 → 明细」展示。
     */
    const runStage = async <T extends { usage: LlmUsage | null; error?: string }>(
      stage: string,
      fn: (cfg: LlmCfg) => Promise<T>,
      detailOf: (r: T) => Record<string, unknown> = () => ({}),
    ): Promise<{ m: ModelSlot; r: T; latencyMs: number }[]> => {
      const results = await Promise.all(
        models.map(async (m) => {
          const t0 = Date.now();
          let r: T;
          try {
            r = await fn({ ...m.cfg, signal });
          } catch (err) {
            r = { usage: null, error: (err as Error).message } as T;
          }
          const latencyMs = Date.now() - t0;
          const pt = r.usage?.promptTokens ?? 0;
          const ct = r.usage?.completionTokens ?? 0;
          out.tokens += pt + ct;
          await this.llmLogService.logCall({
            settingId: m.settingId,
            model: m.cfg.model,
            endpoint: m.cfg.baseUrl,
            purpose: stage,
            promptTokens: pt,
            completionTokens: ct,
            totalTokens: pt + ct,
            latencyMs,
            status: r.error ? 'error' : 'success',
            errorMessage: r.error ?? null,
            taskId,
            articleId: task.articleId ?? null,
            detailJson: { stage, ...detailOf(r) },
            createdBy: null,
          });
          return { m, r, latencyMs };
        }),
      );
      report.stages.push({
        stage,
        calls: results.length,
        tokens: results.reduce((s, x) => s + (x.r.usage?.promptTokens ?? 0) + (x.r.usage?.completionTokens ?? 0), 0),
        latencyMs: results.reduce((s, x) => s + x.latencyMs, 0),
        models: results.map((x) => ({
          model: x.m.cfg.model,
          ok: !x.r.error,
          result: brief(detailOf(x.r)) || (x.r.error ? `失败：${x.r.error}` : 'OK'),
          latencyMs: x.latencyMs,
          tokens: (x.r.usage?.promptTokens ?? 0) + (x.r.usage?.completionTokens ?? 0),
        })),
      });
      return results;
    };

    // ---- 载入分块候选库（v2：该库经 dataset_category 关联的全局分类；供发现/审核/关系提示词动态注入 type 清单）----
    const [dataset] = await this.db.select().from(datasets).where(eq(datasets.id, task.datasetId)).limit(1);
    const catRows = await this.db
      .select({
        id: categories.id,
        parentId: categories.parentId,
        code: categories.code,
        name: categories.name,
        description: categories.description,
      })
      .from(datasetCategories)
      .innerJoin(categories, eq(datasetCategories.categoryId, categories.id))
      .where(and(eq(datasetCategories.datasetId, task.datasetId), eq(categories.status, 'active')))
      .orderBy(asc(datasetCategories.sort));
    const catByCode = new Map(catRows.map((c) => [c.code, c]));
    /** 动态注入发现/审核/关系提示词的关联分类清单（type 的权威来源） */
    const catTypeList: CategoryHint[] = catRows.map((c) => ({
      code: c.code,
      name: c.name,
      description: c.description,
    }));
    // 关系 schema（head 分类 × tail 类型 → 建议关系词）：按本库关联分类加载，注入关系抽取提示词
    const relationSchemaLines = await this.loadRelationSchemasForDataset(task.datasetId);
    // 类型→分类 三级降级：精确 code → 父级前缀 → 语料域首个顶层分类（避免精确匹配失败导致实体被静默丢弃）
    const resolveCategory = (type: string) => {
      const exact = catByCode.get(type);
      if (exact) return exact;
      const prefix = type.split('.')[0];
      const parent = catRows.find((c) => c.code === prefix && !c.parentId);
      if (parent) return parent;
      return catRows.find((c) => !c.parentId) ?? null;
    };

    // ---- Stage 1 发现 ----
    const [discRun] = await runStage('discover', (cfg) => stageDiscover(cfg, body, catTypeList), (r) => ({
      entities: (r as unknown as { entities?: RawEntity[] }).entities?.length ?? 0,
    }));
    const disc = discRun.r.entities ?? [];
    const one = [channel.cfg.model];
    const entitySources = new Map(disc.map((e) => [entityKey(e.name, e.type), one]));

    // 校验：类型白名单 + evidence 逐字 + 去重（纯代码，零成本）
    const seen = new Set<string>();
    const valid: { name: string; type: string; evidence: string; confidence: number }[] = [];
    const discarded: { name: string; type: string; reason: string; evidence: string }[] = [];
    for (const e of disc) {
      const k = entityKey(e.name, e.type);
      if (seen.has(k)) continue;
      seen.add(k);
      if (!e.evidence) {
        discarded.push({ name: e.name, type: e.type, reason: '缺少原文引句', evidence: '' });
        continue;
      }
      if (!body.includes(e.evidence)) {
        discarded.push({ name: e.name, type: e.type, reason: '引句非原文逐字，已丢弃', evidence: e.evidence });
        continue;
      }
      valid.push({ name: e.name, type: e.type, evidence: e.evidence, confidence: Number(e.confidence ?? 0.9) });
    }

    // ---- Stage 1.5 审核 ----
    await setStage('audit');
    const [auditRun] = await runStage('audit', (cfg) => stageAudit(cfg, valid, body, catTypeList), (r) => ({
      results: (r as unknown as { results?: AuditResult[] }).results?.length ?? 0,
      verdicts: tallyVerdicts((r as unknown as { results?: AuditResult[] }).results ?? []),
    }));
    const audit = { results: auditRun.r.results ?? [] };
    const auditMap = new Map(audit.results.map((a) => [norm(a.name), a]));

    const accepted = audit.results.filter((a) => a.verdict === 'accept');
    out.cLayer = audit.results.filter((a) => a.verdict === 'c_layer').length;
    out.rejected = audit.results.filter((a) => a.verdict === 'reject').length;

    // 报告：待审实体条目（含丢弃项），后续把「如何处置」回填进来
    const reportByKey = new Map<string, Record<string, unknown>>();
    const pushEntityRow = (row: Record<string, unknown>, key: string) => {
      report.entities.push(row);
      reportByKey.set(key, row);
    };
    for (const d of discarded) {
      pushEntityRow(
        {
          name: d.name,
          type: d.type,
          confidence: null,
          fromModels: [],
          evidence: d.evidence,
          audit: '未进入审核',
          action: '丢弃',
          reason: d.reason,
        },
        `dropped::${d.name}::${d.type}`,
      );
    }
    for (const item of valid) {
      const a = auditMap.get(norm(item.name));
      const key = entityKey(item.name, item.type);
      pushEntityRow(
        {
          name: item.name,
          type: item.type,
          confidence: item.confidence,
          fromModels: entitySources.get(key) ?? [],
          evidence: item.evidence,
          audit: a ? VERDICT_TEXT[a.verdict] ?? a.verdict : '未判定',
          auditBy: a?.by ?? null,
          description: a?.description ?? null,
          role: a?.role ?? null,
          attrs: a?.attrs ?? null,
          action: a && a.verdict === 'accept' ? '待对齐' : '未通过审核',
          reason: a?.rejectReason ?? null,
        },
        key,
      );
    }

    // ---- Stage 对齐（逐实体）----
    const createdEntityIds: number[] = [];
    /** 把「如何处置」回填到报告条目 */
    const markAction = (name: string, type: string, action: string, patch: Record<string, unknown> = {}) => {
      const row = reportByKey.get(entityKey(name, type));
      if (!row) return;
      row.action = ACTION_TEXT[action] ?? action;
      Object.assign(row, patch);
    };
    await setStage('align');
    for (const item of valid) {
      if (signal?.aborted) break; // 已取消：停止剩余实体对齐
      const a = auditMap.get(norm(item.name));
      if (!a || a.verdict !== 'accept') continue;

      const region = a.attrs.region || geoAnchor(item.evidence, body) || null;
      const category = resolveCategory(item.type);
      if (!category) {
        this.logger.warn(`[align] 语料域(${task.datasetId}) 实体「${item.name}」type=${item.type} 无任何可归类分类，已跳过`);
        continue;
      }

      // 分块：同类别 + 地域锚兼容（v2：实体全局，查重池不按语料域过滤）
      // 性能（F-3A-2）：候选池只取轻量字段（不含 entity_embedding.vec），
      // 向量按分块结果按需拉取，避免「每个提及」都全库拉 3341×2048 维向量。
      const poolRows = await this.db
        .select({
          id: entities.id,
          name: entities.name,
          type: categories.code,
          description: entities.lede,
          attrsJson: entities.attrsJson,
        })
        .from(entities)
        .innerJoin(categories, eq(entities.categoryId, categories.id))
        .where(isNull(entities.deletedAt));

      const poolTargets: AlignTarget[] = poolRows.map((t) => {
        const at = (t.attrsJson ?? {}) as Record<string, string>;
        return {
          id: t.id,
          name: t.name,
          type: t.type,
          description: t.description,
          role: at.role ?? null,
          attrs: { region: at.region, org: at.org, role: at.role },
          geo: at.region ?? null,
          aliases: [],
          vec: null,
        };
      });
      // 克隆分块结果，避免向共享的 poolTargets 元素写入 aliases/vec 造成跨提及污染
      const block = blocking(poolTargets, item.type, region).map((t) => ({ ...t }));

      // 别名（用于 alias_hit 判定）
      const aliasRows = block.length
        ? await this.db
            .select({ entityId: entityAliases.entityId, alias: entityAliases.alias })
            .from(entityAliases)
            .where(inArray(entityAliases.entityId, block.map((b) => b.id)))
        : [];
      const aliasByEntity = new Map<number, string[]>();
      for (const r of aliasRows) {
        const list = aliasByEntity.get(r.entityId) ?? [];
        list.push(r.alias);
        aliasByEntity.set(r.entityId, list);
      }
      for (const t of block) t.aliases = aliasByEntity.get(t.id) ?? [];

      // 分块候选的向量按需拉取（仅 block 内的实体 id）
      if (block.length) {
        const vecRows = await this.db
          .select({ entityId: entityEmbeddings.entityId, vec: entityEmbeddings.vec })
          .from(entityEmbeddings)
          .where(inArray(entityEmbeddings.entityId, block.map((b) => b.id)));
        const vecById = new Map(vecRows.map((r) => [r.entityId, (r.vec as number[] | null) ?? null]));
        for (const t of block) t.vec = vecById.get(t.id) ?? null;
      }

      // 新提及的向量（语义召回不可用时降级为仅字面）
      let mentionVec: number[] | null = null;
      const emb = await embedTexts([entityEmbedText({ name: item.name, description: a.description, role: a.role })], 'query');
      if (emb?.vectors?.length) mentionVec = emb.vectors[0];

      const pre = preAlign(
        {
          name: item.name,
          type: item.type,
          evidence: item.evidence,
          attrs: { region: a.attrs.region, org: a.attrs.org, role: a.attrs.role },
          vec: mentionVec,
        },
        block,
      );

      const draftPayload = {
        name: item.name,
        type: item.type,
        evidence: item.evidence,
        description: a.description,
        role: a.role,
        attrs: a.attrs,
        region,
        auditBy: a.by,
        confidence: item.confidence,
      };

      if (pre.action === 'exact_hit' || pre.action === 'alias_hit') {
        out.entitiesExact += 1;
        markAction(item.name, item.type, pre.action, { matchedEntityId: pre.entityId });
        // 记录候选实体草稿（已存在），供审计与人工复核
        await this.db.insert(extractionDrafts).values({
          runId: task.runId ?? 0,
          entityId: pre.entityId,
          targetType: 'entity',
          payloadJson: { ...draftPayload, alignAction: pre.action },
          status: 'pending',
        });
        createdEntityIds.push(pre.entityId);
        continue;
      }

      if (pre.action === 'review' || pre.action === 'need_llm') {
        // 分数自动裁决：top1 ≥ AUTO_MERGE_TOP1 → 自动合并（写别名）；< AUTO_MERGE_TOP1 → 自动收录新实体
        const top1 = pre.candidates[0] ?? null;
        const top1Score = top1?.score ?? 0;
        let targetRow: { id: number; name: string; attrsJson: Record<string, unknown> | null } | null = null;
        if (top1) {
          const rows = await this.db
            .select({ id: entities.id, name: entities.name, attrsJson: entities.attrsJson })
            .from(entities)
            .where(eq(entities.id, top1.id))
            .limit(1);
          targetRow = rows[0] ?? null;
        }
        if (top1 && targetRow && top1Score >= AUTO_MERGE_TOP1) {
          const rc = roleConflict(
            { role: a.attrs.role },
            { role: (targetRow.attrsJson as Record<string, string> | null)?.role ?? undefined },
          );
          if (rc) {
            // 职务冲突：交人工裁决（不自动合并，防误并）
            out.alignPending += 1;
            markAction(item.name, item.type, 'judge_conflict', {
              matchedEntityId: top1.id,
              matchedEntityName: targetRow.name,
              reason: rc,
              score: Number(top1Score.toFixed(2)),
            });
            await this.db.insert(alignTasks).values({
              datasetId: task.datasetId,
              kind: 'conflict',
              mentionName: item.name,
              mentionType: item.type,
              entityId: top1.id,
              payloadJson: { ...draftPayload, candidates: pre.candidates, reason: rc },
              articleId: task.articleId ?? null,
              runId: task.runId ?? null,
            });
            continue;
          }
          // 自动合并：回写别名（下次零成本命中）
          await this.db
            .insert(entityAliases)
            .values({ entityId: top1.id, alias: item.name, source: 'align_auto' })
            .onDuplicateKeyUpdate({ set: { alias: item.name } });
          out.entitiesMerged += 1;
          createdEntityIds.push(top1.id);
          markAction(item.name, item.type, 'score_merge', {
            matchedEntityId: top1.id,
            matchedEntityName: targetRow.name,
            score: Number(top1Score.toFixed(2)),
          });
          // 审计草稿（approved，来源=system）
          await this.db.insert(extractionDrafts).values({
            runId: task.runId ?? 0,
            entityId: top1.id,
            targetType: 'entity',
            payloadJson: { ...draftPayload, alignAction: 'score_merge', source: 'system', score: Number(top1Score.toFixed(2)) },
            status: 'approved',
          });
          continue;
        }
        // 分数不足或候选查询异常 → 自动收录新实体
        const id = await this.createEntity(task.datasetId, category.id, dataset?.code ?? '', item, a, {
          runId: task.runId,
          articleId: task.articleId,
          pubDate: task.pubDate,
        });
        out.entitiesCreated += 1;
        createdEntityIds.push(id);
        markAction(item.name, item.type, 'score_new', {
          createdEntityId: id,
          reason: top1 ? `top1=${top1Score.toFixed(2)}<${AUTO_MERGE_TOP1}` : ((pre as { reason?: string }).reason ?? '无候选'),
        });
        // 审计草稿（approved，来源=system）
        await this.db.insert(extractionDrafts).values({
          runId: task.runId ?? 0,
          entityId: id,
          targetType: 'entity',
          payloadJson: { ...draftPayload, alignAction: 'score_new', source: 'system', score: top1 ? Number(top1Score.toFixed(2)) : null },
          status: 'approved',
        });
        continue;
      }

      // pre.action === 'new'
      const id = await this.createEntity(task.datasetId, category.id, dataset?.code ?? '', item, a, {
        runId: task.runId,
        articleId: task.articleId,
        pubDate: task.pubDate,
      });
      out.entitiesCreated += 1;
      createdEntityIds.push(id);
      markAction(item.name, item.type, 'new', {
        createdEntityId: id,
        reason: (pre as { reason?: string }).reason ?? null,
      });
    }

    // ---- Stage 2 事实抽取（对本文涉及的实体）----
    // 归一化判定用全量 active 维度（v2：维度全局定义，跨分类精确命中）
    const fullDims = await this.db
      .select({ code: factDimensions.code, name: factDimensions.name })
      .from(factDimensions)
      .where(eq(factDimensions.status, 'active'));

    // 证据批次以文章真实批次为准（档案页基线/增量统计依赖它）
    const [srcArticle] = task.articleId
      ? await this.db.select({ batch: sourceArticles.batch }).from(sourceArticles).where(eq(sourceArticles.id, task.articleId)).limit(1)
      : [];
    const artBatch = (srcArticle?.batch ?? 'incremental') as 'baseline' | 'incremental';

    // 关系草稿去重集（Stage3 关系与后续共用）
    const edgeSeen = new Set<string>();

    const factTargets = [...new Set(createdEntityIds)];

    // ---- 事实/事件批量抽取：每批 ≤10 个实体，正文只发一次（调用数从 O(N) 降到 O(N/10)）----
    const FACT_BATCH = 10;
    const factItems: {
      entityId: number;
      name: string;
      aliases: string[];
      dims: { code: string; name: string }[];
    }[] = [];
    for (const entityId of factTargets) {
      if (signal?.aborted) break;
      const [row] = await this.db
        .select({ name: entities.name, categoryId: entities.categoryId })
        .from(entities)
        .where(eq(entities.id, entityId))
        .limit(1);
      if (!row) continue;
      const aliases = await this.db
        .select({ alias: entityAliases.alias })
        .from(entityAliases)
        .where(eq(entityAliases.entityId, entityId));
      const dims = await this.getCategoryDimensions(task.datasetId, row.categoryId ?? null);
      factItems.push({ entityId, name: row.name, aliases: aliases.map((r2) => r2.alias), dims });
    }

    const factMap = new Map<number, { facts: FactCandidate[]; events: EventCandidate[]; error?: string }>();
    await setStage('fact');
    for (let i = 0; i < factItems.length; i += FACT_BATCH) {
      if (signal?.aborted) break;
      const batch = factItems.slice(i, i + FACT_BATCH);
      const [batchRun] = await runStage(
        'facts',
        (cfg) =>
          stageFactsBatch(
            cfg,
            batch.map((b) => ({ id: b.entityId, name: b.name, aliases: b.aliases, dims: b.dims })),
            body,
          ),
        (r) => ({
          batchSize: batch.length,
          results: (r as unknown as { results?: unknown[] }).results?.length ?? 0,
          entities: batch.map((b) => b.name),
        }),
      );
      const results = batchRun.r.results ?? [];
      // 1) 精确名称匹配
      const claimed = new Set<string>();
      const byName = new Map<string, { facts: FactCandidate[]; events: EventCandidate[] }>();
      for (const res of results) {
        const k = norm(res.entityName);
        if (!byName.has(k)) {
          byName.set(k, { facts: res.facts, events: res.events });
          claimed.add(k);
        }
      }
      for (const b of batch) {
        const hit = byName.get(norm(b.name));
        if (hit) factMap.set(b.entityId, hit);
      }
      // 2) 名称写法不一致时按「包含」兜底认领（避免只因名字多/少几个字就退回逐实体重抽）
      for (const b of batch) {
        if (factMap.has(b.entityId)) continue;
        const bk = norm(b.name);
        const found = results.find((res) => {
          const rk = norm(res.entityName);
          return !claimed.has(rk) && (rk.includes(bk) || bk.includes(rk));
        });
        if (found) {
          claimed.add(norm(found.entityName));
          factMap.set(b.entityId, { facts: found.facts, events: found.events });
        } else {
          factMap.set(b.entityId, { facts: [], events: [], error: batchRun.r.error ?? '批量结果缺失' });
        }
      }
    }

    // 独立回退：批里缺失/失败的实体逐个再抽一次（单实体调用，不连累整批）
    for (const b of factItems) {
      const cur = factMap.get(b.entityId);
      if (cur && !cur.error) continue;
      if (signal?.aborted) break;
      out.factRetries += 1;
      const [fb] = await runStage(
        'facts',
        (cfg) => stageFacts(cfg, { name: b.name, aliases: b.aliases, type: '' }, b.dims, body),
        (r) => ({
          entityName: b.name,
          entityId: b.entityId,
          facts: (r as unknown as { facts?: FactCandidate[] }).facts?.length ?? 0,
          events: (r as unknown as { events?: EventCandidate[] }).events?.length ?? 0,
        }),
      );
      if (fb.r.error) {
        out.factFailures += 1;
        factMap.set(b.entityId, { facts: [], events: [], error: fb.r.error });
      } else {
        factMap.set(b.entityId, { facts: fb.r.facts ?? [], events: fb.r.events ?? [] });
      }
    }

    // ---- 维度/谓词自动归一：规则优先，剩余新词一次批量 LLM 判决，结果沉淀映射表（下次零成本）----
    {
      const knownDimCodes = fullDims.map((d) => d.code);
      const rawDims = [
        ...new Set(
          [...factMap.values()]
            .flatMap((v) => (v.facts ?? []).map((f) => String(f.dimension ?? '').trim()))
            .filter(Boolean),
        ),
      ];
      if (rawDims.length) {
        const pendingDims = await this.collectPendingPredicates(task.datasetId, rawDims, knownDimCodes);
        if (pendingDims.length) {
          const [normRun] = await runStage(
            'normalize',
            (cfg) => stageNormalizePredicates(cfg, pendingDims, knownDimCodes, 'fact'),
            (r) => ({ kind: 'fact', pending: pendingDims.length, mapped: Object.values(r.mapping ?? {}).filter(Boolean).length }),
          );
          await this.applyPredicateMapping(task.datasetId, normRun.r.mapping);
        }
      }
    }

    for (const entityId of factTargets) {
      if (signal?.aborted) break; // 已取消：停止剩余实体的抽取
      const [ent] = await this.db
        .select({ name: entities.name, lede: entities.lede, categoryId: entities.categoryId })
        .from(entities)
        .where(eq(entities.id, entityId))
        .limit(1);
      if (!ent) continue;

      // 按实体分类裁剪提示词维度（显式分配 ∪ 全局未分配维度）
      const scopedDims = await this.getCategoryDimensions(task.datasetId, ent.categoryId ?? null);

      // 事实/事件取自批量结果（缺失/失败的已在上面「独立回退」里逐个重抽过）
      const factRes = factMap.get(entityId) ?? { facts: [], events: [], error: '未获取到结果' };
      const facts = {
        facts: factRes.facts ?? [],
        events: factRes.events ?? [],
        factSources: new Map((factRes.facts ?? []).map((f) => [`${f.dimension}||${f.quote}`, one])),
        eventSources: new Map((factRes.events ?? []).map((ev) => [`${ev.timeText ?? ''}||${ev.quote}`, one])),
      };

      for (const f of facts.facts) {
        if (!body.includes(f.quote)) continue; // 引句必须逐字
        report.facts.push({
          entityId,
          entityName: ent.name,
          dimension: f.dimension,
          statement: f.statement,
          quote: f.quote,
          confidence: f.confidence ?? null,
          risk: f.risk ?? null,
          fromModels: facts.factSources.get(`${f.dimension}||${f.quote}`) ?? [],
          status: '草稿待审',
        });
        const canonical = await this.normalizePredicate(
          task.datasetId,
          f.dimension,
          fullDims.map((d) => d.code),
          scopedDims.map((d) => d.code),
        );
        // payload 结构与 pipeline.approveDraft 对齐，现有人工/自动审核流可直接复用
        const locF = locateQuote(body, f.quote);
        // 证据引句必须是能读出该事实的完整句，禁止只剩实体名/短片段：
        // 用 sentenceAt 把 span 扩成所在整句再落库，短引句自动拉回完整句
        const fullF = locF ? sentenceAt(body, locF.start, locF.end) : null;
        const [insF] = await this.db.insert(extractionDrafts).values({
          runId: task.runId ?? 0,
          entityId,
          targetType: 'fact',
          payloadJson: {
            kind: 'fact',
            entityId,
            entityName: ent.name,
            dimension: canonical,
            rawDimension: f.dimension,
            statement: f.statement,
            confidence: f.confidence ?? 0.9,
            risk: f.risk ?? null,
            articleId: task.articleId,
            publishedAt: task.pubDate,
            source: 'system',
            evidence: {
              quote: fullF?.quote ?? f.quote,
              spanStart: fullF?.start ?? locF?.start ?? 0,
              spanEnd: fullF?.end ?? locF?.end ?? f.quote.length,
              qualityGrade: 'B' as const,
              batch: artBatch,
            },
            dedupeKey: sha256(`${entityId}|${canonical}|${task.articleId}|${f.quote}`),
          },
          status: 'pending',
        });
        out.factDrafts += 1;
        // 事实自动批准：置信度 >0.9 直接入档（审计 reviewedBy=NULL=系统），否则留草稿待人工
        if (Number(f.confidence ?? 0.9) > 0.9) {
          if (await this.autoApproveDraft(Number(insF.insertId))) out.factAutoApproved = (out.factAutoApproved ?? 0) + 1;
        }
      }

      // 事件草稿：时间+主体+动作的真实事件（approveDraft 走 eventService.create，档案页事件时间线数据源）
      // 相对时间（今年/去年/N个月前…）以文章发布日为锚换算成具体日期，保证时间线可排序
      for (const ev of facts.events ?? []) {
        if (!body.includes(ev.quote)) continue; // 引句必须逐字
        const located = locateQuote(body, ev.quote);
        const resolved = resolveRelativeTime(ev.timeText, task.pubDate);
        report.events.push({
          entityId,
          entityName: ent.name,
          description: ev.description,
          timeText: concreteTimeText(resolved, ev.timeText ?? ''),
          timeTextRaw: ev.timeText ?? null,
          quote: ev.quote,
          confidence: ev.confidence ?? null,
          fromModels: facts.eventSources.get(`${ev.timeText ?? ''}||${ev.quote}`) ?? [],
          status: '草稿待审',
        });
        const [insE] = await this.db.insert(extractionDrafts).values({
          runId: task.runId ?? 0,
          entityId,
          targetType: 'event',
          payloadJson: {
            kind: 'event',
            entityId,
            entityName: ent.name,
            dimension: '事件',
            statement: ev.description,
            timeText: concreteTimeText(resolved, ev.timeText ?? ''),
            timeTextRaw: ev.timeText ?? null,
            timePrecision: resolved.precision,
            timeStart: resolved.start,
            timeEnd: resolved.end,
            confidence: Number(ev.confidence ?? 0.8),
            articleId: task.articleId,
            publishedAt: task.pubDate,
            source: 'system',
            evidence: {
              quote: ((sentenceAt(body, (located?.start ?? 0), (located?.end ?? ev.quote.length))) as { quote: string })?.quote ?? ev.quote,
              spanStart: located?.start ?? 0,
              spanEnd: located?.end ?? ev.quote.length,
              qualityGrade: 'B' as const,
              batch: artBatch,
            },
            dedupeKey: sha256(`event|${entityId}|${task.articleId}|${ev.quote}`),
          },
          status: 'pending',
        });
        out.eventDrafts = (out.eventDrafts ?? 0) + 1;
        // 事件自动批准：抽取后全部入时间线（审计 reviewedBy=NULL=系统）
        if (await this.autoApproveDraft(Number(insE.insertId))) out.eventAutoApproved = (out.eventAutoApproved ?? 0) + 1;
      }
    }

    // ---- Stage 3 关系抽取（知识图谱的边）：按实体分批调用（每批 ≤6，防输出过长 JSON 截断）----
    // 主体限定为「本文已入库/命中的实体」，避免整库扫描。
    const relEntities = await this.loadRelationEntities(task.datasetId, [...new Set(createdEntityIds)]);
    // 计划关闭「关系图谱抽取」时跳过 Stage 3 LLM 关系抽取；
    // 其后的关系谓词归一（applyPredicateMapping 'relation'）同在此块内，一并跳过。
    if (task.extractRelations && relEntities.length >= 2) {
      const [relRun] = await runStage(
        'relations',
        (cfg) => stageRelations(cfg, relEntities.map((e) => ({ name: e.name, type: e.type })), body, catTypeList, relationSchemaLines),
        (r) => {
          const rr = r as unknown as {
            relations?: RelationCandidate[]; rejected?: RelationReject[]; directionFixes?: RelationDirectionFix[];
          };
          return {
            relations: rr.relations?.length ?? 0,
            rejected: rr.rejected?.length ?? 0,
            fixed: rr.directionFixes?.length ?? 0,
          };
        },
      );
      // ① 证据硬校验驳回留档：这些关系没有落草稿，但必须在报告里可见（不做静默丢弃）
      const relRejected: RelationReject[] = relRun.r.rejected ?? [];
      if (relRejected.length) {
        out.relationsRejected += relRejected.length;
        this.logger.warn(
          `任务 #${task.id} 关系证据校验驳回 ${relRejected.length} 条；示例：${relRejected[0].head} -${relRejected[0].predicate}-> ${relRejected[0].tail}（${relRejected[0].reason}）`,
        );
        // 只留前 20 条，防 stats_json 过大；展开成普通对象以适配 Record<string, unknown>
        report.relationsRejected.push(...relRejected.slice(0, 20).map((r) => ({ ...r })));
      }
      // 第 1 层方向纠偏留档：已在 stageRelations 内完成 head/tail 交换，这里只记录
      const relFixed: RelationDirectionFix[] = relRun.r.directionFixes ?? [];
      if (relFixed.length) {
        out.relationsDirectionFixed += relFixed.length;
        this.logger.warn(
          `任务 #${task.id} 关系方向自动纠偏 ${relFixed.length} 条；示例：${relFixed[0].head} -${relFixed[0].predicate}-> ${relFixed[0].tail}（${relFixed[0].reason}）`,
        );
        report.relationsDirectionFixed.push(...relFixed.slice(0, 20).map((r) => ({ ...r })));
      }
      const merged = {
        relations: relRun.r.relations ?? [],
        sources: new Map((relRun.r.relations ?? []).map((r) => [relationKey(r), one])),
      };

      // 关系谓词自动归一：规则优先，剩余新词一次批量 LLM 判决并沉淀映射表
      {
        // 关系谓词归一：只认推荐词表（已剔除泛化词）+ 已沉淀 predicate_map；事实维度(code=中文口径)不再混入关系谓词
        const knownPreds = usableRelationHints();
        const rawPreds = [
          ...new Set(merged.relations.map((r) => String(r.predicate ?? '').trim()).filter(Boolean)),
        ];
        if (rawPreds.length) {
          const pendingPreds = await this.collectPendingPredicates(task.datasetId, rawPreds, knownPreds);
          if (pendingPreds.length) {
            const [normRun] = await runStage(
              'normalize',
              (cfg) => stageNormalizePredicates(cfg, pendingPreds, knownPreds, 'relation'),
              (r) => ({ kind: 'relation', pending: pendingPreds.length, mapped: Object.values(r.mapping ?? {}).filter(Boolean).length }),
            );
            await this.applyPredicateMapping(task.datasetId, normRun.r.mapping);
          }
        }
      }

      const nameToId = await this.loadEntityNameIndex(task.datasetId);
      // 实体 id → 分类 code（schema 校验 head/tail 类型组合用）
      const entityCats = await this.db
        .select({ id: entities.id, code: categories.code })
        .from(entities)
        .innerJoin(categories, eq(entities.categoryId, categories.id));
      const catById = new Map<number, string>(entityCats.map((r) => [Number(r.id), r.code]));

      // ---- ③ 同谓词反向去重（通用，非枚举谓词）----
      // 谓词归一并落到同一对实体后，双向各产一条视为重复：只保留方向符合「实体类型序」
      // （人物→机构→活动/产品/食物→地点）的那条，同档或未知则比置信度。顺序 = 先归一后去重，
      // 因此 举行/主办/承办 这类同义会先收敛成同一谓词，反向对才能被识别并合并。
      const canonCache = new Map<string, string>();
      const canonOf = async (p: string) => {
        const k = String(p ?? '').trim();
        if (!canonCache.has(k)) canonCache.set(k, await this.normalizeRelationPredicate(task.datasetId, k));
        return canonCache.get(k)!;
      };
      // 实体类型方向序：只按 coarse 类型族定序（非谓词枚举）
      const typeRank = (code?: string | null): number => {
        const c = code ?? '';
        if (c.includes('person')) return 10; // 人物
        if (c.includes('org')) return 8; // 机构
        if (c.includes('event') || c.includes('activity')) return 6; // 活动/事件
        if (c.includes('work') || c.includes('product') || c.includes('food') || c.includes('dish')) return 5; // 作品/产品/食物
        if (c.includes('place') || c.includes('site')) return 4; // 地点
        return 2; // 概念/其它
      };
      const cands: {
        i: number; hKey: string; tKey: string; hRank: number; tRank: number; conf: number;
        head: string; tail: string; canon: string; quote?: string;
      }[] = [];
      const pairToCands = new Map<string, number[]>();
      for (let i = 0; i < merged.relations.length; i += 1) {
        const rel0 = merged.relations[i];
        const inv = normalizeInversePair(rel0);
        const rel = inv?.rel ?? rel0;
        const hid = nameToId.get(norm(rel.head));
        if (hid == null) continue; // 与下方主循环同规则：头实体必须能落到实体
        const tid = nameToId.get(norm(rel.tail)) ?? null;
        const canon = await canonOf(rel.predicate);
        const hKey = `e${hid}`;
        const tKey = tid != null ? `e${tid}` : `t${norm(rel.tail)}`;
        const pairKey = `${canon}\u0000${[hKey, tKey].sort().join('\u0000')}`;
        const rec = {
          i, hKey, tKey,
          hRank: typeRank(catById.get(hid)),
          tRank: typeRank(tid != null ? catById.get(tid) : rel.tail_type),
          conf: Number(rel.confidence ?? 0.85),
          head: rel.head, tail: rel.tail, canon, quote: rel.quote,
        };
        const arr = pairToCands.get(pairKey) ?? [];
        arr.push(cands.length);
        pairToCands.set(pairKey, arr);
        cands.push(rec);
      }
      const dropIdx = new Set<number>();
      for (const idxs of pairToCands.values()) {
        if (idxs.length < 2) continue;
        // 同对实体 + 同谓词：保留 rankDiff 更大（且更信）的那条方向，其余反向边丢弃
        let win = -1; let winDiff = -Infinity; let winConf = 0;
        for (const ci of idxs) {
          const c = cands[ci];
          const d = c.hRank - c.tRank;
          if (d > winDiff || (d === winDiff && c.conf > winConf)) { win = ci; winDiff = d; winConf = c.conf; }
        }
        for (const ci of idxs) if (ci !== win) dropIdx.add(cands[ci].i);
      }

      for (let i = 0; i < merged.relations.length; i += 1) {
        const rel0 = merged.relations[i];
        // 同谓词反向去重的落败方向：不入草稿，仅计入纠偏报告
        if (dropIdx.has(i)) {
          const c = cands.find((x) => x.i === i);
          out.relationsDirectionFixed += 1;
          report.relationsDirectionFixed.push({
            head: c?.head ?? '', tail: c?.tail ?? '', predicate: c?.canon ?? '', quote: c?.quote ?? '',
            confidence: c?.conf ?? 0,
            reason: `双向去重：同谓词反向边已合并（保留 ${c ? `${c.hKey} → ${c.tKey}` : '更高置信方向'}）`,
          });
          continue;
        }
        // 第 2 层：互逆谓词对归一（下辖/辖有 → 隶属于，统一「小→大」方向，需交换头尾，避免同一事实两个反向边并存）
        const inverse = normalizeInversePair(rel0);
        const rel = inverse?.rel ?? rel0;
        if (inverse) {
          out.relationsDirectionFixed += 1;
          report.relationsDirectionFixed.push({
            head: rel0.head, tail: rel0.tail, predicate: inverse.from, quote: rel0.quote,
            confidence: Number(rel0.confidence ?? 0),
            reason: `互逆谓词归一：${inverse.from} → 隶属于（已交换为 ${rel.head} ${rel.predicate} ${rel.tail}）`,
          });
        }
        const headId = nameToId.get(norm(rel.head));
        if (!headId) continue; // 头实体必须能落到库里的实体
        // 尾实体归一：先解析到库内已有实体（去"温州/浙江"前缀、去行政区后缀），避免同一地点写成两条边
        const tailResolved = await this.resolveTailEntity(task.datasetId, rel.tail);
        const tailId = tailResolved?.id ?? nameToId.get(norm(rel.tail)) ?? null; // 未命中即为「新候选」
        const canonical = await canonOf(rel.predicate);
        // 草稿级去重：同 head + 归一谓词 + 归一 tail 只保留一条（与事实补边共用 edgeSeen）
        const edgeKey = `${headId}|${canonical}|${tailId ?? norm(rel.tail)}`;
        if (edgeSeen.has(edgeKey)) continue;
        edgeSeen.add(edgeKey);
        // ③ 关系把关：空间/归属泛词未逐字出现在引句 = 脑补 → 硬拦（不进草稿，记入驳回）；
        //    其余开放谓词放行（语义质量由判别式验证器把关）。
        const headCode = catById.get(headId) ?? '';
        const tailCode = tailId ? (catById.get(tailId) ?? null) : (rel.tail_type ?? null);
        const gate = checkRelationSchemaGate(relationSchemaLines, headCode, tailCode, canonical, rel.quote);
        if (!gate.ok && gate.hard) {
          out.relationsRejected += 1;
          report.relationsRejected.push({
            head: rel.head, tail: rel.tail, predicate: canonical, quote: rel.quote,
            confidence: Number(rel.confidence ?? 0),
            reason: gate.reason ?? '泛谓词脑补，已拦',
          });
          this.logger.warn(`任务 #${task.id} 关系把关硬拦：${rel.head} -${canonical}-> ${rel.tail}（${gate.reason}）`);
          continue;
        }
        const located = locateQuote(body, rel.quote);
        const modelsOfRel = merged.sources.get(relationKey(rel0)) ?? [];
        await this.db.insert(extractionDrafts).values({
          runId: task.runId ?? 0,
          entityId: headId,
          targetType: 'relation',
          payloadJson: {
            kind: 'relation',
            headEntityId: headId,
            headEntityName: rel.head,
            predicate: canonical,
            predicateRaw: rel.predicate,
            tailEntityId: tailId,
            tailText: tailResolved?.name ?? rel.tail,
            tailType: rel.tail_type ?? null,
            statement: rel.statement ?? `${rel.head} ${rel.predicate} ${rel.tail}`,
            confidence: gate.ok ? Number(rel.confidence ?? 0.85) : Math.min(Number(rel.confidence ?? 0.85), 0.4),
            articleId: task.articleId,
            publishedAt: task.pubDate,
            fromModels: modelsOfRel,
            evidence: {
              quote: ((sentenceAt(body, (located?.start ?? 0), (located?.end ?? rel.quote.length))) as { quote: string })?.quote ?? rel.quote,
              spanStart: located?.start ?? 0,
              spanEnd: located?.end ?? rel.quote.length,
              qualityGrade: 'B' as const,
              batch: artBatch,
            },
            dedupeKey: sha256(`relation|${headId}|${canonical}|${norm(rel.tail)}|${task.articleId}`),
            // schema 校验未通过：压置信度 + 标识，供人工在审核页看到原因；且不再进 LLM 判别式验证（保持待人工）
            ...(gate.ok
              ? {}
              : { verifyFailed: true, verifyReason: gate.reason, schemaGateFail: true }),
          },
          status: 'pending',
        });
        out.relationDrafts += 1;
        if (!gate.ok) {
          out.relationsSchemaFlagged += 1;
          report.relationsSchemaFlagged.push({
            id: null,
            head: rel.head,
            predicate: canonical,
            predicateRaw: rel.predicate,
            tail: rel.tail,
            headType: headCode,
            tailType: tailCode ?? rel.tail_type ?? null,
            quote: rel.quote,
            reason: gate.reason,
          });
        }
        report.relations.push({
          headEntityId: headId,
          head: rel.head,
          predicate: canonical,
          predicateRaw: rel.predicate,
          tailText: rel.tail,
          tailEntityId: tailId,
          tailMatched: tailId != null,
          statement: rel.statement ?? `${rel.head} ${rel.predicate} ${rel.tail}`,
          quote: rel.quote,
          confidence: gate.ok ? Number(rel.confidence ?? 0.85) : Math.min(Number(rel.confidence ?? 0.85), 0.4),
          fromModels: modelsOfRel,
          status: gate.ok ? '草稿待审' : '待人工（谓词不在词表）',
        });
      }
    }

    // ---- 关系判别式验证 + 自动批准/降级（覆盖 Stage3 与 entity_ref 边）----
    // 验证器独立判定「引句是否足以支撑关系 + 类型兼容」；通过 → 自动批准入图；
    // 不通过/异常 → 降级草稿待人工（带 verifyFailed 标识，不丢弃）。
    // 关闭关系抽取时无关系草稿可验，整体跳过（否则空转一次 DB 查询）
    if (task.extractRelations && !signal?.aborted && (task.runId ?? 0)) {
      const pendingRels = (await this.db
        .select({ id: extractionDrafts.id, payloadJson: extractionDrafts.payloadJson })
        .from(extractionDrafts)
        .where(
          and(
            eq(extractionDrafts.runId, task.runId ?? 0),
            eq(extractionDrafts.targetType, 'relation'),
            eq(extractionDrafts.status, 'pending'),
          ),
        )).filter((d) => !(d.payloadJson as { schemaGateFail?: boolean }).schemaGateFail); // schema 校验未过的留待人工，不进判别式验证
      if (pendingRels.length) {
        const samples = await this.loadRejectSamples(task.datasetId, 8);
        const headTypeById = new Map(relEntities.map((e) => [e.id, e.type]));
        for (let i = 0; i < pendingRels.length; i += 20) {
          const chunk = pendingRels.slice(i, i + 20);
          const inputs: RelationVerifyInput[] = chunk.map((d) => {
            const p = d.payloadJson as unknown as {
              headEntityId?: number; headEntityName?: string; predicate?: string;
              tailText?: string; tailType?: string | null; statement?: string; evidence?: { quote?: string };
            };
            return {
              head: String(p.headEntityName ?? ''),
              headType: p.headEntityId != null ? (headTypeById.get(Number(p.headEntityId)) ?? null) : null,
              tail: String(p.tailText ?? ''),
              tailType: p.tailType ?? null,
              predicate: String(p.predicate ?? ''),
              quote: p.evidence?.quote ?? '',
              statement: p.statement ?? '',
            };
          });
          const [vRun] = await runStage(
            'verify_relations',
            (cfg) => stageVerifyRelations(cfg, inputs, { rejectSamples: samples, typeHints: catTypeList }),
            (r) => ({
              total: inputs.length,
              pass: (r as unknown as { verdicts?: RelationVerdict[] }).verdicts?.filter((v) => v.verdict === 'pass').length ?? 0,
              fail: (r as unknown as { verdicts?: RelationVerdict[] }).verdicts?.filter((v) => v.verdict === 'fail').length ?? 0,
            }),
          );
          const vv = vRun.r as unknown as { verdicts?: RelationVerdict[]; error?: string };
          if (vRun.r.error || !vv.verdicts) {
            // LLM/解析异常 → 全部留 pending 待人工（安全方向，不丢数据）
            out.relationVerifyFailed += chunk.length;
            continue;
          }
          for (let j = 0; j < chunk.length; j += 1) {
            const d = chunk[j];
            const v = vv.verdicts[j];
            if (!v || v.verdict !== 'pass') {
              // 验证不通过 → 降级草稿待人工：压低置信度 + verifyFailed 标识 + 保留原因
              const p = d.payloadJson as Record<string, unknown>;
              const curConf = Number((p as { confidence?: number }).confidence ?? 0.5);
              const updated = { ...p, confidence: Math.min(curConf, 0.4), verifyFailed: true, verifyReason: v?.reason ?? '验证未通过' };
              await this.db
                .update(extractionDrafts)
                .set({ payloadJson: updated })
                .where(eq(extractionDrafts.id, d.id));
              out.relationVerifyFailed += 1;
              report.relationsVerifyFailed.push({
                id: d.id,
                head: inputs[j].head,
                predicate: inputs[j].predicate,
                tail: inputs[j].tail,
                quote: inputs[j].quote,
                reason: v?.reason ?? '验证未通过',
              });
            } else if (await this.autoApproveDraft(d.id)) {
              out.relationApproved += 1;
            }
          }
        }
      }
    }

    // 被取消（取消排队中断了在途调用）：收尾为 skipped，而非 done
    if (signal?.aborted) {
      await this.db
        .update(extractTasks)
        .set({
          status: 'skipped',
          stage: 'pending',
          statsJson: { ...out, report },
          errorMsg: '手动取消排队',
        })
        .where(eq(extractTasks.id, taskId));
      return out;
    }

    // 按篇即时审批：本篇文章涉及的实体/事实，处理完立刻自动审批入档，
    // 不再等整批跑批结束（队尾 autoPublish/autoReviewHighConfidence 仍保留兜底）。
    try {
      const instant = await this.autoApproveByEntityIds(task.datasetId, [...new Set(createdEntityIds)]);
      out.instantFactAutoApproved = instant.factApproved;
      out.instantEntityPublished = instant.entityPublished;
    } catch (e) {
      this.logger.warn(`[discovery] 按篇即时审批失败：${(e as Error).message}`);
    }

    // ---- Stage 4 事实→图谱：从本篇已入档（active）事实派生关系边 ----
    // 输入是即时审批后的事实清单（非草稿），派生边直接补图密度；防重四层：
    // prompt 注入已有边 → 谓词归一 → 批内无序对去重 → 库级同义查重 + approveDraft 行锁合并。
    // 关闭关系抽取时同时跳过：其内部的候选筛选/谓词归一/草稿写入均只服务关系边
    if (task.extractRelations && !signal?.aborted && createdEntityIds.length) {
      try {
        const fg = await this.deriveRelationsFromFacts({
          datasetId: task.datasetId,
          entityIds: [...new Set(createdEntityIds)],
          models,
          runId: task.runId ?? 0,
          taskId,
          signal,
        });
        out.factGraphEntities = fg.entities;
        out.factGraphDrafts = fg.drafts;
        out.factGraphApproved = fg.approved;
        out.factGraphDupSkipped = fg.dupSkipped;
      } catch (e) {
        this.logger.warn(`[discovery] 事实→图谱派生失败（任务 #${taskId}）：${(e as Error).message}`);
      }
    }

    await this.db
      .update(extractTasks)
      .set({
        status: 'done',
        stage: 'done',
        statsJson: {
          ...out,
          models: models.map((m) => ({ settingId: m.settingId, name: m.settingName, model: m.cfg.model })),
          report: {
            ...report,
            summary: {
              models: models.map((m) => m.cfg.model),
              stageCount: report.stages.length,
              entityCount: report.entities.length,
              factCount: report.facts.length,
              eventCount: report.events.length,
              relationCount: report.relations.length,
              tokens: out.tokens,
            },
          },
        },
        errorMsg: null,
      })
      .where(eq(extractTasks.id, taskId));

    return out;
  }

  // ---------------------------------------------------------------- 生产线处理记录

  /** 当前生产线渠道（文本模型：启用 + 设为生产线）；concurrency = Σ 各渠道并发数（跑批 worker 总数） */
  async productionModels() {
    const settings = await this.llmConfigService.getProductionSettings();
    const per = (v: unknown) => Math.min(Math.max(Number(v ?? 10), 1), 50);
    return {
      source: settings.length ? 'text' : 'none',
      concurrency: settings.reduce((sum, s) => sum + per(s.concurrency), 0),
      models: settings.map((s) => ({
        id: s.id,
        name: s.name,
        model: s.model,
        baseUrl: s.baseUrl,
        temperature: Number(s.temperature),
        maxTokens: s.maxTokens,
        concurrency: per(s.concurrency),
        enabled: s.enabled,
        isDefault: s.isDefault,
      })),
    };
  }

  /** 处理记录：每篇文章一次处理（extract_task），带模型调用汇总 */
  async listRecords(query: {
    datasetId?: number;
    status?: string;
    page?: number;
    pageSize?: number;
    /** task=处理先后（默认，经典生产线沿用）；pubDate=新闻发布时间倒序（演示版实时新闻流） */
    orderBy?: 'task' | 'pubDate';
  }) {
    const page = query.page ?? 1;
    const pageSize = Math.min(Math.max(query.pageSize ?? 20, 1), 100);
    const where = and(
      query.datasetId ? eq(extractTasks.datasetId, query.datasetId) : undefined,
      query.status ? eq(extractTasks.status, query.status as 'pending' | 'running' | 'done' | 'failed' | 'skipped') : undefined,
    );
    const [{ value: total }] = await this.db.select({ value: count() }).from(extractTasks).where(where);
    const rows = await this.db
      .select({
        id: extractTasks.id,
        datasetId: extractTasks.datasetId,
        articleId: extractTasks.articleId,
        title: extractTasks.title,
        sourceOrg: extractTasks.sourceOrg,
        pubDate: extractTasks.pubDate,
        bodyChars: extractTasks.bodyChars,
        stage: extractTasks.stage,
        status: extractTasks.status,
        attempts: extractTasks.attempts,
        errorMsg: extractTasks.errorMsg,
        createdAt: extractTasks.createdAt,
        updatedAt: extractTasks.updatedAt,
        stats: extractTasks.statsJson,
      })
      .from(extractTasks)
      .where(where)
      .orderBy(
        ...(query.orderBy === 'pubDate'
          ? [desc(extractTasks.pubDate), desc(extractTasks.id)]
          : [desc(extractTasks.id)]),
      )
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const ids = rows.map((r) => r.id);
    const callStats = ids.length
      ? await this.db
          .select({
            taskId: llmCallLogs.taskId,
            calls: count(),
            errors: sql<number>`SUM(CASE WHEN ${llmCallLogs.status}='error' THEN 1 ELSE 0 END)`,
            totalTokens: sql<number>`COALESCE(SUM(${llmCallLogs.totalTokens}),0)`,
            avgLatency: sql<number>`COALESCE(ROUND(AVG(${llmCallLogs.latencyMs})),0)`,
          })
          .from(llmCallLogs)
          .where(inArray(llmCallLogs.taskId, ids))
          .groupBy(llmCallLogs.taskId)
      : [];
    const callMap = new Map(callStats.map((c) => [Number(c.taskId), c]));

    return {
      items: rows.map((r) => ({
        ...r,
        // 列表只带计数，完整抽取报告在明细接口返回（避免列表过大）
        stats: pickStats((r.stats ?? {}) as Record<string, unknown>),
        llm: {
          calls: Number(callMap.get(r.id)?.calls ?? 0),
          errors: Number(callMap.get(r.id)?.errors ?? 0),
          totalTokens: Number(callMap.get(r.id)?.totalTokens ?? 0),
          avgLatencyMs: Number(callMap.get(r.id)?.avgLatency ?? 0),
        },
      })),
      total: Number(total),
      page,
      pageSize,
    };
  }

  /** 单条处理明细：任务概览 + 各模型调用汇总 + 调用次数统计 */
  async getRecord(id: number) {
    const [task] = await this.db.select().from(extractTasks).where(eq(extractTasks.id, id)).limit(1);
    if (!task) throw new NotFoundException('处理记录不存在');

    const [totals] = await this.db
      .select({
        calls: count(),
        success: sql<number>`SUM(CASE WHEN ${llmCallLogs.status}='success' THEN 1 ELSE 0 END)`,
        errors: sql<number>`SUM(CASE WHEN ${llmCallLogs.status}='error' THEN 1 ELSE 0 END)`,
        promptTokens: sql<number>`COALESCE(SUM(${llmCallLogs.promptTokens}),0)`,
        completionTokens: sql<number>`COALESCE(SUM(${llmCallLogs.completionTokens}),0)`,
        totalTokens: sql<number>`COALESCE(SUM(${llmCallLogs.totalTokens}),0)`,
        avgLatency: sql<number>`COALESCE(ROUND(AVG(${llmCallLogs.latencyMs})),0)`,
      })
      .from(llmCallLogs)
      .where(eq(llmCallLogs.taskId, id));

    const byModel = await this.db
      .select({
        settingId: llmCallLogs.settingId,
        settingName: llmSettings.name,
        model: llmCallLogs.model,
        calls: count(),
        success: sql<number>`SUM(CASE WHEN ${llmCallLogs.status}='success' THEN 1 ELSE 0 END)`,
        errors: sql<number>`SUM(CASE WHEN ${llmCallLogs.status}='error' THEN 1 ELSE 0 END)`,
        totalTokens: sql<number>`COALESCE(SUM(${llmCallLogs.totalTokens}),0)`,
        avgLatency: sql<number>`COALESCE(ROUND(AVG(${llmCallLogs.latencyMs})),0)`,
      })
      .from(llmCallLogs)
      .leftJoin(llmSettings, eq(llmCallLogs.settingId, llmSettings.id))
      .where(eq(llmCallLogs.taskId, id))
      .groupBy(llmCallLogs.settingId, llmSettings.name, llmCallLogs.model);

    const byStage = await this.db
      .select({
        stage: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${llmCallLogs.detailJson}, '$.stage'))`,
        calls: count(),
        totalTokens: sql<number>`COALESCE(SUM(${llmCallLogs.totalTokens}),0)`,
        avgLatency: sql<number>`COALESCE(ROUND(AVG(${llmCallLogs.latencyMs})),0)`,
      })
      .from(llmCallLogs)
      .where(eq(llmCallLogs.taskId, id))
      .groupBy(sql`JSON_UNQUOTE(JSON_EXTRACT(${llmCallLogs.detailJson}, '$.stage'))`);

    const stats = (task.statsJson ?? {}) as Record<string, unknown>;
    return {
      ...task,
      stats,
      report: (stats.report as Record<string, unknown> | undefined) ?? null,
      calls: {
        total: Number(totals?.calls ?? 0),
        success: Number(totals?.success ?? 0),
        errors: Number(totals?.errors ?? 0),
        promptTokens: Number(totals?.promptTokens ?? 0),
        completionTokens: Number(totals?.completionTokens ?? 0),
        totalTokens: Number(totals?.totalTokens ?? 0),
        avgLatencyMs: Number(totals?.avgLatency ?? 0),
      },
      byModel: byModel.map((m) => ({
        settingId: m.settingId,
        settingName: m.settingName,
        model: m.model,
        calls: Number(m.calls),
        success: Number(m.success),
        errors: Number(m.errors),
        totalTokens: Number(m.totalTokens),
        avgLatencyMs: Number(m.avgLatency),
      })),
      byStage: byStage.map((s) => ({
        stage: s.stage,
        calls: Number(s.calls),
        totalTokens: Number(s.totalTokens),
        avgLatencyMs: Number(s.avgLatency),
      })),
    };
  }

  /** 某条处理的 LLM 调用明细 */
  async listRecordCalls(
    taskId: number,
    query: { status?: string; stage?: string; page?: number; pageSize?: number },
  ) {
    const page = query.page ?? 1;
    const pageSize = Math.min(Math.max(query.pageSize ?? 20, 1), 200);
    const where = and(
      eq(llmCallLogs.taskId, taskId),
      query.status ? eq(llmCallLogs.status, query.status as 'success' | 'error') : undefined,
      query.stage
        ? sql`JSON_UNQUOTE(JSON_EXTRACT(${llmCallLogs.detailJson}, '$.stage')) = ${query.stage}`
        : undefined,
    );
    const [{ value: total }] = await this.db.select({ value: count() }).from(llmCallLogs).where(where);
    const items = await this.db
      .select()
      .from(llmCallLogs)
      .where(where)
      .orderBy(desc(llmCallLogs.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { items, total: Number(total), page, pageSize };
  }

  /** 某条处理产出的草稿（事实 / 事件 / 实体候选） */
  async listRecordDrafts(taskId: number, page = 1, pageSize = 50) {
    const [task] = await this.db.select().from(extractTasks).where(eq(extractTasks.id, taskId)).limit(1);
    if (!task) throw new NotFoundException('处理记录不存在');
    const size = Math.min(Math.max(pageSize, 1), 200);
    const where = task.articleId
      ? sql`JSON_EXTRACT(${extractionDrafts.payloadJson}, '$.articleId') = ${task.articleId}`
      : sql`1 = 0`;
    const [{ value: total }] = await this.db.select({ value: count() }).from(extractionDrafts).where(where);
    const items = await this.db
      .select()
      .from(extractionDrafts)
      .where(where)
      .orderBy(desc(extractionDrafts.id))
      .limit(size)
      .offset((page - 1) * size);
    return { items, total: Number(total), page, pageSize: size };
  }

  // ---------------------------------------------------------------- 内部

  private async createEntity(
    datasetId: number,
    categoryId: number,
    datasetCode: string,
    item: { name: string; type: string; evidence: string },
    a: { description: string; role: string; attrs: { region: string; org: string; role: string } },
    /** 供「entity_ref 自动成边」落关系草稿用；无文章上下文（如纯人工新建）时可不传 */
    ctx?: { runId?: number | null; articleId?: number | null; pubDate?: string | null; batch?: 'baseline' | 'incremental' },
  ): Promise<number> {
    // 只保留该类别真正定义过的字段（field_def 按类别继承解析），
    // 否则 zod 校验会拒绝额外字段（如 culture.food 未定义 org/role）
    const fields = await this.fieldDefService.resolve(categoryId);
    const allowed = new Set(fields.map((f) => f.key));
    const attrs: Record<string, unknown> = {};
    const raw: Record<string, unknown> = { ...a.attrs, wenz_link: 'explicit' };
    for (const [k, v] of Object.entries(raw)) {
      if (allowed.has(k) && v !== '' && v !== null && v !== undefined) attrs[k] = v;
    }

    // entity_ref 自动填充：把审核给出的「地域 / 机构」文本解析成已存在实体 id，
    // 填进 *_ref 字段（知识图谱据此自动成边）；解析不到就不填，避免脏引用。
    const refSource: Record<string, 'region' | 'org'> = {
      region_ref: 'region',
      org_ref: 'org',
      parent_org_ref: 'org',
    };
    for (const f of fields) {
      if (f.type !== 'entity_ref') continue;
      const srcKey = refSource[f.key];
      if (!srcKey) continue;
      const text = String((a.attrs as Record<string, string>)[srcKey] ?? '');
      if (!text) continue;
      const refId = await this.resolveRefByText(text);
      if (refId) attrs[f.key] = refId;
    }

    let created: { id: number };
    try {
      created = (await this.entityService.create({
        originDatasetId: datasetId,
        categoryId,
        name: item.name,
        lede: a.description || null,
        seedSource: 'llm_discover',
        attrs,
        status: 'draft',
        aliases: [],
      } as never)) as unknown as { id: number };
    } catch (err) {
      // 幂等：实体已存在（URN 唯一键冲突 / slug 撞车，常见于多任务并发抽到同一实体）→ 复用已有实体，
      // 不再让整篇任务因一个重复实体而中断。
      // 匹配范围放宽到「同数据集的全部类别 + 同名」：LLM 对同一现实对象换类型重抽
      // （如 org.company → geo.landmark，上田农贸案例）时也命中复用，从源头杜绝双行实体
      const datasetCategoryIds = this.db
        .select({ id: datasetCategories.categoryId })
        .from(datasetCategories)
        .where(eq(datasetCategories.datasetId, datasetId ?? 0));
      const [existing] = await this.db
        .select({ id: entities.id })
        .from(entities)
        .where(
          and(
            eq(entities.name, item.name),
            inArray(entities.categoryId, datasetCategoryIds),
            isNull(entities.deletedAt),
          ),
        )
        .limit(1);
      if (!existing) throw err;
      created = { id: existing.id };
    }

    // 向量（块内精排用；服务不可用则跳过，退化为仅字面召回）
    const emb = await embedTexts([entityEmbedText({ name: item.name, description: a.description, role: a.role })], 'doc');
    if (emb?.vectors?.length) {
      await this.db
        .insert(entityEmbeddings)
        .values({
          entityId: created.id,
          model: emb.model,
          dim: emb.dim,
          vec: emb.vectors[0],
          sourceText: entityEmbedText({ name: item.name, description: a.description, role: a.role }).slice(0, 500),
        })
        .onDuplicateKeyUpdate({ set: { vec: emb.vectors[0], model: emb.model, dim: emb.dim } });
    }

    return created.id;
  }

  /**
   * 谓词归一化：把模型自由谓词收敛到 fact_dimension 的标准维度。
   * 维度不归一 → 事实版本更新 / 变化检测 / 多源确认全部失效。
   * 顺序：映射表命中 → 维度表精确命中 → 记为待注册（人工确认后永久生效）
   */
  async normalizePredicate(
    datasetId: number,
    raw: string,
    dimCodes: string[],
    suggestionCodes?: string[],
  ): Promise<string> {
    const r = (raw ?? '').trim();
    if (!r) return r;

    const [mapped] = await this.db
      .select({ canonical: predicateMaps.canonical })
      .from(predicateMaps)
      .where(and(eq(predicateMaps.datasetId, datasetId), eq(predicateMaps.raw, r)))
      .limit(1);
    if (mapped) {
      await this.db
        .update(predicateMaps)
        .set({ hitCount: sql`${predicateMaps.hitCount} + 1` })
        .where(and(eq(predicateMaps.datasetId, datasetId), eq(predicateMaps.raw, r)));
      return mapped.canonical;
    }

    if (dimCodes.includes(r)) {
      await this.db
        .insert(predicateMaps)
        .values({ datasetId, raw: r, canonical: r, origin: 'rule', hitCount: 1 })
        .onDuplicateKeyUpdate({ set: { hitCount: sql`${predicateMaps.hitCount} + 1` } });
      return r;
    }

    // 未登记的新谓词：原样使用，并进人工注册队列（注册后统一口径）
    await this.db
      .insert(alignTasks)
      .values({
        datasetId,
        kind: 'predicate_new',
        mentionName: r,
        mentionType: 'predicate',
        payloadJson: {
          raw: r,
          suggestion: suggestionCodes && suggestionCodes.length ? suggestionCodes : dimCodes.slice(0, 10),
        },
      })
      .onDuplicateKeyUpdate({ set: { status: 'pending' } });
    return r;
  }

  /**
   * v2：某语料域下某分类可用维度 = 该库 dataset_category 关联行的 dim_ids（沿分类父链合并）。
   * 父链继承：顶层分类（如 org）关联的维度对其全部子类可见。
   * categoryId 为 null 或未关联时返回空（不抽该分类事实维度）。
   */
  async getCategoryDimensions(datasetId: number, categoryId: number | null) {
    if (categoryId == null) return [];
    const allDims = await this.db
      .select({
        id: factDimensions.id,
        code: factDimensions.code,
        name: factDimensions.name,
        description: factDimensions.description,
      })
      .from(factDimensions)
      .where(eq(factDimensions.status, 'active'));
    // 自 categoryId 沿父链上溯：自身 + 全部祖先分类（继承）
    const catRows = await this.db
      .select({ id: categories.id, parentId: categories.parentId })
      .from(categories);
    const chain: number[] = [];
    let cur = catRows.find((c) => c.id === categoryId);
    while (cur) {
      chain.push(cur.id);
      const parent = cur.parentId;
      cur = parent ? catRows.find((c) => c.id === parent) : undefined;
    }
    const rows = await this.db
      .select({ categoryId: datasetCategories.categoryId, dimIds: datasetCategories.dimIds })
      .from(datasetCategories)
      .where(and(eq(datasetCategories.datasetId, datasetId), inArray(datasetCategories.categoryId, chain)));
    const ids = new Set<number>();
    for (const r of rows) for (const id of (r.dimIds ?? [])) ids.add(Number(id));
    // dim_ids 未配置（空）时回退到分类默认绑定（category_dimension，按分类定义的中文维度集）
    if (!ids.size) {
      const fallback = await this.db
        .select({ dimensionId: categoryDimensions.dimensionId })
        .from(categoryDimensions)
        .where(inArray(categoryDimensions.categoryId, chain));
      for (const r of fallback) ids.add(Number(r.dimensionId));
    }
    return allDims.filter((d) => ids.has(Number(d.id)));
  }

  /** 后台「分类维度」页：返回全量 active 维度 + 该库该分类启用的维度 id 集合（含经父链继承的） */
  async getCategoryDimensionsWithAssignment(datasetId: number, categoryId: number) {
    const dims = await this.db
      .select()
      .from(factDimensions)
      .where(eq(factDimensions.status, 'active'))
      .orderBy(asc(factDimensions.sort));
    const catRows = await this.db
      .select({ id: categories.id, parentId: categories.parentId })
      .from(categories);
    // 自身 + 祖先链（继承）
    const chain: number[] = [];
    let cur = catRows.find((c) => c.id === categoryId);
    while (cur) {
      chain.push(cur.id);
      const parent = cur.parentId;
      cur = parent ? catRows.find((c) => c.id === parent) : undefined;
    }
    const rows = await this.db
      .select({ categoryId: datasetCategories.categoryId, dimIds: datasetCategories.dimIds })
      .from(datasetCategories)
      .where(and(eq(datasetCategories.datasetId, datasetId), inArray(datasetCategories.categoryId, chain)));
    const ownIds = (rows.find((r) => r.categoryId === categoryId)?.dimIds ?? []).map(Number);
    const inheritedIds = [
      ...new Set(rows.filter((r) => r.categoryId !== categoryId).flatMap((r) => (r.dimIds ?? []).map(Number))),
    ];
    // 分类默认绑定（category_dimension，维度重建后「分类即默认定义」）：dim_ids 为空时抽取回退到它
    const defaultRows = await this.db
      .select({ dimensionId: categoryDimensions.dimensionId })
      .from(categoryDimensions)
      .where(inArray(categoryDimensions.categoryId, chain));
    const defaultDimIds = [...new Set(defaultRows.map((r) => Number(r.dimensionId)))];
    return { dimensions: dims, assignedIds: ownIds, inheritedIds, defaultDimIds };
  }

  /** 后台「分类维度」页：整体替换某库某分类的启用维度子集（dataset_category.dim_ids） */
  async setCategoryDimensions(datasetId: number, categoryId: number, dimensionIds: number[]) {
    const [link] = await this.db
      .select({ id: datasetCategories.id })
      .from(datasetCategories)
      .where(and(eq(datasetCategories.datasetId, datasetId), eq(datasetCategories.categoryId, categoryId)))
      .limit(1);
    if (!link) throw new NotFoundException('该语料域未关联此分类');
    const valid = await this.db
      .select({ id: factDimensions.id })
      .from(factDimensions)
      .where(inArray(factDimensions.id, dimensionIds));
    const validIds = new Set(valid.map((v) => Number(v.id)));
    const dimIds = dimensionIds.filter((id) => validIds.has(Number(id)));
    await this.db
      .update(datasetCategories)
      .set({ dimIds, updatedAt: new Date() })
      .where(eq(datasetCategories.id, link.id));
    return { ok: true as const };
  }

  // ---------------------------------------------------------------- 关系 schema（后台维护 + 提示词注入）

  private async getRelationSchema(id: number) {
    const rows = await this.db
      .select({
        id: relationSchemas.id,
        categoryId: relationSchemas.categoryId,
        tailType: relationSchemas.tailType,
        relations: relationSchemas.relations,
        sort: relationSchemas.sort,
        status: relationSchemas.status,
        catCode: categories.code,
        catName: categories.name,
        catParentId: categories.parentId,
      })
      .from(relationSchemas)
      .innerJoin(categories, eq(categories.id, relationSchemas.categoryId))
      .where(eq(relationSchemas.id, id));
    return rows[0] ?? null;
  }

  /** 后台「关系 schema」页：按 head 分类（可选）列出配置，关联分类名称；
   *  选中分类时返回「自身 + 祖先链继承」的配置（子分类沿用父分类关系词表，与分类维度继承一致） */
  async listRelationSchemas(categoryId?: number) {
    const select = this.db
      .select({
        id: relationSchemas.id,
        categoryId: relationSchemas.categoryId,
        tailType: relationSchemas.tailType,
        relations: relationSchemas.relations,
        sort: relationSchemas.sort,
        status: relationSchemas.status,
        catCode: categories.code,
        catName: categories.name,
        catParentId: categories.parentId,
      })
      .from(relationSchemas)
      .innerJoin(categories, eq(categories.id, relationSchemas.categoryId));
    if (!categoryId) {
      return select.orderBy(asc(categories.sort), asc(relationSchemas.sort));
    }
    // 自身 + 祖先链（继承），与 getCategoryDimensionsWithAssignment 的 chain 逻辑一致
    const catRows = await this.db
      .select({ id: categories.id, parentId: categories.parentId })
      .from(categories);
    const chain: number[] = [];
    let cur = catRows.find((c) => c.id === categoryId);
    while (cur) {
      chain.push(cur.id);
      const parent = cur.parentId;
      cur = parent ? catRows.find((c) => c.id === parent) : undefined;
    }
    return select.where(inArray(relationSchemas.categoryId, chain)).orderBy(asc(categories.sort), asc(relationSchemas.sort));
  }

  /** 新增：某 head 分类 × tail 类型 的关系词配置 */
  async createRelationSchema(dto: { categoryId: number; tailType: string; relations: string[]; sort?: number; status?: 'active' | 'disabled' }) {
    const tailType = String(dto.tailType ?? '').trim();
    if (!tailType) throw new BadRequestException('tail 类型不能为空');
    const relations = (dto.relations ?? []).map((r) => String(r).trim()).filter(Boolean);
    if (!relations.length) throw new BadRequestException('关系词至少需要一个');
    const [cat] = await this.db.select({ id: categories.id }).from(categories).where(eq(categories.id, dto.categoryId)).limit(1);
    if (!cat) throw new NotFoundException('分类不存在');
    try {
      const [ins] = await this.db.insert(relationSchemas).values({
        categoryId: dto.categoryId,
        tailType,
        relations,
        sort: dto.sort ?? 0,
        status: dto.status ?? 'active',
      });
      return await this.getRelationSchema(Number(ins.insertId));
    } catch (e) {
      if ((e as { code?: string }).code === 'ER_DUP_ENTRY') {
        throw new BadRequestException('该分类下此 tail 类型已配置，可直接编辑已有条目');
      }
      throw e;
    }
  }

  /** 编辑：tailType / relations / sort / status 均可局部更新（categoryId 不变） */
  async updateRelationSchema(id: number, dto: { tailType?: string; relations?: string[]; sort?: number; status?: 'active' | 'disabled' }) {
    const [row] = await this.db.select({ id: relationSchemas.id }).from(relationSchemas).where(eq(relationSchemas.id, id)).limit(1);
    if (!row) throw new NotFoundException('关系 schema 不存在');
    const values: Partial<typeof relationSchemas.$inferInsert> = { updatedAt: new Date() };
    if (dto.tailType !== undefined) {
      const tt = String(dto.tailType).trim();
      if (!tt) throw new BadRequestException('tail 类型不能为空');
      values.tailType = tt;
    }
    if (dto.relations !== undefined) {
      const rels = dto.relations.map((r) => String(r).trim()).filter(Boolean);
      if (!rels.length) throw new BadRequestException('关系词至少需要一个');
      values.relations = rels;
    }
    if (dto.sort !== undefined) values.sort = dto.sort;
    if (dto.status !== undefined) values.status = dto.status;
    await this.db.update(relationSchemas).set(values).where(eq(relationSchemas.id, id));
    return await this.getRelationSchema(id);
  }

  /** 删除一条关系 schema 配置 */
  async deleteRelationSchema(id: number) {
    const [row] = await this.db.select({ id: relationSchemas.id }).from(relationSchemas).where(eq(relationSchemas.id, id)).limit(1);
    if (!row) throw new NotFoundException('关系 schema 不存在');
    await this.db.delete(relationSchemas).where(eq(relationSchemas.id, id));
    return { ok: true as const };
  }

  /** 读取全部启用的关系 schema（全局分类定义，不按语料域过滤）：
   *  提示词与代码级校验都按 head 实体分类 × tail 类型匹配；
   *  不按 dataset 过滤，可避免「某语料域没挂顶层分类」导致该分类词表缺失。 */
  async loadRelationSchemasForDataset(_datasetId: number): Promise<RelationSchemaLine[]> {
    const rows = await this.db
      .select({
        categoryId: relationSchemas.categoryId,
        catCode: categories.code,
        catName: categories.name,
        tailType: relationSchemas.tailType,
        relations: relationSchemas.relations,
        sort: relationSchemas.sort,
      })
      .from(relationSchemas)
      .innerJoin(categories, eq(categories.id, relationSchemas.categoryId))
      .where(eq(relationSchemas.status, 'active'))
      .orderBy(asc(relationSchemas.sort));
    return rows;
  }

  /**
   * 用生产线模型按语义把某语料域的存量 fact_dimension 自动归类到分类（写入 category_dimension）。
   * 归类粒度精确到二级分类，规则：
   * - 适用于某顶层分类下**全部**子类的维度 → 只挂顶层分类（子类经父链继承可见，
   *   见 getCategoryDimensions）。如「隶属于」→ org（政府/学校/媒体/企业全部继承）。
   * - 只适用于部分子类的维度 → 只挂对应子类。如「主营产品」→ org.company，
   *   「方言属于」→ culture.dialect。
   * - 与任何分类都不相关 → 不写映射（全局维度，对所有分类可见）。
   * 幂等：先清该维度旧映射再写新映射。调用记入 llm_call_logs（purpose=classify）。
   */
  async autoClassifyCategoryDimensions(datasetId: number) {
    const [ds] = await this.db
      .select({ id: datasets.id, name: datasets.name })
      .from(datasets)
      .where(eq(datasets.id, datasetId))
      .limit(1);
    if (!ds) throw new NotFoundException('语料域不存在');

    const settings = await this.llmConfigService.getProductionSettings();
    if (!settings.length) {
      throw new NotFoundException('未配置生产线模型（后台「大模型设置 → 文本模型」需至少一条启用并设为生产线）');
    }
    const s = settings[0];
    const cfg: LlmCfg = {
      baseUrl: s.baseUrl,
      apiKey: s.apiKey,
      model: s.model,
      temperature: 0.1,
      maxTokens: 16384,
    };

    const dims = await this.db
      .select({ id: factDimensions.id, code: factDimensions.code, name: factDimensions.name, description: factDimensions.description })
      .from(factDimensions)
      .where(eq(factDimensions.status, 'active'))
      .orderBy(asc(factDimensions.sort));
    const catRows = await this.db
      .select({ id: categories.id, code: categories.code, name: categories.name, description: categories.description, parentId: categories.parentId })
      .from(categories)
      .where(eq(categories.status, 'active'))
      .orderBy(asc(categories.sort));
    if (!dims.length) return { classified: 0, global: 0, total: 0, assignments: [] as unknown[] };

    // 分类树文本（顶层 + 缩进二级）
    const catLines: string[] = [];
    for (const t of catRows.filter((c) => !c.parentId)) {
      catLines.push(`${t.code} = ${t.name}${t.description ? `（${t.description}）` : ''}`);
      for (const c of catRows.filter((x) => x.parentId === t.id)) {
        catLines.push(`  ${c.code} = ${c.name}${c.description ? `（${c.description}）` : ''}`);
      }
    }
    const catByCode = new Map(catRows.map((c) => [c.code, c]));
    const dimByCode = new Map(dims.map((d) => [d.code, d]));
    const codeOf = (id: number) => catRows.find((c) => c.id === id)?.code ?? String(id);

    // 分批 + 全部并发：思考型模型单次推理 token 消耗大且不可控，一批太多会把 max_tokens 烧满导致 JSON 截断；
    // 截断/解析失败自动重试一次（重跑通常恢复正常）。各批维度互不重叠，可安全并发。
    const CHUNK = 6;
    const batches: (typeof dims)[] = [];
    for (let i = 0; i < dims.length; i += CHUNK) batches.push(dims.slice(i, i + CHUNK));

    const classifyBatch = async (
      batch: typeof dims,
      batchNo: number,
    ): Promise<{ code?: string; categories?: string[] }[]> => {
      const dimLines = batch.map((d) => `- ${d.code}｜${d.name}｜${(d.description ?? '').trim()}`);
      const prompt = `你是知识图谱本体设计师。下面是地方知识库（${ds.name}）的分类树和一批事实维度，请把每个维度归类到它语义适用的分类。

【分类树（code = 名称）】
${catLines.join('\n')}

【维度清单（code｜名称｜语义说明）】
${dimLines.join('\n')}

【归类规则】
1. 每个维度输出语义适用的分类 code 列表，可以是多个；只能使用上面清单中出现的 code。
2. 尽量挂最高层：若维度适用于某顶层分类下的全部子类，只给顶层 code（子类自动继承父类维度）。例：「隶属于」适用于所有机构 → 只给 org。
3. 只适用于部分子类时给具体子类 code。例：「主营产品」只适用于企业 → 只给 org.company；「方言属于」只给 culture.dialect；「始建于」适用于有建筑的分类。
4. 双侧挂载：若某动作/关系类维度的主语和宾语分属不同分类，两侧分类都要分配。例：「举办」既是事件实体的维度（该活动在哪/何时举办）也是机构实体的维度（该机构举办了什么）→ event 和 org 都要给。
5. 适用范围跨多个顶层分类时可同时给多个。
6. 与任何分类都不相关的维度给空数组（视为全局维度）。
7. 语义拿不准时从严：给更小的适用范围或空数组。

只输出 JSON（不要多余文字）：
{"assignments":[{"code":"维度code","categories":["分类code",...]}]}`;

      let parsed: { assignments?: { code?: string; categories?: string[] }[] } | null = null;
      let lastErr = '';
      for (let attempt = 1; attempt <= 2 && !parsed; attempt += 1) {
        const t0 = Date.now();
        const r = await chat(cfg, prompt);
        const latencyMs = Date.now() - t0;
        const pt = r.usage?.promptTokens ?? 0;
        const ct = r.usage?.completionTokens ?? 0;
        await this.llmLogService.logCall({
          settingId: s.id,
          model: s.model,
          endpoint: s.baseUrl,
          purpose: 'classify',
          promptTokens: pt,
          completionTokens: ct,
          totalTokens: pt + ct,
          latencyMs,
          status: r.error ? 'error' : 'success',
          errorMessage: r.error ?? null,
          detailJson: { stage: 'dimension-classify', datasetId, batch: batchNo, attempt, dims: batch.length },
        });
        if (r.error) {
          lastErr = `LLM 调用失败: ${r.error}`;
          continue;
        }
        try {
          parsed = extractJson<{ assignments?: { code?: string; categories?: string[] }[] }>(r.content);
        } catch {
          // 截断恢复：思考型模型可能把 max_tokens 烧满导致 JSON 末尾截断，
          // 条目为扁平对象（无嵌套），逐个抢救已完整闭合的条目
          const objs = r.content.match(/\{[^{}]*"code"[^{}]*\}/g) ?? [];
          const items = objs
            .map((o) => {
              try {
                return JSON.parse(o) as { code?: string; categories?: string[] };
              } catch {
                return null;
              }
            })
            .filter((x): x is { code?: string; categories?: string[] } => !!x);
          if (items.length) {
            parsed = { assignments: items };
          } else {
            lastErr = 'LLM 返回解析失败（无完整条目）';
          }
        }
      }
      if (!parsed) throw new Error(`维度自动分类第 ${batchNo} 批失败（已重试）: ${lastErr}`);
      return parsed.assignments ?? [];
    };

    // 全部批次并发执行，任一批彻底失败则整体报错（不写库，保持幂等）
    const batchResults = await Promise.all(batches.map((b, idx) => classifyBatch(b, idx + 1)));

    // dimId -> 去重后的分类 id 列表
    const resultMap = new Map<number, number[]>();
    for (const items of batchResults.flat()) {
      const d = dimByCode.get(String(items.code ?? '').trim());
      if (!d) continue;
      const ids: number[] = [];
      for (const code of items.categories ?? []) {
        const cat = catByCode.get(String(code).trim());
        if (cat && !ids.includes(cat.id)) ids.push(cat.id);
      }
      resultMap.set(d.id, ids);
    }

    const assignments: { dimensionCode: string; categoryCodes: string[] }[] = [];
    let classified = 0;
    let global = 0;
    for (const d of dims) {
      const catIds = resultMap.get(d.id) ?? [];
      await this.db.delete(categoryDimensions).where(eq(categoryDimensions.dimensionId, d.id));
      if (catIds.length) {
        await this.db.insert(categoryDimensions).values(
          catIds.map((categoryId, i) => ({ categoryId, dimensionId: d.id, sort: i + 1 })),
        );
        classified += 1;
      } else {
        global += 1;
      }
      assignments.push({ dimensionCode: d.code, categoryCodes: catIds.map(codeOf) });
    }

    // v2：把该语料域各关联分类的启用维度子集（dim_ids）更新为归类结果（未关联的分类不启用）
    const catIdByCode = new Map(catRows.map((c) => [c.id, c.code]));
    const linkedRows = await this.db
      .select({ id: datasetCategories.id, categoryId: datasetCategories.categoryId })
      .from(datasetCategories)
      .where(eq(datasetCategories.datasetId, datasetId));
    for (const link of linkedRows) {
      const code = catIdByCode.get(Number(link.categoryId));
      if (!code) continue;
      const dimIds = dims
        .filter((d) => (resultMap.get(d.id) ?? []).some((cid) => catIdByCode.get(cid) === code))
        .map((d) => d.id);
      await this.db
        .update(datasetCategories)
        .set({ dimIds, updatedAt: new Date() })
        .where(eq(datasetCategories.id, link.id));
    }

    return { classified, global, total: dims.length, assignments, model: s.model };
  }

  /**
   * 谓词/维度归一的「前置收集」：已知的就地解决（映射表命中 / 同义规则命中 / 本身就是合法口径），
   * 只把真正的新词返回，交给上层做**一次批量 LLM 判决**（成本可控）。命中规则时顺带沉淀映射。
   */
  private async collectPendingPredicates(datasetId: number, raws: string[], knownCodes: string[]): Promise<string[]> {
    const pending: string[] = [];
    for (const raw of raws) {
      const r = (raw ?? '').trim();
      if (!r) continue;
      const [hit] = await this.db
        .select({ canonical: predicateMaps.canonical })
        .from(predicateMaps)
        .where(and(eq(predicateMaps.datasetId, datasetId), eq(predicateMaps.raw, r)))
        .limit(1);
      if (hit) continue; // 映射表已处理过，零成本
      const rule = PREDICATE_SYNONYMS[r] ?? (knownCodes.includes(r) ? r : null);
      if (rule) {
        await this.upsertPredicateMap(datasetId, r, rule, 'rule');
        continue;
      }
      pending.push(r);
    }
    return [...new Set(pending)];
  }

  /** 沉淀「新词 → 已有口径」映射（LLM 判决结果），下次零成本命中 */
  private async applyPredicateMapping(datasetId: number, mapping: Record<string, string | null>): Promise<number> {
    let n = 0;
    for (const [raw, canonical] of Object.entries(mapping ?? {})) {
      if (!canonical || canonical === raw) continue;
      await this.upsertPredicateMap(datasetId, raw, canonical, 'llm');
      n += 1;
    }
    return n;
  }

  private async upsertPredicateMap(datasetId: number, raw: string, canonical: string, origin: 'rule' | 'llm') {
    const [exist] = await this.db
      .select({ id: predicateMaps.id })
      .from(predicateMaps)
      .where(and(eq(predicateMaps.datasetId, datasetId), eq(predicateMaps.raw, raw)))
      .limit(1);
    if (exist) {
      await this.db.update(predicateMaps).set({ canonical, origin }).where(eq(predicateMaps.id, exist.id));
    } else {
      await this.db.insert(predicateMaps).values({ datasetId, raw, canonical, origin, hitCount: 1 });
    }
  }

  /**
   * 尾实体归一：把 tail 文本解析到库内已有实体（去"温州/浙江"前缀、去行政区后缀），
   * 避免「温州南塘中医药特色街区」与「南塘中医药特色街区」被写成两条边。
   */
  private async resolveTailEntity(datasetId: number, tail: string): Promise<{ id: number; name: string } | null> {
    const t = (tail ?? '').trim();
    if (t.length < 2) return null;
    const candidates = [t];
    const strippedPrefix = t.replace(/^(温州市?|浙江省?|浙江温州)/, '');
    if (strippedPrefix && strippedPrefix !== t && strippedPrefix.length >= 2) candidates.push(strippedPrefix);
    for (const c of candidates) {
      const id = await this.resolveRefByText(c);
      if (!id) continue;
      const [row] = await this.db.select({ name: entities.name }).from(entities).where(eq(entities.id, id)).limit(1);
      if (row) return { id, name: row.name };
    }
    return null;
  }

  /**
   * 关系谓词归一：命中 predicate_map → 复用；否则首次出现即登记并沉淀
   * （origin=rule 命中推荐关系，origin=llm 为模型自拟），后续同谓词零成本复用。
   */
  async normalizeRelationPredicate(datasetId: number, raw: string): Promise<string> {
    const r = (raw ?? '').trim();
    if (!r) return 'rel_关联';
    // 硬编码同义规则优先（发生于→举行、出现于→登上…）：命中即归一并沉淀映射。
    // 这样即使 predicate_maps 里存了陈旧/自映射（如 发生于→发生于、出现于→发生于），
    // 规则也能覆盖，避免「模型自拟但非动作动词」的谓词漏网。与 collectPendingPredicates 口径一致。
    const synHit = PREDICATE_SYNONYMS[r];
    if (synHit) {
      await this.upsertPredicateMap(datasetId, r, synHit, 'rule');
      return synHit;
    }
    const [mapped] = await this.db
      .select({ canonical: predicateMaps.canonical })
      .from(predicateMaps)
      .where(and(eq(predicateMaps.datasetId, datasetId), eq(predicateMaps.raw, r)))
      .limit(1);
    if (mapped) {
      await this.db
        .update(predicateMaps)
        .set({ hitCount: sql`${predicateMaps.hitCount} + 1` })
        .where(and(eq(predicateMaps.datasetId, datasetId), eq(predicateMaps.raw, r)));
      // 已映射的 canonical 也尽量落成中文名（旧数据可能是英文 code）
      const canonical = mapped.canonical.replace(/^rel_/, '');
      return (await this.relationDimName(canonical)) ?? canonical;
    }
    // 英文连接边维度 code（如 affiliated_with/founder）→ 中文名，谓词展示用中文
    const canonical = (await this.relationDimName(r)) ?? r;
    await this.db
      .insert(predicateMaps)
      .values({
        datasetId,
        raw: r,
        canonical,
        // 只有命中推荐词表且非泛化词才记为可信规则；泛化词（关联/包含…）降级记 llm
        origin: RELATION_HINTS.includes(r) && !GENERIC_RELATION_PREDICATES.has(r) ? 'rule' : 'llm',
        hitCount: 1,
      })
      .onDuplicateKeyUpdate({ set: { hitCount: sql`${predicateMaps.hitCount} + 1` } });
    return canonical;
  }

  /** 关系谓词中文名缓存表（code → 中文名）；查 fact_dimension 求得英文 code 的中文名（幂等） */
  private readonly relationZhCache = new Map<string, string>();
  private async relationDimName(code: string): Promise<string | null> {
    if (this.relationZhCache.has(code)) return this.relationZhCache.get(code) ?? null;
    const [row] = await this.db
      .select({ name: factDimensions.name })
      .from(factDimensions)
      .where(eq(factDimensions.code, code))
      .limit(1);
    const name = row?.name && row.name !== code ? row.name : null;
    if (name) this.relationZhCache.set(code, name);
    return name;
  }

  /** 把「泰顺县 / 泰顺」这类文本解析为已存在实体 id（v2：全局查重，用于 entity_ref 自动填充） */
  private async resolveRefByText(text: string): Promise<number | null> {
    const t = (text ?? '').trim();
    if (t.length < 2) return null;
    const candidates = [t];
    const stripped = t.replace(/(特别行政区|自治州|地区|县级市|市|县|区|旗|盟)$/, '');
    if (stripped && stripped !== t && stripped.length >= 2) candidates.push(stripped);
    const [row] = await this.db
      .select({ id: entities.id })
      .from(entities)
      .where(and(isNull(entities.deletedAt), inArray(entities.name, candidates)))
      .limit(1);
    return row?.id ?? null;
  }

  /** 关系抽取主体实体（带类别 code，供 prompt 展示类型；v2 全局） */
  private async loadRelationEntities(datasetId: number, ids: number[]): Promise<{ id: number; name: string; type: string }[]> {
    if (!ids.length) return [];
    return this.db
      .select({ id: entities.id, name: entities.name, type: categories.code })
      .from(entities)
      .innerJoin(categories, eq(entities.categoryId, categories.id))
      .where(inArray(entities.id, ids));
  }

  /** 实体名（含别名）→ id 解析表：head/tail 落库用；tail 未命中即为「新候选」（v2 全局） */
  private async loadEntityNameIndex(datasetId: number) {
    const rows = await this.db
      .select({ id: entities.id, name: entities.name })
      .from(entities)
      .where(isNull(entities.deletedAt));
    const map = new Map<string, number>();
    for (const r of rows) map.set(norm(r.name), r.id);
    const aliasRows = rows.length
      ? await this.db
          .select({ entityId: entityAliases.entityId, alias: entityAliases.alias })
          .from(entityAliases)
          .where(inArray(entityAliases.entityId, rows.map((r) => r.id)))
      : [];
    for (const a of aliasRows) {
      const k = norm(a.alias);
      if (k && !map.has(k)) map.set(k, a.entityId);
    }
    return map;
  }

  // ---------------------------------------------------------------- 人工裁决（沉淀）

  /** 对齐任务裁决：批准合并 → 写别名（下次零成本命中）；批准收录 → 建实体 */
  async resolveAlignTask(
    id: number,
    resolution: 'merge' | 'new' | 'reject',
    userId?: number,
    canonical?: string,
    targetEntityId?: number,
    newName?: string,
    newGroup?: string,
  ) {
    const [task] = await this.db.select().from(alignTasks).where(eq(alignTasks.id, id)).limit(1);
    if (!task) throw new NotFoundException('对齐任务不存在');

    if (task.kind === 'predicate_new' && resolution === 'merge') {
      const payload = (task.payloadJson ?? {}) as { raw?: string; canonical?: string };
      const canonicalVal = (canonical ?? payload.canonical ?? '').trim();
      if (payload.raw && canonicalVal) {
        // 确保 canonical 是真实维度：新建维度时自动落到 fact_dimension（v2 全局），
        // 否则映射的只是一个孤儿 canonical 串（不进口径维度表、无分组、档案页不分组）。
        const [exists] = await this.db
          .select({ id: factDimensions.id })
          .from(factDimensions)
          .where(eq(factDimensions.code, canonicalVal))
          .limit(1);
        if (!exists) {
          const [maxRow] = await this.db
            .select({ m: sql<number>`COALESCE(MAX(${factDimensions.sort}), 0)` })
            .from(factDimensions);
          const [newDim] = await this.db
            .insert(factDimensions)
            .values({
              code: canonicalVal,
              name: newName?.trim() || canonicalVal,
              description: newGroup?.trim() || null,
              sort: (maxRow?.m ?? 0) + 1,
              status: 'active',
            })
            .$returningId();
          // 新建维度归入该对齐任务实体所属分类（v2：全局 category_dimension）+ 追加到该库该分类的启用子集
          if (task.entityId != null) {
            const [entRow] = await this.db
              .select({ categoryId: entities.categoryId })
              .from(entities)
              .where(eq(entities.id, task.entityId))
              .limit(1);
            if (entRow?.categoryId != null) {
              await this.db
                .insert(categoryDimensions)
                .values({
                  categoryId: entRow.categoryId,
                  dimensionId: newDim.id,
                  sort: 0,
                })
                .onDuplicateKeyUpdate({ set: { sort: 0 } });
              const [link] = await this.db
                .select({ id: datasetCategories.id, dimIds: datasetCategories.dimIds })
                .from(datasetCategories)
                .where(and(eq(datasetCategories.datasetId, task.datasetId), eq(datasetCategories.categoryId, entRow.categoryId)))
                .limit(1);
              if (link) {
                const dimIds = [...new Set([...(link.dimIds ?? []).map(Number), newDim.id])];
                await this.db
                  .update(datasetCategories)
                  .set({ dimIds, updatedAt: new Date() })
                  .where(eq(datasetCategories.id, link.id));
              }
            }
          }
        }
        await this.db
          .insert(predicateMaps)
          .values({
            datasetId: task.datasetId,
            raw: payload.raw,
            canonical: canonicalVal,
            origin: 'manual',
            hitCount: 0,
          })
          .onDuplicateKeyUpdate({ set: { canonical: canonicalVal, origin: 'manual' } });
      }
    } else if (resolution === 'new' && (task.kind === 'merge_suggest' || task.kind === 'conflict')) {
      // 人工判定「候选都不是」→ 把该提及收录为新实体（草稿态，走后续发布审核）
      const payload = (task.payloadJson ?? {}) as Record<string, any>;
      const mentionType = task.mentionType ?? '';
      if (!mentionType) throw new NotFoundException('对齐任务缺少类别信息，无法收录新实体');
      const [category] = await this.db
        .select()
        .from(categories)
        .where(eq(categories.code, mentionType))
        .limit(1);
      if (!category) throw new NotFoundException(`类别 ${mentionType} 不存在，无法收录新实体`);
      const [ds] = await this.db
        .select({ code: datasets.code })
        .from(datasets)
        .where(eq(datasets.id, task.datasetId))
        .limit(1);
      const attrs = (payload.attrs ?? {}) as { region?: string; org?: string; role?: string };
      await this.createEntity(
        task.datasetId,
        category.id,
        ds?.code ?? '',
        { name: task.mentionName, type: mentionType, evidence: String(payload.evidence ?? '') },
        {
          description: String(payload.description ?? ''),
          role: String(attrs.role ?? ''),
          attrs: { region: attrs.region ?? '', org: attrs.org ?? '', role: attrs.role ?? '' },
        },
        { runId: task.runId ?? null, articleId: task.articleId ?? null, pubDate: null },
      );
    } else if (resolution === 'merge') {
      // 合并 = 确认提及与目标实体为同一主体，沉淀别名（下次零成本命中）
      const mergeTarget = targetEntityId ?? task.entityId;
      if (mergeTarget) {
        await this.db
          .insert(entityAliases)
          .values({ entityId: mergeTarget, alias: task.mentionName, source: 'manual' })
          .onDuplicateKeyUpdate({ set: { alias: task.mentionName } });
      }
    }

    await this.db
      .update(alignTasks)
      .set({ status: resolution === 'reject' ? 'rejected' : 'approved', resolution, reviewedBy: userId ?? null, reviewedAt: new Date() })
      .where(eq(alignTasks.id, id));
    return { resolved: true, id, resolution };
  }

  async listAlignTasks(
    datasetId: number,
    kind?: string,
    status = 'pending',
    page = 1,
    pageSize = 20,
  ) {
    const where = and(
      eq(alignTasks.datasetId, datasetId),
      eq(alignTasks.status, status as 'pending'),
      kind ? eq(alignTasks.kind, kind as 'merge_suggest') : undefined,
    );
    const [{ value: total }] = await this.db.select({ value: count() }).from(alignTasks).where(where);
    const size = Math.min(Math.max(pageSize, 1), 100);
    const items = await this.db
      .select()
      .from(alignTasks)
      .where(where)
      .orderBy(asc(alignTasks.id))
      .limit(size)
      .offset((Math.max(page, 1) - 1) * size);
    return { items, total: Number(total), page: Math.max(page, 1), pageSize: size };
  }
}
