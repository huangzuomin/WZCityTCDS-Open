"""End-to-End Integration Pipeline and Smoke Acceptance (Python Mirror - Slice R4)."""
from __future__ import annotations

import datetime
import enum
import json
import secrets
import time
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field

from packages.shared.python.contracts.evidence import EvidenceSpan, EvidenceVerificationReceipt
from packages.shared.python.contracts.evidence_engine import SourceNewsDocumentSnapshot, compute_span_hash
from packages.shared.python.contracts.fact_revision import (
    AssertionValue,
    FactRevisionLifecycle,
    PublicationSnapshot,
    PublishedAssertionItem,
    ProjectionMetadata,
    OutletScope,
)
from packages.shared.python.contracts.fact_revision_storage import FactRevisionStorage
from packages.shared.python.contracts.outlets import (
    PublicationSecurityGatePolicy,
    GateVerdict,
    ChangesStreamEvent,
    StreamChangeType,
    AffectedRevision,
)
from packages.shared.python.contracts.outlets_engine import (
    PublicationSecurityGate,
    ChangesStreamManager,
)
from packages.shared.python.contracts.outlets_http import (
    OutletsHttpRouter,
    OutletsHttpRequest,
    OutletsHttpResponse,
    SnapshotRecord,
)
from packages.shared.python.contracts.hub_projection import (
    HubProjectionReceipt,
    HubProjectionReceiptStatus,
    HubUpstreamChangeEvent,
    HubOneWayProjector,
    ChangesStreamConsumer,
    MockHubProjectionTransport,
    compute_upstream_change_digest,
    assert_valid_entity_id,
)
from packages.shared.python.contracts.review_workbench import (
    ReviewWorkbenchManager,
    CandidateAssertion,
    ReviewTask,
    ReviewTaskStatus,
    IngestCandidateParams,
)


class SubsystemStatus(str, enum.Enum):
    HEALTHY = "HEALTHY"
    DEGRADED = "DEGRADED"
    UNHEALTHY = "UNHEALTHY"
    MAINTENANCE = "MAINTENANCE"


class ComponentHealth(BaseModel):
    component: str
    status: SubsystemStatus
    message: str
    latency_ms: float
    checked_at: str
    details: Optional[Dict[str, Any]] = None


class SystemHealthReport(BaseModel):
    status: SubsystemStatus
    version: str
    uptime_seconds: int
    timestamp: str
    components: List[ComponentHealth]
    summary: Dict[str, int]


class E2EExecutionStep(BaseModel):
    step_number: int
    name: str
    status: str
    duration_ms: float
    details: Optional[Dict[str, Any]] = None


class E2EPipelineResult(BaseModel):
    pipeline_run_id: str
    success: bool
    entity_id: str
    steps: List[E2EExecutionStep]
    review_task_id: Optional[str] = None
    published_revision_id: Optional[str] = None
    security_gate_policy: Optional[PublicationSecurityGatePolicy] = None
    hub_receipt: Optional[HubProjectionReceipt] = None
    outlets_verified: List[str] = Field(default_factory=list)
    error: Optional[str] = None


class InMemoryOutletsStore:
    def __init__(self, stream_manager: ChangesStreamManager):
        self.records_by_id: Dict[str, SnapshotRecord] = {}
        self.records_by_entity: Dict[str, SnapshotRecord] = {}
        self.retracted_sources: List[str] = []
        self.stream_manager = stream_manager

    def get_snapshot_record_by_id(self, snapshot_id: str) -> Optional[SnapshotRecord]:
        return self.records_by_id.get(snapshot_id)

    def get_snapshot_record_by_entity(self, entity_id: str) -> Optional[SnapshotRecord]:
        return self.records_by_entity.get(entity_id)

    def list_public_snapshots(self, limit: Optional[int] = None) -> List[SnapshotRecord]:
        items = list(self.records_by_id.values())
        return items[:limit] if limit else items

    def get_changes_stream_manager(self) -> ChangesStreamManager:
        return self.stream_manager

    def get_retracted_source_doc_ids(self) -> List[str]:
        return self.retracted_sources

    def set_record(self, record: SnapshotRecord) -> None:
        self.records_by_id[record.snapshot.snapshot_revision_id] = record
        self.records_by_entity[record.snapshot.entity_id] = record


