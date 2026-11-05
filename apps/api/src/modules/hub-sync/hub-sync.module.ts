import { Module } from '@nestjs/common';
import { HubSyncController } from './hub-sync.controller';
import { HubSyncService } from './hub-sync.service';

@Module({
  controllers: [HubSyncController],
  providers: [HubSyncService],
  exports: [HubSyncService],
})
export class HubSyncModule {}
