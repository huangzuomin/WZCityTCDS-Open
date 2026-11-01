/**
 * 指标口径回补（PRD S04 / AT04）—— 纯函数实现，管线与回填脚本共用。
 *
 * 输入：结构化指标数组 + 原文正文/标题/发布日；
 * 输出：补齐 period / region / sourceNote / sourceArticleId 的指标数组。
 *
 * 铁律：只在同一句内取值，找不到就留空，绝不用发布日期冒充统计期。
 * 唯一例外：原文明确写“今天/今日/当天/昨日”时，可用报道日换算到月（periodBasis=relative_day）。
 */
import { extractRegion } from './metric-keys.js';

export interface EnrichableStat {
  metricKey?: string;
  metricName?: string;
  valueText?: string;
  unit?: string | null;
  period?: string | null;
  region?: string | null;
  scope?: string | null;
  approx?: boolean;
  sourceNote?: string | null;
  sourceArticleId?: number | null;
  sourceUrl?: string | null;
  periodBasis?: string | null;
  enriched?: boolean;
  [k: string]: unknown;
}

export interface EnrichContext {
  body: string;
  title?: string | null;
  publishedAt?: string | Date | null;
  articleId?: number | null;
  url?: string | null;
}

const DURATION_RE = /[天日年个月小时分钟秒]$/;
const AGGREGATE_RE = /合计|总数|总计|总产|全市合计/;

const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 在正文里定位该数值（原样 → 去掉"近/约/余" → 数字核心+单位） */
export function locateValue(body: string, valueText: string): string | null {
  const tries = [valueText, valueText.replace(/^(近|约|超过|逾)/, ''), valueText.replace(/(余|多)$/, '')];
  for (const t of tries) if (t && body.includes(t)) return t;
  const core = valueText.match(/[\d.]+/)?.[0];
  const unit = valueText.replace(/^[^\d]*/, '').replace(/^[\d.]+/, '');
  if (core) {
    if (body.includes(core + unit)) return core + unit;
    if (body.includes(core)) return core;
  }
  return null;
}

/** 取包含该数值的整句与分句序号 */
export function sentenceOf(body: string, needle: string) {
  const idx = body.indexOf(needle);
  if (idx < 0) return null;
  let start = 0;
  for (const m of body.matchAll(/[。；;\n]/g)) {
    if (m.index > idx) break;
    start = m.index + 1;
  }
  const rest = body.slice(start);
  const endM = rest.match(/[。；;\n]/);
  const sentence = endM ? rest.slice(0, endM.index) : rest;
  const parts = sentence.split(/[，,]/);
  const offset = idx - start;
  let acc = 0;
  let partIdx = 0;
  for (let i = 0; i < parts.length; i += 1) {
    if (offset >= acc && offset <= acc + parts[i].length) {
      partIdx = i;
      break;
    }
    acc += parts[i].length + 1;
  }
  return { sentence: sentence.trim(), parts, partIdx };
}

/** 统计期：同分句优先；允许"纯时间前缀分句 + 统计动词"的回退 */
export function pickPeriodKey(parts: string[], partIdx: number): string | null {
  const cur = String(parts[partIdx] ?? '');
  const same = /((?:19|20)\d{2})\s*年(?:\s*(\d{1,2})\s*月)?/.exec(cur);
  if (same) return same[2] ? `${same[1]}-${String(same[2]).padStart(2, '0')}` : same[1];
  if (!/(达|为|共|占|超|增至|增长|实现|合计|投资|产值|产量|面积|金额|规模|接待|销售|营收)/.test(cur)) return null;
  const prev = String(parts[partIdx - 1] ?? '').trim();
  if (prev.length > 16) return null;
  const m = /^((?:19|20)\d{2})\s*年(?:\s*(\d{1,2})\s*月)?$/.exec(prev.replace(/[，,]$/, '').trim());
  if (!m) return null;
  return m[2] ? `${m[1]}-${String(m[2]).padStart(2, '0')}` : m[1];
}

/** 地域：合计类取标题；否则同分句 → 同句 → 不含数字的邻近分句 */
export function pickRegion(parts: string[], partIdx: number, opts: { aggregate?: boolean; title?: string | null; sentence?: string }) {
  if (opts.aggregate) {
    const t = extractRegion(String(opts.title ?? ''));
    if (t) return t;
  }
  const cur = String(parts[partIdx] ?? '');
  const hit = extractRegion(cur) ?? (/全市/.test(cur) ? '温州市' : null);
  if (hit) return hit;
  const sent = String(opts.sentence ?? '');
  const fromSent = extractRegion(sent) ?? (/全市/.test(sent) ? '温州市' : null);
  if (fromSent) return fromSent;
  for (let i = partIdx - 1; i >= 0 && i >= partIdx - 3; i -= 1) {
    const p = String(parts[i] ?? '');
    if (/\d/.test(p)) continue;
    const r = extractRegion(p) ?? (/全市/.test(p) ? '温州市' : null);
    if (r) return r;
  }
  return null;
}

export function pickSourceNote(sentence: string): string | null {
  const m = sentence.match(/据([^，。]{2,24}?)(数据|统计|介绍|通报|披露)/);
  return m ? `据${m[1]}${m[2]}` : null;
}

/**
 * 批量回补。refresh=true 时重算已填过的 period/region（用于规则修正后的重跑）。
 */
export function enrichKeyStatsFromBody<T extends EnrichableStat>(items: T[], ctx: EnrichContext, refresh = false): T[] {
  const body = clean(ctx.body);
  if (!body || !Array.isArray(items)) return items;
  for (const it of items) {
    if (!refresh && it.period && it.region) continue;
    const valueText = String(it.valueText ?? '');
    if (!valueText) continue;
    const hit = locateValue(body, valueText);
    if (!hit) continue;
    const loc = sentenceOf(body, hit);
    if (!loc) continue;

    let period = (refresh ? null : it.period) ?? (DURATION_RE.test(valueText) ? null : pickPeriodKey(loc.parts, loc.partIdx));
    let periodBasis = period ? it.periodBasis ?? 'explicit_in_text' : null;
    if (!period && /今天|今日|当天|昨日/.test(loc.sentence) && ctx.publishedAt) {
      const d = new Date(ctx.publishedAt as string);
      if (!Number.isNaN(d.getTime())) {
        period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        periodBasis = 'relative_day';
      }
    }
    const aggregate = AGGREGATE_RE.test(String(it.scope ?? ''));
    const region =
      (refresh ? null : it.region) ?? pickRegion(loc.parts, loc.partIdx, { aggregate, title: ctx.title, sentence: loc.sentence });
    const note = it.sourceNote ?? pickSourceNote(loc.sentence);

    if (period || region || note) {
      it.period = period ?? null;
      it.region = region ?? null;
      if (periodBasis) it.periodBasis = periodBasis;
      if (note) it.sourceNote = note;
      if (ctx.articleId) it.sourceArticleId = ctx.articleId;
      if (ctx.url) it.sourceUrl = ctx.url;
      it.enriched = true;
    }
  }
  return items;
}
