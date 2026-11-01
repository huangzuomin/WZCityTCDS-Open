import { Controller, Get, Post } from '@nestjs/common';
import { Roles } from '../../auth/decorators';
import { DevService } from './dev.service';

/** 开发调试（仅管理员）：数据清理等运维操作 */
@Controller('dev')
export class DevController {
  constructor(private readonly service: DevService) {}

  /** 各管线表行数预览（清空前确认用） */
  @Get('pipeline-stats')
  @Roles('admin')
  stats() {
    return this.service.pipelineStats();
  }

  /** 一键清空抽取管线产出数据（保留语料与配置） */
  @Post('clear-pipeline')
  @Roles('admin')
  clearPipeline() {
    return this.service.clearPipeline();
  }
}
