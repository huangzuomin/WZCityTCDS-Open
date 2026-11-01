import { sql, type SQL } from 'drizzle-orm';

/**
 * 公开可见范围（PRD R05 双重门禁）的唯一判定入口。
 *
 * 事实：status='active' AND review_status='approved' AND publication_status='published'
 * 主题：publication_status='published'
 *
 * 开关 PUBLISH_GATE_ENABLED（默认 true）：置 0/false/off 时退回旧口径（只看 status='active'），
 * 作为灰度与回滚手段；不允许在业务代码里另写一套过滤条件。
 */
export function publishGateEnabled(): boolean {
  const v = String(process.env.PUBLISH_GATE_ENABLED ?? 'true')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/** 生成 `f.status='active' AND ...` 片段；alias 为 SQL 别名，如 f / fact */
export function publicFactSql(alias = 'f'): SQL {
  const a = sql.raw(alias);
  if (!publishGateEnabled()) return sql`${a}.status = 'active'`;
  return sql`${a}.status = 'active'
    AND ${a}.review_status = 'approved'
    AND ${a}.publication_status = 'published'`;
}

/** 生成主题公开条件片段 */
export function publicTopicSql(alias = 't'): SQL {
  const a = sql.raw(alias);
  if (!publishGateEnabled()) return sql`${a}.status = 'active'`;
  return sql`${a}.status = 'active' AND ${a}.publication_status = 'published'`;
}

/** 事实是否可公开（内存判定，供渲染层复用，避免各处重复写三条件） */
export function isFactPublic(f: Record<string, unknown>): boolean {
  if (!publishGateEnabled()) return String(f.status ?? '') === 'active';
  return (
    String(f.status ?? '') === 'active' &&
    String(f.reviewStatus ?? f.review_status ?? '') === 'approved' &&
    String(f.publicationStatus ?? f.publication_status ?? '') === 'published'
  );
}
