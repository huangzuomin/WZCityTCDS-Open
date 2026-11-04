"""Tests for Urban Spatio-Temporal Trusted Content Hub Entity Master Data Adapter (Python)."""
import unittest

from packages.shared.python.contracts.entity_lookup import (
    EntityCategory,
    EntityLookupRequest,
    EntityResolutionStatus,
    HubAdjudication,
    MatchedEntity,
    ProposalSourceEvidence,
    ProposalStatus,
    UnresolvedEntityProposal,
)
from packages.shared.python.contracts.hub_entity_adapter import (
    HubEntityAdapter,
    MockHubEntityTransport,
    assert_valid_entity_id,
)


class TestHubEntityAdapter(unittest.TestCase):
    def setUp(self) -> None:
        self.adapter = HubEntityAdapter()

    def test_01_assert_valid_entity_id(self) -> None:
        assert_valid_entity_id("ent_wz_lucheng_gov_001")
        assert_valid_entity_id("ent_abcdef123")
        assert_valid_entity_id("ent_wz-sanyang_wetland-99")

        with self.assertRaises(ValueError):
            assert_valid_entity_id("local_ent_001")

        with self.assertRaises(ValueError):
            assert_valid_entity_id("ENT_UPPERCASE_001")

    def test_02_lookup_exact_match_canonical(self) -> None:
        req = EntityLookupRequest(query_text="温州市鹿城区人民政府")
        resp = self.adapter.lookup_entity(req)
        self.assertEqual(resp.resolution_status, EntityResolutionStatus.EXACT_MATCH)
        self.assertEqual(resp.selected_entity_id, "ent_wz_lucheng_gov_001")
        self.assertGreaterEqual(resp.matches[0].confidence, 0.85)

    def test_03_lookup_exact_match_alias(self) -> None:
        req = EntityLookupRequest(query_text="五马街")
        resp = self.adapter.lookup_entity(req)
        self.assertEqual(resp.resolution_status, EntityResolutionStatus.EXACT_MATCH)
        self.assertEqual(resp.selected_entity_id, "ent_wz_wuma_street_002")
        self.assertEqual(resp.matches[0].canonical_name, "五马历史文化街区")

    def test_04_lookup_multiple_matches_ambiguous(self) -> None:
        req = EntityLookupRequest(query_text="温州人民医院")
        resp = self.adapter.lookup_entity(req)
        self.assertEqual(resp.resolution_status, EntityResolutionStatus.MULTIPLE_MATCHES)
        self.assertIsNone(resp.selected_entity_id)
        self.assertGreaterEqual(len(resp.matches), 2)

    def test_05_lookup_unresolved_not_found(self) -> None:
        req = EntityLookupRequest(query_text="南塘未定名未来科技浮空塔2099")
        resp = self.adapter.lookup_entity(req)
        self.assertEqual(resp.resolution_status, EntityResolutionStatus.UNRESOLVED_NOT_FOUND)
        self.assertIsNone(resp.selected_entity_id)
        self.assertEqual(len(resp.matches), 0)

    def test_06_submit_unresolved_proposal_success(self) -> None:
        evidence = ProposalSourceEvidence(
            source_doc_id="doc_wz_daily_20261104_001",
            context_snippet="温州城市未来创新中心今日在鹿城区正式揭牌成立。",
            evidence_span_hash="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        )
        prop = self.adapter.submit_unresolved_proposal(
            candidate_name="温州城市未来创新中心",
            source_evidence=evidence,
            suggested_aliases=["未来创新中心"],
            suggested_category=EntityCategory.ORGANIZATION,
        )
        self.assertTrue(prop.proposal_id.startswith("prop_"))
        self.assertEqual(prop.proposal_status, ProposalStatus.SUBMITTED)
        self.assertEqual(prop.proposer_system, "WZCityTCDS")

    def test_07_submit_proposal_invalid_hash_rejected(self) -> None:
        with self.assertRaises(Exception):
            self.adapter.submit_unresolved_proposal(
                candidate_name="非法哈希实体",
                source_evidence=ProposalSourceEvidence(
                    source_doc_id="doc_invalid_001",
                    context_snippet="片段",
                    evidence_span_hash="short-invalid-hash",
                ),
            )

    def test_08_apply_adjudication_accepted_allocated(self) -> None:
        evidence = ProposalSourceEvidence(
            source_doc_id="doc_001",
            context_snippet="片段",
            evidence_span_hash="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        )
        prop = self.adapter.submit_unresolved_proposal(
            candidate_name="测试实体",
            source_evidence=evidence,
        )
        adj = HubAdjudication(
            allocated_entity_id="ent_wz_future_center_001",
            canonical_name="温州城市未来创新中心",
            resolution_notes="建档通过",
        )
        updated = self.adapter.apply_adjudication(
            prop,
            ProposalStatus.ACCEPTED_ALLOCATED,
            adj,
        )
        self.assertEqual(updated.proposal_status, ProposalStatus.ACCEPTED_ALLOCATED)
        self.assertEqual(updated.hub_adjudication.allocated_entity_id, "ent_wz_future_center_001")

    def test_09_apply_adjudication_merged_as_alias(self) -> None:
        evidence = ProposalSourceEvidence(
            source_doc_id="doc_001",
            context_snippet="片段",
            evidence_span_hash="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        )
        prop = self.adapter.submit_unresolved_proposal(
            candidate_name="生态园公园",
            source_evidence=evidence,
        )
        adj = HubAdjudication(
            allocated_entity_id="ent_wz_sanyang_wetland_003",
            canonical_name="三垟湿地公园",
            resolution_notes="作为别名合并",
        )
        updated = self.adapter.apply_adjudication(
            prop,
            ProposalStatus.MERGED_AS_ALIAS,
            adj,
        )
        self.assertEqual(updated.proposal_status, ProposalStatus.MERGED_AS_ALIAS)
        self.assertEqual(updated.hub_adjudication.allocated_entity_id, "ent_wz_sanyang_wetland_003")

    def test_10_apply_adjudication_rejected(self) -> None:
        evidence = ProposalSourceEvidence(
            source_doc_id="doc_001",
            context_snippet="片段",
            evidence_span_hash="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        )
        prop = self.adapter.submit_unresolved_proposal(
            candidate_name="活动标语词",
            source_evidence=evidence,
        )
        adj = HubAdjudication(
            resolution_notes="非实体驳回",
        )
        updated = self.adapter.apply_adjudication(
            prop,
            ProposalStatus.REJECTED,
            adj,
        )
        self.assertEqual(updated.proposal_status, ProposalStatus.REJECTED)

    def test_11_caching_behavior(self) -> None:
        call_count = 0
        transport = MockHubEntityTransport()
        orig_lookup = transport.lookup

        def counting_lookup(msg):
            nonlocal call_count
            call_count += 1
            return orig_lookup(msg)

        transport.lookup = counting_lookup

        adapter = HubEntityAdapter(transport=transport, enable_cache=True)
        req = EntityLookupRequest(query_text="温州市鹿城区人民政府")

        # 1st call: transport called
        adapter.lookup_entity(req)
        self.assertEqual(call_count, 1)

        # 2nd call: cache hit
        adapter.lookup_entity(req)
        self.assertEqual(call_count, 1)

        # 3rd call: bypass cache
        adapter.lookup_entity(req, bypass_cache=True)
        self.assertEqual(call_count, 2)

    def test_12_option_a_invariant_rejects_illegal_entity_id(self) -> None:
        evidence = ProposalSourceEvidence(
            source_doc_id="doc_001",
            context_snippet="片段",
            evidence_span_hash="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        )
        prop = self.adapter.submit_unresolved_proposal(
            candidate_name="非法实体",
            source_evidence=evidence,
        )
        with self.assertRaises(ValueError):
            self.adapter.apply_adjudication(
                prop,
                ProposalStatus.ACCEPTED_ALLOCATED,
                HubAdjudication(
                    allocated_entity_id="local_illegal_id_001",
                    canonical_name="非法",
                ),
            )


if __name__ == "__main__":
    unittest.main()
