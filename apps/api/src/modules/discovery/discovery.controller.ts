import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { CurrentUser, Public, Roles, type CurrentUserPayload } from '../../auth/decorators';
import { DiscoveryService } from './discovery.service';

/** datasetId 缺失/非法时明确返回 400，避免 NaN 拼进 SQL 导致 500 */
function parseDatasetId(v: string | undefined | null): number {
  const n = Number(v);
  if (!v || !Number.isInteger(n) || n <= 0) {
    throw new BadRequestException('datasetId 缺失或非法（需为正整数）');
  }
  return n;
}

/**
 * 实体发现与对齐管线的操作入口。
 * 队列支持断点续跑：重复调用 run 只会处理未完成的文章。
 */
@Controller('discovery')
export class DiscoveryController {
  constructor(private readonly service: DiscoveryService) {}

  /** 队列进度（pending / running / done / failed 各多少，待人工裁决多少） */
  @Get('queue')
  queue(@Query('datasetId') datasetId: string) {
    return this.service.queueStatus(parseDatasetId(datasetId));
  }

  /** 从 oucai.news 抽样建队列（幂等：已建过的文章不会重复入队） */
  @Post('queue')
  @Roles('admin', 'editor')
  buildQueue(
    @Query('datasetId') datasetId: string,
    @Query('limit') limit?: string,
    @Body() body?: { bodyMin?: number; bodyMax?: number; batch?: 'baseline' | 'incremental' },
  ) {
    return this.service.buildQueue(parseDatasetId(datasetId), Number(limit ?? 100), body ?? {});
  }

  /** 跑队列：并发数取「大模型设置」各渠道的「并发数」配置（默认 10）；已 done 的文章跳过，支持中断后继续 */
  @Post('run')
  @Roles('admin', 'editor')
  run(
    @Query('datasetId') datasetId: string,
    @Query('limit') limit?: string,
  ) {
    // 跑批耗时较长，异步执行；进度通过 GET /discovery/queue 轮询
    // limit 缺省 = 0（不限量）：前端「跑批」已不限量，若这里默认 100 会导致
    // 每次点跑批只处理 100 条就结束，剩下的任务看起来「全是排队、没有进行中」。
    const ds = parseDatasetId(datasetId);
    const batchLimit = Number(limit ?? 0);
    void this.service
      .runQueue(ds, batchLimit)
      .catch((e: Error) => console.error(`[discovery.run] 失败：${e.message}`));
    return { started: true, datasetId: ds, limit: batchLimit };
  }

  /** 取消排队（温和）：只把「排队中」的任务置为跳过（正在处理中的单篇会跑完） */
  @Post('queue/cancel')
  @Roles('admin', 'editor')
  cancelQueue(@Query('datasetId') datasetId: string) {
    return this.service.cancelQueue(parseDatasetId(datasetId));
  }

  /** 终止任务（强制）：中断在途 LLM 调用，并把「排队中 / 进行中」全部置为跳过 */
  @Post('queue/terminate')
  @Roles('admin', 'editor')
  terminateQueue(@Query('datasetId') datasetId: string) {
    return this.service.terminateQueue(parseDatasetId(datasetId));
  }

  // ---------------------------------------------------------------- 生产线处理记录

  /** 当前生产线模型（文本模型：启用 + 设为生产线），多条时并发调用 */
  @Get('production')
  production() {
    return this.service.productionModels();
  }

  /** 处理记录列表（每篇文章一次处理） */
  @Get('records')
  @Public()
  records(
    @Query('datasetId') datasetId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('orderBy') orderBy?: string,
  ) {
    return this.service.listRecords({
      datasetId: datasetId ? Number(datasetId) : undefined,
      status,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
      orderBy: orderBy === 'pubDate' ? 'pubDate' : undefined,
    });
  }

  /** 单条处理明细（概览 + 各模型/各阶段汇总） */
  @Get('records/:id')
  @Public()
  record(@Param('id', ParseIntPipe) id: number) {
    return this.service.getRecord(id);
  }

