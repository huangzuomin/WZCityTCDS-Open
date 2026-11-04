import { createHash, randomBytes } from 'node:crypto';
import {
  type ChangesStreamEvent,
  type StreamChangeType,
  type AffectedRevision,
  ChangesStreamEventSchema,
} from '../contracts/outlets.js';

export interface EmitChangeEventParams {
  change_type: StreamChangeType;
  entity_id: string;
  affected_revision: AffectedRevision;
  event_timestamp?: string;
}

export function computeStreamEventDigest(
  eventWithoutDigest: Omit<ChangesStreamEvent, 'event_digest_sha256'>
): string {
  const canonical = JSON.stringify(
    eventWithoutDigest,
    Object.keys(eventWithoutDigest).sort()
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex').toLowerCase();
}

export class ChangesStreamManager {
  private currentSequenceNum: number;
  private readonly events: ChangesStreamEvent[];

  constructor(initialSequenceNum: number = 0) {
    this.currentSequenceNum = initialSequenceNum;
    this.events = [];
  }

  public getSequence(): number {
    return this.currentSequenceNum;
  }

  public getAllEvents(): readonly ChangesStreamEvent[] {
    return this.events;
  }

  /**
   * Emits a new monotonic ChangesStreamEvent.
   */
  public emitEvent(params: EmitChangeEventParams): ChangesStreamEvent {
    this.currentSequenceNum++;
    const changeEventId = 'chg_' + randomBytes(16).toString('hex');
    const timestamp = params.event_timestamp ?? new Date().toISOString();

    const rawEvent = {
      change_event_id: changeEventId,
      change_sequence_num: this.currentSequenceNum,
      change_type: params.change_type,
      entity_id: params.entity_id,
      event_timestamp: timestamp,
      affected_revision: params.affected_revision,
    };

    const digest = computeStreamEventDigest(rawEvent);
    const event: ChangesStreamEvent = {
      ...rawEvent,
      event_digest_sha256: digest,
    };

    const validated = ChangesStreamEventSchema.parse(event);
    this.events.push(validated);
    return validated;
  }

  /**
   * Serializes recorded events as a Newline-Delimited JSON (NDJSON) string.
   */
  public serializeNdjson(sinceSequenceNum: number = 0): string {
    return this.events
      .filter((e) => e.change_sequence_num > sinceSequenceNum)
      .map((e) => JSON.stringify(e))
      .join('\n');
  }
}
