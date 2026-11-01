import { z } from 'zod';

export const factStatusSchema = z.enum([
  'draft',
  'pending_review',
  'active',
  'superseded',
  'pending_arbitration',
  'rejected',
  'archived',
]);

export const factSemanticRoleSchema = z.enum([
  'metric',
  'trend',
  'ratio',
  'comparison',
  'record',
  'definition',
]);

export const createFactSchema = z.object({
  entityId: z.coerce.number().int().positive(),
  /** 维度 code（对应 fact_dimension.code，如 craft / honor / venue） */
  dimension: z.string().trim().min(1).max(64),
  statement: z.string().trim().min(2),
  factType: z.enum(['current_state', 'source_claim', 'occurred']).default('source_claim'),
  confidence: z.coerce.number().min(0).max(1).default(0.5),
  firstSeenAt: z.string().trim().max(32).optional().nullable(),
  lastVerifiedAt: z.string().trim().max(32).optional().nullable(),
  validFrom: z.string().trim().max(32).optional().nullable(),
  validTo: z.string().trim().max(32).optional().nullable(),
  arbitrationNote: z.string().max(2000).optional().nullable(),
  origin: z.enum(['llm', 'human', 'import']).default('human'),
  /** v2 时间语义：决定「适用性」标签（当前/待生效/历史/计划/截至） */
  temporalKind: z
    .enum(['unknown', 'effective', 'event', 'historical', 'period', 'plan', 'as_of'])
    .default('unknown')
    .optional(),
  asOf: z.string().trim().max(32).optional().nullable(),
  eventStart: z.string().trim().max(32).optional().nullable(),
  eventEnd: z.string().trim().max(32).optional().nullable(),
  /** 核对方式（如「报道依据核对」） */
  method: z.string().trim().max(128).optional().nullable(),
  /** 签发方式：存量导入 / 自动规则签发 / 人工签发 */
  signMode: z.enum(['import', 'auto', 'human']).optional(),
  /** 来源权威类型（新闻报道转述 / 机构通知 / 采访记录 / 模拟） */
  sourceAuthority: z.string().trim().max(128).optional().nullable(),
  /** 是否经过独立真实性现场核验 */
  independentlyVerified: z.boolean().optional(),
  /** 本修订签发时刻 */
  issuedAt: z.string().trim().max(32).optional().nullable(),
  /** 事实级告警（如「存量提取错误，待人工更正」） */
  alerts: z.array(z.string().max(512)).optional(),
  /** 入库后直接生效；草稿制下由管线写入时传 draft */
  status: factStatusSchema.default('active'),
  code: z.string().trim().max(32).optional(),
  evidenceIds: z.array(z.coerce.number().int().positive()).max(200).default([]),
  /** 变化摘要（写入 fact_change.summary） */
  changeSummary: z.string().max(512).optional().nullable(),
  articleId: z.coerce.number().int().positive().optional().nullable(),
  /** 基线建库时不产生 NEW 变化（只有被新闻驱动的更新/确认/新增才记入事实变化） */
  suppressChange: z.boolean().default(false),
  /** 冲突裁决用：为 true 时不自动把同维度旧事实转 superseded（配合 status 自定义） */
  skipSupersede: z.boolean().default(false),
  /** v1.1 槽位坐标：不提供时由归并裁决器（大模型）标注 */
  semanticRole: factSemanticRoleSchema.optional().nullable(),
  periodKey: z.string().trim().max(32).optional().nullable(),
  subjectScope: z.string().trim().max(128).optional().nullable(),
});

/** 元数据修改：原地改 + 只写 audit_log，不产生新版本 */
export const updateFactSchema = z.object({
  status: factStatusSchema.optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  arbitrationNote: z.string().max(2000).optional().nullable(),
  dimension: z.string().trim().min(1).max(64).optional(),
  factType: z.enum(['current_state', 'source_claim', 'occurred']).optional(),
  validFrom: z.string().trim().max(32).optional().nullable(),
  validTo: z.string().trim().max(32).optional().nullable(),
  lastVerifiedAt: z.string().trim().max(32).optional().nullable(),
  code: z.string().trim().max(32).optional(),
  /** v2 时间语义 / 签发责任 / 告警（元数据修改同样可改，但只写 audit_log，不产生新版本） */
  temporalKind: z
    .enum(['unknown', 'effective', 'event', 'historical', 'period', 'plan', 'as_of'])
    .optional(),
  asOf: z.string().trim().max(32).optional().nullable(),
  eventStart: z.string().trim().max(32).optional().nullable(),
  eventEnd: z.string().trim().max(32).optional().nullable(),
  method: z.string().trim().max(128).optional().nullable(),
  signMode: z.enum(['import', 'auto', 'human']).optional(),
  sourceAuthority: z.string().trim().max(128).optional().nullable(),
  independentlyVerified: z.boolean().optional(),
  issuedAt: z.string().trim().max(32).optional().nullable(),
  alerts: z.array(z.string().max(512)).optional(),
});

export const listFactQuerySchema = z.object({
  entityId: z.coerce.number().int().positive().optional(),
  dimension: z.string().trim().max(64).optional(),
  status: factStatusSchema.optional(),
  keyword: z.string().trim().max(128).optional(),
  /** 只返回当前有效（每个维度的最新版本） */
  current: z.coerce.boolean().optional(),
  /** 只返回现行事实（active / pending_arbitration），排除已被替代与归档的历史版本 */
  activeOnly: z.coerce.boolean().optional(),
  /** TTL 过期待核验 */
  expired: z.coerce.boolean().optional(),
  ttlDays: z.coerce.number().int().min(1).max(3650).default(365),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

export const attachEvidenceSchema = z.object({
  evidenceId: z.coerce.number().int().positive(),
  role: z.enum(['support', 'refute']).default('support'),
});

export const arbitrateSchema = z.object({
  entityId: z.coerce.number().int().positive(),
  dimension: z.string().trim().min(1).max(64),
  /** adopt=采纳某版本（其余转 superseded）；coexist=标为多流派并存 */
  mode: z.enum(['adopt', 'coexist']),
  winnerFactId: z.coerce.number().int().positive().optional(),
  note: z.string().max(2000).optional().nullable(),
});

export type CreateFactDto = z.infer<typeof createFactSchema>;
export type UpdateFactDto = z.infer<typeof updateFactSchema>;
export type ListFactQuery = z.infer<typeof listFactQuerySchema>;
export type ArbritrateDto = z.infer<typeof arbitrateSchema>;
