"""Unit tests for EvidenceVerificationEngine and ConflictArbitrationPipeline."""
import unittest
from packages.shared.python.contracts.evidence import (
    EvidenceSpan,
    EvidenceSpanQualityState,
    SpanVerificationCheckStatus,
    OverallVerificationVerdict,
    ConflictingSpanItem,
    ConflictType,
    SourceAuthorityLevel,
    ArbitrationStatus,
    ArbitrationDecision,
)
from packages.shared.python.contracts.evidence_engine import (
    compute_span_hash,
    compute_receipt_digest,
    EvidenceVerificationEngine,
    ConflictArbitrationPipeline,
    SourceNewsDocumentSnapshot,
)


class TestEvidenceEngine(unittest.TestCase):
    def setUp(self):
        self.doc = SourceNewsDocumentSnapshot(
            source_doc_id="news_wenzhou_20261101_001",
            source_url="https://news.wenzhou.gov.cn/art/2026/11/1/art_001.html",
            paragraphs=[
                "温州市统计局发布前三季度经济运行数据。",
                "初步核算，全市实现地区生产总值（GDP）7120.5亿元，按不变价格计算，同比增长5.7%。",
                "规上工业增加值增长8.9%，固定资产投资保持平稳增长。",
            ],
            is_retracted=False,
        )
        self.quoted_text = "地区生产总值（GDP）7120.5亿元"
        self.char_start = self.doc.paragraphs[1].index(self.quoted_text)
        self.char_end = self.char_start + len(self.quoted_text)
        self.span_hash = compute_span_hash(self.quoted_text)

        self.valid_span = EvidenceSpan(
            span_id="span_wz_gdp_2026q3_01",
            source_doc_id=self.doc.source_doc_id,
            source_url=self.doc.source_url,
            paragraph_index=1,
            char_start=self.char_start,
            char_end=self.char_end,
            quoted_text=self.quoted_text,
            span_hash=self.span_hash,
            extracted_at="2026-11-04T05:00:00.000Z",
            quality_state=EvidenceSpanQualityState.VALIDATED,
        )
        self.engine = EvidenceVerificationEngine()
        self.pipeline = ConflictArbitrationPipeline()

    def test_compute_span_hash_nfkc(self):
        h1 = compute_span_hash("温州 2026")
        h2 = compute_span_hash("温州 2026")
        self.assertEqual(len(h1), 64)
        self.assertEqual(h1, h2)
        self.assertNotEqual(compute_span_hash("A"), compute_span_hash("B"))

    def test_verify_span_pass(self):
        res = self.engine.verify_span(self.valid_span, self.doc)
        self.assertEqual(res.check_status, SpanVerificationCheckStatus.PASS)
        self.assertTrue(res.span_hash_matched)
        self.assertTrue(res.source_doc_verified)
        self.assertTrue(res.paragraph_exact_match)
        self.assertEqual(res.computed_hash, self.span_hash)

    def test_verify_span_hash_mismatch(self):
        tampered = self.valid_span.model_copy(
            update={"span_hash": "0000000000000000000000000000000000000000000000000000000000000000"}
        )
        res = self.engine.verify_span(tampered, self.doc)
        self.assertEqual(res.check_status, SpanVerificationCheckStatus.FAIL_HASH_MISMATCH)
        self.assertFalse(res.span_hash_matched)

    def test_verify_span_source_not_found(self):
        res = self.engine.verify_span(self.valid_span, None)
        self.assertEqual(res.check_status, SpanVerificationCheckStatus.FAIL_SOURCE_NOT_FOUND)
        self.assertTrue(res.span_hash_matched)
        self.assertFalse(res.source_doc_verified)

    def test_verify_span_text_mismatch(self):
        mismatched = self.valid_span.model_copy(update={"char_start": 0, "char_end": 10})
        res = self.engine.verify_span(mismatched, self.doc)
        self.assertEqual(res.check_status, SpanVerificationCheckStatus.FAIL_TEXT_NOT_FOUND)
        self.assertFalse(res.paragraph_exact_match)

    def test_verify_assertion_evidence_pass(self):
        receipt = self.engine.verify_assertion_evidence(
            assertion_id="ast_gdp_2026q3_report_01",
            revision_id="rev_gdp_2026q3_v001",
            spans=[self.valid_span],
            source_resolver=lambda id: self.doc if id == self.doc.source_doc_id else None,
        )
        self.assertEqual(receipt.overall_verification_verdict, OverallVerificationVerdict.PASS)
        self.assertEqual(len(receipt.span_verifications), 1)
        self.assertEqual(receipt.span_verifications[0].check_status, SpanVerificationCheckStatus.PASS)
        self.assertEqual(len(receipt.auditor_signature.digest_sha256), 64)

    def test_verify_assertion_evidence_retracted(self):
        retracted_doc = self.doc.model_copy(update={"is_retracted": True})
        receipt = self.engine.verify_assertion_evidence(
            assertion_id="ast_gdp_2026q3_report_01",
            revision_id="rev_gdp_2026q3_v001",
            spans=[self.valid_span],
            source_resolver=lambda id: retracted_doc,
        )
        self.assertEqual(
            receipt.overall_verification_verdict,
            OverallVerificationVerdict.FAIL_SOURCE_RETRACTED,
        )

    def test_verify_assertion_evidence_empty(self):
        receipt = self.engine.verify_assertion_evidence(
            assertion_id="ast_unsupported_claim_01",
            revision_id="rev_unsupported_claim_v001",
            spans=[],
            source_resolver=lambda id: self.doc,
        )
        self.assertEqual(
            receipt.overall_verification_verdict,
            OverallVerificationVerdict.FAIL_INSUFFICIENT_EVIDENCE,
        )

    def test_handle_source_retraction(self):
        span2 = self.valid_span.model_copy(
            update={
                "span_id": "span_other_unaffected_doc_02",
                "source_doc_id": "news_other_reliable_2026_099",
            }
        )
        affected, updated = self.engine.handle_source_retraction(
            self.doc.source_doc_id, [self.valid_span, span2]
        )
        self.assertEqual(len(affected), 1)
        self.assertEqual(affected[0].span_id, self.valid_span.span_id)
        self.assertEqual(affected[0].quality_state, EvidenceSpanQualityState.STALE_SOURCE_RETRACTED)
        self.assertEqual(updated[1].quality_state, EvidenceSpanQualityState.VALIDATED)

    def test_conflict_min_spans(self):
        with self.assertRaises(ValueError):
            self.pipeline.create_conflict_arbitration(
                assertion_id="ast_conflict_test_01",
                conflicting_spans=[
                    ConflictingSpanItem(
                        span_id="span_single_01",
                        source_doc_id="doc_1",
                        reported_value=100,
                        source_authority_level=SourceAuthorityLevel.COMMERCIAL_PORTAL,
                    )
                ],
                conflict_type=ConflictType.NUMERICAL_DISCREPANCY,
            )

    def test_adjudicate_auto_priority_higher(self):
        spans = [
            ConflictingSpanItem(
                span_id="span_gov_release_01",
                source_doc_id="gov_doc_01",
                reported_value=7120.5,
                source_authority_level=SourceAuthorityLevel.OFFICIAL_GOVERNMENT_RELEASE,
            ),
            ConflictingSpanItem(
                span_id="span_portal_claim_02",
                source_doc_id="portal_doc_02",
                reported_value=7200.0,
                source_authority_level=SourceAuthorityLevel.COMMERCIAL_PORTAL,
            ),
        ]
        arb = self.pipeline.create_conflict_arbitration(
            assertion_id="ast_gdp_conflict_01",
            conflicting_spans=spans,
            conflict_type=ConflictType.NUMERICAL_DISCREPANCY,
        )
        res = self.pipeline.adjudicate(arb, policy="AUTO_PRIORITY")
        self.assertEqual(res.arbitration_status, ArbitrationStatus.RESOLVED_ADOPTED)
        self.assertIsNotNone(res.adjudication)
        self.assertEqual(res.adjudication.chosen_decision, ArbitrationDecision.ADOPT_HIGHER_AUTHORITY)
        self.assertEqual(res.adjudication.adopted_span_id, "span_gov_release_01")
        self.assertIn("OFFICIAL_GOVERNMENT_RELEASE", res.adjudication.arbitration_rationale)

    def test_adjudicate_auto_priority_tie_suspend(self):
        spans = [
            ConflictingSpanItem(
                span_id="span_state_media_a_01",
                source_doc_id="media_a",
                reported_value="项目已于10月完工",
                source_authority_level=SourceAuthorityLevel.STATE_MEDIA_PRIMARY,
            ),
            ConflictingSpanItem(
                span_id="span_state_media_b_02",
                source_doc_id="media_b",
                reported_value="项目预计12月完工",
                source_authority_level=SourceAuthorityLevel.STATE_MEDIA_PRIMARY,
            ),
        ]
        arb = self.pipeline.create_conflict_arbitration(
            assertion_id="ast_project_completion_01",
            conflicting_spans=spans,
            conflict_type=ConflictType.STATUS_CONTRADICTION,
        )
        res = self.pipeline.adjudicate(arb, policy="AUTO_PRIORITY")
        self.assertEqual(res.arbitration_status, ArbitrationStatus.PENDING_ARBITRATION)
        self.assertIsNotNone(res.adjudication)
        self.assertEqual(
            res.adjudication.chosen_decision,
            ArbitrationDecision.SUSPEND_PENDING_OFFICIAL_CLARIFICATION,
        )

    def test_adjudicate_allow_range(self):
        spans = [
            ConflictingSpanItem(
                span_id="span_stat_a_01",
                source_doc_id="stat_a",
                reported_value=9400,
                source_authority_level=SourceAuthorityLevel.STATE_MEDIA_PRIMARY,
            ),
            ConflictingSpanItem(
                span_id="span_stat_b_02",
                source_doc_id="stat_b",
                reported_value=9450,
                source_authority_level=SourceAuthorityLevel.LOCAL_MEDIA_REPORT,
            ),
        ]
        arb = self.pipeline.create_conflict_arbitration(
            assertion_id="ast_population_estimate_01",
            conflicting_spans=spans,
            conflict_type=ConflictType.NUMERICAL_DISCREPANCY,
        )
        res = self.pipeline.adjudicate(arb, policy="ALLOW_RANGE")
        self.assertEqual(res.arbitration_status, ArbitrationStatus.RECONCILED_AS_RANGE)
        self.assertIsNotNone(res.adjudication)
        self.assertEqual(
            res.adjudication.chosen_decision,
            ArbitrationDecision.PUBLISH_AS_ESTIMATED_RANGE,
        )


if __name__ == "__main__":
    unittest.main()
