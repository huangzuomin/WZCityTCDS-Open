import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, like, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { DRIZZLE, type Db } from '../../db/db.module';
import { linkedCategoryIds } from '../../common/dataset-categories';
import {
  categories,
  datasetCategories,
  datasets,
  entities,
  entityArticles,
  entityRelations,
  evidences as evidence,
  extractionDrafts,
  extractionRuns,
  factChanges,
  factEvidences,
  factTopics,
  facts,
  sourceArticleBodies,
  sourceArticles,
  events,
  topicAliases,
  topics,
  users,
} from '../../db/schema';
import { CacheService } from '../../common/cache.service';
import { isPublishableKeyStat, metricKindOf, todayInShanghai } from '@ssot/shared';
import { FactService, applicabilityOf } from '../fact/fact.service';
import { EventService } from '../event/event.service';
import { EvidenceService } from '../evidence/evidence.service';
import { GraphService, type EntityGraph, type GraphEdge, type GraphNode } from '../graph/graph.service';
import {
  renderArchiveHtml,
  renderArticleFactsHtml,
  renderChangeHtml,
  renderFactHtml,
  renderSiteHomeHtml,
} from './archive-html';
import { renderTopicFactSheetHtml } from './topic-factsheet';
import { publishGateEnabled, publicFactSql, publicTopicSql } from './public-scope';
import { evidenceIndependence } from './evidence-independence';

/** XML/HTML 转义（feed.xml 用） */
const esc = (v: unknown) =>
  String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/**
 * 日期列（DATE / DATETIME）→ `YYYY-MM-DD`。
 * raw SQL 取回的时间列既可能是 Date 对象（DATE 列）也可能是字符串，两种都要正确处理，
 * 否则前端 `String(date).slice(0,10)` 会得到 "Wed Sep 30" 这类英文周几。
 */
