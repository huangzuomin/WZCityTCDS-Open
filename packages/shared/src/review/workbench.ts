import { randomBytes } from 'node:crypto';
import {
  type AssertionValue,
  AssertionValueSchema,
} from '../contracts/fact-revision.js';
import {
  type EvidenceSpan,
  type EvidenceVerificationReceipt,
  type SourceAuthorityLevel,
  EvidenceSpanSchema,
} from '../contracts/evidence.js';
import {
  EvidenceVerificationEngine,
  type SourceNewsDocumentSnapshot,
} from '../evidence/evidence-engine.js';

export type ReviewTaskStatus =
  | 'PENDING_REVIEW'
  | 'IN_REVIEW'
  | 'ARBITRATION_REQUIRED'
  | 'APPROVED'
  | 'REJECTED'
  | 'CHANGES_REQUESTED';

export type ReviewPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';

export type ReviewActionType =
  | 'INGEST'
  | 'CLAIM'
  | 'RELEASE'
  | 'VERIFY_EVIDENCE'
  | 'ARBITRATE'
  | 'APPROVE'
  | 'REJECT'
  | 'REQUEST_CHANGES';

export interface CandidateAssertion {
  assertion_id: string;
  property_path: string;
  assertion_value: AssertionValue;
  confidence_score?: number;
  evidence_span_ids: string[];
  created_at: string;
}

export interface ReviewAuditEntry {
  action: ReviewActionType;
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
  existing_authority_level?: SourceAuthorityLevel;
  candidate_authority_level?: SourceAuthorityLevel;
  suggested_action?: 'ADOPT_CANDIDATE' | 'RETAIN_EXISTING' | 'MANUAL_ARBITRATION';
  arbitration_verdict?: 'ADOPT_CANDIDATE' | 'RETAIN_EXISTING' | 'RECONCILED_RANGE' | 'SUSPENDED';
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

export interface ReviewTask {
  task_id: string;
  entity_id: string;
  property_path: string;
  candidate_assertion: CandidateAssertion;
  evidence_spans: EvidenceSpan[];
  status: ReviewTaskStatus;
  priority: ReviewPriority;
  created_at: string;
  updated_at: string;
  submitted_by: string;
  assigned_to: string | null;
  assigned_at: string | null;
  evidence_receipt: EvidenceVerificationReceipt | null;
  conflict_context: ReviewConflictContext | null;
  review_result: ReviewResult | null;
  audit_trail: ReviewAuditEntry[];
}

export interface IngestCandidateParams {
  entity_id: string;
  property_path: string;
  candidate_assertion: CandidateAssertion;
  evidence_spans: EvidenceSpan[];
  submitted_by: string;
  priority?: ReviewPriority;
  existing_published_assertion?: {
    revision_id: string;
    raw_value: unknown;
    authority_level?: SourceAuthorityLevel;
  };
}

export interface ListReviewTasksFilter {
  status?: ReviewTaskStatus;
  entity_id?: string;
  assigned_to?: string;
  priority?: ReviewPriority;
  page?: number;
  pageSize?: number;
}

export interface ReviewStore {
  save(task: ReviewTask): Promise<void> | void;
  findById(taskId: string): Promise<ReviewTask | null> | ReviewTask | null;
  findAll(): Promise<ReviewTask[]> | ReviewTask[];
}

export class InMemoryReviewStore implements ReviewStore {
  private tasks = new Map<string, ReviewTask>();

  save(task: ReviewTask): void {
    this.tasks.set(task.task_id, { ...task });
  }

  findById(taskId: string): ReviewTask | null {
    const t = this.tasks.get(taskId);
    return t ? { ...t } : null;
  }

  findAll(): ReviewTask[] {
    return Array.from(this.tasks.values()).map((t) => ({ ...t }));
  }

  clear(): void {
    this.tasks.clear();
  }
}

export class ReviewWorkbenchManager {
  private store: ReviewStore;
  private evidenceEngine: EvidenceVerificationEngine;

