import { Injectable } from '@nestjs/common';
import {
  ReviewWorkbenchManager,
  type ReviewTask,
  type IngestCandidateParams,
  type ListReviewTasksFilter,
  type ReviewTaskStatus,
  type ReviewPriority,
  type EvidenceVerificationReceipt,
  type SourceNewsDocumentSnapshot,
} from '@ssot/shared';

@Injectable()
export class ReviewService {
  private readonly manager: ReviewWorkbenchManager;

  constructor() {
    this.manager = new ReviewWorkbenchManager();
  }

  public async ingestCandidate(params: IngestCandidateParams): Promise<ReviewTask> {
    return this.manager.ingestCandidate(params);
  }

  public async listTasks(filter: ListReviewTasksFilter = {}): Promise<{
    tasks: ReviewTask[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    return this.manager.listTasks(filter);
  }

  public async getTask(taskId: string): Promise<ReviewTask> {
    return this.manager.getTask(taskId);
  }

  public async claimTask(taskId: string, actorId: string, actorRole?: string): Promise<ReviewTask> {
    return this.manager.claimTask(taskId, actorId, actorRole);
  }

  public async releaseTask(taskId: string, actorId: string, actorRole?: string): Promise<ReviewTask> {
    return this.manager.releaseTask(taskId, actorId, actorRole);
  }

  public async verifyEvidence(
    taskId: string,
    sourceDocs: SourceNewsDocumentSnapshot[],
    actorId: string,
  ): Promise<EvidenceVerificationReceipt> {
    return this.manager.verifyEvidence(taskId, sourceDocs, actorId);
  }

  public async arbitrateConflict(
    taskId: string,
    actorId: string,
    decision: 'ADOPT_CANDIDATE' | 'RETAIN_EXISTING' | 'RECONCILED_RANGE' | 'SUSPENDED',
    notes?: string,
    actorRole?: string,
  ): Promise<ReviewTask> {
    return this.manager.arbitrateConflict(taskId, actorId, decision, notes, actorRole);
  }

  public async approveTask(
    taskId: string,
    actorId: string,
    notes?: string,
    actorRole?: string,
  ): Promise<{ task: ReviewTask; published_revision_id: string }> {
    return this.manager.approveTask(taskId, actorId, notes, actorRole);
  }

  public async rejectTask(
    taskId: string,
    actorId: string,
    reason: string,
    notes?: string,
    actorRole?: string,
  ): Promise<ReviewTask> {
    return this.manager.rejectTask(taskId, actorId, reason, notes, actorRole);
  }

  public async requestChanges(
    taskId: string,
    actorId: string,
    changeRequest: string,
    actorRole?: string,
  ): Promise<ReviewTask> {
    return this.manager.requestChanges(taskId, actorId, changeRequest, actorRole);
  }
}
