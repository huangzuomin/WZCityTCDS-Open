/**
 * 正文与引句规范化。
 * 这是「引句逐字回查」(R1) 的唯一真相：入库切片与抽取引句必须用同一套规则，
 * 否则中文全角/半角、空白差异会导致回查假失败。
 */

/**
 * 只统一「括号与引号」+ 去空白，不动中文句读（，。、；：？！）。
 * 与 scripts/validate_v3.py 的 norm() 保持一致的判定口径，
 * 否则入库切片与抽取引句的回查会假失败。
 */
const PAIRS: [string, string][] = [
  ['“', '"'],
  ['”', '"'],
  ['„', '"'],
  ['‘', "'"],
  ['’', "'"],
  ['（', '('],
  ['）', ')'],
  ['［', '['],
  ['］', ']'],
  ['【', '['],
  ['】', ']'],
  ['〔', '['],
  ['〕', ']'],
  ['　', ' '],
];

export function normalizeText(input: string | null | undefined): string {
  let s = String(input ?? '');
  for (const [from, to] of PAIRS) s = s.split(from).join(to);
  return s.replace(/\s+/g, '');
}

/** 正文入库切片：段落内空白折叠、引号统一，段落间单换行 */
export function sliceBody(raw: string | null | undefined): string {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n');
  return text
    .split('\n')
    .map((line) => {
      let l = line.replace(/[ \t\u00a0]+/g, ' ').trim();
      for (const [from, to] of PAIRS) l = l.split(from).join(to);
      return l;
    })
    .filter((l) => l.length > 0)
    .join('\n');
}

export const SLICE_RULE = 'normalize-v1';

/** 归一化字符级映射：归一化串的每个字符对应原文下标（用于把命中位置还原到原文） */
function normalizeWithMap(input: string): { text: string; map: number[] } {
  const pairMap = new Map(PAIRS);
  let text = '';
  const map: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (/\s/.test(ch)) continue;
    const to = pairMap.get(ch) ?? ch;
    for (const c of to) {
      text += c;
      map.push(i);
    }
  }
  return { text, map };
}

/** 编辑距离（只用于短引句的模糊匹配，长度 < 200） */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export interface QuoteLocation {
  start: number;
  end: number;
  /** true = 原文与引句有 1~2 字差异（归一化后），按容错命中 */
  fuzzy?: boolean;
}

/**
 * 在切片里定位引句：命中返回 [start, end)，否则 null。
 * 顺序：原文精确 → 归一化（全半角/引号/空白）→ 模糊容错（≤2 字或相似度 ≥0.95）。
 * 归一化命中会把位置还原到原文下标，避免空白/引号替换导致的偏移。
 */
export function locateQuote(
  slice: string | null | undefined,
  quote: string | null | undefined,
): QuoteLocation | null {
  const body = String(slice ?? '');
  const q = String(quote ?? '').trim();
  if (!body || !q) return null;

  const direct = body.indexOf(q);
  if (direct >= 0) return { start: direct, end: direct + q.length };

  const nQuote = normalizeText(q);
  if (!nQuote) return null;
  const n = normalizeWithMap(body);
  const idx = n.text.indexOf(nQuote);
  if (idx >= 0) {
    return { start: n.map[idx], end: n.map[idx + nQuote.length - 1] + 1 };
  }

  // 模糊容错：滑动窗口找编辑距离最小的等长片段
  if (nQuote.length < 4) return null;
  let best: { start: number; end: number; dist: number } | null = null;
  for (let i = 0; i + nQuote.length <= n.text.length; i++) {
    const d = editDistance(n.text.slice(i, i + nQuote.length), nQuote);
    if (!best || d < best.dist) {
      best = { start: n.map[i], end: n.map[i + nQuote.length - 1] + 1, dist: d };
      if (d === 0) break;
    }
  }
  if (!best) return null;
  if (best.dist <= 2 || best.dist / nQuote.length <= 0.05) {
    return { start: best.start, end: best.end, fuzzy: true };
  }
  return null;
}