  constructor(store?: ReviewStore, evidenceEngine?: EvidenceVerificationEngine) {
    this.store = store ?? new InMemoryReviewStore();
    this.evidenceEngine = evidenceEngine ?? new EvidenceVerificationEngine();
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  private generateId(prefix: string): string {
    return `${prefix}_${randomBytes(8).toString('hex')}`;
  }

  private ensureReviewerRole(role?: string): void {
    if (role && role !== 'reviewer' && role !== 'admin') {
      throw new Error(`Forbidden: role '${role}' is not authorized to perform review actions. Requires 'reviewer' or 'admin'.`);
    }
  }

  async ingestCandidate(params: IngestCandidateParams): Promise<ReviewTask> {
    if (!params.candidate_assertion || !params.candidate_assertion.assertion_id) {
      throw new Error('Candidate ingestion rejected: missing valid candidate_assertion.');
    }
    AssertionValueSchema.parse(params.candidate_assertion.assertion_value);

    if (!params.evidence_spans || params.evidence_spans.length === 0) {
      throw new Error('Candidate ingestion rejected: at least one supporting EvidenceSpan is strictly required.');
    }
    for (const span of params.evidence_spans) {
      EvidenceSpanSchema.parse(span);
    }

    const now = this.nowIso();
    const taskId = this.generateId('revtask');

    let initialStatus: ReviewTaskStatus = 'PENDING_REVIEW';
    let conflictContext: ReviewConflictContext | null = null;

    // Automated Conflict Detection against existing published assertion
    if (params.existing_published_assertion) {
      const existing = params.existing_published_assertion;
      const isDivergent =
        JSON.stringify(existing.raw_value) !==
        JSON.stringify(params.candidate_assertion.assertion_value.raw_value);

      if (isDivergent) {
        initialStatus = 'ARBITRATION_REQUIRED';
        conflictContext = {
          conflict_id: this.generateId('conf'),
          conflicting_revision_id: existing.revision_id,
          conflicting_value: existing.raw_value,
          existing_authority_level: existing.authority_level,
          candidate_authority_level: 'COMMERCIAL_PORTAL',
          suggested_action: 'MANUAL_ARBITRATION',
        };
      }
    }

    const task: ReviewTask = {
      task_id: taskId,
      entity_id: params.entity_id,
      property_path: params.property_path,
      candidate_assertion: params.candidate_assertion,
      evidence_spans: params.evidence_spans,
      status: initialStatus,
      priority: params.priority ?? 'NORMAL',
      created_at: now,
      updated_at: now,
      submitted_by: params.submitted_by,
      assigned_to: null,
      assigned_at: null,
      evidence_receipt: null,
      conflict_context: conflictContext,
      review_result: null,
      audit_trail: [
        {
          action: 'INGEST',
          actor_id: params.submitted_by,
          timestamp: now,
          previous_status: initialStatus,
          new_status: initialStatus,
          notes: conflictContext
            ? `Ingested candidate with detected property divergence against revision ${conflictContext.conflicting_revision_id}`
            : 'Ingested clean candidate assertion',
        },
      ],
    };

    await this.store.save(task);
    return task;
  }

  async listTasks(filter: ListReviewTasksFilter = {}): Promise<{
    tasks: ReviewTask[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const all = await this.store.findAll();
    let filtered = all;

    if (filter.status) {
      filtered = filtered.filter((t) => t.status === filter.status);
    }
    if (filter.entity_id) {
      filtered = filtered.filter((t) => t.entity_id === filter.entity_id);
    }
    if (filter.assigned_to) {
      filtered = filtered.filter((t) => t.assigned_to === filter.assigned_to);
    }
    if (filter.priority) {
      filtered = filtered.filter((t) => t.priority === filter.priority);
    }

    const total = filtered.length;
    const page = filter.page && filter.page > 0 ? filter.page : 1;
    const pageSize = filter.pageSize && filter.pageSize > 0 ? filter.pageSize : 20;
    const start = (page - 1) * pageSize;
    const tasks = filtered.slice(start, start + pageSize);

    return { tasks, total, page, pageSize };
  }

  async getTask(taskId: string): Promise<ReviewTask> {
    const task = await this.store.findById(taskId);
    if (!task) {
      throw new Error(`ReviewTask not found with ID: ${taskId}`);
    }
    return task;
  }

  async claimTask(taskId: string, actorId: string, actorRole?: string): Promise<ReviewTask> {
    this.ensureReviewerRole(actorRole);
    const task = await this.getTask(taskId);

    if (task.status === 'APPROVED' || task.status === 'REJECTED') {
      throw new Error(`Cannot claim completed review task in state: ${task.status}`);
    }

    const now = this.nowIso();
    const prevStatus = task.status;
    const nextStatus = task.status === 'ARBITRATION_REQUIRED' ? 'ARBITRATION_REQUIRED' : 'IN_REVIEW';

    task.assigned_to = actorId;
    task.assigned_at = now;
    task.status = nextStatus;
    task.updated_at = now;

    task.audit_trail.push({
      action: 'CLAIM',
      actor_id: actorId,
      actor_role: actorRole,
      timestamp: now,
      previous_status: prevStatus,
      new_status: nextStatus,
      notes: `Claimed by reviewer ${actorId}`,
    });

    await this.store.save(task);
    return task;
  }

  async releaseTask(taskId: string, actorId: string, actorRole?: string): Promise<ReviewTask> {
    const task = await this.getTask(taskId);
    if (task.assigned_to && task.assigned_to !== actorId && actorRole !== 'admin') {
      throw new Error(`Cannot release task assigned to another reviewer (${task.assigned_to})`);
    }

    const now = this.nowIso();
    const prevStatus = task.status;
    const nextStatus = task.status === 'IN_REVIEW' ? 'PENDING_REVIEW' : task.status;

    task.assigned_to = null;
    task.assigned_at = null;
    task.status = nextStatus;
    task.updated_at = now;

    task.audit_trail.push({
      action: 'RELEASE',
      actor_id: actorId,
      actor_role: actorRole,
      timestamp: now,
      previous_status: prevStatus,
      new_status: nextStatus,
      notes: `Released assignment by ${actorId}`,
    });

    await this.store.save(task);
    return task;
  }

  async verifyEvidence(
    taskId: string,
    sourceDocs: SourceNewsDocumentSnapshot[] | Map<string, SourceNewsDocumentSnapshot>,
    actorId: string,
  ): Promise<EvidenceVerificationReceipt> {
    const task = await this.getTask(taskId);

    const docMap: Map<string, SourceNewsDocumentSnapshot> =
      sourceDocs instanceof Map
        ? sourceDocs
        : new Map(sourceDocs.map((d) => [d.source_doc_id, d]));

    const receipt = this.evidenceEngine.verifyAssertionEvidence({
      assertion_id: task.candidate_assertion.assertion_id,
      revision_id: 'rev_pending_review',
      spans: task.evidence_spans,
      source_resolver: (id: string) => docMap.get(id),
      signer_identity: actorId,
    });

    const now = this.nowIso();
    task.evidence_receipt = receipt;
    task.updated_at = now;

    task.audit_trail.push({
      action: 'VERIFY_EVIDENCE',
      actor_id: actorId,
      timestamp: now,
      previous_status: task.status,
      new_status: task.status,
      notes: `Evidence preflight executed: verdict=${receipt.overall_verification_verdict}, verified_spans=${receipt.span_verifications.length}`,
      metadata: { receipt_id: receipt.receipt_id, overall_verdict: receipt.overall_verification_verdict },
    });

    await this.store.save(task);
    return receipt;
  }

  async arbitrateConflict(
    taskId: string,
    actorId: string,
    decision: 'ADOPT_CANDIDATE' | 'RETAIN_EXISTING' | 'RECONCILED_RANGE' | 'SUSPENDED',
    notes?: string,
    actorRole?: string,
  ): Promise<ReviewTask> {
    this.ensureReviewerRole(actorRole);
    const task = await this.getTask(taskId);

    if (!task.conflict_context) {
      throw new Error(`ReviewTask ${taskId} does not have an active conflict to arbitrate.`);
    }

    const now = this.nowIso();
    const prevStatus = task.status;

    task.conflict_context.arbitration_verdict = decision;
    task.conflict_context.adjudicated_by = actorId;
    task.conflict_context.adjudicated_at = now;
    task.conflict_context.adjudication_notes = notes;

    let nextStatus: ReviewTaskStatus = task.status;

    if (decision === 'ADOPT_CANDIDATE' || decision === 'RECONCILED_RANGE') {
      nextStatus = 'IN_REVIEW';
    } else if (decision === 'RETAIN_EXISTING') {
      nextStatus = 'REJECTED';
      task.review_result = {
        verdict: 'REJECTED',
        reviewer_id: actorId,
        reviewed_at: now,
        notes: `Arbitration resolved to retain existing published revision: ${notes ?? ''}`,
      };
    } else if (decision === 'SUSPENDED') {
      nextStatus = 'CHANGES_REQUESTED';
      task.review_result = {
        verdict: 'CHANGES_REQUESTED',
        reviewer_id: actorId,
        reviewed_at: now,
        notes: `Arbitration suspended pending further source evidence: ${notes ?? ''}`,
      };
    }

    task.status = nextStatus;
    task.updated_at = now;

    task.audit_trail.push({
      action: 'ARBITRATE',
      actor_id: actorId,
      actor_role: actorRole,
      timestamp: now,
      previous_status: prevStatus,
      new_status: nextStatus,
      notes: `Arbitration decision: ${decision}. ${notes ?? ''}`,
      metadata: { decision },
    });

    await this.store.save(task);
    return task;
  }

  async approveTask(
    taskId: string,
    actorId: string,
    notes?: string,
    actorRole?: string,
  ): Promise<{ task: ReviewTask; published_revision_id: string }> {
    this.ensureReviewerRole(actorRole);
    const task = await this.getTask(taskId);

    // Fail-Closed Gates:
    if (task.status === 'ARBITRATION_REQUIRED') {
      throw new Error(`Fail-Closed Gate: Cannot approve task ${taskId} while unresolved conflict arbitration is required.`);
    }
    if (task.status === 'APPROVED') {
      throw new Error(`Task ${taskId} is already approved.`);
    }
    if (task.status === 'REJECTED') {
      throw new Error(`Task ${taskId} is already rejected.`);
    }
    if (task.evidence_receipt && task.evidence_receipt.overall_verification_verdict !== 'PASS') {
      throw new Error(
        `Fail-Closed Gate: Cannot approve task with non-passing evidence verification verdict: ${task.evidence_receipt.overall_verification_verdict}`,
      );
    }

    const now = this.nowIso();
    const prevStatus = task.status;
    const publishedRevId = `rev_${randomBytes(8).toString('hex')}`;

    task.status = 'APPROVED';
    task.updated_at = now;
    task.review_result = {
      verdict: 'APPROVED',
      reviewer_id: actorId,
      reviewed_at: now,
      notes,
      approved_revision_id: publishedRevId,
    };

    task.audit_trail.push({
      action: 'APPROVE',
      actor_id: actorId,
      actor_role: actorRole,
      timestamp: now,
      previous_status: prevStatus,
      new_status: 'APPROVED',
      notes: notes ?? 'Candidate assertion approved for publication release',
      metadata: { published_revision_id: publishedRevId },
    });

    await this.store.save(task);
    return { task, published_revision_id: publishedRevId };
  }

  async rejectTask(
    taskId: string,
    actorId: string,
    reason: string,
    notes?: string,
    actorRole?: string,
  ): Promise<ReviewTask> {
    this.ensureReviewerRole(actorRole);
    const task = await this.getTask(taskId);

    if (task.status === 'APPROVED') {
      throw new Error(`Cannot reject already approved task ${taskId}. Use revocation protocol instead.`);
    }

    const now = this.nowIso();
    const prevStatus = task.status;

    task.status = 'REJECTED';
    task.updated_at = now;
    task.review_result = {
      verdict: 'REJECTED',
      reviewer_id: actorId,
      reviewed_at: now,
      notes: `${reason}${notes ? ` - ${notes}` : ''}`,
    };

    task.audit_trail.push({
      action: 'REJECT',
      actor_id: actorId,
      actor_role: actorRole,
      timestamp: now,
      previous_status: prevStatus,
      new_status: 'REJECTED',
      notes: reason,
    });

    await this.store.save(task);
    return task;
  }

  async requestChanges(
    taskId: string,
    actorId: string,
    changeRequest: string,
    actorRole?: string,
  ): Promise<ReviewTask> {
    this.ensureReviewerRole(actorRole);
    const task = await this.getTask(taskId);

    if (task.status === 'APPROVED' || task.status === 'REJECTED') {
      throw new Error(`Cannot request changes on task in final status ${task.status}.`);
    }

    const now = this.nowIso();
    const prevStatus = task.status;

    task.status = 'CHANGES_REQUESTED';
    task.updated_at = now;
    task.review_result = {
      verdict: 'CHANGES_REQUESTED',
      reviewer_id: actorId,
      reviewed_at: now,
      notes: changeRequest,
    };

    task.audit_trail.push({
      action: 'REQUEST_CHANGES',
      actor_id: actorId,
      actor_role: actorRole,
      timestamp: now,
      previous_status: prevStatus,
      new_status: 'CHANGES_REQUESTED',
      notes: changeRequest,
    });

    await this.store.save(task);
    return task;
  }
}
