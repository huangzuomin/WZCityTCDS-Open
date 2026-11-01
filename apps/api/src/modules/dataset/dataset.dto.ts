import { z } from 'zod';

export const createDatasetSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, 'code 只能小写字母开头，含小写字母/数字/下划线'),
  name: z.string().min(1).max(128),
  description: z.string().max(2000).nullish(),
  sort: z.number().int().default(0),
  status: z.enum(['active', 'archived']).default('active'),
});

export const updateDatasetSchema = createDatasetSchema.partial();

export const listDatasetQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  keyword: z.string().trim().max(128).optional(),
  status: z.enum(['active', 'archived']).optional(),
});

/** 批量同步关联分类（配置首页 / 关联分类 一次保存）：整表 diff，缺省字段不覆盖已有值 */
export const syncDatasetCategoriesSchema = z.object({
  links: z
    .array(
      z.object({
        categoryId: z.number().int().positive(),
        dimIds: z.array(z.number().int()).optional(),
        homeShow: z.number().int().min(0).max(200).optional(),
      }),
    )
    .max(500),
});

export type CreateDatasetDto = z.infer<typeof createDatasetSchema>;
export type UpdateDatasetDto = z.infer<typeof updateDatasetSchema>;
export type ListDatasetQuery = z.infer<typeof listDatasetQuerySchema>;
export type SyncDatasetCategoriesDto = z.infer<typeof syncDatasetCategoriesSchema>;
