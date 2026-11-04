"""Entity lookup and unresolved proposal contracts (Python Pydantic v2)."""
from __future__ import annotations
from enum import Enum
from typing import List, Optional, Tuple
from pydantic import BaseModel, ConfigDict, Field


class EntityCategory(str, Enum):
    POI = "POI"
    ADMIN_DIVISION = "ADMIN_DIVISION"
    ORGANIZATION = "ORGANIZATION"
    PERSON = "PERSON"
    EVENT = "EVENT"
    GEO_FEATURE = "GEO_FEATURE"
    NATURAL_RESOURCE = "NATURAL_RESOURCE"


class SpatialFilter(BaseModel):
    model_config = ConfigDict(extra="forbid")
    region_code: Optional[str] = Field(None, pattern=r"^[0-9]{6}$")
    bounding_box: Optional[Tuple[float, float, float, float]] = None


class EntityLookupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query_text: str = Field(..., min_length=1, max_length=256)
    context_snippet: Optional[str] = Field(None, max_length=2048)
    expected_categories: Optional[List[EntityCategory]] = None
    spatial_filter: Optional[SpatialFilter] = None
    max_candidates: int = Field(5, ge=1, le=50)


class SpatialCoordinates(BaseModel):
    model_config = ConfigDict(extra="forbid")
    longitude: float = Field(..., ge=-180.0, le=180.0)
    latitude: float = Field(..., ge=-90.0, le=90.0)


class MatchedEntity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entity_id: str = Field(..., pattern=r"^ent_[a-z0-9_-]{8,64}$")
    canonical_name: str = Field(..., min_length=1, max_length=256)
    aliases: Optional[List[str]] = None
    category: EntityCategory
    confidence: float = Field(..., ge=0.0, le=1.0)
    hub_uri: Optional[str] = None
    spatial_coordinates: Optional[SpatialCoordinates] = None


class EntityResolutionStatus(str, Enum):
    EXACT_MATCH = "EXACT_MATCH"
    MULTIPLE_MATCHES = "MULTIPLE_MATCHES"
    UNRESOLVED_NOT_FOUND = "UNRESOLVED_NOT_FOUND"


class EntityLookupResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    resolution_status: EntityResolutionStatus
    selected_entity_id: Optional[str] = Field(None, pattern=r"^ent_[a-z0-9_-]{8,64}$")
    matches: List[MatchedEntity]


class EntityLookupMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    protocol_version: str = Field(..., pattern=r"^1\.0(\.0)?$")
    message_id: str = Field(..., pattern=r"^msg_[a-zA-Z0-9_-]{12,64}$")
    timestamp: str
    message_type: str = Field(..., pattern=r"^(LOOKUP_REQUEST|LOOKUP_RESPONSE)$")
    request: Optional[EntityLookupRequest] = None
    response: Optional[EntityLookupResponse] = None


class ProposalSourceEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_doc_id: str = Field(..., min_length=1, max_length=128)
    context_snippet: str = Field(..., min_length=1, max_length=4096)
    evidence_span_hash: str = Field(..., pattern=r"^[a-fA-F0-9]{64}$")


class ProposalStatus(str, Enum):
    SUBMITTED = "SUBMITTED"
    IN_HUB_REVIEW = "IN_HUB_REVIEW"
    ACCEPTED_ALLOCATED = "ACCEPTED_ALLOCATED"
    MERGED_AS_ALIAS = "MERGED_AS_ALIAS"
    REJECTED = "REJECTED"


class HubAdjudication(BaseModel):
    model_config = ConfigDict(extra="forbid")
    adjudicated_at: Optional[str] = None
    allocated_entity_id: Optional[str] = Field(None, pattern=r"^ent_[a-z0-9_-]{8,64}$")
    canonical_name: Optional[str] = None
    resolution_notes: Optional[str] = None


class UnresolvedEntityProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")
    proposal_id: str = Field(..., pattern=r"^prop_[a-zA-Z0-9_-]{12,64}$")
    proposer_system: str = Field(..., pattern=r"^(WZCityTCDS|WZCityTCDS-ExtractionEngine)$")
    submitted_at: str
    candidate_name: str = Field(..., min_length=1, max_length=256)
    suggested_aliases: Optional[List[str]] = None
    suggested_category: Optional[EntityCategory] = None
    source_evidence: ProposalSourceEvidence
    proposal_status: ProposalStatus
    hub_adjudication: Optional[HubAdjudication] = None
