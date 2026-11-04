export * from './entity-lookup.js';
export * from './source-news.js';
export * from './fact-revision.js';
export * from './evidence.js';
export * from './outlets.js';

import { z } from 'zod';

export function validateContract<Output, Def extends z.ZodTypeDef = z.ZodTypeDef, Input = Output>(
  schema: z.ZodType<Output, Def, Input>,
  data: unknown
): {
  success: boolean;
  data?: Output;
  errors?: z.ZodIssue[];
} {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: result.error.issues };
}

export function assertContract<Output, Def extends z.ZodTypeDef = z.ZodTypeDef, Input = Output>(
  schema: z.ZodType<Output, Def, Input>,
  data: unknown,
  contextName = 'Contract'
): Output {
  const result = schema.safeParse(data);
  if (!result.success) {
    const errorDetails = result.error.issues
      .map((i) => `[${i.path.join('.') || 'root'}]: ${i.message}`)
      .join('; ');
    throw new Error(`Validation failed for ${contextName}: ${errorDetails}`);
  }
  return result.data;
}
