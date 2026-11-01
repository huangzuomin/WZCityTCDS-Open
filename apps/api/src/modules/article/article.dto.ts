import { z } from 'zod';

export const importItemSchema = z.object({
  title: z.string().trim().min(1).max(512),
  url: z.string().trim().min(1).max(1024),
  text: z.string().max(4_000_000).optional().nullable(),
  sourceOrg: z.string().trim().max(128).optional().nullable(),
  sourceSite: z.string().trim().max(64).optional().nullable(),
  publishedAt: z.string().trim().max(32).optional().nullable(),
  externalId: z.string().trim().max(64).optional().nullable(),
  quality: z.enum(['A', 'B', 'C', 'D']).optional(),
});

export const importArticlesSchema = z.object({
  datasetId: z.coerce.number().int().positive(),
  batch: z.enum(['baseline', 'incremental']).default('baseline'),
  /** 同标题 + 同发布日期 视为转载重复（对应 dump_corpus.py 的文章级去重） */
  dedupeTitleDay: z.boolean().default(true),
  /**
   * 近似重复检测：字符 n-gram Jaccard，抓"改几个字/改一段"的转载。
   * 判定条件：正文相似度 ≥ bodyThreshold 且 标题相似度 ≥ titleThreshold（标题辅助防误杀）。
   */
  fuzzyDedupe: z
    .object({
      enabled: z.boolean().default(true),
      /** 正文字符 3-gram Jaccard 阈值，超过（且标题也像）视为近似重复 */
      bodyThreshold: z.number().min(0).max(1).default(0.8),
      /** 标题字符 2-gram Jaccard 阈值 */
      titleThreshold: z.number().min(0).max(1).default(0.9),
      /** 库内回看天数：只与最近 N 天入库的存量比对 */
      lookbackDays: z.number().int().min(0).max(90).default(7),
    })
    .optional()
    .default({ enabled: true }),
  /** 入库后立刻用 AC 自动机重建实体召回倒排表 */
  buildHits: z.boolean().default(true),
  items: z.array(importItemSchema).min(1).max(20_000),
});

export const listArticleQuerySchema = z.object({
  datasetId: z.coerce.number().int().positive().optional(),
  batch: z.enum(['baseline', 'incremental']).optional(),
  status: z.enum(['raw', 'cleaned', 'archived']).optional(),
  entityId: z.coerce.number().int().positive().optional(),
  keyword: z.string().trim().max(128).optional(),
  withBody: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

export const updateArticleSchema = z.object({
  batch: z.enum(['baseline', 'incremental']).optional(),
  status: z.enum(['raw', 'cleaned', 'archived']).optional(),
  quality: z.enum(['A', 'B', 'C', 'D']).optional(),
  publishedAt: z.string().trim().max(32).nullable().optional(),
  title: z.string().trim().min(1).max(512).optional(),
});

export const batchTagSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).min(1).max(5000),
  batch: z.enum(['baseline', 'incremental']).optional(),
  status: z.enum(['raw', 'cleaned', 'archived']).optional(),
});

export type ImportArticlesDto = z.infer<typeof importArticlesSchema>;
export type ListArticleQuery = z.infer<typeof listArticleQuerySchema>;
export type UpdateArticleDto = z.infer<typeof updateArticleSchema>;
