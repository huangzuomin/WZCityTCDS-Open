import http from './http';

export type ReviewTaskStatus =
  | 'PENDING_REVIEW'
  | 'IN_REVIEW'
  | 'ARBITRATION_REQUIRED'
  | 'APPROVED'
  | 'REJECTED'
  | 'CHANGES_REQUESTED';

export type ReviewPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';

export interface ReviewAuditEntry {
  action: string;
  actor_id: string;
  actor_role?: string;
  timestamp: string;
  previous_status: ReviewTaskStatus;
  new_status: ReviewTaskStatus;
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface ReviewConflictContext {
  conflict_id: string;
  conflicting_revision_id?: string;
  conflicting_value: unknown;
  existing_authority_level?: string;
  candidate_authority_level?: string;
  suggested_action?: string;
  arbitration_verdict?: string;
  adjudicated_by?: string;
  adjudicated_at?: string;
  adjudication_notes?: string;
}

export interface ReviewResult {
  verdict: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';
  reviewer_id: string;
  reviewed_at: string;
  notes?: string;
  approved_revision_id?: string;
}

export interface ReviewTaskItem {
  task_id: string;
  entity_id: string;
  property_path: string;
  candidate_assertion: {
    assertion_id: string;
    property_path: string;
    assertion_value: {
      raw_value: unknown;
      data_type: string;
      unit?: string;
    };
    confidence_score?: number;
    evidence_span_ids: string[];
    created_at: string;
  };
  evidence_spans: Array<{
    span_id: string;
    source_doc_id: string;
    paragraph_index: number;
    char_start: number;
    char_end: number;
    quoted_text: string;
    span_hash: string;
    extracted_at: string;
    quality_state: string;
  }>;
  status: ReviewTaskStatus;
  priority: ReviewPriority;
  created_at: string;
  updated_at: string;
  submitted_by: string;
  assigned_to: string | null;
  assigned_at: string | null;
  evidence_receipt: any | null;
  conflict_context: ReviewConflictContext | null;
  review_result: ReviewResult | null;
  audit_trail: ReviewAuditEntry[];
}

export interface IngestCandidatePayload {
  entity_id: string;
  property_path: string;
  candidate_assertion: ReviewTaskItem['candidate_assertion'];
  evidence_spans: ReviewTaskItem['evidence_spans'];
  submitted_by?: string;
  priority?: ReviewPriority;
  existing_published_assertion?: {
    revision_id: string;
    raw_value: unknown;
    authority_level?: string;
  };
}

export interface ListReviewTasksParams {
  status?: ReviewTaskStatus;
  entityId?: string;
  assignedTo?: string;
  priority?: ReviewPriority;
  page?: number;
  pageSize?: number;
}

function qs(params?: Record<string, unknown>): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (!entries.length) return '';
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

export const reviewApi = {
  list: (params?: ListReviewTasksParams) =>
    http.get<never, { tasks: ReviewTaskItem[]; total: number; page: number; pageSize: number }>(
      `/review/tasks${qs(params as Record<string, unknown>)}`,
    ),

  detail: (id: string) => http.get<never, ReviewTaskItem>(`/review/tasks/${id}`),

  ingest: (data: IngestCandidatePayload) =>
    http.post<never, ReviewTaskItem>('/review/ingest', data),

  claim: (id: string) => http.post<never, ReviewTaskItem>(`/review/tasks/${id}/claim`),

  release: (id: string) => http.post<never, ReviewTaskItem>(`/review/tasks/${id}/release`),

  verifyEvidence: (id: string, sourceDocs: any[]) =>
    http.post<never, any>(`/review/tasks/${id}/verify-evidence`, { sourceDocs }),

  arbitrate: (
    id: string,
    data: {
      decision: 'ADOPT_CANDIDATE' | 'RETAIN_EXISTING' | 'RECONCILED_RANGE' | 'SUSPENDED';
      notes?: string;
    },
  ) => http.post<never, ReviewTaskItem>(`/review/tasks/${id}/arbitrate`, data),

  approve: (id: string, notes?: string) =>
    http.post<never, { task: ReviewTaskItem; published_revision_id: string }>(
      `/review/tasks/${id}/approve`,
      { notes },
    ),

  reject: (id: string, data: { reason: string; notes?: string }) =>
    http.post<never, ReviewTaskItem>(`/review/tasks/${id}/reject`, data),

  requestChanges: (id: string, changeRequest: string) =>
    http.post<never, ReviewTaskItem>(`/review/tasks/${id}/request-changes`, { changeRequest }),
};
