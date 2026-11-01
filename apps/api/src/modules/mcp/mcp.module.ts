import { Module } from '@nestjs/common';
import { ArchiveModule } from '../archive/archive.module';
import { EntityModule } from '../entity/entity.module';
import { FactModule } from '../fact/fact.module';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

@Module({
  imports: [EntityModule, FactModule, ArchiveModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
