"""
Review Workbench & Ingest Manager - Python Contract Mirror (Slice R2)
"""
from __future__ import annotations

import datetime
import enum
import json
import secrets
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field

from .evidence import (
    EvidenceSpan,
    EvidenceVerificationReceipt,
    SourceAuthorityLevel,
    SpanVerificationItem,
    AuditorSignature,
)
from .evidence_engine import (
    EvidenceVerificationEngine,
    SourceNewsDocumentSnapshot,
    compute_span_hash,
)
from .fact_revision import AssertionValue, FactLifecycleState


class ReviewTaskStatus(str, enum.Enum):
    PENDING_REVIEW = "PENDING_REVIEW"
    IN_REVIEW = "IN_REVIEW"
    ARBITRATION_REQUIRED = "ARBITRATION_REQUIRED"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    CHANGES_REQUESTED = "CHANGES_REQUESTED"


class ReviewPriority(str, enum.Enum):
    LOW = "LOW"
    NORMAL = "NORMAL"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class ReviewActionType(str, enum.Enum):
    INGEST = "INGEST"
    CLAIM = "CLAIM"
    RELEASE = "RELEASE"
    VERIFY_EVIDENCE = "VERIFY_EVIDENCE"
    ARBITRATE = "ARBITRATE"
    APPROVE = "APPROVE"
    REJECT = "REJECT"
    REQUEST_CHANGES = "REQUEST_CHANGES"


class CandidateAssertion(BaseModel):
    assertion_id: str
    property_path: str
    assertion_value: AssertionValue
    confidence_score: Optional[float] = None
    evidence_span_ids: List[str] = Field(default_factory=list)
    created_at: str


class ReviewAuditEntry(BaseModel):
    action: ReviewActionType
    actor_id: str
    actor_role: Optional[str] = None
    timestamp: str
    previous_status: ReviewTaskStatus
    new_status: ReviewTaskStatus
    notes: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class ReviewConflictContext(BaseModel):
    conflict_id: str
    conflicting_revision_id: Optional[str] = None
    conflicting_value: Any
    existing_authority_level: Optional[SourceAuthorityLevel] = None
    candidate_authority_level: Optional[SourceAuthorityLevel] = None
    suggested_action: Optional[str] = "MANUAL_ARBITRATION"
    arbitration_verdict: Optional[str] = None
    adjudicated_by: Optional[str] = None
    adjudicated_at: Optional[str] = None
    adjudication_notes: Optional[str] = None


class ReviewResult(BaseModel):
    verdict: str  # APPROVED | REJECTED | CHANGES_REQUESTED
    reviewer_id: str
    reviewed_at: str
    notes: Optional[str] = None
    approved_revision_id: Optional[str] = None


class ReviewTask(BaseModel):
    task_id: str
    entity_id: str
    property_path: str
    candidate_assertion: CandidateAssertion
    evidence_spans: List[EvidenceSpan]
    status: ReviewTaskStatus
    priority: ReviewPriority
    created_at: str
    updated_at: str
    submitted_by: str
    assigned_to: Optional[str] = None
    assigned_at: Optional[str] = None
    evidence_receipt: Optional[EvidenceVerificationReceipt] = None
    conflict_context: Optional[ReviewConflictContext] = None
    review_result: Optional[ReviewResult] = None
    audit_trail: List[ReviewAuditEntry] = Field(default_factory=list)


class IngestCandidateParams(BaseModel):
    entity_id: str
    property_path: str
    candidate_assertion: CandidateAssertion
    evidence_spans: List[EvidenceSpan]
    submitted_by: str
    priority: Optional[ReviewPriority] = ReviewPriority.NORMAL
    existing_published_assertion: Optional[Dict[str, Any]] = None


class ListReviewTasksFilter(BaseModel):
    status: Optional[ReviewTaskStatus] = None
    entity_id: Optional[str] = None
    assigned_to: Optional[str] = None
    priority: Optional[ReviewPriority] = None
    page: int = 1
    page_size: int = 20


