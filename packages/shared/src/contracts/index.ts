export * from './entity-lookup.js';
export * from './source-news.js';
export * from './fact-revision.js';
export * from './evidence.js';
export * from './outlets.js';

import { z } from 'zod';

export function validateContract<T>(schema: z.ZodType<T>, data: unknown): {
  success: boolean;
  data?: T;
  errors?: z.ZodIssue[];
} {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: result.error.issues };
}

export function assertContract<T>(schema: z.ZodType<T>, data: unknown, contextName = 'Contract'): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const errorDetails = result.error.issues
      .map((i) => `[${i.path.join('.') || 'root'}]: ${i.message}`)
      .join('; ');
    throw new Error(`Validation failed for ${contextName}: ${errorDetails}`);
  }
  return result.data;
}
