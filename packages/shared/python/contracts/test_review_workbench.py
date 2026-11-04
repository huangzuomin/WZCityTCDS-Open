"""
Unit tests for Review Workbench & Ingestion Manager (Slice R2)
"""
import unittest

from packages.shared.python.contracts.evidence import EvidenceSpan, SourceAuthorityLevel
from packages.shared.python.contracts.evidence_engine import (
    EvidenceVerificationEngine,
    SourceNewsDocumentSnapshot,
    compute_span_hash,
)
from packages.shared.python.contracts.fact_revision import AssertionValue, FactDataType
from packages.shared.python.contracts.review_workbench import (
    CandidateAssertion,
    IngestCandidateParams,
    ListReviewTasksFilter,
    ReviewPriority,
    ReviewTaskStatus,
    ReviewWorkbenchManager,
)


class TestReviewWorkbench(unittest.TestCase):
    def setUp(self):
        self.manager = ReviewWorkbenchManager()
        self.sample_text = "温州市2025年全市常住人口为967.9万人，比上年末增加3.2万人。"
        self.span_hash = compute_span_hash(self.sample_text)

        self.sample_span = EvidenceSpan(
            span_id="span_review_test_01",
            source_doc_id="doc_stat_2025_001",
            paragraph_index=0,
            char_start=0,
            char_end=len(self.sample_text),
            quoted_text=self.sample_text,
            span_hash=self.span_hash,
            extracted_at="2026-11-04T12:00:00Z",
            quality_state="VALIDATED",
        )

        self.sample_assertion = CandidateAssertion(
            assertion_id="ast_pop_2025_001",
            property_path="demographics.population.permanent",
            assertion_value=AssertionValue(
                raw_value=9679000,
                data_type=FactDataType.NUMBER,
                unit="人",
            ),
            confidence_score=0.98,
            evidence_span_ids=[self.sample_span.span_id],
            created_at="2026-11-04T12:00:00Z",
        )

    def test_01_ingest_clean_candidate(self):
        task = self.manager.ingest_candidate(
            IngestCandidateParams(
                entity_id="wenzhou_city_330300",
                property_path="demographics.population.permanent",
                candidate_assertion=self.sample_assertion,
                evidence_spans=[self.sample_span],
                submitted_by="editor_agent_01",
                priority=ReviewPriority.HIGH,
            )
        )
        self.assertEqual(task.status, ReviewTaskStatus.PENDING_REVIEW)
        self.assertEqual(task.priority, ReviewPriority.HIGH)
        self.assertEqual(len(task.audit_trail), 1)
        self.assertEqual(task.audit_trail[0].action.value, "INGEST")

    def test_02_ingest_rejects_zero_spans(self):
        with self.assertRaises(ValueError) as ctx:
            self.manager.ingest_candidate(
                IngestCandidateParams(
                    entity_id="wenzhou_city_330300",
                    property_path="demographics.population.permanent",
                    candidate_assertion=self.sample_assertion,
                    evidence_spans=[],
                    submitted_by="editor_agent_01",
                )
            )
        self.assertIn("at least one supporting EvidenceSpan is strictly required", str(ctx.exception))

    def test_03_automated_conflict_detection(self):
        task = self.manager.ingest_candidate(
            IngestCandidateParams(
                entity_id="wenzhou_city_330300",
                property_path="demographics.population.permanent",
                candidate_assertion=self.sample_assertion,
                evidence_spans=[self.sample_span],
                submitted_by="editor_agent_01",
                existing_published_assertion={
                    "revision_id": "rev_pub_old_0000001",
                    "raw_value": 9647000,
                    "authority_level": SourceAuthorityLevel.OFFICIAL_GOVERNMENT_RELEASE,
                },
            )
        )
        self.assertEqual(task.status, ReviewTaskStatus.ARBITRATION_REQUIRED)
        self.assertIsNotNone(task.conflict_context)
        self.assertEqual(task.conflict_context.conflicting_value, 9647000)

    def test_04_list_tasks_filtering(self):
        t1 = self.manager.ingest_candidate(
            IngestCandidateParams(
                entity_id="wenzhou_city_330300",
                property_path="demographics.population.permanent",
                candidate_assertion=self.sample_assertion,
                evidence_spans=[self.sample_span],
                submitted_by="editor_agent_01",
            )
        )
        res = self.manager.list_tasks(ListReviewTasksFilter(status=ReviewTaskStatus.PENDING_REVIEW))
        self.assertEqual(res["total"], 1)
        self.assertEqual(res["tasks"][0].task_id, t1.task_id)

    def test_05_claim_task_transitions_to_in_review(self):
        task = self.manager.ingest_candidate(
            IngestCandidateParams(
                entity_id="wenzhou_city_330300",
                property_path="demographics.population.permanent",
                candidate_assertion=self.sample_assertion,
                evidence_spans=[self.sample_span],
                submitted_by="editor_agent_01",
            )
        )
        claimed = self.manager.claim_task(task.task_id, "reviewer_wang", "reviewer")
        self.assertEqual(claimed.status, ReviewTaskStatus.IN_REVIEW)
        self.assertEqual(claimed.assigned_to, "reviewer_wang")
        self.assertIsNotNone(claimed.assigned_at)
        self.assertEqual(len(claimed.audit_trail), 2)
        self.assertEqual(claimed.audit_trail[1].action.value, "CLAIM")

    def test_06_release_task_reverts_status(self):
        task = self.manager.ingest_candidate(
            IngestCandidateParams(
                entity_id="wenzhou_city_330300",
                property_path="demographics.population.permanent",
                candidate_assertion=self.sample_assertion,
                evidence_spans=[self.sample_span],
                submitted_by="editor_agent_01",
            )
        )
        self.manager.claim_task(task.task_id, "reviewer_wang", "reviewer")
        released = self.manager.release_task(task.task_id, "reviewer_wang", "reviewer")
        self.assertEqual(released.status, ReviewTaskStatus.PENDING_REVIEW)
        self.assertIsNone(released.assigned_to)

    def test_07_preflight_evidence_pass(self):
        task = self.manager.ingest_candidate(
            IngestCandidateParams(
                entity_id="wenzhou_city_330300",
                property_path="demographics.population.permanent",
                candidate_assertion=self.sample_assertion,
                evidence_spans=[self.sample_span],
                submitted_by="editor_agent_01",
            )
        )
        source_doc = SourceNewsDocumentSnapshot(
            source_doc_id="doc_stat_2025_001",
            paragraphs=[self.sample_text],
            is_retracted=False,
        )
        receipt = self.manager.verify_evidence(task.task_id, [source_doc], "reviewer_wang")
        self.assertEqual(receipt.overall_verification_verdict.value, "PASS")
        self.assertEqual(len(receipt.span_verifications), 1)

    def test_08_preflight_evidence_retracted_fail(self):
        task = self.manager.ingest_candidate(
            IngestCandidateParams(
                entity_id="wenzhou_city_330300",
                property_path="demographics.population.permanent",
                candidate_assertion=self.sample_assertion,
                evidence_spans=[self.sample_span],
                submitted_by="editor_agent_01",
            )
        )
        retracted_doc = SourceNewsDocumentSnapshot(
            source_doc_id="doc_stat_2025_001",
            paragraphs=[self.sample_text],
            is_retracted=True,
        )
        receipt = self.manager.verify_evidence(task.task_id, [retracted_doc], "reviewer_wang")
        self.assertEqual(receipt.overall_verification_verdict.value, "FAIL_SOURCE_RETRACTED")

    def test_09_approve_fails_closed_on_bad_evidence(self):
        task = self.manager.ingest_candidate(
            IngestCandidateParams(
                entity_id="wenzhou_city_330300",
                property_path="demographics.population.permanent",
                candidate_assertion=self.sample_assertion,
                evidence_spans=[self.sample_span],
                submitted_by="editor_agent_01",
            )
        )
        self.manager.claim_task(task.task_id, "reviewer_wang", "reviewer")
        retracted_doc = SourceNewsDocumentSnapshot(
            source_doc_id="doc_stat_2025_001",
            paragraphs=[self.sample_text],
            is_retracted=True,
        )
        self.manager.verify_evidence(task.task_id, [retracted_doc], "reviewer_wang")
        with self.assertRaises(ValueError) as ctx:
            self.manager.approve_task(task.task_id, "reviewer_wang", "Approve", "reviewer")
        self.assertIn("Cannot approve task with non-passing evidence verification verdict", str(ctx.exception))

    def test_10_approve_fails_closed_on_unresolved_conflict(self):
        task = self.manager.ingest_candidate(
            IngestCandidateParams(
                entity_id="wenzhou_city_330300",
                property_path="demographics.population.permanent",
                candidate_assertion=self.sample_assertion,
                evidence_spans=[self.sample_span],
                submitted_by="editor_agent_01",
                existing_published_assertion={
                    "revision_id": "rev_pub_old_0000001",
                    "raw_value": 9647000,
                },
            )
        )
        with self.assertRaises(ValueError) as ctx:
            self.manager.approve_task(task.task_id, "reviewer_wang", "Approve", "reviewer")
        self.assertIn("while unresolved conflict arbitration is required", str(ctx.exception))

    def test_11_arbitrate_conflict_resolves_to_in_review(self):
        task = self.manager.ingest_candidate(
            IngestCandidateParams(
                entity_id="wenzhou_city_330300",
                property_path="demographics.population.permanent",
                candidate_assertion=self.sample_assertion,
                evidence_spans=[self.sample_span],
                submitted_by="editor_agent_01",
                existing_published_assertion={
                    "revision_id": "rev_pub_old_0000001",
                    "raw_value": 9647000,
                },
            )
        )
        arbitrated = self.manager.arbitrate_conflict(
            task.task_id,
            "reviewer_wang",
            "ADOPT_CANDIDATE",
            "Newer communique adopted",
            "reviewer",
        )
        self.assertEqual(arbitrated.status, ReviewTaskStatus.IN_REVIEW)
        self.assertEqual(arbitrated.conflict_context.arbitration_verdict, "ADOPT_CANDIDATE")

    def test_12_approve_succeeds_with_clean_evidence(self):
        task = self.manager.ingest_candidate(
            IngestCandidateParams(
                entity_id="wenzhou_city_330300",
                property_path="demographics.population.permanent",
                candidate_assertion=self.sample_assertion,
                evidence_spans=[self.sample_span],
                submitted_by="editor_agent_01",
            )
        )
        self.manager.claim_task(task.task_id, "reviewer_wang", "reviewer")
        source_doc = SourceNewsDocumentSnapshot(
            source_doc_id="doc_stat_2025_001",
            paragraphs=[self.sample_text],
            is_retracted=False,
        )
        self.manager.verify_evidence(task.task_id, [source_doc], "reviewer_wang")
        res = self.manager.approve_task(task.task_id, "reviewer_wang", "All criteria met", "reviewer")
        self.assertEqual(res["task"].status, ReviewTaskStatus.APPROVED)
        self.assertTrue(res["published_revision_id"].startswith("rev_"))
        self.assertEqual(res["task"].review_result.verdict, "APPROVED")

    def test_13_reject_task_with_reason(self):
        task = self.manager.ingest_candidate(
            IngestCandidateParams(
                entity_id="wenzhou_city_330300",
                property_path="economy.gdp.nominal",
                candidate_assertion=CandidateAssertion(
                    assertion_id="ast_gdp_bad_0001",
                    property_path="economy.gdp.nominal",
                    assertion_value=AssertionValue(raw_value=999999, data_type=FactDataType.NUMBER),
                    evidence_span_ids=[self.sample_span.span_id],
                    created_at="2026-11-04T12:00:00Z",
                ),
                evidence_spans=[self.sample_span],
                submitted_by="unverified_bot",
            )
        )
        self.manager.claim_task(task.task_id, "reviewer_li", "reviewer")
        rejected = self.manager.reject_task(
            task.task_id, "reviewer_li", "Unverified source", "Outlier value", "reviewer"
        )
        self.assertEqual(rejected.status, ReviewTaskStatus.REJECTED)
        self.assertEqual(rejected.review_result.verdict, "REJECTED")

    def test_14_request_changes_transitions_status(self):
        task = self.manager.ingest_candidate(
            IngestCandidateParams(
                entity_id="wenzhou_city_330300",
                property_path="environment.air_quality.aqi",
                candidate_assertion=CandidateAssertion(
                    assertion_id="ast_aqi_2025_001",
                    property_path="environment.air_quality.aqi",
                    assertion_value=AssertionValue(raw_value=45, data_type=FactDataType.NUMBER),
                    evidence_span_ids=[self.sample_span.span_id],
                    created_at="2026-11-04T12:00:00Z",
                ),
                evidence_spans=[self.sample_span],
                submitted_by="editor_agent_02",
            )
        )
        self.manager.claim_task(task.task_id, "reviewer_li", "reviewer")
        req = self.manager.request_changes(
            task.task_id, "reviewer_li", "Please attach monitoring station coordinates.", "reviewer"
        )
        self.assertEqual(req.status, ReviewTaskStatus.CHANGES_REQUESTED)
        self.assertEqual(req.review_result.verdict, "CHANGES_REQUESTED")

    def test_15_role_security_guard(self):
        task = self.manager.ingest_candidate(
            IngestCandidateParams(
                entity_id="wenzhou_city_330300",
                property_path="demographics.population.permanent",
                candidate_assertion=self.sample_assertion,
                evidence_spans=[self.sample_span],
                submitted_by="editor_agent_01",
            )
        )
        with self.assertRaises(PermissionError) as ctx:
            self.manager.claim_task(task.task_id, "viewer_guest", "viewer")
        self.assertIn("Forbidden: role 'viewer' is not authorized", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
