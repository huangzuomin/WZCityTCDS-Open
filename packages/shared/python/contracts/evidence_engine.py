"""EvidenceSpan hash verification engine and conflict arbitration pipeline (Python mirror)."""
from __future__ import annotations
import hashlib
import json
import secrets
import unicodedata
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field

from packages.shared.python.contracts.evidence import (
    EvidenceSpan,
    EvidenceSpanQualityState,
    SpanVerificationItem,
    SpanVerificationCheckStatus,
    EvidenceVerificationReceipt,
    OverallVerificationVerdict,
    AuditorSignature,
    AuditorSignatureType,
    EvidenceConflictArbitration,
    ConflictingSpanItem,
    ConflictType,
    ArbitrationStatus,
    ArbitrationDecision,
    ArbitrationAdjudication,
    SourceAuthorityLevel,
)

AUTHORITY_RANK: Dict[SourceAuthorityLevel, int] = {
    SourceAuthorityLevel.OFFICIAL_GOVERNMENT_RELEASE: 1,
    SourceAuthorityLevel.STATE_MEDIA_PRIMARY: 2,
    SourceAuthorityLevel.LOCAL_MEDIA_REPORT: 3,
    SourceAuthorityLevel.COMMERCIAL_PORTAL: 4,
}


class SourceNewsDocumentSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_doc_id: str
    source_url: Optional[str] = None
    paragraphs: List[str]
    is_retracted: bool = False


def compute_span_hash(text: str) -> str:
    """Computes deterministic SHA-256 for quoted evidence text with NFKC normalization."""
    normalized = unicodedata.normalize("NFKC", text)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest().lower()


