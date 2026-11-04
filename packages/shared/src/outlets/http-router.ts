import { PublicationSnapshot } from '../contracts/fact-revision.js';
import {
  PublicationSecurityGate,
  GateAssertionItem,
  GateEvidenceReceiptItem,
} from './security-gate.js';
import { OutletDeliveryProjector } from './outlet-projector.js';
import { ChangesStreamManager } from './changes-stream.js';
import { PublicationSecurityGatePolicy } from '../contracts/outlets.js';

export interface OutletsHttpRequest {
  method: string;
  path: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  body?: unknown;
}

export interface OutletsHttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface SnapshotRecord {
  snapshot: PublicationSnapshot;
  receipts: Record<string, GateEvidenceReceiptItem>;
  isRevoked?: boolean;
  revocationNotice?: string;
  revokedAt?: string;
  sourceDocIds?: Record<string, string[]>;
  lifecycleStates?: Record<string, string>;
}

export interface OutletsStore {
  getSnapshotRecordById(id: string): Promise<SnapshotRecord | null>;
  getSnapshotRecordByEntity(entityId: string): Promise<SnapshotRecord | null>;
  listPublicSnapshots(limit?: number): Promise<SnapshotRecord[]>;
  getChangesStreamManager(): Promise<ChangesStreamManager>;
  getRetractedSourceDocIds(): Promise<string[]>;
}

export class OutletsHttpRouter {
  private readonly gate: PublicationSecurityGate;
  private readonly projector: OutletDeliveryProjector;

  constructor(
    private readonly store: OutletsStore,
    options?: { baseUrl?: string }
  ) {
    this.gate = new PublicationSecurityGate();
    this.projector = new OutletDeliveryProjector({ defaultBaseUrl: options?.baseUrl });
  }

