"""Fact revision lifecycle and publication contracts (Python Pydantic v2)."""
from __future__ import annotations
from enum import Enum
from typing import Any, List, Optional
from pydantic import BaseModel, ConfigDict, Field


class FactLifecycleState(str, Enum):
    DRAFT = "DRAFT"
    PENDING_REVIEW = "PENDING_REVIEW"
    PUBLISHED = "PUBLISHED"
    SUPERSEDED = "SUPERSEDED"
    REVOKED = "REVOKED"


class FactDataType(str, Enum):
    STRING = "STRING"
    NUMBER = "NUMBER"
    BOOLEAN = "BOOLEAN"
    QUANTITY = "QUANTITY"
    TEMPORAL_RANGE = "TEMPORAL_RANGE"
    GEO_SHAPE = "GEO_SHAPE"


class TemporalValidity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    valid_from: Optional[str] = None
    valid_to: Optional[str] = None
    statistical_period: Optional[str] = Field(None, max_length=64)


class SpatialScope(BaseModel):
    model_config = ConfigDict(extra="forbid")
    region_code: Optional[str] = Field(None, pattern=r"^[0-9]{6}$")
    region_name: Optional[str] = None


class AssertionValue(BaseModel):
    model_config = ConfigDict(extra="forbid")
    raw_value: Any
    data_type: FactDataType
    unit: Optional[str] = Field(None, max_length=32)
    temporal_validity: Optional[TemporalValidity] = None
    spatial_scope: Optional[SpatialScope] = None


class RevisionRole(str, Enum):
    FACT_EXTRACTOR = "FACT_EXTRACTOR"
    FACT_REVIEWER = "FACT_REVIEWER"
    FACT_ARBITRATOR = "FACT_ARBITRATOR"
    SYSTEM_MIGRATION = "SYSTEM_MIGRATION"


class RevisionReason(str, Enum):
    INITIAL_PUBLISH = "INITIAL_PUBLISH"
    STATISTICAL_UPDATE = "STATISTICAL_UPDATE"
    ERRATUM_CORRECTION = "ERRATUM_CORRECTION"
    SOURCE_EXPANSION = "SOURCE_EXPANSION"
    SOURCE_RETRACTION_ADJUSTMENT = "SOURCE_RETRACTION_ADJUSTMENT"


class RevisionMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")
    parent_revision_sha256: str = Field(..., pattern=r"^([a-fA-F0-9]{64}|GENESIS)$")
    created_at: str
    created_by_role: RevisionRole
    author_id: Optional[str] = Field(None, min_length=1, max_length=64)
    revision_reason: RevisionReason
    reason_description: Optional[str] = Field(None, max_length=1024)
    evidence_span_hashes: List[str] = Field(..., min_length=1)


class FactRevisionLifecycle(BaseModel):
    model_config = ConfigDict(extra="forbid")
    assertion_id: str = Field(..., pattern=r"^ast_[a-zA-Z0-9_-]{12,64}$")
    revision_id: str = Field(..., pattern=r"^rev_[a-zA-Z0-9_-]{12,64}$")
    revision_number: Optional[int] = Field(None, ge=1)
    entity_id: str = Field(..., pattern=r"^ent_[a-z0-9_-]{8,64}$")
    property_path: str = Field(..., min_length=1, max_length=128)
    assertion_value: AssertionValue
    lifecycle_state: FactLifecycleState
    revision_metadata: RevisionMetadata


class PublishedAssertionItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    assertion_id: str
    revision_id: str
    property_path: str
    raw_value: Any
    unit: Optional[str] = None
    evidence_hashes: List[str] = Field(..., min_length=1)


class OutletScope(str, Enum):
    HUB_ONE_WAY_PROJECTION = "HUB_ONE_WAY_PROJECTION"
    PUBLIC_HTML_ARCHIVE = "PUBLIC_HTML_ARCHIVE"
    REST_API = "REST_API"
    FEED_ATOM = "FEED_ATOM"
    MCP_ENDPOINT = "MCP_ENDPOINT"


class ProjectionMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kernel_system: str = Field(..., pattern=r"^WZCityTCDS-PublicationKernel$")
    publisher_role: str = Field(..., pattern=r"^(CHIEF_FACT_EDITOR|AUTOMATED_RELEASE_BOT)$")
    outlet_scopes: List[OutletScope] = Field(..., min_length=1)
    is_latest_snapshot: bool


class PublicationSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    publication_id: str = Field(..., pattern=r"^pub_[a-zA-Z0-9_-]{12,64}$")
    snapshot_revision_id: str = Field(..., pattern=r"^pubrev_[a-zA-Z0-9_-]{12,64}$")
    entity_id: str = Field(..., pattern=r"^ent_[a-z0-9_-]{8,64}$")
    entity_canonical_name: Optional[str] = Field(None, min_length=1, max_length=256)
    generated_at: str
    snapshot_digest_sha256: str = Field(..., pattern=r"^[a-fA-F0-9]{64}$")
    published_assertions: List[PublishedAssertionItem] = Field(..., min_length=1)
    projection_metadata: ProjectionMetadata


class RevisionTransitionFromState(str, Enum):
    DRAFT = "DRAFT"
    PENDING_REVIEW = "PENDING_REVIEW"
    PUBLISHED = "PUBLISHED"


class RevisionTransitionToState(str, Enum):
    PENDING_REVIEW = "PENDING_REVIEW"
    PUBLISHED = "PUBLISHED"
    SUPERSEDED = "SUPERSEDED"
    REVOKED = "REVOKED"
    REJECTED = "REJECTED"


class RevisionTransitionTrigger(str, Enum):
    SUBMIT_FOR_REVIEW = "SUBMIT_FOR_REVIEW"
    APPROVE_AND_PUBLISH = "APPROVE_AND_PUBLISH"
    SUPERSEDE_WITH_NEW_REVISION = "SUPERSEDE_WITH_NEW_REVISION"
    REVOKE_PUBLISHED_FACT = "REVOKE_PUBLISHED_FACT"
    REJECT_CANDIDATE = "REJECT_CANDIDATE"


class RevisionTransitionRole(str, Enum):
    FACT_EXTRACTOR = "FACT_EXTRACTOR"
    FACT_REVIEWER = "FACT_REVIEWER"
    FACT_ARBITRATOR = "FACT_ARBITRATOR"
    CHIEF_EDITOR = "CHIEF_EDITOR"


class RevisionStateTransition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    transition_id: str = Field(..., pattern=r"^trans_[a-zA-Z0-9_-]{12,64}$")
    assertion_id: str = Field(..., pattern=r"^ast_[a-zA-Z0-9_-]{12,64}$")
    revision_id: str = Field(..., pattern=r"^rev_[a-zA-Z0-9_-]{12,64}$")
    from_state: RevisionTransitionFromState
    to_state: RevisionTransitionToState
    transition_trigger: RevisionTransitionTrigger
    authorized_role: RevisionTransitionRole
    operator_id: Optional[str] = Field(None, min_length=1, max_length=64)
    transition_timestamp: str
    superseded_by_revision_id: Optional[str] = Field(None, pattern=r"^rev_[a-zA-Z0-9_-]{12,64}$")
    revocation_reason: Optional[str] = Field(None, min_length=5, max_length=1024)