const dayOnly = (v: unknown): string | null => {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

/**
 * 由现行事实生成导语：取置信度最高的 active 事实陈述（超长截断）。
 * 人工维护的 entities.lede 降为兜底——导语应随事实库更新而更新，而非停留在静态元数据。
 */
const pickLede = (list: unknown[]): string | null => {
  const actives = list
    .map((r) => r as Record<string, unknown>)
    .filter((f) => f.status === 'active' && typeof f.statement === 'string' && (f.statement as string).trim());
  if (!actives.length) return null;
  actives.sort((a, b) => Number(b.confidence ?? 0) - Number(a.confidence ?? 0));
  const s = String(actives[0].statement).trim();
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
};

export interface ArchivePage {
  entity: {
    id: number;
    urn: string;
    name: string;
    slug: string;
    lede: string | null;
    seedSource: string | null;
    attrsJson: Record<string, unknown> | null;
    status: string;
    revision: number;
    publishedAt: Date | null;
    /** v2：实体溯源语料域（可空 = 纯全局实体） */
    datasetId: number | null;
    datasetCode: string | null;
    datasetName: string | null;
    categoryId: number;
    categoryName: string | null;
    /** 类别编码（实体属性细填充：schema 类型映射依据） */
    categoryCode: string | null;
  };
  dimensions: unknown[];
  stats: Record<string, number>;
  facts: unknown[];
  superseded: unknown[];
  changes: unknown[];
  events: unknown[];
  evidence: unknown[];
  articles: unknown[];
  coverage: { earliest: string | null; latest: string | null };
  /** 以该实体为中心的一跳知识图谱（实时查询，不进档案缓存） */
  graph?: EntityGraph;
  generatedAt: string;
  cached: boolean;
}

@Injectable()
export class ArchiveService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly factService: FactService,
    private readonly eventService: EventService,
    private readonly evidenceService: EvidenceService,
    private readonly graphService: GraphService,
  ) {}

  /** 动态路由 /archive/:dataset/:slug 的整页数据；缓存 key = archive:{entityId}:{revision} */
  async page(datasetCode: string, slug: string): Promise<ArchivePage> {
    const entity = await this.resolveEntity(datasetCode, slug);
    const cacheKey = `archive:${entity.id}:${entity.revision}`;
    const cached = await this.cache.get<ArchivePage>(cacheKey);
    // 图谱不进整页缓存：关系审核后立刻生效（一跳查询很轻）
    if (cached) {
      return {
        ...cached,
        graph: await this.graphService.entityGraph(entity.id, { depth: 1 }),
        cached: true,
      };
    }

    const [{ current, superseded }, changes, timeline, chain, articles, dims] = await Promise.all([
      this.factService.fullBoard(entity.id),
      this.factService.listChanges(entity.id, 50),
      this.eventService.timeline(entity.id),
      this.evidenceService.chain(entity.id),
      this.articles(entity.id),
      this.factService.listDimensions(),
    ]);

    const [factStat] = await this.db
      .select({
        total: count(),
        active: sql<number>`SUM(CASE WHEN ${facts.status} = 'active' THEN 1 ELSE 0 END)`,
        superseded: sql<number>`SUM(CASE WHEN ${facts.status} = 'superseded' THEN 1 ELSE 0 END)`,
        arbitration: sql<number>`SUM(CASE WHEN ${facts.status} = 'pending_arbitration' THEN 1 ELSE 0 END)`,
      })
      .from(facts)
      .where(eq(facts.entityId, entity.id));

    const [changeCount] = await this.db
      .select({ total: count() })
      .from(factChanges)
      .where(eq(factChanges.entityId, entity.id));

    const [eventStat] = await this.db
      .select({ total: count() })
      .from(events)
      .where(and(eq(events.entityId, entity.id), eq(events.status, 'active')));

    // 证据统计与本实体「事实引用证据」同一口径（与 evidence 链一致，不再按 evidence.entity_id 单算）
    const evPassed = chain.filter((c) => c.verifyStatus === 'passed').length;
    // 人工审核留痕：事实 createdBy（人工审核/创建者）→ 用户显示名；无则视为自动管线入库。
    const reviewerByUser = await this.resolveReviewers([...current, ...superseded]);
    const withReview = (list: unknown[]): unknown[] =>
      list.map((raw) => {
        const f = raw as Record<string, unknown>;
        return {
          ...f,
          reviewedByName: reviewerByUser.get(Number(f.createdBy ?? f.created_by)) ?? '自动管线（抽取入库）',
          reviewedAt: dayOnly(f.createdAt ?? f.created_at),
        };
      });

    // 导语：优先由现行事实（最高置信的 active 事实陈述）生成；人工维护的 entities.lede 仅作兜底。
    const entityWithLede = { ...entity, lede: pickLede(current) ?? entity.lede };

    const payload = {
      entity: entityWithLede,
      dimensions: dims,
      stats: {
        facts: Number(factStat?.total ?? 0),
        active: Number(factStat?.active ?? 0),
        superseded: Number(factStat?.superseded ?? 0),
        pendingArbitration: Number(factStat?.arbitration ?? 0),
        changes: Number(changeCount?.total ?? 0),
        events: Number(eventStat?.total ?? 0),
        evidences: chain.length,
        evidencePassed: evPassed,
        articles: articles.length,
        baseline: articles.filter((a) => a.batch === 'baseline').length,
        incremental: articles.filter((a) => a.batch === 'incremental').length,
      },
      facts: withReview(current as unknown[]),
      superseded: withReview(superseded as unknown[]),
      changes,
      events: timeline,
      evidence: chain,
      articles,
      coverage: {
        earliest: articles.length ? articles[articles.length - 1].publishedAt : null,
        latest: articles.length ? articles[0].publishedAt : null,
      },
      graph: await this.graphService.entityGraph(entity.id, { depth: 1 }),
      generatedAt: new Date().toISOString(),
      cached: false,
    };

    await this.cache.set(cacheKey, payload, 600);
    return payload;
  }

  /** 审核留痕：把事实的 createdBy（人工审核/创建者 id）解析为用户显示名。 */
  private async resolveReviewers(rows: unknown[]): Promise<Map<number, string>> {
    const ids = [
      ...new Set(
        rows
          .map((r) => Number((r as Record<string, unknown>).createdBy ?? (r as Record<string, unknown>).created_by))
          .filter((n) => Number.isFinite(n) && n > 0),
      ),
    ];
    if (!ids.length) return new Map();
    const list = await this.db
      .select({ id: users.id, displayName: users.displayName, username: users.username })
      .from(users)
      .where(inArray(users.id, ids));
    return new Map(list.map((u) => [Number(u.id), u.displayName || u.username || `用户#${u.id}`]));
  }

  /** 单条事实的稳定公开地址：/archive/:dataset/:slug/fact/:code（可引用、可收藏、可机器读取） */
  async factByCode(datasetCode: string, slug: string, code: string) {
    const entity = await this.resolveEntity(datasetCode, slug);
    const fact = await this.factService.byCode(entity.id, code);
    return {
      entity,
      fact,
      /** 稳定链接（相对本站根路径），供页面/机器直接引用 */
      permalink: `/archive/${encodeURIComponent(datasetCode)}/${encodeURIComponent(slug)}/fact/${encodeURIComponent(code)}`,
    };
  }

  /** 单条变更的稳定公开地址：/archive/:dataset/:slug/change/:id（可引用、可收藏、可机器读取） */
  async changeById(datasetCode: string, slug: string, id: number) {
    const entity = await this.resolveEntity(datasetCode, slug);
    const change = await this.factService.changeById(entity.id, id);
    return {
      entity,
      change,
      permalink: `/archive/${encodeURIComponent(datasetCode)}/${encodeURIComponent(slug)}/change/${id}`,
    };
  }

  /** 已发布实体的全部现行事实（供 sitemap 收录与 SSG 渲染单条事实页） */
  async factPages() {
    const [rows] = (await this.db.execute(sql`
      SELECT f.code, f.updated_at, e.slug, d.code datasetCode
      FROM fact f
      JOIN entity e ON e.id = f.entity_id
      JOIN dataset d ON d.id = e.origin_dataset_id
      WHERE f.status = 'active' AND f.code IS NOT NULL
        AND e.status = 'published' AND e.deleted_at IS NULL
    `)) as unknown as [Record<string, unknown>[], unknown];
    return (rows ?? []).map((r) => ({
      code: String(r.code),
      datasetCode: String(r.datasetCode),
      slug: String(r.slug),
      updatedAt: (r.updated_at as string | null) ?? null,
    }));
  }

  /**
   * 内容视图 /facts：全站现行事实列表（附实体名与档案路径）。
   * 按最近核验倒序取前 N 条——SSG 直出静态页用，避免该路由对爬虫只呈现空壳。
   */
  async factsPage(limit = 60) {
    const [rows] = (await this.db.execute(sql`
      SELECT f.id, f.code, f.entity_id entityId, f.dimension, f.statement, f.status,
             f.confidence, f.version, f.last_verified_at lastVerifiedAt, f.updated_at updatedAt,
             e.name entityName, e.slug entitySlug, d.code datasetCode
      FROM fact f
      JOIN entity e ON e.id = f.entity_id
      JOIN dataset d ON d.id = e.origin_dataset_id
      WHERE f.status = 'active' AND e.status = 'published' AND e.deleted_at IS NULL
      ORDER BY f.updated_at DESC, f.id DESC
      LIMIT ${Number(limit)}
    `)) as unknown as [Record<string, unknown>[], unknown];
    return (rows ?? []).map((r) => ({
      id: Number(r.id),
      code: (r.code as string | null) ?? null,
      entityId: Number(r.entityId),
      entityName: String(r.entityName),
      entitySlug: String(r.entitySlug),
      datasetCode: String(r.datasetCode),
      dimension: (r.dimension as string | null) ?? null,
      statement: String(r.statement),
      status: String(r.status),
      confidence: Number(r.confidence),
      version: Number(r.version),
      lastVerifiedAt: (r.lastVerifiedAt as string | null) ?? null,
      updatedAt: (r.updatedAt as string | null) ?? null,
    }));
  }

  /** 单条事实页（可抓取 HTML）：与 /fact/:code 的 JSON 同源，附该事实的知识变化历史 */
  async factPageHtml(datasetCode: string, slug: string, code: string, baseUrl: string, spaAssets = '') {
    const { entity, fact } = await this.factByCode(datasetCode, slug, code);
    const fid = Number((fact as { id?: number }).id ?? 0);
    const [history] = (await this.db.execute(sql`
      SELECT id, change_type, summary, created_at
      FROM fact_change
      WHERE to_fact_id = ${fid} OR from_fact_id = ${fid}
      ORDER BY id DESC
      LIMIT 5
    `)) as unknown as [Record<string, unknown>[], unknown];
    const sources = ((fact as { evidences?: unknown[] }).evidences ?? []) as Record<string, unknown>[];
    return {
      html: renderFactHtml(
        {
          entity: { ...entity, datasetCode, slug, name: String(entity.name) },
          fact: fact as unknown as Record<string, unknown>,
          history: history ?? [],
          sources,
        },
        baseUrl,
        spaAssets,
      ),
      etag: `W/"fact-${entity.id}-${code}-${String((fact as { updatedAt?: unknown }).updatedAt ?? '')}"`,
    };
  }

  // ---------------------------------------------------------------- 文章事实列表页（/articles/{articleId}）

  /**
   * 一篇文章抽取的全部事实 + 实体关系一跳的相关事实。
   * 主区「这篇文章抽出了什么」：evidence.article_id → fact_evidence → fact。
   * 相关区「与本文实体有关系的实体的事实」：entity_relation 双向一跳取邻居实体的现行事实。
   */
  async articleFacts(articleId: number) {
    const [article] = await this.db
      .select({
        id: sourceArticles.id,
        title: sourceArticles.title,
        url: sourceArticles.url,
        sourceOrg: sourceArticles.sourceOrg,
        sourceSite: sourceArticles.sourceSite,
        publishedAt: sourceArticles.publishedAt,
        fetchedAt: sourceArticles.fetchedAt,
        // 文章主题/摘要/核心数据（生产线 LLM 产出，事实稿页面的标题位、导语位与指标卡）
        theme: sourceArticles.theme,
        topicId: sourceArticles.topicId,
        summary: sourceArticles.summary,
        keyStats: sourceArticles.keyStats,
        briefAt: sourceArticles.briefAt,
        briefPromptVersion: sourceArticles.briefPromptVersion,
      })
      .from(sourceArticles)
      .where(eq(sourceArticles.id, articleId))
      .limit(1);
    if (!article) throw new NotFoundException('文章不存在');
    // 所属主题：沿合并指针取最终主题名，供文章页「所属主题」入口展示与跳转
    let topic: { id: number; name: string } | null = null;
    if (article.topicId) {
      const finalTopicId = await this.finalTopicId(Number(article.topicId));
      if (finalTopicId) {
        const [topicRow] = await this.db
          .select({ id: topics.id, name: topics.name })
          .from(topics)
          .where(eq(topics.id, finalTopicId))
          .limit(1);
        if (topicRow) topic = { id: Number(topicRow.id), name: String(topicRow.name) };
      }
    }
    // json 列在不同驱动下可能是字符串，统一成 [{ value, label }]，页面不必再判形态
    const keyStats = (() => {
      const raw = article.keyStats as unknown;
      const arr = typeof raw === 'string' ? (() => {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })() : raw;
      if (!Array.isArray(arr)) return [] as { value: string; label: string }[];
      return arr
        .map((it) => ({
          value: String((it as { value?: unknown })?.value ?? '').trim(),
          label: String((it as { label?: unknown })?.label ?? '').trim(),
        }))
        .filter((it) => it.value && it.label)
        .slice(0, 4);
    })();

    const [rows] = (await this.db.execute(sql`
      SELECT f.id, f.code, f.dimension, f.fact_type factType, f.statement, f.status, f.version, f.confidence,
             f.semantic_role semanticRole, f.period_key periodKey, f.subject_scope subjectScope,
             f.temporal_kind temporalKind, f.as_of asOf, f.event_start eventStart, f.event_end eventEnd,
             f.valid_from validFrom, f.valid_to validTo, f.method, f.sign_mode signMode,
             f.source_authority sourceAuthority, f.independently_verified independentlyVerified,
             f.issued_at issuedAt, f.created_at createdAt, f.alerts, f.arbitration_note arbitrationNote,
             f.created_by createdBy, f.superseded_by_id supersededById,
             f.last_verified_at lastVerifiedAt,
             e.id entityId, e.name entityName, e.slug entitySlug, d.code datasetCode,
             ev.id evidenceId, ev.code evidenceCode, ev.quote, ev.span_start spanStart, ev.span_end spanEnd,
             ev.source_org sourceOrg, ev.material_title materialTitle, ev.source_url sourceUrl,
             ev.published_at publishedAt,
             (SELECT ft2.topic_id FROM fact_topic ft2
               WHERE ft2.fact_id = f.id AND ft2.role = 'primary' LIMIT 1) factTopicId,
             (SELECT t2.name FROM fact_topic ft2 JOIN topic t2 ON t2.id = ft2.topic_id
               WHERE ft2.fact_id = f.id AND ft2.role = 'primary' LIMIT 1) factTopicName
      FROM evidence ev
      JOIN fact_evidence fe ON fe.evidence_id = ev.id
      JOIN fact f ON f.id = fe.fact_id
      JOIN entity e ON e.id = f.entity_id
      JOIN dataset d ON d.id = e.origin_dataset_id
      WHERE ev.article_id = ${articleId}
        AND f.status = 'active' AND e.status = 'published' AND e.deleted_at IS NULL
      ORDER BY e.name ASC, f.dimension ASC, f.id ASC
    `)) as unknown as [Record<string, unknown>[], unknown];

    // 同一事实可能挂多条证据（同一篇文章涉及同一实体多段）→ 聚合成一条事实，证据收进 evidences[]
    const alertsOf = (v: unknown): string[] => {
      if (!v) return [];
      if (Array.isArray(v)) return v as string[];
      if (typeof v === 'string') {
        try {
          const p = JSON.parse(v);
          return Array.isArray(p) ? p : [];
        } catch {
          return [];
        }
      }
      return [];
    };
    const toIso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : ((v as string | null) ?? null));
    const byFact = new Map<number, Record<string, unknown>>();
    for (const r of rows ?? []) {
      const id = Number(r.id);
      let item = byFact.get(id);
      if (!item) {
        item = {
          id: Number(r.id),
          code: (r.code as string | null) ?? null,
          statement: String(r.statement),
          dimension: (r.dimension as string | null) ?? null,
          factType: (r.factType as string | null) ?? null,
          status: (r.status as string | null) ?? null,
          version: Number(r.version ?? 1),
          confidence: r.confidence == null ? null : Number(r.confidence),
          semanticRole: (r.semanticRole as string | null) ?? null,
          periodKey: (r.periodKey as string | null) ?? null,
          subjectScope: (r.subjectScope as string | null) ?? null,
          temporalKind: (r.temporalKind as string | null) ?? 'unknown',
          asOf: (r.asOf as string | null) ?? null,
          eventStart: (r.eventStart as string | null) ?? null,
          eventEnd: (r.eventEnd as string | null) ?? null,
          validFrom: (r.validFrom as string | null) ?? null,
          validTo: (r.validTo as string | null) ?? null,
          method: (r.method as string | null) ?? null,
          signMode: (r.signMode as string | null) ?? null,
          sourceAuthority: (r.sourceAuthority as string | null) ?? null,
          independentlyVerified: Boolean(r.independentlyVerified),
          issuedAt: toIso(r.issuedAt),
          createdAt: toIso(r.createdAt),
          alerts: alertsOf(r.alerts),
          arbitrationNote: (r.arbitrationNote as string | null) ?? null,
          createdBy: r.createdBy == null ? null : Number(r.createdBy),
          supersededById: r.supersededById == null ? null : Number(r.supersededById),
          lastVerifiedAt: (r.lastVerifiedAt as string | null) ?? null,
          entityId: Number(r.entityId),
          entityName: String(r.entityName),
          entitySlug: String(r.entitySlug),
          datasetCode: String(r.datasetCode),
          // 事实级主属主题：与文章主题不一致时，页面标「主属主题」并说明该条归入别的主题页
          factTopicId: r.factTopicId == null ? null : Number(r.factTopicId),
          factTopicName: (r.factTopicName as string | null) ?? null,
          evidences: [] as Record<string, unknown>[],
        };
        byFact.set(id, item);
      }
      (item.evidences as Record<string, unknown>[]).push({
        evidenceId: Number(r.evidenceId),
        evidenceCode: (r.evidenceCode as string | null) ?? null,
        quote: (r.quote as string | null) ?? null,
        spanStart: r.spanStart == null ? null : Number(r.spanStart),
        spanEnd: r.spanEnd == null ? null : Number(r.spanEnd),
        sourceOrg: (r.sourceOrg as string | null) ?? null,
        materialTitle: (r.materialTitle as string | null) ?? null,
        sourceUrl: (r.sourceUrl as string | null) ?? null,
        publishedAt: (r.publishedAt as string | null) ?? null,
      });
    }
    const clock = todayInShanghai();
    const facts: Record<string, unknown>[] = [...byFact.values()].map((f) => ({
      ...f,
      applicability: applicabilityOf(f, clock),
    }));

    // ---- 相关事实：文章涉及实体在 entity_relation 中的一跳邻居 ----
    const seedIds = [...new Set(facts.map((f) => Number(f.entityId)))];
    let related: {
      entityId: number;
      entityName: string;
      entitySlug: string;
      datasetCode: string;
      predicate: string;
      facts: { code: string | null; statement: string; dimension: string | null }[];
    }[] = [];
    if (seedIds.length) {
      const seedIn = sql.join(
        seedIds.map((id) => sql`${id}`),
        sql`, `,
      );
      const [relRows] = (await this.db.execute(sql`
        SELECT r.head_entity_id headId, r.tail_entity_id tailId, r.predicate
        FROM entity_relation r
        WHERE r.tail_entity_id IS NOT NULL
          AND (r.head_entity_id IN (${seedIn}) OR r.tail_entity_id IN (${seedIn}))
        LIMIT 400
      `)) as unknown as [Record<string, unknown>[], unknown];

      const seedSet = new Set(seedIds);
      const neighbors = new Map<number, string>(); // 邻居实体 → 首次命中的关系谓词
      for (const r of relRows ?? []) {
        const h = Number(r.headId);
        const t = Number(r.tailId);
        if (seedSet.has(h) && !seedSet.has(t) && !neighbors.has(t)) neighbors.set(t, String(r.predicate));
        else if (seedSet.has(t) && !seedSet.has(h) && !neighbors.has(h)) neighbors.set(h, String(r.predicate));
      }
      const nids = [...neighbors.keys()].slice(0, 8);
      if (nids.length) {
        const nIn = sql.join(
          nids.map((id) => sql`${id}`),
          sql`, `,
        );
        const [relFacts] = (await this.db.execute(sql`
          SELECT f.code, f.statement, f.dimension, e.id entityId, e.name entityName,
                 e.slug entitySlug, d.code datasetCode
          FROM fact f
          JOIN entity e ON e.id = f.entity_id
          JOIN dataset d ON d.id = e.origin_dataset_id
          WHERE f.status = 'active' AND e.status = 'published' AND e.deleted_at IS NULL
            AND f.entity_id IN (${nIn})
          ORDER BY e.id ASC, f.last_verified_at DESC, f.id DESC
          LIMIT 24
        `)) as unknown as [Record<string, unknown>[], unknown];

        const byEntity = new Map<number, (typeof related)[number]>();
        for (const r of relFacts ?? []) {
          const eid = Number(r.entityId);
          if (!byEntity.has(eid)) {
            byEntity.set(eid, {
              entityId: eid,
              entityName: String(r.entityName),
              entitySlug: String(r.entitySlug),
              datasetCode: String(r.datasetCode),
              predicate: neighbors.get(eid) ?? '',
              facts: [],
            });
          }
          const bucket = byEntity.get(eid)!;
          if (bucket.facts.length >= 3) continue; // 每个邻居实体最多 3 条，避免页面被单一实体淹没
          bucket.facts.push({
            code: (r.code as string | null) ?? null,
            statement: String(r.statement),
            dimension: (r.dimension as string | null) ?? null,
          });
        }
        related = [...byEntity.values()];
      }
    }

    // ---- 逐条事实附「修订轨迹」与「版本继承/更正关系」，供按原型 factCard 展示 ----
    const factIds = facts.map((f) => Number(f.id));
    const revMap = new Map<number, unknown[]>();
    const relMap = new Map<number, unknown[]>();
    if (factIds.length) {
      const fIn = sql.join(
        factIds.map((i) => sql`${i}`),
        sql`, `,
      );
      const [revRows] = (await this.db.execute(sql`
        SELECT fact_id factId, rev, statement, change_type changeType, reason, issued_at issuedAt
        FROM fact_revision WHERE fact_id IN (${fIn})
        ORDER BY fact_id ASC, rev ASC
      `)) as unknown as [Record<string, unknown>[], unknown];
      for (const r of revRows ?? []) {
        const k = Number(r.factId);
        if (!revMap.has(k)) revMap.set(k, []);
        revMap.get(k)!.push({
          rev: Number(r.rev),
          statement: (r.statement as string | null) ?? null,
          changeType: (r.changeType as string | null) ?? null,
          reason: (r.reason as string | null) ?? null,
          issuedAt: (r.issuedAt as string | null) ?? null,
        });
      }
      const [relRows] = (await this.db.execute(sql`
        SELECT id, from_fact_id fromId, to_fact_id toId, type
        FROM fact_relation
        WHERE from_fact_id IN (${fIn}) OR to_fact_id IN (${fIn})
      `)) as unknown as [Record<string, unknown>[], unknown];
      const factIdSet = new Set(factIds);
      for (const r of relRows ?? []) {
        const fromId = Number(r.fromId);
        const toId = Number(r.toId);
        const addRel = (owner: number, peer: number, dir: 'out' | 'in') => {
          if (!relMap.has(owner)) relMap.set(owner, []);
          relMap.get(owner)!.push({ id: Number(r.id), type: r.type, direction: dir, peerFactId: peer });
        };
        if (factIdSet.has(fromId)) addRel(fromId, toId, 'out');
        if (factIdSet.has(toId)) addRel(toId, fromId, 'in');
      }
    }
    const factsWithExtra = facts.map((f) => ({
      ...f,
      revisions: revMap.get(Number(f.id)) ?? [],
      relations: relMap.get(Number(f.id)) ?? [],
    }));

    return { article: { ...article, keyStats, topic }, facts: factsWithExtra, related };
  }

  /**
   * 文章事实稿页（可抓取 HTML）：与 /api/archive/article/:id/facts 同源。
   * 该页是自成一体的事实稿版式（自带 topbar / 三栏 / 侧栏 / 页脚），
   * 因此**不注入前台 SPA 资源**，避免被站点框架接管后换成另一套样式。
   */
  async articleFactsPageHtml(articleId: number, baseUrl: string) {
    const data = await this.articleFacts(articleId);
    // 主题/摘要回填后必须换 ETag，否则浏览器继续用旧页面；
    // 只取毫秒时间戳参与拼接，避免把 Date 的本地化字符串写进 HTTP 头（非 ASCII 会 ERR_INVALID_CHAR）
    const briefAt = data.article.briefAt ? new Date(data.article.briefAt).getTime() : 0;
    const briefStamp = Number.isFinite(briefAt) ? briefAt : 0;
    return {
      html: renderArticleFactsHtml(
        {
          article: data.article as unknown as Record<string, unknown>,
          facts: data.facts as unknown as Record<string, unknown>[],
          related: data.related as unknown as Record<string, unknown>[],
        },
        baseUrl,
      ),
      // 版式版本参与 ETag：渲染模板改版后旧缓存必须失效（否则浏览器 304 拿到旧页面）
      etag: `W/"afacts-v2-${articleId}-${data.facts.length}-${data.related.length}-${briefStamp}"`,
    };
  }

  /**
   * 有事实的文章清单（供 SSG 渲染 /articles/{articleId}，signature 作增量比对）。
   * signature = 事实数 | 最新事实/证据时间 | md5(主题+摘要)：
   * 主题与摘要由生产线 LLM 抽取，回填或重跑后必须触发重渲染，因此并入签名。
   */
  async articleFactPages() {
    const [rows] = (await this.db.execute(sql`
      SELECT ev.article_id articleId,
             CONCAT(
               COUNT(DISTINCT f.id), '|',
               DATE_FORMAT(
                 MAX(GREATEST(COALESCE(f.updated_at, '1970-01-01'), COALESCE(ev.created_at, '1970-01-01'))),
                 '%Y-%m-%d %H:%i:%s'
               ), '|',
               MD5(CONCAT(COALESCE(MAX(a.theme), ''), '|', COALESCE(MAX(a.summary), '')))
             ) sig
      FROM evidence ev
      JOIN fact_evidence fe ON fe.evidence_id = ev.id
      JOIN fact f ON f.id = fe.fact_id
      JOIN entity e ON e.id = f.entity_id
      JOIN source_article a ON a.id = ev.article_id
      WHERE f.status = 'active' AND e.status = 'published' AND e.deleted_at IS NULL
      GROUP BY ev.article_id
    `)) as unknown as [Record<string, unknown>[], unknown];
    return (rows ?? []).map((r) => ({
      articleId: Number(r.articleId),
      signature: String(r.sig),
    }));
  }

  // ---------------------------------------------------------------- 主题聚合页（/facts/{topicId}）

  /** 沿 merged_into_id 找到主题最终 id：合并只改指针，历史 fact_topic 不改写，读取时归并 */
  private async finalTopicId(topicId: number): Promise<number | null> {
    let id = topicId;
    for (let i = 0; i < 6; i += 1) {
      const [row] = await this.db
        .select({ id: topics.id, status: topics.status, mergedIntoId: topics.mergedIntoId })
        .from(topics)
        .where(eq(topics.id, id))
        .limit(1);
      if (!row) return null;
      if (row.status === 'merged' && row.mergedIntoId) {
        id = Number(row.mergedIntoId);
        continue;
      }
      return Number(row.id);
    }
    return id;
  }

  /**
   * 主题聚合：该主题下 primary 事实 + 跨文章合并去重 + 来源文章清单 + 主题级核心数据。
   *
   * 合并口径：同一主体 + 归一化陈述（去标点空白）视为同一条事实，证据取并集，
   * 代表条取「证据更多 / 置信更高」的那条，并记录 mergedFactIds 便于溯源。
   * 不额外建汇总表，避免与事实表产生双写不一致。
   */
  async topicFacts(topicId: number) {
    const finalId = await this.finalTopicId(topicId);
    if (!finalId) throw new NotFoundException('主题不存在');

    const [topicRow] = await this.db
      .select({
        id: topics.id,
        code: topics.code,
        name: topics.name,
        definition: topics.definition,
        aliases: topics.aliases,
        firstArticleAt: topics.firstArticleAt,
        lastArticleAt: topics.lastArticleAt,
        updatedAt: topics.updatedAt,
        publicationStatus: topics.publicationStatus,
        publishedRevisionId: topics.publishedRevisionId,
        publishedAt: topics.publishedAt,
      })
      .from(topics)
      .where(eq(topics.id, finalId))
      .limit(1);
    if (!topicRow) throw new NotFoundException('主题不存在');

    const aliasRows = await this.db
      .select({ alias: topicAliases.alias })
      .from(topicAliases)
      .where(eq(topicAliases.topicId, finalId))
      .orderBy(asc(topicAliases.id));

    const [rows] = (await this.db.execute(sql`
      SELECT f.id, f.code, f.statement, f.status, f.version, f.confidence,
             f.fact_type factType, f.semantic_role semanticRole, f.period_key periodKey,
             f.subject_scope subjectScope, f.temporal_kind temporalKind, f.as_of asOf,
             f.event_start eventStart, f.event_end eventEnd, f.valid_from validFrom, f.valid_to validTo,
             f.time_precision timePrecision, f.time_certainty timeCertainty, f.statement_kind statementKind,
             f.canonical_fact_id canonicalFactId,
             (SELECT COUNT(*) FROM fact_entity fe2 WHERE fe2.fact_id=f.id AND fe2.role <> 'primary') participantCount,
             f.method, f.sign_mode signMode, f.source_authority sourceAuthority,
             f.independently_verified independentlyVerified, f.issued_at issuedAt, f.created_at createdAt,
             f.alerts, f.last_verified_at lastVerifiedAt,
             e.id entityId, e.name entityName, e.slug entitySlug, d.code datasetCode,
             ev.id evidenceId, ev.quote, ev.span_start spanStart, ev.span_end spanEnd,
             ev.source_org evidenceSourceOrg, ev.material_title materialTitle, ev.source_url sourceUrl,
             ev.published_at evidencePublishedAt,
             ev.source_family_id familyId, ev.source_id evidenceSourceId, ev.independence evidenceIndependence,
             a.id articleId, a.title articleTitle, a.url articleUrl, a.source_org articleSourceOrg,
             a.source_site articleSourceSite, a.published_at articlePublishedAt
      FROM (
        SELECT ft.fact_id
        FROM fact_topic ft
        WHERE ft.topic_id = ${finalId} AND ft.role = 'primary'
        LIMIT 800
      ) sel
      JOIN fact f ON f.id = sel.fact_id
      JOIN entity e ON e.id = f.entity_id
      JOIN dataset d ON d.id = e.origin_dataset_id
      LEFT JOIN fact_evidence fe ON fe.fact_id = f.id
      LEFT JOIN evidence ev ON ev.id = fe.evidence_id
      LEFT JOIN source_article a ON a.id = ev.article_id
      WHERE ${publicFactSql('f')} AND e.status = 'published' AND e.deleted_at IS NULL
      ORDER BY e.name ASC, f.id ASC
    `)) as unknown as [Record<string, unknown>[], unknown];

    const alertsOf = (v: unknown): string[] => {
      if (!v) return [];
      if (Array.isArray(v)) return v as string[];
      if (typeof v === 'string') {
        try {
          const p = JSON.parse(v);
          return Array.isArray(p) ? p : [];
        } catch {
          return [];
        }
      }
      return [];
    };
    const toIso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : ((v as string | null) ?? null));
    /** 事实去重键：同一主体 + 归一化陈述 */
    const normStmt = (s: unknown) =>
      String(s ?? '')
        .replace(/[\s，。、；：！？,.!?;:""''（）()《》「」【】\-–—]/g, '')
        .toLowerCase()
        .slice(0, 160);

    type FactItem = Record<string, unknown> & {
      evidences: Record<string, unknown>[];
      articles: Map<number, Record<string, unknown>>;
      mergedFactIds: number[];
    };
    const byKey = new Map<string, FactItem>();
    for (const r of rows ?? []) {
      const key = `${Number(r.entityId)}::${normStmt(r.statement)}`;
      let item = byKey.get(key);
      if (!item) {
        item = {
          id: Number(r.id),
          code: (r.code as string | null) ?? null,
          statement: String(r.statement),
          factType: (r.factType as string | null) ?? null,
          status: (r.status as string | null) ?? null,
          version: Number(r.version ?? 1),
          confidence: r.confidence == null ? null : Number(r.confidence),
          semanticRole: (r.semanticRole as string | null) ?? null,
          periodKey: (r.periodKey as string | null) ?? null,
          subjectScope: (r.subjectScope as string | null) ?? null,
          temporalKind: (r.temporalKind as string | null) ?? 'unknown',
          asOf: (r.asOf as string | null) ?? null,
          eventStart: (r.eventStart as string | null) ?? null,
          eventEnd: (r.eventEnd as string | null) ?? null,
          validFrom: (r.validFrom as string | null) ?? null,
          validTo: (r.validTo as string | null) ?? null,
          method: (r.method as string | null) ?? null,
          signMode: (r.signMode as string | null) ?? null,
          sourceAuthority: (r.sourceAuthority as string | null) ?? null,
          independentlyVerified: Boolean(r.independentlyVerified),
          issuedAt: toIso(r.issuedAt),
          createdAt: toIso(r.createdAt),
          lastVerifiedAt: (r.lastVerifiedAt as string | null) ?? null,
          alerts: alertsOf(r.alerts),
          entityId: Number(r.entityId),
          entityName: String(r.entityName),
          entitySlug: String(r.entitySlug),
          datasetCode: String(r.datasetCode),
          timePrecision: (r.timePrecision as string | null) ?? 'unknown',
          timeCertainty: (r.timeCertainty as string | null) ?? 'unknown',
          statementKind: (r.statementKind as string | null) ?? 'claim',
          participantCount: Number(r.participantCount ?? 0),
          canonicalFactId: r.canonicalFactId == null ? null : Number(r.canonicalFactId),
          evidences: [],
          articles: new Map(),
          mergedFactIds: [],
        } as FactItem;
        byKey.set(key, item);
      }
      if (!item.mergedFactIds.includes(Number(r.id))) item.mergedFactIds.push(Number(r.id));
      if (r.evidenceId != null) {
        const evId = Number(r.evidenceId);
        if (!item.evidences.some((e) => Number(e.evidenceId) === evId)) {
          item.evidences.push({
            evidenceId: evId,
            quote: (r.quote as string | null) ?? null,
            spanStart: r.spanStart == null ? null : Number(r.spanStart),
            spanEnd: r.spanEnd == null ? null : Number(r.spanEnd),
            sourceOrg: (r.evidenceSourceOrg as string | null) ?? (r.articleSourceOrg as string | null) ?? null,
            materialTitle: (r.materialTitle as string | null) ?? (r.articleTitle as string | null) ?? null,
            sourceUrl: (r.sourceUrl as string | null) ?? (r.articleUrl as string | null) ?? null,
            publishedAt: (r.evidencePublishedAt as string | null) ?? (r.articlePublishedAt as string | null) ?? null,
            articleId: r.articleId == null ? null : Number(r.articleId),
            articleTitle: (r.articleTitle as string | null) ?? null,
            familyId: r.familyId == null ? null : Number(r.familyId),
            sourceId: r.evidenceSourceId == null ? null : Number(r.evidenceSourceId),
            independence: (r.evidenceIndependence as string | null) ?? 'unknown',
          });
        }
      }
      if (r.articleId != null) {
        const aid = Number(r.articleId);
        if (!item.articles.has(aid)) {
          item.articles.set(aid, {
            id: aid,
            title: (r.articleTitle as string | null) ?? null,
            url: (r.articleUrl as string | null) ?? null,
            sourceOrg: (r.articleSourceOrg as string | null) ?? null,
            sourceSite: (r.articleSourceSite as string | null) ?? null,
            publishedAt: (r.articlePublishedAt as string | null) ?? null,
          });
        }
      }
    }

    const clock = todayInShanghai();
    type OutFact = Omit<FactItem, 'articles'> & {
      articles: Record<string, unknown>[];
      articleCount: number;
      applicability: unknown;
    };
    const factsAll: OutFact[] = [...byKey.values()].map((f) => {
      const evidences = [...f.evidences].sort((a, b) =>
        String((b.publishedAt as string) ?? '').localeCompare(String((a.publishedAt as string) ?? '')),
      );
      const articleList = [...f.articles.values()];
      const base = {
        ...f,
        evidences,
        articles: articleList,
        articleCount: articleList.length,
        independence: evidenceIndependence(evidences as unknown as Parameters<typeof evidenceIndependence>[0]),
        applicability: applicabilityOf(f as unknown as Record<string, unknown>, clock),
      };
      return base as unknown as OutFact;
    });

    // 同一页面内同一引句只出现一次（PRD R02）：非代表条在同一主题里隐藏，
    // 代表条不在本主题时保留，避免跨主题丢事实。
    const presentIds = new Set(factsAll.map((f) => Number((f as Record<string, unknown>).id)));
    const factsOut = factsAll.filter((f) => {
      const canonical = Number((f as Record<string, unknown>).canonicalFactId ?? 0);
      return !canonical || !presentIds.has(canonical);
    });

    // ---- 来源文章清单（按发布时间倒序），并统计每篇贡献的合并事实数 ----
    const articleMap = new Map<number, Record<string, unknown> & { factCount: number }>();
    for (const f of factsOut) {
      for (const a of (f.articles as Record<string, unknown>[]) ?? []) {
        const aid = Number(a.id);
        let hit = articleMap.get(aid);
        if (!hit) {
          hit = {
            id: aid,
            title: a.title ?? null,
            url: a.url ?? null,
            sourceOrg: a.sourceOrg ?? null,
            sourceSite: a.sourceSite ?? null,
            publishedAt: (a.publishedAt as string | null) ?? null,
            factCount: 0,
          };
          articleMap.set(aid, hit);
        }
        hit.factCount += 1;
      }
    }
    const articles = [...articleMap.values()]
      .sort((a, b) => String((b.publishedAt as string) ?? '').localeCompare(String((a.publishedAt as string) ?? '')))
      .slice(0, 200);
    const articleIds = articles.map((a) => Number(a.id));

    // ---- 主题级核心数据（PRD S03/S04）----
    // v2：按 metricKey 去重（同指标不同 label 只出一次），且必须带单位 + 时间/地域口径才进首屏；
    // 旧 key_stats 只作降级来源，标 legacy，不进首屏。
    type StatCard = { value: string; label: string; sub?: string; approx?: boolean; legacy?: boolean };
    const v2Agg = new Map<string, { s: Record<string, unknown>; count: number }>();
    const legacyAgg = new Map<string, { value: string; label: string; count: number }>();
    if (articleIds.length) {
      const idIn = sql.join(
        articleIds.map((id) => sql`${id}`),
        sql`, `,
      );
      const [statRows] = (await this.db.execute(sql`
        SELECT key_stats, key_stats_v2 FROM source_article
        WHERE id IN (${idIn}) AND (key_stats IS NOT NULL OR key_stats_v2 IS NOT NULL)
      `)) as unknown as [Record<string, unknown>[], unknown];
      const parseJson = (v: unknown): unknown => {
        if (typeof v !== 'string') return v;
        try {
          return JSON.parse(v);
        } catch {
          return null;
        }
      };
      for (const row of statRows ?? []) {
        const v2 = parseJson(row.key_stats_v2);
        if (Array.isArray(v2) && v2.length) {
          for (const it of v2 as Record<string, unknown>[]) {
            const k = String(it.metricKey ?? 'unmapped');
            const hit = v2Agg.get(k);
            if (hit) hit.count += 1;
            else v2Agg.set(k, { s: it, count: 1 });
          }
        }
        // 旧字段仍然聚合，仅作为 v2 全不合格时的降级来源
        const v1 = parseJson(row.key_stats);
        if (!Array.isArray(v1)) continue;
        for (const it of v1 as { value?: unknown; label?: string }[]) {
          const value = String(it?.value ?? '').trim();
          const label = String(it?.label ?? '').trim();
          if (!value || !label) continue;
          const k = `${value}|${label}`;
          const hit = legacyAgg.get(k);
          if (hit) hit.count += 1;
          else legacyAgg.set(k, { value, label, count: 1 });
        }
      }
    }
    const keyStats: StatCard[] = [...v2Agg.values()]
      // 准入口径由 shared 统一判定：flow 必须有统计期，stock 允许只有地域/范围
      .filter(({ s }) => isPublishableKeyStat(s as unknown as Parameters<typeof isPublishableKeyStat>[0]))
      .sort((a, b) => b.count - a.count)
      .slice(0, 4)
      .map(({ s }) => {
        const kind = metricKindOf(String(s.metricKey ?? ''));
        const parts = [s.period, s.region, s.scope].filter(Boolean).map(String);
        if (kind === 'stock' && !s.period) parts.push('时点未标注');
        return {
          value: String(s.valueText ?? ''),
          label: String(s.metricName ?? ''),
          sub: parts.join(' · '),
          approx: Boolean(s.approx),
        };
      });
    // 缺口径指标：有数值有单位但缺统计年份/地域——不进首屏，单独披露待补（PRD AT04）
    const keyStatsPending = [...v2Agg.values()]
      .filter(
        ({ s }) =>
          String(s.metricKey ?? 'unmapped') !== 'unmapped' &&
          s.legacy !== true &&
          String(s.valueText ?? '').trim() &&
          s.unit &&
          !isPublishableKeyStat(s as unknown as Parameters<typeof isPublishableKeyStat>[0]),
      )
      .sort((a, b) => b.count - a.count)
      .slice(0, 4)
      .map(({ s }) => ({
        value: String(s.valueText ?? ''),
        label: String(s.metricName ?? ''),
        scope: String(s.scope ?? ''),
      }));

    // 降级：既无合规指标、也无结构化候选时，才把旧卡作为"未校验"披露，避免同一数字两处口径打架
    if (!keyStats.length && !keyStatsPending.length) {
      for (const { value, label } of [...legacyAgg.values()].sort((a, b) => b.count - a.count).slice(0, 2)) {
        keyStats.push({ value, label, sub: '来源表述 · 口径待补', legacy: true });
      }
    }
    const fallbackStats = [
      { value: String(factsOut.length), label: '条合并事实' },
      { value: String(new Set(factsOut.map((f) => Number(f.entityId))).size), label: '个涉及主体' },
      { value: String(articles.length), label: '篇来源文章' },
    ];
    for (const c of fallbackStats) {
      if (keyStats.length >= 4) break;
      if (keyStats.some((x) => x.label === c.label)) continue;
      keyStats.push(c);
    }

    // ---- 同一批文章里出现的其他主题（主题间互跳，最多 6 个） ----
    let relatedTopics: { id: number; name: string; factCount: number }[] = [];
    if (articleIds.length) {
      const idIn = sql.join(
        articleIds.map((id) => sql`${id}`),
        sql`, `,
      );
      const [relRows] = (await this.db.execute(sql`
        SELECT t.id, t.name, COUNT(DISTINCT ft.fact_id) n
        FROM fact_topic ft
        JOIN topic t ON t.id = ft.topic_id
        JOIN fact_evidence fe ON fe.fact_id = ft.fact_id
        JOIN evidence ev ON ev.id = fe.evidence_id
        WHERE ev.article_id IN (${idIn})
          AND ft.role = 'primary' AND ft.topic_id <> ${finalId} AND t.status = 'active'
        GROUP BY t.id, t.name
        ORDER BY n DESC
        LIMIT 6
      `)) as unknown as [Record<string, unknown>[], unknown];
      relatedTopics = (relRows ?? []).map((r) => ({
        id: Number(r.id),
        name: String(r.name),
        factCount: Number(r.n ?? 0),
      }));
    }

    const aliasList = (aliasRows ?? []).map((r) => r.alias).filter((x): x is string => Boolean(x));

    // ---- 计数分离（PRD S01）：公开只报已签发条数，候选单独披露，禁止合并成一个"可信规模" ----
    const [countRows] = (await this.db.execute(sql`
      SELECT
        SUM(f.status = 'active' AND f.review_status = 'approved' AND f.publication_status = 'published') published,
        SUM(f.status = 'active' AND f.review_status = 'candidate') candidate,
        COUNT(*) total
      FROM fact f
      JOIN fact_topic ft ON ft.fact_id = f.id AND ft.topic_id = ${finalId} AND ft.role = 'primary'
      JOIN entity e ON e.id = f.entity_id AND e.status = 'published' AND e.deleted_at IS NULL
      WHERE f.status = 'active'
    `)) as unknown as [Record<string, unknown>[], unknown];
    const cr = countRows?.[0] ?? {};
    const counts = {
      // published 用页面实际可见条数（已剔除同引句非代表条），避免计数与列表不一致
      published: factsOut.length,
      candidate: Number(cr.candidate ?? 0) || 0,
      total: Number(cr.total ?? 0) || 0,
    };

    return {
      topic: {
        id: finalId,
        code: topicRow.code,
        name: topicRow.name,
        definition: topicRow.definition,
        aliases: aliasList,
        firstArticleAt: topicRow.firstArticleAt,
        lastArticleAt: topicRow.lastArticleAt,
        updatedAt: topicRow.updatedAt,
        publicationStatus: topicRow.publicationStatus ?? 'private',
        publishedRevisionId: topicRow.publishedRevisionId ?? null,
        publishedAt: topicRow.publishedAt ?? null,
        articleCount: articles.length,
        factCount: factsOut.length,
        evidenceCount: factsOut.reduce((n, f) => n + ((f.evidences as unknown[])?.length ?? 0), 0),
        counts,
      },
      facts: factsOut,
      articles,
      keyStats,
      keyStatsPending,
      relatedTopics,
    };
  }

  /**
   * 主题聚合页（可抓取 HTML）：与 /api/archive/topic/:id/facts 同源。
   * 与文章页一样自成一体（不注入 SPA 资源），ETag 含主题更新时间与版式版本。
   */
  async topicPageHtml(topicId: number, baseUrl: string) {
    const data = await this.topicFacts(topicId);
    const updated = data.topic.updatedAt instanceof Date ? data.topic.updatedAt.getTime() : 0;
    return {
      html: renderTopicFactSheetHtml(
        {
          topic: data.topic as unknown as Record<string, unknown>,
          facts: data.facts as unknown as Record<string, unknown>[],
          articles: data.articles as unknown as Record<string, unknown>[],
          keyStats: data.keyStats,
          keyStatsPending: data.keyStatsPending,
          relatedTopics: data.relatedTopics,
        },
        baseUrl,
      ),
      etag: `W/"topic-v1-${data.topic.id}-${data.facts.length}-${data.articles.length}-${updated}"`,
    };
  }

  /**
   * 主题页 SSG 清单：signature = 事实数 | 最新事实时间 | md5(主题名+定义+别名) | md5(成员文章 key_stats)。
   * 主题名/定义被改写、事实增删、成员文章核心数据变化都会触发重渲染。
   * key_stats 不进签名时，改指标卡（如修正「999年」→「公元999年」）静态页永远不会更新。
   */
  async topicPages() {
    await this.db.execute(sql`SET SESSION group_concat_max_len = 1000000`);
    const [rows] = (await this.db.execute(sql`
      SELECT t.id topicId,
             MAX(t.publication_status) publicationStatus,
             CONCAT(
               COUNT(DISTINCT ft.fact_id), '|',
               DATE_FORMAT(MAX(COALESCE(f.updated_at, f.created_at, '1970-01-01')), '%Y-%m-%d %H:%i:%s'), '|',
               MD5(CONCAT(COALESCE(MAX(t.name), ''), '|', COALESCE(MAX(t.definition), ''))), '|',
               MD5(COALESCE(GROUP_CONCAT(DISTINCT COALESCE(a.key_stats, '') ORDER BY a.id SEPARATOR ''), ''))
             ) sig
      FROM topic t
      JOIN fact_topic ft ON ft.topic_id = t.id AND ft.role = 'primary'
      JOIN fact f ON f.id = ft.fact_id AND f.status = 'active'
      JOIN entity e ON e.id = f.entity_id AND e.status = 'published' AND e.deleted_at IS NULL
      JOIN fact_evidence fe ON fe.fact_id = f.id
      JOIN evidence ev ON ev.id = fe.evidence_id
      JOIN source_article a ON a.id = ev.article_id
      WHERE t.status = 'active'
      GROUP BY t.id
      HAVING COUNT(DISTINCT ft.fact_id) > 0
    `)) as unknown as [Record<string, unknown>[], unknown];
    return (rows ?? []).map((r) => ({
      topicId: Number(r.topicId),
      signature: String(r.sig),
      publicationStatus: String(r.publicationStatus ?? 'private'),
    }));
  }

  /**
   * 旧链接兼容：/facts/{id} 先按「主题 id」命中（新语义），未命中再按文章 id 找到其主题并 301。
   * 数字冲突时主题优先——旧的文章页 URL 会进入同号主题页，这是新语义下的预期行为。
   */
  async resolveFactsRoute(id: number) {
    const topicId = await this.finalTopicId(id);
    if (topicId) return { kind: 'topic' as const, topicId };
    const [row] = await this.db
      .select({ id: sourceArticles.id, topicId: sourceArticles.topicId })
      .from(sourceArticles)
      .where(eq(sourceArticles.id, id))
      .limit(1);
    if (row?.topicId) {
      const finalId = await this.finalTopicId(Number(row.topicId));
      if (finalId) return { kind: 'redirect' as const, location: `/facts/${finalId}` };
    }
    return { kind: 'missing' as const };
  }

  /**
   * 全部变更记录（供 sitemap 收录与 SSG 渲染单条变更页）。
   * `signature` 供增量渲染比对：内含 md5(summary)，因此摘要被改写后能触发重渲染
   * （`fact_change` 只有 created_at、没有 updated_at）。
   */
  async changePages() {
    const [rows] = (await this.db.execute(sql`
      SELECT fc.id, DATE_FORMAT(fc.created_at, '%Y-%m-%d') AS lastmod, e.slug, d.code datasetCode,
             CONCAT(DATE_FORMAT(fc.created_at, '%Y-%m-%d'), '|', fc.change_type, '|', MD5(COALESCE(fc.summary, '')),
                    '|', COALESCE(fc.from_fact_id, ''), '|', COALESCE(fc.to_fact_id, '')) AS sig
      FROM fact_change fc
      JOIN entity e ON e.id = fc.entity_id
      JOIN dataset d ON d.id = e.origin_dataset_id
      WHERE e.status = 'published' AND e.deleted_at IS NULL
    `)) as unknown as [Record<string, unknown>[], unknown];
    return (rows ?? []).map((r) => ({
      id: Number(r.id),
      datasetCode: String(r.datasetCode),
      slug: String(r.slug),
      lastmod: (r.lastmod as string | null) ?? null,
      signature: String(r.sig),
    }));
  }

  /** 单条变更记录页（可抓取 HTML）：与 /change/:id 的 JSON 同源 */
  async changePageHtml(datasetCode: string, slug: string, id: number, baseUrl: string, spaAssets = '') {
    const { entity, change } = await this.changeById(datasetCode, slug, id);
    return {
      html: renderChangeHtml(
        {
          entity: { ...entity, datasetCode, slug, name: String(entity.name) },
          change: change as unknown as Record<string, unknown>,
        },
        baseUrl,
        spaAssets,
      ),
      etag: `W/"chg-${entity.id}-${id}"`,
    };
  }

  /** v2：按语料域 code 解析其关联分类 id（archive 路径的 dataset 段 = 视图归属） */
  private async linkedCategoryIdsByCode(datasetCode: string): Promise<number[]> {
    const [ds] = await this.db
      .select({ id: datasets.id })
      .from(datasets)
      .where(eq(datasets.code, datasetCode))
      .limit(1);
    if (!ds) return [];
    return linkedCategoryIds(this.db, Number(ds.id));
  }

  async resolveEntity(datasetCode: string, slug: string) {
    const [row] = await this.db
      .select({
        id: entities.id,
        urn: entities.urn,
        name: entities.name,
        slug: entities.slug,
        lede: entities.lede,
        seedSource: entities.seedSource,
        attrsJson: entities.attrsJson,
        status: entities.status,
        revision: entities.revision,
        publishedAt: entities.publishedAt,
        datasetId: entities.originDatasetId,
        datasetCode: datasets.code,
        datasetName: datasets.name,
        categoryId: entities.categoryId,
        categoryName: categories.name,
        categoryCode: categories.code,
      })
      .from(entities)
      .leftJoin(datasets, eq(entities.originDatasetId, datasets.id))
      .leftJoin(categories, eq(entities.categoryId, categories.id))
      .where(
        and(
          inArray(entities.categoryId, await this.linkedCategoryIdsByCode(datasetCode)),
          eq(entities.slug, slug),
          isNull(entities.deletedAt),
        ),
      )
      .limit(1);

    // 只有 status = published 才对外可见，其余返回 404
    if (!row || row.status !== 'published') throw new NotFoundException('档案不存在或未发布');
    return row;
  }

  /**
   * 语料域首页（公开 /archive/home/:dataset）：按该库「关联分类 → home_show 配置」组织分类目录，
   * 每个目录展示配置数量的已发布实体卡片（名称 / 导语 / 分类 / 事实数与证据数）。
   */
  async home(datasetCode: string) {
    const [ds] = await this.db
      .select({ id: datasets.id, code: datasets.code, name: datasets.name, description: datasets.description })
      .from(datasets)
      .where(eq(datasets.code, datasetCode))
      .limit(1);
    if (!ds) throw new NotFoundException('语料域不存在');

    const links = await this.db
      .select({
        categoryId: datasetCategories.categoryId,
        homeShow: datasetCategories.homeShow,
        sort: datasetCategories.sort,
        code: categories.code,
        name: categories.name,
        description: categories.description,
      })
      .from(datasetCategories)
      .innerJoin(categories, eq(datasetCategories.categoryId, categories.id))
      .where(and(eq(datasetCategories.datasetId, ds.id), gt(datasetCategories.homeShow, 0), eq(categories.status, 'active')))
      .orderBy(asc(datasetCategories.sort), asc(datasetCategories.categoryId));

    const directories = [];
    for (const link of links) {
      const limit = Math.min(Math.max(Number(link.homeShow ?? 0), 0), 200);
      // active 事实/证据数：用两步查询 + JS 组装（drizzle 对 select 列里的相关子查询
      // `${entities.id}` 绑定异常，会返回全实体相同的错误值；故不用子查询）
      const baseRows = await this.db
        .select({ id: entities.id, name: entities.name, slug: entities.slug, lede: entities.lede, updatedAt: entities.updatedAt })
        .from(entities)
        .where(and(eq(entities.categoryId, link.categoryId), eq(entities.status, 'published'), isNull(entities.deletedAt)));
      const ids = baseRows.map((r) => r.id);
      const factRows = ids.length
        ? await this.db
            .select({ entityId: facts.entityId, c: count() })
            .from(facts)
            .where(and(inArray(facts.entityId, ids), eq(facts.status, 'active')))
            .groupBy(facts.entityId)
        : [];
      const evRows = ids.length
        ? await this.db
            .select({ entityId: evidence.entityId, c: count() })
            .from(evidence)
            .where(and(inArray(evidence.entityId, ids), eq(evidence.status, 'active')))
            .groupBy(evidence.entityId)
        : [];
      const factMap = new Map(factRows.map((r) => [Number(r.entityId), Number(r.c ?? 0)]));
      const evMap = new Map(evRows.map((r) => [Number(r.entityId), Number(r.c ?? 0)]));
      // 目录取「active 事实数」倒序的 top N；事实数相同取「active 证据数」多者。
      // 取数前先做子串去重：一族名字互含的实体（如「温州敲鱼 / 敲鱼」）只保留事实+证据
      // 更丰的一个，再从去重池向下补足到 top N（避免子串重复挤占名额）。
      const ranked = baseRows
        .map((r) => ({ ...r, factCount: factMap.get(Number(r.id)) ?? 0, evidenceCount: evMap.get(Number(r.id)) ?? 0 }))
        .sort(
          (a, b) =>
            b.factCount - a.factCount ||
            b.evidenceCount - a.evidenceCount
        );
      const top: typeof ranked = [];
      for (const r of ranked) {
        // 与已保留实体互为子串 → 丢弃（保留更早、即事实/证据更多的那个）
        const dupOfKept = top.some((k) => k.name.includes(r.name) || r.name.includes(k.name));
        if (dupOfKept) continue;
        top.push(r);
        if (top.length >= limit) break;
      }
      const [{ value: entityTotal }] = await this.db
        .select({ value: count() })
        .from(entities)
        .where(and(eq(entities.categoryId, link.categoryId), eq(entities.status, 'published'), isNull(entities.deletedAt)));
      directories.push({
        categoryId: Number(link.categoryId),
        code: link.code,
        name: link.name,
        description: link.description,
        homeShow: Number(link.homeShow),
        entityTotal: Number(entityTotal),
        entities: top.map((r) => ({
          id: r.id,
          name: r.name,
          slug: r.slug,
          lede: r.lede,
          factCount: Number(r.factCount ?? 0),
          evidenceCount: Number(r.evidenceCount ?? 0),
        })),
      });
    }

    // 城市事实目录所列实体的合并知识图谱（实体 ∪ 一跳邻居），供首页图谱区域展示
    const catalogEntityIds = directories.flatMap((d) => d.entities.map((e) => Number(e.id)));
    let graph: { seeds: number[]; depth: number; nodes: GraphNode[]; edges: GraphEdge[] } = {
      seeds: [],
      depth: 1,
      nodes: [],
      edges: [],
    };
    if (catalogEntityIds.length) {
      graph = await this.graphService.forEntities(catalogEntityIds, { depth: 1 });
    }

    // News 流：source_article 最近发布
    const recentNews = await this.db
      .select({ id: sourceArticles.id, title: sourceArticles.title, url: sourceArticles.url, sourceOrg: sourceArticles.sourceOrg, publishedAt: sourceArticles.publishedAt })
      .from(sourceArticles)
      .where(eq(sourceArticles.datasetId, ds.id))
      .orderBy(desc(sourceArticles.publishedAt))
      .limit(10);

    // Fact Change 流：fact_change join entity，按实体归属语料域过滤（不再受首页分类配置限制，展示语料域全部变化）
    const fromF = alias(facts, 'f_from');
    const toF = alias(facts, 'f_to');
    // 首页目录用的分类集（homeShow>0，如瓯菜首页只展示 culture.food）
    const homeCategoryIds = links.map((l) => Number(l.categoryId));
    const recentChanges =
      ds.id != null
        ? await this.db
            .select({
              id: factChanges.id,
              entityId: entities.id,
              entityName: entities.name,
              entitySlug: entities.slug,
              changeType: factChanges.changeType,
              occurredAt: factChanges.occurredAt,
              summary: factChanges.summary,
              fromStatement: fromF.statement,
              toStatement: toF.statement,
              toDimension: toF.dimension,
            })
            .from(factChanges)
            .innerJoin(entities, eq(factChanges.entityId, entities.id))
            .leftJoin(fromF, eq(factChanges.fromFactId, fromF.id))
            .leftJoin(toF, eq(factChanges.toFactId, toF.id))
            .where(
              and(
                eq(entities.originDatasetId, ds.id),
                // 只展示首页关联分类（food）的事实变化，否则被迁到 geo/org 的实体（温州、瓯江…）也会冒出
                homeCategoryIds.length ? inArray(entities.categoryId, homeCategoryIds) : eq(entities.id, -1),
              ),
            )
            .orderBy(desc(factChanges.occurredAt))
            .limit(16)
        : [];

    // 语料域绑定的分类集合：待人工确认 / 有效事实统计都按它过滤（与首页目录归属一致）
    const allLinked = await this.db
      .select({ categoryId: datasetCategories.categoryId })
      .from(datasetCategories)
      .where(eq(datasetCategories.datasetId, ds.id));
    const linkedCategoryIds = allLinked.map((r) => Number(r.categoryId));

    const [{ value: activeFacts }] = await this.db
      .select({ value: count() })
      .from(facts)
      .innerJoin(entities, eq(facts.entityId, entities.id))
      .where(
        and(
          eq(facts.status, 'active'),
          linkedCategoryIds.length ? inArray(entities.categoryId, linkedCategoryIds) : eq(entities.id, -1),
        ),
      );

    // 今日新闻 / 待人工确认（口径统一北京时间）
    const today = todayInShanghai();
    const [{ value: todayNews }] = await this.db
      .select({ value: count() })
      .from(sourceArticles)
      .where(and(eq(sourceArticles.datasetId, ds.id), sql`DATE(${sourceArticles.publishedAt}) = ${today}`));
    // 今日变更：数据库全量计数（与变更页同源），不再从 recentChanges 的 16 条截断子集过滤
    let todayChanges = 0;
    if (ds.id != null) {
      const [changeRow] = await this.db
        .select({ value: count() })
        .from(factChanges)
        .innerJoin(entities, eq(factChanges.entityId, entities.id))
        .where(
          and(
            eq(entities.originDatasetId, ds.id),
            eq(factChanges.occurredAt, today),
            homeCategoryIds.length ? inArray(entities.categoryId, homeCategoryIds) : eq(entities.id, -1),
          ),
        );
      todayChanges = Number(changeRow?.value ?? 0);
    }
    const [{ value: pendingReview }] = await this.db
      .select({ value: count() })
      .from(extractionDrafts)
      .innerJoin(extractionRuns, eq(extractionDrafts.runId, extractionRuns.id))
      .innerJoin(entities, eq(extractionDrafts.entityId, entities.id))
      .where(
        and(
          eq(extractionRuns.datasetId, ds.id),
          eq(extractionDrafts.status, 'pending'),
          linkedCategoryIds.length ? inArray(entities.categoryId, linkedCategoryIds) : eq(entities.id, -1),
        ),
      );

    return {
      dataset: { id: ds.id, code: ds.code, name: ds.name, description: ds.description ?? null },
      directories,
      graph,
      news: recentNews.map((n) => ({
        id: n.id,
        title: n.title,
        url: n.url,
        sourceOrg: n.sourceOrg,
        publishedAt: n.publishedAt,
      })),
      changes: recentChanges.map((c) => ({
        id: c.id,
        entityId: c.entityId,
        entityName: c.entityName,
        entitySlug: c.entitySlug,
        changeType: c.changeType,
        occurredAt: c.occurredAt,
        summary: c.summary,
        fromStatement: c.fromStatement,
        toStatement: c.toStatement,
        toDimension: c.toDimension,
      })),
      stats: {
        directories: directories.length,
        entities: directories.reduce((s, d) => s + Number(d.entityTotal), 0),
        facts: Number(activeFacts),
        todayNews: Number(todayNews),
        todayChanges: Number(todayChanges),
        pendingReview: Number(pendingReview),
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 运行总览「抽取草稿 / 待人工复核」的公开口径。
   * 只统计事实(fact) / 事件(event) / 证据(evidence) / 变更(change) 四类知识抽取草稿，
   * 排除图谱关系(relation) 与实体候选(entity)——图谱另计，不混入抽取统计。
   */
  async draftStats() {
    const kinds = sql`${extractionDrafts.targetType} IN ('fact','event','evidence','change')`;
    const [[totalRow], [pendingRow]] = await Promise.all([
      this.db.select({ value: count() }).from(extractionDrafts).where(kinds),
      this.db
        .select({ value: count() })
        .from(extractionDrafts)
        .where(and(kinds, eq(extractionDrafts.status, 'pending'))),
    ]);
    return { drafts: Number(totalRow.value), pendingReview: Number(pendingRow.value) };
  }

  /** 语料域公开图谱（前台只读浏览）：按度数取 top N 节点的概览子图 */
  async datasetGraph(datasetCode: string, limit = 80) {
    const [ds] = await this.db
      .select({ id: datasets.id, code: datasets.code, name: datasets.name })
      .from(datasets)
      .where(eq(datasets.code, datasetCode))
      .limit(1);
    if (!ds) throw new NotFoundException('语料域不存在');
    const graph = await this.graphService.overview(Number(ds.id), limit);
    return {
      dataset: { id: Number(ds.id), code: ds.code, name: ds.name },
      ...graph,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 语料域内某个实体的多跳子图（公开图谱页「点击节点扩到多跳」用）。
   * 安全边界：只返回该语料域**已发布**实体的节点与边（草稿/归档实体不外泄），
   * 因此后台的 `/api/graph/*` 保持鉴权、不必开 @Public()。
   */
  async datasetEntityGraph(datasetCode: string, entityId: number, depth = 3) {
    const [ds] = await this.db
      .select({ id: datasets.id, code: datasets.code, name: datasets.name })
      .from(datasets)
      .where(eq(datasets.code, datasetCode))
      .limit(1);
    if (!ds) throw new NotFoundException('语料域不存在');

    const rows = await this.db
      .select({ id: entities.id })
      .from(entities)
      .where(
        and(
          eq(entities.originDatasetId, Number(ds.id)),
          eq(entities.status, 'published'),
          isNull(entities.deletedAt),
        ),
      );
    const published = new Set(rows.map((r) => Number(r.id)));
    if (!published.has(entityId)) throw new NotFoundException('实体不存在或未发布');

    const g = await this.graphService.entityGraph(entityId, { depth: Math.min(Math.max(depth, 1), 3) });
    // 概念节点统一为负 id（-graph_node.id）：先保留，随后按「边可达性」收敛掉孤立节点
    const nodes = g.nodes.filter((n) => n.id < 0 || published.has(n.id));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = g.edges.filter((e) => ids.has(e.head) && ids.has(e.tail));
    const used = new Set<number>([entityId]);
    for (const e of edges) {
      used.add(e.head);
      used.add(e.tail);
    }
    return {
      center: entityId,
      depth: g.depth,
      direction: g.direction,
      nodes: nodes.filter((n) => used.has(n.id)),
      edges,
    };
  }

  private async articles(entityId: number) {
    return this.db
      .select({
        id: sourceArticles.id,
        title: sourceArticles.title,
        url: sourceArticles.url,
        sourceOrg: sourceArticles.sourceOrg,
        publishedAt: sourceArticles.publishedAt,
        batch: sourceArticles.batch,
      })
      .from(entityArticles)
      .innerJoin(sourceArticles, eq(entityArticles.articleId, sourceArticles.id))
      .where(eq(entityArticles.entityId, entityId))
      .orderBy(desc(sourceArticles.publishedAt));
  }

  private async dimensions() {
    return this.factService.listDimensions();
  }

  /**
   * sitemap：已发布实体清单（v2：dataset 段 = 实体溯源语料域）
   * - 只收「≥1 条现行事实」的实体：空实体不进索引，避免批量提交低质量空页（P1-3）
   * - lastmod 取「现行事实最新更新时间」与「变更流最新变更时间」的较大者（P2-4：
   *   原实现直接用 entity.updated_at，导致 91% 条目日期集中在同一天）
   */
  async sitemap() {
    const factAgg = this.db
      .select({
        entityId: facts.entityId,
        last: sql<string>`DATE_FORMAT(MAX(${facts.updatedAt}), '%Y-%m-%d')`.as('last'),
      })
      .from(facts)
      .where(eq(facts.status, 'active'))
      .groupBy(facts.entityId)
      .as('fa');

    // 变更流：基线事实不写变更记录，只有新闻驱动的变更才进 fact_change，
    // 因此它是"内容真正发生变化的最近时间"，比 facts.updatedAt 更贴近实际（P2-4）
    const changeAgg = this.db
      .select({
        entityId: factChanges.entityId,
        last: sql<string>`DATE_FORMAT(MAX(${factChanges.createdAt}), '%Y-%m-%d')`.as('clast'),
      })
      .from(factChanges)
      .groupBy(factChanges.entityId)
      .as('ca');

    return this.db
      .select({
        datasetCode: datasets.code,
        slug: entities.slug,
        // 两者都是 'YYYY-MM-DD' 字符串，GREATEST 按字典序比较即为时间序
        updatedAt: sql<string>`GREATEST(${factAgg.last}, COALESCE(${changeAgg.last}, ${factAgg.last}))`.as(
          'lastmod',
        ),
        revision: entities.revision,
      })
      .from(entities)
      .innerJoin(datasets, eq(entities.originDatasetId, datasets.id))
      .innerJoin(factAgg, eq(factAgg.entityId, entities.id))
      .leftJoin(changeAgg, eq(changeAgg.entityId, entities.id))
      .where(and(eq(entities.status, 'published'), isNull(entities.deletedAt)))
      .orderBy(desc(sql`lastmod`));
  }

  /**
   * 站点实体口径的唯一权威来源：SSG 构建期与运行期（SSR / JSON 端点 / 前端 SPA）共用同一份数字。
   * - publishedEntities：全部已发布实体（status='published' AND deleted_at IS NULL），
   *   与 /catalog、数据库 COUNT 一致，是本仓库唯一权威统计口径；
   * - indexedEntities：进入 sitemap 索引的实体数（已发布 ∧ ≥1 条现行事实 ∧ 有溯源语料域），
   *   属抓取质量策略口径（空实体不进索引），不是统计口径，仅供解释数字差异；
   * - factCount：现行事实数（facts.status='active'），供总览页复用；
   * - datasetCode：主溯源语料域编码，供 siteSummary 复用，避免重复查询 sitemap。
   */
  async siteStats() {
    const [pubRows, factRows, rows] = await Promise.all([
      this.db
        .select({ value: count() })
        .from(entities)
        .where(and(eq(entities.status, 'published'), isNull(entities.deletedAt))),
      this.db.select({ value: count() }).from(facts).where(eq(facts.status, 'active')),
      this.sitemap(),
    ]);
    const datasetCode = [...new Set(rows.map((r) => r.datasetCode))].filter(Boolean)[0];
    return {
      publishedEntities: Number(pubRows[0]?.value ?? 0),
      indexedEntities: rows.length,
      factCount: Number(factRows[0]?.value ?? 0),
      datasetCode,
    };
  }

  /**
   * 站点首页摘要：首页 SSR 与 JSON 端点共用。
   * 实体数取自 siteStats()（唯一口径 = 全部已发布实体），并附带进入索引的实体数便于解释差异。
   */
  async siteSummary() {
    const stats = await this.siteStats();
    const datasetCode = stats.datasetCode;
    let datasetName: string | undefined;
    if (datasetCode) {
      const [ds] = await this.db
        .select({ name: datasets.name })
        .from(datasets)
        .where(and(eq(datasets.code, datasetCode), eq(datasets.status, 'active')))
        .limit(1);
      datasetName = ds?.name;
    }
    return {
      datasetCode,
      datasetName,
      entityCount: stats.publishedEntities,
      indexedEntityCount: stats.indexedEntities,
    };
  }

  /** 站点首页服务端渲染版（爬虫 / ?format=html 直出；聚合入口，无交互） */
  async siteHtml(baseUrl: string): Promise<{ html: string; etag: string }> {
    const s = await this.siteSummary();
    return {
      html: renderSiteHomeHtml(baseUrl, s),
      etag: `"site-${s.entityCount}-${s.datasetCode ?? 'none'}"`,
    };
  }

  /** sitemap.xml（W3C 日期格式 lastmod，供搜索引擎抓取） */
  async sitemapXml(baseUrl: string): Promise<string> {
    const rows = await this.sitemap();
    // 站点级入口（首页 + 辅助路由 + 语料首页）：此前只收录实体档案页，导致没有可索引的顶层节点
    const datasetCodes = [...new Set(rows.map((r) => r.datasetCode))];
    const today = todayInShanghai();
    const entries = [
      `  <url><loc>${baseUrl}/overview</loc><lastmod>${today}</lastmod></url>`,
      `  <url><loc>${baseUrl}/methodology/</loc><lastmod>${today}</lastmod></url>`,
      `  <url><loc>${baseUrl}/catalog</loc><lastmod>${today}</lastmod></url>`,
      `  <url><loc>${baseUrl}/topics</loc><lastmod>${today}</lastmod></url>`,
      `  <url><loc>${baseUrl}/facts</loc><lastmod>${today}</lastmod></url>`,
      `  <url><loc>${baseUrl}/news</loc><lastmod>${today}</lastmod></url>`,
      `  <url><loc>${baseUrl}/changes</loc><lastmod>${today}</lastmod></url>`,
      `  <url><loc>${baseUrl}/publications</loc><lastmod>${today}</lastmod></url>`,
      `  <url><loc>${baseUrl}/distribution</loc><lastmod>${today}</lastmod></url>`,
      `  <url><loc>${baseUrl}/observatory</loc><lastmod>${today}</lastmod></url>`,
      ...datasetCodes.map((c) => `  <url><loc>${baseUrl}/archive/home/${c}</loc><lastmod>${today}</lastmod></url>`),
    ].join('\n');
    const seen = new Set<string>();
    const urls = rows
      .map((r) => {
        const loc = `${baseUrl}/archive/${r.datasetCode}/${r.slug}`;
        // 同一语料域内同 slug 的重复实体只提交一次（P2-3）
        if (seen.has(loc)) return '';
        seen.add(loc);
        const lastmod = r.updatedAt ? String(r.updatedAt).slice(0, 10) : '';
        return `  <url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
      })
      .filter(Boolean)
      .join('\n');

    // 单条事实页（/archive/:dataset/:slug/fact/:code）：可被稳定引用，一并进入 sitemap
    const seenFact = new Set<string>();
    const factUrls = (await this.factPages())
      .map((r) => {
        const loc = `${baseUrl}/archive/${r.datasetCode}/${r.slug}/fact/${encodeURIComponent(r.code)}`;
        if (seenFact.has(loc)) return '';
        seenFact.add(loc);
        const lastmod = r.updatedAt ? String(r.updatedAt).slice(0, 10) : '';
        return `  <url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
      })
      .filter(Boolean)
      .join('\n');

    // 单条变更记录页（/archive/:dataset/:slug/change/:id）：与事实页同样可被稳定引用
    const seenChange = new Set<string>();
    const changeUrls = (await this.changePages())
      .map((r) => {
        const loc = `${baseUrl}/archive/${r.datasetCode}/${r.slug}/change/${r.id}`;
        if (seenChange.has(loc)) return '';
        seenChange.add(loc);
        return `  <url><loc>${loc}</loc>${r.lastmod ? `<lastmod>${r.lastmod}</lastmod>` : ''}</url>`;
      })
      .filter(Boolean)
      .join('\n');

    // 主题聚合页（/facts/:topicId）：一个主题跨文章合并后的全部事实，可被直接引用
    const topicUrls = (await this.topicPages())
      // 未签发主题不进 sitemap（PRD R05 / AT08）
      .filter((r) => !publishGateEnabled() || r.publicationStatus === 'published')
      .map((r) => {
        const lastmod = r.signature.split('|')[1]?.slice(0, 10) ?? '';
        return `  <url><loc>${baseUrl}/facts/${r.topicId}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
      })
      .join('\n');

    // 文章事实稿页（/articles/:articleId）：一篇文章抽取的全部事实（主题页的下钻页）
    const articleUrls = (await this.articleFactPages())
      .map((r) => {
        const lastmod = r.signature.split('|')[1]?.slice(0, 10) ?? '';
        return `  <url><loc>${baseUrl}/articles/${r.articleId}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
      })
      .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n${urls}\n${factUrls}\n${changeUrls}\n${topicUrls}\n${articleUrls}\n</urlset>`;
  }

  /**
   * robots.txt：放开档案页与自家 GEO 出口（sitemap / feed / catalog / 实体 JSON / 快照），
   * 只拦后台管理 API。robots 按最长匹配优先，Allow 必须写在 Disallow 之前。
   */
  robotsTxt(baseUrl: string): string {
    return [
      'User-agent: *',
      'Allow: /archive/',
      'Allow: /api/archive/sitemap.xml',
      'Allow: /api/archive/feed.xml',
      'Allow: /api/archive/feed.json',
      'Allow: /api/archive/catalog.json',
      'Allow: /api/archive/wenzhou-city-trust/',
      'Allow: /api/archive/article/',
      'Allow: /api/archive/topic/',
      'Allow: /articles/',
      'Disallow: /api/',
      '',
      `Sitemap: ${baseUrl}/sitemap.xml`,
      '',
    ].join('\n');
  }

  /**
   * llms.txt：面向 AI 的站点使用说明（P2-5）。
   * 声明索引入口、结构化数据端点、URN 规范与引用建议，让模型知道"该怎么用这个站"。
   */
  llmsTxt(baseUrl: string): string {
    return [
      '# 温州事实档案（温州有据）',
      '',
      '> 基于温州本地新闻报道抽取的机器可读事实档案。每条事实均附逐字原文证据、模型置信度（非可信度）、',
      '> 物理锚点（原文 span 区间 + span_hash）与 URN 实体标识，全部公开只读，供搜索引擎与',
      '> AI 引用核验。站点内容为中文。',
      '',
      '## 索引入口',
      `- sitemap：${baseUrl}/sitemap.xml`,
      `- robots：${baseUrl}/robots.txt`,
      `- 全量目录：${baseUrl}/api/archive/catalog.json`,
      `- 变更流（近 30 天）：${baseUrl}/api/archive/feed.json · ${baseUrl}/api/archive/feed.xml`,
      `- 方法论与核验（信源/流程/span_hash）：${baseUrl}/methodology/`,
      '',
      '## 人类可读页面（零 JS 可读，启用 JS 自动升级交互版）',
      `- 实体目录：${baseUrl}/catalog`,
      `- 实时新闻流：${baseUrl}/news`,
      `- 事实变更：${baseUrl}/changes`,
      '',
      '## 实体档案',
      `- 人类可读页面：${baseUrl}/archive/{dataset}/{slug}`,
      `- 同一实体的 JSON：${baseUrl}/api/archive/{dataset}/{slug}.json`,
      `- 事实子集：${baseUrl}/api/archive/{dataset}/{slug}/facts`,
      `- 证据子集：${baseUrl}/api/archive/{dataset}/{slug}/evidence`,
      `- 证据原文快照：${baseUrl}/api/archive/article/{id}/raw（noindex，仅溯源用）`,
      '',
      '## 关系图谱',
      `- 语料域全景：${baseUrl}/api/archive/{dataset}/graph`,
      `- 实体多跳子图：${baseUrl}/api/archive/{dataset}/graph/entity/{entityId}?depth=3`,
      '',
      '## 数据规范',
      '- URN：`{dataset}:{category}:{name}`，如 `wenzhou-city-trust:geo.road:人民中路`，跨系统唯一标识实体。',
      '- confidence：0–1，模型自评的置信评分（非可信度），可用于加权排序。',
      '- status：active（现行）/ superseded（被新版本取代，保留备查）。',
      '- 证据锚点：quote 为逐字原文引句；span 区间 + span_hash 可校验原文未被篡改。',
      '',
      '## 引用建议',
      '- 引用某条事实时，请同时给出该事实的 code、URN 与逐字证据引句，便于读者核验。',
      '- 事实会随时间更新：请以 status=active 的版本为准，superseded 仅作历史参考。',
      '- 本站不生产事实，仅对 温州网（66wz.com）及其子频道（含温州都市报 /wzdsb/）与温州申创「世界美食之都」官网（wzfood.net）的公开报道做结构化与溯源。',
      '',
    ].join('\n');
  }

  /** 档案页服务端渲染版（同一数据源，供爬虫 / ?format=html） */
  async pageHtml(datasetCode: string, slug: string, baseUrl: string, spaAssets = '') {
    const page = await this.page(datasetCode, slug);
    return {
      html: renderArchiveHtml(page, baseUrl, spaAssets),
      etag: `W/"arch-${page.entity.id}-${page.entity.revision}"`,
    };
  }

  /** 原文快照（证据溯源）：source_article_body.body_raw 为入库时存档的原文副本 */
  async articleSnapshot(id: number) {
    const [article] = await this.db
      .select()
      .from(sourceArticles)
      .where(eq(sourceArticles.id, id))
      .limit(1);
    if (!article) throw new NotFoundException('文章不存在');
    const [body] = await this.db
      .select({ bodyRaw: sourceArticleBodies.bodyRaw, bodySlice: sourceArticleBodies.bodySlice })
      .from(sourceArticleBodies)
      .where(eq(sourceArticleBodies.articleId, id))
      .limit(1);
    return {
      title: article.title,
      url: article.url,
      sourceOrg: article.sourceOrg,
      sourceSite: article.sourceSite,
      publishedAt: article.publishedAt,
      fetchedAt: article.fetchedAt,
      body: body?.bodyRaw || body?.bodySlice || '',
    };
  }

  /** 实体发布/编辑后主动失效缓存 */
  async invalidate(entityId: number) {
    await this.cache.delPrefix(`archive:${entityId}:`);
  }

  // ---------------------------------------------------------------- 公开变化流出口

  /**
   * 变化流的公共筛选条件（扁平分页与按文章分页共用）。
   *
   * 返回的 fromF/toF 是关键词搜索用到的 fact 别名，调用方的查询必须使用同一组别名，
   * 否则 where 里的引用会指向另一个 join。
   */
  private changesWhere(changeType?: string, keyword?: string, includeSystem = false) {
    // 实体全局唯一，只记录首次来源语料域（origin_dataset_id），档案页链接也按它生成
    const fromF = alias(facts, 'f_from');
    const toF = alias(facts, 'f_to');

    // 系统维护类变更 = 无来源文章 AND 带维护标记（脚本回填会写 audit=fix_backfill、
    // kind=*backfill 或 repair=*）。只隐藏前端无法展示来源、纯属修复痕迹的记录；
    // 有 article_id 的回填记录会被保留，因为它们仍有可展示的原文。
    // JSON_EXTRACT 对 NULL/缺字段返回 NULL，必须用 COALESCE 兜底；否则 false OR NULL = NULL，
    // 外层 NOT(NULL) 仍为 NULL，会把所有 mechanism_json 不含这些标记的正常记录一起过滤掉。
    const systemChange = sql`(
      ${factChanges.articleId} IS NULL
      AND (
        COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${factChanges.mechanismJson}, '$.audit')), '') = 'fix_backfill'
        OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${factChanges.mechanismJson}, '$.kind')), '') LIKE '%backfill%'
        OR JSON_UNQUOTE(JSON_EXTRACT(${factChanges.mechanismJson}, '$.repair')) IS NOT NULL
      )
    )`;

    // 筛选在服务端完成：分类（change_type）、系统维护标记与关键词（摘要/实体名/前后陈述），
    // total 与 items 必须用同一个 where，否则会出现「表里 30 条、抬头写 1 万条」的口径分裂。
    const kw = keyword?.trim();
    const where = and(
      // change_type 是 enum 列，参数化比较避免类型与非法值问题
      changeType ? sql`${factChanges.changeType} = ${changeType}` : undefined,
      // 默认排除系统维护类变更；includeSystem=true 时保留，供审计/排查使用
      includeSystem ? undefined : sql`NOT ${systemChange}`,
      kw
        ? or(
            like(factChanges.summary, `%${kw}%`),
            like(entities.name, `%${kw}%`),
            like(fromF.statement, `%${kw}%`),
            like(toF.statement, `%${kw}%`),
          )
        : undefined,
    );
    return { where, fromF, toF };
  }

  /**
   * /api/changes：变化流分页（供前端页面）。
   *
   * includeSystem=false（默认）时过滤「系统维护类变更」。
   * 这类记录由回填/修复脚本直接写库产生（fix_backfill_change_edges.cjs、
   * reaudit_gray_corroborate.cjs 等），没有关联 source_article，前端拿不到来源文章，
   * 会逐条渲染成「未命名来源 · 变更 #id」，把正常发布记录刷屏。
   *
   * 判定是「无来源文章」AND「带维护标记」，两个条件同时成立才过滤：
   * - 只看维护标记会连带隐藏 389 条有真实来源、只是被脚本修正过的历史记录；
   * - 只看 article_id IS NULL 会误伤人工退役等合法的无来源变更。
   */
  async listChangesPage(
    page = 1,
    pageSize = 20,
    changeType?: string,
    keyword?: string,
    includeSystem = false,
  ) {
    const safePage = Math.max(1, Number(page) || 1);
    const safeSize = Math.min(Math.max(1, Number(pageSize) || 20), 100);
    const offset = (safePage - 1) * safeSize;

    const { where, fromF, toF } = this.changesWhere(changeType, keyword, includeSystem);

    // 佐证类变更「本次新增来源的原文引句」：取本次变更的文章（fact_change.article_id）中，
    // 经 fact_evidence 关联到被佐证事实（to_fact_id）的那条证据引句。
    // 佐证不产生新版本（from_fact_id 恒为 NULL），前端抽屉需要它来区分「现行口径」与「本次新增来源」，
    // 否则两侧会显示同一句陈述、零信息量。非佐证变更该子查询返回 NULL。
    const corroborateQuote = sql<string | null>`(
      SELECT ${evidence.quote}
      FROM ${evidence}
      INNER JOIN ${factEvidences} ON ${factEvidences.evidenceId} = ${evidence.id}
      WHERE ${evidence.articleId} = ${factChanges.articleId}
        AND ${factEvidences.factId} = ${factChanges.toFactId}
      ORDER BY ${evidence.id} DESC
      LIMIT 1
    )`;

    const [{ value: total }] = await this.db
      .select({ value: count() })
      .from(factChanges)
      .innerJoin(entities, eq(factChanges.entityId, entities.id))
      .leftJoin(fromF, eq(factChanges.fromFactId, fromF.id))
      .leftJoin(toF, eq(factChanges.toFactId, toF.id))
      .where(where);

    const items = await this.db
      .select({
        id: factChanges.id,
        entityId: entities.id,
        entityName: entities.name,
        entitySlug: entities.slug,
        datasetCode: datasets.code,
        changeType: factChanges.changeType,
        summary: factChanges.summary,
        rationale: factChanges.rationale,
        occurredAt: factChanges.occurredAt,
        createdAt: factChanges.createdAt,
        fromFactId: factChanges.fromFactId,
        toFactId: factChanges.toFactId,
        fromStatement: fromF.statement,
        fromFactCode: fromF.code,
        toStatement: toF.statement,
        toDimension: toF.dimension,
        toFactCode: toF.code,
        // 退役类变更没有「新版本」（to_fact_id 为空），被退役的事实挂在 from 侧；
        // 统一补一个"本条变更指向的事实"，免得前端两条链各写一遍取词逻辑。
        factStatement: sql<string | null>`COALESCE(${toF.statement}, ${fromF.statement})`,
        factCode: sql<string | null>`COALESCE(${toF.code}, ${fromF.code})`,
        // 佐证类专用：本次新增来源引句（见上方子查询）与被佐证事实的来源计数
        corroborateQuote,
        corroborateCount: toF.corroborateCount,
        articleTitle: sourceArticles.title,
        articleUrl: sourceArticles.url,
      })
      .from(factChanges)
      .innerJoin(entities, eq(factChanges.entityId, entities.id))
      .leftJoin(datasets, eq(datasets.id, entities.originDatasetId))
      .leftJoin(fromF, eq(factChanges.fromFactId, fromF.id))
      .leftJoin(toF, eq(factChanges.toFactId, toF.id))
      .leftJoin(sourceArticles, eq(factChanges.articleId, sourceArticles.id))
      .where(where)
      .orderBy(desc(factChanges.createdAt), desc(factChanges.id))
      .limit(safeSize)
      .offset(offset);

    return { items, total, page: safePage, pageSize: safeSize };
  }

  /**
   * /api/changes?groupBy=article：按「发布记录」分页（供事实发布记录页）。
   *
   * 页面展示单位是「一篇文章入库后产生的一批事实变更」，而 fact_change 一行是一条变更。
   * 直接对变更分页会让一页 100 条只覆盖少数几篇文章（实测最近 100 条仅涉及 3 篇），
   * 前端聚合后看起来像「只加载了 3 条」。这里先按文章取一页，再取这些文章的全部变更，
   * 与实时新闻流「1 条记录 = 1 张卡片」的分页口径一致。
   *
   * 分组键：article_id；无来源文章的变更（人工退役等）用 -id 作伪文章键，各自成组。
   * total 返回发布记录（文章）数，不是变更条数。
   */
  async listPublicationPage(
    page = 1,
    pageSize = 20,
    changeType?: string,
    keyword?: string,
    includeSystem = false,
  ) {
    const safePage = Math.max(1, Number(page) || 1);
    // 一组会带回该文章的全部变更，这里比扁平分页更保守，避免单页响应过大
    const safeSize = Math.min(Math.max(1, Number(pageSize) || 20), 50);
    const offset = (safePage - 1) * safeSize;

    const { where, fromF, toF } = this.changesWhere(changeType, keyword, includeSystem);
    // 「未命名来源」（无 article_id 的系统记录，如 retire_expired 自动退役留痕）不进入发布记录页；
    // includeSystem=true（审计模式）时保留
    const pubWhere = includeSystem ? where : and(where, isNotNull(factChanges.articleId));
    // 无来源文章的变更没有 article_id，用负 id 生成互不相同的伪分组键
    const groupKey = sql`COALESCE(${factChanges.articleId}, -${factChanges.id})`;

    // 发布记录总数 = 分组数（与 listChangesPage 的「变更条数」口径不同）
    const groupSub = this.db
      .select({ gkey: groupKey })
      .from(factChanges)
      .innerJoin(entities, eq(factChanges.entityId, entities.id))
      .leftJoin(fromF, eq(factChanges.fromFactId, fromF.id))
      .leftJoin(toF, eq(factChanges.toFactId, toF.id))
      .where(pubWhere)
      .groupBy(groupKey)
      .as('chg_groups');
    const [{ value: total }] = await this.db.select({ value: count() }).from(groupSub);

    // 本页的发布记录：按组内最新变更时间倒序（与实时新闻流按 pubDate 倒序同理，
    // 保证首屏按「最近发生了什么」排列，而不是按扫描顺序）
    const groupRows = await this.db
      .select({
        gkey: groupKey,
        lastAt: sql<string | null>`MAX(${factChanges.createdAt})`,
      })
      .from(factChanges)
      .innerJoin(entities, eq(factChanges.entityId, entities.id))
      .leftJoin(fromF, eq(factChanges.fromFactId, fromF.id))
      .leftJoin(toF, eq(factChanges.toFactId, toF.id))
      .where(pubWhere)
      .groupBy(groupKey)
      .orderBy(desc(sql`MAX(${factChanges.createdAt})`), desc(sql`MAX(${factChanges.id})`))
      .limit(safeSize)
      .offset(offset);

    const keys = groupRows.map((g) => Number(g.gkey)).filter((k) => Number.isFinite(k));
    if (!keys.length) return { groups: [], items: [], total, page: safePage, pageSize: safeSize };

    // 只取本页涉及的分组：正数 = article_id，负数 = 单条无来源变更的 id
    const keyCond = or(
      ...keys.map((k) => (k > 0 ? eq(factChanges.articleId, k) : eq(factChanges.id, -k))),
    );

    const rows = await this.db
      .select({
        id: factChanges.id,
        entityId: entities.id,
        entityName: entities.name,
        entitySlug: entities.slug,
        datasetCode: datasets.code,
        changeType: factChanges.changeType,
        summary: factChanges.summary,
        rationale: factChanges.rationale,
        occurredAt: factChanges.occurredAt,
        createdAt: factChanges.createdAt,
        fromFactId: factChanges.fromFactId,
        toFactId: factChanges.toFactId,
        fromStatement: fromF.statement,
        fromFactCode: fromF.code,
        toStatement: toF.statement,
        toDimension: toF.dimension,
        toFactCode: toF.code,
        // 退役类变更没有「新版本」（to_fact_id 为空），被退役的事实挂在 from 侧；
        // 统一补一个"本条变更指向的事实"，免得前端两条链各写一遍取词逻辑。
        factStatement: sql<string | null>`COALESCE(${toF.statement}, ${fromF.statement})`,
        factCode: sql<string | null>`COALESCE(${toF.code}, ${fromF.code})`,
        articleTitle: sourceArticles.title,
        articleUrl: sourceArticles.url,
        // 来源机构（如「温州日报」），与实时新闻流展示的 sourceOrg 口径一致
        sourceOrg: sourceArticles.sourceOrg,
        gkey: groupKey,
      })
      .from(factChanges)
      .innerJoin(entities, eq(factChanges.entityId, entities.id))
      .leftJoin(datasets, eq(datasets.id, entities.originDatasetId))
      .leftJoin(fromF, eq(factChanges.fromFactId, fromF.id))
      .leftJoin(toF, eq(factChanges.toFactId, toF.id))
      .leftJoin(sourceArticles, eq(factChanges.articleId, sourceArticles.id))
      .where(and(where, keyCond))
      .orderBy(desc(factChanges.createdAt), desc(factChanges.id));

    const byGroup = new Map<number, typeof rows>();
    for (const r of rows) {
      const k = Number(r.gkey);
      const list = byGroup.get(k);
      if (list) list.push(r);
      else byGroup.set(k, [r]);
    }

    const groups = groupRows.map((g) => {
      const k = Number(g.gkey);
      const items = byGroup.get(k) ?? [];
      return {
        key: String(k),
        articleId: k > 0 ? k : null,
        articleTitle: items.find((i) => i.articleTitle)?.articleTitle ?? null,
        articleUrl: items.find((i) => i.articleUrl)?.articleUrl ?? null,
        // 来源机构与实时新闻流一致：取报道自身的 source_org，而不是链接域名
        sourceOrg: items.find((i) => i.sourceOrg)?.sourceOrg ?? null,
        createdAt: items[0]?.createdAt ?? g.lastAt,
        items,
      };
    });

    return { groups, items: rows, total, page: safePage, pageSize: safeSize };
  }

  /** /api/changes.json：机器出口，最近 200 条 */
  async changesJson() {
    const [res] = (await this.db.execute(sql`
      SELECT fc.id, e.urn entity_urn, ft.dimension predicate,
             fc.from_fact_id old_fact_id, fc.to_fact_id new_fact_id,
             fc.summary, fc.occurred_at changed_at, sa.url evidence_url, fc.change_type change_type
      FROM fact_change fc
      JOIN entity e ON e.id = fc.entity_id
      LEFT JOIN fact ft ON ft.id = fc.to_fact_id
      LEFT JOIN source_article sa ON sa.id = fc.article_id
      ORDER BY fc.created_at DESC, fc.id DESC
      LIMIT 200
    `)) as unknown as [Record<string, unknown>[], unknown];
    return (res ?? []).map((r) => ({
      id: r.id,
      entity_urn: r.entity_urn,
      predicate: r.predicate,
      old_fact_id: r.old_fact_id,
      new_fact_id: r.new_fact_id,
      summary: r.summary,
      changed_at: r.changed_at,
      evidence_url: r.evidence_url,
      change_type: r.change_type,
    }));
  }

  /**
   * /api/feed.json：近 30 天有变化的实体 + 最近变化时间，并追加该实体**最近一条发布记录**。
   * 追加 `latestChange`（含变化类型、变更前后陈述、单条事实编号与路径），使条目回答"变了什么"，
   * 而不仅是"哪个实体更新了"。原有字段保留不变（追加方式，不破坏既有调用方）。
   */
  async feedJson() {
    const [res] = (await this.db.execute(sql`
      SELECT e.id, e.urn, e.name, e.slug, d.code datasetCode,
             MAX(fc.created_at) lastChangeAt, COUNT(*) changeCount
      FROM fact_change fc
      JOIN entity e ON e.id = fc.entity_id
      JOIN dataset d ON d.id = e.origin_dataset_id
      WHERE fc.created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        AND e.status = 'published' AND e.deleted_at IS NULL
      GROUP BY e.id, e.urn, e.name, e.slug, d.code
      ORDER BY lastChangeAt DESC
    `)) as unknown as [Record<string, unknown>[], unknown];

    // 每个实体在窗口内 id 最大的一条变更（= 最近一条发布记录）
    const [latest] = (await this.db.execute(sql`
      SELECT fc.entity_id, fc.id, fc.change_type, fc.summary, fc.created_at,
             fto.code to_code, fto.statement to_statement, fto.dimension,
             ffrom.code from_code, ffrom.statement from_statement,
             JSON_UNQUOTE(JSON_EXTRACT(fc.mechanism_json, '$.verdict')) verdict
      FROM fact_change fc
      JOIN (
        SELECT entity_id, MAX(id) mid FROM fact_change
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        GROUP BY entity_id
      ) t ON t.mid = fc.id
      LEFT JOIN fact fto ON fto.id = fc.to_fact_id
      LEFT JOIN fact ffrom ON ffrom.id = fc.from_fact_id
    `)) as unknown as [Record<string, unknown>[], unknown];

    const latestByEntity = new Map<number, Record<string, unknown>>();
    for (const r of latest ?? []) latestByEntity.set(Number(r.entity_id), r);

    return (res ?? []).map((r) => {
      const c = latestByEntity.get(Number(r.id));
      const factCode = (c?.to_code as string | null) ?? (c?.from_code as string | null) ?? null;
      const datasetCode = String(r.datasetCode ?? '');
      const slug = String(r.slug ?? '');
      return {
        id: r.id,
        urn: r.urn,
        name: r.name,
        slug: r.slug,
        datasetCode: r.datasetCode,
        lastChangeAt: r.lastChangeAt,
        changeCount: Number(r.changeCount),
        latestChange: c
          ? {
              id: Number(c.id),
              changeType: String(c.change_type),
              verdict: (c.verdict as string | null) ?? null,
              summary: (c.summary as string | null) ?? null,
              dimension: (c.dimension as string | null) ?? null,
              at: c.created_at,
              fromStatement: (c.from_statement as string | null) ?? null,
              toStatement: (c.to_statement as string | null) ?? null,
              factCode,
              factPath: factCode
                ? `/archive/${encodeURIComponent(datasetCode)}/${encodeURIComponent(slug)}/fact/${encodeURIComponent(factCode)}`
                : null,
            }
          : null,
      };
    });
  }

  /** /api/catalog.json：已发布实体目录 */
  async catalogJson() {
    const [res] = (await this.db.execute(sql`
      SELECT e.id, e.urn, e.name, e.slug, d.code datasetCode,
             c.code categoryCode, c.name categoryName,
             (SELECT COUNT(*) FROM fact f WHERE f.entity_id = e.id AND f.status = 'active') currentFactCount,
             (SELECT COUNT(*) FROM evidence ev WHERE ev.entity_id = e.id AND ev.status = 'active') evidenceCount,
             (SELECT MAX(fc.created_at) FROM fact_change fc WHERE fc.entity_id = e.id) lastChangeAt
      FROM entity e
      JOIN dataset d ON d.id = e.origin_dataset_id
      LEFT JOIN category c ON c.id = e.category_id
      WHERE e.status = 'published' AND e.deleted_at IS NULL
      ORDER BY e.name
    `)) as unknown as [Record<string, unknown>[], unknown];
    return (res ?? []).map((r) => ({
      id: r.id,
      urn: r.urn,
      name: r.name,
      slug: r.slug,
      datasetCode: r.datasetCode,
      categoryCode: r.categoryCode ?? null,
      categoryName: r.categoryName ?? null,
      currentFactCount: Number(r.currentFactCount),
      evidenceCount: Number(r.evidenceCount),
      lastChangeAt: r.lastChangeAt,
    }));
  }

  /**
   * /api/feed.xml：最近有变化的实体订阅源（RSS 2.0）。
   * 条目描述改为"变了什么"（变化类型 + 维度 + 变更前后陈述），链接指向单条事实页（无则回落实体档案页）；
   * `guid` 保持 URN 不变，避免既有订阅者被重复推送。
   */
  async feedXml(baseUrl: string): Promise<string> {
    const items = await this.feedJson();
    const changeLabel: Record<string, string> = {
      new: '新增事实',
      update: '事实更新',
      corroborate: '佐证',
      retire: '退役',
    };
    const pubs = items
      .slice(0, 50)
      .map((r) => {
        const pubDate = r.lastChangeAt
          ? new Date(String(r.lastChangeAt).replace(' ', 'T')).toUTCString()
          : new Date().toUTCString();
        const c = r.latestChange;
        const label = c ? (changeLabel[c.changeType] ?? c.changeType) : '变更';
        const link = c?.factPath
          ? `${baseUrl}${c.factPath}`
          : `${baseUrl}/archive/${String(r.datasetCode ?? '')}/${String(r.slug ?? '')}`;
        // 取词优先级：变更前后陈述（最能说明"变了什么"）→ 佐证/退役类用摘要 → 兜底摘要
        const stmt = c
          ? c.fromStatement && c.toStatement
            ? `${c.fromStatement} → ${c.toStatement}`
            : (c.toStatement ?? c.fromStatement)
          : null;
        const what = c ? (stmt ?? c.summary ?? '') : '';
        const desc = [
          `${r.name}｜${label}${c?.dimension ? `·${c.dimension}` : ''}`,
          what,
          `近 30 天更新 ${r.changeCount} 次`,
        ]
          .filter(Boolean)
          .join(' · ');
        return `    <item>
      <title>${esc(String(r.name))}</title>
      <link>${esc(link)}</link>
      <guid isPermaLink="false">${esc(String(r.urn))}</guid>
      <category>${esc(label)}</category>
      <description>${esc(desc)}</description>
      <pubDate>${pubDate}</pubDate>
      <dc:date>${String(r.lastChangeAt ?? '').slice(0, 10)}</dc:date>
    </item>`;
      })
      .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>温州知识图谱 · 事实变更</title>
  <link>${esc(baseUrl)}</link>
  <description>温州饮食/地理/文化知识库的事实变更订阅源</description>
  <language>zh-CN</language>
${pubs}
</channel>
</rss>`;
  }
}
