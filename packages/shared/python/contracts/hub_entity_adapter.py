"""Urban Spatio-Temporal Trusted Content Hub Entity Master Data Single Root Alignment Adapter (Python).

Conforms to S1 (Option A) and S2 (ENTITY-AND-SOURCE-CONTRACT.md).
Zero local entity master tables: all canonical identities belong to Hub.
"""
from __future__ import annotations
import re
import secrets
import time
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Dict, List, Optional

from packages.shared.python.contracts.entity_lookup import (
    EntityCategory,
    EntityLookupMessage,
    EntityLookupRequest,
    EntityLookupResponse,
    EntityResolutionStatus,
    HubAdjudication,
    MatchedEntity,
    ProposalSourceEvidence,
    ProposalStatus,
    SpatialCoordinates,
    UnresolvedEntityProposal,
)

ENTITY_ID_REGEX = re.compile(r"^ent_[a-z0-9_-]{8,64}$")
PROPOSAL_ID_REGEX = re.compile(r"^prop_[a-zA-Z0-9_-]{12,64}$")
MESSAGE_ID_REGEX = re.compile(r"^msg_[a-zA-Z0-9_-]{12,64}$")


def assert_valid_entity_id(entity_id: str) -> None:
    """Assert that an entity ID strictly adheres to the Hub single-root format."""
    if not ENTITY_ID_REGEX.fullmatch(entity_id):
        raise ValueError(
            f'Invalid Hub entity_id format: "{entity_id}". '
            f"Must match ^ent_[a-z0-9_-]{{8,64}}$ as mandated by S1/S2 single-root contracts."
        )


class IHubEntityTransport(ABC):
    """Transport interface for communicating with the Urban Spatio-Temporal Hub EntityResolver."""

    @abstractmethod
    def lookup(self, message: EntityLookupMessage) -> EntityLookupMessage:
        pass

    @abstractmethod
    def submit_proposal(self, proposal: UnresolvedEntityProposal) -> UnresolvedEntityProposal:
        pass

    @abstractmethod
    def fetch_proposal(self, proposal_id: str) -> Optional[UnresolvedEntityProposal]:
        pass


