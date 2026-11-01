import { z } from 'zod';

export const roleSchema = z.enum(['admin', 'editor', 'reviewer', 'viewer']);

export const createUserSchema = z.object({
  username: z.string().min(2).max(64),
  password: z.string().min(6).max(128),
  displayName: z.string().max(64).nullish(),
  role: roleSchema.default('viewer'),
  status: z.enum(['active', 'disabled']).default('active'),
});

export const updateUserSchema = z.object({
  displayName: z.string().max(64).nullish(),
  role: roleSchema.optional(),
  status: z.enum(['active', 'disabled']).optional(),
  password: z.string().min(6).max(128).optional(),
});

export const listUserQuerySchema = z.object({
  keyword: z.string().trim().max(64).optional(),
  role: roleSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

export type CreateUserDto = z.infer<typeof createUserSchema>;
export type UpdateUserDto = z.infer<typeof updateUserSchema>;
export type ListUserQuery = z.infer<typeof listUserQuerySchema>;
