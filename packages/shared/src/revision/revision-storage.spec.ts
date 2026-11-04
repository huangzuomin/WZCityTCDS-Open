import {
  FactRevisionStorage,
  computeRevisionDigest,
  computeSnapshotDigest,
} from './revision-storage.js';
import {
  AssertionValue,
  FactRevisionLifecycle,
} from '../contracts/index.js';

export async function runRevisionStorageTestSuite(): Promise<{ passed: number; total: number; errors: string[] }> {
  const errors: string[] = [];
  let passed = 0;
  let total = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    total++;
    try {
      await fn();
      passed++;
    } catch (err: any) {
      errors.push(`[${name}]: ${err.message}`);
    }
  }

  const sampleValue: AssertionValue = {
    raw_value: 80.5,
    data_type: 'NUMBER',
    unit: '万人',
    temporal_validity: {
      statistical_period: '2025年度',
    },
    spatial_scope: {
      region_code: '330302',
      region_name: '鹿城区',
    },
  };

  const sampleValueUpdated: AssertionValue = {
    raw_value: 81.2,
    data_type: 'NUMBER',
    unit: '万人',
    temporal_validity: {
      statistical_period: '2026年度',
    },
    spatial_scope: {
      region_code: '330302',
      region_name: '鹿城区',
    },
  };

  // 1. createRevision - Genesis node
  let genesisRev: FactRevisionLifecycle | null = null;
  await test('createRevision - genesis node has GENESIS parent and rev_number 1', () => {
    const storage = new FactRevisionStorage();
    const rev = storage.createRevision({
      assertion_id: 'ast_wz_pop_lucheng_001',
      entity_id: 'ent_wz_lucheng_gov_001',
      property_path: 'demographics.permanent_population.total',
      assertion_value: sampleValue,
      created_by_role: 'FACT_EXTRACTOR',
      author_id: 'usr_extractor_01',
      revision_reason: 'INITIAL_PUBLISH',
      evidence_span_hashes: ['e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    });

    if (rev.revision_metadata.parent_revision_sha256 !== 'GENESIS') {
      throw new Error(`Expected GENESIS, got ${rev.revision_metadata.parent_revision_sha256}`);
    }
    if (rev.revision_number !== 1) {
      throw new Error(`Expected revision_number 1, got ${rev.revision_number}`);
    }
    if (rev.lifecycle_state !== 'DRAFT') {
      throw new Error(`Expected initial state DRAFT, got ${rev.lifecycle_state}`);
    }
    genesisRev = rev;
  });

  // 2. createRevision - Sequential Hash Chain Link
  let rev2: FactRevisionLifecycle | null = null;
  await test('createRevision - second revision cryptographically links to first digest', () => {
    const storage = new FactRevisionStorage();
    const r1 = storage.createRevision({
      assertion_id: 'ast_wz_pop_lucheng_001',
      entity_id: 'ent_wz_lucheng_gov_001',
      property_path: 'demographics.permanent_population.total',
      assertion_value: sampleValue,
      created_by_role: 'FACT_EXTRACTOR',
      revision_reason: 'INITIAL_PUBLISH',
      evidence_span_hashes: ['e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    });

    const r1Digest = computeRevisionDigest(r1);

    const r2 = storage.createRevision({
      assertion_id: 'ast_wz_pop_lucheng_001',
      entity_id: 'ent_wz_lucheng_gov_001',
      property_path: 'demographics.permanent_population.total',
      assertion_value: sampleValueUpdated,
      created_by_role: 'FACT_REVIEWER',
      revision_reason: 'STATISTICAL_UPDATE',
      evidence_span_hashes: ['a'.repeat(64)],
    });

    if (r2.revision_metadata.parent_revision_sha256 !== r1Digest) {
      throw new Error(`Expected parent ${r1Digest}, got ${r2.revision_metadata.parent_revision_sha256}`);
    }
    if (r2.revision_number !== 2) {
      throw new Error(`Expected revision_number 2, got ${r2.revision_number}`);
    }
    rev2 = r2;
  });

  // 3. validateChainIntegrity - Valid 3-node chain
  await test('validateChainIntegrity - validates clean 3-node hash chain', () => {
    const storage = new FactRevisionStorage();
    const aid = 'ast_wz_gdp_chain_001';

    storage.createRevision({
      assertion_id: aid,
      entity_id: 'ent_wz_lucheng_gov_001',
      property_path: 'economy.gdp.total',
      assertion_value: sampleValue,
      created_by_role: 'FACT_EXTRACTOR',
      revision_reason: 'INITIAL_PUBLISH',
      evidence_span_hashes: ['1'.repeat(64)],
    });

    storage.createRevision({
      assertion_id: aid,
      entity_id: 'ent_wz_lucheng_gov_001',
      property_path: 'economy.gdp.total',
      assertion_value: sampleValueUpdated,
      created_by_role: 'FACT_EXTRACTOR',
      revision_reason: 'STATISTICAL_UPDATE',
      evidence_span_hashes: ['2'.repeat(64)],
    });

    storage.createRevision({
      assertion_id: aid,
      entity_id: 'ent_wz_lucheng_gov_001',
      property_path: 'economy.gdp.total',
      assertion_value: { ...sampleValueUpdated, raw_value: 82.5 },
      created_by_role: 'FACT_REVIEWER',
      revision_reason: 'ERRATUM_CORRECTION',
      evidence_span_hashes: ['3'.repeat(64)],
    });

    const check = storage.validateChainIntegrity(aid);
    if (!check.isValid) {
      throw new Error(`Expected valid chain, got errors: ${check.errors.join('; ')}`);
    }
    if (check.chainLength !== 3) {
      throw new Error(`Expected chainLength 3, got ${check.chainLength}`);
    }
  });

  // 4. transitionState: DRAFT -> PENDING_REVIEW
  await test('transitionState - DRAFT to PENDING_REVIEW via SUBMIT_FOR_REVIEW', () => {
    const storage = new FactRevisionStorage();
    const r = storage.createRevision({
      assertion_id: 'ast_demo_20261104_001',
      entity_id: 'ent_wz_lucheng_gov_001',
      property_path: 'demographics.pop',
      assertion_value: sampleValue,
      created_by_role: 'FACT_EXTRACTOR',
      revision_reason: 'INITIAL_PUBLISH',
      evidence_span_hashes: ['1'.repeat(64)],
    });

    const res = storage.transitionState({
      revision_id: r.revision_id,
      trigger: 'SUBMIT_FOR_REVIEW',
      authorized_role: 'FACT_EXTRACTOR',
      operator_id: 'usr_ext_01',
    });

    if (res.revision.lifecycle_state !== 'PENDING_REVIEW') {
      throw new Error(`Expected PENDING_REVIEW, got ${res.revision.lifecycle_state}`);
    }
    if (res.transition.from_state !== 'DRAFT' || res.transition.to_state !== 'PENDING_REVIEW') {
      throw new Error(`Invalid transition record states`);
    }
  });

  // 5. transitionState: PENDING_REVIEW -> PUBLISHED
  await test('transitionState - PENDING_REVIEW to PUBLISHED via APPROVE_AND_PUBLISH', () => {
    const storage = new FactRevisionStorage();
    const r = storage.createRevision({
      assertion_id: 'ast_demo_20261104_002',
      entity_id: 'ent_wz_lucheng_gov_001',
      property_path: 'demographics.pop',
      assertion_value: sampleValue,
      created_by_role: 'FACT_EXTRACTOR',
      revision_reason: 'INITIAL_PUBLISH',
      evidence_span_hashes: ['1'.repeat(64)],
    });

    storage.transitionState({
      revision_id: r.revision_id,
      trigger: 'SUBMIT_FOR_REVIEW',
      authorized_role: 'FACT_EXTRACTOR',
    });

    const res = storage.transitionState({
      revision_id: r.revision_id,
      trigger: 'APPROVE_AND_PUBLISH',
      authorized_role: 'FACT_REVIEWER',
      operator_id: 'usr_reviewer_01',
    });

    if (res.revision.lifecycle_state !== 'PUBLISHED') {
      throw new Error(`Expected PUBLISHED, got ${res.revision.lifecycle_state}`);
    }
  });

  // 6. transitionState: PUBLISHED -> SUPERSEDED
  await test('transitionState - PUBLISHED to SUPERSEDED via SUPERSEDE_WITH_NEW_REVISION', () => {
    const storage = new FactRevisionStorage();
    const r1 = storage.createRevision({
      assertion_id: 'ast_demo_20261104_003',
      entity_id: 'ent_wz_lucheng_gov_001',
      property_path: 'demographics.pop',
      assertion_value: sampleValue,
      created_by_role: 'FACT_EXTRACTOR',
      revision_reason: 'INITIAL_PUBLISH',
      evidence_span_hashes: ['1'.repeat(64)],
    });

    storage.transitionState({
      revision_id: r1.revision_id,
      trigger: 'SUBMIT_FOR_REVIEW',
      authorized_role: 'FACT_EXTRACTOR',
    });
    storage.transitionState({
      revision_id: r1.revision_id,
      trigger: 'APPROVE_AND_PUBLISH',
      authorized_role: 'CHIEF_EDITOR',
    });

    const r2 = storage.createRevision({
      assertion_id: 'ast_demo_20261104_003',
      entity_id: 'ent_wz_lucheng_gov_001',
      property_path: 'demographics.pop',
      assertion_value: sampleValueUpdated,
      created_by_role: 'FACT_REVIEWER',
      revision_reason: 'STATISTICAL_UPDATE',
      evidence_span_hashes: ['2'.repeat(64)],
    });

    const res = storage.transitionState({
      revision_id: r1.revision_id,
      trigger: 'SUPERSEDE_WITH_NEW_REVISION',
      authorized_role: 'FACT_REVIEWER',
      superseded_by_revision_id: r2.revision_id,
    });

    if (res.revision.lifecycle_state !== 'SUPERSEDED') {
      throw new Error(`Expected SUPERSEDED, got ${res.revision.lifecycle_state}`);
    }
  });

  // 7. transitionState: PUBLISHED -> REVOKED
  await test('transitionState - PUBLISHED to REVOKED requires CHIEF_EDITOR and min 5-char reason', () => {
    const storage = new FactRevisionStorage();
    const r = storage.createRevision({
      assertion_id: 'ast_demo_20261104_004',
      entity_id: 'ent_wz_lucheng_gov_001',
      property_path: 'demographics.pop',
      assertion_value: sampleValue,
      created_by_role: 'FACT_EXTRACTOR',
      revision_reason: 'INITIAL_PUBLISH',
      evidence_span_hashes: ['1'.repeat(64)],
    });

    storage.transitionState({
      revision_id: r.revision_id,
      trigger: 'SUBMIT_FOR_REVIEW',
      authorized_role: 'FACT_EXTRACTOR',
    });
    storage.transitionState({
      revision_id: r.revision_id,
      trigger: 'APPROVE_AND_PUBLISH',
      authorized_role: 'CHIEF_EDITOR',
    });

    let rejectedForRole = false;
    try {
      storage.transitionState({
        revision_id: r.revision_id,
        trigger: 'REVOKE_PUBLISHED_FACT',
        authorized_role: 'FACT_EXTRACTOR', // unauthorized
        revocation_reason: '报道失实需要撤回',
      });
    } catch {
      rejectedForRole = true;
    }
    if (!rejectedForRole) throw new Error('Failed to reject unauthorized role on revocation');

    let rejectedForShortReason = false;
    try {
      storage.transitionState({
        revision_id: r.revision_id,
        trigger: 'REVOKE_PUBLISHED_FACT',
        authorized_role: 'CHIEF_EDITOR',
        revocation_reason: '短', // < 5 chars
      });
    } catch {
      rejectedForShortReason = true;
    }
    if (!rejectedForShortReason) throw new Error('Failed to reject short revocation reason');

    const res = storage.transitionState({
      revision_id: r.revision_id,
      trigger: 'REVOKE_PUBLISHED_FACT',
      authorized_role: 'CHIEF_EDITOR',
      operator_id: 'usr_chief_01',
      revocation_reason: '经核实信源撤稿，依据S2/S3规约正式执行事实撤销',
    });

    if (res.revision.lifecycle_state !== 'REVOKED') {
      throw new Error(`Expected REVOKED, got ${res.revision.lifecycle_state}`);
    }
  });

  // 8. Role Gate Enforcement
  await test('role gate - FACT_EXTRACTOR cannot APPROVE_AND_PUBLISH', () => {
    const storage = new FactRevisionStorage();
    const r = storage.createRevision({
      assertion_id: 'ast_demo_20261104_005',
      entity_id: 'ent_wz_lucheng_gov_001',
      property_path: 'demographics.pop',
      assertion_value: sampleValue,
      created_by_role: 'FACT_EXTRACTOR',
      revision_reason: 'INITIAL_PUBLISH',
      evidence_span_hashes: ['1'.repeat(64)],
      initial_state: 'PENDING_REVIEW',
    });

    let threw = false;
    try {
      storage.transitionState({
        revision_id: r.revision_id,
        trigger: 'APPROVE_AND_PUBLISH',
        authorized_role: 'FACT_EXTRACTOR',
      });
    } catch {
      threw = true;
    }
    if (!threw) throw new Error('Failed to enforce role gate on APPROVE_AND_PUBLISH');
  });

  // 9. generatePublicationSnapshot - aggregations & digests
  await test('generatePublicationSnapshot - aggregates published facts with canonical digest', () => {
    const storage = new FactRevisionStorage();
    const entityId = 'ent_wz_lucheng_gov_001';

    // Fact 1: Population
    const r1 = storage.createRevision({
      assertion_id: 'ast_wz_pop_20261104_001',
      entity_id: entityId,
      property_path: 'demographics.population',
      assertion_value: sampleValue,
      created_by_role: 'FACT_EXTRACTOR',
      revision_reason: 'INITIAL_PUBLISH',
      evidence_span_hashes: ['1'.repeat(64)],
      initial_state: 'PENDING_REVIEW',
    });
    storage.transitionState({
      revision_id: r1.revision_id,
      trigger: 'APPROVE_AND_PUBLISH',
      authorized_role: 'CHIEF_EDITOR',
    });

    // Fact 2: GDP
    const r2 = storage.createRevision({
      assertion_id: 'ast_wz_gdp_20261104_002',
      entity_id: entityId,
      property_path: 'economy.gdp',
      assertion_value: { raw_value: 1200.5, data_type: 'NUMBER', unit: '亿元' },
      created_by_role: 'FACT_EXTRACTOR',
      revision_reason: 'INITIAL_PUBLISH',
      evidence_span_hashes: ['2'.repeat(64)],
      initial_state: 'PENDING_REVIEW',
    });
    storage.transitionState({
      revision_id: r2.revision_id,
      trigger: 'APPROVE_AND_PUBLISH',
      authorized_role: 'CHIEF_EDITOR',
    });

    const snapshot = storage.generatePublicationSnapshot(entityId, {
      entity_canonical_name: '温州市鹿城区人民政府',
    });

    if (snapshot.published_assertions.length !== 2) {
      throw new Error(`Expected 2 published assertions, got ${snapshot.published_assertions.length}`);
    }
    if (!snapshot.snapshot_digest_sha256 || snapshot.snapshot_digest_sha256.length !== 64) {
      throw new Error(`Invalid snapshot_digest_sha256`);
    }
    if (!snapshot.projection_metadata.is_latest_snapshot) {
      throw new Error(`Expected is_latest_snapshot to be true`);
    }
  });

  // 10. Snapshot superseded flag update
  await test('generatePublicationSnapshot - updates previous snapshot is_latest_snapshot flag', () => {
    const storage = new FactRevisionStorage();
    const entityId = 'ent_wz_lucheng_gov_001';

    const r = storage.createRevision({
      assertion_id: 'ast_wz_metric_20261104_001',
      entity_id: entityId,
      property_path: 'metric.a',
      assertion_value: sampleValue,
      created_by_role: 'FACT_EXTRACTOR',
      revision_reason: 'INITIAL_PUBLISH',
      evidence_span_hashes: ['1'.repeat(64)],
      initial_state: 'PENDING_REVIEW',
    });
    storage.transitionState({
      revision_id: r.revision_id,
      trigger: 'APPROVE_AND_PUBLISH',
      authorized_role: 'CHIEF_EDITOR',
    });

    const snap1 = storage.generatePublicationSnapshot(entityId);
    if (!snap1.projection_metadata.is_latest_snapshot) throw new Error('Snap1 should be latest');

    const snap2 = storage.generatePublicationSnapshot(entityId);
    if (snap1.projection_metadata.is_latest_snapshot) throw new Error('Snap1 should now be superseded (false)');
    if (!snap2.projection_metadata.is_latest_snapshot) throw new Error('Snap2 should be latest (true)');
  });

  // 11. Snapshot fails on zero published facts
  await test('generatePublicationSnapshot - throws error when zero published assertions exist', () => {
    const storage = new FactRevisionStorage();
    let threw = false;
    try {
      storage.generatePublicationSnapshot('ent_wz_empty_001');
    } catch {
      threw = true;
    }
    if (!threw) throw new Error('Failed to throw on zero published facts');
  });

  // 12. Immutability guarantee
  await test('immutability - returned revisions are frozen/copied copies', () => {
    const storage = new FactRevisionStorage();
    const r = storage.createRevision({
      assertion_id: 'ast_freeze_20261104_001',
      entity_id: 'ent_wz_lucheng_gov_001',
      property_path: 'frozen.test',
      assertion_value: sampleValue,
      created_by_role: 'FACT_EXTRACTOR',
      revision_reason: 'INITIAL_PUBLISH',
      evidence_span_hashes: ['1'.repeat(64)],
    });

    // Mutating returned object
    r.property_path = 'hacked.path';
    const fetched = storage.getRevision(r.revision_id);
    if (fetched?.property_path !== 'frozen.test') {
      throw new Error(`In-place mutation leaked into storage! Expected frozen.test, got ${fetched?.property_path}`);
    }
  });

  // 13. Audit history query
  await test('getTransitions - retrieves full transition audit history', () => {
    const storage = new FactRevisionStorage();
    const r = storage.createRevision({
      assertion_id: 'ast_audit_20261104_001',
      entity_id: 'ent_wz_lucheng_gov_001',
      property_path: 'audit.path',
      assertion_value: sampleValue,
      created_by_role: 'FACT_EXTRACTOR',
      revision_reason: 'INITIAL_PUBLISH',
      evidence_span_hashes: ['1'.repeat(64)],
    });

    storage.transitionState({
      revision_id: r.revision_id,
      trigger: 'SUBMIT_FOR_REVIEW',
      authorized_role: 'FACT_EXTRACTOR',
    });
    storage.transitionState({
      revision_id: r.revision_id,
      trigger: 'APPROVE_AND_PUBLISH',
      authorized_role: 'CHIEF_EDITOR',
    });

    const history = storage.getTransitions(r.revision_id);
    if (history.length !== 2) {
      throw new Error(`Expected 2 transition history items, got ${history.length}`);
    }
    if (history[0].transition_trigger !== 'SUBMIT_FOR_REVIEW' || history[1].transition_trigger !== 'APPROVE_AND_PUBLISH') {
      throw new Error('Incorrect transition triggers in audit history');
    }
  });

  return { passed, total, errors };
}

// Self-executing runner when executed via node
if (typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].includes('revision-storage.spec')) {
  runRevisionStorageTestSuite().then((res) => {
    console.log(`\n=== FPF Slice C3 Fact Revision Storage Test Suite Results ===`);
    console.log(`Total checks: ${res.total}`);
    console.log(`Passed:       ${res.passed}`);
    console.log(`Failed:       ${res.errors.length}`);
    if (res.errors.length > 0) {
      console.error(`\nErrors:\n` + res.errors.join('\n'));
      process.exit(1);
    } else {
      console.log(`\nALL ${res.total} FACT REVISION STORAGE CHECKS PASSED!\n`);
    }
  });
}
