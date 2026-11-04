import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  OutletsHttpRouter,
  OutletsHttpRequest,
  OutletsHttpResponse,
  OutletsStore,
  SnapshotRecord,
  ChangesStreamManager,
} from '@ssot/shared';
import { DRIZZLE, type Db } from '../../db/db.module';

@Injectable()
export class OutletsService {
  private readonly router: OutletsHttpRouter;
  private readonly streamManager: ChangesStreamManager;
  private readonly inMemorySnapshots: Map<string, SnapshotRecord> = new Map();

  constructor(@Optional() @Inject(DRIZZLE) private readonly db?: Db) {
    this.streamManager = new ChangesStreamManager();
    const store: OutletsStore = {
      getSnapshotRecordById: async (id: string) => this.fetchSnapshotRecordById(id),
      getSnapshotRecordByEntity: async (entityId: string) => this.fetchSnapshotRecordByEntity(entityId),
      listPublicSnapshots: async (limit?: number) => this.listSnapshots(limit),
      getChangesStreamManager: async () => this.streamManager,
      getRetractedSourceDocIds: async () => this.fetchRetractedSourceDocIds(),
    };
    this.router = new OutletsHttpRouter(store);
  }

  public registerSnapshot(record: SnapshotRecord): void {
    this.inMemorySnapshots.set(record.snapshot.snapshot_revision_id, record);
    this.streamManager.emitEvent({
      change_type: 'SNAPSHOT_SEALED',
      entity_id: record.snapshot.entity_id,
      affected_revision: {
        revision_id: record.snapshot.published_assertions[0]?.revision_id ?? 'rev_genesis',
        property_path: record.snapshot.published_assertions[0]?.property_path ?? 'entity.core',
        lifecycle_state: 'PUBLISHED',
        publication_snapshot_id: record.snapshot.snapshot_revision_id,
      },
    });
  }

  public async handleRequest(req: OutletsHttpRequest): Promise<OutletsHttpResponse> {
    return this.router.handleRequest(req);
  }

  private async fetchSnapshotRecordById(id: string): Promise<SnapshotRecord | null> {
    const memory = this.inMemorySnapshots.get(id);
    if (memory) return memory;
    return null;
  }

  private async fetchSnapshotRecordByEntity(entityId: string): Promise<SnapshotRecord | null> {
    for (const rec of this.inMemorySnapshots.values()) {
      if (rec.snapshot.entity_id === entityId) return rec;
    }
    return null;
  }

  private async listSnapshots(limit: number = 50): Promise<SnapshotRecord[]> {
    return Array.from(this.inMemorySnapshots.values()).slice(0, limit);
  }

  private async fetchRetractedSourceDocIds(): Promise<string[]> {
    return [];
  }
}
