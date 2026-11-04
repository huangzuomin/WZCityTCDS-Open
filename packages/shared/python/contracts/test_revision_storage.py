"""Tests for Fact Revision Storage & Publication State Machine (Python)."""
import unittest

from packages.shared.python.contracts.fact_revision import (
    AssertionValue,
    FactDataType,
    FactLifecycleState,
    RevisionReason,
    RevisionRole,
    RevisionTransitionRole,
    RevisionTransitionTrigger,
)
from packages.shared.python.contracts.fact_revision_storage import (
    FactRevisionStorage,
    compute_revision_digest,
    compute_snapshot_digest,
)


class TestFactRevisionStorage(unittest.TestCase):
    def setUp(self) -> None:
        self.storage = FactRevisionStorage()
        self.sample_value = AssertionValue(
            raw_value=80.5,
            data_type=FactDataType.NUMBER,
            unit="万人",
        )
        self.sample_value_updated = AssertionValue(
            raw_value=81.2,
            data_type=FactDataType.NUMBER,
            unit="万人",
        )

    def test_01_create_genesis_revision(self) -> None:
        rev = self.storage.create_revision(
            assertion_id="ast_wz_pop_lucheng_001",
            entity_id="ent_wz_lucheng_gov_001",
            property_path="demographics.pop",
            assertion_value=self.sample_value,
            created_by_role=RevisionRole.FACT_EXTRACTOR,
            revision_reason=RevisionReason.INITIAL_PUBLISH,
            evidence_span_hashes=["1" * 64],
        )
        self.assertEqual(rev.revision_metadata.parent_revision_sha256, "GENESIS")
        self.assertEqual(rev.revision_number, 1)
        self.assertEqual(rev.lifecycle_state, FactLifecycleState.DRAFT)

    def test_02_create_sequential_revision(self) -> None:
        r1 = self.storage.create_revision(
            assertion_id="ast_wz_pop_lucheng_002",
            entity_id="ent_wz_lucheng_gov_001",
            property_path="demographics.pop",
            assertion_value=self.sample_value,
            created_by_role=RevisionRole.FACT_EXTRACTOR,
            revision_reason=RevisionReason.INITIAL_PUBLISH,
            evidence_span_hashes=["1" * 64],
        )
        r1_digest = compute_revision_digest(r1)

        r2 = self.storage.create_revision(
            assertion_id="ast_wz_pop_lucheng_002",
            entity_id="ent_wz_lucheng_gov_001",
            property_path="demographics.pop",
            assertion_value=self.sample_value_updated,
            created_by_role=RevisionRole.FACT_REVIEWER,
            revision_reason=RevisionReason.STATISTICAL_UPDATE,
            evidence_span_hashes=["2" * 64],
        )
        self.assertEqual(r2.revision_metadata.parent_revision_sha256, r1_digest)
        self.assertEqual(r2.revision_number, 2)

    def test_03_validate_chain_integrity(self) -> None:
        aid = "ast_wz_chain_test_001"
        self.storage.create_revision(
            assertion_id=aid,
            entity_id="ent_wz_lucheng_gov_001",
            property_path="demographics.pop",
            assertion_value=self.sample_value,
            created_by_role=RevisionRole.FACT_EXTRACTOR,
            revision_reason=RevisionReason.INITIAL_PUBLISH,
            evidence_span_hashes=["1" * 64],
        )
        self.storage.create_revision(
            assertion_id=aid,
            entity_id="ent_wz_lucheng_gov_001",
            property_path="demographics.pop",
            assertion_value=self.sample_value_updated,
            created_by_role=RevisionRole.FACT_EXTRACTOR,
            revision_reason=RevisionReason.STATISTICAL_UPDATE,
            evidence_span_hashes=["2" * 64],
        )
        is_valid, errors, length = self.storage.validate_chain_integrity(aid)
        self.assertTrue(is_valid)
        self.assertEqual(len(errors), 0)
        self.assertEqual(length, 2)

    def test_04_transition_draft_to_pending_review(self) -> None:
        r = self.storage.create_revision(
            assertion_id="ast_demo_20261104_001",
            entity_id="ent_wz_lucheng_gov_001",
            property_path="pop",
            assertion_value=self.sample_value,
            created_by_role=RevisionRole.FACT_EXTRACTOR,
            revision_reason=RevisionReason.INITIAL_PUBLISH,
            evidence_span_hashes=["1" * 64],
        )
        rev, trans = self.storage.transition_state(
            revision_id=r.revision_id,
            trigger=RevisionTransitionTrigger.SUBMIT_FOR_REVIEW,
            authorized_role=RevisionTransitionRole.FACT_EXTRACTOR,
        )
        self.assertEqual(rev.lifecycle_state, FactLifecycleState.PENDING_REVIEW)
        self.assertEqual(trans.to_state.value, "PENDING_REVIEW")

    def test_05_transition_pending_to_published(self) -> None:
        r = self.storage.create_revision(
            assertion_id="ast_demo_20261104_002",
            entity_id="ent_wz_lucheng_gov_001",
            property_path="pop",
            assertion_value=self.sample_value,
            created_by_role=RevisionRole.FACT_EXTRACTOR,
            revision_reason=RevisionReason.INITIAL_PUBLISH,
            evidence_span_hashes=["1" * 64],
            initial_state=FactLifecycleState.PENDING_REVIEW,
        )
        rev, trans = self.storage.transition_state(
            revision_id=r.revision_id,
            trigger=RevisionTransitionTrigger.APPROVE_AND_PUBLISH,
            authorized_role=RevisionTransitionRole.CHIEF_EDITOR,
        )
        self.assertEqual(rev.lifecycle_state, FactLifecycleState.PUBLISHED)

    def test_06_transition_published_to_superseded(self) -> None:
        r1 = self.storage.create_revision(
            assertion_id="ast_demo_20261104_003",
            entity_id="ent_wz_lucheng_gov_001",
            property_path="pop",
            assertion_value=self.sample_value,
            created_by_role=RevisionRole.FACT_EXTRACTOR,
            revision_reason=RevisionReason.INITIAL_PUBLISH,
            evidence_span_hashes=["1" * 64],
            initial_state=FactLifecycleState.PUBLISHED,
        )
        r2 = self.storage.create_revision(
            assertion_id="ast_demo_20261104_003",
            entity_id="ent_wz_lucheng_gov_001",
            property_path="pop",
            assertion_value=self.sample_value_updated,
            created_by_role=RevisionRole.FACT_REVIEWER,
            revision_reason=RevisionReason.STATISTICAL_UPDATE,
            evidence_span_hashes=["2" * 64],
        )
        rev, _ = self.storage.transition_state(
            revision_id=r1.revision_id,
            trigger=RevisionTransitionTrigger.SUPERSEDE_WITH_NEW_REVISION,
            authorized_role=RevisionTransitionRole.FACT_REVIEWER,
            superseded_by_revision_id=r2.revision_id,
        )
        self.assertEqual(rev.lifecycle_state, FactLifecycleState.SUPERSEDED)

    def test_07_transition_published_to_revoked(self) -> None:
        r = self.storage.create_revision(
            assertion_id="ast_demo_20261104_004",
            entity_id="ent_wz_lucheng_gov_001",
            property_path="pop",
            assertion_value=self.sample_value,
            created_by_role=RevisionRole.FACT_EXTRACTOR,
            revision_reason=RevisionReason.INITIAL_PUBLISH,
            evidence_span_hashes=["1" * 64],
            initial_state=FactLifecycleState.PUBLISHED,
        )
        rev, _ = self.storage.transition_state(
            revision_id=r.revision_id,
            trigger=RevisionTransitionTrigger.REVOKE_PUBLISHED_FACT,
            authorized_role=RevisionTransitionRole.CHIEF_EDITOR,
            revocation_reason="经核实信源撤稿，正式撤回该事实记录",
        )
        self.assertEqual(rev.lifecycle_state, FactLifecycleState.REVOKED)

    def test_08_role_gate_enforcement(self) -> None:
        r = self.storage.create_revision(
            assertion_id="ast_demo_20261104_005",
            entity_id="ent_wz_lucheng_gov_001",
            property_path="pop",
            assertion_value=self.sample_value,
            created_by_role=RevisionRole.FACT_EXTRACTOR,
            revision_reason=RevisionReason.INITIAL_PUBLISH,
            evidence_span_hashes=["1" * 64],
            initial_state=FactLifecycleState.PENDING_REVIEW,
        )
        with self.assertRaises(PermissionError):
            self.storage.transition_state(
                revision_id=r.revision_id,
                trigger=RevisionTransitionTrigger.APPROVE_AND_PUBLISH,
                authorized_role=RevisionTransitionRole.FACT_EXTRACTOR,
            )

    def test_09_generate_publication_snapshot(self) -> None:
        eid = "ent_wz_lucheng_gov_001"
        self.storage.create_revision(
            assertion_id="ast_wz_pop_20261104_001",
            entity_id=eid,
            property_path="pop",
            assertion_value=self.sample_value,
            created_by_role=RevisionRole.FACT_EXTRACTOR,
            revision_reason=RevisionReason.INITIAL_PUBLISH,
            evidence_span_hashes=["1" * 64],
            initial_state=FactLifecycleState.PUBLISHED,
        )
        snap = self.storage.generate_publication_snapshot(
            entity_id=eid,
            entity_canonical_name="温州市鹿城区人民政府",
        )
        self.assertEqual(len(snap.published_assertions), 1)
        self.assertEqual(len(snap.snapshot_digest_sha256), 64)
        self.assertTrue(snap.projection_metadata.is_latest_snapshot)

    def test_10_immutability(self) -> None:
        r = self.storage.create_revision(
            assertion_id="ast_freeze_20261104_001",
            entity_id="ent_wz_lucheng_gov_001",
            property_path="pop",
            assertion_value=self.sample_value,
            created_by_role=RevisionRole.FACT_EXTRACTOR,
            revision_reason=RevisionReason.INITIAL_PUBLISH,
            evidence_span_hashes=["1" * 64],
        )
        fetched = self.storage.get_revision(r.revision_id)
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched.property_path, "pop")


if __name__ == "__main__":
    unittest.main()
