"""
Hub One-Way Projection Inflow & Changes Stream Consumer - Python Contract Mirror (Slice R3)
"""
from __future__ import annotations

import datetime
import enum
import hashlib
import json
import re
import secrets
from typing import Any, Callable, Dict, List, Optional, Union
from pydantic import BaseModel, ConfigDict, Field

from packages.shared.python.contracts.entity_lookup import EntityCategory
from packages.shared.python.contracts.fact_revision import PublicationSnapshot
from packages.shared.python.contracts.outlets import ChangesStreamEvent, PublicationSecurityGatePolicy, GateVerdict

ENTITY_ID_REGEX = re.compile(r"^ent_[a-z0-9_-]{8,64}$")
PROJECTION_ID_REGEX = re.compile(r"^prj_[a-zA-Z0-9_-]{12,64}$")
RECEIPT_ID_REGEX = re.compile(r"^rcpt_[a-zA-Z0-9_-]{12,64}$")
HUB_CHANGE_EVENT_ID_REGEX = re.compile(r"^hchg_[a-zA-Z0-9_-]{12,64}$")


def assert_valid_entity_id(entity_id: str) -> None:
    if not ENTITY_ID_REGEX.match(entity_id):
        raise ValueError(
            f'Invalid Hub entity_id format: "{entity_id}". Must match ^ent_[a-z0-9_-]{{8,64}}$ as mandated by S1/S2 single-root contracts.'
        )


class HubProjectionTarget(str, enum.Enum):
    URBAN_SPATIAL_HUB = "URBAN_SPATIAL_HUB"
    HUB_FACT_LAKE = "HUB_FACT_LAKE"
    HUB_SEARCH_INDEX = "HUB_SEARCH_INDEX"


class ProjectedAssertionItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    property_path: str = Field(min_length=1, max_length=256)
    raw_value: Any
    revision_id: str = Field(min_length=1)
    confidence: float = Field(ge=0.0, le=1.0, default=1.0)


class SpatialAnchor(BaseModel):
    model_config = ConfigDict(extra="forbid")
    longitude: float = Field(ge=-180.0, le=180.0)
    latitude: float = Field(ge=-90.0, le=90.0)
    region_code: Optional[str] = None
    address: Optional[str] = None


class ValidityWindow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    valid_from: str
    valid_to: Optional[str] = None


class HubProjectionPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    projection_id: str = Field(pattern=r"^prj_[a-zA-Z0-9_-]{12,64}$")
    snapshot_revision_id: str = Field(pattern=r"^pubrev_[a-zA-Z0-9_-]{12,64}$")
    entity_id: str = Field(pattern=r"^ent_[a-z0-9_-]{8,64}$")
    target: HubProjectionTarget
    projected_at: str
    snapshot_digest_sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    assertions: List[ProjectedAssertionItem] = Field(min_length=1)
    spatial_anchor: Optional[SpatialAnchor] = None
    validity_window: Optional[ValidityWindow] = None


class HubProjectionReceiptStatus(str, enum.Enum):
    ACCEPTED = "ACCEPTED"
    REJECTED = "REJECTED"
    QUEUED = "QUEUED"


class HubProjectionReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid")
    receipt_id: str = Field(pattern=r"^rcpt_[a-zA-Z0-9_-]{12,64}$")
    projection_id: str = Field(pattern=r"^prj_[a-zA-Z0-9_-]{12,64}$")
    status: HubProjectionReceiptStatus
    hub_slot_id: Optional[str] = None
    acknowledged_at: str
    rejection_reason: Optional[str] = Field(None, max_length=1024)
    receipt_signature_sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")


class HubUpstreamChangeType(str, enum.Enum):
    ENTITY_CREATED = "ENTITY_CREATED"
    ENTITY_UPDATED = "ENTITY_UPDATED"
    ALIAS_ADDED = "ALIAS_ADDED"
    MERGED_INTO = "MERGED_INTO"
    TOMBSTONED = "TOMBSTONED"


