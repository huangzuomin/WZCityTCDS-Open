import assert from 'node:assert';
import {
  computeSpanHash,
  computeReceiptDigest,
  EvidenceVerificationEngine,
  type SourceNewsDocumentSnapshot,
} from './evidence-engine.js';
import {
  ConflictArbitrationPipeline,
} from './arbitration-pipeline.js';
import {
  type EvidenceSpan,
  type ConflictingSpanItem,
} from '../contracts/evidence.js';

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

console.log('=== Running FPF Slice C4 Evidence Verification & Arbitration Tests ===');

const mockDoc: SourceNewsDocumentSnapshot = {
  source_doc_id: 'news_wenzhou_20261101_001',
  source_url: 'https://news.wenzhou.gov.cn/art/2026/11/1/art_001.html',
  paragraphs: [
    '温州市统计局发布前三季度经济运行数据。',
    '初步核算，全市实现地区生产总值（GDP）7120.5亿元，按不变价格计算，同比增长5.7%。',
    '规上工业增加值增长8.9%，固定资产投资保持平稳增长。',
  ],
  is_retracted: false,
};

const quotedP1 = '地区生产总值（GDP）7120.5亿元';
// In paragraph 1: '初步核算，全市实现' (9 chars) -> char_start: 9, char_end: 9 + 21 = 30
const charStart = mockDoc.paragraphs[1].indexOf(quotedP1);
const charEnd = charStart + quotedP1.length;
const validSpanHash = computeSpanHash(quotedP1);

const validSpan: EvidenceSpan = {
  span_id: 'span_wz_gdp_2026q3_01',
  source_doc_id: 'news_wenzhou_20261101_001',
  source_url: mockDoc.source_url,
  paragraph_index: 1,
  char_start: charStart,
  char_end: charEnd,
  quoted_text: quotedP1,
  span_hash: validSpanHash,
  extracted_at: '2026-11-04T05:00:00.000Z',
  quality_state: 'VALIDATED',
};

const engine = new EvidenceVerificationEngine();
const pipeline = new ConflictArbitrationPipeline();

// Check 1: computeSpanHash normalization & determinism
check('computeSpanHash produces deterministic 64-char hex SHA-256 with NFKC normalization', () => {
  const hash1 = computeSpanHash('温州 2026');
  const hash2 = computeSpanHash('温州 2026'.normalize('NFKD'));
  assert.strictEqual(hash1.length, 64);
  assert.strictEqual(hash1, hash2);
  assert.notStrictEqual(computeSpanHash('A'), computeSpanHash('B'));
});

// Check 2: verifySpan PASS on exact match
check('verifySpan returns PASS for valid span matching source document slice', () => {
  const res = engine.verifySpan(validSpan, mockDoc);
  assert.strictEqual(res.check_status, 'PASS');
  assert.strictEqual(res.span_hash_matched, true);
  assert.strictEqual(res.source_doc_verified, true);
  assert.strictEqual(res.paragraph_exact_match, true);
  assert.strictEqual(res.computed_hash, validSpanHash);
});

// Check 3: verifySpan detects tampered span hash
check('verifySpan detects hash mismatch when quoted_text does not match span_hash', () => {
  const tamperedSpan: EvidenceSpan = {
    ...validSpan,
    span_id: 'span_tampered_hash_01',
    span_hash: '0000000000000000000000000000000000000000000000000000000000000000',
  };
  const res = engine.verifySpan(tamperedSpan, mockDoc);
  assert.strictEqual(res.check_status, 'FAIL_HASH_MISMATCH');
  assert.strictEqual(res.span_hash_matched, false);
});

// Check 4: verifySpan detects missing source document
check('verifySpan detects missing source document', () => {
  const res = engine.verifySpan(validSpan, undefined);
  assert.strictEqual(res.check_status, 'FAIL_SOURCE_NOT_FOUND');
  assert.strictEqual(res.span_hash_matched, true);
  assert.strictEqual(res.source_doc_verified, false);
});

