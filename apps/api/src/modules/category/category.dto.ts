import { z } from 'zod';

export const createCategorySchema = z.object({
  parentId: z.coerce.number().int().positive().nullish(),
  code: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, 'code 只能小写字母开头，含小写字母/数字/下划线'),
  name: z.string().min(1).max(128),
  description: z.string().max(2000).nullish(),
  sort: z.number().int().default(0),
  status: z.enum(['active', 'disabled']).default('active'),
});

export const updateCategorySchema = createCategorySchema.partial();

export const listCategoryQuerySchema = z.object({
  keyword: z.string().trim().max(128).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  tree: z.coerce.boolean().default(false),
});

export type CreateCategoryDto = z.infer<typeof createCategorySchema>;
export type UpdateCategoryDto = z.infer<typeof updateCategorySchema>;
export type ListCategoryQuery = z.infer<typeof listCategoryQuerySchema>;

export interface CategoryTreeNode {
  id: number;
  parentId: number | null;
  code: string;
  name: string;
  sort: number;
  status: string;
  children: CategoryTreeNode[];
}
