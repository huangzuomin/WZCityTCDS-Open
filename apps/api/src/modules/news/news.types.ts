/**
 * 实时新闻：新闻来源「入库 + 跑生产线」的定时任务配置与执行记录。
 * 新闻源为 Elasticsearch（66wz.com，见 news-es.ts），连接信息可在「新闻源设置」页配置。
 */

export interface NewsSchedule {
  /** 计划唯一 id（时间戳） */
  id: number;
  /** 计划名称 */
  name: string;
  /** 绑定新闻源 id（见 news-sources.ts） */
  sourceId: string;
  enabled: boolean;
  /** 目标语料域（入库与跑批都落到该 dataset；优先于此源绑定的语料域） */
  datasetId: number;
  /** daily=每天，weekly=每周，monthly=每月，interval=按间隔 */
  mode: 'daily' | 'weekly' | 'monthly' | 'interval';
  /** HH:mm（日/周/月模式生效） */
  time: string;
  /** 1=周一 … 7=周日（weekly 生效） */
  weekday: number;
  /** 每月几号（monthly 生效，超长月份按最后一天） */
  day: number;
  /** 间隔分钟（interval 生效） */
  intervalMinutes: number;
  /** 每次入库的文章数 */
  batchSize: number;
  /** 入库后是否紧接着跑生产线任务 */
  autoRun: boolean;
  /** 跑生产线时是否抽取关系图谱；关闭则跳过关系抽取、关系草稿验证与事实→图谱派生 */
  extractRelations: boolean;
}

export interface NewsScheduleState {
  lastRunAt: string | null;
  lastStatus: 'success' | 'running' | 'error' | null;
  lastError: string | null;
  nextRunAt: string | null;
  running: boolean;
}

/** 一次「新闻入库 + 跑生产线」的执行记录 */
export interface NewsRunRecord {
  id: number;
  source: 'schedule' | 'manual';
  datasetId: number;
  mode: 'ingest' | 'ingest+run';
  startedAt: string;
  finishedAt: string | null;
  /** 随机抽样到的文章数 */
  sampled: number;
  /** 新入队文章数 */
  created: number;
  /** 已存在被跳过数 */
  skipped: number;
  /** 本轮跑批任务数 */
  queueTotal: number;
  done: number;
  failed: number;
  entitiesCreated: number;
  factDrafts: number;
  tokens: number;
  /** running=执行中（跑批开始即落库）；跑完更新为 success / error */
  status: 'running' | 'success' | 'error';
  error: string | null;
}

export const NEWS_SCHEDULE_KEY = 'NEWS_SCHEDULE';
export const NEWS_SCHEDULES_KEY = 'NEWS_SCHEDULES';
export const NEWS_STATE_KEY = 'NEWS_SCHEDULE_STATE';
export const NEWS_STATES_KEY = 'NEWS_SCHEDULE_STATES';
export const NEWS_RUNS_KEY = 'NEWS_RUN_HISTORY';

export const DEFAULT_NEWS_SCHEDULE: NewsSchedule = {
  id: 0,
  name: '',
  sourceId: '',
  enabled: false,
  datasetId: 0,
  mode: 'interval',
  time: '03:00',
  weekday: 1,
  day: 1,
  intervalMinutes: 60,
  batchSize: 10,
  autoRun: true,
  extractRelations: true,
};
