import { Module } from '@nestjs/common';
import { EntityModule } from '../entity/entity.module';
import { FieldDefModule } from '../field-def/field-def.module';
import { LlmConfigModule } from '../llm-config/llm-config.module';
import { LlmLogModule } from '../llm-log/llm-log.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryService } from './discovery.service';

@Module({
  imports: [EntityModule, FieldDefModule, LlmConfigModule, LlmLogModule, PipelineModule],
  controllers: [DiscoveryController],
  providers: [DiscoveryService],
  exports: [DiscoveryService],
})
export class DiscoveryModule {}
