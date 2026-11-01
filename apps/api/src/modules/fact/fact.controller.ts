import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { CurrentUser, Public, Roles, type CurrentUserPayload } from '../../auth/decorators';
import { FactService } from './fact.service';
import {
  arbitrateSchema,
  attachEvidenceSchema,
  createFactSchema,
  listFactQuerySchema,
  updateFactSchema,
} from './fact.dto';

const ZH_DIM = /^[\u4e00-\u9fa5]{2,32}$/;
const dimensionSchema = z.object({
  code: z.string().trim().regex(ZH_DIM, '维度 code 必须为 2~32 位中文字符'),
  name: z.string().trim().regex(ZH_DIM, '维度名称必须为 2~32 位中文字符'),
  description: z.string().max(2000).optional().nullable(),
  sort: z.coerce.number().int().default(0),
});

@Controller('facts')
export class FactController {
  constructor(private readonly service: FactService) {}

  @Get()
  @Public()
  list(@Query(new ZodValidationPipe(listFactQuerySchema)) query: unknown) {
    return this.service.list(query as never);
  }

  @Get('dimensions')
  dimensions() {
    return this.service.listDimensions();
  }

  @Post('dimensions')
  @Roles('admin')
  createDimension(@Body(new ZodValidationPipe(dimensionSchema)) dto: unknown) {
    return this.service.createDimension(dto as never);
  }

  @Patch('dimensions/:id')
  @Roles('admin')
  updateDimension(
    @Param('id', ParseIntPipe) id: number,
    @Body(
      new ZodValidationPipe(
        z.object({
          name: z.string().trim().min(1).max(128).optional(),
          description: z.string().max(2000).optional().nullable(),
          sort: z.coerce.number().int().optional(),
          status: z.enum(['active', 'disabled']).optional(),
        }),
      ),
    )
    dto: unknown,
  ) {
    return this.service.updateDimension(id, dto as never);
  }

  @Get('entity/:entityId/current')
  current(@Param('entityId', ParseIntPipe) entityId: number) {
    return this.service.currentByEntity(entityId);
  }

  @Get('entity/:entityId/board')
  board(@Param('entityId', ParseIntPipe) entityId: number) {
    return this.service.fullBoard(entityId);
  }

  @Get('entity/:entityId/changes')
  changes(
    @Param('entityId', ParseIntPipe) entityId: number,
    @Query('limit') limit?: string,
  ) {
    return this.service.listChanges(entityId, limit ? Number(limit) : 100);
  }

  @Get('entity/:entityId/conflicts')
  conflicts(@Param('entityId', ParseIntPipe) entityId: number) {
    return this.service.conflicts(entityId);
  }

  @Post('arbitrate')
  @Roles('admin', 'reviewer')
  arbitrate(
    @Body(new ZodValidationPipe(arbitrateSchema)) dto: unknown,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.service.arbitrate(dto as never, user?.id);
  }

  @Post()
  @Roles('admin', 'editor')
  create(
    @Body(new ZodValidationPipe(createFactSchema)) dto: unknown,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.service.create(dto as never, user?.id);
  }

  @Get(':id')
  @Public()
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.service.detail(id);
  }

  @Patch(':id')
  @Roles('admin', 'editor', 'reviewer')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateFactSchema)) dto: unknown,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.service.updateMetadata(id, dto as never, user?.id);
  }

  @Post(':id/evidence')
  @Roles('admin', 'editor')
  attach(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(attachEvidenceSchema)) body: unknown,
  ) {
    const dto = body as { evidenceId: number; role: 'support' | 'refute' };
    return this.service.attachEvidence(id, [dto.evidenceId], dto.role);
  }

  @Delete(':id/evidence/:evidenceId')
  @Roles('admin', 'editor')
  detach(
    @Param('id', ParseIntPipe) id: number,
    @Param('evidenceId', ParseIntPipe) evidenceId: number,
  ) {
    return this.service.detachEvidence(id, evidenceId);
  }

  @Post(':id/retire')
  @Roles('admin', 'reviewer')
  retire(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { note?: string },
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.service.retire(id, body?.note ?? null, user?.id);
  }
}
