import { createHash } from 'node:crypto';
import {
  type HubUpstreamChangeEvent,
  type HubUpstreamChangeType,
  HubUpstreamChangeEventSchema,
} from '../contracts/hub-projection.js';
import {
  type ChangesStreamEvent,
  ChangesStreamEventSchema,
} from '../contracts/outlets.js';
import { assertValidEntityId } from '../adapters/hub-entity.js';

export interface ProjectedEntityState {
  entity_id: string;
  canonical_name: string;
  aliases: string[];
  category: string;
  spatial_coordinates?: { longitude: number; latitude: number };
  is_tombstoned: boolean;
  tombstone_reason?: string;
  merged_into_entity_id?: string;
  version_sequence: number;
  last_updated_at: string;
  published_facts: Record<
    string,
    {
      raw_value: unknown;
      revision_id: string;
      lifecycle_state: 'PUBLISHED' | 'SUPERSEDED' | 'REVOKED';
      updated_at: string;
    }
  >;
}

export interface DeadLetterRecord {
  line_number: number;
  raw_line: string;
  error_message: string;
  received_at: string;
}

export type ChangeEventListener = (event: HubUpstreamChangeEvent | ChangesStreamEvent) => void;

export function computeUpstreamChangeDigest(
  eventWithoutDigest: Omit<HubUpstreamChangeEvent, 'digest_sha256'>
): string {
  const canonical = JSON.stringify(
    eventWithoutDigest,
    Object.keys(eventWithoutDigest).sort()
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex').toLowerCase();
}

/**
 * ChangesStreamConsumer
 * Subscribes to and consumes upstream Hub entity changes stream and local outlets fact stream.
 * Strictly maintains local read projection cache while adhering to Option A (No parallel entity master).
 */
export class ChangesStreamConsumer {
  private lastHubSequenceNum: number;
  private lastOutletSequenceNum: number;
  private readonly entityStore = new Map<string, ProjectedEntityState>();
  private readonly deadLetters: DeadLetterRecord[] = [];
  private readonly listeners: ChangeEventListener[] = [];
  private processedCount = 0;
  private skippedDuplicateCount = 0;

  constructor(options?: { initialHubSeq?: number; initialOutletSeq?: number }) {
    this.lastHubSequenceNum = options?.initialHubSeq ?? 0;
    this.lastOutletSequenceNum = options?.initialOutletSeq ?? 0;
  }

  public getHubCursor(): number {
    return this.lastHubSequenceNum;
  }

  public getOutletCursor(): number {
    return this.lastOutletSequenceNum;
  }

  public subscribe(listener: ChangeEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private notify(event: HubUpstreamChangeEvent | ChangesStreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // Safe emission: listeners do not crash the consumer
      }
    }
  }

  /**
   * Consume an upstream Hub entity change event.
   */
  public consumeHubEvent(event: HubUpstreamChangeEvent): { applied: boolean; reason?: string } {
    const validated = HubUpstreamChangeEventSchema.parse(event);
    assertValidEntityId(validated.entity_id);

    if (validated.target_merged_entity_id) {
      assertValidEntityId(validated.target_merged_entity_id);
    }

    if (validated.hub_sequence_num <= this.lastHubSequenceNum) {
      this.skippedDuplicateCount++;
      return {
        applied: false,
        reason: `Duplicate or stale sequence number ${validated.hub_sequence_num} <= cursor ${this.lastHubSequenceNum}`,
      };
    }

    // Verify cryptographic digest
    const { digest_sha256, ...rest } = validated;
    const computed = computeUpstreamChangeDigest(rest);
    if (computed.toLowerCase() !== digest_sha256.toLowerCase()) {
      throw new Error(
        `Event digest mismatch for ${validated.hub_change_event_id}: expected ${digest_sha256}, computed ${computed}`
      );
    }

    let state = this.entityStore.get(validated.entity_id);
    if (!state) {
      state = {
        entity_id: validated.entity_id,
        canonical_name: validated.canonical_name,
        aliases: [...validated.aliases],
        category: validated.category,
        spatial_coordinates: validated.spatial_coordinates,
        is_tombstoned: false,
        version_sequence: validated.hub_sequence_num,
        last_updated_at: validated.timestamp,
        published_facts: {},
      };
    }

    state.version_sequence = validated.hub_sequence_num;
    state.last_updated_at = validated.timestamp;

    switch (validated.change_type) {
      case 'ENTITY_CREATED':
      case 'ENTITY_UPDATED':
        state.canonical_name = validated.canonical_name;
        state.aliases = Array.from(new Set([...state.aliases, ...validated.aliases]));
        state.category = validated.category;
        if (validated.spatial_coordinates) {
          state.spatial_coordinates = validated.spatial_coordinates;
        }
        break;

      case 'ALIAS_ADDED':
        state.aliases = Array.from(new Set([...state.aliases, ...validated.aliases]));
        break;

      case 'MERGED_INTO':
        state.merged_into_entity_id = validated.target_merged_entity_id;
        state.is_tombstoned = true;
        state.tombstone_reason = `Merged into entity ${validated.target_merged_entity_id}`;
        break;

      case 'TOMBSTONED':
        state.is_tombstoned = true;
        state.tombstone_reason = validated.tombstone_reason ?? 'Authoritatively tombstoned by Hub';
        break;
    }

    this.entityStore.set(validated.entity_id, state);
    this.lastHubSequenceNum = validated.hub_sequence_num;
    this.processedCount++;
    this.notify(validated);

    return { applied: true };
  }

  /**
   * Consume an outlet fact changes stream event (e.g. FACT_PUBLISHED, FACT_REVOKED).
   */
  public consumeOutletEvent(event: ChangesStreamEvent): { applied: boolean; reason?: string } {
    const validated = ChangesStreamEventSchema.parse(event);
    assertValidEntityId(validated.entity_id);

    if (validated.change_sequence_num <= this.lastOutletSequenceNum) {
      this.skippedDuplicateCount++;
      return {
        applied: false,
        reason: `Duplicate or stale outlet sequence ${validated.change_sequence_num} <= cursor ${this.lastOutletSequenceNum}`,
      };
    }

    let state = this.entityStore.get(validated.entity_id);
    if (!state) {
      // Lazy creation of read model if entity metadata not yet received
      state = {
        entity_id: validated.entity_id,
        canonical_name: `Entity ${validated.entity_id}`,
        aliases: [],
        category: 'POI',
        is_tombstoned: false,
        version_sequence: 0,
        last_updated_at: validated.event_timestamp,
        published_facts: {},
      };
    }

    const { property_path, revision_id, lifecycle_state } = validated.affected_revision;
    state.published_facts[property_path] = {
      raw_value: undefined,
      revision_id,
      lifecycle_state,
      updated_at: validated.event_timestamp,
    };

    if (validated.change_type === 'FACT_REVOKED' && property_path === '*') {
      state.is_tombstoned = true;
      state.tombstone_reason = 'All facts revoked';
    }

    this.entityStore.set(validated.entity_id, state);
    this.lastOutletSequenceNum = validated.change_sequence_num;
    this.processedCount++;
    this.notify(validated);

    return { applied: true };
  }

  /**
   * Consumes an NDJSON stream line by line.
   * Handles empty lines, skips already processed sequences, and records dead letters for bad lines.
   */
  public consumeNdjson(
    ndjsonStream: string,
    streamType: 'HUB_UPSTREAM' | 'OUTLET_CHANGES' = 'HUB_UPSTREAM'
  ): {
    totalLines: number;
    processed: number;
    skipped: number;
    deadLetters: number;
  } {
    const lines = ndjsonStream.split('\n');
    let processed = 0;
    let skipped = 0;
    let deadLetters = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const parsed = JSON.parse(line);
        if (streamType === 'HUB_UPSTREAM') {
          const res = this.consumeHubEvent(parsed);
          if (res.applied) processed++;
          else skipped++;
        } else {
          const res = this.consumeOutletEvent(parsed);
          if (res.applied) processed++;
          else skipped++;
        }
      } catch (err) {
        deadLetters++;
        this.deadLetters.push({
          line_number: i + 1,
          raw_line: line.length > 256 ? line.substring(0, 256) + '...' : line,
          error_message: err instanceof Error ? err.message : String(err),
          received_at: new Date().toISOString(),
        });
      }
    }

    return {
      totalLines: lines.length,
      processed,
      skipped,
      deadLetters,
    };
  }

  public getEntityState(entity_id: string): ProjectedEntityState | null {
    const state = this.entityStore.get(entity_id);
    return state ? JSON.parse(JSON.stringify(state)) : null;
  }

  public isTombstoned(entity_id: string): boolean {
    const state = this.entityStore.get(entity_id);
    return state?.is_tombstoned ?? false;
  }

  public listEntities(filter?: { category?: string; includeTombstoned?: boolean }): ProjectedEntityState[] {
    const list: ProjectedEntityState[] = [];
    for (const state of this.entityStore.values()) {
      if (filter?.category && state.category !== filter.category) {
        continue;
      }
      if (!filter?.includeTombstoned && state.is_tombstoned) {
        continue;
      }
      list.push(JSON.parse(JSON.stringify(state)));
    }
    return list;
  }

  public getDeadLetters(): readonly DeadLetterRecord[] {
    return this.deadLetters;
  }

  public getStats(): {
    processed: number;
    skippedDuplicates: number;
    deadLettersCount: number;
    projectedEntitiesCount: number;
    hubCursor: number;
    outletCursor: number;
  } {
    return {
      processed: this.processedCount,
      skippedDuplicates: this.skippedDuplicateCount,
      deadLettersCount: this.deadLetters.length,
      projectedEntitiesCount: this.entityStore.size,
      hubCursor: this.lastHubSequenceNum,
      outletCursor: this.lastOutletSequenceNum,
    };
  }
}