class ReviewWorkbenchManager:
    def __init__(self, evidence_engine: Optional[EvidenceVerificationEngine] = None):
        self._tasks: Dict[str, ReviewTask] = {}
        self.evidence_engine = evidence_engine or EvidenceVerificationEngine()

    def _now_iso(self) -> str:
        return datetime.datetime.now(datetime.timezone.utc).isoformat()

    def _generate_id(self, prefix: str) -> str:
        return f"{prefix}_{secrets.token_hex(8)}"

    def _ensure_reviewer_role(self, role: Optional[str]) -> None:
        if role and role not in ("reviewer", "admin"):
            raise PermissionError(
                f"Forbidden: role '{role}' is not authorized to perform review actions. Requires 'reviewer' or 'admin'."
            )

    def ingest_candidate(self, params: IngestCandidateParams) -> ReviewTask:
        if not params.evidence_spans:
            raise ValueError(
                "Candidate ingestion rejected: at least one supporting EvidenceSpan is strictly required."
            )

        now = self._now_iso()
        task_id = self._generate_id("revtask")

        initial_status = ReviewTaskStatus.PENDING_REVIEW
        conflict_context = None

        if params.existing_published_assertion:
            existing = params.existing_published_assertion
            is_divergent = existing.get("raw_value") != params.candidate_assertion.assertion_value.raw_value

            if is_divergent:
                initial_status = ReviewTaskStatus.ARBITRATION_REQUIRED
                conflict_context = ReviewConflictContext(
                    conflict_id=self._generate_id("conf"),
                    conflicting_revision_id=existing.get("revision_id"),
                    conflicting_value=existing.get("raw_value"),
                    existing_authority_level=existing.get("authority_level"),
                    candidate_authority_level=SourceAuthorityLevel.COMMERCIAL_PORTAL,
                    suggested_action="MANUAL_ARBITRATION",
                )

        task = ReviewTask(
            task_id=task_id,
            entity_id=params.entity_id,
            property_path=params.property_path,
            candidate_assertion=params.candidate_assertion,
            evidence_spans=params.evidence_spans,
            status=initial_status,
            priority=params.priority or ReviewPriority.NORMAL,
            created_at=now,
            updated_at=now,
            submitted_by=params.submitted_by,
            assigned_to=None,
            assigned_at=None,
            evidence_receipt=None,
            conflict_context=conflict_context,
            review_result=None,
            audit_trail=[
                ReviewAuditEntry(
                    action=ReviewActionType.INGEST,
                    actor_id=params.submitted_by,
                    timestamp=now,
                    previous_status=initial_status,
                    new_status=initial_status,
                    notes=(
                        f"Ingested candidate with detected property divergence against revision {conflict_context.conflicting_revision_id}"
                        if conflict_context
                        else "Ingested clean candidate assertion"
                    ),
                )
            ],
        )

        self._tasks[task_id] = task
        return task

    def list_tasks(
        self, filter_opts: Optional[ListReviewTasksFilter] = None
    ) -> Dict[str, Any]:
        opts = filter_opts or ListReviewTasksFilter()
        filtered = list(self._tasks.values())

        if opts.status:
            filtered = [t for t in filtered if t.status == opts.status]
        if opts.entity_id:
            filtered = [t for t in filtered if t.entity_id == opts.entity_id]
        if opts.assigned_to:
            filtered = [t for t in filtered if t.assigned_to == opts.assigned_to]
        if opts.priority:
            filtered = [t for t in filtered if t.priority == opts.priority]

        total = len(filtered)
        start = (opts.page - 1) * opts.page_size
        tasks = filtered[start : start + opts.page_size]

        return {
            "tasks": tasks,
            "total": total,
            "page": opts.page,
            "page_size": opts.page_size,
        }

    def get_task(self, task_id: str) -> ReviewTask:
        task = self._tasks.get(task_id)
        if not task:
            raise KeyError(f"ReviewTask not found with ID: {task_id}")
        return task

    def claim_task(
        self, task_id: str, actor_id: str, actor_role: Optional[str] = None
    ) -> ReviewTask:
        self._ensure_reviewer_role(actor_role)
        task = self.get_task(task_id)

        if task.status in (ReviewTaskStatus.APPROVED, ReviewTaskStatus.REJECTED):
            raise ValueError(f"Cannot claim completed review task in state: {task.status}")

        now = self._now_iso()
        prev_status = task.status
        next_status = (
            ReviewTaskStatus.ARBITRATION_REQUIRED
            if task.status == ReviewTaskStatus.ARBITRATION_REQUIRED
            else ReviewTaskStatus.IN_REVIEW
        )

        task.assigned_to = actor_id
        task.assigned_at = now
        task.status = next_status
        task.updated_at = now

        task.audit_trail.append(
            ReviewAuditEntry(
                action=ReviewActionType.CLAIM,
                actor_id=actor_id,
                actor_role=actor_role,
                timestamp=now,
                previous_status=prev_status,
                new_status=next_status,
                notes=f"Claimed by reviewer {actor_id}",
            )
        )
        return task

    def release_task(
        self, task_id: str, actor_id: str, actor_role: Optional[str] = None
    ) -> ReviewTask:
        task = self.get_task(task_id)
        if task.assigned_to and task.assigned_to != actor_id and actor_role != "admin":
            raise PermissionError(
                f"Cannot release task assigned to another reviewer ({task.assigned_to})"
            )

        now = self._now_iso()
        prev_status = task.status
        next_status = (
            ReviewTaskStatus.PENDING_REVIEW
            if task.status == ReviewTaskStatus.IN_REVIEW
            else task.status
        )

        task.assigned_to = None
        task.assigned_at = None
        task.status = next_status
        task.updated_at = now

        task.audit_trail.append(
            ReviewAuditEntry(
                action=ReviewActionType.RELEASE,
                actor_id=actor_id,
                actor_role=actor_role,
                timestamp=now,
                previous_status=prev_status,
                new_status=next_status,
                notes=f"Released assignment by {actor_id}",
            )
        )
        return task

    def verify_evidence(
        self,
        task_id: str,
        source_docs: List[SourceNewsDocumentSnapshot],
        actor_id: str,
    ) -> EvidenceVerificationReceipt:
        task = self.get_task(task_id)
        doc_map = {d.source_doc_id: d for d in source_docs}

        receipt = self.evidence_engine.verify_assertion_evidence(
            assertion_id=task.candidate_assertion.assertion_id,
            revision_id="rev_pending_review",
            spans=task.evidence_spans,
            source_resolver=lambda doc_id: doc_map.get(doc_id),
            signer_identity=actor_id,
        )

        now = self._now_iso()
        task.evidence_receipt = receipt
        task.updated_at = now

        task.audit_trail.append(
            ReviewAuditEntry(
                action=ReviewActionType.VERIFY_EVIDENCE,
                actor_id=actor_id,
                timestamp=now,
                previous_status=task.status,
                new_status=task.status,
                notes=f"Evidence preflight executed: verdict={receipt.overall_verification_verdict.value}, verified_spans={len(receipt.span_verifications)}",
                metadata={"receipt_id": receipt.receipt_id},
            )
        )
        return receipt

    def arbitrate_conflict(
        self,
        task_id: str,
        actor_id: str,
        decision: str,  # ADOPT_CANDIDATE | RETAIN_EXISTING | RECONCILED_RANGE | SUSPENDED
        notes: Optional[str] = None,
        actor_role: Optional[str] = None,
    ) -> ReviewTask:
        self._ensure_reviewer_role(actor_role)
        task = self.get_task(task_id)

        if not task.conflict_context:
            raise ValueError(f"ReviewTask {task_id} does not have an active conflict to arbitrate.")

        now = self._now_iso()
        prev_status = task.status

        task.conflict_context.arbitration_verdict = decision
        task.conflict_context.adjudicated_by = actor_id
        task.conflict_context.adjudicated_at = now
        task.conflict_context.adjudication_notes = notes

        if decision in ("ADOPT_CANDIDATE", "RECONCILED_RANGE"):
            next_status = ReviewTaskStatus.IN_REVIEW
        elif decision == "RETAIN_EXISTING":
            next_status = ReviewTaskStatus.REJECTED
            task.review_result = ReviewResult(
                verdict="REJECTED",
                reviewer_id=actor_id,
                reviewed_at=now,
                notes=f"Arbitration resolved to retain existing published revision: {notes or ''}",
            )
        elif decision == "SUSPENDED":
            next_status = ReviewTaskStatus.CHANGES_REQUESTED
            task.review_result = ReviewResult(
                verdict="CHANGES_REQUESTED",
                reviewer_id=actor_id,
                reviewed_at=now,
                notes=f"Arbitration suspended pending further source evidence: {notes or ''}",
            )
        else:
            raise ValueError(f"Unknown arbitration decision: {decision}")

        task.status = next_status
        task.updated_at = now

        task.audit_trail.append(
            ReviewAuditEntry(
                action=ReviewActionType.ARBITRATE,
                actor_id=actor_id,
                actor_role=actor_role,
                timestamp=now,
                previous_status=prev_status,
                new_status=next_status,
                notes=f"Arbitration decision: {decision}. {notes or ''}",
                metadata={"decision": decision},
            )
        )
        return task

    def approve_task(
        self,
        task_id: str,
        actor_id: str,
        notes: Optional[str] = None,
        actor_role: Optional[str] = None,
    ) -> Dict[str, Any]:
        self._ensure_reviewer_role(actor_role)
        task = self.get_task(task_id)

        if task.status == ReviewTaskStatus.ARBITRATION_REQUIRED:
            raise ValueError(
                f"Fail-Closed Gate: Cannot approve task {task_id} while unresolved conflict arbitration is required."
            )
        if task.status == ReviewTaskStatus.APPROVED:
            raise ValueError(f"Task {task_id} is already approved.")
        if task.status == ReviewTaskStatus.REJECTED:
            raise ValueError(f"Task {task_id} is already rejected.")
        if (
            task.evidence_receipt
            and task.evidence_receipt.overall_verification_verdict.value != "PASS"
        ):
            raise ValueError(
                f"Fail-Closed Gate: Cannot approve task with non-passing evidence verification verdict: {task.evidence_receipt.overall_verification_verdict.value}"
            )

        now = self._now_iso()
        prev_status = task.status
        published_rev_id = f"rev_{secrets.token_hex(8)}"

        task.status = ReviewTaskStatus.APPROVED
        task.updated_at = now
        task.review_result = ReviewResult(
            verdict="APPROVED",
            reviewer_id=actor_id,
            reviewed_at=now,
            notes=notes,
            approved_revision_id=published_rev_id,
        )

        task.audit_trail.append(
            ReviewAuditEntry(
                action=ReviewActionType.APPROVE,
                actor_id=actor_id,
                actor_role=actor_role,
                timestamp=now,
                previous_status=prev_status,
                new_status=ReviewTaskStatus.APPROVED,
                notes=notes or "Candidate assertion approved for publication release",
                metadata={"published_revision_id": published_rev_id},
            )
        )
        return {"task": task, "published_revision_id": published_rev_id}

    def reject_task(
        self,
        task_id: str,
        actor_id: str,
        reason: str,
        notes: Optional[str] = None,
        actor_role: Optional[str] = None,
    ) -> ReviewTask:
        self._ensure_reviewer_role(actor_role)
        task = self.get_task(task_id)

        if task.status == ReviewTaskStatus.APPROVED:
            raise ValueError(
                f"Cannot reject already approved task {task_id}. Use revocation protocol instead."
            )

        now = self._now_iso()
        prev_status = task.status

        task.status = ReviewTaskStatus.REJECTED
        task.updated_at = now
        task.review_result = ReviewResult(
            verdict="REJECTED",
            reviewer_id=actor_id,
            reviewed_at=now,
            notes=f"{reason} - {notes}" if notes else reason,
        )

        task.audit_trail.append(
            ReviewAuditEntry(
                action=ReviewActionType.REJECT,
                actor_id=actor_id,
                actor_role=actor_role,
                timestamp=now,
                previous_status=prev_status,
                new_status=ReviewTaskStatus.REJECTED,
                notes=reason,
            )
        )
        return task

    def request_changes(
        self,
        task_id: str,
        actor_id: str,
        change_request: str,
        actor_role: Optional[str] = None,
    ) -> ReviewTask:
        self._ensure_reviewer_role(actor_role)
        task = self.get_task(task_id)

        if task.status in (ReviewTaskStatus.APPROVED, ReviewTaskStatus.REJECTED):
            raise ValueError(
                f"Cannot request changes on task in final status {task.status}."
            )

        now = self._now_iso()
        prev_status = task.status

        task.status = ReviewTaskStatus.CHANGES_REQUESTED
        task.updated_at = now
        task.review_result = ReviewResult(
            verdict="CHANGES_REQUESTED",
            reviewer_id=actor_id,
            reviewed_at=now,
            notes=change_request,
        )

        task.audit_trail.append(
            ReviewAuditEntry(
                action=ReviewActionType.REQUEST_CHANGES,
                actor_id=actor_id,
                actor_role=actor_role,
                timestamp=now,
                previous_status=prev_status,
                new_status=ReviewTaskStatus.CHANGES_REQUESTED,
                notes=change_request,
            )
        )
        return task
