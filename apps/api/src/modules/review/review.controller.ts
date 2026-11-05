import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser, Roles, type CurrentUserPayload } from '../../auth/decorators';
import { ReviewService } from './review.service';
import type {
  IngestCandidateParams,
  ReviewTaskStatus,
  ReviewPriority,
  SourceNewsDocumentSnapshot,
} from '@ssot/shared';

@Controller('review')
export class ReviewController {
  constructor(private readonly service: ReviewService) {}

  @Post('ingest')
  @Roles('admin', 'editor')
  async ingest(
    @Body() body: IngestCandidateParams,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    const actorId = user ? user.username || String(user.id) : body.submitted_by || 'system_ingest';
    return this.service.ingestCandidate({
      ...body,
      submitted_by: actorId,
    });
  }

  @Get('tasks')
  @Roles('admin', 'editor', 'reviewer')
  async listTasks(
    @Query('status') status?: ReviewTaskStatus,
    @Query('entityId') entityId?: string,
    @Query('assignedTo') assignedTo?: string,
    @Query('priority') priority?: ReviewPriority,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.listTasks({
      status,
      entity_id: entityId,
      assigned_to: assignedTo,
      priority,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
    });
  }

  @Get('tasks/:id')
  @Roles('admin', 'editor', 'reviewer')
  async getTask(@Param('id') id: string) {
    return this.service.getTask(id);
  }

  @Post('tasks/:id/claim')
  @Roles('admin', 'reviewer')
  async claim(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    const actorId = user ? user.username || String(user.id) : 'reviewer_anonymous';
    const role = user ? user.role : 'reviewer';
    return this.service.claimTask(id, actorId, role);
  }

  @Post('tasks/:id/release')
  @Roles('admin', 'reviewer')
  async release(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    const actorId = user ? user.username || String(user.id) : 'reviewer_anonymous';
    const role = user ? user.role : 'reviewer';
    return this.service.releaseTask(id, actorId, role);
  }

  @Post('tasks/:id/verify-evidence')
  @Roles('admin', 'reviewer')
  async verifyEvidence(
    @Param('id') id: string,
    @Body('sourceDocs') sourceDocs: SourceNewsDocumentSnapshot[],
    @CurrentUser() user: CurrentUserPayload,
  ) {
    const actorId = user ? user.username || String(user.id) : 'verifier_anonymous';
    return this.service.verifyEvidence(id, sourceDocs || [], actorId);
  }

  @Post('tasks/:id/arbitrate')
  @Roles('admin', 'reviewer')
  async arbitrate(
    @Param('id') id: string,
    @Body('decision') decision: 'ADOPT_CANDIDATE' | 'RETAIN_EXISTING' | 'RECONCILED_RANGE' | 'SUSPENDED',
    @Body('notes') notes: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    const actorId = user ? user.username || String(user.id) : 'arbitrator_anonymous';
    const role = user ? user.role : 'reviewer';
    return this.service.arbitrateConflict(id, actorId, decision, notes, role);
  }

  @Post('tasks/:id/approve')
  @Roles('admin', 'reviewer')
  async approve(
    @Param('id') id: string,
    @Body('notes') notes: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    const actorId = user ? user.username || String(user.id) : 'reviewer_anonymous';
    const role = user ? user.role : 'reviewer';
    return this.service.approveTask(id, actorId, notes, role);
  }

  @Post('tasks/:id/reject')
  @Roles('admin', 'reviewer')
  async reject(
    @Param('id') id: string,
    @Body('reason') reason: string,
    @Body('notes') notes: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    const actorId = user ? user.username || String(user.id) : 'reviewer_anonymous';
    const role = user ? user.role : 'reviewer';
    return this.service.rejectTask(id, actorId, reason, notes, role);
  }

  @Post('tasks/:id/request-changes')
  @Roles('admin', 'reviewer')
  async requestChanges(
    @Param('id') id: string,
    @Body('changeRequest') changeRequest: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    const actorId = user ? user.username || String(user.id) : 'reviewer_anonymous';
    const role = user ? user.role : 'reviewer';
    return this.service.requestChanges(id, actorId, changeRequest, role);
  }
}
