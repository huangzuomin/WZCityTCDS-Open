"""Public outlet multi-channel and security gate contracts (Python Pydantic v2)."""
from __future__ import annotations
from enum import Enum
from typing import List, Optional
from pydantic import BaseModel, ConfigDict, Field


class OutletChannel(str, Enum):
    PUBLIC_HTML_ARCHIVE = "PUBLIC_HTML_ARCHIVE"
    REST_API_V1 = "REST_API_V1"
    JSON_LD_CARD = "JSON_LD_CARD"
    FEED_ATOM_V1 = "FEED_ATOM_V1"
    XML_SITEMAP = "XML_SITEMAP"
    CHANGES_STREAM_NDJSON = "CHANGES_STREAM_NDJSON"
    LLM_MCP_ENDPOINT = "LLM_MCP_ENDPOINT"


class PayloadFormat(str, Enum):
    HTML = "HTML"
    JSON = "JSON"
    JSON_LD = "JSON_LD"
    XML_ATOM = "XML_ATOM"
    XML_SITEMAP = "XML_SITEMAP"
    NDJSON = "NDJSON"


class DeliveryStatus(str, Enum):
    ACTIVE_CURRENT = "ACTIVE_CURRENT"
    SUPERSEDED_HISTORICAL = "SUPERSEDED_HISTORICAL"
    REVOKED_TOMBSTONE = "REVOKED_TOMBSTONE"


class TombstoneDetails(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revoked_at: Optional[str] = None
    revocation_notice: Optional[str] = Field(None, max_length=1024)
    http_status_code: Optional[int] = Field(None, pattern=r"^(410|404)$")


class CacheControlPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    cache_policy: str = Field(..., pattern=r"^(PUBLIC_IMMUTABLE|PUBLIC_REVALIDATE|NO_STORE)$")
    max_age_seconds: int = Field(..., ge=0)


class PublicOutletDelivery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    outlet_channel: OutletChannel
    publication_id: str = Field(..., pattern=r"^pub_[a-zA-Z0-9_-]{12,64}$")
    snapshot_revision_id: str = Field(..., pattern=r"^pubrev_[a-zA-Z0-9_-]{12,64}$")
    entity_id: str = Field(..., pattern=r"^ent_[a-z0-9_-]{8,64}$")
    canonical_url: Optional[str] = None
    published_at: str
    snapshot_digest_sha256: str = Field(..., pattern=r"^[a-fA-F0-9]{64}$")
    payload_format: PayloadFormat
    delivery_status: DeliveryStatus
    tombstone_details: Optional[TombstoneDetails] = None
    cache_control: Optional[CacheControlPolicy] = None


class GateVerdict(str, Enum):
    PASS_APPROVED_FOR_RELEASE = "PASS_APPROVED_FOR_RELEASE"
    FAIL_CLOSED_BLOCKED = "FAIL_CLOSED_BLOCKED"


class SingleRuleEvaluation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    passed: bool
    count: Optional[int] = None


class RuleEvaluations(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rule_only_published_state: dict
    rule_evidence_receipt_pass: dict
    rule_no_private_ip_leaks: dict
    rule_no_credential_patterns: dict
    rule_source_validity_confirmed: dict


class GateController(BaseModel):
    model_config = ConfigDict(extra="forbid")
    controller_role: str = Field(..., pattern=r"^(FPF_PUBLICATION_SECURITY_GATE|SECURITY_OFFICER)$")
    signature_hash: str = Field(..., pattern=r"^[a-fA-F0-9]{64}$")


class PublicationSecurityGatePolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    gate_evaluation_id: str = Field(..., pattern=r"^gate_[a-zA-Z0-9_-]{12,64}$")
    snapshot_revision_id: str = Field(..., pattern=r"^pubrev_[a-zA-Z0-9_-]{12,64}$")
    evaluated_at: str
    gate_verdict: GateVerdict
    rule_evaluations: RuleEvaluations
    gate_controller: Optional[GateController] = None


class StreamChangeType(str, Enum):
    FACT_PUBLISHED = "FACT_PUBLISHED"
    FACT_CORRECTED = "FACT_CORRECTED"
    FACT_REVOKED = "FACT_REVOKED"
    SNAPSHOT_SEALED = "SNAPSHOT_SEALED"


class AffectedRevision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision_id: str
    property_path: str
    lifecycle_state: str = Field(..., pattern=r"^(PUBLISHED|SUPERSEDED|REVOKED)$")
    previous_revision_id: Optional[str] = None
    publication_snapshot_id: Optional[str] = None


class ChangesStreamEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    change_event_id: str = Field(..., pattern=r"^chg_[a-zA-Z0-9_-]{12,64}$")
    change_sequence_num: int = Field(..., ge=1)
    change_type: StreamChangeType
    entity_id: str = Field(..., pattern=r"^ent_[a-z0-9_-]{8,64}$")
    event_timestamp: str
    event_digest_sha256: str = Field(..., pattern=r"^[a-fA-F0-9]{64}$")
    affected_revision: AffectedRevision
