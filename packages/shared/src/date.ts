/**
 * 业务时区固定为北京时间（Asia/Shanghai，UTC+8，无夏令时）。
 * 服务器/容器可能在 UTC，直接用 Date#toISOString 取「今天」会把凌晨 8 点前的数据
 * 算成前一天，故统一走这里。
 */

const SHANGHAI_OFFSET_MS = 8 * 3600_000;

/** 北京时间下的「今天」日期字符串 YYYY-MM-DD */
export function todayInShanghai(now: Date = new Date()): string {
  return new Date(now.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/** 北京时间下的当前时刻 ISO 字符串（带 +08:00 偏移） */
export function nowInShanghaiIso(now: Date = new Date()): string {
  return `${new Date(now.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 19)}+08:00`;
}

/**
 * 时间精度（PRD R03）：period_key 的形状即精度，不允许把年份精确化为 01-01。
 */
export type PeriodPrecision = 'year' | 'quarter' | 'month' | 'unknown';

export function periodPrecision(periodKey: string | null | undefined): PeriodPrecision {
  const p = String(periodKey ?? '').trim();
  if (!p) return 'unknown';
  if (/^\d{4}$/.test(p)) return 'year';
  if (/^\d{4}-Q[1-4]$/i.test(p)) return 'quarter';
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(p)) return 'month';
  return 'unknown';
}

/**
 * period_key → 时间区间（用于展示与筛选，不伪造单日）。
 *   2025    → 2025-01-01 ~ 2025-12-31
 *   2025-Q1 → 2025-01-01 ~ 2025-03-31
 *   2025-07 → 2025-07-01 ~ 2025-07-31
 */
export function periodKeyToRange(periodKey: string | null | undefined): { from: string; to: string } | null {
  const p = String(periodKey ?? '').trim();
  const prec = periodPrecision(p);
  if (prec === 'year') {
    return { from: `${p}-01-01`, to: `${p}-12-31` };
  }
  if (prec === 'quarter') {
    const y = p.slice(0, 4);
    const q = Number(p.slice(-1));
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    const lastDay = new Date(Date.UTC(Number(y), endMonth, 0)).getUTCDate();
    return {
      from: `${y}-${String(startMonth).padStart(2, '0')}-01`,
      to: `${y}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    };
  }
  if (prec === 'month') {
    const y = p.slice(0, 4);
    const mo = Number(p.slice(5, 7));
    const lastDay = new Date(Date.UTC(Number(y), mo, 0)).getUTCDate();
    return { from: `${p}-01`, to: `${p}-${String(lastDay).padStart(2, '0')}` };
  }
  return null;
}

/**
 * 由槽位 period_key 推 valid_from（**仅月份精度**才有单日起点）：
 *   2025-07 → 2025-07-01
 *   2025 / 2025-Q1 → null（只有年/季度精度，禁止写成 01-01，改用 periodKeyToRange）
 * 无时间线索 → null。
 */
export function periodKeyToValidFrom(periodKey: string | null | undefined): string | null {
  const p = String(periodKey ?? '').trim();
  if (periodPrecision(p) !== 'month') return null;
  return `${p}-01`;
}

const CN_QUARTER: Record<string, string> = { 一: '1', 二: '2', 三: '3', 四: '4' };

/**
 * 由事实陈述文本推断槽位 period_key（`periodKeyToValidFrom` 的逆映射）。
 * 只取**首个**命中的时间，避免多时间区间造成歧义。命中优先级：
 *   年月  2025年7月 / 2025 年 7 月 / 2025-07   → 2025-07
 *   季度  2025年第一季度 / 2025年第1季度 / 2025Q1 → 2025-Q1
 *   年份  2025年 / 2025年度 / 2025年度名单      → 2025
 * 无任何时间线索（纯定义、定性描述）→ null。
 * 年份限定 1900–2099；**裸年份必须带「年」字**，否则「2000亩」「2600万元」这类数量会被误判成时间。
 */
export function inferPeriodKeyFromStatement(statement: string | null | undefined): string | null {
  const s = String(statement ?? '');
  if (!s) return null;

  // 年月：2025年7月 / 2025 年 7 月
  let m = s.match(/\b((?:19|20)\d{2})\s*年\s*([01]?\d)\s*月/);
  if (m) {
    const mo = Number(m[2]);
    if (mo >= 1 && mo <= 12) return `${m[1]}-${String(mo).padStart(2, '0')}`;
  }
  // 连字符年月：2025-07
  m = s.match(/\b((?:19|20)\d{2})-([01]\d)(?!\d)/);
  if (m) {
    const mo = Number(m[2]);
    if (mo >= 1 && mo <= 12) return `${m[1]}-${m[2]}`;
  }
  // 季度：2025年第一季度 / 2025年第1季度
  m = s.match(/\b((?:19|20)\d{2})\s*年?\s*第?\s*([1-4一二三四])\s*季度/);
  if (m) return `${m[1]}-Q${CN_QUARTER[m[2]] ?? m[2]}`;
  // 季度：2025Q1
  m = s.match(/\b((?:19|20)\d{2})\s*Q([1-4])(?!\d)/i);
  if (m) return `${m[1]}-Q${m[2]}`;
  // 年份：必须带「年」字，否则「2000亩」「2600万元」这类数量会被误判成时间
  m = s.match(/\b(?:19|20)\d{2}\s*年/);
  if (m) return m[0].match(/(?:19|20)\d{2}/)![0];
  return null;
}
