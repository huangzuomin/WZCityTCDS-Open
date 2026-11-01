/** 实体状态 */
export const ENTITY_STATUS = ['draft', 'published', 'archived'] as const;
export type EntityStatus = (typeof ENTITY_STATUS)[number];

/** 事实状态：append-only 版本链上的生命周期 */
export const FACT_STATUS = [
  'draft', // LLM 抽取或人工录入草稿
  'pending_review', // 待审核
  'active', // 当前有效
  'superseded', // 已被新版本替代（保留备查）
  'pending_arbitration', // 口径冲突待仲裁
  'rejected', // 审核驳回
  'archived',
] as const;
export type FactStatus = (typeof FACT_STATUS)[number];

/** 事实来源 */
export const FACT_ORIGIN = ['llm', 'human', 'import'] as const;
export type FactOrigin = (typeof FACT_ORIGIN)[number];

/** 事实变化类型 */
export const CHANGE_TYPE = ['new', 'update', 'corroborate', 'retire'] as const;
export type ChangeType = (typeof CHANGE_TYPE)[number];

/** 证据校验状态 */
export const VERIFY_STATUS = ['pending', 'passed', 'failed'] as const;
export type VerifyStatus = (typeof VERIFY_STATUS)[number];

/** 语料批次 */
export const ARTICLE_BATCH = ['baseline', 'incremental'] as const;
export type ArticleBatch = (typeof ARTICLE_BATCH)[number];

/** 时间精度：用于模糊时间排序 */
export const TIME_PRECISION = ['dynasty', 'decade', 'year', 'month', 'day'] as const;
export type TimePrecision = (typeof TIME_PRECISION)[number];

/** 抽取运行/草稿状态 */
export const RUN_STATUS = ['pending', 'running', 'succeeded', 'failed'] as const;
export const DRAFT_STATUS = ['pending', 'approved', 'rejected'] as const;
export type DraftStatus = (typeof DRAFT_STATUS)[number];

/** 自定义字段类型 */
export const FIELD_TYPE = [
  'text',
  'textarea',
  'number',
  'date',
  'select',
  'multiselect',
  'boolean',
  'url',
  'json',
  'entity_ref',
] as const;
export type FieldType = (typeof FIELD_TYPE)[number];

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: '单行文本',
  textarea: '多行文本',
  number: '数字',
  date: '日期',
  select: '单选',
  multiselect: '多选',
  boolean: '是否',
  url: '链接',
  json: 'JSON',
  entity_ref: '实体关联',
};

/** 对外品牌名（内部代号 SSOT 只出现在代码/运维里，不进任何用户可见文案） */
export const BRAND_NAME = '温州有据';

/**
 * 页面标题统一带上品牌后缀：预渲染页与前端运行时用同一个函数，
 * 避免两处各写一套导致标题口径分裂。已含品牌时不再重复追加。
 */
export const withBrand = (title: string): string =>
  String(title ?? '').includes(BRAND_NAME) ? String(title ?? '') : `${title} · ${BRAND_NAME}`;
