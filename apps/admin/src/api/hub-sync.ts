import http from './http';

export interface HubProjectionReceiptItem {
  receipt_id: string;
  projection_id: string;
  status: 'ACCEPTED' | 'REJECTED' | 'QUEUED';
  hub_slot_id?: string;
  acknowledged_at: string;
  rejection_reason?: string;
  receipt_signature_sha256: string;
}

export interface ProjectedEntityStateItem {
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

export interface HubSyncStats {
  projectorHistoryCount: number;
  processed: number;
  skippedDuplicates: number;
  deadLettersCount: number;
  projectedEntitiesCount: number;
  hubCursor: number;
  outletCursor: number;
}

export interface DeadLetterItem {
  line_number: number;
  raw_line: string;
  error_message: string;
  received_at: string;
}

function qs(params?: Record<string, unknown>): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (!entries.length) return '';
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

export const hubSyncApi = {
  project: (snapshot: unknown, options?: unknown) =>
    http.post<never, HubProjectionReceiptItem>('/hub-sync/project', { snapshot, options }),

  history: (entityId?: string) =>
    http.get<never, HubProjectionReceiptItem[]>(
      `/hub-sync/history${qs({ entityId })}`,
    ),

  latestReceipt: (entityId: string) =>
    http.get<never, HubProjectionReceiptItem | null>(
      `/hub-sync/history/${entityId}/latest`,
    ),

  consumeEvent: (event: unknown) =>
    http.post<never, { applied: boolean; reason?: string }>(
      '/hub-sync/consume/event',
      event,
    ),

  consumeOutletEvent: (event: unknown) =>
    http.post<never, { applied: boolean; reason?: string }>(
      '/hub-sync/consume/outlet-event',
      event,
    ),

  consumeNdjson: (stream: string, streamType?: 'HUB_UPSTREAM' | 'OUTLET_CHANGES') =>
    http.post<never, { totalLines: number; processed: number; skipped: number; deadLetters: number }>(
      '/hub-sync/consume/ndjson',
      { stream, streamType },
    ),

  entities: (params?: { category?: string; includeTombstoned?: boolean }) =>
    http.get<never, ProjectedEntityStateItem[]>(
      `/hub-sync/entities${qs(params as Record<string, unknown>)}`,
    ),

  entityDetail: (entityId: string) =>
    http.get<never, ProjectedEntityStateItem | null>(`/hub-sync/entities/${entityId}`),

  stats: () => http.get<never, HubSyncStats>('/hub-sync/stats'),

  deadLetters: () => http.get<never, DeadLetterItem[]>('/hub-sync/dead-letters'),
};
