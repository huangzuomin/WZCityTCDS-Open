import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { CurrentUser, Roles, type CurrentUserPayload } from '../../auth/decorators';
import { PipelineService } from './pipeline.service';
import { batchReviewSchema, listDraftQuerySchema, llmReviewSchema, reviewDraftSchema } from './pipeline.dto';

/**
 * 草稿审核入口。
 * 抽取本身由「生产线」菜单的 discovery 管线负责（oucai.news 入队 → 发现 → 审核 → 对齐 → 事实草稿）。
 */
@Controller('pipeline')
export class PipelineController {
  constructor(private readonly service: PipelineService) {}

  @Get('drafts')
  drafts(@Query(new ZodValidationPipe(listDraftQuerySchema)) query: unknown) {
    return this.service.listDrafts(query as never);
  }

  @Post('drafts/:id/approve')
  @Roles('admin', 'editor', 'reviewer')
  approve(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(reviewDraftSchema)) dto: unknown,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.service.approveDraft(id, dto as never, user?.id);
  }

  @Post('drafts/:id/reject')
  @Roles('admin', 'editor', 'reviewer')
  reject(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(reviewDraftSchema)) dto: unknown,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.service.rejectDraft(id, (dto as { reason?: string }).reason ?? null, user?.id);
  }

  @Post('drafts/batch-review')
  @Roles('admin', 'editor', 'reviewer')
  batchReview(
    @Body(new ZodValidationPipe(batchReviewSchema))
    dto: { ids: number[]; action: 'approve' | 'reject'; reason?: string },
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.service.batchReview(dto.ids, dto.action, dto.reason ?? null, user?.id);
  }

  @Post('drafts/auto-review')
  @Roles('admin', 'editor', 'reviewer')
  autoReviewHighConfidence(@Body() dto: { threshold?: number }, @CurrentUser() user: CurrentUserPayload) {
    return this.service.autoReviewHighConfidence(dto?.threshold ?? 0.85, user?.id);
  }

  /** 大模型审批关系草稿：发起后台任务（running 中互斥），进度轮询 GET drafts/llm-review/status */
  @Post('drafts/llm-review')
  @Roles('admin', 'editor', 'reviewer')
  llmReview(
    @Body(new ZodValidationPipe(llmReviewSchema)) dto: { ids?: number[] },
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.service.startLlmReview(dto?.ids, user?.id);
  }

  /** 大模型审批任务状态/进度（后台任务轮询） */
  @Get('drafts/llm-review/status')
  @Roles('admin', 'editor', 'reviewer')
  llmReviewStatus() {
    return this.service.llmReviewStatus();
  }
}
