import http from './http';
import type {
  Category,
  CategoryNode,
  Dataset,
  EntityDetail,
  EntityListItem,
  FieldDef,
  FieldType,
  PageResult,
} from '@/types';

// ---------------------------------------------------------------- 鉴权

export interface AuthUser {
  id: number;
  username: string;
  displayName: string | null;
  role: string;
}

export interface LoginResult {
  token: string;
  expiresIn: string;
  user: AuthUser;
}

export const authApi = {
  login: (data: { username: string; password: string }) =>
    http.post<never, LoginResult>('/auth/login', data),
  me: () => http.get<never, AuthUser & { lastLoginAt: string | null }>('/auth/me'),
  changePassword: (data: { oldPassword: string; newPassword: string }) =>
    http.patch<never, unknown>('/auth/password', data),
};

const qs = (params: Record<string, unknown>) => {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') sp.append(k, String(v));
  });
  const s = sp.toString();
  return s ? `?${s}` : '';
};

// ---------------------------------------------------------------- 口径维度（v2 全局定义）

export interface FactDimension {
  id: number;
  code: string;
  name: string;
  description: string | null;
  sort: number;
  status: 'active' | 'disabled';
}

export const factDimensionApi = {
  list: () => http.get<never, FactDimension[]>('/facts/dimensions'),
  create: (data: { code: string; name: string; description?: string | null; sort?: number }) =>
    http.post<never, FactDimension>('/facts/dimensions', data),
  update: (
    id: number,
    data: { name?: string; description?: string | null; sort?: number; status?: 'active' | 'disabled' },
  ) => http.patch<never, FactDimension>(`/facts/dimensions/${id}`, data),
};

// ---------------------------------------------------------------- 事实

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

export interface FactChange {
  id: number;
  changeType: 'new' | 'update' | 'corroborate' | 'conflict' | 'archive';
  occurredAt: string;
  summary: string | null;
  rationale: string | null;
  articleTitle: string | null;
  articleUrl: string | null;
}

export const factApi = {
  list: (
    params: {
      entityId?: number;
      dimension?: string;
      status?: string;
      keyword?: string;
      current?: boolean;
      minConfidence?: number;
      page?: number;
      pageSize?: number;
    } = {},
  ) => http.get<never, PageResult<FactItem>>(`/facts${qs(params)}`),
  detail: (id: number) => http.get<never, FactItem>(`/facts/${id}`),
  update: (
    id: number,
    data: {
      status?: string;
      confidence?: number;
      arbitrationNote?: string | null;
      dimension?: string;
      factType?: string;
      lastVerifiedAt?: string | null;
    },
  ) => http.patch<never, FactItem>(`/facts/${id}`, data),
  retire: (id: number, note?: string) => http.post<never, unknown>(`/facts/${id}/retire`, { note }),
  changes: (entityId: number) => http.get<never, FactChange[]>(`/facts/entity/${entityId}/changes`),
  conflicts: (entityId: number) =>
    http.get<never, { entityId: number; groups: { dimension: string; count: number; facts: FactItem[] }[] }>(
      `/facts/entity/${entityId}/conflicts`,
    ),
  arbitrate: (data: {
    entityId: number;
    dimension: string;
    mode: 'adopt' | 'coexist';
    winnerFactId?: number;
    note?: string | null;
  }) => http.post<never, unknown>('/facts/arbitrate', data),
};

// ---------------------------------------------------------------- 事实变更流

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
  toStatement: string | null;
  toDimension: string | null;
  articleTitle: string | null;
  articleUrl: string | null;
}

export const changesApi = {
  list: (params: { page?: number; pageSize?: number } = {}) =>
    http.get<never, { items: FactChangeRow[]; total: number; page: number; pageSize: number }>(
      `/changes${qs(params)}`,
    ),
};

// ---------------------------------------------------------------- MCP 只读工具服务

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

// ---------------------------------------------------------------- 任务计划（harvest）

export interface HarvestTask {
  id: number;
  datasetId: number;
  name: string;
  siteDomains: string;
  queriesPerEntity: number;
  applyMode: 'draft' | 'auto';
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastRun: { id: number; status: string; startedAt: string | null; finishedAt: string | null; statsJson: Record<string, unknown> | null } | null;
}