def compute_receipt_digest(receipt_dict: dict) -> str:
    """Computes deterministic SHA-256 digest over sorted canonical JSON."""
    canonical = json.dumps(receipt_dict, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest().lower()


class EvidenceVerificationEngine:
    def __init__(
        self,
        engine_version: str = "EvidenceVerificationEngine/1.0.0-FPF-S4",
        signer_identity: str = "system:evidence-verifier-kernel",
    ):
        self.default_engine_version = engine_version
        self.default_signer_identity = signer_identity

    def verify_span(
        self,
        span: EvidenceSpan,
        source_doc: Optional[SourceNewsDocumentSnapshot] = None,
    ) -> SpanVerificationItem:
        computed_hash = compute_span_hash(span.quoted_text)
        hash_matched = computed_hash == span.span_hash.lower()

        if not hash_matched:
            return SpanVerificationItem(
                span_id=span.span_id,
                span_hash_matched=False,
                source_doc_verified=False,
                paragraph_exact_match=False,
                check_status=SpanVerificationCheckStatus.FAIL_HASH_MISMATCH,
                computed_hash=computed_hash,
            )

        if source_doc is None:
            return SpanVerificationItem(
                span_id=span.span_id,
                span_hash_matched=True,
                source_doc_verified=False,
                paragraph_exact_match=False,
                check_status=SpanVerificationCheckStatus.FAIL_SOURCE_NOT_FOUND,
                computed_hash=computed_hash,
            )

        p_idx = span.paragraph_index
        if p_idx < 0 or p_idx >= len(source_doc.paragraphs):
            return SpanVerificationItem(
                span_id=span.span_id,
                span_hash_matched=True,
                source_doc_verified=True,
                paragraph_exact_match=False,
                check_status=SpanVerificationCheckStatus.FAIL_TEXT_NOT_FOUND,
                computed_hash=computed_hash,
            )

        paragraph = source_doc.paragraphs[p_idx]
        sliced = paragraph[span.char_start : span.char_end]
        exact_match = sliced == span.quoted_text

        if not exact_match:
            return SpanVerificationItem(
                span_id=span.span_id,
                span_hash_matched=True,
                source_doc_verified=True,
                paragraph_exact_match=False,
                check_status=SpanVerificationCheckStatus.FAIL_TEXT_NOT_FOUND,
                computed_hash=computed_hash,
            )

        return SpanVerificationItem(
            span_id=span.span_id,
            span_hash_matched=True,
            source_doc_verified=True,
            paragraph_exact_match=True,
            check_status=SpanVerificationCheckStatus.PASS,
            computed_hash=computed_hash,
        )

    def verify_assertion_evidence(
        self,
        assertion_id: str,
        revision_id: str,
        spans: List[EvidenceSpan],
        source_resolver: Callable[[str], Optional[SourceNewsDocumentSnapshot]],
        verifier_engine_version: Optional[str] = None,
        signer_identity: Optional[str] = None,
        signature_type: AuditorSignatureType = AuditorSignatureType.ENGINE_HMAC,
    ) -> EvidenceVerificationReceipt:
        engine_ver = verifier_engine_version or self.default_engine_version
        signer_id = signer_identity or self.default_signer_identity
        receipt_id = f"rcpt_{secrets.token_hex(16)}"
        verified_at = datetime.now(timezone.utc).isoformat()

        if len(spans) == 0:
            dummy_item = SpanVerificationItem(
                span_id="span_missing_dummy_none",
                span_hash_matched=False,
                source_doc_verified=False,
                paragraph_exact_match=False,
                check_status=SpanVerificationCheckStatus.FAIL_TEXT_NOT_FOUND,
            )
            raw_payload = {
                "receipt_id": receipt_id,
                "assertion_id": assertion_id,
                "revision_id": revision_id,
                "verified_at": verified_at,
                "verifier_engine_version": engine_ver,
                "span_verifications": [dummy_item.model_dump()],
                "overall_verification_verdict": OverallVerificationVerdict.FAIL_INSUFFICIENT_EVIDENCE.value,
            }
            digest = compute_receipt_digest(raw_payload)
            sig = AuditorSignature(
                signature_type=signature_type,
                signer_identity=signer_id,
                digest_sha256=digest,
            )
            return EvidenceVerificationReceipt(
                receipt_id=receipt_id,
                assertion_id=assertion_id,
                revision_id=revision_id,
                verified_at=verified_at,
                verifier_engine_version=engine_ver,
                span_verifications=[dummy_item],
                overall_verification_verdict=OverallVerificationVerdict.FAIL_INSUFFICIENT_EVIDENCE,
                auditor_signature=sig,
            )

        span_verifications: List[SpanVerificationItem] = []
        has_source_retracted = False
        has_hash_mismatch = False
        has_text_not_found = False
        has_source_not_found = False

        for span in spans:
            doc = source_resolver(span.source_doc_id)
            if doc and doc.is_retracted:
                has_source_retracted = True

            item = self.verify_span(span, doc)
            span_verifications.append(item)

            if item.check_status == SpanVerificationCheckStatus.FAIL_HASH_MISMATCH:
                has_hash_mismatch = True
            elif item.check_status == SpanVerificationCheckStatus.FAIL_SOURCE_NOT_FOUND:
                has_source_not_found = True
            elif item.check_status == SpanVerificationCheckStatus.FAIL_TEXT_NOT_FOUND:
                has_text_not_found = True

        overall_verdict = OverallVerificationVerdict.PASS
        if has_source_retracted:
            overall_verdict = OverallVerificationVerdict.FAIL_SOURCE_RETRACTED
        elif has_hash_mismatch:
            overall_verdict = OverallVerificationVerdict.FAIL_HASH_MISMATCH
        elif has_source_not_found or has_text_not_found:
            overall_verdict = OverallVerificationVerdict.FAIL_TEXT_NOT_FOUND

        raw_payload = {
            "receipt_id": receipt_id,
            "assertion_id": assertion_id,
            "revision_id": revision_id,
            "verified_at": verified_at,
            "verifier_engine_version": engine_ver,
            "span_verifications": [item.model_dump() for item in span_verifications],
            "overall_verification_verdict": overall_verdict.value,
        }
        digest = compute_receipt_digest(raw_payload)
        sig = AuditorSignature(
            signature_type=signature_type,
            signer_identity=signer_id,
            digest_sha256=digest,
        )

        return EvidenceVerificationReceipt(
            receipt_id=receipt_id,
            assertion_id=assertion_id,
            revision_id=revision_id,
            verified_at=verified_at,
            verifier_engine_version=engine_ver,
            span_verifications=span_verifications,
            overall_verification_verdict=overall_verdict,
            auditor_signature=sig,
        )

    def handle_source_retraction(
        self,
        retracted_source_doc_id: str,
        spans: List[EvidenceSpan],
    ) -> Tuple[List[EvidenceSpan], List[EvidenceSpan]]:
        affected: List[EvidenceSpan] = []
        updated: List[EvidenceSpan] = []

        for span in spans:
            if span.source_doc_id == retracted_source_doc_id:
                marked = span.model_copy(
                    update={"quality_state": EvidenceSpanQualityState.STALE_SOURCE_RETRACTED}
                )
                affected.append(marked)
                updated.append(marked)
            else:
                updated.append(span)

        return affected, updated


class ConflictArbitrationPipeline:
    def __init__(self, default_arbitrator_id: str = "system:conflict-arbitration-kernel"):
        self.default_arbitrator_id = default_arbitrator_id

    def create_conflict_arbitration(
        self,
        assertion_id: str,
        conflicting_spans: List[ConflictingSpanItem],
        conflict_type: ConflictType,
    ) -> EvidenceConflictArbitration:
        if len(conflicting_spans) < 2:
            raise ValueError("Conflict arbitration requires at least 2 conflicting spans")

        arbitration_id = f"arb_{secrets.token_hex(16)}"
        created_at = datetime.now(timezone.utc).isoformat()

        return EvidenceConflictArbitration(
            arbitration_id=arbitration_id,
            assertion_id=assertion_id,
            conflicting_spans=conflicting_spans,
            conflict_type=conflict_type,
            arbitration_status=ArbitrationStatus.PENDING_ARBITRATION,
            created_at=created_at,
        )

    def adjudicate(
        self,
        arbitration: EvidenceConflictArbitration,
        policy: str = "AUTO_PRIORITY",
        arbitrator_id: Optional[str] = None,
        chosen_decision: Optional[ArbitrationDecision] = None,
        adopted_span_id: Optional[str] = None,
        custom_rationale: Optional[str] = None,
    ) -> EvidenceConflictArbitration:
        arb_id = arbitrator_id or self.default_arbitrator_id
        now = datetime.now(timezone.utc).isoformat()

        if policy == "ALLOW_RANGE":
            rationale = (
                custom_rationale
                or f"Numerical / temporal divergence reconciled as authoritative estimated range across multiple reliable sources ({len(arbitration.conflicting_spans)} reporting channels)."
            )
            return arbitration.model_copy(
                update={
                    "arbitration_status": ArbitrationStatus.RECONCILED_AS_RANGE,
                    "adjudication": ArbitrationAdjudication(
                        adjudicated_at=now,
                        arbitrator_id=arb_id,
                        chosen_decision=ArbitrationDecision.PUBLISH_AS_ESTIMATED_RANGE,
                        arbitration_rationale=rationale,
                    ),
                }
            )

        if policy == "MANUAL" and chosen_decision:
            decision = chosen_decision
            status = ArbitrationStatus.PENDING_ARBITRATION
            if decision in (
                ArbitrationDecision.ADOPT_HIGHER_AUTHORITY,
                ArbitrationDecision.ADOPT_LATEST_TIMESTAMPS,
            ):
                status = ArbitrationStatus.RESOLVED_ADOPTED
            elif decision == ArbitrationDecision.PUBLISH_AS_ESTIMATED_RANGE:
                status = ArbitrationStatus.RECONCILED_AS_RANGE
            elif decision == ArbitrationDecision.SUSPEND_PENDING_OFFICIAL_CLARIFICATION:
                status = ArbitrationStatus.PENDING_ARBITRATION

            rationale = (
                custom_rationale
                or f"Manual adjudication decided by authorized arbitrator {arb_id} under governance policy."
            )
            return arbitration.model_copy(
                update={
                    "arbitration_status": status,
                    "adjudication": ArbitrationAdjudication(
                        adjudicated_at=now,
                        arbitrator_id=arb_id,
                        chosen_decision=decision,
                        adopted_span_id=adopted_span_id,
                        arbitration_rationale=rationale,
                    ),
                }
            )

        # Default policy: AUTO_PRIORITY
        sorted_spans = sorted(
            arbitration.conflicting_spans,
            key=lambda s: AUTHORITY_RANK.get(s.source_authority_level, 99),
        )
        top_span = sorted_spans[0]
        top_rank = AUTHORITY_RANK.get(top_span.source_authority_level, 99)

        top_tied = [
            s for s in sorted_spans if AUTHORITY_RANK.get(s.source_authority_level, 99) == top_rank
        ]
        distinct_vals = {json.dumps(s.reported_value, sort_keys=True) for s in top_tied}

        if len(top_tied) > 1 and len(distinct_vals) > 1:
            rationale = (
                custom_rationale
                or f"Major contradiction detected between equal-tier authority sources ({top_span.source_authority_level.value}). Automatic resolution suspended pending official clarification."
            )
            return arbitration.model_copy(
                update={
                    "arbitration_status": ArbitrationStatus.PENDING_ARBITRATION,
                    "adjudication": ArbitrationAdjudication(
                        adjudicated_at=now,
                        arbitrator_id=arb_id,
                        chosen_decision=ArbitrationDecision.SUSPEND_PENDING_OFFICIAL_CLARIFICATION,
                        arbitration_rationale=rationale,
                    ),
                }
            )

        adopted = top_span
        rationale = (
            custom_rationale
            or f"Adopted higher authority level ({adopted.source_authority_level.value}) from span {adopted.span_id} over subordinate reporting channels."
        )
        return arbitration.model_copy(
            update={
                "arbitration_status": ArbitrationStatus.RESOLVED_ADOPTED,
                "adjudication": ArbitrationAdjudication(
                    adjudicated_at=now,
                    arbitrator_id=arb_id,
                    chosen_decision=ArbitrationDecision.ADOPT_HIGHER_AUTHORITY,
                    adopted_span_id=adopted.span_id,
                    arbitration_rationale=rationale,
                ),
            }
        )
