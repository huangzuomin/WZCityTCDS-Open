import { Module } from '@nestjs/common';
import { EventModule } from '../event/event.module';
import { EvidenceModule } from '../evidence/evidence.module';
import { FactModule } from '../fact/fact.module';
import { GraphModule } from '../graph/graph.module';
import { ArchiveController } from './archive.controller';
import { ArchiveService } from './archive.service';
import { BotVerifyService } from './bot-verify.service';
import { ChangesController } from './changes.controller';

@Module({
  imports: [EvidenceModule, FactModule, EventModule, GraphModule],
  controllers: [ArchiveController, ChangesController],
  providers: [ArchiveService, BotVerifyService],
  exports: [ArchiveService],
})
export class ArchiveModule {}
