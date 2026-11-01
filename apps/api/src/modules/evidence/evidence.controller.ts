import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { CurrentUser, Roles, type CurrentUserPayload } from '../../auth/decorators';
import { EvidenceService } from './evidence.service';
import {
  anchorPreviewSchema,
  createEvidenceSchema,
  listEvidenceQuerySchema,
  updateEvidenceSchema,
  verifySchema,
} from './evidence.dto';

@Controller('evidence')
export class EvidenceController {
  constructor(private readonly service: EvidenceService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listEvidenceQuerySchema)) query: unknown) {
    return this.service.list(query as never);
  }

  @Get('entity/:entityId/chain')
  chain(@Param('entityId', ParseIntPipe) entityId: number) {
    return this.service.chain(entityId);
  }

  @Get('entity/:entityId/stats')
  stats(@Param('entityId', ParseIntPipe) entityId: number) {
    return this.service.stats(entityId);
  }

  /** 锚点复核台：引句高亮预览 */
  @Post('anchor-preview')
  anchorPreview(@Body(new ZodValidationPipe(anchorPreviewSchema)) dto: unknown) {
    return this.service.anchorPreview(dto as never);
  }

  /** R1 引句逐字回查 */
  @Post('entity/:entityId/recheck')
  @Roles('admin', 'editor', 'reviewer')
  recheck(@Param('entityId', ParseIntPipe) entityId: number) {
    return this.service.recheck(entityId);
  }

  @Post('detect-stale')
  @Roles('admin', 'editor', 'reviewer')
  detectStale(@Body() body: { entityId?: number }) {
    return this.service.detectStale(body?.entityId ? Number(body.entityId) : undefined);
  }

  @Post()
  @Roles('admin', 'editor')
  create(
    @Body(new ZodValidationPipe(createEvidenceSchema)) dto: unknown,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.service.create(dto as never, user?.id);
  }

  @Get(':id')
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.service.detail(id);
  }

  @Patch(':id')
  @Roles('admin', 'editor')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateEvidenceSchema)) dto: unknown,
  ) {
    return this.service.update(id, dto as never);
  }

  /** 人工回查：通过 / 失败 */
  @Post(':id/verify')
  @Roles('admin', 'editor', 'reviewer')
  verify(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(verifySchema))
    dto: { verifyStatus: 'pending' | 'passed' | 'failed'; verifyDetail?: string | null },
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.service.verify(id, dto.verifyStatus, dto.verifyDetail, user?.id);
  }
}