// Check 5: verifySpan detects text mismatch with paragraph
check('verifySpan detects text mismatch when coordinates point to different text', () => {
  const mismatchedSpan: EvidenceSpan = {
    ...validSpan,
    span_id: 'span_mismatch_coords_01',
    char_start: 0,
    char_end: 10,
  };
  const res = engine.verifySpan(mismatchedSpan, mockDoc);
  assert.strictEqual(res.check_status, 'FAIL_TEXT_NOT_FOUND');
  assert.strictEqual(res.paragraph_exact_match, false);
});

// Check 6: verifyAssertionEvidence emits PASS receipt
check('verifyAssertionEvidence emits schema-compliant receipt with overall PASS verdict', () => {
  const receipt = engine.verifyAssertionEvidence({
    assertion_id: 'ast_gdp_2026q3_report_01',
    revision_id: 'rev_gdp_2026q3_v001',
    spans: [validSpan],
    source_resolver: (id) => (id === mockDoc.source_doc_id ? mockDoc : undefined),
  });
  assert.strictEqual(receipt.overall_verification_verdict, 'PASS');
  assert.strictEqual(receipt.span_verifications.length, 1);
  assert.strictEqual(receipt.span_verifications[0].check_status, 'PASS');
  assert.strictEqual(receipt.auditor_signature.digest_sha256.length, 64);
});

// Check 7: verifyAssertionEvidence flags retracted source
check('verifyAssertionEvidence detects retracted source and flags FAIL_SOURCE_RETRACTED', () => {
  const retractedDoc: SourceNewsDocumentSnapshot = {
    ...mockDoc,
    is_retracted: true,
  };
  const receipt = engine.verifyAssertionEvidence({
    assertion_id: 'ast_gdp_2026q3_report_01',
    revision_id: 'rev_gdp_2026q3_v001',
    spans: [validSpan],
    source_resolver: () => retractedDoc,
  });
  assert.strictEqual(receipt.overall_verification_verdict, 'FAIL_SOURCE_RETRACTED');
});

// Check 8: verifyAssertionEvidence handles empty spans
check('verifyAssertionEvidence rejects assertion with zero supporting evidence spans', () => {
  const receipt = engine.verifyAssertionEvidence({
    assertion_id: 'ast_unsupported_claim_01',
    revision_id: 'rev_unsupported_claim_v001',
    spans: [],
    source_resolver: () => mockDoc,
  });
  assert.strictEqual(receipt.overall_verification_verdict, 'FAIL_INSUFFICIENT_EVIDENCE');
});

// Check 9: handleSourceRetraction updates quality state to STALE_SOURCE_RETRACTED
check('handleSourceRetraction accurately identifies and marks affected spans as STALE_SOURCE_RETRACTED', () => {
  const span2: EvidenceSpan = {
    ...validSpan,
    span_id: 'span_other_unaffected_doc_02',
    source_doc_id: 'news_other_reliable_2026_099',
  };
  const result = engine.handleSourceRetraction(mockDoc.source_doc_id, [validSpan, span2]);
  assert.strictEqual(result.affected_spans.length, 1);
  assert.strictEqual(result.affected_spans[0].span_id, validSpan.span_id);
  assert.strictEqual(result.affected_spans[0].quality_state, 'STALE_SOURCE_RETRACTED');
  assert.strictEqual(result.updated_spans[1].quality_state, 'VALIDATED');
});

// Check 10: ConflictArbitrationPipeline validates minimum 2 conflicting spans
check('ConflictArbitrationPipeline rejects conflicts with fewer than 2 items', () => {
  assert.throws(() => {
    pipeline.createConflictArbitration({
      assertion_id: 'ast_conflict_test_01',
      conflicting_spans: [
        {
          span_id: 'span_single_01',
          source_doc_id: 'doc_1',
          reported_value: 100,
          source_authority_level: 'COMMERCIAL_PORTAL',
        },
      ],
      conflict_type: 'NUMERICAL_DISCREPANCY',
    });
  });
});

