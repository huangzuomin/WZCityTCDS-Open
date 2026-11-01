import { z } from 'zod';

export const listDraftQuerySchema = z.object({
  runId: z.coerce.number().int().positive().optional(),
  entityId: z.coerce.number().int().positive().optional(),
  datasetId: z.coerce.number().int().positive().optional(),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  targetType: z.enum(['fact', 'evidence', 'event', 'change', 'entity', 'relation']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

export const reviewDraftSchema = z.object({
  /** 通过前的人工改写；不传则按原样入库 */
  statement: z.string().trim().min(2).max(4000).optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  dimension: z.string().trim().min(1).max(64).optional(),
  reason: z.string().max(1000).optional(),
  /** 与库中同维度现行事实冲突时的裁决：采纳新 / 保留旧 / 多流派并存 */
  resolution: z.enum(['adopt_new', 'keep_old', 'coexist']).optional(),
  note: z.string().max(2000).optional().nullable(),
});

export const batchReviewSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).min(1).max(500),
  action: z.enum(['approve', 'reject']),
  reason: z.string().max(1000).optional(),
});

/** 大模型审批关系草稿：不传 ids = 全部 pending 关系草稿 */
export const llmReviewSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).min(1).max(500).optional(),
});

export type ListDraftQuery = z.infer<typeof listDraftQuerySchema>;
