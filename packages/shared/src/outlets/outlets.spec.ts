import assert from 'node:assert';
import {
  PublicationSecurityGate,
  type GateAssertionItem,
} from './security-gate.js';
import {
  OutletDeliveryProjector,
} from './outlet-projector.js';
import {
  ChangesStreamManager,
} from './changes-stream.js';
import {
  type PublicationSnapshot,
} from '../contracts/fact-revision.js';

let passed = 0;
let total = 0;

function check(desc: string, fn: () => void) {
  total++;
  try {
    fn();
    passed++;
    console.log('[PASS] Check ' + total + ': ' + desc);
  } catch (err) {
    console.error('[FAIL] Check ' + total + ': ' + desc);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log('=== Running FPF Slice C5 Outlets & Publication Security Gate Tests ===');

const gate = new PublicationSecurityGate();
const projector = new OutletDeliveryProjector({ defaultBaseUrl: 'https://facts.wenzhou.gov.cn' });
const streamManager = new ChangesStreamManager();

const validSnapshot: PublicationSnapshot = {
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
    outlet_scopes: ['HUB_ONE_WAY_PROJECTION'],
    is_latest_snapshot: true,
  },
};

const validAssertions: GateAssertionItem[] = [
  {
    assertion_id: 'ast_gdp_annual_2026_wz',
    lifecycle_state: 'PUBLISHED',
    evidence_hashes: ['b'.repeat(64)],
    raw_value: 7120.5,
    source_doc_ids: ['news_valid_doc_001'],
  },
];

const validReceipts = {
  ast_gdp_annual_2026_wz: { overall_verification_verdict: 'PASS' },
};

// Check 1: Gate approves clean, valid snapshot
check('evaluate approves clean snapshot when all 5 gate rules pass', () => {
  const policy = gate.evaluate({
    snapshot_revision_id: validSnapshot.snapshot_revision_id,
    assertions: validAssertions,
    evidence_receipts: validReceipts,
  });
  assert.strictEqual(policy.gate_verdict, 'PASS_APPROVED_FOR_RELEASE');
  assert.strictEqual(policy.rule_evaluations.rule_only_published_state.passed, true);
  assert.strictEqual(policy.rule_evaluations.rule_evidence_receipt_pass.passed, true);
  assert.strictEqual(policy.rule_evaluations.rule_no_private_ip_leaks.passed, true);
  assert.strictEqual(policy.rule_evaluations.rule_no_credential_patterns.passed, true);
  assert.strictEqual(policy.rule_evaluations.rule_source_validity_confirmed.passed, true);
});

// Check 2: Gate blocks non-published assertions (Rule 1)
check('evaluate blocks candidate if any assertion is not in PUBLISHED state', () => {
  const nonPublishedAssertions: GateAssertionItem[] = [
    {
      assertion_id: 'ast_draft_01',
      lifecycle_state: 'DRAFT',
      source_doc_ids: ['doc_1'],
    },
  ];
  const policy = gate.evaluate({
    snapshot_revision_id: validSnapshot.snapshot_revision_id,
    assertions: nonPublishedAssertions,
    evidence_receipts: validReceipts,
  });
  assert.strictEqual(policy.gate_verdict, 'FAIL_CLOSED_BLOCKED');
  assert.strictEqual(policy.rule_evaluations.rule_only_published_state.passed, false);
  assert.strictEqual(policy.rule_evaluations.rule_only_published_state.non_published_count, 1);
});

// Check 3: Gate blocks unverified assertions (Rule 2)
check('evaluate blocks candidate if evidence receipt is missing or failed', () => {
  const policy = gate.evaluate({
    snapshot_revision_id: validSnapshot.snapshot_revision_id,
    assertions: validAssertions,
    evidence_receipts: {}, // missing receipt
  });
  assert.strictEqual(policy.gate_verdict, 'FAIL_CLOSED_BLOCKED');
  assert.strictEqual(policy.rule_evaluations.rule_evidence_receipt_pass.passed, false);
  assert.strictEqual(policy.rule_evaluations.rule_evidence_receipt_pass.unverified_assertion_count, 1);
});

// Check 4: Gate detects private IP and internal hostname leaks (Rule 3)
check('evaluate blocks candidate if private IP or internal hostname is leaked', () => {
  const leakedText = 'Internal database endpoint: 192.168.214.53 and server.database.local';
  const policy = gate.evaluate({
    snapshot_revision_id: validSnapshot.snapshot_revision_id,
    assertions: validAssertions,
    evidence_receipts: validReceipts,
    raw_payload_text: leakedText,
  });
  assert.strictEqual(policy.gate_verdict, 'FAIL_CLOSED_BLOCKED');
  assert.strictEqual(policy.rule_evaluations.rule_no_private_ip_leaks.passed, false);
  assert.ok(policy.rule_evaluations.rule_no_private_ip_leaks.detected_matches.includes('192.168.214.53'));
  assert.ok(policy.rule_evaluations.rule_no_private_ip_leaks.detected_matches.includes('server.database.local'));
});

// Check 5: Gate detects credential patterns (Rule 4)
check('evaluate blocks candidate if API keys or private tokens are leaked', () => {
  const secretText = 'Authorization header: Bearer sk-live12345678901234567890abcdef and ghp_' + 'x'.repeat(36);
  const policy = gate.evaluate({
    snapshot_revision_id: validSnapshot.snapshot_revision_id,
    assertions: validAssertions,
    evidence_receipts: validReceipts,
    raw_payload_text: secretText,
  });
  assert.strictEqual(policy.gate_verdict, 'FAIL_CLOSED_BLOCKED');
  assert.strictEqual(policy.rule_evaluations.rule_no_credential_patterns.passed, false);
  assert.strictEqual(policy.rule_evaluations.rule_no_credential_patterns.suspicious_token_count, 2);
});

// Check 6: Gate blocks retracted source documents (Rule 5)
check('evaluate blocks candidate if supporting evidence belongs to a retracted source', () => {
  const policy = gate.evaluate({
    snapshot_revision_id: validSnapshot.snapshot_revision_id,
    assertions: validAssertions,
    evidence_receipts: validReceipts,
    retracted_source_doc_ids: ['news_valid_doc_001'],
  });
  assert.strictEqual(policy.gate_verdict, 'FAIL_CLOSED_BLOCKED');
  assert.strictEqual(policy.rule_evaluations.rule_source_validity_confirmed.passed, false);
  assert.strictEqual(policy.rule_evaluations.rule_source_validity_confirmed.retracted_source_count, 1);
});

// Check 7: Fail-Closed fallback generates valid schema record on error
check('evaluate safely falls closed and produces valid blocked schema record on malformed params', () => {
  const policy = gate.evaluate({
    snapshot_revision_id: 'pubrev_malformed_001',
    assertions: null as unknown as GateAssertionItem[],
    evidence_receipts: validReceipts,
  });
  assert.strictEqual(policy.gate_verdict, 'FAIL_CLOSED_BLOCKED');
});

// Check 8: Projector projects to PUBLIC_HTML_ARCHIVE
check('projectSnapshot maps snapshot to PUBLIC_HTML_ARCHIVE with HTML format and cache header', () => {
  const delivery = projector.projectSnapshot(validSnapshot, { channel: 'PUBLIC_HTML_ARCHIVE' });
  assert.strictEqual(delivery.outlet_channel, 'PUBLIC_HTML_ARCHIVE');
  assert.strictEqual(delivery.payload_format, 'HTML');
  assert.strictEqual(delivery.delivery_status, 'ACTIVE_CURRENT');
  assert.strictEqual(delivery.cache_control?.cache_policy, 'PUBLIC_REVALIDATE');
  assert.strictEqual(delivery.cache_control?.max_age_seconds, 3600);
});

// Check 9: Projector projects to REST_API_V1 and LLM_MCP_ENDPOINT
check('projectSnapshot maps snapshot to REST_API_V1 and LLM_MCP_ENDPOINT with JSON format', () => {
  const apiDelivery = projector.projectSnapshot(validSnapshot, { channel: 'REST_API_V1' });
  const mcpDelivery = projector.projectSnapshot(validSnapshot, { channel: 'LLM_MCP_ENDPOINT' });
  assert.strictEqual(apiDelivery.payload_format, 'JSON');
  assert.strictEqual(mcpDelivery.payload_format, 'JSON');
  assert.strictEqual(apiDelivery.entity_id, validSnapshot.entity_id);
});

// Check 10: Projector sets SUPERSEDED_HISTORICAL with PUBLIC_IMMUTABLE cache
check('projectSnapshot marks superseded snapshots with SUPERSEDED_HISTORICAL and PUBLIC_IMMUTABLE', () => {
  const delivery = projector.projectSnapshot(validSnapshot, {
    channel: 'REST_API_V1',
    isSuperseded: true,
  });
  assert.strictEqual(delivery.delivery_status, 'SUPERSEDED_HISTORICAL');
  assert.strictEqual(delivery.cache_control?.cache_policy, 'PUBLIC_IMMUTABLE');
});

// Check 11: Projector produces Tombstone with HTTP 410 and NO_STORE
check('projectTombstone produces REVOKED_TOMBSTONE record with HTTP 410 Gone status', () => {
  const tombstone = projector.projectTombstone({
    channel: 'REST_API_V1',
    publication_id: validSnapshot.publication_id,
    snapshot_revision_id: validSnapshot.snapshot_revision_id,
    entity_id: validSnapshot.entity_id,
    snapshot_digest_sha256: validSnapshot.snapshot_digest_sha256,
    revocation_notice: 'Official fact revoked following source newspaper retraction.',
  });
  assert.strictEqual(tombstone.delivery_status, 'REVOKED_TOMBSTONE');
  assert.strictEqual(tombstone.tombstone_details?.http_status_code, 410);
  assert.strictEqual(tombstone.cache_control?.cache_policy, 'NO_STORE');
});

// Check 12: Projector renders valid JSON-LD structure
check('renderPayload generates valid Schema.org JSON-LD structure', () => {
  const jsonLd = projector.renderPayload(validSnapshot, 'JSON_LD_CARD');
  const parsed = JSON.parse(jsonLd);
  assert.strictEqual(parsed['@context'], 'https://schema.org');
  assert.strictEqual(parsed['@type'], 'City');
  assert.strictEqual(parsed.subjectOf.version, validSnapshot.snapshot_revision_id);
});

// Check 13: ChangesStreamManager emits monotonic events with valid SHA-256
check('ChangesStreamManager emits monotonic sequence numbers and computes event SHA-256', () => {
  const evt1 = streamManager.emitEvent({
    change_type: 'FACT_PUBLISHED',
    entity_id: 'ent_wenzhou_330300',
    affected_revision: {
      revision_id: 'rev_gdp_2026_v001',
      property_path: 'economy.gdp.annual',
      lifecycle_state: 'PUBLISHED',
    },
  });
  const evt2 = streamManager.emitEvent({
    change_type: 'FACT_CORRECTED',
    entity_id: 'ent_wenzhou_330300',
    affected_revision: {
      revision_id: 'rev_gdp_2026_v002',
      property_path: 'economy.gdp.annual',
      lifecycle_state: 'PUBLISHED',
      previous_revision_id: 'rev_gdp_2026_v001',
    },
  });
  assert.strictEqual(evt1.change_sequence_num, 1);
  assert.strictEqual(evt2.change_sequence_num, 2);
  assert.strictEqual(evt1.event_digest_sha256.length, 64);
  assert.strictEqual(evt2.event_digest_sha256.length, 64);
});

// Check 14: ChangesStreamManager serializes NDJSON correctly
check('serializeNdjson generates valid newline-delimited JSON stream', () => {
  const ndjson = streamManager.serializeNdjson();
  const lines = ndjson.trim().split('\n');
  assert.strictEqual(lines.length, 2);
  const parsedLine1 = JSON.parse(lines[0]);
  assert.strictEqual(parsedLine1.change_sequence_num, 1);
  assert.strictEqual(parsedLine1.change_type, 'FACT_PUBLISHED');
});

console.log('\n=== FPF Slice C5 Outlets Test Suite Results ===');
console.log('Total checks: ' + total);
console.log('Passed:       ' + passed);
console.log('Failed:       ' + (total - passed));

if (passed === total) {
  console.log('\nALL 14 OUTLETS & SECURITY GATE CHECKS PASSED!\n');
} else {
  process.exit(1);
}
