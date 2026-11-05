import assert from 'node:assert';
import {
  HubOneWayProjector,
  MockHubProjectionTransport,
} from './hub-projector.js';
import {
  ChangesStreamConsumer,
  computeUpstreamChangeDigest,
} from './changes-consumer.js';
import {
  type PublicationSnapshot,
} from '../contracts/fact-revision.js';
import {
  type PublicationSecurityGatePolicy,
} from '../contracts/outlets.js';
import {
  type HubUpstreamChangeEvent,
} from '../contracts/hub-projection.js';

console.log('=== Running FPF Slice R3 Hub Projection & Changes Consumer Tests ===');

async function runTests() {
  const validEntityId = 'ent_wz_lucheng_gov_001';
  const mockSnapshot: PublicationSnapshot = {
    publication_id: 'pub_test_snapshot_001',
    snapshot_revision_id: 'pubrev_test_snapshot_rev_001',
    entity_id: validEntityId,
    entity_canonical_name: '温州市鹿城区人民政府',
    generated_at: '2026-11-05T01:00:00.000Z',
    snapshot_digest_sha256: 'a'.repeat(64),
    published_assertions: [
      {
        assertion_id: 'ast_population_001',
        revision_id: 'rev_ast_001',
        property_path: 'demographics.population',
        raw_value: 1200000,
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

  const passingGatePolicy: PublicationSecurityGatePolicy = {
    gate_evaluation_id: 'gate_eval_pass_001',
    snapshot_revision_id: mockSnapshot.snapshot_revision_id,
    evaluated_at: '2026-11-05T01:00:01.000Z',
    gate_verdict: 'PASS_APPROVED_FOR_RELEASE',
    rule_evaluations: {
      rule_only_published_state: { passed: true, non_published_count: 0 },
      rule_evidence_receipt_pass: { passed: true, unverified_assertion_count: 0 },
      rule_no_private_ip_leaks: { passed: true, detected_matches: [] },
      rule_no_credential_patterns: { passed: true, suspicious_token_count: 0 },
      rule_source_validity_confirmed: { passed: true, retracted_source_count: 0 },
    },
  };

  const failingGatePolicy: PublicationSecurityGatePolicy = {
    gate_evaluation_id: 'gate_eval_fail_002',
    snapshot_revision_id: mockSnapshot.snapshot_revision_id,
    evaluated_at: '2026-11-05T01:00:01.000Z',
    gate_verdict: 'FAIL_CLOSED_BLOCKED',
    rule_evaluations: {
      rule_only_published_state: { passed: true, non_published_count: 0 },
      rule_evidence_receipt_pass: { passed: false, unverified_assertion_count: 1 },
      rule_no_private_ip_leaks: { passed: true, detected_matches: [] },
      rule_no_credential_patterns: { passed: true, suspicious_token_count: 0 },
      rule_source_validity_confirmed: { passed: true, retracted_source_count: 0 },
    },
  };

  // Check 1: projectSnapshot generates valid HubProjectionPayload and returns signed receipt
  {
    const projector = new HubOneWayProjector();
    const receipt = await projector.projectSnapshot(mockSnapshot);
    assert.strictEqual(receipt.status, 'ACCEPTED');
    assert.ok(receipt.receipt_id.startsWith('rcpt_'));
    assert.ok(receipt.hub_slot_id?.startsWith('slot_'));
    assert.strictEqual(receipt.receipt_signature_sha256.length, 64);
    console.log('[PASS] Check 1: projectSnapshot generates valid payload and returns signed ACCEPTED receipt');
  }

  // Check 2: projectSnapshot rejects non-Hub entity ID format (fail-closed)
  {
    const projector = new HubOneWayProjector();
    const badSnapshot: PublicationSnapshot = {
      ...mockSnapshot,
      entity_id: 'invalid-non-hub-id',
    };
    await assert.rejects(
      async () => {
        await projector.projectSnapshot(badSnapshot);
      },
      /Invalid Hub entity_id format/
    );
    console.log('[PASS] Check 2: projectSnapshot rejects invalid non-Hub entity ID format');
  }

  // Check 3: projectSnapshot with failing security gate fails closed
  {
    const projector = new HubOneWayProjector();
    await assert.rejects(
      async () => {
        await projector.projectSnapshot(mockSnapshot, { gatePolicy: failingGatePolicy });
      },
      /Security gate fail-closed: publication cannot be projected to Hub/
    );
    console.log('[PASS] Check 3: projectSnapshot fails closed when publication security gate is not PASS');
  }

  // Check 4: projectSnapshot with passing security gate succeeds and saves history
  {
    const projector = new HubOneWayProjector();
    const receipt = await projector.projectSnapshot(mockSnapshot, { gatePolicy: passingGatePolicy });
    assert.strictEqual(receipt.status, 'ACCEPTED');
    const history = projector.getHistory(validEntityId);
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].receipt_id, receipt.receipt_id);
    console.log('[PASS] Check 4: projectSnapshot succeeds with passing security gate and records history');
  }

  // Check 5: projectSnapshot rejects empty assertions
  {
    const projector = new HubOneWayProjector();
    const emptySnapshot: PublicationSnapshot = {
      ...mockSnapshot,
      published_assertions: [] as any,
    };
    await assert.rejects(
      async () => {
        await projector.projectSnapshot(emptySnapshot);
      },
      /zero published assertions/
    );
    console.log('[PASS] Check 5: projectSnapshot rejects empty published assertions');
  }

  // Check 6: MockHubProjectionTransport with shouldFail=true produces REJECTED receipt
  {
    const transport = new MockHubProjectionTransport();
    transport.shouldFail = true;
    transport.failureReason = 'Simulated Hub downstream unavailable';
    const projector = new HubOneWayProjector(transport);
    const receipt = await projector.projectSnapshot(mockSnapshot);
    assert.strictEqual(receipt.status, 'REJECTED');
    assert.strictEqual(receipt.rejection_reason, 'Simulated Hub downstream unavailable');
    console.log('[PASS] Check 6: Mock transport with failure flag produces signed REJECTED receipt');
  }

  // Check 7: getLatestReceipt returns latest receipt
  {
    const projector = new HubOneWayProjector();
    await projector.projectSnapshot(mockSnapshot);
    const receipt2 = await projector.projectSnapshot(mockSnapshot);
    const latest = projector.getLatestReceipt(validEntityId);
    assert.strictEqual(latest?.receipt_id, receipt2.receipt_id);
    console.log('[PASS] Check 7: getLatestReceipt returns latest receipt for target entity');
  }

  // Check 8: ChangesStreamConsumer consumes ENTITY_CREATED and initializes ProjectedEntityState
  {
    const consumer = new ChangesStreamConsumer();
    const rawEvent = {
      hub_change_event_id: 'hchg_init_001_12345678',
      hub_sequence_num: 1,
      change_type: 'ENTITY_CREATED' as const,
      entity_id: validEntityId,
      canonical_name: '温州市鹿城区人民政府',
      aliases: ['鹿城区政府'],
      category: 'ADMIN_DIVISION' as const,
      spatial_coordinates: { longitude: 120.655, latitude: 28.016 },
      timestamp: '2026-11-05T01:10:00.000Z',
    };
    const digest = computeUpstreamChangeDigest(rawEvent);
    const event: HubUpstreamChangeEvent = { ...rawEvent, digest_sha256: digest };

    const res = consumer.consumeHubEvent(event);
    assert.strictEqual(res.applied, true);
    assert.strictEqual(consumer.getHubCursor(), 1);

    const state = consumer.getEntityState(validEntityId);
    assert.ok(state);
    assert.strictEqual(state.canonical_name, '温州市鹿城区人民政府');
    assert.strictEqual(state.category, 'ADMIN_DIVISION');
    assert.strictEqual(state.is_tombstoned, false);
    console.log('[PASS] Check 8: ChangesStreamConsumer consumes ENTITY_CREATED and initializes state');
  }

  // Check 9: ChangesStreamConsumer updates entity on ENTITY_UPDATED
  {
    const consumer = new ChangesStreamConsumer({ initialHubSeq: 1 });
    const rawInit = {
      hub_change_event_id: 'hchg_init_002_12345678',
      hub_sequence_num: 2,
      change_type: 'ENTITY_CREATED' as const,
      entity_id: validEntityId,
      canonical_name: '温州市鹿城区政府',
      aliases: ['鹿城区政府'],
      category: 'ADMIN_DIVISION' as const,
      timestamp: '2026-11-05T01:10:00.000Z',
    };
    consumer.consumeHubEvent({ ...rawInit, digest_sha256: computeUpstreamChangeDigest(rawInit) });

    const rawUpdate = {
      hub_change_event_id: 'hchg_upd_003_12345678',
      hub_sequence_num: 3,
      change_type: 'ENTITY_UPDATED' as const,
      entity_id: validEntityId,
      canonical_name: '温州市鹿城区人民政府 (正式)',
      aliases: ['鹿城区人民政府', '鹿城区政府'],
      category: 'ADMIN_DIVISION' as const,
      timestamp: '2026-11-05T01:15:00.000Z',
    };
    const updateEvent: HubUpstreamChangeEvent = { ...rawUpdate, digest_sha256: computeUpstreamChangeDigest(rawUpdate) };
    consumer.consumeHubEvent(updateEvent);

    const state = consumer.getEntityState(validEntityId);
    assert.strictEqual(state?.canonical_name, '温州市鹿城区人民政府 (正式)');
    assert.ok(state?.aliases.includes('鹿城区人民政府'));
    console.log('[PASS] Check 9: ChangesStreamConsumer updates metadata on ENTITY_UPDATED');
  }

  // Check 10: ChangesStreamConsumer applies MERGED_INTO and marks tombstoned
  {
    const consumer = new ChangesStreamConsumer();
    const sourceEntityId = 'ent_wz_old_poi_0099';
    const targetEntityId = 'ent_wz_new_poi_0100';

    const rawMerge = {
      hub_change_event_id: 'hchg_mrg_004_12345678',
      hub_sequence_num: 1,
      change_type: 'MERGED_INTO' as const,
      entity_id: sourceEntityId,
      canonical_name: '旧五马商厦',
      aliases: [],
      category: 'POI' as const,
      target_merged_entity_id: targetEntityId,
      timestamp: '2026-11-05T01:20:00.000Z',
    };
    const event: HubUpstreamChangeEvent = { ...rawMerge, digest_sha256: computeUpstreamChangeDigest(rawMerge) };
    consumer.consumeHubEvent(event);

    assert.strictEqual(consumer.isTombstoned(sourceEntityId), true);
    const state = consumer.getEntityState(sourceEntityId);
    assert.strictEqual(state?.merged_into_entity_id, targetEntityId);
    console.log('[PASS] Check 10: ChangesStreamConsumer marks entity tombstoned on MERGED_INTO');
  }

  // Check 11: ChangesStreamConsumer applies TOMBSTONED
  {
    const consumer = new ChangesStreamConsumer();
    const rawTombstone = {
      hub_change_event_id: 'hchg_tmb_005_12345678',
      hub_sequence_num: 1,
      change_type: 'TOMBSTONED' as const,
      entity_id: validEntityId,
      canonical_name: '温州市鹿城区人民政府',
      aliases: [],
      category: 'ADMIN_DIVISION' as const,
      tombstone_reason: 'Demolished or revoked by civil affairs office',
      timestamp: '2026-11-05T01:25:00.000Z',
    };
    consumer.consumeHubEvent({ ...rawTombstone, digest_sha256: computeUpstreamChangeDigest(rawTombstone) });
    assert.strictEqual(consumer.isTombstoned(validEntityId), true);
    const state = consumer.getEntityState(validEntityId);
    assert.strictEqual(state?.tombstone_reason, 'Demolished or revoked by civil affairs office');
    console.log('[PASS] Check 11: ChangesStreamConsumer records authoritative tombstone on TOMBSTONED');
  }

  // Check 12: ChangesStreamConsumer skips duplicate/stale sequence numbers idempotently
  {
    const consumer = new ChangesStreamConsumer({ initialHubSeq: 10 });
    const rawStale = {
      hub_change_event_id: 'hchg_stale_006_12345',
      hub_sequence_num: 8,
      change_type: 'ENTITY_CREATED' as const,
      entity_id: validEntityId,
      canonical_name: 'Stale Entity',
      aliases: [],
      category: 'POI' as const,
      timestamp: '2026-11-05T01:30:00.000Z',
    };
    const res = consumer.consumeHubEvent({ ...rawStale, digest_sha256: computeUpstreamChangeDigest(rawStale) });
    assert.strictEqual(res.applied, false);
    assert.ok(res.reason?.includes('Duplicate or stale'));
    assert.strictEqual(consumer.getStats().skippedDuplicates, 1);
    console.log('[PASS] Check 12: ChangesStreamConsumer skips stale sequence numbers idempotently');
  }

  // Check 13: ChangesStreamConsumer detects digest mismatch
  {
    const consumer = new ChangesStreamConsumer();
    const rawTampered = {
      hub_change_event_id: 'hchg_tamper_007_1234',
      hub_sequence_num: 1,
      change_type: 'ENTITY_CREATED' as const,
      entity_id: validEntityId,
      canonical_name: 'Tampered Entity',
      aliases: [],
      category: 'POI' as const,
      timestamp: '2026-11-05T01:35:00.000Z',
      digest_sha256: '0'.repeat(64),
    };
    assert.throws(
      () => consumer.consumeHubEvent(rawTampered as any),
      /Event digest mismatch/
    );
    console.log('[PASS] Check 13: ChangesStreamConsumer detects cryptographic digest mismatch');
  }

  // Check 14: ChangesStreamConsumer consumes outlet fact stream event
  {
    const consumer = new ChangesStreamConsumer();
    const res = consumer.consumeOutletEvent({
      change_event_id: 'chg_outlet_008_12345678',
      change_sequence_num: 1,
      change_type: 'FACT_PUBLISHED',
      entity_id: validEntityId,
      event_timestamp: '2026-11-05T01:40:00.000Z',
      event_digest_sha256: 'c'.repeat(64),
      affected_revision: {
        revision_id: 'rev_pop_001',
        property_path: 'demographics.population',
        lifecycle_state: 'PUBLISHED',
      },
    });
    assert.strictEqual(res.applied, true);
    const state = consumer.getEntityState(validEntityId);
    assert.strictEqual(state?.published_facts['demographics.population']?.revision_id, 'rev_pop_001');
    console.log('[PASS] Check 14: ChangesStreamConsumer integrates outlet fact stream events');
  }

  // Check 15: ChangesStreamConsumer parses NDJSON stream and tracks dead letters
  {
    const consumer = new ChangesStreamConsumer();
    const raw1 = {
      hub_change_event_id: 'hchg_line1_009_12345678',
      hub_sequence_num: 1,
      change_type: 'ENTITY_CREATED' as const,
      entity_id: 'ent_wz_first_poi_001',
      canonical_name: '首座地标',
      aliases: [],
      category: 'POI' as const,
      timestamp: '2026-11-05T01:45:00.000Z',
    };
    const line1 = JSON.stringify({ ...raw1, digest_sha256: computeUpstreamChangeDigest(raw1) });

    const raw2 = {
      hub_change_event_id: 'hchg_line2_010_12345678',
      hub_sequence_num: 2,
      change_type: 'ENTITY_CREATED' as const,
      entity_id: 'ent_wz_second_poi_002',
      canonical_name: '次座地标',
      aliases: [],
      category: 'POI' as const,
      timestamp: '2026-11-05T01:45:01.000Z',
    };
    const line2 = JSON.stringify({ ...raw2, digest_sha256: computeUpstreamChangeDigest(raw2) });

    const badLine = '{"bad_json": true, "corrupted';
    const ndjson = `${line1}\n\n${badLine}\n${line2}\n`;

    const summary = consumer.consumeNdjson(ndjson, 'HUB_UPSTREAM');
    assert.strictEqual(summary.processed, 2);
    assert.strictEqual(summary.deadLetters, 1);
    assert.strictEqual(consumer.getDeadLetters().length, 1);
    assert.ok(consumer.getEntityState('ent_wz_first_poi_001'));
    assert.ok(consumer.getEntityState('ent_wz_second_poi_002'));
    console.log('[PASS] Check 15: ChangesStreamConsumer parses NDJSON stream and records dead letters safely');
  }

  console.log('\n=== FPF Slice R3 Hub Projection & Changes Consumer Test Suite Results ===');
  console.log('Total checks: 15');
  console.log('Passed:       15');
  console.log('Failed:       0\n');
  console.log('ALL 15 HUB PROJECTION & CHANGES CONSUMER CHECKS PASSED!');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