/** 引句定位失败时，返回正文里最接近的一段原文（供调用方修正，或人工核对） */
export function closestQuote(
  slice: string | null | undefined,
  quote: string | null | undefined,
  pad = 14,
): string | null {
  const body = String(slice ?? '');
  const q = String(quote ?? '').trim();
  if (!body || !q) return null;
  const direct = body.indexOf(q);
  if (direct >= 0) return body.slice(Math.max(0, direct - pad), direct + q.length + pad);

  const nQuote = normalizeText(q);
  if (!nQuote) return null;
  const n = normalizeWithMap(body);
  const len = nQuote.length;
  if (len > n.text.length) return body.slice(0, Math.min(body.length, 120)).replace(/\s+/g, ' ');

  let best: { i: number; dist: number } | null = null;
  for (let i = 0; i + len <= n.text.length; i++) {
    const d = editDistance(n.text.slice(i, i + len), nQuote);
    if (!best || d < best.dist) {
      best = { i, dist: d };
      if (d === 0) break;
    }
  }
  if (!best) return null;
  const start = n.map[best.i];
  const end = n.map[Math.min(best.i + len - 1, n.map.length - 1)] + 1;
  return body.slice(Math.max(0, start - pad), Math.min(body.length, end + pad)).replace(/\s+/g, ' ');
}

/** 引句所在整句（用于「证据引用片段」的可读性） */
export function sentenceAt(
  text: string,
  start: number,
  end: number,
): { quote: string; start: number; end: number } {
  const s = Math.max(
    text.lastIndexOf('。', Math.max(0, start - 1)) + 1,
    text.lastIndexOf('\n', Math.max(0, start - 1)) + 1,
    text.lastIndexOf('；', Math.max(0, start - 1)) + 1,
  );
  const candidates = [text.indexOf('。', end), text.indexOf('\n', end), text.indexOf('；', end)]
    .filter((x) => x >= 0);
  const e = candidates.length ? Math.min(...candidates) : text.length;
  const raw = text.slice(s, e);
  const lead = raw.length - raw.trimStart().length;
  return { quote: raw.trim(), start: s + lead, end: s + raw.trimEnd().length };
}

/** 时间精度推断（P5 时间三件套） */
export function inferTimePrecision(timeText: string): {
  precision: 'dynasty' | 'decade' | 'year' | 'month' | 'day';
  start: string | null;
  end: string | null;
  inferred: boolean;
} {
  const t = String(timeText ?? '').trim();
  const day = t.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (day) {
    const pad = (v: string) => v.padStart(2, '0');
    return {
      precision: 'day',
      start: `${day[1]}-${pad(day[2])}-${pad(day[3])}`,
      end: `${day[1]}-${pad(day[2])}-${pad(day[3])}`,
      inferred: false,
    };
  }
  const month = t.match(/(\d{4})[-/年](\d{1,2})/);
  if (month) {
    const y = Number(month[1]);
    const m = Number(month[2]);
    const pad = (v: number) => String(v).padStart(2, '0');
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      precision: 'month',
      start: `${y}-${pad(m)}-01`,
      end: `${y}-${pad(m)}-${pad(last)}`,
      inferred: false,
    };
  }
  const decade = t.match(/(\d{4})\s*年代/);
  if (decade) {
    const y = Number(decade[1]);
    return { precision: 'decade', start: `${y}-01-01`, end: `${y + 9}-12-31`, inferred: false };
  }
  const year = t.match(/(\d{4})/);
  if (year) {
    const y = Number(year[1]);
    const inferred = /推算|推测|据.*?报道|文中未/.test(t);
    return { precision: 'year', start: `${y}-01-01`, end: `${y}-12-31`, inferred };
  }
  if (/朝代|年间|清|明|宋|唐|民国|元/.test(t)) {
    return { precision: 'dynasty', start: null, end: null, inferred: true };
  }
  return { precision: 'dynasty', start: null, end: null, inferred: true };
}

type TimePrecision = 'dynasty' | 'decade' | 'year' | 'month' | 'day';
interface TimeResolve {
  precision: TimePrecision;
  start: string | null;
  end: string | null;
  inferred: boolean;
}

const pad2 = (v: number) => String(v).padStart(2, '0');

