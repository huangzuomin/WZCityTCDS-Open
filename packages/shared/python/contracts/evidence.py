"""Evidence traceability and conflict arbitration contracts (Python Pydantic v2)."""
from __future__ import annotations
from enum import Enum
from typing import Any, List, Optional
from pydantic import BaseModel, ConfigDict, Field


class EvidenceSpanQualityState(str, Enum):
    VALIDATED = "VALIDATED"
    PENDING_VERIFICATION = "PENDING_VERIFICATION"
    STALE_SOURCE_RETRACTED = "STALE_SOURCE_RETRACTED"
    TAMPERED_HASH_MISMATCH = "TAMPERED_HASH_MISMATCH"


class ExtractorMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")
    engine_version: Optional[str] = None
    confidence_score: Optional[float] = Field(None, ge=0.0, le=1.0)
    model_fingerprint: Optional[str] = None
    prompt_template_id: Optional[str] = None


class EvidenceSpan(BaseModel):
    model_config = ConfigDict(extra="forbid")
    span_id: str = Field(..., pattern=r"^span_[a-zA-Z0-9_-]{12,64}$")
    source_doc_id: str = Field(..., min_length=1, max_length=128)
    source_url: Optional[str] = None
    paragraph_index: int = Field(..., ge=0)
    char_start: int = Field(..., ge=0)
    char_end: int = Field(..., ge=1)
    quoted_text: str = Field(..., min_length=1, max_length=8192)
    span_hash: str = Field(..., pattern=r"^[a-fA-F0-9]{64}$")
    extracted_at: str
    extractor_metadata: Optional[ExtractorMetadata] = None
    quality_state: EvidenceSpanQualityState


class SpanVerificationCheckStatus(str, Enum):
    PASS = "PASS"
    FAIL_HASH_MISMATCH = "FAIL_HASH_MISMATCH"
    FAIL_SOURCE_NOT_FOUND = "FAIL_SOURCE_NOT_FOUND"
    FAIL_TEXT_NOT_FOUND = "FAIL_TEXT_NOT_FOUND"


class SpanVerificationItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    span_id: str
    span_hash_matched: bool
    source_doc_verified: bool
    paragraph_exact_match: bool
    check_status: SpanVerificationCheckStatus
    computed_hash: Optional[str] = Field(None, pattern=r"^[a-fA-F0-9]{64}$")


class OverallVerificationVerdict(str, Enum):
    PASS = "PASS"
    FAIL_HASH_MISMATCH = "FAIL_HASH_MISMATCH"
    FAIL_SOURCE_RETRACTED = "FAIL_SOURCE_RETRACTED"
    FAIL_TEXT_NOT_FOUND = "FAIL_TEXT_NOT_FOUND"
    FAIL_INSUFFICIENT_EVIDENCE = "FAIL_INSUFFICIENT_EVIDENCE"


class AuditorSignatureType(str, Enum):
    ENGINE_HMAC = "ENGINE_HMAC"
    SIGSTORE_OIDC = "SIGSTORE_OIDC"
    SYSTEM_KEY = "SYSTEM_KEY"


class AuditorSignature(BaseModel):
    model_config = ConfigDict(extra="forbid")
    signature_type: AuditorSignatureType
    signer_identity: str
    digest_sha256: str = Field(..., pattern=r"^[a-fA-F0-9]{64}$")


class EvidenceVerificationReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid")
    receipt_id: str = Field(..., pattern=r"^rcpt_[a-zA-Z0-9_-]{12,64}$")
    assertion_id: str = Field(..., pattern=r"^ast_[a-zA-Z0-9_-]{12,64}$")
    revision_id: str = Field(..., pattern=r"^rev_[a-zA-Z0-9_-]{12,64}$")
    verified_at: str
    verifier_engine_version: str = Field(..., min_length=1, max_length=64)
    span_verifications: List[SpanVerificationItem] = Field(..., min_length=1)
    overall_verification_verdict: OverallVerificationVerdict
    auditor_signature: AuditorSignature


class SourceAuthorityLevel(str, Enum):
    OFFICIAL_GOVERNMENT_RELEASE = "OFFICIAL_GOVERNMENT_RELEASE"
    STATE_MEDIA_PRIMARY = "STATE_MEDIA_PRIMARY"
    LOCAL_MEDIA_REPORT = "LOCAL_MEDIA_REPORT"
    COMMERCIAL_PORTAL = "COMMERCIAL_PORTAL"


class ConflictingSpanItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    span_id: str
    source_doc_id: str
    reported_value: Any
    source_authority_level: SourceAuthorityLevel


class ConflictType(str, Enum):
    NUMERICAL_DISCREPANCY = "NUMERICAL_DISCREPANCY"
    TEMPORAL_SCOPE_MISMATCH = "TEMPORAL_SCOPE_MISMATCH"
    STATUS_CONTRADICTION = "STATUS_CONTRADICTION"
    GEOGRAPHIC_BOUNDARY_DIVERGENCE = "GEOGRAPHIC_BOUNDARY_DIVERGENCE"


class ArbitrationStatus(str, Enum):
    PENDING_ARBITRATION = "PENDING_ARBITRATION"
    RESOLVED_ADOPTED = "RESOLVED_ADOPTED"
    RECONCILED_AS_RANGE = "RECONCILED_AS_RANGE"
    REJECTED_UNRESOLVABLE = "REJECTED_UNRESOLVABLE"


class ArbitrationDecision(str, Enum):
    ADOPT_HIGHER_AUTHORITY = "ADOPT_HIGHER_AUTHORITY"
    ADOPT_LATEST_TIMESTAMPS = "ADOPT_LATEST_TIMESTAMPS"
    PUBLISH_AS_ESTIMATED_RANGE = "PUBLISH_AS_ESTIMATED_RANGE"
    SUSPEND_PENDING_OFFICIAL_CLARIFICATION = "SUSPEND_PENDING_OFFICIAL_CLARIFICATION"


class ArbitrationAdjudication(BaseModel):
    model_config = ConfigDict(extra="forbid")
    adjudicated_at: Optional[str] = None
    arbitrator_id: Optional[str] = None
    chosen_decision: Optional[ArbitrationDecision] = None
    adopted_span_id: Optional[str] = None
    arbitration_rationale: Optional[str] = Field(None, min_length=10, max_length=2048)


class EvidenceConflictArbitration(BaseModel):
    model_config = ConfigDict(extra="forbid")
    arbitration_id: str = Field(..., pattern=r"^arb_[a-zA-Z0-9_-]{12,64}$")
    assertion_id: str = Field(..., pattern=r"^ast_[a-zA-Z0-9_-]{12,64}$")
    conflicting_spans: List[ConflictingSpanItem] = Field(..., min_length=2)
    conflict_type: ConflictType
    arbitration_status: ArbitrationStatus
    created_at: str
    adjudication: Optional[ArbitrationAdjudication] = None