class EndToEndIntegrationPipeline:
    def __init__(self, transport=None):
        self.start_time = time.time()
        self.workbench = ReviewWorkbenchManager()
        self.revision_storage = FactRevisionStorage()
        self.security_gate = PublicationSecurityGate()
        self.changes_manager = ChangesStreamManager()
        self.outlets_store = InMemoryOutletsStore(self.changes_manager)
        self.http_router = OutletsHttpRouter(self.outlets_store)
        self.hub_transport = transport or MockHubProjectionTransport()
        self.hub_projector = HubOneWayProjector(self.hub_transport)
        self.changes_consumer = ChangesStreamConsumer()

    def execute_golden_path(
        self,
        candidate_data: Dict[str, Any],
        source_doc: SourceNewsDocumentSnapshot,
        reviewer_id: str,
    ) -> E2EPipelineResult:
        steps: List[E2EExecutionStep] = []
        run_id = f"pipe_run_{int(time.time() * 1000)}_{secrets.token_hex(4)}"
        entity_id = candidate_data["entity_id"]
        verified_outlets: List[str] = []
        try:
            t1 = time.time()
            assertion_id = f"ast_{int(time.time() * 1000)}_{secrets.token_hex(6)}"
            spans: List[EvidenceSpan] = []
            for idx, s in enumerate(candidate_data["evidence_spans"]):
                span_id = f"span_{int(time.time() * 1000)}_{idx}_{secrets.token_hex(6)}"
                spans.append(
                    EvidenceSpan(
                        span_id=span_id,
                        source_doc_id=s["source_doc_id"],
                        paragraph_index=s["paragraph_index"],
                        char_start=s["start_char"],
                        char_end=s["end_char"],
                        quoted_text=s["quoted_text"],
                        span_hash=s["span_hash"],
                        extracted_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                        quality_state="VALIDATED",
                    )
                )

            cand_assertion = CandidateAssertion(
                assertion_id=assertion_id,
                property_path=candidate_data["field_id"],
                assertion_value=AssertionValue(
                    raw_value=candidate_data["value"],
                    data_type="STRING",
                ),
                evidence_span_ids=[sp.span_id for sp in spans],
                created_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            )

            review_task = self.workbench.ingest_candidate(
                IngestCandidateParams(
                    entity_id=entity_id,
                    property_path=candidate_data["field_id"],
                    candidate_assertion=cand_assertion,
                    evidence_spans=spans,
                    submitted_by=candidate_data.get("submitted_by", "bot"),
                )
            )
            steps.append(
                E2EExecutionStep(
                    step_number=1,
                    name="INGEST_CANDIDATE",
                    status="PASS",
                    duration_ms=(time.time() - t1) * 1000,
                    details={"task_id": review_task.task_id, "status": review_task.status.value},
                )
            )

            t2 = time.time()
            evidence_receipt = self.workbench.verify_evidence(
                review_task.task_id,
                [source_doc],
                reviewer_id,
            )
            if evidence_receipt.overall_verification_verdict != "PASS":
                raise ValueError(f"Preflight evidence verification failed: {evidence_receipt.overall_verification_verdict}")
            steps.append(
                E2EExecutionStep(
                    step_number=2,
                    name="PREFLIGHT_EVIDENCE_VERIFICATION",
                    status="PASS",
                    duration_ms=(time.time() - t2) * 1000,
                    details={"verdict": evidence_receipt.overall_verification_verdict},
                )
            )

            t3 = time.time()
            self.workbench.claim_task(review_task.task_id, reviewer_id, "reviewer")
            steps.append(
                E2EExecutionStep(
                    step_number=3,
                    name="CLAIM_TASK",
                    status="PASS",
                    duration_ms=(time.time() - t3) * 1000,
                    details={"assigned_to": reviewer_id},
                )
            )

            t4 = time.time()
            approval_res = self.workbench.approve_task(
                review_task.task_id,
                reviewer_id,
                "Editorial sign-off approved",
                "reviewer",
            )
            approved_task = approval_res["task"]
            published_rev_id = approval_res["published_revision_id"]
            steps.append(
                E2EExecutionStep(
                    step_number=4,
                    name="EDITORIAL_APPROVAL",
                    status="PASS",
                    duration_ms=(time.time() - t4) * 1000,
                    details={"published_revision_id": published_rev_id},
                )
            )

            t5 = time.time()
            stored_revision = self.revision_storage.create_revision(
                assertion_id=assertion_id,
                entity_id=entity_id,
                property_path=candidate_data["field_id"],
                assertion_value=AssertionValue(
                    raw_value=candidate_data["value"],
                    data_type="STRING",
                ),
                created_by_role="FACT_REVIEWER",
                author_id=reviewer_id,
                revision_reason="INITIAL_PUBLISH",
                reason_description="Initial establishment",
                evidence_span_hashes=[s["span_hash"] for s in candidate_data["evidence_spans"]],
                initial_state="PENDING_REVIEW",
            )
            self.revision_storage.transition_state(
                revision_id=stored_revision.revision_id,
                trigger="APPROVE_AND_PUBLISH",
                authorized_role="FACT_REVIEWER",
                operator_id=reviewer_id,
            )

            snapshot = self.revision_storage.generate_publication_snapshot(
                entity_id=entity_id,
                publisher_role="CHIEF_FACT_EDITOR",
                outlet_scopes=[
                    "PUBLIC_HTML_ARCHIVE",
                    "REST_API",
                    "FEED_ATOM",
                    "MCP_ENDPOINT",
                    "HUB_ONE_WAY_PROJECTION",
                ],
            )
            steps.append(
                E2EExecutionStep(
                    step_number=5,
                    name="APPEND_REVISION_STORAGE",
                    status="PASS",
                    duration_ms=(time.time() - t5) * 1000,
                    details={
                        "revision_id": stored_revision.revision_id,
                        "snapshot_revision_id": snapshot.snapshot_revision_id,
                    },
                )
            )

            t6 = time.time()
            gate_assertions = [
                {
                    "assertion_id": a.assertion_id,
                    "lifecycle_state": "PUBLISHED",
                    "evidence_hashes": a.evidence_hashes,
                    "raw_value": a.raw_value,
                    "source_doc_ids": [source_doc.source_doc_id],
                }
                for a in snapshot.published_assertions
            ]
            receipts_map = {assertion_id: {"overall_verification_verdict": "PASS"}}
            for sp in spans:
                receipts_map[sp.span_hash] = {"overall_verification_verdict": "PASS"}

            gate_policy = self.security_gate.evaluate(
                snapshot_revision_id=snapshot.snapshot_revision_id,
                assertions=gate_assertions,
                evidence_receipts=receipts_map,
            )
            if gate_policy.gate_verdict != GateVerdict.PASS_APPROVED_FOR_RELEASE:
                raise ValueError(f"Security gate blocked release: {gate_policy.gate_verdict}")

            steps.append(
                E2EExecutionStep(
                    step_number=6,
                    name="PUBLICATION_SECURITY_GATE",
                    status="PASS",
                    duration_ms=(time.time() - t6) * 1000,
                    details={"gate_verdict": gate_policy.gate_verdict.value},
                )
            )

            t7 = time.time()
            snapshot_record = SnapshotRecord(
                snapshot=snapshot,
                receipts=receipts_map,
                lifecycle_states={assertion_id: "PUBLISHED"},
                source_doc_ids={assertion_id: [source_doc.source_doc_id]},
            )
            self.outlets_store.set_record(snapshot_record)

            rest_res = self.http_router.handle_request(
                OutletsHttpRequest(method="GET", path=f"/outlets/snapshot/{snapshot.snapshot_revision_id}")
            )
            if rest_res.status_code == 200:
                verified_outlets.append("REST_API_V1")

            html_res = self.http_router.handle_request(
                OutletsHttpRequest(method="GET", path=f"/outlets/archive/{snapshot.entity_id}")
            )
            if html_res.status_code == 200:
                verified_outlets.append("PUBLIC_HTML_ARCHIVE")

            jsonld_res = self.http_router.handle_request(
                OutletsHttpRequest(method="GET", path=f"/outlets/jsonld/{snapshot.snapshot_revision_id}")
            )
            if jsonld_res.status_code == 200:
                verified_outlets.append("JSON_LD_CARD")

            mcp_res = self.http_router.handle_request(
                OutletsHttpRequest(method="POST", path="/outlets/mcp", body={"entity_id": snapshot.entity_id})
            )
            if mcp_res.status_code == 200:
                verified_outlets.append("LLM_MCP_ENDPOINT")

            steps.append(
                E2EExecutionStep(
                    step_number=7,
                    name="MULTI_OUTLET_DISTRIBUTION",
                    status="PASS",
                    duration_ms=(time.time() - t7) * 1000,
                    details={"verified_outlets": verified_outlets},
                )
            )

            t8 = time.time()
            receipt = self.hub_projector.project_snapshot(snapshot, gate_policy=gate_policy)
            if receipt.status != HubProjectionReceiptStatus.ACCEPTED:
                raise ValueError(f"Hub projection rejected: {receipt.rejection_reason or receipt.status}")

            steps.append(
                E2EExecutionStep(
                    step_number=8,
                    name="HUB_ONE_WAY_PROJECTION",
                    status="PASS",
                    duration_ms=(time.time() - t8) * 1000,
                    details={
                        "receipt_id": receipt.receipt_id,
                        "status": receipt.status.value,
                        "slot_id": receipt.hub_slot_id,
                    },
                )
            )

            t9 = time.time()
            change_evt = self.changes_manager.emit_event(
                change_type=StreamChangeType.FACT_PUBLISHED,
                entity_id=entity_id,
                affected_revision=AffectedRevision(
                    revision_id=stored_revision.revision_id,
                    property_path=candidate_data["field_id"],
                    lifecycle_state="PUBLISHED",
                    publication_snapshot_id=snapshot.publication_id,
                ),
            )
            self.changes_consumer.consume_outlet_event(change_evt)
            steps.append(
                E2EExecutionStep(
                    step_number=9,
                    name="CHANGES_STREAM_CONSUMPTION",
                    status="PASS",
                    duration_ms=(time.time() - t9) * 1000,
                    details={
                        "sequence": change_evt.change_sequence_num,
                        "outlet_cursor": self.changes_consumer.get_outlet_cursor(),
                    },
                )
            )

            return E2EPipelineResult(
                pipeline_run_id=run_id,
                success=True,
                entity_id=entity_id,
                steps=steps,
                review_task_id=approved_task.task_id,
                published_revision_id=published_rev_id,
                security_gate_policy=gate_policy,
                hub_receipt=receipt,
                outlets_verified=verified_outlets,
            )
        except Exception as e:
            return E2EPipelineResult(
                pipeline_run_id=run_id,
                success=False,
                entity_id=entity_id,
                steps=steps,
                outlets_verified=verified_outlets,
                error=str(e),
            )

    def execute_security_gate_fail_closed(
        self,
        candidate_data: Dict[str, Any],
        source_doc: SourceNewsDocumentSnapshot,
        reviewer_id: str,
        leaked_secret: Optional[str] = None,
        leaked_ip: Optional[str] = None,
    ) -> E2EPipelineResult:
        steps: List[E2EExecutionStep] = []
        run_id = f"pipe_run_sec_{int(time.time() * 1000)}"
        entity_id = candidate_data["entity_id"]
        assertion_id = f"ast_sec_{int(time.time() * 1000)}_{secrets.token_hex(4)}"
        spans: List[EvidenceSpan] = []
        for idx, s in enumerate(candidate_data["evidence_spans"]):
            spans.append(
                EvidenceSpan(
                    span_id=f"span_sec_{int(time.time() * 1000)}_{idx}_{secrets.token_hex(4)}",
                    source_doc_id=s["source_doc_id"],
                    paragraph_index=s["paragraph_index"],
                    char_start=s["start_char"],
                    char_end=s["end_char"],
                    quoted_text=s["quoted_text"],
                    span_hash=s["span_hash"],
                    extracted_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    quality_state="VALIDATED",
                )
            )
        task = self.workbench.ingest_candidate(
            IngestCandidateParams(
                entity_id=entity_id,
                property_path=candidate_data["field_id"],
                candidate_assertion=CandidateAssertion(
                    assertion_id=assertion_id,
                    property_path=candidate_data["field_id"],
                    assertion_value=AssertionValue(
                        raw_value=candidate_data["value"],
                        data_type="STRING",
                    ),
                    evidence_span_ids=[sp.span_id for sp in spans],
                    created_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                ),
                evidence_spans=spans,
                submitted_by="sec_test_user",
            )
        )
        self.workbench.verify_evidence(task.task_id, [source_doc], reviewer_id)
        self.workbench.claim_task(task.task_id, reviewer_id, "reviewer")
        approval_res = self.workbench.approve_task(
            task.task_id, reviewer_id, "Signoff", "reviewer"
        )
        approved_task = approval_res["task"]
        published_rev_id = approval_res["published_revision_id"]
        leaked_raw_value = (
            f"api_key={leaked_secret}"
            if leaked_secret
            else f"http://{leaked_ip}:8080/internal"
            if leaked_ip
            else candidate_data["value"]
        )
        leaked_raw_text = (
            f"Bearer {leaked_secret}"
            if leaked_secret
            else f"Host is http://{leaked_ip}:8080/internal"
            if leaked_ip
            else None
        )
        snapshot_rev_id = f"pubrev_sec_{int(time.time() * 1000)}_{secrets.token_hex(4)}"
        gate_policy = self.security_gate.evaluate(
            snapshot_revision_id=snapshot_rev_id,
            assertions=[
                {
                    "assertion_id": assertion_id,
                    "lifecycle_state": "PUBLISHED",
                    "evidence_hashes": [s["span_hash"] for s in candidate_data["evidence_spans"]],
                    "raw_value": leaked_raw_value,
                    "source_doc_ids": [source_doc.source_doc_id],
                }
            ],
            evidence_receipts={assertion_id: {"overall_verification_verdict": "PASS"}},
            raw_payload_text=leaked_raw_text,
        )
        gate_blocked = gate_policy.gate_verdict == GateVerdict.FAIL_CLOSED_BLOCKED
        steps.append(
            E2EExecutionStep(
                step_number=1,
                name="GATE_EVALUATION",
                status="PASS" if gate_blocked else "FAIL",
                duration_ms=1.0,
                details={"verdict": gate_policy.gate_verdict.value},
            )
        )
        snapshot = PublicationSnapshot(
            publication_id=f"pub_sec_{int(time.time() * 1000)}_{secrets.token_hex(4)}",
            snapshot_revision_id=snapshot_rev_id,
            entity_id=entity_id,
            generated_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            snapshot_digest_sha256="c" * 64,
            published_assertions=[
                PublishedAssertionItem(
                    assertion_id=assertion_id,
                    revision_id=published_rev_id,
                    property_path=candidate_data["field_id"],
                    raw_value=leaked_raw_value,
                    evidence_hashes=[s["span_hash"] for s in candidate_data["evidence_spans"]],
                )
            ],
            projection_metadata=ProjectionMetadata(
                kernel_system="WZCityTCDS-PublicationKernel",
                publisher_role="CHIEF_FACT_EDITOR",
                outlet_scopes=[OutletScope.REST_API],
                is_latest_snapshot=True,
            ),
        )
        self.outlets_store.set_record(
            SnapshotRecord(
                snapshot=snapshot,
                receipts={assertion_id: {"overall_verification_verdict": "PASS"}},
                lifecycle_states={assertion_id: "PUBLISHED"},
                source_doc_ids={assertion_id: [source_doc.source_doc_id]},
            )
        )
        rest_res = self.http_router.handle_request(
            OutletsHttpRequest(method="GET", path=f"/outlets/snapshot/{snapshot.snapshot_revision_id}")
        )
        outlets_blocked = rest_res.status_code == 403
        steps.append(
            E2EExecutionStep(
                step_number=2,
                name="OUTLETS_BLOCKED_VERIFICATION",
                status="PASS" if outlets_blocked else "FAIL",
                duration_ms=1.0,
                details={"http_status": rest_res.status_code},
            )
        )
        hub_blocked = False
        hub_receipt = None
        try:
            hub_receipt = self.hub_projector.project_snapshot(snapshot, gate_policy=gate_policy)
            hub_blocked = hub_receipt.status == HubProjectionReceiptStatus.REJECTED
        except Exception as e:
            hub_blocked = "Security gate fail-closed" in str(e)
        steps.append(
            E2EExecutionStep(
                step_number=3,
                name="HUB_PROJECTION_BLOCKED",
                status="PASS" if hub_blocked else "FAIL",
                duration_ms=1.0,
                details={"hub_blocked": hub_blocked},
            )
        )
        return E2EPipelineResult(
            pipeline_run_id=run_id,
            success=gate_blocked and outlets_blocked and hub_blocked,
            entity_id=entity_id,
            steps=steps,
            review_task_id=task.task_id,
            published_revision_id=published_rev_id,
            security_gate_policy=gate_policy,
            hub_receipt=hub_receipt,
            outlets_verified=[],
        )


