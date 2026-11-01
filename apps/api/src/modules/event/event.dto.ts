import { z } from 'zod';

export const createEventSchema = z.object({
  entityId: z.coerce.number().int().positive(),
  eventType: z.string().trim().min(1).max(64),
  /** 时间三件套之一：原文时间表述（清道光年间 / 1970年代末 / 2001-10 / 2016） */
  timeText: z.string().trim().min(1).max(64),
  timePrecision: z.enum(['dynasty', 'decade', 'year', 'month', 'day']).optional(),
  timeStart: z.string().trim().max(32).optional().nullable(),
  timeEnd: z.string().trim().max(32).optional().nullable(),
  isInferred: z.coerce.boolean().optional(),
  location: z.string().trim().max(255).optional().nullable(),
  subject: z.string().trim().min(1).max(255),
  description: z.string().min(1),
  quote: z.string().trim().min(2).optional().nullable(),
  articleId: z.coerce.number().int().positive().optional().nullable(),
  evidenceIds: z.array(z.coerce.number().int().positive()).max(50).default([]),
  origin: z.enum(['llm', 'human', 'import']).default('human'),
  status: z.enum(['draft', 'active', 'rejected']).default('active'),
  /** 主体与引句错配时仍然强制入库（人工确认的例外） */
  allowMismatch: z.coerce.boolean().default(false),
});

export const updateEventSchema = createEventSchema
  .partial()
  .omit({ entityId: true, allowMismatch: true });

export const listEventQuerySchema = z.object({
  entityId: z.coerce.number().int().positive().optional(),
  datasetId: z.coerce.number().int().positive().optional(),
  eventType: z.string().trim().max(64).optional(),
  status: z.enum(['draft', 'active', 'rejected']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export type CreateEventDto = z.infer<typeof createEventSchema>;
export type UpdateEventDto = z.infer<typeof updateEventSchema>;
export type ListEventQuery = z.infer<typeof listEventQuerySchema>;