// Check 11: AUTO_PRIORITY adopts higher authority span
check('adjudicate adopts OFFICIAL_GOVERNMENT_RELEASE over COMMERCIAL_PORTAL', () => {
  const spans: ConflictingSpanItem[] = [
    {
      span_id: 'span_gov_release_01',
      source_doc_id: 'gov_doc_01',
      reported_value: 7120.5,
      source_authority_level: 'OFFICIAL_GOVERNMENT_RELEASE',
    },
    {
      span_id: 'span_portal_claim_02',
      source_doc_id: 'portal_doc_02',
      reported_value: 7200.0,
      source_authority_level: 'COMMERCIAL_PORTAL',
    },
  ];
  const arbitration = pipeline.createConflictArbitration({
    assertion_id: 'ast_gdp_conflict_01',
    conflicting_spans: spans,
    conflict_type: 'NUMERICAL_DISCREPANCY',
  });
  const res = pipeline.adjudicate(arbitration, { policy: 'AUTO_PRIORITY' });
  assert.strictEqual(res.arbitration_status, 'RESOLVED_ADOPTED');
  assert.strictEqual(res.adjudication?.chosen_decision, 'ADOPT_HIGHER_AUTHORITY');
  assert.strictEqual(res.adjudication?.adopted_span_id, 'span_gov_release_01');
  assert.ok(res.adjudication?.arbitration_rationale?.includes('OFFICIAL_GOVERNMENT_RELEASE'));
});

// Check 12: AUTO_PRIORITY suspends when equal-tier authorities conflict
check('adjudicate suspends pending clarification when same highest-tier sources conflict', () => {
  const spans: ConflictingSpanItem[] = [
    {
      span_id: 'span_state_media_a_01',
      source_doc_id: 'media_a',
      reported_value: '项目已于10月完工',
      source_authority_level: 'STATE_MEDIA_PRIMARY',
    },
    {
      span_id: 'span_state_media_b_02',
      source_doc_id: 'media_b',
      reported_value: '项目预计12月完工',
      source_authority_level: 'STATE_MEDIA_PRIMARY',
    },
  ];
  const arbitration = pipeline.createConflictArbitration({
    assertion_id: 'ast_project_completion_01',
    conflicting_spans: spans,
    conflict_type: 'STATUS_CONTRADICTION',
  });
  const res = pipeline.adjudicate(arbitration, { policy: 'AUTO_PRIORITY' });
  assert.strictEqual(res.arbitration_status, 'PENDING_ARBITRATION');
  assert.strictEqual(res.adjudication?.chosen_decision, 'SUSPEND_PENDING_OFFICIAL_CLARIFICATION');
});

// Check 13: ALLOW_RANGE reconciles numerical / temporal conflict into range
check('adjudicate reconciles numerical divergence as estimated range under ALLOW_RANGE policy', () => {
  const spans: ConflictingSpanItem[] = [
    {
      span_id: 'span_stat_a_01',
      source_doc_id: 'stat_a',
      reported_value: 9400,
      source_authority_level: 'STATE_MEDIA_PRIMARY',
    },
    {
      span_id: 'span_stat_b_02',
      source_doc_id: 'stat_b',
      reported_value: 9450,
      source_authority_level: 'LOCAL_MEDIA_REPORT',
    },
  ];
  const arbitration = pipeline.createConflictArbitration({
    assertion_id: 'ast_population_estimate_01',
    conflicting_spans: spans,
    conflict_type: 'NUMERICAL_DISCREPANCY',
  });
  const res = pipeline.adjudicate(arbitration, { policy: 'ALLOW_RANGE' });
  assert.strictEqual(res.arbitration_status, 'RECONCILED_AS_RANGE');
  assert.strictEqual(res.adjudication?.chosen_decision, 'PUBLISH_AS_ESTIMATED_RANGE');
});

console.log('\n=== FPF Slice C4 Evidence Test Suite Results ===');
console.log('Total checks: ' + total);
console.log('Passed:       ' + passed);
console.log('Failed:       ' + (total - passed));

if (passed === total) {
  console.log('\nALL 13 EVIDENCE VERIFICATION & ARBITRATION CHECKS PASSED!\n');
} else {
  process.exit(1);
}
