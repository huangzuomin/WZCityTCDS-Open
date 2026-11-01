import http from './http';

/**
 * 公开前台的 API 子集：只包含公开只读接口（后端均在 @Public() 的 archive 控制器下）。
 * 后台管理接口（实体/审核/大模型/观测台…）刻意不出现在这里。
 */
const qs = (params: Record<string, unknown>) => {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') sp.append(k, String(v));
  });
  const s = sp.toString();
  return s ? `?${s}` : '';
};

// ---------------------------------------------------------------- 图谱类型

export interface GraphNode {
  /** 实体为正 entity.id；概念为负 -graph_node.id（统一节点空间，符号区分） */
  id: number;
  nodeType: 'entity' | 'concept';
  name: string;
  categoryCode: string | null;
  categoryName: string | null;
  status: string;
  lede: string | null;
  datasetId: number | null;
  slug?: string | null;
  datasetCode?: string | null;
}

export interface GraphEdge {
  id: number;
  head: number;
  tail: number;
  predicate: string;
  label: string;
  predicateRaw: string | null;
  statement: string | null;
  confidence: number;
  corroborateCount: number;
  articleId: number | null;
  evidenceId?: number | null;
  quote?: string | null;
  evidenceCode?: string | null;
  verifyStatus?: 'pending' | 'passed' | 'failed' | null;
}

