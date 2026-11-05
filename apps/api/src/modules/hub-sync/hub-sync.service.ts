import { Injectable } from '@nestjs/common';
import {
  HubOneWayProjector,
  ChangesStreamConsumer,
  type HubProjectionReceipt,
  type ProjectSnapshotOptions,
  type PublicationSnapshot,
  type HubUpstreamChangeEvent,
  type ChangesStreamEvent,
  type ProjectedEntityState,
  type DeadLetterRecord,
} from '@ssot/shared';

@Injectable()
export class HubSyncService {
  private readonly projector: HubOneWayProjector;
  private readonly consumer: ChangesStreamConsumer;

  constructor() {
    this.projector = new HubOneWayProjector();
    this.consumer = new ChangesStreamConsumer();
  }

  public async projectSnapshot(
    snapshot: PublicationSnapshot,
    options?: ProjectSnapshotOptions,
  ): Promise<HubProjectionReceipt> {
    return this.projector.projectSnapshot(snapshot, options);
  }

  public getProjectionHistory(entityId?: string): readonly HubProjectionReceipt[] {
    return this.projector.getHistory(entityId);
  }

  public getLatestProjectionReceipt(entityId: string): HubProjectionReceipt | null {
    return this.projector.getLatestReceipt(entityId);
  }

  public consumeHubEvent(event: HubUpstreamChangeEvent): { applied: boolean; reason?: string } {
    return this.consumer.consumeHubEvent(event);
  }

  public consumeOutletEvent(event: ChangesStreamEvent): { applied: boolean; reason?: string } {
    return this.consumer.consumeOutletEvent(event);
  }

  public consumeNdjson(
    ndjsonStream: string,
    streamType: 'HUB_UPSTREAM' | 'OUTLET_CHANGES' = 'HUB_UPSTREAM',
  ): {
    totalLines: number;
    processed: number;
    skipped: number;
    deadLetters: number;
  } {
    return this.consumer.consumeNdjson(ndjsonStream, streamType);
  }

  public getProjectedEntity(entityId: string): ProjectedEntityState | null {
    return this.consumer.getEntityState(entityId);
  }

  public listProjectedEntities(filter?: {
    category?: string;
    includeTombstoned?: boolean;
  }): ProjectedEntityState[] {
    return this.consumer.listEntities(filter);
  }

  public getDeadLetters(): readonly DeadLetterRecord[] {
    return this.consumer.getDeadLetters();
  }

  public getStats(): {
    projectorHistoryCount: number;
    processed: number;
    skippedDuplicates: number;
    deadLettersCount: number;
    projectedEntitiesCount: number;
    hubCursor: number;
    outletCursor: number;
  } {
    const consumerStats = this.consumer.getStats();
    return {
      projectorHistoryCount: this.projector.getHistory().length,
      ...consumerStats,
    };
  }
}
