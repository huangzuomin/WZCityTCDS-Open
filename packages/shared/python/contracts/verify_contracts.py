"""Verification test suite for Python Pydantic contract models."""
import sys
from packages.shared.python.contracts import (
    EntityLookupMessage,
    UnresolvedEntityProposal,
    SourceNewsEvent,
    FactRevisionLifecycle,
    PublicationSnapshot,
    RevisionStateTransition,
    EvidenceSpan,
    EvidenceVerificationReceipt,
    EvidenceConflictArbitration,
    PublicOutletDelivery,
    PublicationSecurityGatePolicy,
    ChangesStreamEvent,
)


def run_tests():
    total = 0
    passed = 0

    # 1. Entity Lookup
    total += 1
    msg = EntityLookupMessage.model_validate({
        "protocol_version": "1.0",
        "message_id": "msg_req_lookup_20261104_001",
        "timestamp": "2026-11-04T10:00:00Z",
        "message_type": "LOOKUP_REQUEST",
        "request": {
            "query_text": "温州奥体中心",
            "max_candidates": 5,
        },
    })
    assert msg.message_id == "msg_req_lookup_20261104_001"
    passed += 1

    # 2. Unresolved Proposal
    total += 1
    prop = UnresolvedEntityProposal.model_validate({
        "proposal_id": "prop_unresolved_20261104_0001",
        "proposer_system": "WZCityTCDS",
        "submitted_at": "2026-11-04T10:05:00Z",
        "candidate_name": "瓯海新城数字港",
        "source_evidence": {
            "source_doc_id": "doc_wzrb_20261104_88899",
            "context_snippet": "市重大产业投资落地瓯海新城数字港...",
            "evidence_span_hash": "a" * 64,
        },
        "proposal_status": "SUBMITTED",
    })
    assert prop.candidate_name == "瓯海新城数字港"
    passed += 1

    # 3. Source News Event
    total += 1
    evt = SourceNewsEvent.model_validate({
        "event_id": "evt_news_publish_20261104_001",
        "event_type": "NEWS_PUBLISHED",
        "event_time": "2026-11-04T08:30:00Z",
        "source_doc_id": "wznews_20261104_12345",
        "cms_origin": {
            "publisher_name": "温州日报",
            "channel_id": "chan_economy",
        },
    })
    assert evt.event_type.value == "NEWS_PUBLISHED"
    passed += 1

    # 4. Fact Revision Lifecycle
    total += 1
    rev = FactRevisionLifecycle.model_validate({
        "assertion_id": "ast_gdp_annual_2026_wenzhou",
        "revision_id": "rev_gdp_20261104_v1_0001",
        "entity_id": "ent_wenzhou_330300",
        "property_path": "economy.gdp.annual",
        "assertion_value": {
            "raw_value": 6500.5,
            "data_type": "NUMBER",
            "unit": "亿元",
        },
        "lifecycle_state": "PUBLISHED",
        "revision_metadata": {
            "parent_revision_sha256": "GENESIS",
            "created_at": "2026-11-04T09:00:00Z",
            "created_by_role": "FACT_REVIEWER",
            "revision_reason": "INITIAL_PUBLISH",
            "evidence_span_hashes": ["d" * 64],
        },
    })
    assert rev.assertion_id == "ast_gdp_annual_2026_wenzhou"
    passed += 1

    # 5. Publication Snapshot
    total += 1
    snap = PublicationSnapshot.model_validate({
        "publication_id": "pub_entity_profile_330300_20261104",
        "snapshot_revision_id": "pubrev_330300_rel_20261104_01",
        "entity_id": "ent_wenzhou_330300",
        "generated_at": "2026-11-04T09:15:00Z",
        "snapshot_digest_sha256": "e" * 64,
        "published_assertions": [
            {
                "assertion_id": "ast_gdp_annual_2026_wenzhou",
                "revision_id": "rev_gdp_20261104_v1_0001",
                "property_path": "economy.gdp.annual",
                "raw_value": 6500.5,
                "evidence_hashes": ["d" * 64],
            }
        ],
        "projection_metadata": {
            "kernel_system": "WZCityTCDS-PublicationKernel",
            "publisher_role": "CHIEF_FACT_EDITOR",
            "outlet_scopes": ["HUB_ONE_WAY_PROJECTION"],
            "is_latest_snapshot": True,
        },
    })
    assert snap.publication_id == "pub_entity_profile_330300_20261104"
    passed += 1

    # 6. Revision State Transition
    total += 1
    trans = RevisionStateTransition.model_validate({
        "transition_id": "trans_submit_review_20261104_01",
        "assertion_id": "ast_gdp_annual_2026_wenzhou",
        "revision_id": "rev_gdp_20261104_v1_0001",
        "from_state": "PENDING_REVIEW",
        "to_state": "PUBLISHED",
        "transition_trigger": "APPROVE_AND_PUBLISH",
        "authorized_role": "CHIEF_EDITOR",
        "transition_timestamp": "2026-11-04T09:10:00Z",
    })
    assert trans.to_state.value == "PUBLISHED"
    passed += 1

    # 7. Evidence Span
    total += 1
    span = EvidenceSpan.model_validate({
        "span_id": "span_evid_20261104_00000001",
        "source_doc_id": "wznews_20261104_12345",
        "paragraph_index": 0,
        "char_start": 0,
        "char_end": 25,
        "quoted_text": "温州前三季度全市生产总值",
        "span_hash": "f" * 64,
        "extracted_at": "2026-11-04T08:35:00Z",
        "quality_state": "VALIDATED",
    })
    assert span.span_id == "span_evid_20261104_00000001"
    passed += 1

    # 8. Evidence Verification Receipt
    total += 1
    rcpt = EvidenceVerificationReceipt.model_validate({
        "receipt_id": "rcpt_evid_verify_20261104_001",
        "assertion_id": "ast_gdp_annual_2026_wenzhou",
        "revision_id": "rev_gdp_20261104_v1_0001",
        "verified_at": "2026-11-04T08:45:00Z",
        "verifier_engine_version": "v1.0.0",
        "span_verifications": [
            {
                "span_id": "span_01",
                "span_hash_matched": True,
                "source_doc_verified": True,
                "paragraph_exact_match": True,
                "check_status": "PASS",
            }
        ],
        "overall_verification_verdict": "PASS",
        "auditor_signature": {
            "signature_type": "SIGSTORE_OIDC",
            "signer_identity": "63087187+huangzuomin@users.noreply.github.com",
            "digest_sha256": "1" * 64,
        },
    })
    assert rcpt.overall_verification_verdict.value == "PASS"
    passed += 1

    # 9. Evidence Conflict Arbitration
    total += 1
    arb = EvidenceConflictArbitration.model_validate({
        "arbitration_id": "arb_conflict_20261104_0001",
        "assertion_id": "ast_gdp_annual_2026_wenzhou",
        "conflicting_spans": [
            {
                "span_id": "span_01",
                "source_doc_id": "doc_01",
                "reported_value": 6500.5,
                "source_authority_level": "OFFICIAL_GOVERNMENT_RELEASE",
            },
            {
                "span_id": "span_02",
                "source_doc_id": "doc_02",
                "reported_value": 6498.0,
                "source_authority_level": "LOCAL_MEDIA_REPORT",
            },
        ],
        "conflict_type": "NUMERICAL_DISCREPANCY",
        "arbitration_status": "RESOLVED_ADOPTED",
        "created_at": "2026-11-04T08:50:00Z",
    })
    assert arb.conflict_type.value == "NUMERICAL_DISCREPANCY"
    passed += 1

    # 10. Public Outlet Delivery
    total += 1
    outlet = PublicOutletDelivery.model_validate({
        "outlet_channel": "REST_API_V1",
        "publication_id": "pub_entity_profile_330300_20261104",
        "snapshot_revision_id": "pubrev_330300_rel_20261104_01",
        "entity_id": "ent_wenzhou_330300",
        "published_at": "2026-11-04T09:20:00Z",
        "snapshot_digest_sha256": "2" * 64,
        "payload_format": "JSON",
        "delivery_status": "ACTIVE_CURRENT",
    })
    assert outlet.outlet_channel.value == "REST_API_V1"
    passed += 1

    # 11. Security Gate Policy
    total += 1
    gate = PublicationSecurityGatePolicy.model_validate({
        "gate_evaluation_id": "gate_eval_20261104_00001",
        "snapshot_revision_id": "pubrev_330300_rel_20261104_01",
        "evaluated_at": "2026-11-04T09:18:00Z",
        "gate_verdict": "PASS_APPROVED_FOR_RELEASE",
        "rule_evaluations": {
            "rule_only_published_state": {"passed": True},
            "rule_evidence_receipt_pass": {"passed": True},
            "rule_no_private_ip_leaks": {"passed": True},
            "rule_no_credential_patterns": {"passed": True},
            "rule_source_validity_confirmed": {"passed": True},
        },
    })
    assert gate.gate_verdict.value == "PASS_APPROVED_FOR_RELEASE"
    passed += 1

    # 12. Changes Stream Event
    total += 1
    chg = ChangesStreamEvent.model_validate({
        "change_event_id": "chg_evt_20261104_00000001",
        "change_sequence_num": 1,
        "change_type": "FACT_PUBLISHED",
        "entity_id": "ent_wenzhou_330300",
        "event_timestamp": "2026-11-04T09:22:00Z",
        "event_digest_sha256": "4" * 64,
        "affected_revision": {
            "revision_id": "rev_gdp_20261104_v1_0001",
            "property_path": "economy.gdp.annual",
            "lifecycle_state": "PUBLISHED",
        },
    })
    assert chg.change_type.value == "FACT_PUBLISHED"
    passed += 1

    # 13. Hub Entity Adapter Python Unit Tests
    import unittest
    from packages.shared.python.contracts.test_hub_entity_adapter import TestHubEntityAdapter
    suite = unittest.TestLoader().loadTestsFromTestCase(TestHubEntityAdapter)
    runner = unittest.TextTestRunner(verbosity=1)
    res = runner.run(suite)
    assert res.wasSuccessful(), f"HubEntityAdapter tests failed: {len(res.errors)} errors, {len(res.failures)} failures"
    total += res.testsRun
    passed += res.testsRun

    # 14. Fact Revision Storage Python Unit Tests
    from packages.shared.python.contracts.test_revision_storage import TestFactRevisionStorage
    suite_rev = unittest.TestLoader().loadTestsFromTestCase(TestFactRevisionStorage)
    res_rev = runner.run(suite_rev)
    assert res_rev.wasSuccessful(), f"FactRevisionStorage tests failed: {len(res_rev.errors)} errors, {len(res_rev.failures)} failures"
    total += res_rev.testsRun
    passed += res_rev.testsRun

    # 15. Evidence Verification Engine & Conflict Arbitration Pipeline Tests
    from packages.shared.python.contracts.test_evidence_engine import TestEvidenceEngine
    suite_evid = unittest.TestLoader().loadTestsFromTestCase(TestEvidenceEngine)
    res_evid = runner.run(suite_evid)
    assert res_evid.wasSuccessful(), f"EvidenceEngine tests failed: {len(res_evid.errors)} errors, {len(res_evid.failures)} failures"
    total += res_evid.testsRun
    passed += res_evid.testsRun

    # 16. Outlets & Publication Security Gate Tests
    from packages.shared.python.contracts.test_outlets_engine import TestOutletsEngine
    suite_out = unittest.TestLoader().loadTestsFromTestCase(TestOutletsEngine)
    res_out = runner.run(suite_out)
    assert res_out.wasSuccessful(), f"OutletsEngine tests failed: {len(res_out.errors)} errors, {len(res_out.failures)} failures"
    total += res_out.testsRun
    passed += res_out.testsRun

    # 17. Outlets HTTP Router Tests
    from packages.shared.python.contracts.test_outlets_http import TestOutletsHttpRouter
    suite_http = unittest.TestLoader().loadTestsFromTestCase(TestOutletsHttpRouter)
    res_http = runner.run(suite_http)
    assert res_http.wasSuccessful(), f"OutletsHttpRouter tests failed: {len(res_http.errors)} errors, {len(res_http.failures)} failures"
    total += res_http.testsRun
    passed += res_http.testsRun

    print(f"\n=== Python Pydantic, Entity Adapter, Revision Storage & Evidence Engine & Outlets Gate & HTTP Router Test Suite Results ===")
    print(f"Total: {total}, Passed: {passed}, Failed: {total - passed}")
    print(f"ALL {total} PYTHON CHECKS PASSED!\n")


if __name__ == "__main__":
    run_tests()
