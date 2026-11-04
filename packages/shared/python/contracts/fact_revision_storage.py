"""Append-Only Fact Revision Chain Storage Engine & Publication State Machine (Python).

Conforms to S1 (Option A) and S3 (FACT-REVISION-KERNEL-SPECIFICATION.md).
Enforces immutability, cryptographic hash-chaining, and strict role-gated state transitions.
"""
from __future__ import annotations
import hashlib
import json
import re
import secrets
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from packages.shared.python.contracts.fact_revision import (
    AssertionValue,
    FactLifecycleState,
    FactRevisionLifecycle,
    OutletScope,
    ProjectionMetadata,
    PublicationSnapshot,
    PublishedAssertionItem,
    RevisionMetadata,
    RevisionReason,
    RevisionRole,
    RevisionStateTransition,
    RevisionTransitionFromState,
    RevisionTransitionRole,
    RevisionTransitionToState,
    RevisionTransitionTrigger,
)

ASSERTION_ID_REGEX = re.compile(r"^ast_[a-zA-Z0-9_-]{12,64}$")
REVISION_ID_REGEX = re.compile(r"^rev_[a-zA-Z0-9_-]{12,64}$")
PUBLICATION_ID_REGEX = re.compile(r"^pub_[a-zA-Z0-9_-]{12,64}$")
PUBREV_ID_REGEX = re.compile(r"^pubrev_[a-zA-Z0-9_-]{12,64}$")
TRANSITION_ID_REGEX = re.compile(r"^trans_[a-zA-Z0-9_-]{12,64}$")


def compute_revision_digest(rev: FactRevisionLifecycle) -> str:
    """Computes canonical SHA-256 digest of a FactRevisionLifecycle for hash-chaining."""
    canonical_dict = {
        "assertion_id": rev.assertion_id,
        "revision_id": rev.revision_id,
        "entity_id": rev.entity_id,
        "property_path": rev.property_path,
        "assertion_value": {
            "raw_value": rev.assertion_value.raw_value,
            "data_type": rev.assertion_value.data_type.value,
            "unit": rev.assertion_value.unit,
            "temporal_validity": (
                rev.assertion_value.temporal_validity.model_dump(exclude_none=True)
                if rev.assertion_value.temporal_validity
                else None
            ),
            "spatial_scope": (
                rev.assertion_value.spatial_scope.model_dump(exclude_none=True)
                if rev.assertion_value.spatial_scope
                else None
            ),
        },
        "parent_revision_sha256": rev.revision_metadata.parent_revision_sha256,
        "evidence_span_hashes": sorted(rev.revision_metadata.evidence_span_hashes),
    }
    raw_json = json.dumps(canonical_dict, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw_json.encode("utf-8")).hexdigest()


def compute_snapshot_digest(items: List[PublishedAssertionItem]) -> str:
    """Computes canonical aggregate SHA-256 digest of published items for publication snapshot."""
    sorted_items = sorted(items, key=lambda x: (x.property_path, x.assertion_id))
    canonical_list = [
        {
            "assertion_id": item.assertion_id,
            "revision_id": item.revision_id,
            "property_path": item.property_path,
            "raw_value": item.raw_value,
            "unit": item.unit,
            "evidence_hashes": sorted(item.evidence_hashes),
        }
        for item in sorted_items
    ]
    raw_json = json.dumps(canonical_list, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw_json.encode("utf-8")).hexdigest()


