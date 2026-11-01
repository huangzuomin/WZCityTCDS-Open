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
import { ZodValidationPipe } from '../../common/zod.pipe';
import { CurrentUser, Public, Roles, type CurrentUserPayload } from '../../auth/decorators';
import { EntityService } from './entity.service';
import {
  aliasSchema,
  createEntitySchema,
  listEntityQuerySchema,
  updateEntitySchema,
} from './entity.dto';

@Controller('entities')
export class EntityController {
  constructor(private readonly service: EntityService) {}

  @Get()
  @Public()
  list(@Query(new ZodValidationPipe(listEntityQuerySchema)) query: unknown) {
    return this.service.list(query as never);
  }

  @Get(':id')
  @Public()
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.service.detail(id);
  }

  @Post()
  create(@Body(new ZodValidationPipe(createEntitySchema)) dto: unknown) {
    return this.service.create(dto as never);
  }

  /** 规则自动审批：有事实草稿的 draft 实体批量发布 */
  @Post('auto-publish')
  @Roles('admin', 'editor')
  autoPublish(
    @Query('datasetId') datasetId?: string,
    @CurrentUser() user?: CurrentUserPayload,
  ) {
    return this.service.autoPublish(datasetId ? Number(datasetId) : undefined, user?.id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateEntitySchema)) dto: unknown,
  ) {
    return this.service.update(id, dto as never);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }

  @Get(':id/aliases')
  aliases(@Param('id', ParseIntPipe) id: number) {
    return this.service.listAliases(id);
  }

  @Post(':id/aliases')
  addAlias(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(aliasSchema)) dto: { alias: string; source?: string | null },
  ) {
    return this.service.addAlias(id, dto.alias, dto.source);
  }

  @Delete(':id/aliases/:aliasId')
  removeAlias(
    @Param('id', ParseIntPipe) id: number,
    @Param('aliasId', ParseIntPipe) aliasId: number,
  ) {
    return this.service.removeAlias(id, aliasId);
  }
}
