import { eq } from 'drizzle-orm';
import type { Db } from '../../db/db.module';
import { systemSettings } from '../../db/schema';

/**
 * 多新闻源管理。
 *
 * 每个源 = 一条独立配置，类型二选一：
 *  - `es`   ：Elasticsearch（66wz 温州新闻网，见 news-es.ts），靠增量游标采集；
 *  - `http` ：通用 JSON 接口，从接口拉取新闻列表，按字段映射解析，靠已入库 id 去重。
 * 源列表持久化在 system_setting（NEWS_SOURCES_KEY），每源的增量游标在 NEWS_CURSORS_KEY（按源 id）。
 * 每源绑定一个目标语料域（datasetId），入库/跑批都落到它。
 */
import {
  fetchLatest,
  fetchSinceCursor,
  hitToCursor,
  hitToDoc,
  type NewsEsConfig,
  type NewsEsCursor,
} from './news-es';

export type NewsSourceType = 'es' | 'http';

export interface NewsHttpConfig {
  /** 接口地址 */
  url: string;
  /** 请求方法 */
  method: 'GET' | 'POST';
  /** 请求头（JSON 字符串，如 {"Authorization":"Bearer xxx"}） */
  headersJson: string;
  /** JSON 中列表所在路径（点路径，空 = 根） */
  listPath: string;
  /** 请求体 JSON（POST 时可选） */
  bodyJson: string;
  /** 字段映射 */
  idField: string;
  titleField: string;
  pubDateField: string;
  urlField: string;
  contentField: string;
  sourceNameField: string;
  /** 固定来源媒体名（sourceNameField 为空时用） */
  sourceName: string;
  bodyMin: number;
  bodyMax: number;
}

export interface NewsSource {
  id: string;
  type: NewsSourceType;
  name: string;
  enabled: boolean;
  /** 绑定目标语料域 */
  datasetId: number;
  /** type=es 时的 ES 配置 */
  es?: NewsEsConfig;
  /** type=http 时的接口配置 */
  http?: NewsHttpConfig;
}

/** 统一后的文档结构（与 EsNewsDoc 对齐，供 createQueueFromDocs 入库） */
export interface NewsDoc {
  assetId: string;
  title: string | null;
  sourceName: string | null;
  pubDate: string | null;
  sourceUrl: string | null;
  contentText: string;
  bodyChars: number;
}

export const NEWS_SOURCES_KEY = 'NEWS_SOURCES';
export const NEWS_CURSORS_KEY = 'NEWS_CURSORS';

export const DEFAULT_NEWS_HTTP_CONFIG: Omit<NewsHttpConfig, 'url'> = {
  method: 'GET',
  headersJson: '',
  listPath: '',
  bodyJson: '',
  idField: 'id',
  titleField: 'title',
  pubDateField: 'pubDate',
  urlField: 'url',
  contentField: 'content',
  sourceNameField: '',
  sourceName: '',
  bodyMin: 500,
  bodyMax: 3000,
};

// ---------------------------------------------------------------- 源列表持久化

