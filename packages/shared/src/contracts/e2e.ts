import { z } from 'zod';
import { PublicationSecurityGatePolicySchema } from './outlets.js';
import { HubProjectionReceiptSchema } from './hub-projection.js';

export const SubsystemStatusSchema = z.enum([
  'HEALTHY',
  'DEGRADED',
  'UNHEALTHY',
  'MAINTENANCE',
]);
export type SubsystemStatus = z.infer<typeof SubsystemStatusSchema>;

export const ComponentHealthSchema = z.object({
  component: z.string(),
  status: SubsystemStatusSchema,
  message: z.string(),
  latency_ms: z.number().nonnegative(),
  checked_at: z.string(),
  details: z.record(z.unknown()).optional(),
});
export type ComponentHealth = z.infer<typeof ComponentHealthSchema>;

export const SystemHealthReportSchema = z.object({
  status: SubsystemStatusSchema,
  version: z.string(),
  uptime_seconds: z.number().nonnegative(),
  timestamp: z.string(),
  components: z.array(ComponentHealthSchema),
  summary: z.object({
    total_components: z.number().nonnegative(),
    healthy_count: z.number().nonnegative(),
    degraded_count: z.number().nonnegative(),
    unhealthy_count: z.number().nonnegative(),
  }),
});
export type SystemHealthReport = z.infer<typeof SystemHealthReportSchema>;

export const E2EExecutionStepSchema = z.object({
  step_number: z.number().int().positive(),
  name: z.string(),
  status: z.enum(['PASS', 'FAIL', 'SKIPPED', 'BLOCKED']),
  duration_ms: z.number().nonnegative(),
  details: z.record(z.unknown()).optional(),
});
export type E2EExecutionStep = z.infer<typeof E2EExecutionStepSchema>;

export const E2EPipelineResultSchema = z.object({
  pipeline_run_id: z.string(),
  success: z.boolean(),
  entity_id: z.string(),
  steps: z.array(E2EExecutionStepSchema),
  review_task_id: z.string().optional(),
  published_revision_id: z.string().optional(),
  security_gate_policy: PublicationSecurityGatePolicySchema.optional(),
  hub_receipt: HubProjectionReceiptSchema.optional(),
  outlets_verified: z.array(z.string()),
  error: z.string().optional(),
});
export type E2EPipelineResult = z.infer<typeof E2EPipelineResultSchema>;
