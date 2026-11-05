import http from './http';

export type SubsystemStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'MAINTENANCE';

export interface ComponentHealthItem {
  component: string;
  status: SubsystemStatus;
  message: string;
  latency_ms: number;
  checked_at: string;
  details?: Record<string, unknown>;
}

export interface SystemHealthReportItem {
  status: SubsystemStatus;
  version: string;
  uptime_seconds: number;
  timestamp: string;
  components: ComponentHealthItem[];
  summary: {
    total_components: number;
    healthy_count: number;
    degraded_count: number;
    unhealthy_count: number;
  };
}

export interface E2EExecutionStepItem {
  step_number: number;
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIPPED' | 'BLOCKED';
  duration_ms: number;
  details?: Record<string, unknown>;
}

export interface E2EPipelineResultItem {
  pipeline_run_id: string;
  success: boolean;
  entity_id: string;
  steps: E2EExecutionStepItem[];
  review_task_id?: string;
  published_revision_id?: string;
  security_gate_policy?: unknown;
  hub_receipt?: unknown;
  outlets_verified: string[];
  error?: string;
}

export const healthApi = {
  getHealth: () => http.get<never, SystemHealthReportItem>('/health'),
  getReady: () => http.get<never, { ready: boolean; status: SubsystemStatus }>('/health/ready'),
  getLive: () => http.get<never, { live: boolean; uptime_seconds: number }>('/health/live'),
  runE2E: (params: unknown) =>
    http.post<never, E2EPipelineResultItem>('/health/e2e-run', params),
};
