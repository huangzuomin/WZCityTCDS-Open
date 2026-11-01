import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../db/db.module';
import {
  categories,
  entities,
  entityAliases,
  entityArticles,
  entityRelations,
  extractionDrafts,
  extractionRuns,
  facts,
  graphNodes,
  relationRejectSamples,
  sourceArticles,
  systemSettings,
  validationResults,
} from '../../db/schema';
import { sha256 } from '../../common/crypto';
import { EvidenceService } from '../evidence/evidence.service';
import { FactService } from '../fact/fact.service';
import { EventService } from '../event/event.service';
import { EntityService } from '../entity/entity.service';
import { LlmConfigService } from '../llm-config/llm-config.service';
import { chat, type LlmCfg, type LlmUsage } from '../discovery/stages';
import { extractJson } from '../discovery/lexicon';
import type { ListDraftQuery } from './pipeline.dto';

/** 关系草稿（知识图谱的边）：头实体已存在；尾实体可以是新候选（tailEntityId 为空） */
interface RelationDraftPayload {
  kind: 'relation';
  headEntityId: number;
  headEntityName: string;
  predicate: string;
  predicateRaw?: string | null;
  tailEntityId: number | null;
  tailText: string;
  tailType?: string | null;
  statement: string;
  confidence: number;
  /** 边来源：fact = 事实→图谱派生（stageFactRelations）；缺省 llm = 正文关系抽取 */
  origin?: 'fact' | 'llm';
  articleId: number;
  publishedAt: string | null;
  fromModels?: string[];
  evidence: {
    quote: string;
    spanStart: number;
    spanEnd: number;
    qualityGrade: 'A' | 'B' | 'C' | 'D';
    batch: 'baseline' | 'incremental';
  };
}

interface DraftPayload {
  kind: 'fact' | 'event';
  entityId: number;
  entityName: string;
  dimension: string;
  statement: string;
  confidence: number;
  risk?: string | null;
  articleId: number;
  publishedAt: string | null;
  timeText?: string | null;
  evidence: {
    quote: string;
    spanStart: number;
    spanEnd: number;
    qualityGrade: 'A' | 'B' | 'C' | 'D';
    batch: 'baseline' | 'incremental';
  };
}

/**
 * 草稿审核与应用。
 *
 * 历史说明：这里原本还承载「实体驱动抽取管线」（按预置实体 + article_hit 配对跑 extraction_run），
 * 该旧管线（瓯菜专用）已删除。现在抽取统一由「生产线」菜单的 discovery 管线负责
 * （oucai.news 入队 → 实体发现 → 入库审核 → 对齐 → 事实/事件草稿），本服务只负责：
 * 草稿查询 / 人工审核应用 / 批量与阈值自动审核。
 */
