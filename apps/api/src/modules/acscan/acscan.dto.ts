import { z } from 'zod';

export const runScanSchema = z.object({
  datasetId: z.coerce.number().int().positive().default(1),
  /** 只扫前 N 篇（调试用），不传 = 全量 */
  limit: z.coerce.number().int().positive().max(200000).optional(),
});

export const listHitsSchema = z.object({
  jobId: z.coerce.number().int().positive().optional(),
  /** kept=最长匹配保留；rejected=嵌套被过滤；all=全部 */
  filter: z.enum(['kept', 'rejected', 'all']).default('kept'),
  category: z.string().optional(),
  entityId: z.coerce.number().int().positive().optional(),
  articleId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const listContextsSchema = z.object({
  jobId: z.coerce.number().int().positive().optional(),
  category: z.string().optional(),
  entityId: z.coerce.number().int().positive().optional(),
  articleId: z.coerce.number().int().positive().optional(),
  keyword: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type RunScanDto = z.infer<typeof runScanSchema>;
export type ListHitsDto = z.infer<typeof listHitsSchema>;
export type ListContextsDto = z.infer<typeof listContextsSchema>;
