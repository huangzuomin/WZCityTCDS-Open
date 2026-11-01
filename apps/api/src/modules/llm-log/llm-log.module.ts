import { Module } from '@nestjs/common';
import { LlmLogController } from './llm-log.controller';
import { LlmLogService } from './llm-log.service';

@Module({
  controllers: [LlmLogController],
  providers: [LlmLogService],
  exports: [LlmLogService],
})
export class LlmLogModule {}
