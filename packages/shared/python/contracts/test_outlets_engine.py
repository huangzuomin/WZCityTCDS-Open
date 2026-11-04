"""Unit tests for PublicationSecurityGate, OutletDeliveryProjector, and ChangesStreamManager."""
import json
import unittest
from packages.shared.python.contracts.outlets import (
    OutletChannel,
    PayloadFormat,
    DeliveryStatus,
    GateVerdict,
    StreamChangeType,
    AffectedRevision,
)
from packages.shared.python.contracts.fact_revision import PublicationSnapshot
from packages.shared.python.contracts.outlets_engine import (
    PublicationSecurityGate,
    OutletDeliveryProjector,
    ChangesStreamManager,
)


class TestOutletsEngine(unittest.TestCase):
    def setUp(self):
        self.gate = PublicationSecurityGate()
        self.projector = OutletDeliveryProjector(default_base_url="https://facts.wenzhou.gov.cn")
        self.stream_manager = ChangesStreamManager()

        self.valid_snapshot = PublicationSnapshot(
            publication_id="pub_wenzhou_gdp_20261104_001",
            snapshot_revision_id="pubrev_wenzhou_20261104_v1",
            entity_id="ent_wenzhou_330300",
            generated_at="2026-11-04T10:00:00.000Z",
            snapshot_digest_sha256="a" * 64,
            published_assertions=[
                {
                    "assertion_id": "ast_gdp_annual_2026_wz",
                    "revision_id": "rev_gdp_2026_v001",
                    "property_path": "economy.gdp.annual",
                    "raw_value": 7120.5,
                    "evidence_hashes": ["b" * 64],
                }
            ],
            projection_metadata={
                "kernel_system": "WZCityTCDS-PublicationKernel",
                "publisher_role": "CHIEF_FACT_EDITOR",
                "outlet_scopes": ["HUB_ONE_WAY_PROJECTION"],
                "is_latest_snapshot": True,
            },
        )

        self.valid_assertions = [
            {
                "assertion_id": "ast_gdp_annual_2026_wz",
                "lifecycle_state": "PUBLISHED",
                "evidence_hashes": ["b" * 64],
                "raw_value": 7120.5,
                "source_doc_ids": ["news_valid_doc_001"],
            }
        ]

        self.valid_receipts = {
            "ast_gdp_annual_2026_wz": {"overall_verification_verdict": "PASS"}
        }

    def test_evaluate_clean_pass(self):
        policy = self.gate.evaluate(
            snapshot_revision_id=self.valid_snapshot.snapshot_revision_id,
            assertions=self.valid_assertions,
            evidence_receipts=self.valid_receipts,
        )
        self.assertEqual(policy.gate_verdict, GateVerdict.PASS_APPROVED_FOR_RELEASE)
        self.assertTrue(policy.rule_evaluations.rule_only_published_state["passed"])
        self.assertTrue(policy.rule_evaluations.rule_evidence_receipt_pass["passed"])
        self.assertTrue(policy.rule_evaluations.rule_no_private_ip_leaks["passed"])
        self.assertTrue(policy.rule_evaluations.rule_no_credential_patterns["passed"])
        self.assertTrue(policy.rule_evaluations.rule_source_validity_confirmed["passed"])

    def test_evaluate_blocks_non_published(self):
        bad_assertions = [
            {"assertion_id": "ast_draft_01", "lifecycle_state": "DRAFT", "source_doc_ids": ["doc_1"]}
        ]
        policy = self.gate.evaluate(
            snapshot_revision_id=self.valid_snapshot.snapshot_revision_id,
            assertions=bad_assertions,
            evidence_receipts=self.valid_receipts,
        )
        self.assertEqual(policy.gate_verdict, GateVerdict.FAIL_CLOSED_BLOCKED)
        self.assertFalse(policy.rule_evaluations.rule_only_published_state["passed"])
        self.assertEqual(policy.rule_evaluations.rule_only_published_state["non_published_count"], 1)

    def test_evaluate_blocks_unverified(self):
        policy = self.gate.evaluate(
            snapshot_revision_id=self.valid_snapshot.snapshot_revision_id,
            assertions=self.valid_assertions,
            evidence_receipts={},  # missing receipt
        )
        self.assertEqual(policy.gate_verdict, GateVerdict.FAIL_CLOSED_BLOCKED)
        self.assertFalse(policy.rule_evaluations.rule_evidence_receipt_pass["passed"])

    def test_evaluate_blocks_ip_leaks(self):
        leaked = "Host 192.168.214.53 and backend.cluster.internal"
        policy = self.gate.evaluate(
            snapshot_revision_id=self.valid_snapshot.snapshot_revision_id,
            assertions=self.valid_assertions,
            evidence_receipts=self.valid_receipts,
            raw_payload_text=leaked,
        )
        self.assertEqual(policy.gate_verdict, GateVerdict.FAIL_CLOSED_BLOCKED)
        self.assertFalse(policy.rule_evaluations.rule_no_private_ip_leaks["passed"])
        self.assertIn("192.168.214.53", policy.rule_evaluations.rule_no_private_ip_leaks["detected_matches"])

    def test_evaluate_blocks_credentials(self):
        secret = "Bearer sk-live12345678901234567890abcdef and ghp_" + "x" * 36
        policy = self.gate.evaluate(
            snapshot_revision_id=self.valid_snapshot.snapshot_revision_id,
            assertions=self.valid_assertions,
            evidence_receipts=self.valid_receipts,
            raw_payload_text=secret,
        )
        self.assertEqual(policy.gate_verdict, GateVerdict.FAIL_CLOSED_BLOCKED)
        self.assertFalse(policy.rule_evaluations.rule_no_credential_patterns["passed"])

    def test_evaluate_blocks_retracted_source(self):
        policy = self.gate.evaluate(
            snapshot_revision_id=self.valid_snapshot.snapshot_revision_id,
            assertions=self.valid_assertions,
            evidence_receipts=self.valid_receipts,
            retracted_source_doc_ids=["news_valid_doc_001"],
        )
        self.assertEqual(policy.gate_verdict, GateVerdict.FAIL_CLOSED_BLOCKED)
        self.assertFalse(policy.rule_evaluations.rule_source_validity_confirmed["passed"])

    def test_evaluate_fails_closed_on_error(self):
        policy = self.gate.evaluate(
            snapshot_revision_id="pubrev_error_00000001",
            assertions=None,
            evidence_receipts=None,
        )
        self.assertEqual(policy.gate_verdict, GateVerdict.FAIL_CLOSED_BLOCKED)

    def test_project_snapshot_html(self):
        delivery = self.projector.project_snapshot(
            self.valid_snapshot, channel=OutletChannel.PUBLIC_HTML_ARCHIVE
        )
        self.assertEqual(delivery.outlet_channel, OutletChannel.PUBLIC_HTML_ARCHIVE)
        self.assertEqual(delivery.payload_format, PayloadFormat.HTML)
        self.assertEqual(delivery.delivery_status, DeliveryStatus.ACTIVE_CURRENT)
        self.assertEqual(delivery.cache_control.cache_policy, "PUBLIC_REVALIDATE")

    def test_project_snapshot_api_and_mcp(self):
        api = self.projector.project_snapshot(self.valid_snapshot, channel=OutletChannel.REST_API_V1)
        mcp = self.projector.project_snapshot(self.valid_snapshot, channel=OutletChannel.LLM_MCP_ENDPOINT)
        self.assertEqual(api.payload_format, PayloadFormat.JSON)
        self.assertEqual(mcp.payload_format, PayloadFormat.JSON)
        self.assertEqual(api.entity_id, self.valid_snapshot.entity_id)

    def test_project_snapshot_superseded(self):
        delivery = self.projector.project_snapshot(
            self.valid_snapshot, channel=OutletChannel.REST_API_V1, is_superseded=True
        )
        self.assertEqual(delivery.delivery_status, DeliveryStatus.SUPERSEDED_HISTORICAL)
        self.assertEqual(delivery.cache_control.cache_policy, "PUBLIC_IMMUTABLE")

    def test_project_tombstone(self):
        tombstone = self.projector.project_tombstone(
            channel=OutletChannel.REST_API_V1,
            publication_id=self.valid_snapshot.publication_id,
            snapshot_revision_id=self.valid_snapshot.snapshot_revision_id,
            entity_id=self.valid_snapshot.entity_id,
            snapshot_digest_sha256=self.valid_snapshot.snapshot_digest_sha256,
            revocation_notice="Revoked following source article correction.",
        )
        self.assertEqual(tombstone.delivery_status, DeliveryStatus.REVOKED_TOMBSTONE)
        self.assertEqual(tombstone.tombstone_details.http_status_code, 410)
        self.assertEqual(tombstone.cache_control.cache_policy, "NO_STORE")

    def test_render_payload_json_ld(self):
        rendered = self.projector.render_payload(self.valid_snapshot, OutletChannel.JSON_LD_CARD)
        data = json.loads(rendered)
        self.assertEqual(data["@context"], "https://schema.org")
        self.assertEqual(data["@type"], "City")

    def test_emit_event_monotonic(self):
        evt1 = self.stream_manager.emit_event(
            change_type=StreamChangeType.FACT_PUBLISHED,
            entity_id="ent_wenzhou_330300",
            affected_revision=AffectedRevision(
                revision_id="rev_001",
                property_path="economy.gdp.annual",
                lifecycle_state="PUBLISHED",
            ),
        )
        evt2 = self.stream_manager.emit_event(
            change_type=StreamChangeType.FACT_CORRECTED,
            entity_id="ent_wenzhou_330300",
            affected_revision=AffectedRevision(
                revision_id="rev_002",
                property_path="economy.gdp.annual",
                lifecycle_state="PUBLISHED",
            ),
        )
        self.assertEqual(evt1.change_sequence_num, 1)
        self.assertEqual(evt2.change_sequence_num, 2)
        self.assertEqual(len(evt1.event_digest_sha256), 64)

    def test_serialize_ndjson(self):
        self.stream_manager.emit_event(
            change_type=StreamChangeType.FACT_PUBLISHED,
            entity_id="ent_wenzhou_330300",
            affected_revision=AffectedRevision(
                revision_id="rev_001",
                property_path="economy.gdp.annual",
                lifecycle_state="PUBLISHED",
            ),
        )
        self.stream_manager.emit_event(
            change_type=StreamChangeType.FACT_CORRECTED,
            entity_id="ent_wenzhou_330300",
            affected_revision=AffectedRevision(
                revision_id="rev_002",
                property_path="economy.gdp.annual",
                lifecycle_state="PUBLISHED",
            ),
        )
        ndjson = self.stream_manager.serialize_ndjson()
        lines = [line for line in ndjson.strip().split("\n") if line]
        self.assertEqual(len(lines), 2)
        item = json.loads(lines[0])
        self.assertEqual(item["change_sequence_num"], 1)


if __name__ == "__main__":
    unittest.main()
