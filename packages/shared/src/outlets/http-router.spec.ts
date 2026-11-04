import assert from 'node:assert';
import { PublicationSnapshot } from '../contracts/fact-revision.js';
import { ChangesStreamManager } from './changes-stream.js';
import { OutletsHttpRouter, OutletsStore, SnapshotRecord } from './http-router.js';

function createMockSnapshot(overrides: Partial<PublicationSnapshot> = {}): PublicationSnapshot {
  return {
    publication_id: 'pub_wenzhou_gdp_20261104_001',
    snapshot_revision_id: 'pubrev_wenzhou_20261104_v1',
    entity_id: 'ent_wenzhou_330300',
    generated_at: '2026-11-04T10:00:00.000Z',
    snapshot_digest_sha256: 'a'.repeat(64),
    published_assertions: [
      {
        assertion_id: 'ast_gdp_annual_2026_wz',
        revision_id: 'rev_gdp_2026_v001',
        property_path: 'economy.gdp.annual',
        raw_value: 7120.5,
        evidence_hashes: ['b'.repeat(64)],
      },
    ],
    projection_metadata: {
      kernel_system: 'WZCityTCDS-PublicationKernel',
      publisher_role: 'CHIEF_FACT_EDITOR',
      outlet_scopes: ['PUBLIC_HTML_ARCHIVE', 'REST_API', 'FEED_ATOM', 'MCP_ENDPOINT'],
      is_latest_snapshot: true,
    },
    ...overrides,
  };
}

class MockOutletsStore implements OutletsStore {
  constructor(
    public recordsById: Map<string, SnapshotRecord>,
    public streamManager: ChangesStreamManager,
    public retractedSources: string[] = []
  ) {}

  async getSnapshotRecordById(id: string): Promise<SnapshotRecord | null> {
    return this.recordsById.get(id) || null;
  }

  async getSnapshotRecordByEntity(entityId: string): Promise<SnapshotRecord | null> {
    for (const rec of this.recordsById.values()) {
      if (rec.snapshot.entity_id === entityId) {
        return rec;
      }
    }
    return null;
  }

  async listPublicSnapshots(limit: number = 50): Promise<SnapshotRecord[]> {
    return Array.from(this.recordsById.values()).slice(0, limit);
  }

  async getChangesStreamManager(): Promise<ChangesStreamManager> {
    return this.streamManager;
  }

  async getRetractedSourceDocIds(): Promise<string[]> {
    return this.retractedSources;
  }
}

