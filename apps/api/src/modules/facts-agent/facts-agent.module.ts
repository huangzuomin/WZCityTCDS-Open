import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { EvidenceModule } from '../evidence/evidence.module';
import { FactModule } from '../fact/fact.module';
import { LlmConfigModule } from '../llm-config/llm-config.module';
import { AgentMcpController } from './agent-mcp.controller';
import { AgentMcpService } from './agent-mcp.service';
import { AgentTokenGuard } from './agent-token.guard';

@Module({
  imports: [FactModule, EvidenceModule, AuditModule, LlmConfigModule],
  controllers: [AgentMcpController],
  providers: [AgentMcpService, AgentTokenGuard],
})
export class FactsAgentModule {}
