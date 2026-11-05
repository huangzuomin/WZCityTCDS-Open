"""
Unit tests for Hub Projection & Changes Stream Consumer (Python mirror - Slice R3)
"""
import json
import unittest
from packages.shared.python.contracts.hub_projection import (
    HubProjectionTarget,
    HubProjectionPayload,
    HubProjectionReceipt,
    HubProjectionReceiptStatus,
    HubUpstreamChangeType,
    HubUpstreamChangeEvent,
    MockHubProjectionTransport,
    HubOneWayProjector,
    ChangesStreamConsumer,
    compute_upstream_change_digest,
    compute_receipt_signature,
    assert_valid_entity_id,
)
from packages.shared.python.contracts.fact_revision import (
    PublicationSnapshot,
    PublishedAssertionItem,
    ProjectionMetadata,
    OutletScope,
)
from packages.shared.python.contracts.outlets import (
    PublicationSecurityGatePolicy,
    GateVerdict,
    RuleEvaluations,
    ChangesStreamEvent,
    StreamChangeType,
    AffectedRevision,
)


class TestHubProjection(unittest.TestCase):
    def setUp(self):
        self.valid_entity_id = "ent_wz_lucheng_gov_001"
        self.mock_snapshot = PublicationSnapshot(
            publication_id="pub_test_snapshot_001",
            snapshot_revision_id="pubrev_test_snapshot_rev_001",
            entity_id=self.valid_entity_id,
            entity_canonical_name="温州市鹿城区人民政府",
            generated_at="2026-11-05T01:00:00Z",
            snapshot_digest_sha256="a" * 64,
            published_assertions=[
                PublishedAssertionItem(
                    assertion_id="ast_population_001",
                    revision_id="rev_ast_001",
                    property_path="demographics.population",
                    raw_value=1200000,
                    evidence_hashes=["b" * 64],
                )
            ],
            projection_metadata=ProjectionMetadata(
                kernel_system="WZCityTCDS-PublicationKernel",
                publisher_role="CHIEF_FACT_EDITOR",
                outlet_scopes=[OutletScope.HUB_ONE_WAY_PROJECTION],
                is_latest_snapshot=True,
            ),
        )

        self.passing_gate = PublicationSecurityGatePolicy(
            gate_evaluation_id="gate_eval_pass_001",
            snapshot_revision_id=self.mock_snapshot.snapshot_revision_id,
            evaluated_at="2026-11-05T01:00:01Z",
            gate_verdict=GateVerdict.PASS_APPROVED_FOR_RELEASE,
            rule_evaluations=RuleEvaluations(
                rule_only_published_state={"passed": True, "non_published_count": 0},
                rule_evidence_receipt_pass={"passed": True, "unverified_assertion_count": 0},
                rule_no_private_ip_leaks={"passed": True, "detected_matches": []},
                rule_no_credential_patterns={"passed": True, "suspicious_token_count": 0},
                rule_source_validity_confirmed={"passed": True, "retracted_source_count": 0},
            ),
        )

        self.failing_gate = PublicationSecurityGatePolicy(
            gate_evaluation_id="gate_eval_fail_002",
            snapshot_revision_id=self.mock_snapshot.snapshot_revision_id,
            evaluated_at="2026-11-05T01:00:01Z",
            gate_verdict=GateVerdict.FAIL_CLOSED_BLOCKED,
            rule_evaluations=RuleEvaluations(
                rule_only_published_state={"passed": True, "non_published_count": 0},
                rule_evidence_receipt_pass={"passed": False, "unverified_assertion_count": 1},
                rule_no_private_ip_leaks={"passed": True, "detected_matches": []},
                rule_no_credential_patterns={"passed": True, "suspicious_token_count": 0},
                rule_source_validity_confirmed={"passed": True, "retracted_source_count": 0},
            ),
        )

    def test_01_project_snapshot_success(self):
        projector = HubOneWayProjector()
        receipt = projector.project_snapshot(self.mock_snapshot)
        self.assertEqual(receipt.status, HubProjectionReceiptStatus.ACCEPTED)
        self.assertTrue(receipt.receipt_id.startswith("rcpt_"))
        self.assertTrue(receipt.hub_slot_id.startswith("slot_"))
        self.assertEqual(len(receipt.receipt_signature_sha256), 64)

    def test_02_project_snapshot_invalid_entity_id_fails(self):
        projector = HubOneWayProjector()
        bad_snapshot = self.mock_snapshot.model_copy(update={"entity_id": "invalid-entity-id"})
        with self.assertRaises(ValueError):
            projector.project_snapshot(bad_snapshot)

    def test_03_project_snapshot_failing_gate_fails_closed(self):
        projector = HubOneWayProjector()
        with self.assertRaises(ValueError) as ctx:
            projector.project_snapshot(self.mock_snapshot, gate_policy=self.failing_gate)
        self.assertIn("Security gate fail-closed", str(ctx.exception))

    def test_04_project_snapshot_passing_gate_records_history(self):
        projector = HubOneWayProjector()
        receipt = projector.project_snapshot(self.mock_snapshot, gate_policy=self.passing_gate)
        self.assertEqual(receipt.status, HubProjectionReceiptStatus.ACCEPTED)
        history = projector.get_history(self.valid_entity_id)
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0].receipt_id, receipt.receipt_id)

    def test_05_project_snapshot_empty_assertions_fails(self):
        projector = HubOneWayProjector()
        bad_snapshot = self.mock_snapshot.model_copy(update={"published_assertions": []})
        with self.assertRaises(ValueError) as ctx:
            projector.project_snapshot(bad_snapshot)
        self.assertIn("zero published assertions", str(ctx.exception))

    def test_06_mock_transport_failure_produces_rejected_receipt(self):
        transport = MockHubProjectionTransport()
        transport.should_fail = True
        transport.failure_reason = "Simulated downstream unreachable"
        projector = HubOneWayProjector(transport)
        receipt = projector.project_snapshot(self.mock_snapshot)
        self.assertEqual(receipt.status, HubProjectionReceiptStatus.REJECTED)
        self.assertEqual(receipt.rejection_reason, "Simulated downstream unreachable")

    def test_07_get_latest_receipt(self):
        projector = HubOneWayProjector()
        r1 = projector.project_snapshot(self.mock_snapshot)
        r2 = projector.project_snapshot(self.mock_snapshot)
        latest = projector.get_latest_receipt(self.valid_entity_id)
        self.assertIsNotNone(latest)
        self.assertEqual(latest.receipt_id, r2.receipt_id)

    def test_08_consume_hub_event_created(self):
        consumer = ChangesStreamConsumer()
        raw = {
            "hub_change_event_id": "hchg_init_001_12345678",
            "hub_sequence_num": 1,
            "change_type": "ENTITY_CREATED",
            "entity_id": self.valid_entity_id,
            "canonical_name": "温州市鹿城区人民政府",
            "aliases": ["鹿城区政府"],
            "category": "ADMIN_DIVISION",
            "spatial_coordinates": {"longitude": 120.655, "latitude": 28.016},
            "timestamp": "2026-11-05T01:10:00Z",
        }
        digest = compute_upstream_change_digest(raw)
        raw["digest_sha256"] = digest

        res = consumer.consume_hub_event(raw)
        self.assertTrue(res["applied"])
        self.assertEqual(consumer.get_hub_cursor(), 1)
        state = consumer.get_entity_state(self.valid_entity_id)
        self.assertIsNotNone(state)
        self.assertEqual(state["canonical_name"], "温州市鹿城区人民政府")
        self.assertEqual(state["category"], "ADMIN_DIVISION")
        self.assertFalse(state["is_tombstoned"])

    def test_09_consume_hub_event_updated(self):
        consumer = ChangesStreamConsumer(initial_hub_seq=1)
        raw_init = {
            "hub_change_event_id": "hchg_init_002_12345678",
            "hub_sequence_num": 2,
            "change_type": "ENTITY_CREATED",
            "entity_id": self.valid_entity_id,
            "canonical_name": "温州市鹿城区政府",
            "aliases": ["鹿城区政府"],
            "category": "ADMIN_DIVISION",
            "timestamp": "2026-11-05T01:10:00Z",
        }
        raw_init["digest_sha256"] = compute_upstream_change_digest(raw_init)
        consumer.consume_hub_event(raw_init)

        raw_upd = {
            "hub_change_event_id": "hchg_upd_003_12345678",
            "hub_sequence_num": 3,
            "change_type": "ENTITY_UPDATED",
            "entity_id": self.valid_entity_id,
            "canonical_name": "温州市鹿城区人民政府 (正式)",
            "aliases": ["鹿城区人民政府", "鹿城区政府"],
            "category": "ADMIN_DIVISION",
            "timestamp": "2026-11-05T01:15:00Z",
        }
        raw_upd["digest_sha256"] = compute_upstream_change_digest(raw_upd)
        consumer.consume_hub_event(raw_upd)

        state = consumer.get_entity_state(self.valid_entity_id)
        self.assertEqual(state["canonical_name"], "温州市鹿城区人民政府 (正式)")
        self.assertIn("鹿城区人民政府", state["aliases"])

    def test_10_consume_hub_event_merged_into(self):
        consumer = ChangesStreamConsumer()
        source = "ent_wz_old_poi_0099"
        target = "ent_wz_new_poi_0100"
        raw = {
            "hub_change_event_id": "hchg_mrg_004_12345678",
            "hub_sequence_num": 1,
            "change_type": "MERGED_INTO",
            "entity_id": source,
            "canonical_name": "旧五马商厦",
            "aliases": [],
            "category": "POI",
            "target_merged_entity_id": target,
            "timestamp": "2026-11-05T01:20:00Z",
        }
        raw["digest_sha256"] = compute_upstream_change_digest(raw)
        consumer.consume_hub_event(raw)

        self.assertTrue(consumer.is_tombstoned(source))
        state = consumer.get_entity_state(source)
        self.assertEqual(state["merged_into_entity_id"], target)

    def test_11_consume_hub_event_tombstoned(self):
        consumer = ChangesStreamConsumer()
        raw = {
            "hub_change_event_id": "hchg_tmb_005_12345678",
            "hub_sequence_num": 1,
            "change_type": "TOMBSTONED",
            "entity_id": self.valid_entity_id,
            "canonical_name": "温州市鹿城区人民政府",
            "aliases": [],
            "category": "ADMIN_DIVISION",
            "tombstone_reason": "Demolished or revoked by civil affairs office",
            "timestamp": "2026-11-05T01:25:00Z",
        }
        raw["digest_sha256"] = compute_upstream_change_digest(raw)
        consumer.consume_hub_event(raw)

        self.assertTrue(consumer.is_tombstoned(self.valid_entity_id))
        state = consumer.get_entity_state(self.valid_entity_id)
        self.assertEqual(state["tombstone_reason"], "Demolished or revoked by civil affairs office")

    def test_12_consume_hub_event_skips_duplicates(self):
        consumer = ChangesStreamConsumer(initial_hub_seq=10)
        raw = {
            "hub_change_event_id": "hchg_stale_006_12345",
            "hub_sequence_num": 8,
            "change_type": "ENTITY_CREATED",
            "entity_id": self.valid_entity_id,
            "canonical_name": "Stale",
            "aliases": [],
            "category": "POI",
            "timestamp": "2026-11-05T01:30:00Z",
        }
        raw["digest_sha256"] = compute_upstream_change_digest(raw)
        res = consumer.consume_hub_event(raw)
        self.assertFalse(res["applied"])
        self.assertIn("Duplicate or stale", res["reason"])
        self.assertEqual(consumer.get_stats()["skipped_duplicates"], 1)

    def test_13_consume_hub_event_detects_digest_mismatch(self):
        consumer = ChangesStreamConsumer()
        raw = {
            "hub_change_event_id": "hchg_tamper_007_1234",
            "hub_sequence_num": 1,
            "change_type": "ENTITY_CREATED",
            "entity_id": self.valid_entity_id,
            "canonical_name": "Tampered",
            "aliases": [],
            "category": "POI",
            "timestamp": "2026-11-05T01:35:00Z",
            "digest_sha256": "0" * 64,
        }
        with self.assertRaises(ValueError) as ctx:
            consumer.consume_hub_event(raw)
        self.assertIn("Event digest mismatch", str(ctx.exception))

    def test_14_consume_outlet_fact_event(self):
        consumer = ChangesStreamConsumer()
        event = ChangesStreamEvent(
            change_event_id="chg_outlet_008_12345678",
            change_sequence_num=1,
            change_type=StreamChangeType.FACT_PUBLISHED,
            entity_id=self.valid_entity_id,
            event_timestamp="2026-11-05T01:40:00Z",
            event_digest_sha256="c" * 64,
            affected_revision=AffectedRevision(
                revision_id="rev_pop_001",
                property_path="demographics.population",
                lifecycle_state="PUBLISHED",
            ),
        )
        res = consumer.consume_outlet_event(event)
        self.assertTrue(res["applied"])
        state = consumer.get_entity_state(self.valid_entity_id)
        self.assertEqual(state["published_facts"]["demographics.population"]["revision_id"], "rev_pop_001")

    def test_15_consume_ndjson_and_dead_letters(self):
        consumer = ChangesStreamConsumer()
        raw1 = {
            "hub_change_event_id": "hchg_line1_009_12345678",
            "hub_sequence_num": 1,
            "change_type": "ENTITY_CREATED",
            "entity_id": "ent_wz_first_poi_001",
            "canonical_name": "首座地标",
            "aliases": [],
            "category": "POI",
            "timestamp": "2026-11-05T01:45:00Z",
        }
        raw1["digest_sha256"] = compute_upstream_change_digest(raw1)
        line1 = json.dumps(raw1)

        raw2 = {
            "hub_change_event_id": "hchg_line2_010_12345678",
            "hub_sequence_num": 2,
            "change_type": "ENTITY_CREATED",
            "entity_id": "ent_wz_second_poi_002",
            "canonical_name": "次座地标",
            "aliases": [],
            "category": "POI",
            "timestamp": "2026-11-05T01:45:01Z",
        }
        raw2["digest_sha256"] = compute_upstream_change_digest(raw2)
        line2 = json.dumps(raw2)

        bad_line = '{"corrupted": true'
        ndjson = f"{line1}\n\n{bad_line}\n{line2}\n"

        summary = consumer.consume_ndjson(ndjson, "HUB_UPSTREAM")
        self.assertEqual(summary["processed"], 2)
        self.assertEqual(summary["dead_letters"], 1)
        self.assertEqual(len(consumer.get_dead_letters()), 1)
        self.assertIsNotNone(consumer.get_entity_state("ent_wz_first_poi_001"))
        self.assertIsNotNone(consumer.get_entity_state("ent_wz_second_poi_002"))


if __name__ == "__main__":
    unittest.main()
