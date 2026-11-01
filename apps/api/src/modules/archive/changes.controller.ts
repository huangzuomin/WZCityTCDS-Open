import { Controller, Get, Header, Query } from '@nestjs/common';
import { Public } from '../../auth/decorators';
import { ArchiveService } from './archive.service';

/**
 * 公开事实变更流出口（只读）。
 * 路由挂在根前缀下，对齐对外文档：/api/changes 与 /api/changes.json。
 */
@Controller()
@Public()
export class ChangesController {
  constructor(private readonly service: ArchiveService) {}

  /**
   * /api/changes：变化流分页（供前端页面）；changeType/keyword 为可选服务端筛选。
   *
   * includeSystem：是否包含「系统维护类变更」，默认 false。
   * 这类记录由回填/修复脚本直接写入 fact_change（mechanism_json 标记 audit=fix_backfill、
   * kind=*backfill 或 repair=*），没有关联来源文章，前端会逐条渲染成「未命名来源 · 变更 #id」。
   * 需要审计这些记录时显式传 includeSystem=true。
   *
   * groupBy=article：按「发布记录（文章）」分页，返回 { groups, items, total }。
   * 此时 pageSize 表示每页的发布记录数，total 也是发布记录数，而不是变更条数。
   * 不传则保持扁平的变更流（静态页 / MCP 等既有调用方不变）。
   */
  @Get('changes')
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('changeType') changeType?: string,
    @Query('keyword') keyword?: string,
    @Query('includeSystem') includeSystem?: string,
    @Query('groupBy') groupBy?: string,
  ) {
    const p = page ? Number(page) : 1;
    const size = pageSize ? Number(pageSize) : 20;
    const type = changeType || undefined;
    const kw = keyword || undefined;
    const withSystem = includeSystem === 'true' || includeSystem === '1';
    return groupBy === 'article'
      ? this.service.listPublicationPage(p, size, type, kw, withSystem)
      : this.service.listChangesPage(p, size, type, kw, withSystem);
  }

  /** /api/changes.json：机器出口，最近 200 条数组 */
  @Get('changes.json')
  @Header('Content-Type', 'application/json; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=600')
  json() {
    return this.service.changesJson();
  }
}