export interface EntityGraph {
  center: number;
  depth: number;
  direction: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphOverview {
  nodes: GraphNode[];
  edges: GraphEdge[];
  degrees: Record<string, number>;
}

// ---------------------------------------------------------------- 语料域首页

export interface DatasetHomeEntity {
  id: number;
  name: string;
  slug: string;
  lede: string | null;
  factCount: number;
  evidenceCount: number;
}
export interface DatasetHomeDirectory {
  categoryId: number;
  code: string;
  name: string;
  description: string | null;
  homeShow: number;
  entityTotal: number;
  entities: DatasetHomeEntity[];
}
export interface DatasetHomeChange {
  id: number;
  entityId: number;
  entityName: string;
  entitySlug: string;
  changeType: 'new' | 'update' | 'corroborate' | 'retire' | string;
  occurredAt: string | null;
  summary: string | null;
  fromStatement: string | null;
  toStatement: string | null;
  toDimension: string | null;
}
export interface DatasetHome {
  dataset: { id: number; code: string; name: string; description: string | null };
  directories: DatasetHomeDirectory[];
  graph: { seeds: number[]; depth: number; nodes: GraphNode[]; edges: GraphEdge[] };
  news: { id: number; title: string; url: string | null; sourceOrg: string | null; publishedAt: string | null }[];
  changes: DatasetHomeChange[];
  stats: {
    directories: number;
    entities: number;
    facts: number;
    todayNews: number;
    todayChanges: number;
    pendingReview: number;
  };
  generatedAt: string;
}
export const datasetHomeApi = {
  get: (datasetCode: string) => http.get<never, DatasetHome>(`/archive/home/${datasetCode}`),
};

/** 运行总览的抽取草稿统计（公开口径：事实/事件/证据/变更，不含图谱关系与实体候选） */
export interface DraftStats {
  drafts: number;
  pendingReview: number;
}
export const draftStatsApi = {
  get: () => http.get<never, DraftStats>('/archive/stats/drafts'),
};

/**
 * 站点实体统计（SSG 与运行期共用的唯一口径来源）：
 * publishedEntities = 全部已发布实体（与 /catalog、DB COUNT 一致，权威口径）；
 * indexedEntities = 进入 sitemap 索引的实体数（抓取质量策略口径，非统计口径）；
 * factCount = 现行事实数。
 */
export interface SiteStats {
  datasetCode?: string;
  publishedEntities: number;
  indexedEntities: number;
  factCount: number;
}
export const archiveApi = {
  siteStats: () => http.get<never, SiteStats>('/archive/stats/site'),
};

/** 语料域公开图谱（前台只读浏览） */
export interface DatasetGraph extends GraphOverview {
  dataset: { id: number; code: string; name: string };
  generatedAt: string;
}
export const datasetGraphApi = {
  get: (datasetCode: string, limit = 80) =>
    http.get<never, DatasetGraph>(`/archive/${datasetCode}/graph${qs({ limit })}`),
  /**
   * 打开某节点的多跳邻域（公开图谱页"点击节点扩跳"用）。
   * 走公开的 archive 端点，只返回该语料域已发布实体，不触碰后台 /api/graph/*。
   */
  entityGraph: (datasetCode: string, entityId: number, depth = 3) =>
    http.get<never, EntityGraph>(`/archive/${datasetCode}/graph/entity/${entityId}${qs({ depth })}`),
};

// ================================================================
// 公开 demo 展示页只读接口（后端均已 @Public）
// 与后台版（apps/admin/src/api）同构：demo 前台只用到这些只读 GET + mcp 只读工具。
// ================================================================

export interface FactEvidence {
  id: number;
  code: string | null;
  quote: string;
  role: string;
  verifyStatus: string | null;
  qualityGrade: string | null;
  sourceOrg: string | null;
  materialTitle: string | null;
  publishedAt: string | null;
}

export interface FactItem {
  id: number;
  entityId: number;
  code: string | null;
  dimension: string;
  statement: string;
  factType: 'current_state' | 'source_claim' | 'occurred';
  status: string;
  confidence: number;
  version: number;
  firstSeenAt: string | null;
  lastVerifiedAt: string | null;
  arbitrationNote: string | null;
  supersededById: number | null;
  evidences: FactEvidence[];
}

export interface FactChangeRow {
  id: number;
  entityId: number;
  entityName: string;
  entitySlug: string | null;
  datasetCode: string | null;
  changeType: 'new' | 'update' | 'corroborate' | 'retire';
  summary: string | null;
  rationale: string | null;
  occurredAt: string | null;
  createdAt: string;
  fromFactId: number | null;
  toFactId: number | null;
  fromStatement: string | null;
  fromFactCode: string | null;
  toStatement: string | null;
  toDimension: string | null;
  toFactCode: string | null;
  /**
   * 佐证类专用：本次新增来源的原文引句。
   * 取 `fact_change.article_id` 的文章中、经 `fact_evidence` 关联到被佐证事实（to_fact_id）的证据引句。
   * 取不到时为 null（前端回退到原有文案）。
   */
  corroborateQuote?: string | null;
  /** 佐证类专用：被佐证事实的来源计数（fact.corroborate_count） */
  corroborateCount?: number | null;
  /** 本条变更指向的事实：新增/更新/佐证取 to 侧，退役取 from 侧（退役无新版本） */
  factStatement: string | null;
  factCode: string | null;
  articleTitle: string | null;
  articleUrl: string | null;
  /** 来源机构（如「温州日报」）；按文章分页时返回，与实时新闻流的来源口径一致 */
  sourceOrg?: string | null;
}

/**
 * 一组「发布记录」= 一篇文章入库后产生的一批事实变更。
 * 由 /api/changes?groupBy=article 返回，分页与 total 均以组（文章）为单位。
 */
export interface PublicationGroup {
  key: string;
  articleId: number | null;
  articleTitle: string | null;
  articleUrl: string | null;
  /** 来源机构，对应 source_article.source_org */
  sourceOrg: string | null;
  createdAt: string | null;
  items: FactChangeRow[];
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  content: { type: string; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: McpCallResult;
  error?: { code: number; message: string };
}

export interface NewsRunRecord {
  id: number;
  source: 'schedule' | 'manual';
  datasetId: number;
  mode: 'ingest' | 'ingest+run';
  startedAt: string;
  finishedAt: string | null;
  sampled: number;
  created: number;
  skipped: number;
  queueTotal: number;
  done: number;
  failed: number;
  entitiesCreated: number;
  factDrafts: number;
  tokens: number;
  status: 'running' | 'success' | 'error';
  error: string | null;
}

export interface ObservatoryMetrics {
  discoveryLagMin: number | null;
  aiFreshnessLagMin: number | null;
  citationRate: number | null;
  citationRateBase: number;
  citationRateDeltaPp: number | null;
  lastCitation:
    | { at: string; model: string; question: string; cited: 'fact_page' | 'same_domain'; url: string; factUrl: string }
    | null;
}

export interface ObservatoryEventNode {
  label: string;
  at: string | null;
  state: 'done' | 'pending' | 'planned';
}

export interface ObservatoryEventTrack {
  id: string;
  title: string;
  newsUrl: string;
  factId: string;
  factUrl: string;
  factStatement: string | null;
  factEntity: string | null;
  factDimension: string | null;
  isDemo: boolean;
  nodes: ObservatoryEventNode[];
}

export interface ObservatoryQuestionRow {
  id: number;
  question: string;
  expectedAnswer: string;
  byModel: Record<string, string>;
}

export interface ProbeAnswer {
  runId: number;
  modelId: string;
  modelLabel: string;
  cited: 'fact_page' | 'same_domain' | 'other' | 'none';
  matchMethod: 'url_struct' | 'url_text' | 'none';
  sourceUrls: string[] | null;
  matchedUrl: string | null;
  excerpt: string | null;
  rawAnswer: string | null;
  probedAt: string | null;
}

export interface ObservatoryModelColumn {
  id: string;
  label: string;
}

export interface ObservatorySnapshot {
  metrics: ObservatoryMetrics;
  events: ObservatoryEventTrack[];
  questions: ObservatoryQuestionRow[];
  modelColumns: ObservatoryModelColumn[];
  weeklyStats: { label: string; rate: number | null; base: number }[];
  generatedAt: string;
}

export interface ProductionRecord {
  id: number;
  datasetId: number;
  articleId: number | null;
  title: string | null;
  sourceOrg: string | null;
  pubDate: string | null;
  bodyChars: number;
  stage: 'pending' | 'discover' | 'audit' | 'align' | 'fact' | 'done';
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  attempts: number;
  errorMsg: string | null;
  stats: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  llm: { calls: number; errors: number; totalTokens: number; avgLatencyMs: number };
}

export interface ReportEntity {
  name: string;
  type: string;
  confidence: number | null;
  fromModels: string[];
  evidence: string;
  audit: string;
  auditBy?: string | null;
  description?: string | null;
  role?: string | null;
  action: string;
  reason?: string | null;
  candidates?: string[];
  matchedEntityId?: number;
  matchedEntityName?: string;
  createdEntityId?: number;
  judge?: { best: number; confidence: number; reason: string };
}

export interface ReportFact {
  entityId: number;
  entityName: string;
  dimension: string;
  statement: string;
  quote: string;
  confidence: number | null;
  risk?: string | null;
  fromModels: string[];
  status: string;
}

export interface ReportEvent {
  entityId: number;
  entityName: string;
  description: string;
  timeText: string;
  timeTextRaw?: string | null;
  quote: string;
  confidence: number | null;
  fromModels: string[];
  status: string;
}

export interface ReportRelation {
  headEntityId: number;
  head: string;
  predicate: string;
  predicateRaw: string | null;
  tailText: string;
  tailEntityId: number | null;
  tailMatched: boolean;
  statement: string;
  quote: string;
  confidence: number;
  fromModels: string[];
  status: string;
}

export interface ExtractionReport {
  article: {
    taskId: number;
    articleId: number | null;
    title: string | null;
    sourceOrg: string | null;
    pubDate: string | null;
    bodyChars: number;
    bodyPreview: string;
  };
  stages: {
    stage: string;
    calls: number;
    tokens: number;
    latencyMs: number;
    models: { model: string; ok: boolean; result: string; latencyMs: number; tokens: number }[];
  }[];
  entities: ReportEntity[];
  facts: ReportFact[];
  events: ReportEvent[];
  relations: ReportRelation[];
  summary: {
    models: string[];
    stageCount: number;
    entityCount: number;
    factCount: number;
    eventCount: number;
    relationCount: number;
    tokens: number;
  };
}

export interface ProductionRecordDetail extends ProductionRecord {
  report: ExtractionReport | null;
  calls: {
    total: number;
    success: number;
    errors: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    avgLatencyMs: number;
  };
  byModel: {
    settingId: number | null;
    settingName: string | null;
    model: string;
    calls: number;
    success: number;
    errors: number;
    totalTokens: number;
    avgLatencyMs: number;
  }[];
  byStage: { stage: string; calls: number; totalTokens: number; avgLatencyMs: number }[];
}

// ---------------------------------------------------------------- 实体

export const entityApi = {
  list: (
    params: {
      datasetId?: number;
      categoryId?: number;
      status?: string;
      keyword?: string;
      page?: number;
      pageSize?: number;
      cursor?: number;
      order?: 'asc' | 'desc';
      sort?: 'id' | 'factCount';
    } = {},
  ) => http.get<never, import('../types').PageResult<import('../types').EntityListItem>>(`/entities${qs(params)}`),
  detail: (id: number) => http.get<never, import('../types').EntityDetail>(`/entities/${id}`),
};

// ---------------------------------------------------------------- 事实

export const factApi = {
  list: (
    params: {
      entityId?: number;
      dimension?: string;
      status?: string;
      keyword?: string;
      current?: boolean;
      activeOnly?: boolean;
      minConfidence?: number;
      page?: number;
      pageSize?: number;
    } = {},
  ) => http.get<never, import('../types').PageResult<FactItem>>(`/facts${qs(params)}`),
  detail: (id: number) => http.get<never, FactItem>(`/facts/${id}`),
};

// ---------------------------------------------------------------- 文章事实列表

export interface ArticleFactApplicability {
  key: string;
  label: string;
  color: string;
}
export interface ArticleFactEvidence {
  evidenceId: number;
  evidenceCode: string | null;
  quote: string | null;
  spanStart: number | null;
  spanEnd: number | null;
  sourceOrg: string | null;
  materialTitle: string | null;
  sourceUrl: string | null;
  publishedAt: string | null;
}
export interface ArticleFactRevision {
  rev: number;
  statement: string | null;
  changeType: string | null;
  reason: string | null;
  release: string | null;
  issuedAt: string | null;
}
export interface ArticleFactRelation {
  id: number;
  type: string;
  direction: 'out' | 'in' | string;
  peerFactId: number;
}
export interface ArticleFactItem {
  id: number;
  code: string | null;
  statement: string;
  dimension: string | null;
  factType: string | null;
  status: string | null;
  version: number;
  confidence: number | null;
  semanticRole: string | null;
  periodKey: string | null;
  subjectScope: string | null;
  temporalKind: string | null;
  asOf: string | null;
  eventStart: string | null;
  eventEnd: string | null;
  validFrom: string | null;
  validTo: string | null;
  method: string | null;
  signMode: string | null;
  sourceAuthority: string | null;
  independentlyVerified: boolean;
  issuedAt: string | null;
  /** 入库时间（ISO），issuedAt 缺失时作为展示兜底 */
  createdAt: string | null;
  alerts: string[];
  arbitrationNote: string | null;
  createdBy: number | null;
  supersededById: number | null;
  lastVerifiedAt: string | null;
  entityId: number;
  entityName: string;
  entitySlug: string;
  datasetCode: string;
  applicability: ArticleFactApplicability;
  evidences: ArticleFactEvidence[];
  revisions: ArticleFactRevision[];
  relations: ArticleFactRelation[];
  /** 事实级主属主题：与文章主题不一致时页面标「主属主题」 */
  factTopicId?: number | null;
  factTopicName?: string | null;
}

export interface ArticleFactsPayload {
  article: {
    id: number;
    title: string;
    url: string;
    sourceOrg: string | null;
    sourceSite: string | null;
    publishedAt: string | null;
    fetchedAt: string | null;
    /** 文章主题（生产线 LLM 抽取，事实稿页面标题位） */
    theme: string | null;
    /** 文章摘要（生产线 LLM 抽取，事实稿页面导语位） */
    summary: string | null;
    /** 核心数据（生产线 LLM 抽取）：事实概览的指标卡 */
    keyStats: { value: string; label: string }[];
    /** 主题/摘要的生成时间与提示词版本 */
    briefAt: string | null;
    briefPromptVersion: string | null;
    /** 所属主题（生产线归并后的最终主题），未归并时为 null */
    topic: { id: number; name: string } | null;
  };
  facts: ArticleFactItem[];
  related: {
    entityId: number;
    entityName: string;
    entitySlug: string;
    datasetCode: string;
    predicate: string;
    facts: { code: string | null; statement: string; dimension: string | null }[];
  }[];
}

export const articleFactsApi = {
  get: (articleId: number) => http.get<never, ArticleFactsPayload>(`/archive/article/${articleId}/facts`),
};

// ---------------------------------------------------------------- 主题事实聚合（/facts/{topicId}）

/** 主题页证据：比单篇多「来自哪篇文章」，用于跨文章溯源 */
export interface TopicFactEvidence extends ArticleFactEvidence {
  articleId: number | null;
  articleTitle: string | null;
}
export interface TopicFactArticleRef {
  id: number;
  title: string | null;
  url: string | null;
  sourceOrg: string | null;
  sourceSite: string | null;
  publishedAt: string | null;
}
/** 主题页事实：跨文章合并去重后的一条，附「出自 N 篇文章」与合并前的事实编号 */
export interface TopicFactItem extends Omit<ArticleFactItem, 'evidences'> {
  evidences: TopicFactEvidence[];
  /** 合并前的原始事实 id（同一主体同一陈述在抽取阶段被拆成多条） */
  mergedFactIds: number[];
  articles: TopicFactArticleRef[];
  articleCount: number;
  /** 证据独立性（按来源家族判定，不按文章条数） */
  independence?: {
    evidenceCount: number;
    familyCount: number;
    publisherCount: number;
    label: string;
    level: 'none' | 'single' | 'same_family' | 'same_publisher' | 'multi_family';
  };
  /** 时间精度与确定性（PRD R03） */
  timePrecision?: string | null;
  timeCertainty?: string | null;
  statementKind?: string | null;
  /** 同一引句另挂的实体数（PRD R02 多主体） */
  participantCount?: number;
  canonicalFactId?: number | null;
}
export interface TopicArticle {
  id: number;
  title: string | null;
  url: string | null;
  sourceOrg: string | null;
  sourceSite: string | null;
  publishedAt: string | null;
  factCount: number;
}
export interface TopicFactsPayload {
  topic: {
    id: number;
    code: string | null;
    name: string;
    definition: string | null;
    aliases: string[];
    firstArticleAt: string | null;
    lastArticleAt: string | null;
    updatedAt: string | null;
    articleCount: number;
    factCount: number;
    evidenceCount: number;
  };
  facts: TopicFactItem[];
  articles: TopicArticle[];
  keyStats: { value: string; label: string }[];
  relatedTopics: { id: number; name: string; factCount: number }[];
}

export const topicFactsApi = {
  get: (topicId: number) => http.get<never, TopicFactsPayload>(`/archive/topic/${topicId}/facts`),
};

/**
 * 旧链接解析：/facts/{id} 可能是主题 id，也可能是迁移前的文章 id。
 * 显式带 format=json，拿 JSON 结果而不是被 301 到 HTML 页，前端据此替换路由。
 */
export type FactsRouteResolution =
  | { kind: 'topic'; topicId: number; url: string }
  | { kind: 'redirect'; location: string }
  | { kind: 'missing' };

export const factsRouteApi = {
  resolve: (id: number) => http.get<never, FactsRouteResolution>(`/archive/facts/${id}/resolve?format=json`),
};

// ---------------------------------------------------------------- 类别

export const categoryApi = {
  list: (params: { datasetId?: number; keyword?: string; tree?: boolean } = {}) =>
    http.get<never, { items: import('../types').CategoryNode[] | import('../types').Category[]; total: number }>(
      `/categories${qs(params)}`,
    ),
  get: (id: number) => http.get<never, import('../types').Category>(`/categories/${id}`),
};

// ---------------------------------------------------------------- 语料域

export const datasetApi = {
  list: (params: { page?: number; pageSize?: number; keyword?: string; status?: string } = {}) =>
    http.get<never, import('../types').PageResult<import('../types').Dataset>>(`/datasets${qs(params)}`),
  get: (id: number) => http.get<never, import('../types').Dataset>(`/datasets/${id}`),
  stats: (id: number) =>
    http.get<never, { datasetId: number; categoryCount: number; entityCount: number }>(`/datasets/${id}/stats`),
};

// ---------------------------------------------------------------- 事实变更流

export const changesApi = {
  /**
   * 扁平变更流（按变更条数分页）。
   * includeSystem=true 时包含系统维护类变更（回填/修复脚本写入的无来源记录）；
   * 事实变更页是审计视图，应传 true，否则唯一的退役记录会被隐藏。
   */
  list: (
    params: {
      page?: number;
      pageSize?: number;
      changeType?: string;
      keyword?: string;
      includeSystem?: boolean;
    } = {},
  ) =>
    http.get<never, { items: FactChangeRow[]; total: number; page: number; pageSize: number }>(
      `/changes${qs(params)}`,
    ),
  /**
   * 按「发布记录（文章）」分页：pageSize = 每页文章数，total = 文章数。
   * 避免按变更条数分页时，一页明细只覆盖少数几篇文章。
   */
  publications: (
    params: { page?: number; pageSize?: number; changeType?: string; keyword?: string } = {},
  ) =>
    http.get<
      never,
      { groups: PublicationGroup[]; items: FactChangeRow[]; total: number; page: number; pageSize: number }
    >(`/changes${qs({ ...params, groupBy: 'article' })}`),
};

// ---------------------------------------------------------------- 实时新闻（仅执行记录）

export const newsApi = {
  runs: (params: { page?: number; pageSize?: number } = {}) =>
    http.get<never, { total: number; items: NewsRunRecord[] }>(`/news/runs${qs(params)}`),
};

// ---------------------------------------------------------------- 引用监测（观测台快照）

export const observatoryApi = {
  snapshot: () => http.get<never, ObservatorySnapshot>('/observatory'),
};

// ---------------------------------------------------------------- 生产线处理记录

export const discoveryApi = {
  records: (
    params: {
      datasetId?: number;
      status?: string;
      page?: number;
      pageSize?: number;
      orderBy?: 'task' | 'pubDate';
    } = {},
  ) =>
    http.get<never, { items: ProductionRecord[]; total: number; page: number; pageSize: number }>(
      `/discovery/records${qs(params)}`,
    ),
  record: (id: number) => http.get<never, ProductionRecordDetail>(`/discovery/records/${id}`),
};

// ---------------------------------------------------------------- MCP 只读工具服务

export const mcpApi = {
  /** tools/list 的 REST 形式（公开接口） */
  tools: () => http.get<never, { tools: McpTool[] }>('/mcp/tools'),
  /** JSON-RPC 2.0：tools/call */
  call: (name: string, args: Record<string, unknown>) =>
    http.post<never, McpRpcResponse>('/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
};

// ---------------------------------------------------------------- 审核草稿（只读计数；需登录，公开访问返回 401 由页面容错）

export const pipelineApi = {
  listDrafts: (
    params: {
      status?: 'pending' | 'approved' | 'rejected';
      targetType?: string;
      page?: number;
      pageSize?: number;
    } = {},
  ) =>
    http.get<never, { items: unknown[]; total: number; page: number; pageSize: number }>(
      `/pipeline/drafts${qs(params)}`,
    ),
};
