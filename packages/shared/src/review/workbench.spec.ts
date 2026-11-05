import assert from 'node:assert';
import {
  ReviewWorkbenchManager,
  InMemoryReviewStore,
  type CandidateAssertion,
} from './workbench.js';
import { computeSpanHash } from '../evidence/evidence-engine.js';
import type { EvidenceSpan } from '../contracts/evidence.js';

console.log('=== Running FPF Slice R2 Review Workbench Tests ===');
let checksPassed = 0;

function pass(msg: string) {
  checksPassed++;
  console.log(`[PASS] Check ${checksPassed}: ${msg}`);
}

async function runTests() {
  const store = new InMemoryReviewStore();
  const manager = new ReviewWorkbenchManager(store);

  const sampleText = '温州市2025年全市常住人口为967.9万人，比上年末增加3.2万人。';
  const spanHash = computeSpanHash(sampleText);

  const sampleSpan: EvidenceSpan = {
    span_id: 'span_review_test_01',
    source_doc_id: 'doc_stat_2025_001',
    paragraph_index: 0,
    char_start: 0,
    char_end: sampleText.length,
    quoted_text: sampleText,
    span_hash: spanHash,
    extracted_at: '2026-11-04T12:00:00Z',
    quality_state: 'VALIDATED',
  };

  const sampleAssertion: CandidateAssertion = {
    assertion_id: 'ast_pop_2025_001',
    property_path: 'demographics.population.permanent',
    assertion_value: {
      raw_value: 9679000,
      data_type: 'NUMBER',
      unit: '人',
    },
    confidence_score: 0.98,
    evidence_span_ids: [sampleSpan.span_id],
    created_at: '2026-11-04T12:00:00Z',
  };

  // Check 1: Ingest clean candidate assertion creates PENDING_REVIEW task
  const task1 = await manager.ingestCandidate({
    entity_id: 'wenzhou_city_330300',
    property_path: 'demographics.population.permanent',
    candidate_assertion: sampleAssertion,
    evidence_spans: [sampleSpan],
    submitted_by: 'editor_agent_01',
    priority: 'HIGH',
  });

  assert.strictEqual(task1.status, 'PENDING_REVIEW');
  assert.strictEqual(task1.priority, 'HIGH');
  assert.strictEqual(task1.audit_trail.length, 1);
  assert.strictEqual(task1.audit_trail[0].action, 'INGEST');
  pass('Ingest clean candidate creates task in PENDING_REVIEW with audit log');

  // Check 2: Ingest rejects candidate with zero evidence spans
  let rejectedZeroSpans = false;
  try {
    await manager.ingestCandidate({
      entity_id: 'wenzhou_city_330300',
      property_path: 'demographics.population.permanent',
      candidate_assertion: sampleAssertion,
      evidence_spans: [],
      submitted_by: 'editor_agent_01',
    });
  } catch (err: any) {
    if (err.message.includes('at least one supporting EvidenceSpan is strictly required')) {
      rejectedZeroSpans = true;
    }
  }
  assert.strictEqual(rejectedZeroSpans, true);
  pass('Ingest candidate fails closed when zero evidence spans are provided');

  // Check 3: Automated conflict detection flags ARBITRATION_REQUIRED when existing published assertion diverges
  const taskConflict = await manager.ingestCandidate({
    entity_id: 'wenzhou_city_330300',
    property_path: 'demographics.population.permanent',
    candidate_assertion: sampleAssertion, // 9679000
    evidence_spans: [sampleSpan],
    submitted_by: 'editor_agent_01',
    existing_published_assertion: {
      revision_id: 'rev_pub_old_0000001',
      raw_value: 9647000, // divergent value
      authority_level: 'OFFICIAL_GOVERNMENT_RELEASE',
    },
  });

  assert.strictEqual(taskConflict.status, 'ARBITRATION_REQUIRED');
  assert.ok(taskConflict.conflict_context);
  assert.strictEqual(taskConflict.conflict_context.conflicting_value, 9647000);
  pass('Automated conflict detection marks status ARBITRATION_REQUIRED on property value divergence');

  // Check 4: List tasks with filters and pagination
  const listRes = await manager.listTasks({ status: 'PENDING_REVIEW' });
  assert.strictEqual(listRes.total, 1);
  assert.strictEqual(listRes.tasks[0].task_id, task1.task_id);

  const listConflict = await manager.listTasks({ status: 'ARBITRATION_REQUIRED' });
  assert.strictEqual(listConflict.total, 1);
  assert.strictEqual(listConflict.tasks[0].task_id, taskConflict.task_id);
  pass('List tasks accurately filters by task status and returns paginated result');

  // Check 5: Claim task assigns reviewer and transitions to IN_REVIEW
  const claimedTask = await manager.claimTask(task1.task_id, 'reviewer_wang', 'reviewer');
  assert.strictEqual(claimedTask.status, 'IN_REVIEW');
  assert.strictEqual(claimedTask.assigned_to, 'reviewer_wang');
  assert.ok(claimedTask.assigned_at);
  assert.strictEqual(claimedTask.audit_trail.length, 2);
  assert.strictEqual(claimedTask.audit_trail[1].action, 'CLAIM');
  pass('Claim task assigns reviewer and updates status to IN_REVIEW');

  // Check 6: Release task resets assignment and reverts to PENDING_REVIEW
  const releasedTask = await manager.releaseTask(task1.task_id, 'reviewer_wang', 'reviewer');
  assert.strictEqual(releasedTask.status, 'PENDING_REVIEW');
  assert.strictEqual(releasedTask.assigned_to, null);
  pass('Release task clears assignment and reverts status to PENDING_REVIEW');

  // Re-claim for subsequent steps
  await manager.claimTask(task1.task_id, 'reviewer_wang', 'reviewer');

  // Check 7: Preflight evidence verification generates passing receipt
  const sourceDoc = {
    source_doc_id: 'doc_stat_2025_001',
    paragraphs: [sampleText],
    is_retracted: false,
  };
  const receipt = await manager.verifyEvidence(task1.task_id, [sourceDoc], 'reviewer_wang');
  assert.strictEqual(receipt.overall_verification_verdict, 'PASS');
  assert.strictEqual(receipt.span_verifications.length, 1);
  assert.strictEqual(receipt.span_verifications[0].check_status, 'PASS');
  pass('Preflight evidence verification returns PASS receipt against matching source document');

  // Check 8: Preflight evidence detects retracted source and flags FAIL
  const retractedDoc = {
    source_doc_id: 'doc_stat_2025_001',
    paragraphs: [sampleText],
    is_retracted: true,
  };
  const failReceipt = await manager.verifyEvidence(task1.task_id, [retractedDoc], 'reviewer_wang');
  assert.strictEqual(failReceipt.overall_verification_verdict, 'FAIL_SOURCE_RETRACTED');
  pass('Preflight evidence detects retracted source and attaches FAIL_SOURCE_RETRACTED receipt');

  // Check 9: Approve task fails closed when evidence verification failed
  let approveBlockedOnEvidence = false;
  try {
    await manager.approveTask(task1.task_id, 'reviewer_wang', 'Approved', 'reviewer');
  } catch (err: any) {
    if (err.message.includes('Fail-Closed Gate: Cannot approve task with non-passing evidence verification verdict')) {
      approveBlockedOnEvidence = true;
    }
  }
  assert.strictEqual(approveBlockedOnEvidence, true);
  pass('Approve task fails closed when evidence verification verdict is not PASS');

  // Restore clean passing evidence
  await manager.verifyEvidence(task1.task_id, [sourceDoc], 'reviewer_wang');

  // Check 10: Approve task fails closed while task is in ARBITRATION_REQUIRED
  let approveBlockedOnConflict = false;
  try {
    await manager.approveTask(taskConflict.task_id, 'reviewer_wang', 'Approve conflict', 'reviewer');
  } catch (err: any) {
    if (err.message.includes('Cannot approve task') && err.message.includes('unresolved conflict arbitration')) {
      approveBlockedOnConflict = true;
    }
  }
  assert.strictEqual(approveBlockedOnConflict, true);
  pass('Approve task fails closed while unresolved conflict arbitration is required');

  // Check 11: Arbitrate conflict resolves divergence and moves to IN_REVIEW
  const arbitrated = await manager.arbitrateConflict(
    taskConflict.task_id,
    'reviewer_wang',
    'ADOPT_CANDIDATE',
    'Statistical communique is newer than previous portal report',
    'reviewer',
  );
  assert.strictEqual(arbitrated.status, 'IN_REVIEW');
  assert.strictEqual(arbitrated.conflict_context?.arbitration_verdict, 'ADOPT_CANDIDATE');
  pass('Arbitrate conflict adopts candidate and transitions status to IN_REVIEW');

  // Check 12: Approve task succeeds and generates published revision ID
  const approvedResult = await manager.approveTask(
    task1.task_id,
    'reviewer_wang',
    'All verification criteria satisfied.',
    'reviewer',
  );
  assert.strictEqual(approvedResult.task.status, 'APPROVED');
  assert.ok(approvedResult.published_revision_id.startsWith('rev_'));
  assert.strictEqual(approvedResult.task.review_result?.verdict, 'APPROVED');
  pass('Approve task succeeds on clean evidence and assigns published revision ID');

  // Check 13: Reject task transitions to REJECTED with reason
  const taskToReject = await manager.ingestCandidate({
    entity_id: 'wenzhou_city_330300',
    property_path: 'economy.gdp.nominal',
    candidate_assertion: {
      assertion_id: 'ast_gdp_bad_0001',
      property_path: 'economy.gdp.nominal',
      assertion_value: {
        raw_value: 999999999,
        data_type: 'NUMBER',
      },
      evidence_span_ids: [sampleSpan.span_id],
      created_at: '2026-11-04T12:00:00Z',
    },
    evidence_spans: [sampleSpan],
    submitted_by: 'unverified_bot',
  });
  await manager.claimTask(taskToReject.task_id, 'reviewer_li', 'reviewer');
  const rejected = await manager.rejectTask(
    taskToReject.task_id,
    'reviewer_li',
    'Unverified source with impossible outlier number',
    'Exceeds city historical record by 10x',
    'reviewer',
  );
  assert.strictEqual(rejected.status, 'REJECTED');
  assert.strictEqual(rejected.review_result?.verdict, 'REJECTED');
  pass('Reject task sets status REJECTED with audit notes');

  // Check 14: Request changes transitions to CHANGES_REQUESTED
  const taskToRequestChanges = await manager.ingestCandidate({
    entity_id: 'wenzhou_city_330300',
    property_path: 'environment.air_quality.aqi',
    candidate_assertion: {
      assertion_id: 'ast_aqi_2025_001',
      property_path: 'environment.air_quality.aqi',
      assertion_value: {
        raw_value: 45,
        data_type: 'NUMBER',
      },
      evidence_span_ids: [sampleSpan.span_id],
      created_at: '2026-11-04T12:00:00Z',
    },
    evidence_spans: [sampleSpan],
    submitted_by: 'editor_agent_02',
  });
  await manager.claimTask(taskToRequestChanges.task_id, 'reviewer_li', 'reviewer');
  const changesReq = await manager.requestChanges(
    taskToRequestChanges.task_id,
    'reviewer_li',
    'Please attach monitoring station specific coordinates and temporal duration.',
    'reviewer',
  );
  assert.strictEqual(changesReq.status, 'CHANGES_REQUESTED');
  assert.strictEqual(changesReq.review_result?.verdict, 'CHANGES_REQUESTED');
  pass('Request changes sets status CHANGES_REQUESTED with reviewer feedback');

  // Check 15: Role security guard blocks unauthorized role
  let unauthorizedBlocked = false;
  try {
    await manager.claimTask(taskToRequestChanges.task_id, 'viewer_guest', 'viewer');
  } catch (err: any) {
    if (err.message.includes("Forbidden: role 'viewer' is not authorized")) {
      unauthorizedBlocked = true;
    }
  }
  assert.strictEqual(unauthorizedBlocked, true);
  pass('Role security guard blocks unauthorized viewer role from claiming review task');

  console.log(`\n=== FPF Slice R2 Review Workbench Test Suite Results ===`);
  console.log(`Total checks: ${checksPassed}`);
  console.log(`Passed:       ${checksPassed}`);
  console.log(`Failed:       0\n`);
  console.log(`ALL ${checksPassed} REVIEW WORKBENCH CHECKS PASSED!\n`);
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