class MockHubEntityTransport(IHubEntityTransport):
    """In-memory Mock Transport with default Wenzhou seed entities for testing and offline/local execution."""

    def __init__(self, seed_defaults: bool = True) -> None:
        self.all_entities: List[MatchedEntity] = []
        self.proposals: Dict[str, UnresolvedEntityProposal] = {}
        if seed_defaults:
            self._seed_defaults()

    def _seed_defaults(self) -> None:
        default_seeds = [
            MatchedEntity(
                entity_id="ent_wz_lucheng_gov_001",
                canonical_name="温州市鹿城区人民政府",
                aliases=["鹿城区政府", "鹿城区人民政府"],
                category=EntityCategory.ADMIN_DIVISION,
                confidence=0.98,
                hub_uri="https://hub.wenzhou.gov.cn/entities/ent_wz_lucheng_gov_001",
                spatial_coordinates=SpatialCoordinates(longitude=120.655, latitude=28.016),
            ),
            MatchedEntity(
                entity_id="ent_wz_wuma_street_002",
                canonical_name="五马历史文化街区",
                aliases=["五马街", "禅街", "五马步行街"],
                category=EntityCategory.POI,
                confidence=0.95,
                hub_uri="https://hub.wenzhou.gov.cn/entities/ent_wz_wuma_street_002",
                spatial_coordinates=SpatialCoordinates(longitude=120.662, latitude=28.021),
            ),
            MatchedEntity(
                entity_id="ent_wz_sanyang_wetland_003",
                canonical_name="三垟湿地公园",
                aliases=["三垟湿地", "温州生态园", "温州三垟湿地"],
                category=EntityCategory.GEO_FEATURE,
                confidence=0.92,
                hub_uri="https://hub.wenzhou.gov.cn/entities/ent_wz_sanyang_wetland_003",
                spatial_coordinates=SpatialCoordinates(longitude=120.718, latitude=27.973),
            ),
            MatchedEntity(
                entity_id="ent_wz_nanxi_river_004",
                canonical_name="楠溪江风景名胜区",
                aliases=["楠溪江", "永嘉楠溪江"],
                category=EntityCategory.NATURAL_RESOURCE,
                confidence=0.94,
                hub_uri="https://hub.wenzhou.gov.cn/entities/ent_wz_nanxi_river_004",
                spatial_coordinates=SpatialCoordinates(longitude=120.732, latitude=28.188),
            ),
            MatchedEntity(
                entity_id="ent_wz_first_hospital_005",
                canonical_name="温州医科大学附属第一医院",
                aliases=["温州第一人民医院", "温医一院", "温州人民医院"],
                category=EntityCategory.ORGANIZATION,
                confidence=0.82,
                hub_uri="https://hub.wenzhou.gov.cn/entities/ent_wz_first_hospital_005",
                spatial_coordinates=SpatialCoordinates(longitude=120.687, latitude=27.943),
            ),
            MatchedEntity(
                entity_id="ent_wz_central_hospital_006",
                canonical_name="温州市中心医院",
                aliases=["温州市第二人民医院", "市中心医院", "温州人民医院"],
                category=EntityCategory.ORGANIZATION,
                confidence=0.81,
                hub_uri="https://hub.wenzhou.gov.cn/entities/ent_wz_central_hospital_006",
                spatial_coordinates=SpatialCoordinates(longitude=120.648, latitude=28.025),
            ),
        ]
        for ent in default_seeds:
            self.register_entity(ent)

    def register_entity(self, entity: MatchedEntity) -> None:
        if not any(e.entity_id == entity.entity_id for e in self.all_entities):
            self.all_entities.append(entity)

    def lookup(self, message: EntityLookupMessage) -> EntityLookupMessage:
        req = message.request
        if not req:
            raise ValueError("LOOKUP_REQUEST must contain a valid request body")

        query = req.query_text.strip()
        matches: List[MatchedEntity] = []

        for ent in self.all_entities:
            if any(m.entity_id == ent.entity_id for m in matches):
                continue
            if ent.canonical_name == query or (ent.aliases and query in ent.aliases):
                matches.append(ent)
                continue
            if ent.canonical_name in query or query in ent.canonical_name:
                matches.append(ent)
                continue
            if ent.aliases and any(a in query or query in a for a in ent.aliases):
                matches.append(ent)

        if req.expected_categories:
            matches = [m for m in matches if m.category in req.expected_categories]

        max_cand = req.max_candidates or 5
        final_matches = matches[:max_cand]

        resolution_status = EntityResolutionStatus.UNRESOLVED_NOT_FOUND
        selected_entity_id: Optional[str] = None

        if len(final_matches) == 1 and final_matches[0].confidence >= 0.85:
            resolution_status = EntityResolutionStatus.EXACT_MATCH
            selected_entity_id = final_matches[0].entity_id
        elif len(final_matches) > 1:
            top = final_matches[0]
            second = final_matches[1]
            if top.confidence >= 0.85 and (top.confidence - second.confidence) >= 0.15:
                resolution_status = EntityResolutionStatus.EXACT_MATCH
                selected_entity_id = top.entity_id
            else:
                resolution_status = EntityResolutionStatus.MULTIPLE_MATCHES
        elif len(final_matches) == 1:
            resolution_status = EntityResolutionStatus.MULTIPLE_MATCHES

        resp_payload = EntityLookupResponse(
            resolution_status=resolution_status,
            selected_entity_id=selected_entity_id,
            matches=final_matches,
        )

        resp_envelope = EntityLookupMessage(
            protocol_version="1.0.0",
            message_id=f"msg_resp_{int(time.time()*1000)}_{secrets.token_hex(4)}",
            timestamp=datetime.now(timezone.utc).isoformat(),
            message_type="LOOKUP_RESPONSE",
            response=resp_payload,
        )
        return resp_envelope

    def submit_proposal(self, proposal: UnresolvedEntityProposal) -> UnresolvedEntityProposal:
        self.proposals[proposal.proposal_id] = proposal.model_copy()
        return proposal

    def fetch_proposal(self, proposal_id: str) -> Optional[UnresolvedEntityProposal]:
        found = self.proposals.get(proposal_id)
        return found.model_copy() if found else None

    def adjudicate_proposal(
        self,
        proposal_id: str,
        status: ProposalStatus,
        adjudication: HubAdjudication,
    ) -> UnresolvedEntityProposal:
        existing = self.proposals.get(proposal_id)
        if not existing:
            raise KeyError(f"Proposal not found: {proposal_id}")

        updated = existing.model_copy(
            update={
                "proposal_status": status,
                "hub_adjudication": adjudication,
            }
        )
        self.proposals[proposal_id] = updated
        return updated


