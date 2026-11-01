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
import { Roles } from '../../auth/decorators';
import { ArticleService } from './article.service';
import {
  batchTagSchema,
  importArticlesSchema,
  listArticleQuerySchema,
  updateArticleSchema,
} from './article.dto';

@Controller('articles')
export class ArticleController {
  constructor(private readonly service: ArticleService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listArticleQuerySchema)) query: unknown) {
    return this.service.list(query as never);
  }

  @Get('stats')
  stats(@Query('datasetId') datasetId?: string) {
    return this.service.stats(datasetId ? Number(datasetId) : undefined);
  }

  @Post('import')
  @Roles('admin', 'editor')
  import(@Body(new ZodValidationPipe(importArticlesSchema)) dto: unknown) {
    return this.service.importArticles(dto as never);
  }

  @Post('reindex')
  @Roles('admin', 'editor')
  reindex(@Body() body: { datasetId: number }) {
    return this.service.reindex(Number(body.datasetId));
  }

  /** 切片规则变更：bodyVersion+1（之后证据会因版本不一致被标为待复核） */
  @Post('reslice')
  @Roles('admin')
  reslice(@Body() body: { datasetId: number }) {
    return this.service.reslice(Number(body.datasetId));
  }

  @Post('batch-tag')
  @Roles('admin', 'editor')
  batchTag(@Body(new ZodValidationPipe(batchTagSchema)) dto: unknown) {
    return this.service.batchTag(dto as never);
  }

  @Get(':id')
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.service.detail(id);
  }

  @Get(':id/body')
  body(@Param('id', ParseIntPipe) id: number) {
    return this.service.body(id);
  }

  @Get('entity/:entityId')
  byEntity(
    @Param('entityId', ParseIntPipe) entityId: number,
    @Query() query: { page?: string; pageSize?: string },
  ) {
    return this.service.listByEntity(entityId, {
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
    });
  }

  @Patch(':id')
  @Roles('admin', 'editor')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateArticleSchema)) dto: unknown,
  ) {
    return this.service.update(id, dto as never);
  }
}
