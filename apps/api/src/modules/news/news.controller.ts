import { Body, Controller, Delete, Get, Post, Put, Query } from '@nestjs/common';
import { Roles, Public } from '../../auth/decorators';
import { NewsService } from './news.service';
import { NewsScheduleService } from './news-schedule.service';
import type { NewsSource } from './news-sources';
import type { NewsEsConfig } from './news-es';

/**
 * 实时新闻：多新闻源（es / http）+ 多任务计划。
 * 支持定时任务计划（多计划、计划绑定单新闻源）、新闻源连接配置与手动触发。
 */
@Controller('news')
export class NewsController {
  constructor(
    private readonly news: NewsService,
    private readonly schedule: NewsScheduleService,
  ) {}

  // ---------------------------------------------------------------- 多源

  @Get('sources')
  listSources() {
    return this.news.listSources();
  }

  @Post('sources')
  @Roles('admin', 'editor')
  saveSource(@Body() body: Partial<NewsSource> & { id?: string }) {
    return this.news.saveSource(body);
  }

  @Delete('sources')
  @Roles('admin', 'editor')
  deleteSource(@Query('id') id: string) {
    return this.news.deleteSource(id);
  }

  /** 测试某源（未保存的表单值先行验证） */
  @Post('sources/test')
  @Roles('admin', 'editor')
  testSource(@Body() body: Partial<NewsSource>) {
    return this.news.testSource(body);
  }

  // ---------------------------------------------------------------- 统计 / 预览 / 入库（按源）

  @Get('stats')
  stats(@Query('sourceId') sourceId?: string) {
    return this.news.stats(sourceId ?? '');
  }

  @Get('preview')
  preview(@Query('sourceId') sourceId?: string, @Query('limit') limit?: string) {
    return this.news.preview(sourceId ?? '', Number(limit ?? 10));
  }

  @Post('ingest')
  @Roles('admin', 'editor')
  ingest(@Query('sourceId') sourceId?: string, @Query('limit') limit?: string) {
    return this.news.ingest(sourceId ?? '', Number(limit ?? 10));
  }

  // ---------------------------------------------------------------- 兼容旧 ES 编辑页接口

  @Get('es-config')
  getEsConfig() {
    return this.news.getEsConfig();
  }

  @Put('es-config')
  @Roles('admin', 'editor')
  saveEsConfig(@Body() body: Partial<NewsEsConfig>) {
    return this.news.saveEsConfig(body);
  }

  @Post('es-config/test')
  @Roles('admin', 'editor')
  testEsConfig(@Body() body?: Partial<NewsEsConfig>) {
    return this.news.testEsConfig(body);
  }

  @Post('es-config/cursor/reset')
  @Roles('admin', 'editor')
  resetCursor() {
    return this.news.resetCursor();
  }

  // ---------------------------------------------------------------- 多计划

  @Get('schedules')
  listSchedules() {
    return this.schedule.listSchedules();
  }

  @Put('schedules')
  @Roles('admin', 'editor')
  saveSchedule(@Body() body: Parameters<NewsScheduleService['saveSchedule']>[0]) {
    return this.schedule.saveSchedule(body);
  }

  @Delete('schedules')
  @Roles('admin', 'editor')
  deleteSchedule(@Query('id') id: string) {
    return this.schedule.deleteSchedule(Number(id));
  }

  /** 手动触发执行一个计划（后台执行） */
  @Post('schedules/run-now')
  @Roles('admin', 'editor')
  async runNow(@Body() body: { id?: number }) {
    void this.schedule.runOnce('manual', Number(body?.id));
    return { accepted: true, error: null };
  }

  /** 执行记录（入库 + 跑批的每次执行） */
  @Get('runs')
  @Public()
  runs(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.schedule.history(page ? Number(page) : 1, pageSize ? Number(pageSize) : 20);
  }
}