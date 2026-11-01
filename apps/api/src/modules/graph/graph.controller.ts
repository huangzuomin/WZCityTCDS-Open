import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { GraphService } from './graph.service';
import { Roles } from '../../auth/decorators';

/** 知识图谱浏览：子图 / 概览 / 关系明细 / 谓词分布 / 实体搜索 + 关系方向人工修正 */
@Controller('graph')
export class GraphController {
  constructor(private readonly service: GraphService) {}

  /** 以实体为中心的多跳子图 */
  @Get('entity/:id')
  entityGraph(
    @Param('id', ParseIntPipe) id: number,
    @Query('depth') depth?: string,
    @Query('direction') direction?: string,
    @Query('minConfidence') minConfidence?: string,
    @Query('predicate') predicate?: string,
  ) {
    return this.service.entityGraph(id, {
      depth: depth ? Number(depth) : 1,
      direction: direction === 'out' || direction === 'in' ? direction : 'both',
      minConfidence: minConfidence ? Number(minConfidence) : undefined,
      predicate: predicate || undefined,
    });
  }

  /** 概览子图（按度数取 top N） */
  @Get('overview')
  overview(@Query('datasetId') datasetId?: string, @Query('limit') limit?: string) {
    return this.service.overview(datasetId ? Number(datasetId) : undefined, limit ? Number(limit) : 50);
  }

  /** 关系明细列表 */
  @Get('relations')
  relations(
    @Query('datasetId') datasetId?: string,
    @Query('headEntityId') headEntityId?: string,
    @Query('predicate') predicate?: string,
    @Query('keyword') keyword?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.relations({
      datasetId: datasetId ? Number(datasetId) : undefined,
      headEntityId: headEntityId ? Number(headEntityId) : undefined,
      predicate,
      keyword,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
    });
  }

  /** 人工反转关系方向（head ⇄ tail）：写库，origin=manual */
  @Post('relations/:id/reverse')
  @Roles('admin', 'editor')
  reverseRelation(@Param('id', ParseIntPipe) id: number) {
    return this.service.reverseRelation(id);
  }

  /** 修改关系名称（谓词）：人工，origin=manual */
  @Patch('relations/:id')
  @Roles('admin', 'editor')
  updateRelation(@Param('id', ParseIntPipe) id: number, @Body() body: { predicate?: string }) {
    return this.service.updateRelation(id, { predicate: body?.predicate });
  }

  /** 删除关系（软删为 rejected） */
  @Delete('relations/:id')
  @Roles('admin', 'editor')
  deleteRelation(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteRelation(id);
  }

  /** 修改概念节点（非实体）名称 */
  @Patch('nodes/:id')
  @Roles('admin', 'editor')
  updateConceptNode(@Param('id', ParseIntPipe) id: number, @Body() body: { name?: string }) {
    return this.service.updateConceptNode(id, { name: body?.name });
  }

  /** 谓词分布 */
  @Get('predicates')
  predicates(@Query('datasetId') datasetId?: string) {
    return this.service.predicates(datasetId ? Number(datasetId) : undefined);
  }

  /** 实体搜索（选中心点） */
  @Get('entities')
  searchEntities(
    @Query('keyword') keyword: string,
    @Query('datasetId') datasetId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.searchEntities(keyword ?? '', datasetId ? Number(datasetId) : undefined, limit ? Number(limit) : 20);
  }

  /** 节点搜索（实体 ∪ 概念，选中心点） */
  @Get('nodes/search')
  searchNodes(
    @Query('keyword') keyword: string,
    @Query('datasetId') datasetId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.searchNodes(keyword ?? '', datasetId ? Number(datasetId) : undefined, limit ? Number(limit) : 20);
  }
}
