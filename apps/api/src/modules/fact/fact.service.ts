import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, like, lt, or, sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import {
  datasets,
  entities,
  evidences as evidence,
  factChanges,
  factDimensions,
  factEvidences,
  factRelations,
  factRevisions,
  facts,
  sourceArticles,
} from '../../db/schema';
import {
  buildFactCode,
  classifyStatementKind,
  codeSeq,
  inferPeriodKeyFromStatement,
  periodKeyToValidFrom,
  periodPrecision,
  todayInShanghai,
} from '@ssot/shared';
import { AuditService } from '../audit/audit.service';
import { LlmConfigService } from '../llm-config/llm-config.service';
import type { LlmCfg } from '../discovery/stages';
import {
  adjudicateFact,
  type AdjudicationResult,
  type SemanticRole,
  type UpdatePolicy,
  type Verdict,
} from './fact-adjudicator';
import { NEAR_DUPLICATE_THRESHOLD, isCorroborating, statementSimilarity } from './statement-similarity';
import type {
  ArbritrateDto,
  CreateFactDto,
  ListFactQuery,
  UpdateFactDto,
} from './fact.dto';

type FactStatus =
  | 'draft'
  | 'pending_review'
  | 'active'
  | 'superseded'
  | 'pending_arbitration'
  | 'rejected'
  | 'archived';

/** 状态机：draft → pending_review → active → superseded / pending_arbitration */
const TRANSITIONS: Record<FactStatus, FactStatus[]> = {
  draft: ['pending_review', 'active', 'rejected'],
  pending_review: ['active', 'rejected', 'draft'],
  active: ['superseded', 'pending_arbitration', 'archived'],
  pending_arbitration: ['active', 'superseded', 'rejected'],
  superseded: [],
  rejected: [],
  archived: [],
};

const ACTIVE_STATUSES: FactStatus[] = ['active', 'pending_arbitration'];

/** 事务里可复用的事实读写执行器（this.db 或交易 tx 都可满足这些操作） */
type TxDb = Pick<Db, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

type FactRow = typeof facts.$inferSelect;
type FactWithEvidence = Omit<FactRow, 'confidence'> & { confidence: number; evidences: unknown[] };
type ConflictGroup = { dimension: string; count: number; facts: FactWithEvidence[] };

/**
 * 事实「适用性」派生标签（对齐产品原型）：同一事实的不同修订 / 历史 / 撤回标识须与当前口径分开。
 * 依据：发布状态、时间语义类型(temporalKind)、有效区间、业务日期(clock，上海时区今天)。
 */
export function applicabilityOf(
  f: Record<string, unknown>,
  clock: string,
): { key: string; label: string; color: string } {
  const status = String(f.status ?? 'active');
  const tk = String(f.temporalKind ?? 'unknown');
  const validFrom = (f.validFrom as string | null) ?? null;
  const validTo = (f.validTo as string | null) ?? null;
  const eventEnd = (f.eventEnd as string | null) ?? null;
  const periodKey = (f.periodKey as string | null) ?? null;
  const asOf = (f.asOf as string | null) ?? null;
  if (status === 'archived' || status === 'rejected')
    return {
      key: 'archived',
      label: status === 'rejected' ? '已驳回 · 不作为现行主张' : '已退役 · 保留备查',
      color: 'red',
    };
  if (validFrom && validFrom > clock)
    return { key: 'future', label: `待生效 · ${validFrom} 起（依据公告）`, color: 'blue' };
  if (tk === 'event')
    return {
      key: 'history',
      label: eventEnd && eventEnd < clock ? '历史事实 · 活动已结束' : '事件记录 · 发生时间见条目',
      color: '',
    };
  if (tk === 'historical' || tk === 'period')
    return {
      key: 'history',
      label: periodKey ? `历史统计 · ${periodKey}` : '历史事实 · 非当前经营状态',
      color: '',
    };
  if (validTo && clock >= validTo)
    return { key: 'history', label: `历史适用区间 · 截至 ${validTo} 前`, color: '' };
  if (tk === 'plan') return { key: 'plan', label: '计划／报道表述 · 不代表已实现', color: 'amber' };
  if (tk === 'as_of')
    return { key: 'asof', label: `截至 ${asOf ?? clock} 的报道记录 · 非实时确认`, color: 'amber' };
  return { key: 'current', label: '按已发依据适用 · 未独立现场复核', color: 'green' };
}

/** 把 ISO / 日期字符串转 Date（供 datetime 列写入；date-only 按本地零点） */
function isoToDate(v?: string | null): Date | null {
  if (!v) return null;
  return new Date(v.length <= 10 ? `${v}T00:00:00` : v);
}

/** 今天（北京时间口径）：首建/核验时间与过期判定的统一基准，避免服务器在 UTC 时差一天。 */
function today(): string {
  return todayInShanghai();
}

/**
 * S1 缺轴兜底：模型/调用方一条槽位轴都没给时，不得落「三轴全空」的 ∅ 槽位——
 * 否则不同语义簇会被挤进同一个空槽位、相互覆盖。这里按事实类型补出最小可用的
 * semantic_role（事件→record、状态/口径→metric、转述/定义→definition）；
 * 时间键另走规则：调用方/裁决器都没给时，从陈述里抽年份/季度/月份（`inferPeriodKeyFromStatement`）。
 * subject_scope 保持为空（确为整实体通用表述时本就应为空）。
 * 返回 `filled=true` 表示本次自动补了 semantic_role、`periodFilled=true` 表示自动补了 period_key
 * （调用方可据此在备注里留痕待人工复核）。
 */
/**
 * 时间确定性（PRD R03）：
 * - 陈述里直接出现该年份 → exact
 * - 由 period_key 推断（模型/规则补）→ inferred
 * - 无时间口径 → unknown
 */
function timeCertaintyOf(statement: string, periodKey: string | null): 'unknown' | 'exact' | 'inferred' {
  if (!periodKey) return 'unknown';
  const year = String(periodKey).slice(0, 4);
  return new RegExp(`${year}\\s*年`).test(String(statement ?? '')) ? 'exact' : 'inferred';
}

function fillSlotAxes(
  role: SemanticRole | null,
  periodKey: string | null,
  subjectScope: string | null,
  factType: string | null | undefined,
  statement?: string | null,
): {
  role: SemanticRole | null;
  periodKey: string | null;
  subjectScope: string | null;
  filled: boolean;
  periodFilled: boolean;
} {
  const inferredPeriod = periodKey ?? inferPeriodKeyFromStatement(statement);
  const periodFilled = !periodKey && !!inferredPeriod;
  if (role || periodKey || subjectScope) {
    return { role, periodKey: inferredPeriod, subjectScope, filled: false, periodFilled };
  }
  const inferred: SemanticRole =
    factType === 'occurred' ? 'record' : factType === 'current_state' ? 'metric' : 'definition';
  return { role: inferred, periodKey: inferredPeriod, subjectScope, filled: true, periodFilled };
}

