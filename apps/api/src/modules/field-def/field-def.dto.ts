import { z } from 'zod';
import { fieldDefCreateSchema } from '@ssot/shared';

export const createFieldDefSchema = z.object({
  categoryId: z.coerce.number().int().positive(),
}).merge(fieldDefCreateSchema);

export const updateFieldDefSchema = fieldDefCreateSchema.partial();

export const listFieldDefQuerySchema = z.object({
  categoryId: z.coerce.number().int().positive().optional(),
  /** 是否沿继承链合并出最终生效字段 */
  resolved: z.coerce.boolean().default(false),
});

export type CreateFieldDefDto = z.infer<typeof createFieldDefSchema>;
export type UpdateFieldDefDto = z.infer<typeof updateFieldDefSchema>;
export type ListFieldDefQuery = z.infer<typeof listFieldDefQuerySchema>;