export interface HarvestRun {
  id: number;
  taskId: number;
  triggerType: 'schedule' | 'manual';
  status: 'running' | 'succeeded' | 'failed';
  statsJson: Record<string, unknown> | null;
  logJson: string[] | null;
  errorMsg: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface HarvestConfig {
  tokenSet: boolean;
  source: 'db' | 'env' | 'none';
  expired: boolean | null;
  daysLeft: number | null;
  exp: number | null;
  preview: string | null;
}

export const harvestApi = {
  tasks: (datasetId?: number) =>
    http.get<never, HarvestTask[]>(`/harvest/tasks${datasetId ? `?datasetId=${datasetId}` : ''}`),
  createTask: (data: Partial<HarvestTask>) => http.post<never, HarvestTask>('/harvest/tasks', data),
  updateTask: (id: number, data: Partial<HarvestTask>) => http.patch<never, HarvestTask>(`/harvest/tasks/${id}`, data),
  deleteTask: (id: number) => http.delete<never, unknown>(`/harvest/tasks/${id}`),
  runTask: (id: number) => http.post<never, { runId: number }>(`/harvest/tasks/${id}/run`, {}),
  runs: (taskId?: number, page = 1, pageSize = 20) =>
    http.get<never, PageResult<HarvestRun>>(`/harvest/runs${qs({ taskId, page, pageSize })}`),
  runDetail: (id: number) => http.get<never, HarvestRun>(`/harvest/runs/${id}`),
  config: () => http.get<never, HarvestConfig>('/harvest/config'),
  saveConfig: (token: string) => http.put<never, HarvestConfig>('/harvest/config', { token }),
  testConfig: (query?: string) => http.post<never, { ok: boolean; count: number; refs: { title: string; uri: string }[] }>('/harvest/config/test', { query }),
};

// ---------------------------------------------------------------- 语料域

export const datasetApi = {
  list: (params: { page?: number; pageSize?: number; keyword?: string; status?: string } = {}) =>
    http.get<never, PageResult<Dataset>>(`/datasets${qs(params)}`),
  get: (id: number) => http.get<never, Dataset>(`/datasets/${id}`),
  stats: (id: number) =>
    http.get<never, { datasetId: number; categoryCount: number; entityCount: number }>(
      `/datasets/${id}/stats`,
    ),
  create: (data: Partial<Dataset>) => http.post<never, Dataset>('/datasets', data),
  update: (id: number, data: Partial<Dataset>) => http.patch<never, Dataset>(`/datasets/${id}`, data),
  remove: (id: number) => http.delete<never, unknown>(`/datasets/${id}`),
  // v2 关联分类（dataset_category）
  linkedCategories: (id: number) =>
    http.get<never, { links: DatasetCategoryLink[]; allDims: FactDimension[] }>(`/datasets/${id}/categories`),
  /** 批量同步关联分类（配置首页 / 关联分类 一次保存） */
  syncCategories: (
    id: number,
    links: { categoryId: number; dimIds?: number[]; homeShow?: number }[],
  ) =>
    http.put<never, { links: DatasetCategoryLink[]; allDims: FactDimension[] }>(`/datasets/${id}/categories`, {
      links,
    }),
  linkCategory: (id: number, categoryId: number, dimIds?: number[]) =>
    http.post<never, { links: DatasetCategoryLink[]; allDims: FactDimension[] }>(
      `/datasets/${id}/categories/${categoryId}`,
      { dimIds: dimIds ?? [] },
    ),
  updateLinkedCategory: (id: number, categoryId: number, body: { dimIds?: number[]; sort?: number; homeShow?: number }) =>
    http.patch<never, { links: DatasetCategoryLink[]; allDims: FactDimension[] }>(
      `/datasets/${id}/categories/${categoryId}`,
      body,
    ),
  unlinkCategory: (id: number, categoryId: number) =>
    http.delete<never, { links: DatasetCategoryLink[]; allDims: FactDimension[] }>(
      `/datasets/${id}/categories/${categoryId}`,
    ),
};

export interface DatasetCategoryLink {
  id: number;
  datasetId: number;
  categoryId: number;
  dimIds: number[];
  homeShow: number;
  sort: number;
  code: string;
  name: string;
  description: string | null;
  parentId: number | null;
  status: string;
  dims: FactDimension[];
}

// 说明：语料域首页 / 公开图谱的接口封装已迁到公开前台 `apps/web/src/api/index.ts`
//（后台不再承载公开页，避免公开站接口与后台管理接口混在一份产物里）

// ---------------------------------------------------------------- 类别

export const categoryApi = {
  list: (params: { datasetId?: number; keyword?: string; tree?: boolean } = {}) =>
    http.get<never, { items: CategoryNode[] | Category[]; total: number }>(
      `/categories${qs(params)}`,
    ),
  get: (id: number) => http.get<never, Category>(`/categories/${id}`),
  chain: (id: number) => http.get<never, Category[]>(`/categories/${id}/chain`),
  create: (data: Partial<Category>) => http.post<never, Category>('/categories', data),
  update: (id: number, data: Partial<Category>) =>
    http.patch<never, Category>(`/categories/${id}`, data),
  remove: (id: number) => http.delete<never, unknown>(`/categories/${id}`),
};

// ---------------------------------------------------------------- 自定义字段

export const fieldDefApi = {
  listByCategory: (categoryId: number) =>
    http.get<never, { items: FieldDef[]; total: number }>(`/field-defs?categoryId=${categoryId}`),
  resolved: (categoryId: number) => http.get<never, FieldDef[]>(`/field-defs/resolved?categoryId=${categoryId}`),
  get: (id: number) => http.get<never, FieldDef>(`/field-defs/${id}`),
  create: (data: {
    categoryId: number;
    key: string;
    label: string;
    type: FieldType;
    required?: boolean;
    inheritable?: boolean;
    options?: { value: string; label: string }[] | null;
    defaultValue?: unknown;
    placeholder?: string | null;
    helpText?: string | null;
    groupName?: string | null;
    sort?: number;
    searchable?: boolean;
    status?: string;
  }) => http.post<never, FieldDef>('/field-defs', data),
  update: (id: number, data: Partial<FieldDef>) =>
    http.patch<never, FieldDef>(`/field-defs/${id}`, data),
  remove: (id: number) => http.delete<never, unknown>(`/field-defs/${id}`),
};

// ---------------------------------------------------------------- 抽取 / 审核

export interface ExtractionDraft {
  id: number;
  runId: number;
  entityId: number | null;
  targetType: 'fact' | 'evidence' | 'event' | 'change' | 'entity' | 'relation';
  entityName?: string | null;
  articleTitle?: string | null;
  articleUrl?: string | null;
  payloadJson: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected';
  reviewedBy: number | null;
  reviewedAt: string | null;
  createdAt: string;
  validation: { ruleCode: string; passed: boolean; message: string | null; targetType: string; targetId: number }[];
}

export const pipelineApi = {
  listDrafts: (
    params: {
      status?: 'pending' | 'approved' | 'rejected';
      runId?: number;
      entityId?: number;
      targetType?: string;
      datasetId?: number;
      page?: number;
      pageSize?: number;
    } = {},
  ) =>
    http.get<never, { items: ExtractionDraft[]; total: number; page: number; pageSize: number }>(
      `/pipeline/drafts${qs(params)}`,
    ),
  approveDraft: (
    id: number,
    data: {
      statement?: string;
      confidence?: number;
      dimension?: string;
      resolution?: 'adopt_new' | 'keep_old' | 'coexist';
      note?: string | null;
    } = {},
  ) => http.post<never, unknown>(`/pipeline/drafts/${id}/approve`, data),
  rejectDraft: (id: number, reason?: string) =>
    http.post<never, unknown>(`/pipeline/drafts/${id}/reject`, { reason }),
  batchReview: (ids: number[], action: 'approve' | 'reject', reason?: string) =>
    http.post<never, { total: number; succeeded: number; failures: { id: number; message: string }[] }>(
      '/pipeline/drafts/batch-review',
      { ids, action, reason },
    ),
  autoReviewFactDrafts: (threshold = 0.85) =>
    http.post<never, { threshold: number; total: number; autoApproved: number; blocked: number }>(
      '/pipeline/drafts/auto-review',
      { threshold },
    ),
  /** 发起大模型审批（后台任务，立即返回；进度轮询 llmReviewStatus） */
  startLlmReview: (ids?: number[]) =>
    http.post<never, { accepted: boolean; message?: string; state: LlmReviewTaskState }>(
      '/pipeline/drafts/llm-review',
      { ids },
    ),
  /** 大模型审批任务状态/进度 */
  llmReviewStatus: () =>
    http.get<never, LlmReviewTaskState>('/pipeline/drafts/llm-review/status'),
};

export interface LlmReviewTaskState {
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
  rejectedList?: { id: number; reason?: string | null }[];
  revisedList?: { id: number; detail?: string }[];
}

// ---------------------------------------------------------------- 生产线

export interface ProductionModel {
  id: number;
  name: string;
  model: string;
  baseUrl: string;
  temperature: number;
  maxTokens: number;
  /** 该渠道跑批并发数（worker 数），默认 10 */
  concurrency: number;
  enabled: boolean;
  isDefault: boolean;
}

export interface ProductionLine {
  source: 'text' | 'env' | 'none';
  /** 总并发 = Σ 各渠道并发数 */
  concurrency: number;
  models: ProductionModel[];
  env: { model: string; baseUrl: string } | null;
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
  ) => http.get<never, PageResult<EntityListItem>>(`/entities${qs(params)}`),
  detail: (id: number) => http.get<never, EntityDetail>(`/entities/${id}`),
  create: (data: {
    /** v2 溯源用：实体首次来自哪个语料域（可选；实体本身全局唯一） */
    originDatasetId?: number;
    categoryId: number;
    name: string;
    slug?: string;
    lede?: string | null;
    seedSource?: string | null;
    attrs?: Record<string, unknown>;
    status?: string;
    aliases?: string[];
  }) => http.post<never, EntityDetail>('/entities', data),
  update: (
    id: number,
    data: {
      name?: string;
      slug?: string;
      lede?: string | null;
      seedSource?: string | null;
      attrs?: Record<string, unknown>;
      status?: string;
      aliases?: string[];
    },
  ) => http.patch<never, EntityDetail>(`/entities/${id}`, data),
  remove: (id: number) => http.delete<never, unknown>(`/entities/${id}`),
  autoPublish: (datasetId: number) =>
    http.post<never, { published: number; candidates: number }>(`/entities/auto-publish?datasetId=${datasetId}`, {}),
};

