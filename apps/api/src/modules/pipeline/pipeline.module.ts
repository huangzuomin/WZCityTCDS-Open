import { Module } from '@nestjs/common';
import { EventModule } from '../event/event.module';
import { EvidenceModule } from '../evidence/evidence.module';
import { FactModule } from '../fact/fact.module';
import { EntityModule } from '../entity/entity.module';
import { LlmConfigModule } from '../llm-config/llm-config.module';
import { PipelineController } from './pipeline.controller';
import { PipelineService } from './pipeline.service';

/** 草稿审核模块（抽取由 discovery 生产线负责；关系草稿审核通过后入图谱边表） */
@Module({
  imports: [EvidenceModule, FactModule, EventModule, EntityModule, LlmConfigModule],
  controllers: [PipelineController],
  providers: [PipelineService],
  exports: [PipelineService],
})
export class PipelineModule {}
