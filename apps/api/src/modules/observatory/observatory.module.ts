import { Module } from '@nestjs/common';
import { ObservatoryController } from './observatory.controller';
import { ObservatoryService } from './observatory.service';
import { ProbeService } from './probe.service';
import { ProbeModelConfigService } from './probe-model-config.service';
import { GeoReportService } from './geo-report.service';
import { ProbeScheduleService } from './probe-schedule.service';
import { LlmConfigModule } from '../llm-config/llm-config.module';
import { LlmLogModule } from '../llm-log/llm-log.module';

@Module({
  imports: [LlmConfigModule, LlmLogModule],
  controllers: [ObservatoryController],
  providers: [
    ObservatoryService,
    ProbeService,
    ProbeModelConfigService,
    GeoReportService,
    ProbeScheduleService,
  ],
  exports: [
    ObservatoryService,
    ProbeService,
    ProbeModelConfigService,
    GeoReportService,
    ProbeScheduleService,
  ],
})
export class ObservatoryModule {}
