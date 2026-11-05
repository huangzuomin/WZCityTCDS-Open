"""
Unit tests for End-to-End Integration & Acceptance Pipeline (Python mirror - Slice R4).
"""
import datetime
import json
import unittest

from packages.shared.python.contracts.e2e_integration import (
    EndToEndIntegrationPipeline,
    SystemHealthEvaluator,
    SubsystemStatus,
    SystemHealthReport,
)
from packages.shared.python.contracts.evidence import EvidenceSpan
from packages.shared.python.contracts.evidence_engine import (
    SourceNewsDocumentSnapshot,
    compute_span_hash,
)
from packages.shared.python.contracts.fact_revision import (
    PublicationSnapshot,
    ProjectionMetadata,
    OutletScope,
    AssertionValue,
)
from packages.shared.python.contracts.hub_projection import (
    HubProjectionReceiptStatus,
    HubUpstreamChangeEvent,
    HubUpstreamChangeType,
    compute_upstream_change_digest,
)
from packages.shared.python.contracts.outlets import (
    GateVerdict,
    StreamChangeType,
    AffectedRevision,
)
from packages.shared.python.contracts.review_workbench import (
    CandidateAssertion,
    ReviewTaskStatus,
    IngestCandidateParams,
)


class TestE2EIntegration(unittest.TestCase):
    def setUp(self):
        self.paragraph = "2026年温州市全市数字经济核心产业增加值达到985.4亿元，同比增长11.2%。"
        self.quoted_text = "985.4亿元"
        self.start_index = self.paragraph.index(self.quoted_text)
        self.end_index = self.start_index + len(self.quoted_text)
        self.span_hash = compute_span_hash(self.quoted_text)

        self.source_doc = SourceNewsDocumentSnapshot(
            source_doc_id="news_wz_2026_digital_economy",
            source_url="https://news.wenzhou.gov.cn/2026/economy/digital.html",
            paragraphs=[self.paragraph],
            is_retracted=False,
        )

        self.golden_candidate = {
            "entity_id": "ent_wz_economy_stat_2026",
            "field_id": "digital_economy_added_value",
            "value": "985.4亿元",
            "evidence_spans": [
                {
                    "source_doc_id": self.source_doc.source_doc_id,
                    "paragraph_index": 0,
                    "start_char": self.start_index,
                    "end_char": self.end_index,
                    "quoted_text": self.quoted_text,
                    "span_hash": self.span_hash,
                    "source_authority_level": "OFFICIAL_GOVERNMENT",
                }
            ],
            "submitted_by": "editorial_ingest_bot",
            "notes": "2026 annual digital economy benchmark",
        }

    def test_01_golden_path_full_lifecycle(self):
        pipeline = EndToEndIntegrationPipeline()
        result = pipeline.execute_golden_path(
            candidate_data=self.golden_candidate,
            source_doc=self.source_doc,
            reviewer_id="reviewer_alice",
        )
        self.assertTrue(result.success, f"Golden path failed: {result.error}")
        self.assertEqual(len(result.steps), 9)
        self.assertGreaterEqual(len(result.outlets_verified), 4)
        self.assertIsNotNone(result.hub_receipt)
        self.assertEqual(result.hub_receipt.status, HubProjectionReceiptStatus.ACCEPTED)

    def test_02_preflight_evidence_failure_halts_pipeline(self):
        broken_candidate = dict(self.golden_candidate)
        broken_candidate["entity_id"] = "ent_wz_economy_stat_broken"
        broken_candidate["evidence_spans"] = [
            {
                "source_doc_id": self.source_doc.source_doc_id,
                "paragraph_index": 0,
                "start_char": 0,
                "end_char": 5,
                "quoted_text": "wrong",
                "span_hash": "a" * 64,
            }
        ]
        pipeline = EndToEndIntegrationPipeline()
        result = pipeline.execute_golden_path(
            candidate_data=broken_candidate,
            source_doc=self.source_doc,
            reviewer_id="reviewer_bob",
        )
        self.assertFalse(result.success)
        self.assertEqual(len(result.outlets_verified), 0)
        self.assertIn("Preflight evidence verification failed", str(result.error))

    def test_03_conflicting_candidate_triggers_arbitration(self):
        pipe = EndToEndIntegrationPipeline()
        span_item = EvidenceSpan(
            span_id="span_conf_123456789012",
            source_doc_id=self.source_doc.source_doc_id,
            paragraph_index=0,
            char_start=self.start_index,
            char_end=self.end_index,
            quoted_text=self.quoted_text,
            span_hash=self.span_hash,
            extracted_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            quality_state="VALIDATED",
        )
        pipe.workbench.ingest_candidate(
            IngestCandidateParams(
                entity_id="ent_wz_digital_conflict_1",
                property_path="gdp.growth",
                candidate_assertion=CandidateAssertion(
                    assertion_id="ast_conflict_0000000001",
                    property_path="gdp.growth",
                    assertion_value=AssertionValue(raw_value="11.2%", data_type="STRING"),
                    evidence_span_ids=[span_item.span_id],
                    created_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                ),
                evidence_spans=[span_item],
                submitted_by="bot_a",
            )
        )
        t2 = pipe.workbench.ingest_candidate(
            IngestCandidateParams(
                entity_id="ent_wz_digital_conflict_1",
                property_path="gdp.growth",
                candidate_assertion=CandidateAssertion(
                    assertion_id="ast_conflict_0000000002",
                    property_path="gdp.growth",
                    assertion_value=AssertionValue(raw_value="12.0%", data_type="STRING"),
                    evidence_span_ids=[span_item.span_id],
                    created_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                ),
                evidence_spans=[span_item],
                submitted_by="bot_b",
                existing_published_assertion={
                    "revision_id": "rev_existing_pub_12345678",
                    "raw_value": "11.2%",
                },
            )
        )
        task2 = pipe.workbench.get_task(t2.task_id)
        self.assertEqual(task2.status, ReviewTaskStatus.ARBITRATION_REQUIRED)
        self.assertIsNotNone(task2.conflict_context)

    def test_04_security_gate_blocks_private_ip(self):
        pipe = EndToEndIntegrationPipeline()
        cand = dict(self.golden_candidate)
        cand["entity_id"] = "ent_wz_sec_ip_leak"
        result = pipe.execute_security_gate_fail_closed(
            candidate_data=cand,
            source_doc=self.source_doc,
            reviewer_id="reviewer_carol",
            leaked_ip="192.168.1.100",
        )
        self.assertTrue(result.success)
        self.assertEqual(result.security_gate_policy.gate_verdict, GateVerdict.FAIL_CLOSED_BLOCKED)
        self.assertFalse(result.security_gate_policy.rule_evaluations.rule_no_private_ip_leaks["passed"])

    def test_05_security_gate_blocks_api_key_credentials(self):
        pipe = EndToEndIntegrationPipeline()
        cand = dict(self.golden_candidate)
        cand["entity_id"] = "ent_wz_sec_key_leak"
        result = pipe.execute_security_gate_fail_closed(
            candidate_data=cand,
            source_doc=self.source_doc,
            reviewer_id="reviewer_carol",
            leaked_secret="-".join(["sk", "test12345678901234567890123456"]),
        )
        self.assertTrue(result.success)
        self.assertEqual(result.security_gate_policy.gate_verdict, GateVerdict.FAIL_CLOSED_BLOCKED)
        self.assertFalse(result.security_gate_policy.rule_evaluations.rule_no_credential_patterns["passed"])

    def test_06_retracted_source_triggers_verification_failure(self):
        retracted_doc = SourceNewsDocumentSnapshot(
            source_doc_id=self.source_doc.source_doc_id,
            source_url=self.source_doc.source_url,
            paragraphs=self.source_doc.paragraphs,
            is_retracted=True,
        )
        pipe = EndToEndIntegrationPipeline()
        span_retract = EvidenceSpan(
            span_id="span_retract_123456789012",
            source_doc_id=retracted_doc.source_doc_id,
            paragraph_index=0,
            char_start=self.start_index,
            char_end=self.end_index,
            quoted_text=self.quoted_text,
            span_hash=self.span_hash,
            extracted_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            quality_state="VALIDATED",
        )
        task = pipe.workbench.ingest_candidate(
            IngestCandidateParams(
                entity_id="ent_wz_retracted_source",
                property_path="stats",
                candidate_assertion=CandidateAssertion(
                    assertion_id="ast_retract_00000000001",
                    property_path="stats",
                    assertion_value=AssertionValue(raw_value="985.4亿元", data_type="STRING"),
                    evidence_span_ids=[span_retract.span_id],
                    created_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                ),
                evidence_spans=[span_retract],
                submitted_by="bot_test",
            )
        )
        receipt = pipe.workbench.verify_evidence(task.task_id, [retracted_doc], "reviewer_dan")
        self.assertEqual(receipt.overall_verification_verdict, "FAIL_SOURCE_RETRACTED")

    def test_07_hub_projector_enforces_option_a_entity_id(self):
        pipe = EndToEndIntegrationPipeline()
        with self.assertRaises(Exception) as ctx:
            pipe.hub_projector.project_snapshot(
                PublicationSnapshot(
                    publication_id="pub_1234567890123",
                    snapshot_revision_id="pubrev_1234567890123",
                    entity_id="INVALID_ID_WITHOUT_PREFIX",
                    generated_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    snapshot_digest_sha256="0" * 64,
                    published_assertions=[],
                    projection_metadata=ProjectionMetadata(
                        kernel_system="WZCityTCDS-PublicationKernel",
                        publisher_role="CHIEF_FACT_EDITOR",
                        outlet_scopes=[OutletScope.REST_API],
                        is_latest_snapshot=True,
                    ),
                )
            )
        self.assertTrue("ent_" in str(ctx.exception) or "Invalid" in str(ctx.exception))

    def test_08_hub_signed_receipt_verified(self):
        pipe = EndToEndIntegrationPipeline()
        res = pipe.execute_golden_path(self.golden_candidate, self.source_doc, "reviewer_alice")
        self.assertTrue(res.success)
        receipt = pipe.hub_projector.get_latest_receipt(self.golden_candidate["entity_id"])
        self.assertIsNotNone(receipt)
        self.assertEqual(receipt.status, HubProjectionReceiptStatus.ACCEPTED)
        self.assertIsNotNone(receipt.hub_slot_id)
        self.assertEqual(len(receipt.receipt_signature_sha256), 64)

    def test_09_upstream_entity_update_event_sync(self):
        pipe = EndToEndIntegrationPipeline()
        consumer = pipe.changes_consumer
        evt_data = {
            "hub_change_event_id": "hchg_upd_000000001",
            "hub_sequence_num": 10,
            "change_type": "ENTITY_UPDATED",
            "category": "ORGANIZATION",
            "entity_id": self.golden_candidate["entity_id"],
            "canonical_name": "温州市大数据局",
            "aliases": ["温州数据局"],
            "timestamp": "2026-11-05T02:00:00Z",
        }
        digest = compute_upstream_change_digest(evt_data)
        consumer.consume_hub_event(HubUpstreamChangeEvent(**evt_data, digest_sha256=digest))
        state = consumer.get_entity_state(self.golden_candidate["entity_id"])
        self.assertIsNotNone(state)
        self.assertEqual(state["entity_id"], self.golden_candidate["entity_id"])
        self.assertFalse(state["is_tombstoned"])
        self.assertEqual(consumer.get_hub_cursor(), 10)

    def test_10_upstream_entity_tombstoned_propagation(self):
        pipe = EndToEndIntegrationPipeline()
        consumer = pipe.changes_consumer
        evt_data = {
            "hub_change_event_id": "hchg_tomb_000000002",
            "hub_sequence_num": 11,
            "change_type": "TOMBSTONED",
            "category": "ORGANIZATION",
            "entity_id": self.golden_candidate["entity_id"],
            "canonical_name": "温州市大数据局",
            "aliases": [],
            "timestamp": "2026-11-05T03:00:00Z",
            "tombstone_reason": "Government organization restructured",
        }
        digest = compute_upstream_change_digest(evt_data)
        consumer.consume_hub_event(HubUpstreamChangeEvent(**evt_data, digest_sha256=digest))
        state = consumer.get_entity_state(self.golden_candidate["entity_id"])
        self.assertIsNotNone(state)
        self.assertTrue(state["is_tombstoned"])
        self.assertEqual(consumer.get_hub_cursor(), 11)

    def test_11_multi_outlet_content_consistency(self):
        pipe = EndToEndIntegrationPipeline()
        res = pipe.execute_golden_path(self.golden_candidate, self.source_doc, "reviewer_alice")
        self.assertTrue(res.success)
        snap_id = res.security_gate_policy.snapshot_revision_id
        from packages.shared.python.contracts.outlets_http import OutletsHttpRequest

        rest_out = pipe.http_router.handle_request(OutletsHttpRequest(method="GET", path=f"/outlets/snapshot/{snap_id}"))
        html_out = pipe.http_router.handle_request(OutletsHttpRequest(method="GET", path=f"/outlets/archive/{self.golden_candidate['entity_id']}"))
        jsonld_out = pipe.http_router.handle_request(OutletsHttpRequest(method="GET", path=f"/outlets/jsonld/{snap_id}"))
        mcp_out = pipe.http_router.handle_request(OutletsHttpRequest(method="POST", path="/outlets/mcp", body={"entity_id": self.golden_candidate["entity_id"]}))

        self.assertEqual(rest_out.status_code, 200)
        self.assertEqual(html_out.status_code, 200)
        self.assertEqual(jsonld_out.status_code, 200)
        self.assertEqual(mcp_out.status_code, 200)
        self.assertIn("985.4", html_out.body)
        self.assertIn(self.golden_candidate["entity_id"], jsonld_out.body)
        self.assertIn("985.4", mcp_out.body)

    def test_12_changes_stream_sequence_monotonicity(self):
        pipe = EndToEndIntegrationPipeline()
        init_seq = pipe.changes_manager.get_sequence()
        evt_a = pipe.changes_manager.emit_event(
            change_type=StreamChangeType.FACT_PUBLISHED,
            entity_id="ent_mono_000000001",
            affected_revision=AffectedRevision(
                revision_id="rev_mono_000000000001",
                property_path="p1",
                lifecycle_state="PUBLISHED",
            ),
        )
        evt_b = pipe.changes_manager.emit_event(
            change_type=StreamChangeType.FACT_PUBLISHED,
            entity_id="ent_mono_000000002",
            affected_revision=AffectedRevision(
                revision_id="rev_mono_000000000002",
                property_path="p2",
                lifecycle_state="PUBLISHED",
            ),
        )
        self.assertEqual(evt_a.change_sequence_num, init_seq + 1)
        self.assertEqual(evt_b.change_sequence_num, init_seq + 2)

    def test_13_ndjson_ingestion_and_dead_letter_queue(self):
        pipe = EndToEndIntegrationPipeline()
        consumer = pipe.changes_consumer
        e1 = {
            "hub_change_event_id": "hchg_ndjson_good_1",
            "hub_sequence_num": 30,
            "category": "ORGANIZATION",
            "entity_id": "ent_ndjson_good",
            "canonical_name": "测试单位",
            "aliases": [],
            "timestamp": "2026-03-01T00:00:00Z",
            "change_type": "ENTITY_CREATED",
        }
        e1["digest_sha256"] = compute_upstream_change_digest(e1)
        e2 = {
            "hub_change_event_id": "hchg_ndjson_good_2",
            "hub_sequence_num": 31,
            "category": "ORGANIZATION",
            "entity_id": "ent_ndjson_good",
            "canonical_name": "测试单位2",
            "aliases": [],
            "timestamp": "2026-03-01T00:00:00Z",
            "change_type": "ENTITY_UPDATED",
        }
        e2["digest_sha256"] = compute_upstream_change_digest(e2)
        mixed_ndjson = f"{json.dumps(e1)}\nMALFORMED_NON_JSON_LINE\n{json.dumps(e2)}\n"
        stats = consumer.consume_ndjson(mixed_ndjson)
        self.assertEqual(stats["processed"], 2)
        self.assertEqual(stats["dead_letters"], 1)
        self.assertGreaterEqual(len(consumer.get_dead_letters()), 1)

    def test_14_system_health_evaluator_report_schema(self):
        pipe = EndToEndIntegrationPipeline()
        evaluator = SystemHealthEvaluator(pipe)
        report = evaluator.evaluate_health()
        self.assertIsInstance(report, SystemHealthReport)
        self.assertEqual(len(report.components), 6)
        self.assertEqual(report.summary["total_components"], 6)

    def test_15_clean_evaluator_produces_healthy_status(self):
        clean_pipe = EndToEndIntegrationPipeline()
        clean_evaluator = SystemHealthEvaluator(clean_pipe)
        report = clean_evaluator.evaluate_health()
        self.assertEqual(report.status, SubsystemStatus.HEALTHY)
        self.assertEqual(report.summary["healthy_count"], 6)
        self.assertEqual(report.summary["degraded_count"], 0)
        self.assertEqual(report.summary["unhealthy_count"], 0)


if __name__ == "__main__":
    unittest.main()