class HubEntityAdapter:
    """Urban Spatio-Temporal Trusted Content Hub Entity Master Data Single Root Alignment Adapter."""

    def __init__(
        self,
        transport: Optional[IHubEntityTransport] = None,
        confidence_threshold: float = 0.85,
        enable_cache: bool = True,
        cache_ttl_seconds: int = 300,
        proposer_system: str = "WZCityTCDS",
    ) -> None:
        self.transport = transport or MockHubEntityTransport()
        self.confidence_threshold = confidence_threshold
        self.enable_cache = enable_cache
        self.cache_ttl_seconds = cache_ttl_seconds
        self.proposer_system = proposer_system
        self._cache: Dict[str, tuple[EntityLookupResponse, float]] = {}

    def _build_cache_key(self, req: EntityLookupRequest) -> str:
        cats = ",".join(sorted(c.value for c in req.expected_categories)) if req.expected_categories else ""
        region = req.spatial_filter.region_code if req.spatial_filter and req.spatial_filter.region_code else ""
        return f"{req.query_text.strip().lower()}|{req.context_snippet or ''}|{cats}|{region}"

    def lookup_entity(
        self,
        request: EntityLookupRequest,
        bypass_cache: bool = False,
    ) -> EntityLookupResponse:
        now = time.time()
        cache_key = self._build_cache_key(request)

        if self.enable_cache and not bypass_cache:
            if cache_key in self._cache:
                cached_resp, expires_at = self._cache[cache_key]
                if expires_at > now:
                    return cached_resp

        message_id = f"msg_req_{int(now*1000)}_{secrets.token_hex(4)}"
        envelope = EntityLookupMessage(
            protocol_version="1.0.0",
            message_id=message_id,
            timestamp=datetime.now(timezone.utc).isoformat(),
            message_type="LOOKUP_REQUEST",
            request=request,
        )

        resp_envelope = self.transport.lookup(envelope)
        if not resp_envelope.response:
            raise ValueError("Response envelope missing response payload")

        classified = self.classify_response(resp_envelope.response)

        if self.enable_cache:
            self._cache[cache_key] = (classified, now + self.cache_ttl_seconds)

        return classified

    def classify_response(self, raw: EntityLookupResponse) -> EntityLookupResponse:
        matches = raw.matches
        if not matches:
            return EntityLookupResponse(
                resolution_status=EntityResolutionStatus.UNRESOLVED_NOT_FOUND,
                selected_entity_id=None,
                matches=[],
            )

        top = matches[0]
        if len(matches) == 1:
            if top.confidence >= self.confidence_threshold:
                assert_valid_entity_id(top.entity_id)
                return EntityLookupResponse(
                    resolution_status=EntityResolutionStatus.EXACT_MATCH,
                    selected_entity_id=top.entity_id,
                    matches=matches,
                )
            return EntityLookupResponse(
                resolution_status=EntityResolutionStatus.MULTIPLE_MATCHES,
                selected_entity_id=None,
                matches=matches,
            )

        second = matches[1]
        if top.confidence >= self.confidence_threshold and (top.confidence - second.confidence) >= 0.15:
            assert_valid_entity_id(top.entity_id)
            return EntityLookupResponse(
                resolution_status=EntityResolutionStatus.EXACT_MATCH,
                selected_entity_id=top.entity_id,
                matches=matches,
            )

        return EntityLookupResponse(
            resolution_status=EntityResolutionStatus.MULTIPLE_MATCHES,
            selected_entity_id=None,
            matches=matches,
        )

    def submit_unresolved_proposal(
        self,
        candidate_name: str,
        source_evidence: ProposalSourceEvidence,
        suggested_aliases: Optional[List[str]] = None,
        suggested_category: Optional[EntityCategory] = None,
    ) -> UnresolvedEntityProposal:
        proposal_id = f"prop_{int(time.time()*1000)}_{secrets.token_hex(6)}"
        proposal = UnresolvedEntityProposal(
            proposal_id=proposal_id,
            proposer_system=self.proposer_system,
            submitted_at=datetime.now(timezone.utc).isoformat(),
            candidate_name=candidate_name.strip(),
            suggested_aliases=suggested_aliases,
            suggested_category=suggested_category,
            source_evidence=source_evidence,
            proposal_status=ProposalStatus.SUBMITTED,
        )
        return self.transport.submit_proposal(proposal)

    def get_proposal(self, proposal_id: str) -> Optional[UnresolvedEntityProposal]:
        if not PROPOSAL_ID_REGEX.fullmatch(proposal_id):
            raise ValueError(f"Invalid proposal_id format: {proposal_id}")
        return self.transport.fetch_proposal(proposal_id)

    def apply_adjudication(
        self,
        proposal: UnresolvedEntityProposal,
        new_status: ProposalStatus,
        adjudication: HubAdjudication,
    ) -> UnresolvedEntityProposal:
        if new_status == ProposalStatus.ACCEPTED_ALLOCATED:
            if not adjudication.allocated_entity_id:
                raise ValueError("ACCEPTED_ALLOCATED requires allocated_entity_id")
            assert_valid_entity_id(adjudication.allocated_entity_id)
        elif new_status == ProposalStatus.MERGED_AS_ALIAS:
            if not adjudication.allocated_entity_id:
                raise ValueError("MERGED_AS_ALIAS requires allocated_entity_id")
            assert_valid_entity_id(adjudication.allocated_entity_id)

        adj_copy = adjudication.model_copy()
        if not adj_copy.adjudicated_at:
            adj_copy.adjudicated_at = datetime.now(timezone.utc).isoformat()

        return proposal.model_copy(
            update={
                "proposal_status": new_status,
                "hub_adjudication": adj_copy,
            }
        )

    def clear_cache(self) -> None:
        self._cache.clear()
