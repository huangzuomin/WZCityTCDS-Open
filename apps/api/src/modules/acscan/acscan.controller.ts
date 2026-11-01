import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { Roles } from '../../auth/decorators';
import { AcScanService } from './acscan.service';
import { listContextsSchema, listHitsSchema, runScanSchema } from './acscan.dto';

@Controller('acscan')
export class AcScanController {
  constructor(private readonly service: AcScanService) {}

  /** 触发一次全量扫描（异步执行，返回 jobId 供轮询） */
  @Post('run')
  @Roles('admin', 'editor')
  run(@Body(new ZodValidationPipe(runScanSchema)) dto: unknown) {
    return this.service.startRun(dto as never);
  }

  @Get('jobs/latest')
  latestJob() {
    return this.service.latestJob();
  }

  /** 任务汇总 + 类别分布 + 实体排行 + 窗口长度分布 */
  @Get('stats')
  stats(@Query('jobId') jobId?: string) {
    return this.service.stats(jobId ? Number(jobId) : undefined);
  }

  @Get('hits')
  hits(@Query(new ZodValidationPipe(listHitsSchema)) query: unknown) {
    return this.service.listHits(query as never);
  }

  @Get('contexts')
  contexts(@Query(new ZodValidationPipe(listContextsSchema)) query: unknown) {
    return this.service.listContexts(query as never);
  }

  @Get('contexts/:id')
  contextDetail(@Param('id', ParseIntPipe) id: number) {
    return this.service.contextDetail(id);
  }
}