  /** 单条处理的 LLM 调用明细 */
  @Get('records/:id/calls')
  recordCalls(
    @Param('id', ParseIntPipe) id: number,
    @Query('status') status?: string,
    @Query('stage') stage?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.listRecordCalls(id, {
      status,
      stage,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
    });
  }

  /** 单条处理产出的草稿 */
  @Get('records/:id/drafts')
  recordDrafts(
    @Param('id', ParseIntPipe) id: number,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.listRecordDrafts(id, page ? Number(page) : 1, pageSize ? Number(pageSize) : 50);
  }

  /** 待人工裁决队列（合并建议 / 属性冲突 / 新谓词注册），分页返回 */
  @Get('align-tasks')
  alignTasks(
    @Query('datasetId') datasetId: string,
    @Query('kind') kind?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.listAlignTasks(
      parseDatasetId(datasetId),
      kind,
      'pending',
      page ? Number(page) : 1,
      pageSize ? Number(pageSize) : 20,
    );
  }

  /**
   * 人工裁决：每次裁决都会沉淀（别名 / 谓词映射），让同类问题下次自动命中。
   * resolution: merge=合并到目标实体; new=作为新实体收录; reject=丢弃
   */
  @Post('align-tasks/:id/resolve')
  @Roles('admin', 'editor', 'reviewer')
  resolve(
    @Param('id', ParseIntPipe) id: number,
    @Body()
    dto: {
      resolution: 'merge' | 'new' | 'reject';
      canonical?: string;
      targetEntityId?: number;
      newName?: string;
      newGroup?: string;
    },
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.service.resolveAlignTask(
      id,
      dto.resolution,
      user?.id,
      dto.canonical,
      dto.targetEntityId,
      dto.newName,
      dto.newGroup,
    );
  }

  /** 某分类的维度分配：返回该语料域全部 active 维度 + 已分配 id 集合（后台「分类维度」页） */
  @Get('categories/:id/dimensions')
  categoryDimensions(
    @Param('id', ParseIntPipe) id: number,
    @Query('datasetId') datasetId: string,
  ) {
    return this.service.getCategoryDimensionsWithAssignment(parseDatasetId(datasetId), id);
  }

  /** 整体替换某库某分类的启用维度子集 */
  @Put('categories/:id/dimensions')
  @Roles('admin', 'editor')
  setCategoryDimensions(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { datasetId: number; dimensionIds: number[] },
  ) {
    return this.service.setCategoryDimensions(Number(dto.datasetId), id, dto.dimensionIds ?? []);
  }

  /** 按语义把某语料域存量维度自动归类到分类（写入 category_dimension） */
  @Post('dimensions/auto-classify')
  @Roles('admin', 'editor')
  autoClassifyDimensions(@Body() dto: { datasetId: number }) {
    return this.service.autoClassifyCategoryDimensions(Number(dto.datasetId));
  }

  // ---------------------------------------------------------------- 关系 schema（后台维护）

  /** 关系 schema 列表：按 head 分类（可选）列出，关联分类名称 */
  @Get('relation-schemas')
  relationSchemas(@Query('categoryId') categoryId?: string) {
    return this.service.listRelationSchemas(categoryId ? Number(categoryId) : undefined);
  }

  /** 新增：某 head 分类 × tail 类型 的关系词配置 */
  @Post('relation-schemas')
  @Roles('admin', 'editor')
  createRelationSchema(
    @Body() dto: { categoryId: number; tailType: string; relations: string[]; sort?: number; status?: 'active' | 'disabled' },
  ) {
    return this.service.createRelationSchema(dto);
  }

  /** 编辑：tailType / relations / sort / status 局部更新 */
  @Patch('relation-schemas/:id')
  @Roles('admin', 'editor')
  updateRelationSchema(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { tailType?: string; relations?: string[]; sort?: number; status?: 'active' | 'disabled' },
  ) {
    return this.service.updateRelationSchema(id, dto);
  }

  /** 删除一条关系 schema 配置 */
  @Delete('relation-schemas/:id')
  @Roles('admin', 'editor')
  deleteRelationSchema(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteRelationSchema(id);
  }
}
