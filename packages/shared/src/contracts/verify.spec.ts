import {
  EntityLookupMessageSchema,
  UnresolvedEntityProposalSchema,
  SourceNewsEventSchema,
  FactRevisionLifecycleSchema,
  PublicationSnapshotSchema,
  RevisionStateTransitionSchema,
  EvidenceSpanSchema,
  EvidenceVerificationReceiptSchema,
  EvidenceConflictArbitrationSchema,
  PublicOutletDeliverySchema,
  PublicationSecurityGatePolicySchema,
  ChangesStreamEventSchema,
  assertContract,
  validateContract,
} from './index.js';

export function runContractTestSuite(): { passed: number; total: number; errors: string[] } {
  const errors: string[] = [];
  let passed = 0;
  let total = 0;

  function test(name: string, fn: () => void) {
    total++;
    try {
      fn();
      passed++;
    } catch (err: any) {
      errors.push(`[${name}]: ${err.message}`);
    }
  }

  // 1. Entity Lookup
  test('EntityLookupMessageSchema - valid request', () => {
    const validRequest = {
      protocol_version: '1.0',
      message_id: 'msg_req_lookup_20261104_001',
      timestamp: '2026-11-04T10:00:00Z',
      message_type: 'LOOKUP_REQUEST',
      request: {
        query_text: '温州奥林匹克体育中心',
        expected_categories: ['POI'],
        max_candidates: 5,
      },
    };
    assertContract(EntityLookupMessageSchema, validRequest, 'EntityLookupRequest');
  });

  test('EntityLookupMessageSchema - invalid message_id regex rejected', () => {
    const invalid = {
      protocol_version: '1.0',
      message_id: 'invalid-id',
      timestamp: '2026-11-04T10:00:00Z',
      message_type: 'LOOKUP_REQUEST',
      request: { query_text: 'test' },
    };
    const res = validateContract(EntityLookupMessageSchema, invalid);
    if (res.success) throw new Error('Expected validation failure');
  });

  // 2. Unresolved Entity Proposal
  test('UnresolvedEntityProposalSchema - valid proposal', () => {
    const validProposal = {
      proposal_id: 'prop_unresolved_20261104_0001',
      proposer_system: 'WZCityTCDS',
      submitted_at: '2026-11-04T10:05:00Z',
      candidate_name: '瓯海新城数字港',
      suggested_category: 'POI',
      source_evidence: {
        source_doc_id: 'doc_wzrb_20261104_88899',
        context_snippet: '市重大产业投资落地瓯海新城数字港...',
        evidence_span_hash: 'a'.repeat(64),
      },
      proposal_status: 'SUBMITTED',
    };
    assertContract(UnresolvedEntityProposalSchema, validProposal, 'UnresolvedEntityProposal');
  });

  // 3. Source News Event
  test('SourceNewsEventSchema - valid published news event', () => {
    const validNews = {
      event_id: 'evt_news_publish_20261104_001',
      event_type: 'NEWS_PUBLISHED',
      event_time: '2026-11-04T08:30:00Z',
      source_doc_id: 'wznews_20261104_12345',
      cms_origin: {
        publisher_name: '温州日报',
        channel_id: 'chan_economy',
      },
      news_payload: {
        title: '温州前三季度GDP突破6500亿元',
        publish_time: '2026-11-04T08:30:00Z',
        content_text: '温州前三季度全市地区生产总值同比增长6.2%...',
        content_sha256: 'b'.repeat(64),
        paragraphs: [
          {
            paragraph_index: 0,
            char_start: 0,
            char_end: 25,
            text: '温州前三季度全市地区生产总值同比增长6.2%...',
            paragraph_sha256: 'c'.repeat(64),
          },
        ],
      },
    };
    assertContract(SourceNewsEventSchema, validNews, 'SourceNewsEvent');
  });

  // 4. Fact Revision Lifecycle
  test('FactRevisionLifecycleSchema - valid genesis revision', () => {
    const validRevision = {
      assertion_id: 'ast_gdp_annual_2026_wenzhou',
      revision_id: 'rev_gdp_20261104_v1_0001',
      revision_number: 1,
      entity_id: 'ent_wenzhou_330300',
      property_path: 'economy.gdp.annual',
      assertion_value: {
        raw_value: 6500.5,
        data_type: 'NUMBER',
        unit: '亿元',
        temporal_validity: {
          statistical_period: '2026-Q1-Q3',
        },
      },
      lifecycle_state: 'PUBLISHED',
      revision_metadata: {
        parent_revision_sha256: 'GENESIS',
        created_at: '2026-11-04T09:00:00Z',
        created_by_role: 'FACT_REVIEWER',
        revision_reason: 'INITIAL_PUBLISH',
        evidence_span_hashes: ['d'.repeat(64)],
      },
    };
    assertContract(FactRevisionLifecycleSchema, validRevision, 'FactRevisionLifecycle');
  });

  // 5. Publication Snapshot
  test('PublicationSnapshotSchema - valid entity projection snapshot', () => {
    const validSnapshot = {
      publication_id: 'pub_entity_profile_330300_20261104',
      snapshot_revision_id: 'pubrev_330300_rel_20261104_01',
      entity_id: 'ent_wenzhou_330300',
      entity_canonical_name: '温州市',
      generated_at: '2026-11-04T09:15:00Z',
      snapshot_digest_sha256: 'e'.repeat(64),
      published_assertions: [
        {
          assertion_id: 'ast_gdp_annual_2026_wenzhou',
          revision_id: 'rev_gdp_20261104_v1_0001',
          property_path: 'economy.gdp.annual',
          raw_value: 6500.5,
          unit: '亿元',
          evidence_hashes: ['d'.repeat(64)],
        },
      ],
      projection_metadata: {
        kernel_system: 'WZCityTCDS-PublicationKernel',
        publisher_role: 'CHIEF_FACT_EDITOR',
        outlet_scopes: ['HUB_ONE_WAY_PROJECTION', 'REST_API'],
        is_latest_snapshot: true,
      },
    };
    assertContract(PublicationSnapshotSchema, validSnapshot, 'PublicationSnapshot');
  });

  // 6. Revision State Transition
  test('RevisionStateTransitionSchema - valid approve transition', () => {
    const validTransition = {
      transition_id: 'trans_submit_review_20261104_01',
      assertion_id: 'ast_gdp_annual_2026_wenzhou',
      revision_id: 'rev_gdp_20261104_v1_0001',
      from_state: 'PENDING_REVIEW',
      to_state: 'PUBLISHED',
      transition_trigger: 'APPROVE_AND_PUBLISH',
      authorized_role: 'CHIEF_EDITOR',
      transition_timestamp: '2026-11-04T09:10:00Z',
    };
    assertContract(RevisionStateTransitionSchema, validTransition, 'RevisionStateTransition');
  });

  // 7. Evidence Span
  test('EvidenceSpanSchema - valid verified evidence span', () => {
    const validSpan = {
      span_id: 'span_evid_20261104_00000001',
      source_doc_id: 'wznews_20261104_12345',
      paragraph_index: 0,
      char_start: 0,
      char_end: 25,
      quoted_text: '温州前三季度全市地区生产总值同比增长6.2%',
      span_hash: 'f'.repeat(64),
      extracted_at: '2026-11-04T08:35:00Z',
      quality_state: 'VALIDATED',
    };
    assertContract(EvidenceSpanSchema, validSpan, 'EvidenceSpan');
  });

  // 8. Evidence Verification Receipt
  test('EvidenceVerificationReceiptSchema - valid verification receipt', () => {
    const validReceipt = {
      receipt_id: 'rcpt_evid_verify_20261104_001',
      assertion_id: 'ast_gdp_annual_2026_wenzhou',
      revision_id: 'rev_gdp_20261104_v1_0001',
      verified_at: '2026-11-04T08:45:00Z',
      verifier_engine_version: 'EvidenceEngine-v1.0.0',
      span_verifications: [
        {
          span_id: 'span_evid_20261104_00000001',
          span_hash_matched: true,
          source_doc_verified: true,
          paragraph_exact_match: true,
          check_status: 'PASS',
        },
      ],
      overall_verification_verdict: 'PASS',
      auditor_signature: {
        signature_type: 'SIGSTORE_OIDC',
        signer_identity: 'verifier-agent@wzcitytcds.local',
        digest_sha256: '1'.repeat(64),
      },
    };
    assertContract(EvidenceVerificationReceiptSchema, validReceipt, 'EvidenceVerificationReceipt');
  });

  // 9. Evidence Conflict Arbitration
  test('EvidenceConflictArbitrationSchema - valid arbitration record', () => {
    const validArbitration = {
      arbitration_id: 'arb_conflict_20261104_0001',
      assertion_id: 'ast_gdp_annual_2026_wenzhou',
      conflicting_spans: [
        {
          span_id: 'span_evid_official_01',
          source_doc_id: 'doc_gov_release_01',
          reported_value: 6500.5,
          source_authority_level: 'OFFICIAL_GOVERNMENT_RELEASE',
        },
        {
          span_id: 'span_evid_media_02',
          source_doc_id: 'doc_media_report_02',
          reported_value: 6498.0,
          source_authority_level: 'LOCAL_MEDIA_REPORT',
        },
      ],
      conflict_type: 'NUMERICAL_DISCREPANCY',
      arbitration_status: 'RESOLVED_ADOPTED',
      created_at: '2026-11-04T08:50:00Z',
      adjudication: {
        adjudicated_at: '2026-11-04T08:55:00Z',
        arbitrator_id: 'chief_arb_001',
        chosen_decision: 'ADOPT_HIGHER_AUTHORITY',
        adopted_span_id: 'span_evid_official_01',
        arbitration_rationale: '优先采纳温州市统计局官方发布数据，排除二阶媒体速报口径误差。',
      },
    };
    assertContract(EvidenceConflictArbitrationSchema, validArbitration, 'EvidenceConflictArbitration');
  });

  // 10. Public Outlet Delivery
  test('PublicOutletDeliverySchema - valid API outlet delivery record', () => {
    const validOutlet = {
      outlet_channel: 'REST_API_V1',
      publication_id: 'pub_entity_profile_330300_20261104',
      snapshot_revision_id: 'pubrev_330300_rel_20261104_01',
      entity_id: 'ent_wenzhou_330300',
      canonical_url: 'https://facts.wenzhou.gov.cn/v1/entities/ent_wenzhou_330300',
      published_at: '2026-11-04T09:20:00Z',
      snapshot_digest_sha256: '2'.repeat(64),
      payload_format: 'JSON',
      delivery_status: 'ACTIVE_CURRENT',
      cache_control: {
        cache_policy: 'PUBLIC_IMMUTABLE',
        max_age_seconds: 86400,
      },
    };
    assertContract(PublicOutletDeliverySchema, validOutlet, 'PublicOutletDelivery');
  });

  // 11. Security Gate Policy
  test('PublicationSecurityGatePolicySchema - valid PASS security gate evaluation', () => {
    const validGate = {
      gate_evaluation_id: 'gate_eval_20261104_00001',
      snapshot_revision_id: 'pubrev_330300_rel_20261104_01',
      evaluated_at: '2026-11-04T09:18:00Z',
      gate_verdict: 'PASS_APPROVED_FOR_RELEASE',
      rule_evaluations: {
        rule_only_published_state: { passed: true, non_published_count: 0 },
        rule_evidence_receipt_pass: { passed: true, unverified_assertion_count: 0 },
        rule_no_private_ip_leaks: { passed: true, detected_matches: [] },
        rule_no_credential_patterns: { passed: true, suspicious_token_count: 0 },
        rule_source_validity_confirmed: { passed: true, retracted_source_count: 0 },
      },
      gate_controller: {
        controller_role: 'FPF_PUBLICATION_SECURITY_GATE',
        signature_hash: '3'.repeat(64),
      },
    };
    assertContract(PublicationSecurityGatePolicySchema, validGate, 'PublicationSecurityGatePolicy');
  });

  // 12. Changes Stream Event
  test('ChangesStreamEventSchema - valid changes stream event', () => {
    const validEvent = {
      change_event_id: 'chg_evt_20261104_00000001',
      change_sequence_num: 1,
      change_type: 'FACT_PUBLISHED',
      entity_id: 'ent_wenzhou_330300',
      event_timestamp: '2026-11-04T09:22:00Z',
      event_digest_sha256: '4'.repeat(64),
      affected_revision: {
        revision_id: 'rev_gdp_20261104_v1_0001',
        property_path: 'economy.gdp.annual',
        lifecycle_state: 'PUBLISHED',
        publication_snapshot_id: 'pub_entity_profile_330300_20261104',
      },
    };
    assertContract(ChangesStreamEventSchema, validEvent, 'ChangesStreamEvent');
  });

  return { passed, total, errors };
}

// Self-executing runner when executed via node
if (typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].includes('verify.spec')) {
  const result = runContractTestSuite();
  console.log(`\n=== FPF Slice C1 Contract Test Suite Results ===`);
  console.log(`Total checks: ${result.total}`);
  console.log(`Passed:       ${result.passed}`);
  console.log(`Failed:       ${result.errors.length}`);
  if (result.errors.length > 0) {
    console.error('\nFailures:\n' + result.errors.join('\n'));
    process.exit(1);
  } else {
    console.log(`\nALL ${result.passed} CONTRACT SPECIFICATION CHECKS PASSED!\n`);
  }
}
