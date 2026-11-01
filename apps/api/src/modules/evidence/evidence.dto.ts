import { z } from 'zod';

export const createEvidenceSchema = z.object({
  entityId: z.coerce.number().int().positive(),
  articleId: z.coerce.number().int().positive(),
  quote: z.string().trim().min(2),
  /** 不传则按引句在正文切片里自动定位 */
  spanStart: z.coerce.number().int().min(0).optional(),
  spanEnd: z.coerce.number().int().min(0).optional(),
  sourceOrg: z.string().trim().max(128).optional(),
  materialTitle: z.string().trim().max(512).optional(),
  sourceUrl: z.string().trim().max(1024).optional(),
  publishedAt: z.string().trim().max(32).optional().nullable(),
  assetUrn: z.string().trim().max(255).optional(),
  qualityGrade: z.enum(['A', 'B', 'C', 'D']).default('B'),
  batch: z.enum(['baseline', 'incremental']).default('baseline'),
  origin: z.enum(['llm', 'human', 'import']).default('human'),
  status: z.enum(['draft', 'active', 'rejected']).default('draft'),
  code: z.string().trim().max(32).optional(),
});

export const updateEvidenceSchema = createEvidenceSchema
  .partial()
  .omit({ entityId: true, articleId: true });

export const listEvidenceQuerySchema = z.object({
  entityId: z.coerce.number().int().positive().optional(),
  articleId: z.coerce.number().int().positive().optional(),
  status: z.enum(['draft', 'active', 'rejected']).optional(),
  verifyStatus: z.enum(['pending', 'passed', 'failed']).optional(),
  batch: z.enum(['baseline', 'incremental']).optional(),
  keyword: z.string().trim().max(128).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

export const verifySchema = z.object({
  verifyStatus: z.enum(['pending', 'passed', 'failed']),
  verifyDetail: z.string().max(2000).optional().nullable(),
});

export const anchorPreviewSchema = z.object({
  articleId: z.coerce.number().int().positive(),
  quote: z.string().trim().min(1).optional(),
  spanStart: z.coerce.number().int().min(0).optional(),
  spanEnd: z.coerce.number().int().min(0).optional(),
  context: z.coerce.number().int().min(0).max(2000).default(120),
});

export type CreateEvidenceDto = z.infer<typeof createEvidenceSchema>;
export type UpdateEvidenceDto = z.infer<typeof updateEvidenceSchema>;
export type ListEvidenceQuery = z.infer<typeof listEvidenceQuerySchema>;