  public async handleRequest(req: OutletsHttpRequest): Promise<OutletsHttpResponse> {
    try {
      const method = (req.method || 'GET').toUpperCase();
      const rawPath = (req.path || '/').split('?')[0];
      const normalizedPath = rawPath.replace(/\/+$/, '') || '/';

      if (method === 'GET') {
        // 1. REST API Snapshot: /api/v1/outlets/snapshot/:id or /outlets/snapshot/:id
        const snapshotMatch = normalizedPath.match(/^(?:\/api\/v1)?\/outlets\/snapshot\/([^/]+)$/);
        if (snapshotMatch) {
          const snapshotId = decodeURIComponent(snapshotMatch[1]);
          return await this.handleGetSnapshot(snapshotId);
        }

        // 2. Public HTML Archive: /outlets/archive/:entity_id
        const archiveMatch = normalizedPath.match(/^\/outlets\/archive\/([^/]+)$/);
        if (archiveMatch) {
          const entityId = decodeURIComponent(archiveMatch[1]);
          return await this.handleGetArchive(entityId);
        }

        // 3. JSON-LD Card: /outlets/jsonld/:id
        const jsonldMatch = normalizedPath.match(/^\/outlets\/jsonld\/([^/]+)$/);
        if (jsonldMatch) {
          const snapshotId = decodeURIComponent(jsonldMatch[1]);
          return await this.handleGetJsonLd(snapshotId);
        }

        // 4. Atom Feed: /outlets/feed.atom or /feed.atom
        if (normalizedPath === '/outlets/feed.atom' || normalizedPath === '/feed.atom') {
          return await this.handleGetFeed();
        }

        // 5. XML Sitemap: /outlets/sitemap.xml or /sitemap.xml
        if (normalizedPath === '/outlets/sitemap.xml' || normalizedPath === '/sitemap.xml') {
          return await this.handleGetSitemap();
        }

        // 6. Changes Stream NDJSON: /outlets/changes.ndjson or /changes.ndjson
        if (normalizedPath === '/outlets/changes.ndjson' || normalizedPath === '/changes.ndjson') {
          const sinceSeqStr = req.query?.since_seq || req.query?.sinceSequenceNum;
          const sinceSeq = sinceSeqStr ? parseInt(sinceSeqStr, 10) : 0;
          return await this.handleGetChangesStream(sinceSeq);
        }
      }

      // 7. LLM MCP Endpoint: POST /outlets/mcp
      if (method === 'POST' && (normalizedPath === '/outlets/mcp' || normalizedPath === '/api/outlets/mcp')) {
        return await this.handleMcpInvocation(req.body);
      }

      // 404 Route Not Found
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          error: 'NOT_FOUND',
          message: `Route ${method} ${normalizedPath} not found in Outlets router`,
        }),
      };
    } catch (err: unknown) {
      // Fail-closed fallback: never leak internal stack traces or bypass gate
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        statusCode: 500,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify({
          error: 'INTERNAL_GATE_ROUTER_FAIL_CLOSED',
          message: 'Outlets router encountered unexpected error and failed closed.',
          detail: errorMsg,
        }),
      };
    }
  }

  private evaluateRecordGate(
    record: SnapshotRecord,
    retractedSourceDocIds: string[]
  ): PublicationSecurityGatePolicy {
    const assertions: GateAssertionItem[] = record.snapshot.published_assertions.map((a) => ({
      assertion_id: a.assertion_id,
      lifecycle_state: record.lifecycleStates?.[a.assertion_id] ?? 'PUBLISHED',
      raw_value: a.raw_value,
      evidence_hashes: a.evidence_hashes,
      source_doc_ids: record.sourceDocIds?.[a.assertion_id] ?? [],
    }));

    return this.gate.evaluate({
      snapshot_revision_id: record.snapshot.snapshot_revision_id,
      assertions,
      evidence_receipts: record.receipts,
      retracted_source_doc_ids: retractedSourceDocIds,
    });
  }

  private async handleGetSnapshot(snapshotId: string): Promise<OutletsHttpResponse> {
    const record = await this.store.getSnapshotRecordById(snapshotId);
    if (!record) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: 'SNAPSHOT_NOT_FOUND', snapshot_id: snapshotId }),
      };
    }

    if (record.isRevoked) {
      const tombstone = this.projector.projectTombstone({
        channel: 'REST_API_V1',
        publication_id: record.snapshot.publication_id,
        snapshot_revision_id: record.snapshot.snapshot_revision_id,
        entity_id: record.snapshot.entity_id,
        snapshot_digest_sha256: record.snapshot.snapshot_digest_sha256,
        revocation_notice: record.revocationNotice ?? 'Formal administrative retraction',
        revoked_at: record.revokedAt,
        http_status_code: 410,
      });

      return {
        statusCode: 410,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Fact-Revocation-Notice': 'REVOKED',
        },
        body: JSON.stringify(tombstone),
      };
    }

    const retractedSources = await this.store.getRetractedSourceDocIds();
    const policy = this.evaluateRecordGate(record, retractedSources);

    if (policy.gate_verdict !== 'PASS_APPROVED_FOR_RELEASE') {
      return {
        statusCode: 403,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify({
          error: 'PUBLICATION_SECURITY_GATE_BLOCKED',
          policy,
        }),
      };
    }

    const payload = this.projector.renderPayload(record.snapshot, 'REST_API_V1');
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        ETag: `"${record.snapshot.snapshot_digest_sha256}"`,
      },
      body: payload,
    };
  }

  private async handleGetArchive(entityId: string): Promise<OutletsHttpResponse> {
    const record = await this.store.getSnapshotRecordByEntity(entityId);
    if (!record) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: '<html><body><h1>404 Not Found</h1><p>Public archive item not found.</p></body></html>',
      };
    }

    if (record.isRevoked) {
      return {
        statusCode: 410,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Fact-Revocation-Notice': 'REVOKED',
        },
        body: `<!DOCTYPE html><html><head><title>410 Revoked</title></head><body><h1>410 Fact Revoked</h1><p>${record.revocationNotice ?? 'This fact record was formally revoked.'}</p><p>Entity ID: ${entityId}</p></body></html>`,
      };
    }

    const retractedSources = await this.store.getRetractedSourceDocIds();
    const policy = this.evaluateRecordGate(record, retractedSources);

    if (policy.gate_verdict !== 'PASS_APPROVED_FOR_RELEASE') {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        body: `<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body><h1>403 Publication Blocked</h1><p>Security Gate rejected publication: ${JSON.stringify(policy.rule_evaluations)}</p></body></html>`,
      };
    }

    const html = this.projector.renderPayload(record.snapshot, 'PUBLIC_HTML_ARCHIVE');
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
      body: html,
    };
  }

  private async handleGetJsonLd(snapshotId: string): Promise<OutletsHttpResponse> {
    const record = await this.store.getSnapshotRecordById(snapshotId);
    if (!record) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: 'SNAPSHOT_NOT_FOUND', snapshot_id: snapshotId }),
      };
    }

    if (record.isRevoked) {
      return {
        statusCode: 410,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ error: 'FACT_REVOKED_TOMBSTONE', snapshot_id: snapshotId }),
      };
    }

    const retractedSources = await this.store.getRetractedSourceDocIds();
    const policy = this.evaluateRecordGate(record, retractedSources);

    if (policy.gate_verdict !== 'PASS_APPROVED_FOR_RELEASE') {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ error: 'SECURITY_GATE_BLOCKED', policy }),
      };
    }

    const jsonld = this.projector.renderPayload(record.snapshot, 'JSON_LD_CARD');
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/ld+json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
      body: jsonld,
    };
  }

  private async handleGetFeed(): Promise<OutletsHttpResponse> {
    const snapshots = await this.store.listPublicSnapshots(50);
    const retractedSources = await this.store.getRetractedSourceDocIds();

    const approved = snapshots.filter((rec) => {
      if (rec.isRevoked) return false;
      const policy = this.evaluateRecordGate(rec, retractedSources);
      return policy.gate_verdict === 'PASS_APPROVED_FOR_RELEASE';
    });

    const entries = approved.map((rec) =>
      this.projector.renderPayload(rec.snapshot, 'FEED_ATOM_V1')
    );

    const feedXml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<feed xmlns="http://www.w3.org/2005/Atom">',
      '  <title>WZCityTCDS Public Fact Publications</title>',
      '  <id>urn:wzcitytcds:feed</id>',
      `  <updated>${new Date().toISOString()}</updated>`,
      ...entries,
      '</feed>',
    ].join('\n');

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/atom+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=600',
      },
      body: feedXml,
    };
  }

  private async handleGetSitemap(): Promise<OutletsHttpResponse> {
    const snapshots = await this.store.listPublicSnapshots(100);
    const retractedSources = await this.store.getRetractedSourceDocIds();

    const approved = snapshots.filter((rec) => {
      if (rec.isRevoked) return false;
      const policy = this.evaluateRecordGate(rec, retractedSources);
      return policy.gate_verdict === 'PASS_APPROVED_FOR_RELEASE';
    });

    const urls = approved.map((rec) =>
      this.projector.renderPayload(rec.snapshot, 'XML_SITEMAP')
    );

    const sitemapXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...urls,
      '</urlset>',
    ].join('\n');

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
      body: sitemapXml,
    };
  }

  private async handleGetChangesStream(sinceSeq: number): Promise<OutletsHttpResponse> {
    const streamManager = await this.store.getChangesStreamManager();
    const ndjson = streamManager.serializeNdjson(sinceSeq);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
      },
      body: ndjson,
    };
  }

  private async handleMcpInvocation(body: unknown): Promise<OutletsHttpResponse> {
    const payload = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const entityId = typeof payload.entity_id === 'string' ? payload.entity_id : undefined;

    const snapshots = await this.store.listPublicSnapshots(50);
    const retractedSources = await this.store.getRetractedSourceDocIds();

    const matched = snapshots.filter((rec) => {
      if (entityId && rec.snapshot.entity_id !== entityId) return false;
      if (rec.isRevoked) return false;
      const policy = this.evaluateRecordGate(rec, retractedSources);
      return policy.gate_verdict === 'PASS_APPROVED_FOR_RELEASE';
    });

    const results = matched.map((rec) => ({
      entity_id: rec.snapshot.entity_id,
      snapshot_revision_id: rec.snapshot.snapshot_revision_id,
      payload: JSON.parse(this.projector.renderPayload(rec.snapshot, 'LLM_MCP_ENDPOINT')),
    }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify({
        tool: 'query_facts',
        total_results: results.length,
        results,
      }),
    };
  }
}
