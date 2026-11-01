import { Controller, Get } from '@nestjs/common';
import { DashboardService } from './dashboard.service';

/** 运行态驾驶舱聚合端点（登录态） */
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('ops')
  ops() {
    return this.service.ops();
  }

  /** 事实质量评估：逐规则通过率、字段分布、置信度与 N 分布、Top 实体 */
  @Get('quality')
  quality() {
    return this.service.quality();
  }

  /** 知识资产聚合（全景图表数据源）：实体分类 / 事实维度 / 变化日趋势 / 关系谓词 */
  @Get('viz')
  viz() {
    return this.service.viz();
  }
}