export async function loadSources(db: Db): Promise<NewsSource[]> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.skey, NEWS_SOURCES_KEY)).limit(1);
  if (!row) return [];
  try {
    const v = JSON.parse(row.svalue) as NewsSource[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function saveSources(db: Db, sources: NewsSource[]): Promise<void> {
  await db
    .insert(systemSettings)
    .values({ skey: NEWS_SOURCES_KEY, svalue: JSON.stringify(sources) })
    .onDuplicateKeyUpdate({ set: { svalue: JSON.stringify(sources) } });
}

export async function getAllSources(db: Db): Promise<{ sources: NewsSource[] }> {
  return { sources: await loadSources(db) };
}

/** 生成短唯一 id */
export function newSourceId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 规范化补默认值（保存前调用） */
export function normalizeSource(s: NewsSource): NewsSource {
  if (s.type === 'http') {
    s.http = { ...DEFAULT_NEWS_HTTP_CONFIG, ...(s.http ?? {}), url: (s.http?.url || '').trim() };
    s.http.bodyMin = Math.min(Math.max(Number(s.http.bodyMin) || 0, 0), 100_000);
    s.http.bodyMax = Math.min(Math.max(Number(s.http.bodyMax) || 0, s.http.bodyMin), 1_000_000);
  } else if (s.type === 'es') {
    s.es = {
      url: (s.es?.url || 'http://localhost:9200').replace(/\/+$/, ''),
      username: s.es?.username || '',
      password: s.es?.password || '',
      index: s.es?.index || 'wz_content_assets_v1',
      sourceName: s.es?.sourceName || '',
      sourceSystem: s.es?.sourceSystem || '',
      bodyMin: Math.min(Math.max(Number(s.es?.bodyMin) || 0, 0), 100_000),
      bodyMax: Math.min(Math.max(Number(s.es?.bodyMax) || 0, s.es?.bodyMin || 0), 1_000_000),
    };
  }
  return s;
}

// ---------------------------------------------------------------- 每源游标

export async function loadCursors(db: Db): Promise<Record<string, NewsEsCursor>> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.skey, NEWS_CURSORS_KEY)).limit(1);
  if (!row) return {};
  try {
    const v = JSON.parse(row.svalue) as Record<string, NewsEsCursor>;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export async function saveCursors(db: Db, cursors: Record<string, NewsEsCursor>): Promise<void> {
  await db
    .insert(systemSettings)
    .values({ skey: NEWS_CURSORS_KEY, svalue: JSON.stringify(cursors) })
    .onDuplicateKeyUpdate({ set: { svalue: JSON.stringify(cursors) } });
}

export async function loadCursorFor(db: Db, sourceId: string): Promise<NewsEsCursor | null> {
  const all = await loadCursors(db);
  return all[sourceId] ?? null;
}

export async function clearCursors(db: Db): Promise<void> {
  await db.delete(systemSettings).where(eq(systemSettings.skey, NEWS_CURSORS_KEY));
}

// ---------------------------------------------------------------- http 源拉取

function getByPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

/** GET/POST 请求返回 JSON（尝试 json，失败按文本） */
async function httpRequest(cfg: NewsHttpConfig): Promise<unknown> {
  let headers: Record<string, string> = {};
  if (cfg.headersJson) {
    try {
      headers = JSON.parse(cfg.headersJson);
    } catch {
      headers = {};
    }
  }
  const opts: RequestInit = {
    method: cfg.method,
    headers,
    signal: AbortSignal.timeout(120_000),
  };
  if (cfg.method === 'POST' && cfg.bodyJson) opts.body = cfg.bodyJson;
  const res = await fetch(cfg.url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}：${text.slice(0, 300) || res.statusText}`);
  }
  const ct = res.headers.get('content-type') || '';
  const raw = await res.text();
  if (ct.includes('json')) return JSON.parse(raw);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`返回不是 JSON：${raw.slice(0, 200)}`);
  }
}

/** 把接口 JSON 列表解析为标准文档（按字段映射），按正文长度过滤 */
export function httpItemsToDocs(cfg: NewsHttpConfig, items: unknown[]): NewsDoc[] {
  const docs: NewsDoc[] = [];
  const fixedSource = cfg.sourceName || '';
  for (const item of items) {
    if (item == null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const title = str(cfg.titleField ? o[cfg.titleField] : o.id);
    const contentText = str(cfg.contentField ? o[cfg.contentField] : o.content);
    if (!title && !contentText) continue;
    const len = contentText.length;
    if (len < cfg.bodyMin || len > cfg.bodyMax) continue;
    const assetId = str(cfg.idField ? o[cfg.idField] : o.id) || shaFallback(contentText + title);
    const sourceName = cfg.sourceNameField && o[cfg.sourceNameField] != null ? str(o[cfg.sourceNameField]) : fixedSource;
    docs.push({
      assetId,
      title: title || null,
      sourceName: sourceName || null,
      pubDate: cfg.pubDateField && o[cfg.pubDateField] != null ? str(o[cfg.pubDateField]) : null,
      sourceUrl: cfg.urlField && o[cfg.urlField] != null ? str(o[cfg.urlField]) : null,
      contentText,
      bodyChars: len,
    });
  }
  return docs;
}

function shaFallback(v: string): string {
  let h = 5381;
  for (let i = 0; i < v.length; i += 1) h = ((h << 5) + h + v.charCodeAt(i)) | 0;
  return `http:${h.toString(16)}`;
}

/** 递归查找返回 JSON 里的第一层数组（用于自动定位列表，供 listPath 留空时兜底） */
function findTopArray(obj: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  // 优先常见的列表键
  for (const k of ['list', 'items', 'records', 'rows', 'results', 'result', 'data', 'content', 'dataList', 'articles']) {
    const v = (obj as Record<string, unknown>)[k];
    if (Array.isArray(v)) return v;
  }
  for (const v of Object.values(obj)) {
    const found = findTopArray(v, depth + 1);
    if (found) return found;
  }
  return null;
}

/** http 源拉取一批文档（去重交给入库层的幂等 external_key） */
export async function httpPull(cfg: NewsHttpConfig): Promise<NewsDoc[]> {
  const json = await httpRequest(cfg);
  let listRaw = getByPath(json, cfg.listPath);
  if (!Array.isArray(listRaw)) listRaw = findTopArray(json) ?? null; // 路径取不到则自动探测数组
  if (!Array.isArray(listRaw)) throw new Error('未在接口返回中找到新闻列表数组，请在「列表路径」填写数组所在路径');
  return httpItemsToDocs(cfg, listRaw);
}

// ---------------------------------------------------------------- 统一拉取入口

export interface SourcePullResult {
  docs: NewsDoc[];
  /** es 源推进后写入游标；http 源为 null */
  cursor: NewsEsCursor | null;
}

/** 按源类型拉取待入库文档（内存态，未写库游标）。es 无游标时取 limit 条最新。 */
export async function pullSource(db: Db, src: NewsSource, limit: number): Promise<SourcePullResult> {
  if (src.type === 'es') {
    const cfg = src.es!;
    const cursor = await loadCursorFor(db, src.id);
    if (cursor) {
      const hits = await fetchSinceCursor(cfg, cursor);
      return { docs: hits.map(hitToDoc), cursor: null };
    }
    const hits = await fetchLatest(cfg, limit);
    const newest = hits[hits.length - 1] ?? null; // 降序取最后一条即最新
    return {
      docs: hits.map(hitToDoc),
      cursor: newest ? hitToCursor(newest) : null,
    };
  }
  const cfg = src.http!;
  const docs = await httpPull(cfg);
  return { docs, cursor: null };
}