@Injectable()
export class PipelineService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly evidenceService: EvidenceService,
    private readonly factService: FactService,
    private readonly eventService: EventService,
    private readonly entityService: EntityService,
    private readonly llmConfigService: LlmConfigService,
  ) {}

  // ---------------------------------------------------------------- 草稿审核

  async listDrafts(query: ListDraftQuery) {
    // 按语料域过滤时，先把该语料域下的所有 runId 取出来，再用 inArray 约束草稿
    let runIds: number[] | undefined;
    if (query.datasetId) {
      const runs = await this.db
        .select({ id: extractionRuns.id })
        .from(extractionRuns)
        .where(eq(extractionRuns.datasetId, query.datasetId));
      runIds = runs.map((r) => r.id);
    }
    const where = and(
      query.runId ? eq(extractionDrafts.runId, query.runId) : undefined,
      query.entityId ? eq(extractionDrafts.entityId, query.entityId) : undefined,
      runIds ? inArray(extractionDrafts.runId, runIds) : undefined,
      query.status ? eq(extractionDrafts.status, query.status) : undefined,
      query.targetType ? eq(extractionDrafts.targetType, query.targetType) : undefined,
    );
    const [{ value: total }] = await this.db
      .select({ value: count() })
      .from(extractionDrafts)
      .where(where);
    const rows = await this.db
      .select()
      .from(extractionDrafts)
      .where(where)
      .orderBy(desc(extractionDrafts.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const ids = rows.map((r) => r.id);
    const issues = ids.length
      ? await this.db
          .select()
          .from(validationResults)
          .where(and(eq(validationResults.targetType, 'extraction_draft'), inArray(validationResults.targetId, ids)))
      : [];
    const byTarget = new Map<number, typeof issues>();
    for (const i of issues) {
      const list = byTarget.get(i.targetId as number) ?? [];
      list.push(i);
      byTarget.set(i.targetId as number, list);
    }

    // 补充实体名与来源文章（发现管线的草稿把 articleId 放在 payloadJson 里）
    const entityIds = [...new Set(rows.map((r) => r.entityId).filter((v): v is number => v != null))];
    const artIds = [
      ...new Set(
        rows
          .map((r) => Number((r.payloadJson as Record<string, unknown> | null)?.articleId))
          .filter((v) => Number.isFinite(v) && v > 0),
      ),
    ];
    const entRows = entityIds.length
      ? await this.db.select({ id: entities.id, name: entities.name }).from(entities).where(inArray(entities.id, entityIds))
      : [];
    const artRows = artIds.length
      ? await this.db
          .select({ id: sourceArticles.id, title: sourceArticles.title, url: sourceArticles.url })
          .from(sourceArticles)
          .where(inArray(sourceArticles.id, artIds))
      : [];
    const entName = new Map(entRows.map((e) => [e.id, e.name]));
    const artMap = new Map(artRows.map((a) => [a.id, a]));

    return {
      items: rows.map((r) => {
        const p = (r.payloadJson ?? {}) as Record<string, unknown>;
        const art = artMap.get(Number(p.articleId));
        return {
          ...r,
          entityName: (p.entityName as string) ?? (r.entityId ? (entName.get(r.entityId) ?? null) : null),
          articleTitle: art?.title ?? null,
          articleUrl: art?.url ?? null,
          validation: byTarget.get(r.id) ?? [],
        };
      }),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async approveDraft(
    id: number,
    patch: {
      statement?: string;
      confidence?: number;
      dimension?: string;
      resolution?: 'adopt_new' | 'keep_old' | 'coexist';
      note?: string | null;
    },
    userId?: number,
  ) {
    const [draft] = await this.db
      .select()
      .from(extractionDrafts)
      .where(eq(extractionDrafts.id, id))
      .limit(1);
    if (!draft) throw new NotFoundException('草稿不存在');
    if (draft.status !== 'pending') throw new BadRequestException('该草稿已审核');

    const payload = draft.payloadJson as unknown as DraftPayload;

    // ---- 关系草稿（知识图谱的边）：尾实体允许是新候选，通过时按需建实体 ----
    if ((draft.payloadJson as { kind?: string } | null)?.kind === 'relation') {
      return this.approveRelationDraft(id, draft.payloadJson as unknown as RelationDraftPayload, userId);
    }

    // 实体-文章关联（档案页「基线/增量/相关报道」统计与新闻列表的数据源）
    if (payload.articleId) {
      await this.db
        .insert(entityArticles)
        .values({ entityId: payload.entityId, articleId: payload.articleId, role: 'reference' })
        .onDuplicateKeyUpdate({ set: { isRelevant: true } });
    }

    // 先建证据（span 锚点 + 引句逐字回查），再写事实
    const evidence = await this.evidenceService.create(
      {
        entityId: payload.entityId,
        articleId: payload.articleId,
        quote: payload.evidence.quote,
        spanStart: payload.evidence.spanStart,
        spanEnd: payload.evidence.spanEnd,
        qualityGrade: payload.evidence.qualityGrade,
        batch: payload.evidence.batch,
        origin: 'llm',
        status: 'active',
        publishedAt: payload.publishedAt,
      },
      userId,
    );

    if (payload.kind === 'event') {
      await this.eventService.create(
        {
          entityId: payload.entityId,
          eventType: patch.dimension ?? payload.dimension,
          timeText: (payload as unknown as { timeText?: string }).timeText ?? payload.publishedAt ?? '未知',
          timePrecision: (payload as unknown as { timePrecision?: 'dynasty' | 'decade' | 'year' | 'month' | 'day' }).timePrecision,
          timeStart: (payload as unknown as { timeStart?: string }).timeStart ?? undefined,
          timeEnd: (payload as unknown as { timeEnd?: string }).timeEnd ?? undefined,
          subject: payload.entityName,
          description: patch.statement ?? payload.statement,
          quote: payload.evidence.quote,
          articleId: payload.articleId,
          evidenceIds: [evidence.id],
          origin: 'llm',
          status: 'active',
          allowMismatch: true,
        },
        userId,
      );
    } else {
      const dimension = patch.dimension ?? payload.dimension;
      // 冲突检测：同实体+同维度已有现行事实（active / 仲裁中 / 待复核）
      const [existingFact] = await this.db
        .select({ id: facts.id, code: facts.code, version: facts.version, status: facts.status })
        .from(facts)
        .where(
          and(
            eq(facts.entityId, payload.entityId),
            eq(facts.dimension, dimension),
            inArray(facts.status, ['active', 'pending_arbitration', 'pending_review']),
          ),
        )
        .orderBy(desc(facts.version))
        .limit(1);

      const base = {
        entityId: payload.entityId,
        dimension,
        statement: patch.statement ?? payload.statement,
        factType: 'source_claim' as const,
        confidence: patch.confidence ?? payload.confidence,
        // 时间语义分离：首建/核验取「系统入库时刻」（create 内默认 today()），
        // 不再沿用文章发布日（发布日只留在证据/来源文章上）。
        origin: 'llm' as const,
        evidenceIds: [evidence.id],
        articleId: payload.articleId,
        suppressChange: false,
        skipSupersede: false,
      };

      if (!existingFact) {
        // 无冲突：直接生效
        await this.factService.create({ ...base, status: 'active' }, userId);
      } else if (!patch.resolution || patch.resolution === 'adopt_new') {
        // 无显式决议：交由归并裁决器判定取代/并列/追加，变化文案与 change_type
        // 由 applyAdjudicated 按 verdict 生成，这里不预设"采纳新版"文案（否则 coexist 会被说成更新）。
        await this.factService.create({ ...base, status: 'active' }, userId);
      } else if (patch.resolution === 'keep_old') {
        // 保留旧版：新草稿作 superseded 备查，不覆盖现行
        await this.factService.create(
          {
            ...base,
            status: 'superseded',
            skipSupersede: true,
            arbitrationNote: patch.note ?? null,
            changeSummary: `冲突裁决·保留旧版，新版作废：${dimension}`,
          },
          userId,
        );
      } else {
        // coexist：两者均生效，附裁决说明
        await this.factService.create(
          {
            ...base,
            status: 'active',
            skipSupersede: true,
            arbitrationNote: patch.note ?? null,
            changeSummary: `冲突裁决·多流派并存：${dimension}`,
          },
          userId,
        );
      }
    }

    await this.db
      .update(extractionDrafts)
      .set({ status: 'approved', reviewedBy: userId ?? null, reviewedAt: new Date() })
      .where(eq(extractionDrafts.id, id));

    return { approved: true, id, evidenceId: evidence.id };
  }

  /**
   * 关系草稿审核入图：
   * 1) 建证据（引句锚点，挂头实体）
   * 2) 头/尾实体：库内已有（同名/别名）→ 复用；尾端**未命中实体**时不再建草稿实体，
   *    改在节点层建概念节点（graph_node.node_type=concept），边只记 tailNodeId + tailText
   * 3) 入边：同 head+predicate+tail 已有 active 边 → corroborateCount+1；否则新建 active 边
   */
  /**
   * 并发写入复用：同一关系（头实体）的「查现有 → 判重复/新建」跑在事务 + 行锁里，
   * 避免并发批准同一条关系草稿时各自都查不到现有边而重复插入（与事实层同款竞态）。
   * 多路并发插入同一节点索引可能触发死锁（ER_LOCK_DEADLOCK, errno 1213），这里事务级重试。
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

  private async approveRelationDraft(id: number, rp: RelationDraftPayload, userId?: number) {
    // 硬性拦截降级草稿：判别式验证未通过 / schema 校验未通过的关系，禁止在「批准/入库」入口落图。
    // 这类草稿置信度已被压制（≤0.4）且带 verifyFailed 标记，无论自动批还是人工批都不放行，
    // 需重新抽取/重新验证后才能入库。
    const flags = rp as unknown as { verifyFailed?: boolean; schemaGateFail?: boolean };
    if (flags.verifyFailed || flags.schemaGateFail) {
      throw new BadRequestException(
        `关系草稿 #${id} 未通过验证（${flags.schemaGateFail ? 'schema 校验' : '判别式验证'}），拒绝入库，请重新抽取`,
      );
    }
    const tailEntityId = rp.tailEntityId ?? (await this.resolveTailEntityId(rp));
    // 实体 id 级自环防护：head 与 tail 被归一解析成同一实体时（如「温州菜又称瓯菜」→ 两者都指向瓯菜），
    // 这条边是冗余自环（head=tail），不该落图。显示名不同但解析后同 id 也会被这里拦下。
    if (tailEntityId != null && tailEntityId === rp.headEntityId) {
      return;
    }
    // 跨 run 反向去重：同对实体 + 同归一谓词已存在 active 反向边 → 这是一致事实的反向重复
    // （如 酒店-举办->活动 与 活动-举行->酒店，两者谓词归一后都是 举办），无论是否同一批产出都合并。
    if (tailEntityId != null) {
      const [rev] = await this.db
        .select({ id: entityRelations.id })
        .from(entityRelations)
        .where(
          and(
            eq(entityRelations.headEntityId, tailEntityId),
            eq(entityRelations.tailEntityId, rp.headEntityId),
            eq(entityRelations.predicate, rp.predicate),
            eq(entityRelations.status, 'active'),
          ),
        )
        .limit(1);
      if (rev) return;
    }
    const evidence = await this.evidenceService.create(
      {
        entityId: rp.headEntityId,
        articleId: rp.articleId,
        quote: rp.evidence.quote,
        spanStart: rp.evidence.spanStart,
        spanEnd: rp.evidence.spanEnd,
        qualityGrade: rp.evidence.qualityGrade,
        batch: rp.evidence.batch,
        origin: 'llm',
        status: 'active',
        publishedAt: rp.publishedAt,
      },
      userId,
    );

    const [head] = await this.db
      .select({ originDatasetId: entities.originDatasetId })
      .from(entities)
      .where(eq(entities.id, rp.headEntityId))
      .limit(1);
    if (!head) throw new NotFoundException('关系头实体不存在');

    // v2：关系归属语料域 = 该关系草稿来源文章的语料域；无文章时回落头实体的溯源域
    let relDatasetId: number | null = head.originDatasetId;
    if (rp.articleId != null) {
      const [art] = await this.db
        .select({ datasetId: sourceArticles.datasetId })
        .from(sourceArticles)
        .where(eq(sourceArticles.id, rp.articleId))
        .limit(1);
      if (art) relDatasetId = Number(art.datasetId);
    }
    if (relDatasetId == null) throw new NotFoundException('关系头实体缺少溯源语料域，无法归属关系');

    // 节点层：实体端镜像进 graph_node；尾端未命中实体则建概念节点
    const headNodeId = await this.ensureEntityNode(rp.headEntityId, rp.headEntityName, relDatasetId);
    const tailNodeId = tailEntityId
      ? await this.ensureEntityNode(tailEntityId, rp.tailText, relDatasetId)
      : await this.ensureConceptNode(rp.tailText, relDatasetId, rp.tailType ?? null, rp.articleId ?? null);

    const dedupeKey = sha256(`relation|${rp.headEntityId}|${rp.predicate}|${rp.tailText}|${tailEntityId ?? ''}`);

    // 并发一致性：锁住头实体行，把「查现有 → 判重复/新建」原子化。否则并发批准同一条
    // 关系草稿会各自都查不到现有边而重复插入（同一头实体的多条边并发入库时，同 head+predicate+tail
    // 会撞出多条 active 边）。证据/节点的创建在锁外（各自幂等），此处只串行化边本身的写入。
    const relationId = await this.withLockRetry(() =>
      this.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM ${entities} WHERE id = ${rp.headEntityId} FOR UPDATE`);

        const [existing] = await tx
          .select()
          .from(entityRelations)
          .where(
            and(
              eq(entityRelations.datasetId, relDatasetId),
              eq(entityRelations.headEntityId, rp.headEntityId),
              eq(entityRelations.predicate, rp.predicate),
              tailEntityId ? eq(entityRelations.tailEntityId, tailEntityId) : eq(entityRelations.tailText, rp.tailText),
              eq(entityRelations.status, 'active'),
            ),
          )
          .limit(1);

        if (existing) {
          await tx
            .update(entityRelations)
            .set({
              corroborateCount: existing.corroborateCount + 1,
              confidence:
                Number(existing.confidence) >= Number(rp.confidence ?? 0.85)
                  ? existing.confidence
                  : String(rp.confidence ?? 0.85),
              lastVerifiedAt: new Date(),
              evidenceId: evidence.id,
              // 旧边顺带补节点层引用（渐进迁移，避免全表回填）
              headNodeId: existing.headNodeId ?? headNodeId,
              tailNodeId: existing.tailNodeId ?? tailNodeId,
            })
            .where(eq(entityRelations.id, existing.id));
          return existing.id;
        }

        const [ins] = await tx.insert(entityRelations).values({
          datasetId: relDatasetId,
          headEntityId: rp.headEntityId,
          predicate: rp.predicate,
          predicateRaw: rp.predicateRaw ?? null,
          tailEntityId,
          tailText: rp.tailText,
          tailType: rp.tailType ?? null,
          headNodeId,
          tailNodeId,
          statement: rp.statement ?? `${rp.headEntityName} ${rp.predicate} ${rp.tailText}`,
          confidence: String(rp.confidence ?? 0.85),
          status: 'active',
          version: 1,
          corroborateCount: 1,
          // 事实→图谱派生的边标 origin=fact（其余走 LLM 抽取/人工/导入）
          origin: rp.origin === 'fact' ? 'fact' : 'llm',
          articleId: rp.articleId,
          evidenceId: evidence.id,
          dedupeKey,
          // 首见 = 系统入库知悉时刻（不再取文章发布日）；最近核验 = 本次入图时刻
          firstSeenAt: new Date(),
          lastVerifiedAt: new Date(),
        });
        return Number(ins.insertId);
      }),
    );

    await this.db
      .update(extractionDrafts)
      .set({ status: 'approved', reviewedBy: userId ?? null, reviewedAt: new Date() })
      .where(eq(extractionDrafts.id, id));

    return { approved: true, id, relationId, tailEntityId, evidenceId: evidence.id };
  }

  /** 尾实体解析：库内同名/别名 → 复用；未命中返回 null（交由概念节点承接） */
  private async resolveTailEntityId(rp: RelationDraftPayload): Promise<number | null> {
    const name = (rp.tailText ?? '').trim();
    if (!name) return null;

    const [byName] = await this.db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.name, name), isNull(entities.deletedAt)))
      .limit(1);
    if (byName) return byName.id;

    const [byAlias] = await this.db
      .select({ entityId: entityAliases.entityId })
      .from(entityAliases)
      .innerJoin(entities, eq(entities.id, entityAliases.entityId))
      .where(and(eq(entityAliases.alias, name), isNull(entities.deletedAt)))
      .limit(1);
    if (byAlias) return byAlias.entityId;

    // 未命中实体：不再新建「草稿实体」，由 ensureConceptNode 建概念节点
    return null;
  }

  /** 实体在图谱节点层的镜像节点（node_type=entity）：幂等 upsert，返回 graph_node.id */
  private async ensureEntityNode(entityId: number, name: string, datasetId: number): Promise<number | null> {
    const label = (name ?? '').trim();
    if (!label) return null;
    const [exist] = await this.db
      .select({ id: graphNodes.id })
      .from(graphNodes)
      .where(and(eq(graphNodes.entityId, entityId), eq(graphNodes.datasetId, datasetId)))
      .limit(1);
    if (exist) return exist.id;
    try {
      // 同名概念节点存在时升级为实体节点（同名即同一节点）
      await this.db
        .insert(graphNodes)
        .values({ datasetId, name: label, nodeType: 'entity', entityId })
        .onDuplicateKeyUpdate({ set: { entityId, nodeType: 'entity' } });
      const [row] = await this.db
        .select({ id: graphNodes.id })
        .from(graphNodes)
        .where(and(eq(graphNodes.datasetId, datasetId), eq(graphNodes.entityId, entityId)))
        .limit(1);
      return row?.id ?? null;
    } catch {
      return null;
    }
  }

  /** 概念节点（node_type=concept）：尾端未命中实体时创建，同名复用；返回 graph_node.id */
  private async ensureConceptNode(
    name: string,
    datasetId: number,
    categoryCode: string | null,
    articleId: number | null,
  ): Promise<number | null> {
    const label = (name ?? '').trim();
    if (!label) return null;
    const [exist] = await this.db
      .select({ id: graphNodes.id, nodeType: graphNodes.nodeType })
      .from(graphNodes)
      .where(and(eq(graphNodes.datasetId, datasetId), eq(graphNodes.name, label)))
      .limit(1);
    if (exist) return exist.nodeType === 'concept' ? exist.id : null;
    try {
      await this.db
        .insert(graphNodes)
        .values({
          datasetId,
          name: label,
          nodeType: 'concept',
          categoryCode,
          sourceArticleId: articleId,
        })
        .onDuplicateKeyUpdate({ set: { name: label } });
      const [row] = await this.db
        .select({ id: graphNodes.id })
        .from(graphNodes)
        .where(and(eq(graphNodes.datasetId, datasetId), eq(graphNodes.name, label)))
        .limit(1);
      return row?.id ?? null;
    } catch {
      return null; // 建概念节点失败 → 边只保留 tailText 兜底
    }
  }

  async rejectDraft(id: number, reason: string | null, userId?: number) {
    const [draft] = await this.db
      .select()
      .from(extractionDrafts)
      .where(eq(extractionDrafts.id, id))
      .limit(1);
    if (!draft) throw new NotFoundException('草稿不存在');
    await this.db
      .update(extractionDrafts)
      .set({
        status: 'rejected',
        reviewedBy: userId ?? null,
        reviewedAt: new Date(),
        payloadJson: { ...(draft.payloadJson as object), rejectReason: reason ?? null } as Record<string, unknown>,
      })
      .where(eq(extractionDrafts.id, id));
    // 关系驳回 → 落拒绝样本表（供验证器 few-shot 反例）
    if ((draft.payloadJson as { kind?: string } | null)?.kind === 'relation') {
      await this.recordRelationRejectSample(draft, reason).catch(() => undefined);
    }
    return { rejected: true, id };
  }

  /** 关系驳回样本落库：claimHash 防同一断言重复刷表 */
  private async recordRelationRejectSample(
    draft: typeof extractionDrafts.$inferSelect,
    reason: string | null,
  ): Promise<void> {
    const p = (draft.payloadJson ?? {}) as {
      headEntityName?: string;
      predicate?: string;
      tailText?: string;
      evidence?: { quote?: string };
      articleId?: number;
    };
    const head = String(p.headEntityName ?? '').trim();
    const predicate = String(p.predicate ?? '').trim();
    const tail = String(p.tailText ?? '').trim();
    const quote = String(p.evidence?.quote ?? '').trim();
    if (!head || !predicate || !tail) return;
    let datasetId = 0;
    const articleId = Number(p.articleId ?? 0);
    if (articleId) {
      const [art] = await this.db
        .select({ datasetId: sourceArticles.datasetId })
        .from(sourceArticles)
        .where(eq(sourceArticles.id, articleId))
        .limit(1);
      datasetId = Number(art?.datasetId ?? 0);
    }
    const claimHash = sha256(`${datasetId}|${head}|${predicate}|${tail}|${quote}`);
    await this.db
      .insert(relationRejectSamples)
      .values({
        datasetId,
        articleId: articleId || null,
        head,
        predicate,
        tail,
        quote: quote || null,
        reason: reason ? String(reason).slice(0, 500) : null,
        claimHash,
      })
      .onDuplicateKeyUpdate({ set: { reason: reason ? String(reason).slice(0, 500) : null } });
  }

  async batchReview(ids: number[], action: 'approve' | 'reject', reason: string | null, userId?: number) {
    let ok = 0;
    const failures: { id: number; message: string }[] = [];
    for (const id of ids) {
      try {
        if (action === 'approve') await this.approveDraft(id, {}, userId);
        else await this.rejectDraft(id, reason, userId);
        ok += 1;
      } catch (err) {
        failures.push({ id, message: (err as Error).message });
      }
    }
    return { total: ids.length, succeeded: ok, failures };
  }

  // ---------------------------------------------------------------- 大模型审批（关系草稿）

  /** 每批送审的草稿条数（控制单次调用体量，避免长 JSON 截断） */
  private readonly LLM_REVIEW_BATCH = 20;
  /** 单次审批上限，与 batchReview 一致 */
  private readonly LLM_REVIEW_MAX = 500;
  /** 后台审批任务状态（system_setting） */
  private readonly LLM_REVIEW_TASK_KEY = 'LLM_REVIEW_TASK';
  /** 审批任务状态：上次遗留 running 超过该时长视为僵死，允许重新发起 */
  private readonly LLM_REVIEW_STALE_MS = 12 * 3600_000;

  private async readLlmReviewTask(): Promise<{
    running: boolean;
    startedAt: string | null;
    finishedAt: string | null;
    status: 'idle' | 'running' | 'success' | 'error';
    total: number;
    processed: number;
    approved: number;
    rejected: number;
    revised: number;
    failures: { id: number; message: string }[];
    batches: number;
    model: string | null;
    error: string | null;
    rejectedList?: { id: number; reason: string }[];
    revisedList?: { id: number; detail: string }[];
    /** 本轮大模型审批快照的草稿 id 集（用于排除并发自动批准） */
    draftIds?: number[];
  }> {
    const [row] = await this.db.select().from(systemSettings).where(eq(systemSettings.skey, this.LLM_REVIEW_TASK_KEY)).limit(1);
    if (!row) {
      return { running: false, startedAt: null, finishedAt: null, status: 'idle', total: 0, processed: 0, approved: 0, rejected: 0, revised: 0, failures: [], batches: 0, model: null, error: null, rejectedList: [], revisedList: [], draftIds: [] };
    }
    try {
      return { running: false, startedAt: null, finishedAt: null, status: 'idle', total: 0, processed: 0, approved: 0, rejected: 0, revised: 0, failures: [], batches: 0, model: null, error: null, rejectedList: [], revisedList: [], draftIds: [], ...JSON.parse(row.svalue) };
    } catch {
      return { running: false, startedAt: null, finishedAt: null, status: 'idle', total: 0, processed: 0, approved: 0, rejected: 0, revised: 0, failures: [], batches: 0, model: null, error: null, rejectedList: [], revisedList: [], draftIds: [] };
    }
  }

  private async saveLlmReviewTask(s: Awaited<ReturnType<PipelineService['readLlmReviewTask']>>): Promise<void> {
    await this.db
      .insert(systemSettings)
      .values({ skey: this.LLM_REVIEW_TASK_KEY, svalue: JSON.stringify(s) })
      .onDuplicateKeyUpdate({ set: { svalue: JSON.stringify(s) } });
  }

  /** 发起大模型审批（后台执行）：running 中互斥；返回 immediately，进度走 GET llm-review/status */
  async startLlmReview(ids?: number[], userId?: number) {
    const st = await this.readLlmReviewTask();
    if (st.running && st.startedAt && Date.now() - new Date(st.startedAt).getTime() < this.LLM_REVIEW_STALE_MS) {
      return { accepted: false, message: '上一轮大模型审批仍在执行中，请等待完成或稍后再试', state: st };
    }
    const fresh = { running: true, startedAt: new Date().toISOString(), finishedAt: null, status: 'running' as const, total: 0, processed: 0, approved: 0, rejected: 0, revised: 0, failures: [] as { id: number; message: string }[], batches: 0, model: null as string | null, error: null as string | null };
    await this.saveLlmReviewTask(fresh);
    // 后台执行，请求立即返回；进度可轮询
    void this.runLlmReviewTask(ids, userId);
    return { accepted: true, state: fresh };
  }

  async llmReviewStatus() {
    return this.readLlmReviewTask();
  }

  /** 后台执行体：逐批调 LLM 裁决并落库，每批更新进度状态 */
  private async runLlmReviewTask(ids?: number[], userId?: number) {
    const commit = async (patch: Partial<Awaited<ReturnType<PipelineService['readLlmReviewTask']>>>) => {
      const cur = await this.readLlmReviewTask();
      await this.saveLlmReviewTask({ ...cur, ...patch });
    };
    try {
      const models = await this.llmConfigService.getProductionSettings();
      const [setting] = models; // 多条生产线：取第一个（id 升序）
      if (!setting) {
        await commit({ running: false, status: 'error', error: '未配置生产线文本模型（后台「大模型设置 → 文本模型」需至少一条启用并设为生产线）', finishedAt: new Date().toISOString() });
        return;
      }
      const cfg: LlmCfg = {
        baseUrl: setting.baseUrl,
        apiKey: setting.apiKey,
        model: setting.model,
        temperature: Number(setting.temperature ?? 0.1),
        maxTokens: setting.maxTokens ?? 2048,
      };

      const where = and(
        eq(extractionDrafts.targetType, 'relation'),
        eq(extractionDrafts.status, 'pending'),
        ids?.length ? inArray(extractionDrafts.id, ids) : undefined,
      );
      const drafts = await this.db
        .select()
        .from(extractionDrafts)
        .where(where)
        .orderBy(desc(extractionDrafts.id))
        .limit(this.LLM_REVIEW_MAX);
      if (!drafts.length) {
        await commit({ running: false, status: 'success', total: 0, model: setting.model, finishedAt: new Date().toISOString() });
        return;
      }
      await commit({ total: drafts.length, model: setting.model });

      const approved: number[] = [];
      const rejected: { id: number; reason: string }[] = [];
      const revised: { id: number; detail: string }[] = [];
      const failures: { id: number; message: string }[] = [];
      let promptTokens = 0;
      let completionTokens = 0;
      let batches = 0;

      for (let i = 0; i < drafts.length; i += this.LLM_REVIEW_BATCH) {
        const chunk = drafts.slice(i, i + this.LLM_REVIEW_BATCH);
        batches += 1;
        const verdicts = await this.llmReviewChunk(cfg, chunk);
        promptTokens += verdicts.promptTokens;
        completionTokens += verdicts.completionTokens;

        for (const v of verdicts.verdicts) {
          const draft = chunk[v.index];
          if (!draft) continue;
          if (v.verdict === 'approve') {
            try {
              await this.approveDraft(draft.id, {}, userId);
              approved.push(draft.id);
            } catch (err) {
              failures.push({ id: draft.id, message: (err as Error).message });
            }
          } else if (v.verdict === 'reject') {
            try {
              await this.rejectDraft(draft.id, v.reason ?? '大模型审批未通过', userId);
              rejected.push({ id: draft.id, reason: v.reason ?? '' });
            } catch (err) {
              failures.push({ id: draft.id, message: (err as Error).message });
            }
          } else if (v.verdict === 'revise') {
            try {
              await this.applyRelationRevision(draft, v, userId);
              revised.push({ id: draft.id, detail: v.reason ?? '' });
            } catch (err) {
              failures.push({ id: draft.id, message: (err as Error).message });
            }
          } else {
            failures.push({ id: draft.id, message: `LLM 返回非法裁决: ${v.verdict}` });
          }
        }
        // 每批完成后更新进度（前端轮询展示）
        await commit({ processed: i + chunk.length, approved: approved.length, rejected: rejected.length, revised: revised.length, failures, batches });
      }

      await commit({
        running: false,
        status: 'success',
        finishedAt: new Date().toISOString(),
        processed: drafts.length,
        approved: approved.length,
        rejected: rejected.length,
        revised: revised.length,
        failures,
        batches,
        rejectedList: rejected.slice(0, 8),
        revisedList: revised.slice(0, 8),
      });
      console.log(`[pipeline] 大模型审批完成：${approved.length}/${drafts.length} 通过，${revised.length} 纠偏，${rejected.length} 驳回，${failures.length} 失败（${batches} 批）`);
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[pipeline] 大模型审批任务失败：${msg}`);
      await commit({ running: false, status: 'error', error: msg, finishedAt: new Date().toISOString() });
    }
  }

  /** 大模型批量审批关系草稿（同步版，仅用于兼容历史调用；新入口用 startLlmReview） */
  async reviewRelationsWithLlm(ids?: number[], userId?: number) {
    const models = await this.llmConfigService.getProductionSettings();
    const [setting] = models; // 多条生产线：取第一个（id 升序）
    if (!setting) {
      throw new NotFoundException('未配置生产线文本模型（后台「大模型设置 → 文本模型」需至少一条启用并设为生产线）');
    }
    const cfg: LlmCfg = {
      baseUrl: setting.baseUrl,
      apiKey: setting.apiKey,
      model: setting.model,
      temperature: Number(setting.temperature ?? 0.1),
      maxTokens: setting.maxTokens ?? 2048,
    };

    const where = and(
      eq(extractionDrafts.targetType, 'relation'),
      eq(extractionDrafts.status, 'pending'),
      ids?.length ? inArray(extractionDrafts.id, ids) : undefined,
    );
    const drafts = await this.db
      .select()
      .from(extractionDrafts)
      .where(where)
      .orderBy(desc(extractionDrafts.id))
      .limit(this.LLM_REVIEW_MAX);
    if (!drafts.length) {
      return { total: 0, approved: 0, rejected: 0, revised: 0, failures: [], batches: 0, model: setting.model };
    }

    const approved: number[] = [];
    const rejected: { id: number; reason: string }[] = [];
    const revised: { id: number; detail: string }[] = [];
    const failures: { id: number; message: string }[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let batches = 0;

    for (let i = 0; i < drafts.length; i += this.LLM_REVIEW_BATCH) {
      const chunk = drafts.slice(i, i + this.LLM_REVIEW_BATCH);
      batches += 1;
      const verdicts = await this.llmReviewChunk(cfg, chunk);
      promptTokens += verdicts.promptTokens;
      completionTokens += verdicts.completionTokens;

      for (const v of verdicts.verdicts) {
        const draft = chunk[v.index];
        if (!draft) continue;
        if (v.verdict === 'approve') {
          try {
            await this.approveDraft(draft.id, {}, userId);
            approved.push(draft.id);
          } catch (err) {
            failures.push({ id: draft.id, message: (err as Error).message });
          }
        } else if (v.verdict === 'reject') {
          try {
            await this.rejectDraft(draft.id, v.reason ?? '大模型审批未通过', userId);
            rejected.push({ id: draft.id, reason: v.reason ?? '' });
          } catch (err) {
            failures.push({ id: draft.id, message: (err as Error).message });
          }
        } else if (v.verdict === 'revise') {
          try {
            await this.applyRelationRevision(draft, v, userId);
            revised.push({ id: draft.id, detail: v.reason ?? '' });
          } catch (err) {
            failures.push({ id: draft.id, message: (err as Error).message });
          }
        } else {
          failures.push({ id: draft.id, message: `LLM 返回非法裁决: ${v.verdict}` });
        }
      }
    }

    return {
      total: drafts.length,
      approved: approved.length,
      rejected: rejected.length,
      revised: revised.length,
      failures,
      batches,
      model: setting.model,
      settingName: setting.name,
      usage: { promptTokens, completionTokens },
      rejectedList: rejected,
      revisedList: revised,
    };
  }

  /** 单批 LLM 裁决：prompt 构造 → 调用 → 解析（JSON 非法时重试一次） */
  private async llmReviewChunk(
    cfg: LlmCfg,
    chunk: (typeof extractionDrafts.$inferSelect)[],
  ): Promise<{
    verdicts: {
      index: number;
      verdict: string;
      reason?: string;
      head?: string;
      predicate?: string;
      tail?: string;
      statement?: string;
    }[];
    promptTokens: number;
    completionTokens: number;
  }> {
    const list = chunk
      .map((d, idx) => {
        const p = (d.payloadJson ?? {}) as {
          headEntityName?: string;
          predicate?: string;
          tailText?: string;
          statement?: string;
          confidence?: number;
          evidence?: { quote?: string };
        };
        return `${idx + 1}. [${p.headEntityName ?? ''}] —${(p.predicate ?? '').replace('rel_', '')}→ [${p.tailText ?? ''}]\n   陈述：${p.statement ?? ''}\n   置信度：${p.confidence ?? '-'}\n   引句：“${p.evidence?.quote ?? ''}”`;
      })
      .join('\n');

    const prompt = `你是知识图谱关系的审核员。下面每一条是一条「关系草稿」（头实体 —谓词→ 尾实体），附模型抽取的置信度与引句。

${list}

请逐条判定（四选一）：
- approve：关系成立、方向正确（head 是主语/主体，谓词方向与引句一致）、谓词与两端实体类型匹配（奖项/活动类实体不应「位于」地点；机构不应是「主办」的宾语——正确的应是「机构 主办 奖项」）、引句能直接读出该关系
- revise：关系本身成立且引句可证，但存在可修正的瑕疵——最常见是「方向颠倒」（head 与 tail 应互换，如抽成了「赛事 举行 龙湾」，正确应为「龙湾 举行 赛事」，即地点/主办方作 head、赛事/活动作 tail），或谓词不贴切但可改为更准确的说法。修正时必须同时给出 head / predicate / tail，且 head 与 tail 都必须逐字出现在引句中，不要发明引句里没有的名词
- reject：关系不成立、引句读不出关系、两端只是并列共现没有实际关系、陈述与引句矛盾、或修正后仍无法成立（例如引句根本不支持该关系）
- 说明：若关系成立且方向/谓词都正确，必须选 approve 而不是 revise

【要求】
1. 每条都必须给出裁决，输出严格 JSON，不要输出任何解释文字
2. reason 必填（简短中文）：approve 写「成立」；reject 写拒绝原因；revise 写修正说明（如「方向颠倒：应是「龙湾 举行 赛事」」）
3. revise 必须给出 head / predicate / tail（修正后的完整三元组，head 与 tail 逐字来自引句），statement 可选（修正后的完整陈述句）
4. 置信度低但方向/类型正确、引句成立的，按 approve 处理（宁宽勿误杀）

{"verdicts":[{"i":1,"verdict":"approve","reason":"成立"},{"i":2,"verdict":"revise","reason":"方向颠倒：应是「龙湾 举行 赛事」","head":"龙湾","predicate":"举行","tail":"赛事","statement":"龙湾 举行 赛事"},{"i":3,"verdict":"reject","reason":"引句读不出该关系"}]}`;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const r = await chat(cfg, attempt === 1 ? prompt : prompt + '\n\n注意：上次输出不是合法 JSON，请只输出上面要求的 JSON 结构，不要夹带解释。');
      if (r.error) throw new Error(`LLM 调用失败: ${r.error}`);
      const raw = (r.content ?? '').trim();
      try {
        const obj = extractJson<{
          verdicts?: {
            i: number;
            verdict: string;
            reason?: string;
            head?: string;
            predicate?: string;
            tail?: string;
            statement?: string;
          }[];
        }>(raw);
        const verdicts = (obj.verdicts ?? []).map((v) => ({
          index: Math.max(0, Math.min(chunk.length - 1, Math.round(Number(v.i)) - 1)),
          verdict: String(v.verdict ?? '').trim().toLowerCase(),
          reason: v.reason ? String(v.reason).trim().slice(0, 300) : undefined,
          head: v.head ? String(v.head).trim() : undefined,
          predicate: v.predicate ? String(v.predicate).trim() : undefined,
          tail: v.tail ? String(v.tail).trim() : undefined,
          statement: v.statement ? String(v.statement).trim().slice(0, 500) : undefined,
        }));
        if (verdicts.length) {
          return { verdicts, promptTokens: r.usage?.promptTokens ?? 0, completionTokens: r.usage?.completionTokens ?? 0 };
        }
      } catch {
        /* 重试一次 */
      }
    }
    throw new Error('LLM 返回内容解析失败');
  }

  /** revise 纠偏：用 LLM 修正后的三元组覆盖草稿 payload 后直接通过入库 */
  private async applyRelationRevision(
    draft: typeof extractionDrafts.$inferSelect,
    v: { head?: string; predicate?: string; tail?: string; statement?: string },
    userId?: number,
  ) {
    const p = (draft.payloadJson ?? {}) as unknown as RelationDraftPayload;
    const quote = p.evidence?.quote ?? '';
    const newHead = (v.head ?? '').trim() || p.headEntityName;
    const newPredicate = (v.predicate ?? '').trim() || p.predicate;
    const newTail = (v.tail ?? '').trim() || p.tailText;
    if (!newHead || !newTail) throw new BadRequestException('纠偏缺少 head 或 tail');

    // 程序化兜底：head / tail 必须逐字出现在引句中，防止模型发明引句里没有的名词
    if (quote) {
      if (!quote.includes(newHead)) throw new BadRequestException(`修正 head「${newHead}」未逐字出现在引句中`);
      if (!quote.includes(newTail)) throw new BadRequestException(`修正 tail「${newTail}」未逐字出现在引句中`);
    }

    // head 名变化时重新解析实体 ID（head 必须是已存在实体，不能新建）
    const [headRow] = await this.db
      .select({ id: entities.id, originDatasetId: entities.originDatasetId })
      .from(entities)
      .where(eq(entities.id, p.headEntityId))
      .limit(1);
    if (!headRow) throw new NotFoundException('关系头实体不存在');
    let headEntityId = p.headEntityId;
    if (newHead !== p.headEntityName) {
      headEntityId = (await this.resolveHeadEntityIdByName(headRow.originDatasetId ?? 0, newHead)) ?? 0;
      if (!headEntityId) throw new BadRequestException(`修正 head「${newHead}」在库中无对应实体，无法入图`);
    }

    const updated: RelationDraftPayload = {
      ...p,
      headEntityId,
      headEntityName: newHead,
      predicate: newPredicate,
      tailText: newTail,
      tailEntityId: null, // 交给 resolveTailEntityId 按新 tailText 重新解析/新建
      statement: (v.statement ?? '').trim() || `${newHead} ${newPredicate} ${newTail}`,
    };
    await this.db
      .update(extractionDrafts)
      .set({ payloadJson: updated as unknown as Record<string, unknown> })
      .where(eq(extractionDrafts.id, draft.id));
    await this.approveDraft(draft.id, {}, userId);
  }

  /** 按名称/别名解析库内实体 ID（head 纠偏用，只允许命中已存在实体；v2 全局查重） */
  private async resolveHeadEntityIdByName(datasetId: number, name: string): Promise<number | null> {
    const n = name.trim();
    const [byName] = await this.db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.name, n), isNull(entities.deletedAt)))
      .limit(1);
    if (byName) return byName.id;
    const [byAlias] = await this.db
      .select({ entityId: entityAliases.entityId })
      .from(entityAliases)
      .innerJoin(entities, eq(entities.id, entityAliases.entityId))
      .where(and(eq(entityAliases.alias, n), isNull(entities.deletedAt)))
      .limit(1);
    return byAlias?.entityId ?? null;
  }

  /**
   * 置信度阈值自动审核：pending 的 fact 草稿，confidence >= threshold 且基本完整 → 自动 approve，
   * 其余保留 pending 等人工。幂等：已审核草稿会被 approveDraft 拒绝而跳过。
   */
  async autoReviewHighConfidence(threshold = 0.9, userId?: number) {
    const drafts = await this.db
      .select()
      .from(extractionDrafts)
      .where(and(eq(extractionDrafts.targetType, 'fact'), eq(extractionDrafts.status, 'pending')));
    const approveIds: number[] = [];
    const blocked: { id: number; confidence: number; dimension: string | null }[] = [];
    for (const d of drafts) {
      const p = (d.payloadJson ?? {}) as {
        confidence?: number | string;
        statement?: string;
        dimension?: string;
        evidence?: { quote?: string };
      };
      const conf = Number(p.confidence ?? 0);
      const quote = (p.evidence?.quote ?? '').trim();
      if (conf >= threshold && p.statement?.trim() && quote.length >= 4) {
        approveIds.push(d.id);
      } else {
        blocked.push({ id: d.id, confidence: conf, dimension: p.dimension ?? null });
      }
    }
    let autoApproved = 0;
    let failures: { id: number; message: string }[] = [];
    if (approveIds.length) {
      const res = await this.batchReview(approveIds, 'approve', null, userId);
      autoApproved = res.succeeded;
      failures = res.failures;
    }
    return { threshold, total: drafts.length, autoApproved, blocked: blocked.length, failures, blockedList: blocked };
  }
}
