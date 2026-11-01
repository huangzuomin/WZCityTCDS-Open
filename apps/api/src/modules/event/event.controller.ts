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
import { CurrentUser, Roles, type CurrentUserPayload } from '../../auth/decorators';
import { EventService } from './event.service';
import { createEventSchema, listEventQuerySchema, updateEventSchema } from './event.dto';

const typeSchema = z.object({
  datasetId: z.coerce.number().int().positive(),
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(128),
  sort: z.coerce.number().int().default(0),
});

const attachSchema = z.object({
  evidenceIds: z.array(z.coerce.number().int().positive()).min(1).max(50),
});

@Controller('events')
export class EventController {
  constructor(private readonly service: EventService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listEventQuerySchema)) query: unknown) {
    return this.service.list(query as never);
  }

  @Get('types')
  types(@Query('datasetId') datasetId: string) {
    return this.service.types(Number(datasetId));
  }

  @Post('types')
  @Roles('admin')
  createType(@Body(new ZodValidationPipe(typeSchema)) dto: unknown) {
    return this.service.createType(dto as never);
  }

  @Get('entity/:entityId/timeline')
  timeline(@Param('entityId', ParseIntPipe) entityId: number) {
    return this.service.timeline(entityId);
  }

  @Post()
  @Roles('admin', 'editor')
  create(
    @Body(new ZodValidationPipe(createEventSchema)) dto: unknown,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.service.create(dto as never, user?.id);
  }

  @Get(':id')
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.service.detail(id);
  }

  @Patch(':id')
  @Roles('admin', 'editor', 'reviewer')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateEventSchema)) dto: unknown,
  ) {
    return this.service.update(id, dto as never);
  }

  @Post(':id/evidence')
  @Roles('admin', 'editor')
  attach(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(attachSchema)) dto: { evidenceIds: number[] },
  ) {
    return this.service.attachEvidence(id, dto.evidenceIds);
  }

  @Delete(':id')
  @Roles('admin', 'editor')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