// ---------------------------------------------------------------- AC 扫描

export interface AcScanJob {
  id: number;
  datasetId: number;
  status: 'running' | 'succeeded' | 'failed';
  patternCount: number;
  articleTotal: number;
  articleScanned: number;
  hitArticleCount: number;
  rawHitCount: number;
  keptHitCount: number;
  overlapFiltered: number;
  suspectHitCount: number;
  contextCount: number;
  buildMs: number;
  scanMs: number;
  errorMsg: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AcScanStats {
  job: AcScanJob;
  categories: {
    categoryCode: string;
    contexts: number;
    hits: number;
    avgWindowChars: number;
    avgMerge: number;
  }[];
  topEntities: { entityId: number; entityName: string; categoryCode: string; hits: number }[];
  statusDist: { status: string; cnt: number }[];
  lenDist: { bucket: string; cnt: number }[];
}

export interface AcHitItem {
  id: number;
  articleId: number;
  articleTitle: string | null;
  entityId: number;
  entityName: string;
  categoryCode: string;
  mention: string;
  startPos: number;
  endPos: number;
  isKept: boolean;
  rejectReason: string | null;
  contextId: number | null;
}

export interface AcContextItem {
  id: number;
  articleId: number;
  articleTitle: string | null;
  publishedAt: string | null;
  sourceOrg: string | null;
  categoryCode: string;
  entityIds: number[];
  entityNames: string[];
  hitCount: number;
  windowText: string;
  startPos: number;
  endPos: number;
  windowChars: number;
  mergeCount: number;
  status: string;
}

export const acscanApi = {
  run: (data: { datasetId: number; limit?: number }) =>
    http.post<never, { jobId: number; articleTotal: number }>('/acscan/run', data),
  latestJob: () => http.get<never, AcScanJob | null>('/acscan/jobs/latest'),
  stats: (jobId?: number) =>
    http.get<never, AcScanStats>(`/acscan/stats${jobId ? `?jobId=${jobId}` : ''}`),
  hits: (params: {
    jobId?: number;
    filter?: 'kept' | 'rejected' | 'all';
    category?: string;
    entityId?: number;
    articleId?: number;
    page?: number;
    pageSize?: number;
  } = {}) => http.get<never, { items: AcHitItem[]; total: number; page: number; pageSize: number }>(`/acscan/hits${qs(params)}`),
  contexts: (params: {
    jobId?: number;
    category?: string;
    entityId?: number;
    articleId?: number;
    keyword?: string;
    page?: number;
    pageSize?: number;
  } = {}) => http.get<never, { items: AcContextItem[]; total: number; page: number; pageSize: number }>(`/acscan/contexts${qs(params)}`),
};

// ---------------------------------------------------------------- 质量看板

export interface QualitySummary {
  draftTotal: number;
  passedDrafts: number;
  rejectedDrafts: number;
  passRate: number;
  factTotal: number;
  factActive: number;
  factReview: number;
}

export interface QualityMetrics {
  faithfulness: number;
  attribution: number;
  fieldRouting: number;
  spanBounds: number;
  quoteLength: number;
  confidenceRange: number;
  confidenceMin: number;
  nameSplit: number;
  valueLength: number;
  cooccurrence: number;
  qualityAnchor: number;
  entityType: number;
}

export interface QualityRule {
  ruleCode: string;
  total: number;
  failed: string | number;
}

export interface QualityByDimension {
  dimension: string;
  count: number;
  active: number;
  review: number;
  avgN: number;
}

export interface QualityReport {
  summary: QualitySummary;
  metrics: QualityMetrics;
  rules: QualityRule[];
  byDimension: QualityByDimension[];
}

export const qualityApi = {
  report: () => http.get<never, QualityReport>('/dashboard/quality'),
};

// ---------------------------------------------------------------- 大模型设置

export interface LlmSetting {
  id: number;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  model: string;
  /** text=文本模型（生产线抽取用，可多条并存并发） | vector=向量模型 */
  kind: 'text' | 'vector';
  dimensions: number | null;
  useDefaultDim: boolean;
  isDefault: boolean;
  temperature: number | string;
  maxTokens: number;
  /** 生产线并发数（该渠道跑批 worker 数），默认 10 */
  concurrency: number;
  enabled: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LlmSettingKind = LlmSetting['kind'];

export interface LlmConfigTestResult {
  ok: boolean;
  kind?: string;
  model: string;
  dim?: number;
  latencyMs: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  error?: string;
}

export const llmConfigApi = {
  list: (kind?: LlmSettingKind) =>
    http.get<never, LlmSetting[]>(`/llm-config${kind ? `?kind=${kind}` : ''}`),
  active: (kind?: LlmSettingKind) =>
    http.get<never, LlmSetting | null>(`/llm-config/active${kind ? `?kind=${kind}` : ''}`),
  /** 生产线模型（文本模型：启用 + 设为生产线），可能多条 */
  production: () => http.get<never, LlmSetting[]>('/llm-config/production'),
  create: (data: {
    name: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    kind?: LlmSettingKind;
    dimensions?: number | null;
    useDefaultDim?: boolean;
    isDefault?: boolean;
    temperature?: number;
    maxTokens?: number;
    concurrency?: number;
    enabled?: boolean;
    notes?: string | null;
  }) => http.post<never, LlmSetting>('/llm-config', data),
  update: (
    id: number,
    data: {
      name?: string;
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      kind?: LlmSettingKind;
      dimensions?: number | null;
      useDefaultDim?: boolean;
      isDefault?: boolean;
      temperature?: number;
      maxTokens?: number;
      concurrency?: number;
      enabled?: boolean;
      notes?: string | null;
    },
  ) => http.patch<never, LlmSetting>(`/llm-config/${id}`, data),
  remove: (id: number) => http.delete<never, unknown>(`/llm-config/${id}`),
  setDefault: (id: number) => http.post<never, LlmSetting>(`/llm-config/${id}/set-default`, {}),
  unsetDefault: (id: number) => http.post<never, LlmSetting>(`/llm-config/${id}/unset-default`, {}),
  test: (body: { id?: number; config?: Record<string, unknown> }) =>
    http.post<never, LlmConfigTestResult>('/llm-config/test', body),
};

// ---------------------------------------------------------------- 大模型调用日志

export interface LlmCallLog {
  id: number;
  settingId: number | null;
  model: string;
  endpoint: string;
  purpose: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  status: 'success' | 'error';
  errorMessage: string | null;
  /** 归属批次（extraction_run.id） */
  runId: number | null;
  /** 归属发现任务（extract_task.id） */
  taskId: number | null;
  entityId: number | null;
  articleId: number | null;
  /** 明细：prompt 片段 / 响应原文片段 / 候选数等 */
  detailJson: {
    stage?: string;
    settingName?: string;
    temperature?: number;
    maxTokens?: number;
    entityName?: string;
    entityId?: number;
    articleId?: number;
    articleTitle?: string;
    promptChars?: number;
    promptPreview?: string;
    responsePreview?: string;
    candidates?: number;
    httpStatus?: number | null;
    entities?: number;
    results?: number;
    facts?: number;
    events?: number;
    verdicts?: Record<string, number>;
    mention?: string;
    best?: number;
  } | null;
  createdBy: number | null;
  createdAt: string;
}

export interface LlmLogStats {
  totals: {
    calls: number;
    success: number;
    errors: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    avgLatencyMs: number;
  };
  bySetting: { settingId: number | null; settingName: string | null; model: string; calls: number; totalTokens: number }[];
  byDay: { day: string; calls: number; totalTokens: number }[];
}

export const llmLogApi = {
  list: (params: {
    settingId?: number;
    purpose?: string;
    status?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  } = {}) => http.get<never, { items: LlmCallLog[]; total: number; page: number; pageSize: number }>(`/llm-log${qs(params)}`),
  stats: (params: { settingId?: number; purpose?: string; status?: string; from?: string; to?: string } = {}) =>
    http.get<never, LlmLogStats>(`/llm-log/stats${qs(params)}`),
};

// ---------------------------------------------------------------- 引用监测（Observatory）

export type CitedStatus = 'fact_page' | 'same_domain' | 'other' | 'none';

export interface ProbeModelConfig {
  id: string;
  provider: string;
  label: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  enabled: boolean;
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
  byModel: Record<string, CitedStatus>;
}

export interface ProbeAnswer {
  runId: number;
  modelId: string;
  modelLabel: string;
  cited: CitedStatus;
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
  /** 近 4 周引用变化（真实探测数据分桶） */
  weeklyStats: { label: string; rate: number | null; base: number }[];
  generatedAt: string;
}

export interface ProbeQuestion {
  id: number;
  factId: number | null;
  entityId: number | null;
  question: string;
  expectedAnswer: string;
  category: 'fact' | 'time' | 'status' | 'place' | 'public_service' | 'history';
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

export interface ProbeRunResultRow {
  runId: number;
  questionId: number;
  question: string;
  expectedAnswer: string;
  modelId: string;
  modelLabel: string;
  cited: CitedStatus;
  matchMethod: 'url_struct' | 'url_text' | 'none';
  sourceUrls: string[] | null;
  matchedUrl: string | null;
  excerpt: string | null;
  rawAnswer: string | null;
  probedAt: string | null;
}

export interface ProbeQuestionList {
  items: ProbeQuestion[];
  total: number;
  page: number;
  pageSize: number;
}

export const observatoryApi = {
  snapshot: () => http.get<never, ObservatorySnapshot>('/observatory'),
  questions: (params: { page?: number; pageSize?: number; status?: string; category?: string; keyword?: string } = {}) =>
    http.get<never, ProbeQuestionList>(`/observatory/questions${qs(params)}`),
  createQuestion: (data: { question: string; expectedAnswer: string; category?: string; status?: string; factId?: number; entityId?: number }) =>
    http.post<never, ProbeQuestion>('/observatory/questions', data),
  updateQuestion: (id: number, data: Record<string, unknown>) =>
    http.put<never, ProbeQuestion>(`/observatory/questions/${id}`, data),
  deleteQuestion: (id: number) => http.delete<never, { deleted: boolean }>(`/observatory/questions/${id}`),
  questionAnswers: (id: number) => http.get<never, ProbeAnswer[]>(`/observatory/questions/${id}/answers`),
  syncQuestions: () => http.post<never, { synced: number }>('/observatory/questions/sync', {}),
  settings: () => http.get<never, ProbeModelConfig[]>('/observatory/settings'),
  saveSettings: (models: ProbeModelConfig[]) => http.put<never, unknown>('/observatory/settings', { models }),
  probe: (body: { modelId?: string; sample?: number }) =>
    http.post<never, { runs: { modelId: string; questionCount: number; runId: number }[]; results: ProbeRunResultRow[] }>(
      '/observatory/probe',
      body,
      { timeout: 900000 }, // 探测为长任务（每模型×每问题 3-30s），不受全局 20s 超时限制
    ),
};

export interface GeoReport {
  title: string;
  generatedAt: string;
  modelName: string;
  questionCount: number;
  answerCount: number;
  llmOk: boolean;
  llmError?: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  latencyMs: number;
  html: string;
}

export const geoReportApi = {
  generate: (body: { questionLimit?: number } = {}) =>
    http.post<never, GeoReport>('/observatory/report', body, { timeout: 600000 }), // 大模型分析需 30~180s
  latest: () => http.get<never, GeoReport | null>('/observatory/report/latest'),
};

// ---------------------------------------------------------------- 探针任务计划与执行记录

export interface ProbeSchedule {
  enabled: boolean;
  mode: 'daily' | 'weekly' | 'monthly' | 'interval';
  /** HH:mm（daily/weekly/monthly 生效） */
  time: string;
  /** 1=周一…7=周日（weekly 生效） */
  weekday: number;
  /** 每月几号（monthly 生效） */
  day: number;
  /** 间隔分钟（interval 生效） */
  intervalMinutes: number;
}

export interface ProbeScheduleState {
  lastRunAt: string | null;
  lastStatus: 'success' | 'running' | 'error' | null;
  lastError: string | null;
  nextRunAt: string | null;
  running: boolean;
}

export interface ProbeRunRow {
  runId: number;
  modelId: string;
  questionCount: number;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationSec: number | null;
  hitRate: number | null;
  answerCount: number;
  factPage: number;
  sameDomain: number;
  other: number;
  none: number;
}

export interface ProbeRunDetail {
  run: Record<string, unknown>;
  questions: {
    id: number;
    question: string;
    expectedAnswer: string;
    factId: number | null;
    answers: {
      modelId: string;
      modelLabel: string;
      cited: 'fact_page' | 'same_domain' | 'other' | 'none';
      matchMethod: string;
      sourceUrls: string[] | null;
      matchedUrl: string | null;
      excerpt: string | null;
      rawAnswer: string;
      probedAt: string | null;
    }[];
  }[];
}

export const probeScheduleApi = {
  get: () => http.get<never, [ProbeSchedule, ProbeScheduleState]>('/observatory/schedule'),
  save: (patch: Partial<ProbeSchedule>) => http.put<never, { schedule: ProbeSchedule; state: ProbeScheduleState }>('/observatory/schedule', patch),
  runNow: () => http.post<never, { accepted: boolean }>('/observatory/schedule/run-now', {}),
};

export const probeRunsApi = {
  list: (params: { page?: number; pageSize?: number } = {}) =>
    http.get<never, { total: number; items: ProbeRunRow[] }>(`/observatory/runs${qs(params)}`),
  detail: (id: number) => http.get<never, ProbeRunDetail | null>(`/observatory/runs/${id}`),
};



// ---------------------------------------------------------------- 实体发现与对齐审核

export interface AlignTask {
  id: number;
  datasetId: number;
  kind: 'merge_suggest' | 'conflict' | 'predicate_new' | 'new_entity';
  mentionName: string;
  mentionType: string;
  entityId: number | null;
  payloadJson: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected';
  articleId: number | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface DiscoveryQueue {
  byStatus: Record<string, number>;
  pendingAlign: Record<string, number>;
}

/** 关系 schema 条目：head 分类 × tail 类型 → 建议关系词（后台可维护） */
export interface RelationSchemaItem {
  id: number;
  categoryId: number;
  tailType: string;
  relations: string[];
  sort: number;
  status: 'active' | 'disabled';
  catCode: string;
  catName: string;
  catParentId: number | null;
}

export const discoveryApi = {
  queue: (datasetId: number) =>
    http.get<never, DiscoveryQueue>(`/discovery/queue?datasetId=${datasetId}`),
  alignTasks: (datasetId: number, kind?: string, page = 1, pageSize = 20) =>
    http.get<never, { items: AlignTask[]; total: number; page: number; pageSize: number }>(
      `/discovery/align-tasks${qs({ datasetId, kind, page, pageSize })}`,
    ),
  resolve: (
    id: number,
    resolution: 'merge' | 'new' | 'reject',
    canonical?: string,
    targetEntityId?: number,
    newName?: string,
    newGroup?: string,
  ) =>
    http.post<never, { resolved: boolean; id: number; resolution: string }>(
      `/discovery/align-tasks/${id}/resolve`,
      { resolution, canonical, targetEntityId, newName, newGroup },
    ),
  /** 某分类的维度分配：全部 active 维度 + 已分配 id 集合（含经父链继承的）+ 分类默认绑定 */
  categoryDimensions: (categoryId: number, datasetId: number) =>
    http.get<never, { dimensions: FactDimension[]; assignedIds: number[]; inheritedIds: number[]; defaultDimIds: number[] }>(
      `/discovery/categories/${categoryId}/dimensions${qs({ datasetId })}`,
    ),
  /** 整体替换某库某分类的启用维度子集（v2：dataset_category.dim_ids） */
  setCategoryDimensions: (categoryId: number, datasetId: number, dimensionIds: number[]) =>
    http.put<never, { ok: boolean }>(`/discovery/categories/${categoryId}/dimensions`, { datasetId, dimensionIds }),
  /** 按语义把某语料域存量维度自动归类到分类 */
  autoClassifyDimensions: (datasetId: number) =>
    http.post<never, { classified: number; global: number; total: number; assignments: unknown[] }>(
      `/discovery/dimensions/auto-classify`,
      { datasetId },
    ),
  // ---- 关系 schema（按 head 分类 × tail 类型维护建议关系词） ----
  relationSchemas: (categoryId?: number) =>
    http.get<never, RelationSchemaItem[]>(`/discovery/relation-schemas${categoryId ? `?categoryId=${categoryId}` : ''}`),
  createRelationSchema: (data: { categoryId: number; tailType: string; relations: string[]; sort?: number; status?: 'active' | 'disabled' }) =>
    http.post<never, RelationSchemaItem>('/discovery/relation-schemas', data),
  updateRelationSchema: (id: number, data: { tailType?: string; relations?: string[]; sort?: number; status?: 'active' | 'disabled' }) =>
    http.patch<never, RelationSchemaItem>(`/discovery/relation-schemas/${id}`, data),
  deleteRelationSchema: (id: number) =>
    http.delete<never, { ok: boolean }>(`/discovery/relation-schemas/${id}`),
  // ---- 生产线处理记录 ----
  buildQueue: (datasetId: number, limit: number, body?: { bodyMin?: number; bodyMax?: number; batch?: string }) =>
    http.post<never, { sampled: number; created: number; skipped: number; datasetId: number }>(
      `/discovery/queue?datasetId=${datasetId}&limit=${limit}`,
      body ?? {},
    ),
  runQueue: (datasetId: number, limit?: number) =>
    http.post<never, { started: boolean }>(
      `/discovery/run?datasetId=${datasetId}${limit != null ? `&limit=${limit}` : ''}`,
      {},
    ),
  /** 取消排队（温和）：只撤销排队中的任务，在途的会跑完 */
  cancelQueue: (datasetId: number) =>
    http.post<never, { cancelled: number; datasetId: number }>(`/discovery/queue/cancel?datasetId=${datasetId}`, {}),
  /** 终止任务（强制）：中断在途调用，排队中 + 进行中全部取消 */
  terminateQueue: (datasetId: number) =>
    http.post<never, { terminated: number; datasetId: number }>(`/discovery/queue/terminate?datasetId=${datasetId}`, {}),
  production: () => http.get<never, ProductionLine>('/discovery/production'),
  records: (
    params: {
      datasetId?: number;
      status?: string;
      page?: number;
      pageSize?: number;
      /** task=处理先后（默认）；pubDate=新闻发布时间倒序 */
      orderBy?: 'task' | 'pubDate';
    } = {},
  ) =>
    http.get<never, { items: ProductionRecord[]; total: number; page: number; pageSize: number }>(
      `/discovery/records${qs(params)}`,
    ),
  record: (id: number) => http.get<never, ProductionRecordDetail>(`/discovery/records/${id}`),
  recordCalls: (
    id: number,
    params: { status?: string; stage?: string; page?: number; pageSize?: number } = {},
  ) =>
    http.get<never, { items: LlmCallLog[]; total: number; page: number; pageSize: number }>(
      `/discovery/records/${id}/calls${qs(params)}`,
    ),
  recordDrafts: (id: number, params: { page?: number; pageSize?: number } = {}) =>
    http.get<never, { items: ExtractionDraft[]; total: number; page: number; pageSize: number }>(
      `/discovery/records/${id}/drafts${qs(params)}`,
    ),
};

// ---------------------------------------------------------------- 实时新闻

export interface NewsSchedule {
  id: number;
  name: string;
  sourceId: string;
  enabled: boolean;
  datasetId: number;
  mode: 'daily' | 'weekly' | 'monthly' | 'interval';
  time: string;
  weekday: number;
  day: number;
  intervalMinutes: number;
  /** 每次随机入库的文章数 */
  batchSize: number;
  /** 入库后是否紧接着跑生产线 */
  autoRun: boolean;
  /** 跑生产线时是否抽取关系图谱；关闭则跳过关系抽取与事实→图谱派生 */
  extractRelations: boolean;
}

export interface NewsScheduleState {
  lastRunAt: string | null;
  lastStatus: 'success' | 'running' | 'error' | null;
  lastError: string | null;
  nextRunAt: string | null;
  running: boolean;
}

export interface NewsStats {
  sourceId: string;
  sourceName: string;
  datasetId: number;
  /** 新闻源（es/http）是否可达 */
  ready: boolean;
  /** 可拉取文档总量 */
  total: number;
  ingested: number;
  remaining: number;
  /** 统计缓存时间（ISO） */
  cachedAt: string | null;
  /** 增量游标：上次入库记录到的最新一条 */
  cursor: NewsEsCursor | null;
}

/** ES 新闻源连接配置 */
export interface NewsEsConfig {
  url: string;
  username: string;
  password: string;
  index: string;
  sourceName: string;
  sourceSystem: string;
  bodyMin: number;
  bodyMax: number;
}

export interface NewsEsCursor {
  docId: string;
  pubDate: string | null;
  sort: (string | number)[];
}

export interface NewsEsTestResult {
  ok: boolean;
  cluster: string;
  version: string;
  total: number;
  error: string | null;
}

/** HTTP 通用 JSON 接口新闻源配置 */
export interface NewsHttpConfig {
  url: string;
  method: 'GET' | 'POST';
  headersJson: string;
  listPath: string;
  bodyJson: string;
  idField: string;
  titleField: string;
  pubDateField: string;
  urlField: string;
  contentField: string;
  sourceNameField: string;
  sourceName: string;
  bodyMin: number;
  bodyMax: number;
}

export type NewsSourceType = 'es' | 'http';

export interface NewsSource {
  id: string;
  type: NewsSourceType;
  name: string;
  enabled: boolean;
  datasetId: number;
  es?: NewsEsConfig;
  http?: NewsHttpConfig;
}

export interface NewsPreviewItem {
  assetId: string;
  title: string | null;
  sourceName: string | null;
  pubDate: string | null;
  sourceUrl: string | null;
  bodyChars: number;
  excerpt: string;
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
  /** running=执行中（跑批开始即落库） */
  status: 'running' | 'success' | 'error';
  error: string | null;
}

export const newsApi = {
  stats: (sourceId: string, refresh = false) =>
    http.get<never, NewsStats>(`/news/stats${qs({ sourceId })}${refresh ? '&refresh=1' : ''}`),
  preview: (sourceId: string, limit = 10) =>
    http.get<never, NewsPreviewItem[]>(`/news/preview${qs({ sourceId, limit })}`),
  ingest: (sourceId: string, limit = 10) =>
    http.post<never, { sampled: number; created: number; skipped: number; datasetId: number; cursor: NewsEsCursor | null }>(
      `/news/ingest${qs({ sourceId, limit })}`,
      {},
    ),
  // 多新闻源
  listSources: () => http.get<never, { sources: NewsSource[] }>('/news/sources'),
  saveSource: (patch: Partial<NewsSource> & { id?: string }) => http.post<never, { source: NewsSource }>('/news/sources', patch),
  deleteSource: (id: string) => http.delete<never, { ok: boolean }>(`/news/sources${qs({ id })}`),
  testSource: (patch: Partial<NewsSource>) =>
    http.post<never, { ok: boolean; detail: string; total: number; error: string | null }>('/news/sources/test', patch),
  // 多任务计划
  listSchedules: () =>
    http.get<never, { schedules: NewsSchedule[]; states: Record<number, NewsScheduleState> }>('/news/schedules'),
  saveSchedule: (patch: Partial<NewsSchedule> & { id?: number }) =>
    http.put<never, { schedule: NewsSchedule; state: NewsScheduleState }>('/news/schedules', patch),
  deleteSchedule: (id: number) => http.delete<never, { ok: boolean }>(`/news/schedules${qs({ id })}`),
  runSchedule: (id?: number) => http.post<never, { accepted: boolean; error?: string | null }>('/news/schedules/run-now', { id }),
  // 兼容旧 ES 编辑页（DevTools）
  getEsConfig: () => http.get<never, { config: NewsEsConfig; cursor: NewsEsCursor | null }>('/news/es-config'),
  saveEsConfig: (patch: Partial<NewsEsConfig>) => http.put<never, { config: NewsEsConfig }>('/news/es-config', patch),
  testEsConfig: (patch?: Partial<NewsEsConfig>) => http.post<never, NewsEsTestResult>('/news/es-config/test', patch ?? {}),
  resetCursor: () => http.post<never, { ok: boolean; cursor: NewsEsCursor | null }>('/news/es-config/cursor/reset', {}),
  runs: (params: { page?: number; pageSize?: number } = {}) => http.get<never, { total: number; items: NewsRunRecord[] }>(`/news/runs${qs(params)}`),
};

// ---------------------------------------------------------------- 审计日志

export interface AuditLogItem {
  id: number;
  userId: number | null;
  userName: string | null;
  username: string | null;
  action: string;
  targetType: string;
  targetId: number | null;
  beforeJson: Record<string, unknown> | null;
  afterJson: Record<string, unknown> | null;
  remark: string | null;
  createdAt: string;
}

export const auditApi = {
  list: (
    params: {
      targetType?: string;
      targetId?: number;
      userId?: number;
      action?: string;
      dateFrom?: string;
      dateTo?: string;
      page?: number;
      pageSize?: number;
    } = {},
  ) =>
    http.get<never, { items: AuditLogItem[]; total: number; page: number; pageSize: number }>(
      `/audit-logs${qs(params)}`,
    ),
};

// ---------------------------------------------------------------- 开发调试

export interface PipelineStatItem {
  table: string;
  label: string;
  rows: number;
}

export const devApi = {
  /** 各管线表行数预览 */
  pipelineStats: () => http.get<never, { items: PipelineStatItem[]; total: number; running: number }>('/dev/pipeline-stats'),
  /** 一键清空抽取管线产出数据（保留语料与配置） */
  clearPipeline: () =>
    http.post<
      never,
      { cleared: PipelineStatItem[]; failures: { table: string; message: string }[]; total: number }
    >('/dev/clear-pipeline', {}),
};

// ---------------------------------------------------------------- 生产线处理记录

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
  /** 列表只带计数；明细接口返回完整 stats + report */
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
  /** 尾实体是否已落到库（false = 新候选，审核通过时建实体） */
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
  /** 关系（知识图谱的边）：尾实体未落库时为「新候选」 */
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

// ---------------------------------------------------------------- 知识图谱

export interface GraphNode {
  /** 实体为正 entity.id；概念为负 -graph_node.id（统一节点空间，符号区分） */
  id: number;
  /** 实体 | 概念 */
  nodeType: 'entity' | 'concept';
  name: string;
  categoryCode: string | null;
  categoryName: string | null;
  status: string;
  lede: string | null;
  datasetId: number | null;
  /** 跳档案页用（概念节点为空） */
  slug?: string | null;
  datasetCode?: string | null;
}

export interface GraphEdge {
  id: number;
  head: number;
  tail: number;
  /** 归一后的关系码，如 rel_隶属 */
  predicate: string;
  /** 展示标签（去掉 rel_ 前缀） */
  label: string;
  predicateRaw: string | null;
  statement: string | null;
  confidence: number;
  corroborateCount: number;
  articleId: number | null;
  /** 支撑引句 / 证据编码 / 核验状态（随证据挂载） */
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

export interface RelationRow extends GraphEdge {
  headName: string | null;
  tailName: string | null;
  tailText: string;
  tailType: string | null;
  firstSeenAt: string | null;
  lastVerifiedAt: string | null;
}

export interface RelationPredicateRow {
  predicate: string;
  label: string;
  count: number;
  avgConfidence: number;
}

export interface GraphEntityHit {
  id: number;
  name: string;
  categoryCode: string | null;
  categoryName: string | null;
  status: string;
}

/** 节点搜索命中（实体 ∪ 概念） */
export interface GraphNodeHit extends GraphEntityHit {
  nodeType: 'entity' | 'concept';
}

export const graphApi = {
  entityGraph: (
    id: number,
    params: { depth?: number; direction?: 'both' | 'out' | 'in'; minConfidence?: number; predicate?: string } = {},
  ) => http.get<never, EntityGraph>(`/graph/entity/${id}${qs(params)}`),
  overview: (params: { datasetId?: number; limit?: number } = {}) =>
    http.get<never, GraphOverview>(`/graph/overview${qs(params)}`),
  relations: (
    params: {
      datasetId?: number;
      headEntityId?: number;
      predicate?: string;
      keyword?: string;
      page?: number;
      pageSize?: number;
    } = {},
  ) =>
    http.get<never, { items: RelationRow[]; total: number; page: number; pageSize: number }>(
      `/graph/relations${qs(params)}`,
    ),
  predicates: (datasetId?: number) =>
    http.get<never, RelationPredicateRow[]>(`/graph/predicates${qs({ datasetId })}`),
  entities: (params: { keyword: string; datasetId?: number; limit?: number }) =>
    http.get<never, GraphEntityHit[]>(`/graph/entities${qs(params)}`),
  /** 节点搜索（实体 ∪ 概念），概念节点 id 为负数 */
  nodes: (params: { keyword: string; datasetId?: number; limit?: number }) =>
    http.get<never, GraphNodeHit[]>(`/graph/nodes/search${qs(params)}`),
  /** 人工反转关系方向（head ⇄ tail），写库保存 */
  reverseRelation: (id: number) =>
    http.post<
      never,
      { reversed: boolean; id: number; mergedInto?: number; message?: string; headName?: string; tailName?: string }
    >(`/graph/relations/${id}/reverse`, {}),
  /** 修改关系名称（谓词） */
  updateRelation: (id: number, predicate: string) =>
    http.patch<never, { updated: boolean; id: number; predicate: string; mergedInto?: number; message?: string }>(
      `/graph/relations/${id}`,
      { predicate },
    ),
  /** 删除关系（软删） */
  deleteRelation: (id: number) =>
    http.delete<never, { deleted: boolean; id: number }>(`/graph/relations/${id}`),
  /** 修改概念节点（非实体）名称 */
  updateNodeName: (id: number, name: string) =>
    http.patch<never, { updated: boolean; id: number; name: string }>(`/graph/nodes/${id}`, { name }),
};

export * from './review';
export * from './hub-sync';
export * from './health';
