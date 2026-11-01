/**
 * Observatory 模块契约类型
 * 对应 demo「AI Citation Observatory」的数据结构，但改用真实探针数据回填。
 */

/** 引用判定结果：引用我方事实页 / 引用同域其他页(新闻) / 引用外部 / 未引用 */
export type CitedStatus = 'fact_page' | 'same_domain' | 'other' | 'none';

/** 命中方式：结构化搜索结果 / 正文内联 URL / 未命中 */
export type MatchMethod = 'url_struct' | 'url_text' | 'none';

export interface ProbeModelConfig {
  id: string;
  /** ark=直连豆包 Ark API；websearch=统一联网搜索 API（本地 8790 服务，无鉴权） */
  provider: 'ark' | 'websearch';
  /** 展示名，如「豆包」 */
  label: string;
  baseUrl: string;
  model: string;
  /** 从环境变量读取的 key 名（websearch 无需鉴权，可留空） */
  apiKeyEnv: string;
  enabled: boolean;
}

/** 固定问题集中的一题（从 fact 派生或人工维护） */
export interface ProbeQuestion {
  id: number;
  factId?: number;
  entityId?: number;
  question: string;
  expectedAnswer: string;
  category: 'fact' | 'time' | 'status' | 'place' | 'public_service' | 'history';
  createdAt: Date;
}

export interface ProbeRun {
  id: number;
  modelId: string;
  startedAt: Date;
  finishedAt?: Date;
  questionCount: number;
  status: 'running' | 'done' | 'failed';
}

export interface ProbeResult {
  id: number;
  runId: number;
  questionId: number;
  modelId: string;
  cited: CitedStatus;
  matchMethod: MatchMethod;
  sourceUrls: string[];
  matchedUrl: string | null;
  excerpt: string | null;
  rawAnswer: string;
  probedAt: Date;
}

/** 顶部 3 指标卡 */
export interface ObservatoryMetrics {
  /** 新闻发布→搜索首次发现（分钟），需搜索收录源，暂无则 null */
  discoveryLagMin: number | null;
  /** 事实更新→AI 首次正确采用（分钟），来自探针 */
  aiFreshnessLagMin: number | null;
  /** 引用率 0..1 */
  citationRate: number | null;
  citationRateBase: number;
  citationRateDeltaPp: number | null;
  lastCitation: {
    at: Date;
    model: string;
    question: string;
    /** 引用等级：fact_page=事实页，same_domain=同域其他页（新闻等） */
    cited: 'fact_page' | 'same_domain';
    /** 模型真正命中的 URL（可能与 factUrl 不同） */
    url: string;
    /** 该题关联的事实页 URL */
    factUrl: string;
  } | null;
}

/** Event Tracking 一行 */
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
  nodes: { label: string; at: Date | null; state: 'done' | 'pending' | 'planned' }[];
}

/** 固定问题集表格行 */
export interface ObservatoryQuestionRow {
  id: number;
  question: string;
  expectedAnswer: string;
  /** modelId -> 该模型判定 */
  byModel: Record<string, CitedStatus>;
  /** 该问题累计被各模型回答的次数（探测记录数） */
  answerCount: number;
}

/** 近 4 周引用变化：按 7 天分桶，每桶为真实探测数据算出的引用正确率 */
export interface ObservatoryWeekStat {
  /** 桶标签：W1（最早）… W4（最近） */
  label: string;
  /** 引用正确率 0..1；该周无探测样本时为 null */
  rate: number | null;
  /** 该周参与判定的问题数（去重） */
  base: number;
}

export interface ObservatorySnapshot {
  metrics: ObservatoryMetrics;
  events: ObservatoryEventTrack[];
  questions: ObservatoryQuestionRow[];
  /** 渲染表格列（动态来自配置，目前仅豆包） */
  modelColumns: { id: string; label: string }[];
  /** 近 4 周引用变化（真实探测数据分桶） */
  weeklyStats: ObservatoryWeekStat[];
  generatedAt: Date;
}