class FactRevisionStorage:
    """Append-Only Fact Revision Chain Storage & Publication State Machine."""

    def __init__(self) -> None:
        self.revisions_by_id: Dict[str, FactRevisionLifecycle] = {}
        self.revision_digests_by_id: Dict[str, str] = {}
        self.chains_by_assertion_id: Dict[str, List[str]] = {}
        self.transitions_by_revision_id: Dict[str, List[RevisionStateTransition]] = {}
        self.snapshots_by_entity_id: Dict[str, List[PublicationSnapshot]] = {}

    def create_revision(
        self,
        assertion_id: str,
        entity_id: str,
        property_path: str,
        assertion_value: AssertionValue,
        created_by_role: RevisionRole,
        revision_reason: RevisionReason,
        evidence_span_hashes: List[str],
        author_id: Optional[str] = None,
        reason_description: Optional[str] = None,
        initial_state: FactLifecycleState = FactLifecycleState.DRAFT,
    ) -> FactRevisionLifecycle:
        """Creates a new immutable FactRevision node chained to parent."""
        chain = self.chains_by_assertion_id.get(assertion_id, [])
        parent_hash = "GENESIS"
        rev_number = 1

        if chain:
            last_rev_id = chain[-1]
            last_digest = self.revision_digests_by_id.get(last_rev_id)
            if not last_digest:
                raise RuntimeError(f"Corrupted state: digest missing for previous revision {last_rev_id}")
            parent_hash = last_digest
            rev_number = len(chain) + 1

        revision_id = f"rev_{int(time.time()*1000)}_{secrets.token_hex(6)}"
        metadata = RevisionMetadata(
            parent_revision_sha256=parent_hash,
            created_at=datetime.now(timezone.utc).isoformat(),
            created_by_role=created_by_role,
            author_id=author_id,
            revision_reason=revision_reason,
            reason_description=reason_description,
            evidence_span_hashes=evidence_span_hashes,
        )

        new_rev = FactRevisionLifecycle(
            assertion_id=assertion_id,
            revision_id=revision_id,
            revision_number=rev_number,
            entity_id=entity_id,
            property_path=property_path,
            assertion_value=assertion_value,
            lifecycle_state=initial_state,
            revision_metadata=metadata,
        )

        digest = compute_revision_digest(new_rev)

        self.revisions_by_id[revision_id] = new_rev.model_copy()
        self.revision_digests_by_id[revision_id] = digest

        if assertion_id not in self.chains_by_assertion_id:
            self.chains_by_assertion_id[assertion_id] = []
        self.chains_by_assertion_id[assertion_id].append(revision_id)

        return new_rev.model_copy()

    def get_revision(self, revision_id: str) -> Optional[FactRevisionLifecycle]:
        rev = self.revisions_by_id.get(revision_id)
        return rev.model_copy() if rev else None

    def get_revisions_for_assertion(self, assertion_id: str) -> List[FactRevisionLifecycle]:
        chain = self.chains_by_assertion_id.get(assertion_id, [])
        return [self.revisions_by_id[rid].model_copy() for rid in chain]

    def get_latest_revision(self, assertion_id: str) -> Optional[FactRevisionLifecycle]:
        chain = self.chains_by_assertion_id.get(assertion_id, [])
        if not chain:
            return None
        return self.revisions_by_id[chain[-1]].model_copy()

    def validate_chain_integrity(self, assertion_id: str) -> Tuple[bool, List[str], int]:
        """Validates the cryptographic hash chain integrity of an assertion."""
        chain = self.chains_by_assertion_id.get(assertion_id, [])
        errors: List[str] = []

        if not chain:
            return True, [], 0

        expected_parent_hash = "GENESIS"
        for i, rev_id in enumerate(chain):
            rev = self.revisions_by_id.get(rev_id)
            if not rev:
                errors.append(f"Revision {rev_id} referenced in chain is missing from storage")
                continue

            if rev.revision_metadata.parent_revision_sha256 != expected_parent_hash:
                errors.append(
                    f"Chain break at index {i} ({rev_id}): expected parent {expected_parent_hash}, "
                    f"got {rev.revision_metadata.parent_revision_sha256}"
                )

            computed_digest = compute_revision_digest(rev)
            stored_digest = self.revision_digests_by_id.get(rev_id)
            if computed_digest != stored_digest:
                errors.append(
                    f"Payload tamper detected at index {i} ({rev_id}): computed {computed_digest} != stored {stored_digest}"
                )

            expected_parent_hash = computed_digest

        return len(errors) == 0, errors, len(chain)

    def transition_state(
        self,
        revision_id: str,
        trigger: RevisionTransitionTrigger,
        authorized_role: RevisionTransitionRole,
        operator_id: Optional[str] = None,
        revocation_reason: Optional[str] = None,
        superseded_by_revision_id: Optional[str] = None,
    ) -> Tuple[FactRevisionLifecycle, RevisionStateTransition]:
        """Executes a role-gated state transition on a revision node."""
        current_rev = self.revisions_by_id.get(revision_id)
        if not current_rev:
            raise KeyError(f"Cannot transition non-existent revision: {revision_id}")

        from_state = current_rev.lifecycle_state
        to_state: FactLifecycleState

        if trigger == RevisionTransitionTrigger.SUBMIT_FOR_REVIEW:
            if from_state != FactLifecycleState.DRAFT:
                raise ValueError(f"SUBMIT_FOR_REVIEW only valid from DRAFT, got {from_state}")
            if authorized_role != RevisionTransitionRole.FACT_EXTRACTOR:
                raise PermissionError(f"SUBMIT_FOR_REVIEW requires FACT_EXTRACTOR, got {authorized_role}")
            if len(current_rev.revision_metadata.evidence_span_hashes) == 0:
                raise ValueError("Precondition failed: At least 1 evidence_span_hash is required")
            to_state = FactLifecycleState.PENDING_REVIEW

        elif trigger == RevisionTransitionTrigger.APPROVE_AND_PUBLISH:
            if from_state != FactLifecycleState.PENDING_REVIEW:
                raise ValueError(f"APPROVE_AND_PUBLISH only valid from PENDING_REVIEW, got {from_state}")
            if authorized_role not in (RevisionTransitionRole.FACT_REVIEWER, RevisionTransitionRole.CHIEF_EDITOR):
                raise PermissionError(f"APPROVE_AND_PUBLISH requires FACT_REVIEWER or CHIEF_EDITOR, got {authorized_role}")
            to_state = FactLifecycleState.PUBLISHED

        elif trigger == RevisionTransitionTrigger.REJECT_CANDIDATE:
            if from_state != FactLifecycleState.PENDING_REVIEW:
                raise ValueError(f"REJECT_CANDIDATE only valid from PENDING_REVIEW, got {from_state}")
            if authorized_role != RevisionTransitionRole.FACT_REVIEWER:
                raise PermissionError(f"REJECT_CANDIDATE requires FACT_REVIEWER, got {authorized_role}")
            to_state = FactLifecycleState.REVOKED

        elif trigger == RevisionTransitionTrigger.SUPERSEDE_WITH_NEW_REVISION:
            if from_state != FactLifecycleState.PUBLISHED:
                raise ValueError(f"SUPERSEDE_WITH_NEW_REVISION only valid from PUBLISHED, got {from_state}")
            if not superseded_by_revision_id:
                raise ValueError("Precondition failed: superseded_by_revision_id is required")
            to_state = FactLifecycleState.SUPERSEDED

        elif trigger == RevisionTransitionTrigger.REVOKE_PUBLISHED_FACT:
            if from_state != FactLifecycleState.PUBLISHED:
                raise ValueError(f"REVOKE_PUBLISHED_FACT only valid from PUBLISHED, got {from_state}")
            if authorized_role != RevisionTransitionRole.CHIEF_EDITOR:
                raise PermissionError(f"REVOKE_PUBLISHED_FACT requires CHIEF_EDITOR, got {authorized_role}")
            if not revocation_reason or len(revocation_reason.strip()) < 5:
                raise ValueError("Precondition failed: revocation_reason with min 5 characters is required")
            to_state = FactLifecycleState.REVOKED

        else:
            raise ValueError(f"Unknown trigger: {trigger}")

        transition_id = f"trans_{int(time.time()*1000)}_{secrets.token_hex(6)}"
        transition_record = RevisionStateTransition(
            transition_id=transition_id,
            assertion_id=current_rev.assertion_id,
            revision_id=current_rev.revision_id,
            from_state=RevisionTransitionFromState(from_state.value),
            to_state=RevisionTransitionToState(to_state.value),
            transition_trigger=trigger,
            authorized_role=authorized_role,
            operator_id=operator_id,
            transition_timestamp=datetime.now(timezone.utc).isoformat(),
            superseded_by_revision_id=superseded_by_revision_id,
            revocation_reason=revocation_reason,
        )

        updated_rev = current_rev.model_copy(update={"lifecycle_state": to_state})
        self.revisions_by_id[revision_id] = updated_rev

        if revision_id not in self.transitions_by_revision_id:
            self.transitions_by_revision_id[revision_id] = []
        self.transitions_by_revision_id[revision_id].append(transition_record)

        return updated_rev.model_copy(), transition_record

    def generate_publication_snapshot(
        self,
        entity_id: str,
        entity_canonical_name: Optional[str] = None,
        publisher_role: str = "CHIEF_FACT_EDITOR",
        outlet_scopes: Optional[List[OutletScope]] = None,
    ) -> PublicationSnapshot:
        """Generates an immutable PublicationSnapshot for an entity."""
        published_items: List[PublishedAssertionItem] = []

        for chain in self.chains_by_assertion_id.values():
            if not chain:
                continue
            latest_id = chain[-1]
            rev = self.revisions_by_id.get(latest_id)
            if rev and rev.entity_id == entity_id and rev.lifecycle_state == FactLifecycleState.PUBLISHED:
                item = PublishedAssertionItem(
                    assertion_id=rev.assertion_id,
                    revision_id=rev.revision_id,
                    property_path=rev.property_path,
                    raw_value=rev.assertion_value.raw_value,
                    unit=rev.assertion_value.unit,
                    evidence_hashes=rev.revision_metadata.evidence_span_hashes,
                )
                published_items.append(item)

        if not published_items:
            raise ValueError(f"Cannot generate PublicationSnapshot: zero PUBLISHED assertions for {entity_id}")

        digest = compute_snapshot_digest(published_items)
        pub_id = f"pub_{int(time.time()*1000)}_{secrets.token_hex(6)}"
        pubrev_id = f"pubrev_{int(time.time()*1000)}_{secrets.token_hex(6)}"

        existing_snapshots = self.snapshots_by_entity_id.get(entity_id, [])
        for s in existing_snapshots:
            s.projection_metadata.is_latest_snapshot = False

        scopes = outlet_scopes or [
            OutletScope.HUB_ONE_WAY_PROJECTION,
            OutletScope.REST_API,
            OutletScope.PUBLIC_HTML_ARCHIVE,
        ]

        snapshot = PublicationSnapshot(
            publication_id=pub_id,
            snapshot_revision_id=pubrev_id,
            entity_id=entity_id,
            entity_canonical_name=entity_canonical_name,
            generated_at=datetime.now(timezone.utc).isoformat(),
            snapshot_digest_sha256=digest,
            published_assertions=published_items,
            projection_metadata=ProjectionMetadata(
                kernel_system="WZCityTCDS-PublicationKernel",
                publisher_role=publisher_role,
                outlet_scopes=scopes,
                is_latest_snapshot=True,
            ),
        )

        if entity_id not in self.snapshots_by_entity_id:
            self.snapshots_by_entity_id[entity_id] = []
        self.snapshots_by_entity_id[entity_id].append(snapshot)

        return snapshot

    def get_latest_snapshot(self, entity_id: str) -> Optional[PublicationSnapshot]:
        snapshots = self.snapshots_by_entity_id.get(entity_id, [])
        if not snapshots:
            return None
        return snapshots[-1].model_copy()

    def get_transitions(self, revision_id: str) -> List[RevisionStateTransition]:
        transitions = self.transitions_by_revision_id.get(revision_id, [])
        return [t.model_copy() for t in transitions]