class SpatialCoordinates(BaseModel):
    model_config = ConfigDict(extra="forbid")
    longitude: float = Field(ge=-180.0, le=180.0)
    latitude: float = Field(ge=-90.0, le=90.0)


class HubUpstreamChangeEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    hub_change_event_id: str = Field(pattern=r"^hchg_[a-zA-Z0-9_-]{12,64}$")
    hub_sequence_num: int = Field(ge=1)
    change_type: HubUpstreamChangeType
    entity_id: str = Field(pattern=r"^ent_[a-z0-9_-]{8,64}$")
    canonical_name: str = Field(min_length=1, max_length=256)
    aliases: List[str] = Field(default_factory=list)
    category: str
    spatial_coordinates: Optional[SpatialCoordinates] = None
    target_merged_entity_id: Optional[str] = Field(None, pattern=r"^ent_[a-z0-9_-]{8,64}$")
    tombstone_reason: Optional[str] = Field(None, max_length=512)
    timestamp: str
    digest_sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")


def compute_upstream_change_digest(event_dict: dict) -> str:
    cleaned = {k: v for k, v in event_dict.items() if k != "digest_sha256" and v is not None}
    canonical = json.dumps(cleaned, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest().lower()


def compute_receipt_signature(receipt_dict: dict) -> str:
    cleaned = {k: v for k, v in receipt_dict.items() if k != "receipt_signature_sha256" and v is not None}
    canonical = json.dumps(cleaned, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest().lower()


class MockHubProjectionTransport:
    def __init__(self):
        self.received_projections: List[HubProjectionPayload] = []
        self.receipts: Dict[str, HubProjectionReceipt] = {}
        self.should_fail: bool = False
        self.failure_reason: str = "Hub ingestion temporary failure"

    def project(self, payload: HubProjectionPayload) -> HubProjectionReceipt:
        validated = HubProjectionPayload.model_validate(payload)
        self.received_projections.append(validated)

        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        receipt_id = f"rcpt_{secrets.token_hex(16)}"

        if self.should_fail:
            raw_rejected = {
                "receipt_id": receipt_id,
                "projection_id": validated.projection_id,
                "status": HubProjectionReceiptStatus.REJECTED,
                "acknowledged_at": now,
                "rejection_reason": self.failure_reason,
            }
            sig = compute_receipt_signature(raw_rejected)
            receipt = HubProjectionReceipt(
                **raw_rejected,
                receipt_signature_sha256=sig,
            )
            self.receipts[validated.projection_id] = receipt
            return receipt

        slot_id = f"slot_{validated.entity_id}_{secrets.token_hex(6)}"
        raw_accepted = {
            "receipt_id": receipt_id,
            "projection_id": validated.projection_id,
            "status": HubProjectionReceiptStatus.ACCEPTED,
            "hub_slot_id": slot_id,
            "acknowledged_at": now,
        }
        sig = compute_receipt_signature(raw_accepted)
        receipt = HubProjectionReceipt(
            **raw_accepted,
            receipt_signature_sha256=sig,
        )
        self.receipts[validated.projection_id] = receipt
        return receipt

    def health_check(self) -> Dict[str, Any]:
        return {
            "ok": not self.should_fail,
            "status": "DEGRADED" if self.should_fail else "HEALTHY_ONLINE",
        }


class HubOneWayProjector:
    def __init__(self, transport: Optional[MockHubProjectionTransport] = None):
        self.transport = transport or MockHubProjectionTransport()
        self.receipts: List[HubProjectionReceipt] = []
        self.entity_to_receipts: Dict[str, List[HubProjectionReceipt]] = {}

    def project_snapshot(
        self,
        snapshot: PublicationSnapshot,
        target: HubProjectionTarget = HubProjectionTarget.URBAN_SPATIAL_HUB,
        gate_policy: Optional[PublicationSecurityGatePolicy] = None,
        spatial_anchor: Optional[SpatialAnchor] = None,
        validity_window: Optional[ValidityWindow] = None,
    ) -> HubProjectionReceipt:
        assert_valid_entity_id(snapshot.entity_id)

        if gate_policy is not None:
            if gate_policy.gate_verdict != GateVerdict.PASS_APPROVED_FOR_RELEASE:
                raise ValueError(
                    f"Security gate fail-closed: publication cannot be projected to Hub. Gate verdict: {gate_policy.gate_verdict}"
                )

        if not snapshot.published_assertions:
            raise ValueError(
                f"Cannot project empty snapshot for entity {snapshot.entity_id}: zero published assertions"
            )

        assertions = [
            ProjectedAssertionItem(
                property_path=a.property_path,
                raw_value=a.raw_value,
                revision_id=a.revision_id,
                confidence=1.0,
            )
            for a in snapshot.published_assertions
        ]

        projection_id = f"prj_{secrets.token_hex(16)}"
        projected_at = datetime.datetime.now(datetime.timezone.utc).isoformat()

        payload = HubProjectionPayload(
            projection_id=projection_id,
            snapshot_revision_id=snapshot.snapshot_revision_id,
            entity_id=snapshot.entity_id,
            target=target,
            projected_at=projected_at,
            snapshot_digest_sha256=snapshot.snapshot_digest_sha256,
            assertions=assertions,
            spatial_anchor=spatial_anchor,
            validity_window=validity_window,
        )

        receipt = self.transport.project(payload)
        self.receipts.append(receipt)
        lst = self.entity_to_receipts.setdefault(snapshot.entity_id, [])
        lst.append(receipt)
        return receipt

    def get_history(self, entity_id: Optional[str] = None) -> List[HubProjectionReceipt]:
        if entity_id:
            return list(self.entity_to_receipts.get(entity_id, []))
        return list(self.receipts)

    def get_latest_receipt(self, entity_id: str) -> Optional[HubProjectionReceipt]:
        lst = self.entity_to_receipts.get(entity_id)
        if not lst:
            return None
        return lst[-1]


class ProjectedEntityState:
    def __init__(
        self,
        entity_id: str,
        canonical_name: str,
        aliases: List[str],
        category: str,
        spatial_coordinates: Optional[Dict[str, float]] = None,
        is_tombstoned: bool = False,
        tombstone_reason: Optional[str] = None,
        merged_into_entity_id: Optional[str] = None,
        version_sequence: int = 0,
        last_updated_at: str = "",
    ):
        self.entity_id = entity_id
        self.canonical_name = canonical_name
        self.aliases = aliases
        self.category = category
        self.spatial_coordinates = spatial_coordinates
        self.is_tombstoned = is_tombstoned
        self.tombstone_reason = tombstone_reason
        self.merged_into_entity_id = merged_into_entity_id
        self.version_sequence = version_sequence
        self.last_updated_at = last_updated_at
        self.published_facts: Dict[str, Dict[str, Any]] = {}

    def to_dict(self) -> Dict[str, Any]:
        return {
            "entity_id": self.entity_id,
            "canonical_name": self.canonical_name,
            "aliases": list(self.aliases),
            "category": self.category,
            "spatial_coordinates": self.spatial_coordinates,
            "is_tombstoned": self.is_tombstoned,
            "tombstone_reason": self.tombstone_reason,
            "merged_into_entity_id": self.merged_into_entity_id,
            "version_sequence": self.version_sequence,
            "last_updated_at": self.last_updated_at,
            "published_facts": self.published_facts,
        }


class DeadLetterRecord:
    def __init__(self, line_number: int, raw_line: str, error_message: str, received_at: str):
        self.line_number = line_number
        self.raw_line = raw_line
        self.error_message = error_message
        self.received_at = received_at

    def to_dict(self) -> Dict[str, Any]:
        return {
            "line_number": self.line_number,
            "raw_line": self.raw_line,
            "error_message": self.error_message,
            "received_at": self.received_at,
        }


class ChangesStreamConsumer:
    def __init__(self, initial_hub_seq: int = 0, initial_outlet_seq: int = 0):
        self.last_hub_sequence_num = initial_hub_seq
        self.last_outlet_sequence_num = initial_outlet_seq
        self.entity_store: Dict[str, ProjectedEntityState] = {}
        self.dead_letters: List[DeadLetterRecord] = []
        self.listeners: List[Callable[[Any], None]] = []
        self.processed_count = 0
        self.skipped_duplicate_count = 0

    def get_hub_cursor(self) -> int:
        return self.last_hub_sequence_num

    def get_outlet_cursor(self) -> int:
        return self.last_outlet_sequence_num

    def subscribe(self, listener: Callable[[Any], None]) -> Callable[[], None]:
        self.listeners.append(listener)

        def unsubscribe():
            if listener in self.listeners:
                self.listeners.remove(listener)

        return unsubscribe

    def _notify(self, event: Any) -> None:
        for listener in self.listeners:
            try:
                listener(event)
            except Exception:
                pass

    def consume_hub_event(self, event_input: Union[HubUpstreamChangeEvent, dict]) -> Dict[str, Any]:
        if isinstance(event_input, dict):
            event = HubUpstreamChangeEvent.model_validate(event_input)
        else:
            event = event_input

        assert_valid_entity_id(event.entity_id)
        if event.target_merged_entity_id:
            assert_valid_entity_id(event.target_merged_entity_id)

        if event.hub_sequence_num <= self.last_hub_sequence_num:
            self.skipped_duplicate_count += 1
            return {
                "applied": False,
                "reason": f"Duplicate or stale sequence number {event.hub_sequence_num} <= cursor {self.last_hub_sequence_num}",
            }

        computed = compute_upstream_change_digest(event.model_dump(exclude_none=True))
        if computed.lower() != event.digest_sha256.lower():
            raise ValueError(
                f"Event digest mismatch for {event.hub_change_event_id}: expected {event.digest_sha256}, computed {computed}"
            )

        state = self.entity_store.get(event.entity_id)
        coords = (
            event.spatial_coordinates.model_dump() if event.spatial_coordinates else None
        )
        if not state:
            state = ProjectedEntityState(
                entity_id=event.entity_id,
                canonical_name=event.canonical_name,
                aliases=list(event.aliases),
                category=event.category,
                spatial_coordinates=coords,
                is_tombstoned=False,
                version_sequence=event.hub_sequence_num,
                last_updated_at=event.timestamp,
            )

        state.version_sequence = event.hub_sequence_num
        state.last_updated_at = event.timestamp

        if event.change_type in (HubUpstreamChangeType.ENTITY_CREATED, HubUpstreamChangeType.ENTITY_UPDATED):
            state.canonical_name = event.canonical_name
            state.aliases = sorted(list(set(state.aliases + event.aliases)))
            state.category = event.category
            if coords:
                state.spatial_coordinates = coords
        elif event.change_type == HubUpstreamChangeType.ALIAS_ADDED:
            state.aliases = sorted(list(set(state.aliases + event.aliases)))
        elif event.change_type == HubUpstreamChangeType.MERGED_INTO:
            state.merged_into_entity_id = event.target_merged_entity_id
            state.is_tombstoned = True
            state.tombstone_reason = f"Merged into entity {event.target_merged_entity_id}"
        elif event.change_type == HubUpstreamChangeType.TOMBSTONED:
            state.is_tombstoned = True
            state.tombstone_reason = event.tombstone_reason or "Authoritatively tombstoned by Hub"

        self.entity_store[event.entity_id] = state
        self.last_hub_sequence_num = event.hub_sequence_num
        self.processed_count += 1
        self._notify(event)
        return {"applied": True}

    def consume_outlet_event(self, event_input: Union[ChangesStreamEvent, dict]) -> Dict[str, Any]:
        if isinstance(event_input, dict):
            event = ChangesStreamEvent.model_validate(event_input)
        else:
            event = event_input

        assert_valid_entity_id(event.entity_id)

        if event.change_sequence_num <= self.last_outlet_sequence_num:
            self.skipped_duplicate_count += 1
            return {
                "applied": False,
                "reason": f"Duplicate or stale outlet sequence {event.change_sequence_num} <= cursor {self.last_outlet_sequence_num}",
            }

        state = self.entity_store.get(event.entity_id)
        if not state:
            state = ProjectedEntityState(
                entity_id=event.entity_id,
                canonical_name=f"Entity {event.entity_id}",
                aliases=[],
                category="POI",
                is_tombstoned=False,
                version_sequence=0,
                last_updated_at=event.event_timestamp,
            )

        prop = event.affected_revision.property_path
        state.published_facts[prop] = {
            "raw_value": None,
            "revision_id": event.affected_revision.revision_id,
            "lifecycle_state": event.affected_revision.lifecycle_state,
            "updated_at": event.event_timestamp,
        }

        if event.change_type.value == "FACT_REVOKED" and prop == "*":
            state.is_tombstoned = True
            state.tombstone_reason = "All facts revoked"

        self.entity_store[event.entity_id] = state
        self.last_outlet_sequence_num = event.change_sequence_num
        self.processed_count += 1
        self._notify(event)
        return {"applied": True}

    def consume_ndjson(
        self,
        ndjson_stream: str,
        stream_type: str = "HUB_UPSTREAM",
    ) -> Dict[str, int]:
        lines = ndjson_stream.splitlines()
        processed = 0
        skipped = 0
        dead_letters = 0

        for i, line in enumerate(lines):
            line_str = line.strip()
            if not line_str:
                continue

            try:
                parsed = json.loads(line_str)
                if stream_type == "HUB_UPSTREAM":
                    res = self.consume_hub_event(parsed)
                    if res["applied"]:
                        processed += 1
                    else:
                        skipped += 1
                else:
                    res = self.consume_outlet_event(parsed)
                    if res["applied"]:
                        processed += 1
                    else:
                        skipped += 1
            except Exception as e:
                dead_letters += 1
                snippet = line_str[:256] + "..." if len(line_str) > 256 else line_str
                self.dead_letters.append(
                    DeadLetterRecord(
                        line_number=i + 1,
                        raw_line=snippet,
                        error_message=str(e),
                        received_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    )
                )

        return {
            "total_lines": len(lines),
            "processed": processed,
            "skipped": skipped,
            "dead_letters": dead_letters,
        }

    def get_entity_state(self, entity_id: str) -> Optional[Dict[str, Any]]:
        state = self.entity_store.get(entity_id)
        return state.to_dict() if state else None

    def is_tombstoned(self, entity_id: str) -> bool:
        state = self.entity_store.get(entity_id)
        return state.is_tombstoned if state else False

    def list_entities(
        self,
        category: Optional[str] = None,
        include_tombstoned: bool = False,
    ) -> List[Dict[str, Any]]:
        result = []
        for state in self.entity_store.values():
            if category and state.category != category:
                continue
            if not include_tombstoned and state.is_tombstoned:
                continue
            result.append(state.to_dict())
        return result

    def get_dead_letters(self) -> List[Dict[str, Any]]:
        return [dl.to_dict() for dl in self.dead_letters]

    def get_stats(self) -> Dict[str, Any]:
        return {
            "processed": self.processed_count,
            "skipped_duplicates": self.skipped_duplicate_count,
            "dead_letters_count": len(self.dead_letters),
            "projected_entities_count": len(self.entity_store),
            "hub_cursor": self.last_hub_sequence_num,
            "outlet_cursor": self.last_outlet_sequence_num,
        }