/** 中文数字/阿拉伯数字 → 数值；失败返回 null（如"几/数"这类不确定量词） */
function cnNum(s: string): number | null {
  if (!s) return null;
  if (/^\d{1,4}$/.test(s)) return parseInt(s, 10);
  const digit = { '零': 0, '一': 1, '两': 2, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  const get = (c: string) => (c in digit ? digit[c as keyof typeof digit] : null);
  if (isNaN(Number(s))) {
    if (s.includes('十')) {
      const [lo, hi] = s.split('十');
      const tens = lo === '' ? 1 : get(lo);
      if (tens === null) return null;
      const ones = hi === '' ? 0 : get(hi);
      if (ones === null) return null;
      const v = tens * 10 + ones;
      return v > 0 ? v : null;
    }
    if (s.length === 1) return get(s);
    return null;
  }
  return Number(s);
}

/** 把锚点（文章发布时间，YYYY-MM-DD 或 Date）解析为 UTC 基准 */
function anchorParts(
  anchor: string | Date | undefined | null,
): { y: number; m: number; d: number; date: Date } {
  if (anchor instanceof Date && !isNaN(anchor.getTime())) {
    return {
      y: anchor.getUTCFullYear(),
      m: anchor.getUTCMonth() + 1,
      d: anchor.getUTCDate(),
      date: new Date(anchor.getTime()),
    };
  }
  const s = String(anchor ?? '').trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return { y: +m[1], m: +m[2], d: +m[3], date };
  }
  const now = new Date();
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate(), date: now };
}

const dstr = (dt: Date) => `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
const monthRange = (y: number, m: number): { start: string; end: string } => {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${y}-${pad2(m)}-01`, end: `${y}-${pad2(m)}-${pad2(last)}` };
};
const yearRange = (y: number): { start: string; end: string } => ({ start: `${y}-01-01`, end: `${y}-12-31` });

/**
 * 相对/模糊时间 → 具体区间（P5 时间补充）。
 * 以文章发布时间为锚：把「今年/去年/前年/N个月前/N年前/N天前/今天/本周/上周/X月X日」
 * 等表述换算成可排序的具体日期。已是绝对表述时退化为 inferTimePrecision。
 */
