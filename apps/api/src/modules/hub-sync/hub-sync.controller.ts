import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators';
import { HubSyncService } from './hub-sync.service';
import type {
  PublicationSnapshot,
  ProjectSnapshotOptions,
  HubUpstreamChangeEvent,
  ChangesStreamEvent,
} from '@ssot/shared';

@Controller('hub-sync')
export class HubSyncController {
  constructor(private readonly service: HubSyncService) {}

  @Post('project')
  @Roles('admin', 'editor')
  async project(
    @Body('snapshot') snapshot: PublicationSnapshot,
    @Body('options') options?: ProjectSnapshotOptions,
  ) {
    return this.service.projectSnapshot(snapshot, options);
  }

  @Get('history')
  @Roles('admin', 'editor', 'reviewer')
  async getHistory(@Query('entityId') entityId?: string) {
    return this.service.getProjectionHistory(entityId);
  }

  @Get('history/:entityId/latest')
  @Roles('admin', 'editor', 'reviewer')
  async getLatestReceipt(@Param('entityId') entityId: string) {
    return this.service.getLatestProjectionReceipt(entityId);
  }

  @Post('consume/event')
  @Roles('admin')
  async consumeEvent(@Body() event: HubUpstreamChangeEvent) {
    return this.service.consumeHubEvent(event);
  }

  @Post('consume/outlet-event')
  @Roles('admin')
  async consumeOutletEvent(@Body() event: ChangesStreamEvent) {
    return this.service.consumeOutletEvent(event);
  }

  @Post('consume/ndjson')
  @Roles('admin')
  async consumeNdjson(
    @Body('stream') stream: string,
    @Body('streamType') streamType?: 'HUB_UPSTREAM' | 'OUTLET_CHANGES',
  ) {
    return this.service.consumeNdjson(stream || '', streamType);
  }

  @Get('entities')
  @Roles('admin', 'editor', 'reviewer')
  async listEntities(
    @Query('category') category?: string,
    @Query('includeTombstoned') includeTombstoned?: string,
  ) {
    return this.service.listProjectedEntities({
      category,
      includeTombstoned: includeTombstoned === 'true',
    });
  }

  @Get('entities/:entityId')
  @Roles('admin', 'editor', 'reviewer')
  async getEntity(@Param('entityId') entityId: string) {
    return this.service.getProjectedEntity(entityId);
  }

  @Get('stats')
  @Roles('admin', 'editor', 'reviewer')
  async getStats() {
    return this.service.getStats();
  }

  @Get('dead-letters')
  @Roles('admin')
  async getDeadLetters() {
    return this.service.getDeadLetters();
  }
}