@Injectable()
export class FactService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly llmConfig: LlmConfigService,
  ) {}

  // ---------------------------------------------------------------- 查询

  async list(query: ListFactQuery) {
    let where = and(
      query.entityId ? eq(facts.entityId, query.entityId) : undefined,
      query.dimension ? eq(facts.dimension, query.dimension) : undefined,
      query.status ? eq(facts.status, query.status) : undefined,
      // 展示层默认只看现行事实：已被替代/归档的历史版本不进列表
      query.activeOnly ? inArray(facts.status, ACTIVE_STATUSES) : undefined,
      query.keyword ? like(facts.statement, `%${query.keyword}%`) : undefined,
      query.minConfidence !== undefined ? sql`${facts.confidence} >= ${query.minConfidence}` : undefined,
      query.expired
        ? lt(
            facts.lastVerifiedAt,
            todayInShanghai(new Date(Date.now() - query.ttlDays * 86400_000)),
          )
        : undefined,
    );

    if (query.current) where = and(where, sql`(${facts.validTo} IS NULL OR ${facts.validTo} >= ${today()})`);

    const [{ value: total }] = await this.db.select({ value: count() }).from(facts).where(where);

    const rows = await this.db
      .select()
      .from(facts)
      .where(where)
      .orderBy(desc(facts.entityId), asc(facts.code), desc(facts.version))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      items: await this.withEvidence(rows),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * 每个「槽位」的最新有效版本（v1.1：槽位 = 实体 + 维度 + 裁决三轴）。
   * MySQL 5.7 没有窗口函数，不能用 ROW_NUMBER() OVER (PARTITION BY ...)，
   * 这里用 JOIN + MAX(version) 子查询替代；三轴可空，JOIN 用 <=> 做 NULL 安全相等，
   * 保证存量（三轴为 NULL）仍按维度归并、而新增的并列槽位能各自独立取现行版本。
   */
  async currentByEntity(entityId: number, statuses: FactStatus[] = ACTIVE_STATUSES) {
    const statusList = sql.join(
      statuses.map((s) => sql`${s}`),
      sql`, `,
    );
    // 到期自动退役（查询时判定）：valid_to 早于今日的事实不再计入「现行」，
    // 与定时任务 retireExpired 的写口径互为兜底。
    // 注意：valid_to 只对 current_state 表示「有效期」；historical/period/event 等描述过去的事实
    // 过期不失效（否则历史事实会被查询侧吞掉/退役）。
    const notExpired = sql`(f.valid_to IS NULL OR f.valid_to >= ${today()} OR f.fact_type <> 'occurred')`;
    const rows = await this.db.execute(sql`
      SELECT
        f.id, f.entity_id AS entityId, f.code, f.dimension_id AS dimensionId, f.dimension, f.statement,
        f.fact_type AS factType, f.status, f.confidence, f.corroborate_count AS corroborateCount,
        f.first_seen_at AS firstSeenAt, f.last_verified_at AS lastVerifiedAt,
        f.valid_from AS validFrom, f.valid_to AS validTo,
        f.superseded_by_id AS supersededById, f.version, f.arbitration_note AS arbitrationNote, f.origin,
        f.semantic_role AS semanticRole, f.period_key AS periodKey, f.subject_scope AS subjectScope,
        f.created_by AS createdBy, f.updated_by AS updatedBy, f.created_at AS createdAt, f.updated_at AS updatedAt,
        f.temporal_kind AS temporalKind, f.as_of AS asOf, f.event_start AS eventStart, f.event_end AS eventEnd,
        f.method AS method, f.sign_mode AS signMode, f.source_authority AS sourceAuthority,
        f.independently_verified AS independentlyVerified, f.issued_at AS issuedAt, f.alerts AS alerts
      FROM ${facts} f
      JOIN (
        SELECT entity_id, dimension, semantic_role, period_key, subject_scope, MAX(version) AS mv
        FROM ${facts}
        WHERE entity_id = ${entityId} AND status IN (${statusList})
          AND (${facts}.valid_to IS NULL OR ${facts}.valid_to >= ${today()} OR ${facts}.fact_type <> 'occurred')
        GROUP BY entity_id, dimension, semantic_role, period_key, subject_scope
      ) t
      ON f.entity_id = t.entity_id
         AND f.dimension <=> t.dimension
         AND f.semantic_role <=> t.semantic_role
         AND f.period_key <=> t.period_key
         AND f.subject_scope <=> t.subject_scope
         AND f.version = t.mv
      WHERE f.entity_id = ${entityId} AND f.status IN (${statusList}) AND ${notExpired}
      ORDER BY CAST(SUBSTRING_INDEX(f.code, '-', -1) AS UNSIGNED)
    `);
    const list = ((rows as unknown as [unknown[], unknown[]])[0] ?? []) as (typeof facts.$inferSelect)[];
    return this.withEvidence(list);
  }

  /** 当前事实 + 被替代的旧版本（页面要保留备查并链接替代者） */
  async fullBoard(entityId: number) {
    const [current, superseded] = await Promise.all([
      this.currentByEntity(entityId, ['active', 'pending_arbitration']),
      this.db
        .select()
        .from(facts)
        .where(and(eq(facts.entityId, entityId), eq(facts.status, 'superseded')))
        .orderBy(asc(facts.code)),
    ]);
    const supersededWithEvidence = await this.withEvidence(superseded);
    return { current, superseded: supersededWithEvidence };
  }

  async detail(id: number) {
    const [row] = await this.db.select().from(facts).where(eq(facts.id, id)).limit(1);
    if (!row) throw new NotFoundException('事实不存在');
    const [withEv] = await this.withEvidence([row]);
    const [revisions, relations] = await Promise.all([this.revisions(id), this.relations(id)]);
    return {
      ...withEv,
      applicability: applicabilityOf(withEv as unknown as Record<string, unknown>, todayInShanghai()),
      revisions,
      relations,
    };
  }

  /**
   * 按稳定编号取单条事实（含被替代的历史版本），用于单条事实的公开地址
   * `/archive/{dataset}/{slug}/fact/{code}`。编号全网唯一，仍校验实体归属以防跨实体访问。
   */
  async byCode(entityId: number, code: string) {
    const [row] = await this.db
      .select()
      .from(facts)
      .where(and(eq(facts.entityId, entityId), eq(facts.code, code)))
      .limit(1);
    if (!row) throw new NotFoundException('事实不存在');
    const [withEv] = await this.withEvidence([row]);
    const [revisions, relations] = await Promise.all([this.revisions(row.id), this.relations(row.id)]);
    return {
      ...withEv,
      applicability: applicabilityOf(withEv as unknown as Record<string, unknown>, todayInShanghai()),
      revisions,
      relations,
    };
  }

  /** 事实逐版不可变修订轨迹（升序），供详情页「修订轨迹 / 查看旧版」 */
  async revisions(factId: number) {
    const rows = await this.db
      .select()
      .from(factRevisions)
      .where(eq(factRevisions.factId, factId))
      .orderBy(asc(factRevisions.rev));
    return rows.map((r) => ({
      ...r,
      evidenceIds: (r.evidenceIds as number[] | null) ?? [],
      confidence: Number(r.confidence ?? 0),
    }));
  }

  /** 事实间关系（版本继承 / 更正链），双向展开：本事实作为 from（取代）或 to（被取代） */
  async relations(factId: number) {
    const rows = await this.db
      .select({
        id: factRelations.id,
        fromFactId: factRelations.fromFactId,
        toFactId: factRelations.toFactId,
        type: factRelations.type,
        peerId: sql<number>`CASE WHEN ${factRelations.fromFactId} = ${factId} THEN ${factRelations.toFactId} ELSE ${factRelations.fromFactId} END`,
        peerCode: sql<string>`(SELECT code FROM ${facts} f WHERE f.id = CASE WHEN ${factRelations.fromFactId} = ${factId} THEN ${factRelations.toFactId} ELSE ${factRelations.fromFactId} END)`,
        peerStatement: sql<string>`(SELECT statement FROM ${facts} f WHERE f.id = CASE WHEN ${factRelations.fromFactId} = ${factId} THEN ${factRelations.toFactId} ELSE ${factRelations.fromFactId} END)`,
      })
      .from(factRelations)
      .where(or(eq(factRelations.fromFactId, factId), eq(factRelations.toFactId, factId)));
    return rows.map((r) => ({
      id: Number(r.id),
      type: r.type,
      direction: Number(r.fromFactId) === factId ? 'out' : 'in',
      peer: { factId: Number(r.peerId), code: r.peerCode ?? null, statement: r.peerStatement ?? null },
    }));
  }

  // ---------------------------------------------------------------- 写入

  /**
   * 事实 append-only + 槽位归并（二元口径：新增 / 更新）：
   * - 同维度无现行版本 → 新建 v1 + change(new)
   * - 同维度有现行版本 → 一律交「归并裁决器」(大模型)，结论只有两种：
   *   duplicate（讲的是同一件事）→「更新」：表述一致则计数+1/刷新核验时间不建新版本；
   *              表述不同则新版本取代旧版（旧版 superseded 保留备查）+ change(update)
   *   append   （讲的是另一件事）→「新增」：作为独立事实落库，不取代任何既有事实 + change(new)
   *   模型同时给出槽位三轴（semantic_role / period_key / subject_scope）。
   * - 裁决器不可用时退回字面判同兜底（归一化后相似度 ≥ 阈值 → 更新），否则新增独立事实，绝不擅自取代。
   * - dto.skipSupersede=true → 调用方（人工仲裁/管线显式决议）已定，跳过裁决，按原行为执行。
   */
  async create(dto: CreateFactDto, userId?: number) {
    const [entity] = await this.db
      .select()
      .from(entities)
      .where(and(eq(entities.id, dto.entityId), isNull(entities.deletedAt)))
      .limit(1);
    if (!entity) throw new NotFoundException('实体不存在');

    // 编号命名空间：实体首次来源的语料域 code（如 wenzhou-city-trust），无则 global
    const [ds] = entity.originDatasetId
      ? await this.db
          .select({ code: datasets.code })
          .from(datasets)
          .where(eq(datasets.id, entity.originDatasetId))
          .limit(1)
      : [];
    const datasetCode = ds?.code ?? 'global';

    const verifiedAt = dto.lastVerifiedAt ?? today();
    const firstSeen = dto.firstSeenAt ?? verifiedAt;

    // 归并裁决在实体行锁之外进行：模型调用耗时长，不能占着锁阻塞同实体其他写入；
    // 拿到裁决结果后再进事务，用最新的候选快照落库（applyCreate 内会重新取候选）。
    const adjudication = await this.preAdjudicate(dto, entity.name);

    // 并发一致性：同一实体的并发事实写入用事务 + 实体行锁串行化，让
    // 「查现行 → 判同一/更新/新建」原子化。否则并发抽取同一条事实（跨文章）
    // 会各自当成首建重复入档（F-01 重号），或两路并发算出同一 version 造成丢失更新。
    const { factId } = await this.withLockRetry(() =>
      this.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM ${entities} WHERE id = ${dto.entityId} FOR UPDATE`);
        const candidates = await this.findCurrentCandidates(dto.entityId, dto.dimension, tx);
        return this.applyCreate(tx, { dto, userId, datasetCode, verifiedAt, firstSeen }, candidates, adjudication);
      }),
    );

    return this.detail(factId);
  }

  /** 事务内落库：多源确认 → 自动归并裁决 → 首版/人工覆盖，三分支互斥。 */
  private async applyCreate(
    tx: TxDb,
    ctx: { dto: CreateFactDto; userId?: number; datasetCode: string; verifiedAt: string; firstSeen: string },
    candidates: FactRow[],
    adjudication: AdjudicationResult | null,
  ): Promise<{ factId: number }> {
    const { dto, userId, datasetCode, verifiedAt, firstSeen } = ctx;

    // 1) 无模型裁决（调用方已定 / 模型不可用）时才退回字面判同兜底：
    //    同维度现行事实里有同义/近义表述 → 计数 +1，不新建版本。
    //    有模型裁决时不走这里：判同交给模型（见 applyAdjudicated 的 duplicate 分支）。
    if (!adjudication && !dto.skipSupersede) {
      const dup = this.findNearDuplicate(dto.statement, candidates);
      if (dup) return this.corroborate(tx, dto, userId, dup.target, verifiedAt, dup.note);
    }

    const existing = candidates[0] ?? null;

    // 2) 同维度已有现行事实且无人工覆盖 → 由裁决结果决定「更新」还是「新增」
    if (existing && !dto.skipSupersede) {
      // 2.1) 兜底路径的「同槽位重复复活」防护：新陈述与已退役的历史版本近义、而现行版本是另一种说法时，
      //      不新建版本（否则同一措辞会以新版本号重新冒出来），只对历史版本留多源确认痕迹。
      if (!adjudication) {
        const retired = this.findNearDuplicate(
          dto.statement,
          await this.findRetiredInDimension(dto.entityId, dto.dimension, tx),
        );
        if (retired) return this.corroborate(tx, dto, userId, retired.target, verifiedAt, retired.note);
      }

      return this.applyAdjudicated(tx, ctx, candidates, existing, adjudication);
    }

    // 3) 首版 或 调用方显式覆盖（skipSupersede）
    const nextVersion = await this.nextVersion(dto.entityId, dto.dimension, tx);
    const code = dto.code ?? (await this.nextCode(dto.entityId, datasetCode, tx));
    const status: FactStatus = dto.status ?? 'active';

    // S1 缺轴兜底：三轴全空时按事实类型补 semantic_role；时间键缺失时从陈述里抽年份/季度/月份
    const axes = fillSlotAxes(
      dto.semanticRole ?? null,
      dto.periodKey ?? null,
      dto.subjectScope ?? null,
      dto.factType,
      dto.statement,
    );

    const [ins] = await tx.insert(facts).values({
      entityId: dto.entityId,
      code,
      dimension: dto.dimension,
      statement: dto.statement,
      factType: dto.factType,
      status,
      confidence: String(dto.confidence),
      corroborateCount: 1,
      firstSeenAt: existing ? existing.firstSeenAt : firstSeen,
      lastVerifiedAt: verifiedAt,
      // 有效起始日：显式给定优先，否则由槽位 period_key（年份/季度/月份）推边界
      validFrom: dto.validFrom ?? periodKeyToValidFrom(axes.periodKey),
      validTo: dto.validTo ?? null,
      version: nextVersion,
      arbitrationNote: dto.arbitrationNote ?? null,
      semanticRole: axes.role,
      periodKey: axes.periodKey,
      subjectScope: axes.subjectScope,
      origin: dto.origin,
      createdBy: userId ?? null,
      updatedBy: userId ?? null,
      // v2 时间语义 / 签发责任 / 告警
      temporalKind: dto.temporalKind ?? 'unknown',
      asOf: dto.asOf ?? null,
      eventStart: dto.eventStart ?? null,
      eventEnd: dto.eventEnd ?? null,
      method: dto.method ?? null,
      signMode: dto.signMode ?? (dto.origin === 'llm' ? 'auto' : 'human'),
      sourceAuthority: dto.sourceAuthority ?? null,
      independentlyVerified: dto.independentlyVerified ?? false,
      issuedAt: isoToDate(dto.issuedAt),
      alerts: dto.alerts ?? [],
      // 断言形态与时间精度（PRD R02/R03）：所有写入通道统一在此补
      statementKind: classifyStatementKind(dto.statement),
      timePrecision: periodPrecision(axes.periodKey),
      timeCertainty: timeCertaintyOf(dto.statement, axes.periodKey),
    });
    const factId = Number(ins.insertId);

    await this.snapshotRevision(tx, factId, nextVersion, {
      dimension: dto.dimension,
      statement: dto.statement,
      factType: dto.factType,
      confidence: dto.confidence,
      temporalKind: dto.temporalKind ?? 'unknown',
      asOf: dto.asOf ?? null,
      eventStart: dto.eventStart ?? null,
      eventEnd: dto.eventEnd ?? null,
      validFrom: dto.validFrom ?? periodKeyToValidFrom(axes.periodKey),
      validTo: dto.validTo ?? null,
      qualifier: axes.subjectScope,
      method: dto.method ?? null,
      signMode: dto.signMode ?? (dto.origin === 'llm' ? 'auto' : 'human'),
      sourceAuthority: dto.sourceAuthority ?? null,
      independentlyVerified: dto.independentlyVerified ?? false,
      actor: userId ?? null,
      release: status,
      changeType: 'initial',
      reason: dto.arbitrationNote ?? null,
      issuedAt: dto.issuedAt ?? null,
      evidenceIds: dto.evidenceIds,
    });

    if (existing && dto.skipSupersede && !dto.suppressChange) {
      // 冲突裁决：保留现行版本（keep_old 新版本作 superseded 备查 / coexist 两者均生效）
      await tx.insert(factChanges).values({
        entityId: dto.entityId,
        // coexist（两者均生效）是新添了一条并列事实 → new；keep_old（新版作 superseded）才记 update
        changeType: dto.status === 'active' ? 'new' : 'update',
        occurredAt: verifiedAt,
        fromFactId: existing.id,
        toFactId: factId,
        summary:
          dto.changeSummary ??
          (dto.status === 'superseded'
            ? `${dto.dimension} 冲突裁决·保留旧版，新版作 superseded 备查`
            : `${dto.dimension} 冲突裁决·多流派并存，两者均生效`),
        rationale: dto.arbitrationNote ?? '人工冲突裁决',
        mechanismJson: {
          kind: dto.status === 'superseded' ? 'arbitrate_keep_old' : 'arbitrate_coexist',
          detail: `现行 ${existing.code ?? `v${existing.version}`} 保留；${code} 置 ${dto.status}`,
          fromVersion: existing.version,
          toVersion: nextVersion,
        },
        articleId: dto.articleId ?? null,
        createdBy: userId ?? null,
      });
    } else if (!dto.suppressChange) {
      await tx.insert(factChanges).values({
        entityId: dto.entityId,
        changeType: 'new',
        occurredAt: firstSeen,
        fromFactId: null,
        toFactId: factId,
        summary: dto.changeSummary ?? `新增事实：${dto.dimension}`,
        rationale: '该维度首次入档',
        mechanismJson: { kind: 'new', version: nextVersion },
        articleId: dto.articleId ?? null,
        createdBy: userId ?? null,
      });
    }

    if (dto.evidenceIds.length) {
      await this.attachEvidence(factId, dto.evidenceIds, 'support', tx);
    }

    return { factId };
  }

  /**
   * 归并裁决落库：按 verdict 决定「更新」还是「新增」，并写入槽位三轴与变化留痕。
   * - duplicate → 更新：表述归一化后一致则不建新行（多源确认）；否则新 active + target 转 superseded
   * - append    → 新增：新 active + target 保持 active（两者是互不覆盖的独立事实）
   */
  private async applyAdjudicated(
    tx: TxDb,
    ctx: { dto: CreateFactDto; userId?: number; datasetCode: string; verifiedAt: string; firstSeen: string },
    candidates: FactRow[],
    existing: FactRow,
    adjudication: AdjudicationResult | null,
  ): Promise<{ factId: number }> {
    const { dto, userId, datasetCode, verifiedAt, firstSeen } = ctx;

    let verdict: Verdict;
    let target = existing;
    let role: SemanticRole | null = dto.semanticRole ?? null;
    let periodKey: string | null = dto.periodKey ?? null;
    let subjectScope: string | null = dto.subjectScope ?? null;
    let reason = '';
    /** 是否由大模型裁决产出；false = 裁决器不可用（存量审计可据此定向回溯） */
    const llmUsed = adjudication != null;

    if (adjudication) {
      verdict = adjudication.verdict;
      role = dto.semanticRole ?? adjudication.semanticRole ?? null;
      periodKey = dto.periodKey ?? adjudication.periodKey ?? null;
      subjectScope = dto.subjectScope ?? adjudication.subjectScope ?? null;
      reason = adjudication.reason;
      if (adjudication.targetFactId != null) {
        target = candidates.find((c) => c.id === adjudication.targetFactId) ?? existing;
      }
    } else {
      // 兜底：裁决器不可用 → 不做任何取代，一律作为独立事实新增（宁可多留一条，也不误取代）
      verdict = 'append';
      reason = '裁决器不可用，退为新增独立事实（不取代任何既有事实）';
    }

    // S1 缺轴兜底：裁决器未给出槽位轴时按事实类型补 semantic_role，并从陈述里抽时间键。
    const axes = fillSlotAxes(role, periodKey, subjectScope, dto.factType, dto.statement);
    role = axes.role;
    periodKey = axes.periodKey;
    subjectScope = axes.subjectScope;
    if (axes.filled || axes.periodFilled) {
      const notes: string[] = [];
      if (axes.filled) notes.push(`按事实类型自动补 semantic_role=${role}`);
      if (axes.periodFilled) notes.push(`时间键由陈述自动推断 period_key=${periodKey}`);
      reason = `${reason ? `${reason}；` : ''}缺轴兜底：${notes.join('、')}，待人工复核`;
    }

    // 模型判为「同义复述」→ 多源确认（计数+1、刷新核验时间，不新建版本）
    if (verdict === 'corroborate') {
      return this.corroborate(
        tx,
        dto,
        userId,
        target,
        verifiedAt,
        `同义复述（模型裁决 corroborate）：${reason}`,
      );
    }

    // duplicate 且文本近似（仅差虚词，或数字集合不变且相似度≥高阈值）→ 兜底走多源确认
    if (verdict === 'duplicate' && isCorroborating(dto.statement, target.statement)) {
      return this.corroborate(
        tx,
        dto,
        userId,
        target,
        verifiedAt,
        `同语义且同义复述（模型裁决 duplicate）：${reason}`,
      );
    }

    const nextVersion = await this.nextVersion(dto.entityId, dto.dimension, tx);
    const code = dto.code ?? (await this.nextCode(dto.entityId, datasetCode, tx));
    const status: FactStatus = 'active';

    const [ins] = await tx.insert(facts).values({
      entityId: dto.entityId,
      code,
      dimension: dto.dimension,
      statement: dto.statement,
      factType: dto.factType,
      status,
      confidence: String(dto.confidence),
      corroborateCount: 1,
      firstSeenAt: firstSeen,
      lastVerifiedAt: verifiedAt,
      // 有效起始日：显式给定优先，否则由裁决后的槽位 period_key 推边界
      validFrom: dto.validFrom ?? periodKeyToValidFrom(periodKey),
      validTo: dto.validTo ?? null,
      version: nextVersion,
      arbitrationNote: dto.arbitrationNote ?? (axes.filled ? reason || null : null),
      semanticRole: role,
      periodKey,
      subjectScope,
      origin: dto.origin,
      createdBy: userId ?? null,
      updatedBy: userId ?? null,
      // v2 时间语义 / 签发责任 / 告警
      temporalKind: dto.temporalKind ?? 'unknown',
      asOf: dto.asOf ?? null,
      eventStart: dto.eventStart ?? null,
      eventEnd: dto.eventEnd ?? null,
      method: dto.method ?? null,
      signMode: dto.signMode ?? (dto.origin === 'llm' ? 'auto' : 'human'),
      sourceAuthority: dto.sourceAuthority ?? null,
      independentlyVerified: dto.independentlyVerified ?? false,
      issuedAt: isoToDate(dto.issuedAt),
      alerts: dto.alerts ?? [],
      statementKind: classifyStatementKind(dto.statement),
      timePrecision: periodPrecision(periodKey),
      timeCertainty: timeCertaintyOf(dto.statement, periodKey),
    });
    const factId = Number(ins.insertId);

    await this.snapshotRevision(tx, factId, nextVersion, {
      dimension: dto.dimension,
      statement: dto.statement,
      factType: dto.factType,
      confidence: dto.confidence,
      temporalKind: dto.temporalKind ?? 'unknown',
      asOf: dto.asOf ?? null,
      eventStart: dto.eventStart ?? null,
      eventEnd: dto.eventEnd ?? null,
      validFrom: dto.validFrom ?? periodKeyToValidFrom(axes.periodKey),
      validTo: dto.validTo ?? null,
      qualifier: axes.subjectScope,
      method: dto.method ?? null,
      signMode: dto.signMode ?? (dto.origin === 'llm' ? 'auto' : 'human'),
      sourceAuthority: dto.sourceAuthority ?? null,
      independentlyVerified: dto.independentlyVerified ?? false,
      actor: userId ?? null,
      release: status,
      changeType: 'initial',
      reason: dto.arbitrationNote ?? null,
      issuedAt: dto.issuedAt ?? null,
      evidenceIds: dto.evidenceIds,
    });

    // duplicate（同语义、表述不同）→ 旧版转 superseded 保留备查，由本条取代
    if (verdict === 'duplicate') {
      await tx
        .update(facts)
        .set({ status: 'superseded', supersededById: factId })
        .where(eq(facts.id, target.id));
      // 版本继承关系：新事实取代旧事实（支撑详情页「被本事实取代」关联）
      await tx.insert(factRelations).values({
        fromFactId: factId,
        toFactId: target.id,
        type: 'succeeds',
      });
    }

    if (!dto.suppressChange) {
      const summaryMap: Record<string, string> = {
        duplicate: `${dto.dimension} 同语义更新（${target.code ?? `v${target.version}`} → 新版本）`,
        append: `${dto.dimension} 新增独立事实（与 ${target.code ?? `v${target.version}`} 并存）`,
      };
      // change_type 忠实映射裁决结果：duplicate 是「更新」（旧值被取代），append 是「新增」
      const changeType = verdict === 'duplicate' ? 'update' : 'new';
      await tx.insert(factChanges).values({
        entityId: dto.entityId,
        changeType,
        occurredAt: verdict === 'duplicate' ? verifiedAt : firstSeen,
        fromFactId: target.id,
        toFactId: factId,
        summary: dto.changeSummary ?? summaryMap[verdict] ?? `${dto.dimension} 裁决：${verdict}`,
        rationale: reason || '大模型归并裁决',
        mechanismJson: {
          kind: verdict === 'duplicate' ? 'supersede' : 'append_standalone',
          verdict,
          llmUsed,
          targetFactId: target.id,
          semanticRole: role,
          periodKey,
          subjectScope,
          reason,
        },
        articleId: dto.articleId ?? null,
        createdBy: userId ?? null,
      });
    }

    if (dto.evidenceIds.length) {
      await this.attachEvidence(factId, dto.evidenceIds, 'support', tx);
    }

    return { factId };
  }

  /** 多源确认：陈述一致/近义（硬规则命中） → 计数 +1、刷新核验时间、置信微升，不产生新版本。 */
  private async corroborate(
    tx: TxDb,
    dto: CreateFactDto,
    userId: number | undefined,
    target: FactRow,
    verifiedAt: string,
    note?: string,
  ): Promise<{ factId: number }> {
    await tx
      .update(facts)
      .set({
        corroborateCount: (target.corroborateCount ?? 1) + 1,
        lastVerifiedAt: verifiedAt,
        confidence: String(Math.min(1, Number(target.confidence ?? 0.5) + 0.05)),
      })
      .where(eq(facts.id, target.id));

    await tx.insert(factChanges).values({
      entityId: dto.entityId,
      changeType: 'corroborate',
      occurredAt: verifiedAt,
      fromFactId: null,
      toFactId: target.id,
      summary:
        dto.changeSummary ??
        `${dto.dimension} 口径获多源确认（第 ${(target.corroborateCount ?? 1) + 1} 源）`,
      rationale: note ?? `与现行版本 F 值一致，不产生新版本；置信提升并保持 active`,
      mechanismJson: {
        kind: 'corroborate',
        // P5：原 `note ? 'near_duplicate' : 'exact'` 三元在「所有调用入口都传 note」下恒为 'near_duplicate'，
        // 'exact' 分支全库从未产生（0 条）→ 死分支。改为语义明确的 'restatement'，仍表达「同义复述」。
        via: 'restatement',
        detail: `corroborate_count ${target.corroborateCount ?? 1} → ${(target.corroborateCount ?? 1) + 1}`,
        lastVerifiedAt: verifiedAt,
      },
      articleId: dto.articleId ?? null,
      createdBy: userId ?? null,
    });

    if (dto.evidenceIds.length) {
      await this.attachEvidence(target.id, dto.evidenceIds, 'support', tx);
    }
    return { factId: target.id };
  }

  /** 元数据修改：原地改 + 只写 audit_log，不动版本链 */
  async updateMetadata(id: number, dto: UpdateFactDto, userId?: number) {
    const current = await this.detail(id);
    const before = { status: current.status, confidence: current.confidence, note: current.arbitrationNote };

    if (dto.status && dto.status !== current.status) {
      const allowed = TRANSITIONS[current.status as FactStatus] ?? [];
      if (!allowed.includes(dto.status)) {
        throw new ConflictException(
          `状态机不允许 ${current.status} → ${dto.status}（允许：${allowed.join(' / ') || '终态'}）`,
        );
      }
    }

    const patch: Partial<typeof facts.$inferInsert> = { updatedBy: userId ?? null };
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.confidence !== undefined) patch.confidence = String(dto.confidence);
    if (dto.arbitrationNote !== undefined) patch.arbitrationNote = dto.arbitrationNote ?? null;
    if (dto.dimension !== undefined) patch.dimension = dto.dimension;
    if (dto.factType !== undefined) patch.factType = dto.factType;
    if (dto.validFrom !== undefined) patch.validFrom = dto.validFrom ?? null;
    if (dto.validTo !== undefined) patch.validTo = dto.validTo ?? null;
    if (dto.lastVerifiedAt !== undefined) patch.lastVerifiedAt = dto.lastVerifiedAt ?? null;
    if (dto.code !== undefined) patch.code = dto.code;
    if (dto.temporalKind !== undefined) patch.temporalKind = dto.temporalKind;
    if (dto.asOf !== undefined) patch.asOf = dto.asOf ?? null;
    if (dto.eventStart !== undefined) patch.eventStart = dto.eventStart ?? null;
    if (dto.eventEnd !== undefined) patch.eventEnd = dto.eventEnd ?? null;
    if (dto.method !== undefined) patch.method = dto.method ?? null;
    if (dto.signMode !== undefined) patch.signMode = dto.signMode;
    if (dto.sourceAuthority !== undefined) patch.sourceAuthority = dto.sourceAuthority ?? null;
    if (dto.independentlyVerified !== undefined) patch.independentlyVerified = dto.independentlyVerified;
    if (dto.issuedAt !== undefined)
      patch.issuedAt = isoToDate(dto.issuedAt);
    if (dto.alerts !== undefined) patch.alerts = dto.alerts ?? [];

    await this.db.update(facts).set(patch).where(eq(facts.id, id));

    await this.audit.record({
      userId: userId ?? null,
      action: 'fact.update_metadata',
      targetType: 'fact',
      targetId: id,
      before,
      after: patch,
      remark: '元数据修改：不产生新版本',
    });

    return this.detail(id);
  }

  async retire(id: number, note: string | null, userId?: number) {
    const current = await this.detail(id);
    if (current.status !== 'active' && current.status !== 'pending_arbitration') {
      throw new ConflictException(`当前状态 ${current.status} 不可退役`);
    }
    await this.db.update(facts).set({ status: 'archived', updatedBy: userId ?? null }).where(eq(facts.id, id));
    await this.db.insert(factChanges).values({
      entityId: current.entityId,
      changeType: 'retire',
      occurredAt: today(),
      fromFactId: id,
      toFactId: null,
      summary: `事实退役：${current.code ?? current.dimension}`,
      rationale: note ?? '人工退役',
      mechanismJson: { kind: 'retire', from: current.status },
      createdBy: userId ?? null,
    });
    return this.detail(id);
  }

  /**
   * 到期自动退役（定时任务）：valid_to 早于今日的现行事实转 archived，并写一条 retire 变更留痕。
   * 与 currentByEntity/list(current) 的查询时判定互为兜底——查询侧即便任务未跑也不会把过期事实算作现行。
   */
  async retireExpired(): Promise<{ retired: number }> {
    const t = today();
    const rows = await this.db
      .select({ id: facts.id, entityId: facts.entityId, code: facts.code, dimension: facts.dimension })
      .from(facts)
      .where(
        and(
          inArray(facts.status, ACTIVE_STATUSES),
          isNotNull(facts.validTo),
          lt(facts.validTo, t),
          // valid_to 的「有效期」语义只适用于现状/来源披露类；occurred 历史事件永不因过期退役
          inArray(facts.factType, ['current_state', 'source_claim']),
        ),
      );
    for (const r of rows) {
      await this.db.update(facts).set({ status: 'archived' }).where(eq(facts.id, r.id));
      await this.db.insert(factChanges).values({
        entityId: r.entityId,
        changeType: 'retire',
        occurredAt: t,
        fromFactId: r.id,
        toFactId: null,
        summary: `事实到期退役：${r.code ?? r.dimension}`,
        rationale: '有效截止日（valid_to）已过，自动退役',
        mechanismJson: { kind: 'retire_expired' },
      });
    }
    return { retired: rows.length };
  }

  // ---------------------------------------------------------------- 证据挂载

  /** 「引句是否和主张完全无关」：去标点后取二字词(2-gram)交集；完全没有共同二字词才判为无关。
   *  目的：挂在事实上的证据必须"多少在讲这件事"。像「鲜肉汤圆」引句挂到「麦饼固定菜单项」主张
   *  （二字词交集为 0）就拦下；「巴黎…女人麦饼店」仍含「麦饼/巴黎」，哪怕弱相关也保留，不误伤。 */
  private evidenceRelevant(statement: string | null | undefined, quote: string | null | undefined): boolean {
    const words = (s: string) => {
      const t = String(s ?? '').replace(/[\s，。、；：？！·“”‘’"\'（）()〈〉《》【】\[\]—…\-]/g, '');
      const set = new Set<string>();
      for (let i = 0; i + 1 < t.length; i++) set.add(t.slice(i, i + 2));
      return set;
    };
    const s = words(statement ?? '');
    const q = words(quote ?? '');
    if (s.size === 0 || q.size === 0) return true; // 缺少文本时不拦（保守放行）
    for (const w of s) if (q.has(w)) return true; // 有任一共词即视为相关
    return false;
  }

  async attachEvidence(factId: number, evidenceIds: number[], role: 'support' | 'refute' = 'support', db: TxDb = this.db) {
    if (!evidenceIds.length) return { attached: 0, filtered: 0 };
    // 只保留「引句与主张相关」的证据，彻底无关的（如汤圆句挂到麦饼主张）不再挂到该事实
    const [f] = await db.select({ statement: facts.statement }).from(facts).where(eq(facts.id, factId)).limit(1);
    let ids = evidenceIds;
    let filtered = 0;
    if (f?.statement) {
      const evs = await db
        .select({ id: evidence.id, quote: evidence.quote })
        .from(evidence)
        .where(inArray(evidence.id, evidenceIds));
      const keep = new Set(evs.filter((e) => this.evidenceRelevant(f.statement, e.quote)).map((e) => e.id));
      ids = evidenceIds.filter((id) => keep.has(id));
      filtered = evidenceIds.length - ids.length;
    }
    if (!ids.length) return { attached: 0, filtered };
    await db
      .insert(factEvidences)
      .values(ids.map((evidenceId) => ({ factId, evidenceId, role })))
      .onDuplicateKeyUpdate({ set: { role } });
    return { attached: ids.length, filtered };
  }

  async detachEvidence(factId: number, evidenceId: number) {
    await this.db
      .delete(factEvidences)
      .where(and(eq(factEvidences.factId, factId), eq(factEvidences.evidenceId, evidenceId)));
    return { detached: true };
  }

  // ---------------------------------------------------------------- 变化 / 仲裁

  async listChanges(entityId: number, limit = 100) {
    const rows = await this.db
      .select({
        id: factChanges.id,
        changeType: factChanges.changeType,
        occurredAt: factChanges.occurredAt,
        fromFactId: factChanges.fromFactId,
        toFactId: factChanges.toFactId,
        summary: factChanges.summary,
        rationale: factChanges.rationale,
        mechanismJson: factChanges.mechanismJson,
        articleId: factChanges.articleId,
        runId: factChanges.runId,
        createdAt: factChanges.createdAt,
        articleTitle: sourceArticles.title,
        articleUrl: sourceArticles.url,
        articlePublishedAt: sourceArticles.publishedAt,
      })
      .from(factChanges)
      .leftJoin(sourceArticles, eq(factChanges.articleId, sourceArticles.id))
      .where(eq(factChanges.entityId, entityId))
      .orderBy(desc(factChanges.occurredAt), desc(factChanges.id))
      .limit(limit);

    const ids = [...new Set(rows.flatMap((r) => [r.fromFactId, r.toFactId]).filter(Boolean) as number[])];
    const factMap = new Map<number, { code: string | null; statement: string; status: string; version: number }>();
    if (ids.length) {
      const factRows = await this.db
        .select({
          id: facts.id,
          code: facts.code,
          statement: facts.statement,
          status: facts.status,
          version: facts.version,
        })
        .from(facts)
        .where(inArray(facts.id, ids));
      for (const f of factRows) factMap.set(f.id, f);
    }

    return rows.map((r) => ({
      ...r,
      fromFact: r.fromFactId ? factMap.get(r.fromFactId) ?? null : null,
      toFact: r.toFactId ? factMap.get(r.toFactId) ?? null : null,
    }));
  }

  /**
   * 按 id 取单条变更（限本实体），用于单条变更的公开地址
   * `/archive/{dataset}/{slug}/change/{id}`；返回形态与 listChanges 单条一致。
   */
  async changeById(entityId: number, id: number) {
    const [row] = await this.db
      .select({
        id: factChanges.id,
        changeType: factChanges.changeType,
        occurredAt: factChanges.occurredAt,
        fromFactId: factChanges.fromFactId,
        toFactId: factChanges.toFactId,
        summary: factChanges.summary,
        rationale: factChanges.rationale,
        mechanismJson: factChanges.mechanismJson,
        articleId: factChanges.articleId,
        runId: factChanges.runId,
        createdAt: factChanges.createdAt,
        articleTitle: sourceArticles.title,
        articleUrl: sourceArticles.url,
        articlePublishedAt: sourceArticles.publishedAt,
      })
      .from(factChanges)
      .leftJoin(sourceArticles, eq(factChanges.articleId, sourceArticles.id))
      .where(and(eq(factChanges.entityId, entityId), eq(factChanges.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException('变更记录不存在');

    const ids = [row.fromFactId, row.toFactId].filter(Boolean) as number[];
    const factMap = new Map<
      number,
      { code: string | null; statement: string; status: string; version: number; dimension: string | null }
    >();
    if (ids.length) {
      const factRows = await this.db
        .select({
          id: facts.id,
          code: facts.code,
          statement: facts.statement,
          status: facts.status,
          version: facts.version,
          dimension: facts.dimension,
        })
        .from(facts)
        .where(inArray(facts.id, ids));
      for (const f of factRows) factMap.set(f.id, f);
    }
    return {
      ...row,
      fromFact: row.fromFactId ? factMap.get(row.fromFactId) ?? null : null,
      toFact: row.toFactId ? factMap.get(row.toFactId) ?? null : null,
    };
  }

  /** 仲裁台：同一维度存在多个并存口径的事实 */
  async conflicts(entityId: number) {
    const rows = await this.db
      .select()
      .from(facts)
      .where(
        and(
          eq(facts.entityId, entityId),
          inArray(facts.status, ['active', 'pending_arbitration', 'pending_review']),
        ),
      )
      .orderBy(asc(facts.dimension), desc(facts.version));

    const grouped = new Map<string, (typeof facts.$inferSelect)[]>();
    for (const r of rows) {
      const key = r.dimension ?? '_';
      const list = grouped.get(key) ?? [];
      list.push(r);
      grouped.set(key, list);
    }

    const groups: ConflictGroup[] = [];
    for (const [dimension, list] of grouped) {
      if (list.length < 2) continue;
      const withEvidence = await this.withEvidence(list);
      groups.push({ dimension, count: list.length, facts: withEvidence });
    }
    return { entityId, groups };
  }

  async arbitrate(dto: ArbritrateDto, userId?: number) {
    const { groups: conflictGroups } = await this.conflicts(dto.entityId);
    const group = conflictGroups.find((g) => g.dimension === dto.dimension);
    if (!group) throw new BadRequestException('该维度没有待仲裁的冲突');

    if (dto.mode === 'adopt') {
      if (!dto.winnerFactId) throw new BadRequestException('adopt 模式必须指定 winnerFactId');
      const winner = group.facts.find((f) => f.id === dto.winnerFactId);
      if (!winner) throw new BadRequestException('winnerFactId 不在该维度冲突组内');

      await this.db
        .update(facts)
        .set({ status: 'active', arbitrationNote: dto.note ?? null, updatedBy: userId ?? null })
        .where(eq(facts.id, winner.id));

      for (const loser of group.facts) {
        if (loser.id === winner.id) continue;
        await this.db
          .update(facts)
          .set({ status: 'superseded', supersededById: winner.id, arbitrationNote: dto.note ?? null })
          .where(eq(facts.id, loser.id));
        await this.db.insert(factChanges).values({
          entityId: dto.entityId,
          changeType: 'update',
          occurredAt: today(),
          fromFactId: loser.id,
          toFactId: winner.id,
          summary: `仲裁采纳：${dto.dimension} 采用 ${winner.code ?? `#${winner.id}`}`,
          rationale: dto.note ?? '人工裁决采纳该版本',
          mechanismJson: { kind: 'arbitrate_adopt', loser: loser.code, winner: winner.code },
          createdBy: userId ?? null,
        });
      }
    } else {
      for (const f of group.facts) {
        await this.db
          .update(facts)
          .set({ status: 'pending_arbitration', arbitrationNote: dto.note ?? '多流派并存，人工标记为共存口径' })
          .where(eq(facts.id, f.id));
      }
      await this.db.insert(factChanges).values({
        entityId: dto.entityId,
        changeType: 'corroborate',
        occurredAt: today(),
        fromFactId: group.facts[0]?.id ?? null,
        toFactId: group.facts[group.facts.length - 1]?.id ?? null,
        summary: `仲裁结论：${dto.dimension} 标为多流派并存`,
        rationale: dto.note ?? '不强行归一，多个口径同时保留',
        mechanismJson: { kind: 'arbitrate_coexist', count: group.facts.length },
        createdBy: userId ?? null,
      });
    }

    await this.audit.record({
      userId: userId ?? null,
      action: `fact.arbitrate_${dto.mode}`,
      targetType: 'fact',
      targetId: dto.winnerFactId ?? group.facts[0]?.id ?? null,
      after: dto,
      remark: `维度 ${dto.dimension} 仲裁`,
    });

    return this.conflicts(dto.entityId);
  }

  // ---------------------------------------------------------------- 口径维度（v2 全局定义）

  async listDimensions() {
    return this.db
      .select()
      .from(factDimensions)
      .orderBy(asc(factDimensions.sort), asc(factDimensions.id));
  }

  async createDimension(dto: {
    code: string;
    name: string;
    description?: string | null;
    sort?: number;
  }) {
    const [dup] = await this.db
      .select({ id: factDimensions.id })
      .from(factDimensions)
      .where(eq(factDimensions.code, dto.code))
      .limit(1);
    if (dup) throw new ConflictException('维度 code 全局已存在');
    const [ins] = await this.db.insert(factDimensions).values({
      code: dto.code,
      name: dto.name,
      description: dto.description ?? null,
      sort: dto.sort ?? 0,
    });
    return { id: Number(ins.insertId), ...dto };
  }

  /** 维度元数据编辑（name/description/sort/status；code 不可改，事实挂靠它） */
  async updateDimension(
    id: number,
    dto: { name?: string; description?: string | null; sort?: number; status?: 'active' | 'disabled' },
  ) {
    const [row] = await this.db.select().from(factDimensions).where(eq(factDimensions.id, id)).limit(1);
    if (!row) throw new NotFoundException('维度不存在');
    await this.db
      .update(factDimensions)
      .set({
        name: dto.name ?? row.name,
        description: dto.description ?? row.description,
        sort: dto.sort ?? row.sort,
        status: dto.status ?? row.status,
      })
      .where(eq(factDimensions.id, id));
    const [updated] = await this.db.select().from(factDimensions).where(eq(factDimensions.id, id)).limit(1);
    return updated;
  }

  // ---------------------------------------------------------------- 内部

  /**
   * 并发写入复用：同一实体的检查-判定-写入跑在事务 + 行锁里，多路并发可能
   * 触发死锁（ER_LOCK_DEADLOCK, errno 1213），被选为牺牲者的事务整体回滚，
   * 这里在事务级重试（退避递增 + 抖动），通常一次重试即可成功。
   */
  private async withLockRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < tries; i += 1) {
      try {
        return await fn();
      } catch (e) {
        const err = e as { errno?: number; code?: string; message?: string };
        const isDeadlock =
          err?.errno === 1213 ||
          err?.code === 'ER_LOCK_DEADLOCK' ||
          /deadlock/i.test(err?.message ?? '');
        if (!isDeadlock) throw e;
        lastErr = e;
        await new Promise((r) => setTimeout(r, 50 * (i + 1) + Math.random() * 50));
      }
    }
    throw lastErr;
  }

  /**
   * 取同维度下所有现行（active / pending_arbitration）版本，按版本降序。
   * 顺序即优先级：[0] 为同维度最新版本，其余为可能的并列槽位候选。
   */
  private async findCurrentCandidates(entityId: number, dimension: string, db: TxDb = this.db) {
    return db
      .select()
      .from(facts)
      .where(
        and(
          eq(facts.entityId, entityId),
          eq(facts.dimension, dimension),
          inArray(facts.status, ACTIVE_STATUSES),
        ),
      )
      .orderBy(desc(facts.version));
  }

  /**
   * 近义判同（硬规则「近义即合并」）：在同一维度的事实行中找出与新陈述最接近的一条。
   * - 先在现行（active/pending_arbitration）版本里找：同一件事的不同措辞应合并到现行那条；
   * - 现行里没有时再到已退役的历史版本里找：用于识别「同槽位重复复活」。
   * 命中返回 target 与写库留痕用的 note；未命中返回 null（继续走裁决器 / 首建）。
   */
  private findNearDuplicate(
    statement: string,
    rows: FactRow[],
  ): { target: FactRow; note: string } | null {
    const isActive = (r: FactRow) => ACTIVE_STATUSES.includes(r.status as FactStatus);
    const pick = (list: FactRow[]) => {
      let best: { target: FactRow; sim: number } | null = null;
      for (const r of list) {
        const sim = statementSimilarity(statement, r.statement);
        if (sim < NEAR_DUPLICATE_THRESHOLD) continue;
        // 相似度相同时取版本号更大的，合并到较新的那条
        if (!best || sim > best.sim || (sim === best.sim && r.version > best.target.version)) {
          best = { target: r, sim };
        }
      }
      return best;
    };

    const hit = pick(rows.filter(isActive));
    if (hit) {
      return {
        target: hit.target,
        note:
          `近义表述与现行版本一致（文本相似度 ${hit.sim.toFixed(2)}，阈值 ${NEAR_DUPLICATE_THRESHOLD}）：` +
          '按「近义即合并」硬规则合并为多源确认，不新建版本',
      };
    }
    const retired = pick(rows.filter((r) => !isActive(r)));
    if (retired) {
      return {
        target: retired.target,
        note:
          `与已退役版本 ${retired.target.code ?? `v${retired.target.version}`} 近义（相似度 ${retired.sim.toFixed(2)}）：` +
          '现行口径未被改写，仅留多源确认痕迹，不新建版本（避免同一措辞以新版本号重复复活）',
      };
    }
    return null;
  }

  /** 同维度下已退役（superseded / archived / rejected）的历史版本，按版本降序，最多 200 条。 */
  private async findRetiredInDimension(entityId: number, dimension: string, db: TxDb = this.db) {
    return db
      .select()
      .from(facts)
      .where(
        and(
          eq(facts.entityId, entityId),
          eq(facts.dimension, dimension),
          inArray(facts.status, ['superseded', 'archived', 'rejected']),
        ),
      )
      .orderBy(desc(facts.version))
      .limit(200);
  }

  /** 同维度下一个可用版本号（在实体行锁持有的事务内调用，故并发安全）。 */
  private async nextVersion(entityId: number, dimension: string, db: TxDb = this.db): Promise<number> {
    const [maxRow] = await db
      .select({ mv: sql<number>`MAX(${facts.version})` })
      .from(facts)
      .where(and(eq(facts.entityId, entityId), eq(facts.dimension, dimension)));
    return Number(maxRow?.mv ?? 0) + 1;
  }

  /**
   * 在实体行锁之外预跑归并裁决：仅在「同维度已有现行事实」且「新陈述与既有陈述都不同」时才调用大模型，
   * 避免无谓开销。模型不可用或异常时返回 null，由落库阶段按维度 update_policy 兜底。
   */
  private async preAdjudicate(dto: CreateFactDto, entityName: string): Promise<AdjudicationResult | null> {
    if (dto.skipSupersede) return null; // 调用方已裁决，跳过模型
    const snapshot = await this.findCurrentCandidates(dto.entityId, dto.dimension);
    if (!snapshot.length) return null;

    const cfg = await this.productionCfg();
    if (!cfg) return null;
    const updatePolicy = await this.dimensionUpdatePolicy(dto.dimension);
    try {
      return await adjudicateFact(cfg, {
        entityName,
        dimension: dto.dimension,
        newStatement: dto.statement,
        updatePolicy,
        candidates: snapshot.map((c) => ({
          factId: c.id,
          code: c.code,
          statement: c.statement,
          semanticRole: (c.semanticRole as SemanticRole | null) ?? null,
          periodKey: c.periodKey,
          subjectScope: c.subjectScope,
        })),
      });
    } catch {
      return null;
    }
  }

  /** 生产线大模型配置（取第一启用且设为生产的文本模型）。 */
  private async productionCfg(): Promise<LlmCfg | null> {
    const settings = await this.llmConfig.getProductionSettings().catch(() => []);
    const [s] = settings;
    if (!s?.baseUrl || !s?.model) return null;
    return {
      baseUrl: s.baseUrl,
      apiKey: s.apiKey ?? null,
      model: s.model,
      temperature: 0.1,
      maxTokens: 1024,
    };
  }

  /** 维度级兜底更新策略（LLM 裁决不可用时的缺省），按 code 或 name 匹配 fact_dimension。 */
  private async dimensionUpdatePolicy(dimension: string, db: TxDb = this.db): Promise<UpdatePolicy> {
    const [row] = await db
      .select({ policy: factDimensions.updatePolicy })
      .from(factDimensions)
      .where(or(eq(factDimensions.code, dimension), eq(factDimensions.name, dimension)))
      .limit(1);
    return (row?.policy as UpdatePolicy) ?? 'replace';
  }

  /**
   * 落一份事实逐版不可变修订快照（append-only），支撑详情页「修订轨迹 / 查看旧版」。
   * 仅在产生新事实行（首版 / 取代更新 / 冲突裁决新增）时调用，旧值不原地改。
   */
  private async snapshotRevision(
    tx: TxDb,
    factId: number,
    rev: number,
    r: {
      statement: string;
      dimension: string;
      factType: string;
      confidence: number;
      temporalKind: string;
      asOf: string | null;
      eventStart: string | null;
      eventEnd: string | null;
      validFrom: string | null;
      validTo: string | null;
      qualifier: string | null;
      method: string | null;
      signMode: string | null;
      sourceAuthority: string | null;
      independentlyVerified: boolean;
      actor: number | null;
      release: string;
      changeType: string;
      reason: string | null;
      issuedAt: string | null;
      evidenceIds: number[];
    },
  ) {
    await tx.insert(factRevisions).values({
      factId,
      rev,
      statement: r.statement,
      dimension: r.dimension,
      factType: r.factType as 'current_state' | 'source_claim' | 'occurred',
      confidence: String(r.confidence),
      temporalKind: r.temporalKind,
      asOf: r.asOf,
      eventStart: r.eventStart,
      eventEnd: r.eventEnd,
      validFrom: r.validFrom,
      validTo: r.validTo,
      qualifier: r.qualifier,
      evidenceIds: r.evidenceIds ?? [],
      method: r.method,
      signMode: r.signMode,
      sourceAuthority: r.sourceAuthority,
      independentlyVerified: r.independentlyVerified ?? false,
      actor: r.actor ?? null,
      release: r.release,
      changeType: r.changeType,
      reason: r.reason ?? null,
      issuedAt: isoToDate(r.issuedAt),
    });
  }

  private async withEvidence(rows: FactRow[]): Promise<FactWithEvidence[]> {
    if (!rows.length) return [];
    const links = await this.db
      .select({
        factId: factEvidences.factId,
        role: factEvidences.role,
        id: evidence.id,
        code: evidence.code,
        quote: evidence.quote,
        spanStart: evidence.spanStart,
        spanEnd: evidence.spanEnd,
        spanHash: evidence.spanHash,
        verifyStatus: evidence.verifyStatus,
        qualityGrade: evidence.qualityGrade,
        articleId: evidence.articleId,
        materialTitle: evidence.materialTitle,
        sourceOrg: evidence.sourceOrg,
        publishedAt: evidence.publishedAt,
      })
      .from(factEvidences)
      .innerJoin(evidence, eq(factEvidences.evidenceId, evidence.id))
      .where(inArray(factEvidences.factId, rows.map((r) => r.id)))
      .orderBy(asc(evidence.id));

    const byFact = new Map<number, unknown[]>();
    for (const l of links) {
      const list = byFact.get(l.factId) ?? [];
      list.push(l);
      byFact.set(l.factId, list);
    }

    return rows.map((r) => ({
      ...r,
      confidence: Number(r.confidence ?? 0),
      evidences: byFact.get(r.id) ?? [],
    }));
  }

  /**
   * 生成全网唯一事实编号：{dataset}-F-{entityId 6位}-{域内序号 2位}。
   * 序号在实体内递增（调用点在实体行锁持有的事务内，故并发安全）；
   * 实体 id 全局唯一 ⇒ 编号全网不撞号（旧格式 F-01 实体内唯一、全网重号）。
   */
  private async nextCode(entityId: number, datasetCode: string, db: TxDb = this.db) {
    const rows = await db
      .select({ code: facts.code })
      .from(facts)
      .where(eq(facts.entityId, entityId));
    let max = 0;
    for (const r of rows) max = Math.max(max, codeSeq(r.code));
    return buildFactCode(datasetCode, entityId, max + 1);
  }
}