export function resolveRelativeTime(
  timeText: string,
  anchor: string | Date | undefined | null,
): TimeResolve {
  const t = String(timeText ?? '').trim();
  if (!t) return { precision: 'dynasty', start: null, end: null, inferred: true };

  const abs = inferTimePrecision(t);
  if (abs.start !== null || abs.precision === 'decade') return abs;

  const { y: Y, m: M, d: D, date: base } = anchorParts(anchor);

  // 今天 / 昨天
  if (/今天|今日/.test(t)) return { precision: 'day', start: dstr(base), end: dstr(base), inferred: true };
  if (/昨天|昨日/.test(t)) {
    const dt = new Date(Date.UTC(Y, M - 1, D - 1));
    return { precision: 'day', start: dstr(dt), end: dstr(dt), inferred: true };
  }

  // N天前 / N个月前 / N年前（支持中文数字）
  const nDays = t.match(/([\d一时两二三四五六七八九十]{1,4})\s*天前/);
  if (nDays) {
    const n = cnNum(nDays[1]);
    if (n) {
      const dt = new Date(Date.UTC(Y, M - 1, D - n));
      const s = dstr(dt);
      return { precision: 'day', start: s, end: s, inferred: true };
    }
  }

  const nMonths = t.match(/([\d一时两二三四五六七八九十]{1,4})\s*个月前/);
  if (nMonths) {
    const n = cnNum(nMonths[1]);
    if (n) {
      const idx = Y * 12 + (M - 1) - n;
      const yy = Math.floor(idx / 12);
      const mm = ((idx % 12) + 12) % 12 + 1;
      const { start, end } = monthRange(yy, mm);
      return { precision: 'month', start, end, inferred: true };
    }
  }

  const nYears = t.match(/([\d一时两二三四五六七八九十]{1,4})\s*年前/);
  if (nYears) {
    const n = cnNum(nYears[1]);
    if (n) {
      const yy = Y - n;
      const mm = t.match(/([\d一二两三四五六七八九十]{1,4})\s*月/);
      if (mm) {
        const mVal = cnNum(mm[1]);
        if (mVal) {
          const { start, end } = monthRange(yy, mVal);
          return { precision: 'month', start, end, inferred: true };
        }
      }
      const { start, end } = yearRange(yy);
      return { precision: 'year', start, end, inferred: true };
    }
  }

  // 今年 / 去年 / 前年 / 大前年（可带月份）
  const yearRefs: [RegExp, number][] = [
    [/今年/, 0],
    [/去年/, -1],
    [/前年/, -2],
    [/大前年/, -3],
  ];
  for (const [re, off] of yearRefs) {
    if (re.test(t)) {
      const yy = Y + off;
      // 形如「今年2月份」「去年3月」（支持中文数字）
      const mOf = t.match(/([\d一二两三四五六七八九十]{1,4})\s*月/);
      if (mOf) {
        const mv = cnNum(mOf[1]);
        if (mv) {
          const { start, end } = monthRange(yy, mv);
          return { precision: 'month', start, end, inferred: true };
        }
      }
      const { start, end } = yearRange(yy);
      return { precision: 'year', start, end, inferred: true };
    }
  }

  // 本月 / 上个月
  if (/本月|这个月/.test(t)) {
    const { start, end } = monthRange(Y, M);
    return { precision: 'month', start, end, inferred: true };
  }
  if (/上个月|上月/.test(t)) {
    // last month = (Y,M-2) with borrow
    const idx = Y * 12 + (M - 1) - 1;
    const yy = Math.floor(idx / 12);
    const mm = ((idx % 12) + 12) % 12 + 1;
    const { start, end } = monthRange(yy, mm);
    return { precision: 'month', start, end, inferred: true };
  }

  // 单独「X月X日 / X月】
  const md = t.match(/^([\d一二两三四五六七八九十]{1,4})\s*月\s*([\d一二两三四五六七八九十]{1,4})\s*[日号]/);
  if (md) {
    const mv = cnNum(md[1]);
    const dv = cnNum(md[2]);
    if (mv && dv) {
      const s = `${Y}-${pad2(mv)}-${pad2(dv)}`;
      return { precision: 'day', start: s, end: s, inferred: true };
    }
  }
  const mo = t.match(/([\d一二两三四五六七八九十]{1,4})\s*月/);
  if (mo) {
    const mv = cnNum(mo[1]);
    if (mv) {
      const { start, end } = monthRange(Y, mv);
      return { precision: 'month', start, end, inferred: true };
    }
  }

  // 本周 / 上周（本周周一 / 上周周一）
  const weekMon = (dt: Date) => new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)));
  if (/本周|这周/.test(t)) {
    const s = dstr(weekMon(base));
    return { precision: 'day', start: s, end: s, inferred: true };
  }
  if (/上周|上一周/.test(t)) {
    const lastMon = weekMon(base).getTime() - 7 * 86400000;
    const s = dstr(new Date(lastMon));
    return { precision: 'day', start: s, end: s, inferred: true };
  }

  // 无数字锚的近义模糊词：按用户约定以文章发布日为锚近似。
  // 「近日/最近/近期/日前/目前/当前/当天/同日」→ 发布日；「之后/后来/随后」→ 发布年。
  if (/日前|近日|最近|近期|目前|当前|当下|如今|当天|同日/.test(t)) {
    return { precision: 'day', start: dstr(base), end: dstr(base), inferred: true };
  }
  if (/之后|以后|随后|后来|此后|过后|当年|同年/.test(t)) {
    return { precision: 'year', ...yearRange(Y), inferred: true };
  }

  // 仍未识别 → 无锚可排
  return { precision: 'dynasty', start: null, end: null, inferred: true };
}

/** 字符级 n-gram（去空白），用于近似重复检测 */
export function charNGrams(text: string | null | undefined, n = 3): Set<string> {
  const s = String(text ?? '').replace(/\s+/g, '');
  const out = new Set<string>();
  if (!s) return out;
  if (s.length <= n) {
    out.add(s);
    return out;
  }
  for (let i = 0; i <= s.length - n; i++) out.add(s.slice(i, i + n));
  return out;
}

/** 两个 n-gram 集合的 Jaccard 相似度 [0,1]，空集合视为不相似 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

/** 把已解析的时间写成人可读的具体表述（"2026年2月"/"2026年3月5日"），解析失败保留原文 */
export function concreteTimeText(
  r: { precision: TimePrecision; start: string | null },
  original: string,
): string {
  const y = r.start?.slice(0, 4);
  const m = r.start?.slice(5, 7);
  const d = r.start?.slice(8, 10);
  if (!y) return original;
  const yn = Number(y);
  const mn = m ? Number(m) : NaN;
  const dn = d ? Number(d) : NaN;
  if (r.precision === 'day' && !isNaN(dn)) return `${yn}年${isNaN(mn) ? '' : mn}月${dn}日`;
  if (r.precision === 'month' && !isNaN(mn)) return `${yn}年${mn}月`;
  return `${yn}年`;
}
