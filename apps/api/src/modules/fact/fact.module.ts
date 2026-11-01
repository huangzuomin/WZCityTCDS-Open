import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LlmConfigModule } from '../llm-config/llm-config.module';
import { FactController } from './fact.controller';
import { FactExpiryService } from './fact-expiry.service';
import { FactService } from './fact.service';

@Module({
  imports: [AuditModule, LlmConfigModule],
  controllers: [FactController],
  providers: [FactService, FactExpiryService],
  exports: [FactService],
})
export class FactModule {}