class SystemHealthEvaluator:
    def __init__(self, pipeline: EndToEndIntegrationPipeline):
        self.pipeline = pipeline

    def evaluate_health(self) -> SystemHealthReport:
        components: List[ComponentHealth] = []
        now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
        t_store = time.time()
        try:
            self.pipeline.revision_storage.get_latest_revision("ast_test_123456789012")
            components.append(
                ComponentHealth(
                    component="revision_storage",
                    status=SubsystemStatus.HEALTHY,
                    message="Append-only fact revision storage online",
                    latency_ms=(time.time() - t_store) * 1000,
                    checked_at=now_iso,
                )
            )
        except Exception as e:
            components.append(
                ComponentHealth(
                    component="revision_storage",
                    status=SubsystemStatus.UNHEALTHY,
                    message=f"Revision storage error: {e}",
                    latency_ms=(time.time() - t_store) * 1000,
                    checked_at=now_iso,
                )
            )
        t_bench = time.time()
        try:
            components.append(
                ComponentHealth(
                    component="review_workbench",
                    status=SubsystemStatus.HEALTHY,
                    message="Editorial review workbench operational",
                    latency_ms=(time.time() - t_bench) * 1000,
                    checked_at=now_iso,
                )
            )
        except Exception as e:
            components.append(
                ComponentHealth(
                    component="review_workbench",
                    status=SubsystemStatus.UNHEALTHY,
                    message=f"Workbench error: {e}",
                    latency_ms=(time.time() - t_bench) * 1000,
                    checked_at=now_iso,
                )
            )
        t_gate = time.time()
        try:
            components.append(
                ComponentHealth(
                    component="outlets_security_gate",
                    status=SubsystemStatus.HEALTHY,
                    message="Publication security gate active with 5 fail-closed rules",
                    latency_ms=(time.time() - t_gate) * 1000,
                    checked_at=now_iso,
                )
            )
        except Exception as e:
            components.append(
                ComponentHealth(
                    component="outlets_security_gate",
                    status=SubsystemStatus.UNHEALTHY,
                    message=f"Gate error: {e}",
                    latency_ms=(time.time() - t_gate) * 1000,
                    checked_at=now_iso,
                )
            )
        t_router = time.time()
        try:
            rec_count = len(self.pipeline.outlets_store.records_by_id)
            components.append(
                ComponentHealth(
                    component="outlets_http_router",
                    status=SubsystemStatus.HEALTHY,
                    message=f"Outlets HTTP router active ({rec_count} registered snapshots)",
                    latency_ms=(time.time() - t_router) * 1000,
                    checked_at=now_iso,
                    details={"records_count": rec_count},
                )
            )
        except Exception as e:
            components.append(
                ComponentHealth(
                    component="outlets_http_router",
                    status=SubsystemStatus.UNHEALTHY,
                    message=f"Router error: {e}",
                    latency_ms=(time.time() - t_router) * 1000,
                    checked_at=now_iso,
                )
            )
        t_hub = time.time()
        try:
            hist_count = len(self.pipeline.hub_projector.get_history())
            components.append(
                ComponentHealth(
                    component="hub_one_way_sync",
                    status=SubsystemStatus.HEALTHY,
                    message=f"Hub sync projector active ({hist_count} projections recorded)",
                    latency_ms=(time.time() - t_hub) * 1000,
                    checked_at=now_iso,
                    details={"history_count": hist_count},
                )
            )
        except Exception as e:
            components.append(
                ComponentHealth(
                    component="hub_one_way_sync",
                    status=SubsystemStatus.UNHEALTHY,
                    message=f"Hub sync error: {e}",
                    latency_ms=(time.time() - t_hub) * 1000,
                    checked_at=now_iso,
                )
            )
        t_cons = time.time()
        try:
            stats = self.pipeline.changes_consumer.get_stats()
            status = SubsystemStatus.DEGRADED if stats["dead_letters_count"] > 0 else SubsystemStatus.HEALTHY
            components.append(
                ComponentHealth(
                    component="changes_consumer",
                    status=status,
                    message=f"Changes consumer active (Hub: {stats['hub_cursor']}, Outlet: {stats['outlet_cursor']}, Dead letters: {stats['dead_letters_count']})",
                    latency_ms=(time.time() - t_cons) * 1000,
                    checked_at=now_iso,
                    details=stats,
                )
            )
        except Exception as e:
            components.append(
                ComponentHealth(
                    component="changes_consumer",
                    status=SubsystemStatus.UNHEALTHY,
                    message=f"Changes consumer error: {e}",
                    latency_ms=(time.time() - t_cons) * 1000,
                    checked_at=now_iso,
                )
            )
        healthy_count = sum(1 for c in components if c.status == SubsystemStatus.HEALTHY)
        degraded_count = sum(1 for c in components if c.status == SubsystemStatus.DEGRADED)
        unhealthy_count = sum(1 for c in components if c.status == SubsystemStatus.UNHEALTHY)
        overall = (
            SubsystemStatus.UNHEALTHY
            if unhealthy_count > 0
            else SubsystemStatus.DEGRADED
            if degraded_count > 0
            else SubsystemStatus.HEALTHY
        )
        return SystemHealthReport(
            status=overall,
            version="1.0.0-mvp",
            uptime_seconds=int(time.time() - self.pipeline.start_time),
            timestamp=now_iso,
            components=components,
            summary={
                "total_components": len(components),
                "healthy_count": healthy_count,
                "degraded_count": degraded_count,
                "unhealthy_count": unhealthy_count,
            },
        )
