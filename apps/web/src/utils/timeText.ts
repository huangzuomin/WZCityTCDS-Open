/**
 * 时间文案工具：区分「纯日期字段」与「带时刻字段」。
 *
 * `source_article.published_at`、`fact_change.occurred_at` 在库里是 MySQL date 类型，
 * 值形如 "2026-10-18"。JS 的 `new Date("2026-10-18")` 会按 UTC 零点解析，
 * 浏览器在北京时区 (+8) 渲染时就会凭空多出 08:00 这类假时刻。
 *
 * 因此这里按「值本身是不是纯日期串」判断，而不是按字段名——多个页面都有
 * `日期字段 || createdAt` 的回退：回退到带时刻的 createdAt 时仍需显示时刻。
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** 值是否为纯日期串（YYYY-MM-DD，不含时刻） */
export const isDateOnly = (v: string | null | undefined): boolean => typeof v === 'string' && DATE_ONLY.test(v);

/** 纯日期 → YYYY/MM/DD（不补时刻）；带时刻 → 年/月/日 时:分 */
export const formatDateTime = (v: string | null | undefined): string => {
  if (!v) return '—';
  if (isDateOnly(v)) return v.replace(/-/g, '/');
  return new Date(v).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};

/** 纯日期 → YYYY/MM/DD；带时刻 → 时:分 */
export const formatClock = (v: string | null | undefined): string => {
  if (!v) return '—';
  if (isDateOnly(v)) return v.replace(/-/g, '/');
  return new Date(v).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
};