async function runTestSuite() {
  console.log('=== Running FPF Slice R1 Outlets HTTP Router Tests ===');
  let passed = 0;
  let total = 0;

  const validSnap = createMockSnapshot();
  const validRecord: SnapshotRecord = {
    snapshot: validSnap,
    receipts: {
      ast_gdp_annual_2026_wz: { overall_verification_verdict: 'PASS' },
    },
    sourceDocIds: {
      ast_gdp_annual_2026_wz: ['news_valid_doc_001'],
    },
  };

  const revokedSnap = createMockSnapshot({
    publication_id: 'pub_lucheng_revoked_01',
    snapshot_revision_id: 'pubrev_lucheng_revoked_01',
    entity_id: 'ent_wz_lucheng_revoked',
  });
  const revokedRecord: SnapshotRecord = {
    snapshot: revokedSnap,
    receipts: {
      ast_gdp_annual_2026_wz: { overall_verification_verdict: 'PASS' },
    },
    isRevoked: true,
    revocationNotice: 'Administrative policy retraction #410',
    revokedAt: '2026-11-04T12:00:00.000Z',
  };

  const leakSnap = createMockSnapshot({
    publication_id: 'pub_lucheng_leak_01',
    snapshot_revision_id: 'pubrev_lucheng_leak_01',
    entity_id: 'ent_wz_lucheng_leak',
    published_assertions: [
      {
        assertion_id: 'ast_leak_001',
        revision_id: 'rev_leak_001',
        property_path: 'internal.server',
        evidence_hashes: ['b'.repeat(64)],
        raw_value: '192.168.1.100 internal host',
      },
    ],
  });
  const leakRecord: SnapshotRecord = {
    snapshot: leakSnap,
    receipts: {
      ast_leak_001: { overall_verification_verdict: 'PASS' },
    },
  };

  const stream = new ChangesStreamManager();
  stream.emitEvent({
    change_type: 'FACT_PUBLISHED',
    entity_id: validSnap.entity_id,
    affected_revision: {
      revision_id: 'rev_gdp_2026_v001',
      property_path: 'economy.gdp.annual',
      lifecycle_state: 'PUBLISHED',
      publication_snapshot_id: validSnap.snapshot_revision_id,
    },
  });
  stream.emitEvent({
    change_type: 'FACT_CORRECTED',
    entity_id: validSnap.entity_id,
    affected_revision: {
      revision_id: 'rev_gdp_2026_v002',
      property_path: 'economy.gdp.annual',
      lifecycle_state: 'PUBLISHED',
      previous_revision_id: 'rev_gdp_2026_v001',
      publication_snapshot_id: validSnap.snapshot_revision_id,
    },
  });

  const recordMap = new Map<string, SnapshotRecord>([
    [validSnap.snapshot_revision_id, validRecord],
    [revokedSnap.snapshot_revision_id, revokedRecord],
    [leakSnap.snapshot_revision_id, leakRecord],
  ]);

  const store = new MockOutletsStore(recordMap, stream);
  const router = new OutletsHttpRouter(store);

  // Check 1: GET /api/v1/outlets/snapshot/:id returns 200 OK with REST_API_V1 payload
  total++;
  const res1 = await router.handleRequest({ method: 'GET', path: `/api/v1/outlets/snapshot/${validSnap.snapshot_revision_id}` });
  assert.strictEqual(res1.statusCode, 200);
  assert.ok(res1.headers['Content-Type'].includes('application/json'));
  assert.ok(res1.headers['Cache-Control'].includes('public'));
  const body1 = JSON.parse(res1.body);
  assert.strictEqual(body1.snapshot_revision_id, validSnap.snapshot_revision_id);
  assert.strictEqual(body1.entity_id, validSnap.entity_id);
  console.log('[PASS] Check 1: GET /outlets/snapshot/:id returns 200 OK with REST_API_V1 payload');
  passed++;

  // Check 2: GET /outlets/snapshot/:id returns 410 Gone for REVOKED snapshot
  total++;
  const res2 = await router.handleRequest({ method: 'GET', path: `/outlets/snapshot/${revokedSnap.snapshot_revision_id}` });
  assert.strictEqual(res2.statusCode, 410);
  assert.strictEqual(res2.headers['Cache-Control'], 'no-store');
  assert.strictEqual(res2.headers['X-Fact-Revocation-Notice'], 'REVOKED');
  const body2 = JSON.parse(res2.body);
  assert.strictEqual(body2.delivery_status, 'REVOKED_TOMBSTONE');
  assert.strictEqual(body2.tombstone_details.http_status_code, 410);
  console.log('[PASS] Check 2: GET /outlets/snapshot/:id returns 410 Gone with REVOKED_TOMBSTONE');
  passed++;

  // Check 3: GET /outlets/snapshot/:id returns 403 Forbidden when security gate fails (Private IP leak)
  total++;
  const res3 = await router.handleRequest({ method: 'GET', path: `/outlets/snapshot/${leakSnap.snapshot_revision_id}` });
  assert.strictEqual(res3.statusCode, 403);
  const body3 = JSON.parse(res3.body);
  assert.strictEqual(body3.error, 'PUBLICATION_SECURITY_GATE_BLOCKED');
  assert.strictEqual(body3.policy.rule_evaluations.rule_no_private_ip_leaks.passed, false);
  console.log('[PASS] Check 3: GET /outlets/snapshot/:id returns 403 Forbidden on security gate private IP leak');
  passed++;

  // Check 4: GET /outlets/snapshot/:id returns 404 for non-existent snapshot
  total++;
  const res4 = await router.handleRequest({ method: 'GET', path: '/outlets/snapshot/non_existent_999' });
  assert.strictEqual(res4.statusCode, 404);
  console.log('[PASS] Check 4: GET /outlets/snapshot/:id returns 404 when not found');
  passed++;

  // Check 5: GET /outlets/archive/:entity_id returns 200 HTML
  total++;
  const res5 = await router.handleRequest({ method: 'GET', path: `/outlets/archive/${validSnap.entity_id}` });
  assert.strictEqual(res5.statusCode, 200);
  assert.ok(res5.headers['Content-Type'].includes('text/html'));
  assert.ok(res5.body.includes('<!DOCTYPE html>'));
  assert.ok(res5.body.includes(validSnap.entity_id));
  console.log('[PASS] Check 5: GET /outlets/archive/:entity_id returns 200 with HTML archive page');
  passed++;

  // Check 6: GET /outlets/archive/:entity_id returns 410 HTML for REVOKED
  total++;
  const res6 = await router.handleRequest({ method: 'GET', path: `/outlets/archive/${revokedSnap.entity_id}` });
  assert.strictEqual(res6.statusCode, 410);
  assert.ok(res6.body.includes('410 Fact Revoked'));
  console.log('[PASS] Check 6: GET /outlets/archive/:entity_id returns 410 HTML tombstone when revoked');
  passed++;

  // Check 7: GET /outlets/archive/:entity_id returns 403 HTML when gate fails
  total++;
  const res7 = await router.handleRequest({ method: 'GET', path: `/outlets/archive/${leakSnap.entity_id}` });
  assert.strictEqual(res7.statusCode, 403);
  assert.ok(res7.body.includes('403 Publication Blocked'));
  console.log('[PASS] Check 7: GET /outlets/archive/:entity_id returns 403 HTML when gate fails');
  passed++;

  // Check 8: GET /outlets/archive/:entity_id returns 404 HTML when not found
  total++;
  const res8 = await router.handleRequest({ method: 'GET', path: '/outlets/archive/non_existent_entity' });
  assert.strictEqual(res8.statusCode, 404);
  assert.ok(res8.body.includes('404 Not Found'));
  console.log('[PASS] Check 8: GET /outlets/archive/:entity_id returns 404 HTML when not found');
  passed++;

  // Check 9: GET /outlets/jsonld/:id returns 200 with JSON-LD
  total++;
  const res9 = await router.handleRequest({ method: 'GET', path: `/outlets/jsonld/${validSnap.snapshot_revision_id}` });
  assert.strictEqual(res9.statusCode, 200);
  assert.ok(res9.headers['Content-Type'].includes('application/ld+json'));
  const body9 = JSON.parse(res9.body);
  assert.strictEqual(body9['@context'], 'https://schema.org');
  assert.strictEqual(body9['@type'], 'City');
  console.log('[PASS] Check 9: GET /outlets/jsonld/:id returns 200 OK with Schema.org JSON-LD');
  passed++;

  // Check 10: GET /outlets/feed.atom returns 200 with Atom XML
  total++;
  const res10 = await router.handleRequest({ method: 'GET', path: '/outlets/feed.atom' });
  assert.strictEqual(res10.statusCode, 200);
  assert.ok(res10.headers['Content-Type'].includes('application/atom+xml'));
  assert.ok(res10.body.includes('<feed xmlns="http://www.w3.org/2005/Atom">'));
  assert.ok(res10.body.includes('<entry'));
  console.log('[PASS] Check 10: GET /outlets/feed.atom returns 200 OK with Atom XML feed');
  passed++;

  // Check 11: GET /outlets/sitemap.xml returns 200 with XML Sitemap
  total++;
  const res11 = await router.handleRequest({ method: 'GET', path: '/outlets/sitemap.xml' });
  assert.strictEqual(res11.statusCode, 200);
  assert.ok(res11.headers['Content-Type'].includes('application/xml'));
  assert.ok(res11.body.includes('<urlset'));
  assert.ok(res11.body.includes('<loc>'));
  console.log('[PASS] Check 11: GET /outlets/sitemap.xml returns 200 OK with XML Sitemap');
  passed++;

  // Check 12: GET /outlets/changes.ndjson returns 200 with NDJSON stream and respects since_seq
  total++;
  const res12 = await router.handleRequest({
    method: 'GET',
    path: '/outlets/changes.ndjson',
    query: { since_seq: '1' },
  });
  assert.strictEqual(res12.statusCode, 200);
  assert.ok(res12.headers['Content-Type'].includes('application/x-ndjson'));
  const lines = res12.body.trim().split('\n');
  assert.strictEqual(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.strictEqual(event.change_sequence_num, 2);
  console.log('[PASS] Check 12: GET /outlets/changes.ndjson returns 200 OK and filters by since_seq');
  passed++;

  // Check 13: POST /outlets/mcp returns 200 with query_facts tool response
  total++;
  const res13 = await router.handleRequest({
    method: 'POST',
    path: '/outlets/mcp',
    body: { entity_id: validSnap.entity_id },
  });
  assert.strictEqual(res13.statusCode, 200);
  const body13 = JSON.parse(res13.body);
  assert.strictEqual(body13.tool, 'query_facts');
  assert.strictEqual(body13.total_results, 1);
  assert.strictEqual(body13.results[0].entity_id, validSnap.entity_id);
  console.log('[PASS] Check 13: POST /outlets/mcp returns 200 OK with projected MCP facts');
  passed++;

  // Check 14: Unknown route returns 404, error in store returns 500 Fail-Closed
  total++;
  const res14a = await router.handleRequest({ method: 'GET', path: '/unknown/random/path' });
  assert.strictEqual(res14a.statusCode, 404);

  const brokenStore: OutletsStore = {
    async getSnapshotRecordById() {
      throw new Error('Database connection explosion');
    },
    async getSnapshotRecordByEntity() {
      throw new Error('Database connection explosion');
    },
    async listPublicSnapshots() {
      throw new Error('Database connection explosion');
    },
    async getChangesStreamManager() {
      throw new Error('Database connection explosion');
    },
    async getRetractedSourceDocIds() {
      throw new Error('Database connection explosion');
    },
  };
  const brokenRouter = new OutletsHttpRouter(brokenStore);
  const res14b = await brokenRouter.handleRequest({ method: 'GET', path: '/outlets/snapshot/test' });
  assert.strictEqual(res14b.statusCode, 500);
  const body14b = JSON.parse(res14b.body);
  assert.strictEqual(body14b.error, 'INTERNAL_GATE_ROUTER_FAIL_CLOSED');
  console.log('[PASS] Check 14: 404 on unknown route and 500 Fail-Closed on store failure');
  passed++;

  console.log('\n=== FPF Slice R1 Outlets Test Suite Results ===');
  console.log(`Total checks: ${total}`);
  console.log(`Passed:       ${passed}`);
  console.log(`Failed:       ${total - passed}`);

  if (passed === total) {
    console.log('\nALL 14 OUTLETS HTTP ROUTER CHECKS PASSED!\n');
  } else {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error(err);
  process.exit(1);
});
