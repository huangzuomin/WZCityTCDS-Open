import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { Public } from '../../auth/decorators';
import { ObservatoryService } from './observatory.service';
import { ProbeService } from './probe.service';
import { ProbeModelConfigService } from './probe-model-config.service';
import { GeoReportService } from './geo-report.service';
import { ProbeScheduleService, type ProbeSchedule } from './probe-schedule.service';
import type { ProbeModelConfig } from './observatory.types';

@Controller('observatory')
export class ObservatoryController {
  constructor(
    private readonly obs: ObservatoryService,
    private readonly probe: ProbeService,
    private readonly modelConfig: ProbeModelConfigService,
    private readonly geoReport: GeoReportService,
    private readonly schedule: ProbeScheduleService,
  ) {}

  /** 展示层只读快照（公开） */
  @Get()
  @Public()
  getSnapshot() {
    return this.obs.getSnapshot();
  }

  /** 问题列表（分页 + 过滤） */
  @Get('questions')
  listQuestions(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: 'active' | 'disabled',
    @Query('category') category?: string,
    @Query('keyword') keyword?: string,
  ) {
    return this.obs.listQuestions({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      status,
      category,
      keyword,
    });
  }

  @Post('questions')
  createQuestion(@Body() dto: { question: string; expectedAnswer: string; category?: string; status?: string; factId?: number; entityId?: number }) {
    return this.obs.createQuestion(dto);
  }

  @Put('questions/:id')
  updateQuestion(@Param('id') id: string, @Body() dto: Record<string, unknown>) {
    return this.obs.updateQuestion(Number(id), dto);
  }

  @Delete('questions/:id')
  deleteQuestion(@Param('id') id: string) {
    return this.obs.deleteQuestion(Number(id));
  }

  /** 单题的「大模型回答记录」（各模型原文 + 引用判定） */
  @Get('questions/:id/answers')
  getQuestionAnswers(@Param('id') id: string) {
    return this.obs.getQuestionAnswers(Number(id));
  }

  /** 从 facts 重新派生问题集 */
  @Post('questions/sync')
  async syncQuestions() {
    const n = await this.probe.syncQuestionsFromFacts();
    return { synced: n };
  }

  /** 探针模型配置（后台「设置」） */
  @Get('settings')
  getSettings() {
    return this.modelConfig.list();
  }

  @Put('settings')
  saveSettings(@Body() body: { models: ProbeModelConfig[] }) {
    return this.modelConfig.save(body.models);
  }

  /** 跑一轮探针：可指定模型与随机抽样数（消耗 token，需登录） */
  @Post('probe')
  async runProbe(@Body() body: { modelId?: string; sample?: number }) {
    const { runs, results } = await this.probe.runProbe({ modelId: body?.modelId, sample: body?.sample });
    return { runs, results };
  }

  /**
   * 一键生成 GEO 效果分析报告（HTML）：
   * 取最近 questionLimit 条提问记录 + 各模型引用情况，交给生产线文本模型分析。
   */
  @Post('report')
  async generateReport(@Body() body: { questionLimit?: number }) {
    return this.geoReport.generate({ questionLimit: body?.questionLimit });
  }

  /** 最近一次生成的报告（无则 null） */
  @Get('report/latest')
  latestReport() {
    return this.geoReport.latest();
  }

  /** 探针任务计划：配置 + 当前执行状态 */
  @Get('schedule')
  getSchedule() {
    return Promise.all([this.schedule.getSchedule(), this.schedule.getState()]);
  }

  @Put('schedule')
  saveSchedule(@Body() body: Partial<ProbeSchedule>) {
    return this.schedule.saveSchedule(body);
  }

  /** 立即跑一轮全量问题（后台执行，立即返回） */
  @Post('schedule/run-now')
  runNow() {
    void this.schedule.runOnce('manual');
    return { accepted: true };
  }

  /** 执行记录列表（按命中率等统计排序） */
  @Get('runs')
  listRuns(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.obs.listRuns(page ? Number(page) : 1, pageSize ? Number(pageSize) : 20);
  }

  /** 单次执行的明细：每题 × 各模型引用判定 */
  @Get('runs/:id')
  getRunDetail(@Param('id') id: string) {
    return this.obs.getRunDetail(Number(id));
  }
}
