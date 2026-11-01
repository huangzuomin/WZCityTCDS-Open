import { z } from 'zod';

export const createEntitySchema = z.object({
  /** v2 溯源用：实体首次来自哪个语料域（可选；实体本身全局唯一） */
  originDatasetId: z.coerce.number().int().positive().nullish(),
  categoryId: z.coerce.number().int().positive(),
  name: z.string().trim().min(1).max(255),
  slug: z
    .string()
    .trim()
    .max(180)
    .regex(/^[a-z0-9-]+$/, 'slug 只能包含小写字母、数字与连字符')
    .optional(),
  lede: z.string().max(4000).nullish(),
  seedSource: z.string().max(255).nullish(),
  attrs: z.record(z.unknown()).default({}),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  aliases: z.array(z.string().trim().min(1).max(255)).default([]),
});

export const updateEntitySchema = createEntitySchema
  .omit({ originDatasetId: true, categoryId: true })
  .partial();

export const listEntityQuerySchema = z.object({
  datasetId: z.coerce.number().int().positive().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
  keyword: z.string().trim().max(128).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  /** keyset 分页游标（上一页最后一条 id），提供时优先于 page */
  cursor: z.coerce.number().int().positive().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  /** 排序字段：id（默认）或 factCount（按生效事实数） */
  sort: z.enum(['id', 'factCount']).default('id'),
});

export const aliasSchema = z.object({
  alias: z.string().trim().min(1).max(255),
  source: z.string().max(64).nullish(),
});

export type CreateEntityDto = z.infer<typeof createEntitySchema>;
export type UpdateEntityDto = z.infer<typeof updateEntitySchema>;
export type ListEntityQuery = z.infer<typeof listEntityQuerySchema>;
