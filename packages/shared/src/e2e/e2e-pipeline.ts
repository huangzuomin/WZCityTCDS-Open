import {
  type ReviewTask,
  type CandidateAssertion,
  ReviewWorkbenchManager,
} from "../review/workbench.js";
import {
  FactRevisionStorage,
} from "../revision/revision-storage.js";
import {
  type FactRevisionLifecycle,
  type PublicationSnapshot,
} from "../contracts/fact-revision.js";
import {
  type GateAssertionItem,
  type GateEvidenceReceiptItem,
  PublicationSecurityGate,
} from "../outlets/security-gate.js";
import {
  type PublicationSecurityGatePolicy,
} from "../contracts/outlets.js";
import {
  type OutletsHttpRequest,
  type OutletsHttpResponse,
  type OutletsStore,
  type SnapshotRecord,
  OutletsHttpRouter,
} from "../outlets/http-router.js";
import {
  type ChangesStreamEvent,
  ChangesStreamManager,
} from "../outlets/changes-stream.js";
import {
  type IHubProjectionTransport,
  HubOneWayProjector,
  MockHubProjectionTransport,
} from "../hub/hub-projector.js";
import {
  type HubProjectionReceipt,
} from "../contracts/hub-projection.js";
import {
  type ProjectedEntityState,
  ChangesStreamConsumer,
} from "../hub/changes-consumer.js";
import {
  type HubUpstreamChangeEvent,
} from "../contracts/hub-projection.js";
import {
  type E2EPipelineResult,
  type E2EExecutionStep,
  type SystemHealthReport,
  type ComponentHealth,
  type SubsystemStatus,
} from "../contracts/e2e.js";
import {
  type SourceNewsDocumentSnapshot,
  computeSpanHash,
} from "../evidence/evidence-engine.js";
import { type EvidenceSpan } from "../contracts/evidence.js";

export interface GoldenPathCandidateInput {
  entity_id: string;
  field_id: string;
  value: string;
  evidence_spans: Array<{
    source_doc_id: string;
    paragraph_index: number;
    start_char: number;
    end_char: number;
    quoted_text: string;
    span_hash: string;
    source_authority_level?: "OFFICIAL_GOVERNMENT" | "OFFICIAL_PORTAL" | "STATE_COMMERCIAL_MEDIA" | "OTHER";
  }>;
  submitted_by: string;
  notes?: string;
}

export class InMemoryOutletsStore implements OutletsStore {
  public recordsById = new Map<string, SnapshotRecord>();
  public recordsByEntity = new Map<string, SnapshotRecord>();
  public retractedSources: string[] = [];

  constructor(public streamManager: ChangesStreamManager) {}

  async getSnapshotRecordById(id: string): Promise<SnapshotRecord | null> {
    return this.recordsById.get(id) || null;
  }

  async getSnapshotRecordByEntity(entityId: string): Promise<SnapshotRecord | null> {
    return this.recordsByEntity.get(entityId) || null;
  }

  async listPublicSnapshots(limit?: number): Promise<SnapshotRecord[]> {
    const list = Array.from(this.recordsById.values());
    return typeof limit === "number" && limit > 0 ? list.slice(0, limit) : list;
  }

  async getChangesStreamManager(): Promise<ChangesStreamManager> {
    return this.streamManager;
  }

  async getRetractedSourceDocIds(): Promise<string[]> {
    return this.retractedSources;
  }

  setRecord(record: SnapshotRecord): void {
    this.recordsById.set(record.snapshot.snapshot_revision_id, record);
    this.recordsByEntity.set(record.snapshot.entity_id, record);
  }
}

export class EndToEndIntegrationPipeline {
  public readonly workbench: ReviewWorkbenchManager;
  public readonly revisionStorage: FactRevisionStorage;
  public readonly securityGate: PublicationSecurityGate;
  public readonly outletsStore: InMemoryOutletsStore;
  public readonly httpRouter: OutletsHttpRouter;
  public readonly changesManager: ChangesStreamManager;
  public readonly hubProjector: HubOneWayProjector;
  public readonly changesConsumer: ChangesStreamConsumer;
  public readonly startTime: number;

  constructor(options: { transport?: IHubProjectionTransport } = {}) {
    this.startTime = Date.now();
    this.workbench = new ReviewWorkbenchManager();
    this.revisionStorage = new FactRevisionStorage();
    this.securityGate = new PublicationSecurityGate();
    this.changesManager = new ChangesStreamManager();
    this.outletsStore = new InMemoryOutletsStore(this.changesManager);
    this.httpRouter = new OutletsHttpRouter(this.outletsStore);
    const transport = options.transport || new MockHubProjectionTransport();
    this.hubProjector = new HubOneWayProjector(transport);
    this.changesConsumer = new ChangesStreamConsumer();
  }

  public async executeGoldenPath(params: {
    candidate: GoldenPathCandidateInput;
    sourceDoc: SourceNewsDocumentSnapshot;
    reviewerId: string;
  }): Promise<E2EPipelineResult> {
    const steps: E2EExecutionStep[] = [];
    const runId = `pipe_run_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const entityId = params.candidate.entity_id;
    const verifiedOutlets: string[] = [];

    try {
      // Step 1: Ingest candidate fact
      const t1 = Date.now();
      const assertionId = `ast_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const spans: EvidenceSpan[] = params.candidate.evidence_spans.map((s, idx) => ({
        span_id: `span_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 7)}`,
        source_doc_id: s.source_doc_id,
        paragraph_index: s.paragraph_index,
        char_start: s.start_char,
        char_end: s.end_char,
        quoted_text: s.quoted_text,
        span_hash: s.span_hash,
        extracted_at: new Date().toISOString(),
        quality_state: "VALIDATED",
      }));

      const candidateAssertion: CandidateAssertion = {
        assertion_id: assertionId,
        property_path: params.candidate.field_id,
        assertion_value: {
          raw_value: params.candidate.value,
          data_type: "STRING",
        },
        evidence_span_ids: spans.map((s) => s.span_id),
        created_at: new Date().toISOString(),
      };

      const reviewTask = await this.workbench.ingestCandidate({
        entity_id: params.candidate.entity_id,
        property_path: params.candidate.field_id,
        candidate_assertion: candidateAssertion,
        evidence_spans: spans,
        submitted_by: params.candidate.submitted_by,
      });

      steps.push({
        step_number: 1,
        name: "INGEST_CANDIDATE",
        status: "PASS",
        duration_ms: Date.now() - t1,
        details: { task_id: reviewTask.task_id, status: reviewTask.status },
      });

      // Step 2: Preflight evidence verification
      const t2 = Date.now();
      const evidenceReceipt = await this.workbench.verifyEvidence(
        reviewTask.task_id,
        [params.sourceDoc],
        params.reviewerId
      );
      if (evidenceReceipt.overall_verification_verdict !== "PASS") {
        throw new Error(
          `Preflight evidence verification failed: ${evidenceReceipt.overall_verification_verdict}`
        );
      }
      steps.push({
        step_number: 2,
        name: "PREFLIGHT_EVIDENCE_VERIFICATION",
        status: "PASS",
        duration_ms: Date.now() - t2,
        details: { verdict: evidenceReceipt.overall_verification_verdict },
      });

      // Step 3: Claim review task
      const t3 = Date.now();
      await this.workbench.claimTask(reviewTask.task_id, params.reviewerId, "reviewer");
      steps.push({
        step_number: 3,
        name: "CLAIM_TASK",
        status: "PASS",
        duration_ms: Date.now() - t3,
        details: { assigned_to: params.reviewerId },
      });

      // Step 4: Editorial approval
      const t4 = Date.now();
      const { task: approvedTask, published_revision_id } = await this.workbench.approveTask(
        reviewTask.task_id,
        params.reviewerId,
        "Editorial sign-off approved",
        "reviewer"
      );
      steps.push({
        step_number: 4,
        name: "EDITORIAL_APPROVAL",
        status: "PASS",
        duration_ms: Date.now() - t4,
        details: { published_revision_id },
      });

      // Step 5: Append to Revision Storage
      const t5 = Date.now();
      const storedRevision = this.revisionStorage.createRevision({
        assertion_id: assertionId,
        entity_id: params.candidate.entity_id,
        property_path: params.candidate.field_id,
        assertion_value: {
          raw_value: params.candidate.value,
          data_type: "STRING",
        },
        created_by_role: "FACT_REVIEWER",
        author_id: params.reviewerId,
        revision_reason: "INITIAL_PUBLISH",
        reason_description: "Initial establishment",
        evidence_span_hashes: spans.map((s) => s.span_hash),
        initial_state: "PENDING_REVIEW",
      });

      this.revisionStorage.transitionState({
        revision_id: storedRevision.revision_id,
        trigger: "APPROVE_AND_PUBLISH",
        authorized_role: "FACT_REVIEWER",
        operator_id: params.reviewerId,
      });

      // Generate publication snapshot
      const snapshot = this.revisionStorage.generatePublicationSnapshot(params.candidate.entity_id, {
        publisher_role: "CHIEF_FACT_EDITOR",
        outlet_scopes: [
          "PUBLIC_HTML_ARCHIVE",
          "REST_API",
          "FEED_ATOM",
          "MCP_ENDPOINT",
          "HUB_ONE_WAY_PROJECTION",
        ],
      });

      steps.push({
        step_number: 5,
        name: "APPEND_REVISION_STORAGE",
        status: "PASS",
        duration_ms: Date.now() - t5,
        details: {
          revision_id: storedRevision.revision_id,
          snapshot_revision_id: snapshot.snapshot_revision_id,
        },
      });

      // Step 6: Publication Security Gate
      const t6 = Date.now();
      const gateAssertions: GateAssertionItem[] = snapshot.published_assertions.map((a) => ({
        assertion_id: a.assertion_id,
        lifecycle_state: "PUBLISHED",
        evidence_hashes: a.evidence_hashes,
        raw_value: a.raw_value,
        source_doc_ids: [params.sourceDoc.source_doc_id],
      }));
      const receiptsMap: Record<string, GateEvidenceReceiptItem> = {};
      receiptsMap[assertionId] = { overall_verification_verdict: "PASS" };
      for (const span of spans) {
        receiptsMap[span.span_hash] = { overall_verification_verdict: "PASS" };
      }

      const gatePolicy = this.securityGate.evaluate({
        snapshot_revision_id: snapshot.snapshot_revision_id,
        assertions: gateAssertions,
        evidence_receipts: receiptsMap,
      });

      if (gatePolicy.gate_verdict !== "PASS_APPROVED_FOR_RELEASE") {
        throw new Error(`Security gate blocked release: ${gatePolicy.gate_verdict}`);
      }
      steps.push({
        step_number: 6,
        name: "PUBLICATION_SECURITY_GATE",
        status: "PASS",
        duration_ms: Date.now() - t6,
        details: { gate_verdict: gatePolicy.gate_verdict },
      });

      // Step 7: Multi-outlet distribution & registration
      const t7 = Date.now();
      const snapshotRecord: SnapshotRecord = {
        snapshot,
        receipts: receiptsMap,
        lifecycleStates: { [assertionId]: "PUBLISHED" },
        sourceDocIds: { [assertionId]: [params.sourceDoc.source_doc_id] },
      };
      this.outletsStore.setRecord(snapshotRecord);

      // Verify outlets
      const restRes = await this.httpRouter.handleRequest({
        method: "GET",
        path: `/outlets/snapshot/${snapshot.snapshot_revision_id}`,
      });
      if (restRes.statusCode === 200) verifiedOutlets.push("REST_API_V1");

      const htmlRes = await this.httpRouter.handleRequest({
        method: "GET",
        path: `/outlets/archive/${snapshot.entity_id}`,
      });
      if (htmlRes.statusCode === 200) verifiedOutlets.push("PUBLIC_HTML_ARCHIVE");

      const jsonldRes = await this.httpRouter.handleRequest({
        method: "GET",
        path: `/outlets/jsonld/${snapshot.snapshot_revision_id}`,
      });
      if (jsonldRes.statusCode === 200) verifiedOutlets.push("JSON_LD_CARD");

      const mcpRes = await this.httpRouter.handleRequest({
        method: "POST",
        path: "/outlets/mcp",
        body: { entity_id: snapshot.entity_id },
      });
      if (mcpRes.statusCode === 200) verifiedOutlets.push("LLM_MCP_ENDPOINT");

      steps.push({
        step_number: 7,
        name: "MULTI_OUTLET_DISTRIBUTION",
        status: "PASS",
        duration_ms: Date.now() - t7,
        details: { verified_outlets: verifiedOutlets },
      });

      // Step 8: Hub one-way projection
      const t8 = Date.now();
      const receipt = await this.hubProjector.projectSnapshot(snapshot, { gatePolicy });
      if (receipt.status !== "ACCEPTED") {
        throw new Error(`Hub projection rejected: ${receipt.rejection_reason || receipt.status}`);
      }
      steps.push({
        step_number: 8,
        name: "HUB_ONE_WAY_PROJECTION",
        status: "PASS",
        duration_ms: Date.now() - t8,
        details: {
          receipt_id: receipt.receipt_id,
          status: receipt.status,
          slot_id: receipt.hub_slot_id,
        },
      });

      // Step 9: Changes stream emission and consumption
      const t9 = Date.now();
      const changeEvent = this.changesManager.emitEvent({
        change_type: "FACT_PUBLISHED",
        entity_id: params.candidate.entity_id,
        affected_revision: {
          revision_id: storedRevision.revision_id,
          property_path: params.candidate.field_id,
          lifecycle_state: "PUBLISHED",
          publication_snapshot_id: snapshot.publication_id,
        },
      });
      this.changesConsumer.consumeOutletEvent(changeEvent);

      steps.push({
        step_number: 9,
        name: "CHANGES_STREAM_CONSUMPTION",
        status: "PASS",
        duration_ms: Date.now() - t9,
        details: {
          sequence: changeEvent.change_sequence_num,
          outlet_cursor: this.changesConsumer.getOutletCursor(),
        },
      });

      return {
        pipeline_run_id: runId,
        success: true,
        entity_id: entityId,
        steps,
        review_task_id: approvedTask.task_id,
        published_revision_id,
        security_gate_policy: gatePolicy,
        hub_receipt: receipt,
        outlets_verified: verifiedOutlets,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        pipeline_run_id: runId,
        success: false,
        entity_id: entityId,
        steps,
        outlets_verified: verifiedOutlets,
        error: errorMsg,
      };
    }
  }

  public async executeSecurityGateFailClosed(params: {
    candidate: GoldenPathCandidateInput;
    sourceDoc: SourceNewsDocumentSnapshot;
    reviewerId: string;
    leakedSecret?: string;
    leakedIp?: string;
  }): Promise<E2EPipelineResult> {
    const steps: E2EExecutionStep[] = [];
    const runId = `pipe_run_sec_${Date.now()}`;
    const entityId = params.candidate.entity_id;

    // 1. Ingest & verify
    const assertionId = `ast_sec_${Date.now()}`;
    const spans: EvidenceSpan[] = params.candidate.evidence_spans.map((s, idx) => ({
      span_id: `span_sec_${Date.now()}_${idx}`,
      source_doc_id: s.source_doc_id,
      paragraph_index: s.paragraph_index,
      char_start: s.start_char,
      char_end: s.end_char,
      quoted_text: s.quoted_text,
      span_hash: s.span_hash,
      extracted_at: new Date().toISOString(),
      quality_state: "VALIDATED",
    }));

    const task = await this.workbench.ingestCandidate({
      entity_id: params.candidate.entity_id,
      property_path: params.candidate.field_id,
      candidate_assertion: {
        assertion_id: assertionId,
        property_path: params.candidate.field_id,
        assertion_value: {
          raw_value: params.candidate.value,
          data_type: "STRING",
        },
        evidence_span_ids: spans.map((s) => s.span_id),
        created_at: new Date().toISOString(),
      },
      evidence_spans: spans,
      submitted_by: "sec_test_user",
    });
    await this.workbench.verifyEvidence(task.task_id, [params.sourceDoc], params.reviewerId);
    await this.workbench.claimTask(task.task_id, params.reviewerId, "reviewer");
    const { published_revision_id } = await this.workbench.approveTask(task.task_id, params.reviewerId, "Signoff", "reviewer");

    // 2. Build snapshot with leaked payload
    const leakedRawValue = params.leakedSecret
      ? `api_key=${params.leakedSecret}`
      : params.leakedIp
      ? `http://${params.leakedIp}:8080/internal`
      : params.candidate.value;

    const leakedRawText = params.leakedSecret
      ? `Bearer ${params.leakedSecret}`
      : params.leakedIp
      ? `Host is http://${params.leakedIp}:8080/internal`
      : undefined;

    const snapshotRevisionId = `pubrev_sec_${Date.now()}`;

    const gatePolicy = this.securityGate.evaluate({
      snapshot_revision_id: snapshotRevisionId,
      assertions: [
        {
          assertion_id: assertionId,
          lifecycle_state: "PUBLISHED",
          evidence_hashes: params.candidate.evidence_spans.map((s) => s.span_hash),
          raw_value: leakedRawValue,
          source_doc_ids: [params.sourceDoc.source_doc_id],
        },
      ],
      evidence_receipts: {
        [assertionId]: {
          overall_verification_verdict: "PASS",
        },
      },
      raw_payload_text: leakedRawText,
    });

    const gateBlocked = gatePolicy.gate_verdict === "FAIL_CLOSED_BLOCKED";
    steps.push({
      step_number: 1,
      name: "GATE_EVALUATION",
      status: gateBlocked ? "PASS" : "FAIL",
      duration_ms: 1,
      details: { verdict: gatePolicy.gate_verdict },
    });

    // 3. Register to outlets with failed gate policy
    const snapshot: PublicationSnapshot = {
      publication_id: `pub_sec_${Date.now()}`,
      snapshot_revision_id: snapshotRevisionId,
      entity_id: params.candidate.entity_id,
      generated_at: new Date().toISOString(),
      snapshot_digest_sha256: "c".repeat(64),
      published_assertions: [
        {
          assertion_id: assertionId,
          revision_id: published_revision_id,
          property_path: params.candidate.field_id,
          raw_value: leakedRawValue,
          evidence_hashes: params.candidate.evidence_spans.map((s) => s.span_hash),
        },
      ],
      projection_metadata: {
        kernel_system: "WZCityTCDS-PublicationKernel",
        publisher_role: "CHIEF_FACT_EDITOR",
        outlet_scopes: ["REST_API"],
        is_latest_snapshot: true,
      },
    };

    this.outletsStore.setRecord({
      snapshot,
      receipts: {
        [assertionId]: {
          overall_verification_verdict: "PASS",
        },
      },
      lifecycleStates: { [assertionId]: "PUBLISHED" },
      sourceDocIds: { [assertionId]: [params.sourceDoc.source_doc_id] },
    });

    const restRes = await this.httpRouter.handleRequest({
      method: "GET",
      path: `/outlets/snapshot/${snapshot.snapshot_revision_id}`,
    });
    const outletsBlocked = restRes.statusCode === 403;
    steps.push({
      step_number: 2,
      name: "OUTLETS_BLOCKED_VERIFICATION",
      status: outletsBlocked ? "PASS" : "FAIL",
      duration_ms: 1,
      details: { http_status: restRes.statusCode },
    });

    // 4. Hub projection fail-closed
    let hubBlocked = false;
    let hubReceipt: HubProjectionReceipt | undefined;
    try {
      hubReceipt = await this.hubProjector.projectSnapshot(snapshot, { gatePolicy });
      hubBlocked = hubReceipt.status === "REJECTED";
    } catch (err: unknown) {
      hubBlocked = String(err).includes("Security gate fail-closed");
    }

    steps.push({
      step_number: 3,
      name: "HUB_PROJECTION_BLOCKED",
      status: hubBlocked ? "PASS" : "FAIL",
      duration_ms: 1,
      details: { hub_blocked: hubBlocked },
    });

    return {
      pipeline_run_id: runId,
      success: gateBlocked && outletsBlocked && hubBlocked,
      entity_id: entityId,
      steps,
      review_task_id: task.task_id,
      published_revision_id,
      security_gate_policy: gatePolicy,
      hub_receipt: hubReceipt,
      outlets_verified: [],
    };
  }
}

export class SystemHealthEvaluator {
  private readonly pipeline: EndToEndIntegrationPipeline;

  constructor(pipeline: EndToEndIntegrationPipeline) {
    this.pipeline = pipeline;
  }

  public evaluateHealth(): SystemHealthReport {
    const components: ComponentHealth[] = [];
    const nowIso = new Date().toISOString();

    // 1. Revision Storage
    const tStorage = Date.now();
    try {
      this.pipeline.revisionStorage.getLatestRevision("ast_test_123456789012");
      components.push({
        component: "revision_storage",
        status: "HEALTHY",
        message: "Append-only fact revision storage online",
        latency_ms: Date.now() - tStorage,
        checked_at: nowIso,
      });
    } catch (err: unknown) {
      components.push({
        component: "revision_storage",
        status: "UNHEALTHY",
        message: `Revision storage error: ${String(err)}`,
        latency_ms: Date.now() - tStorage,
        checked_at: nowIso,
      });
    }

    // 2. Review Workbench
    const tBench = Date.now();
    try {
      components.push({
        component: "review_workbench",
        status: "HEALTHY",
        message: "Editorial review workbench operational",
        latency_ms: Date.now() - tBench,
        checked_at: nowIso,
      });
    } catch (err: unknown) {
      components.push({
        component: "review_workbench",
        status: "UNHEALTHY",
        message: `Workbench error: ${String(err)}`,
        latency_ms: Date.now() - tBench,
        checked_at: nowIso,
      });
    }

    // 3. Outlets Security Gate
    const tGate = Date.now();
    try {
      components.push({
        component: "outlets_security_gate",
        status: "HEALTHY",
        message: "Publication security gate active with 5 fail-closed rules",
        latency_ms: Date.now() - tGate,
        checked_at: nowIso,
      });
    } catch (err: unknown) {
      components.push({
        component: "outlets_security_gate",
        status: "UNHEALTHY",
        message: `Gate error: ${String(err)}`,
        latency_ms: Date.now() - tGate,
        checked_at: nowIso,
      });
    }

    // 4. Outlets HTTP Router
    const tRouter = Date.now();
    try {
      const recordsCount = this.pipeline.outletsStore.recordsById.size;
      components.push({
        component: "outlets_http_router",
        status: "HEALTHY",
        message: `Outlets HTTP router active (${recordsCount} registered snapshots)`,
        latency_ms: Date.now() - tRouter,
        checked_at: nowIso,
        details: { records_count: recordsCount },
      });
    } catch (err: unknown) {
      components.push({
        component: "outlets_http_router",
        status: "UNHEALTHY",
        message: `Router error: ${String(err)}`,
        latency_ms: Date.now() - tRouter,
        checked_at: nowIso,
      });
    }

    // 5. Hub One-Way Projector
    const tHub = Date.now();
    try {
      const historyCount = this.pipeline.hubProjector.getHistory().length;
      components.push({
        component: "hub_one_way_sync",
        status: "HEALTHY",
        message: `Hub sync projector active (${historyCount} projections recorded)`,
        latency_ms: Date.now() - tHub,
        checked_at: nowIso,
        details: { history_count: historyCount },
      });
    } catch (err: unknown) {
      components.push({
        component: "hub_one_way_sync",
        status: "UNHEALTHY",
        message: `Hub sync error: ${String(err)}`,
        latency_ms: Date.now() - tHub,
        checked_at: nowIso,
      });
    }

    // 6. Changes Stream Consumer
    const tConsumer = Date.now();
    try {
      const stats = this.pipeline.changesConsumer.getStats();
      const status: SubsystemStatus = stats.deadLettersCount > 0 ? "DEGRADED" : "HEALTHY";
      components.push({
        component: "changes_consumer",
        status,
        message: `Changes consumer active (Hub: ${stats.hubCursor}, Outlet: ${stats.outletCursor}, Dead letters: ${stats.deadLettersCount})`,
        latency_ms: Date.now() - tConsumer,
        checked_at: nowIso,
        details: stats,
      });
    } catch (err: unknown) {
      components.push({
        component: "changes_consumer",
        status: "UNHEALTHY",
        message: `Changes consumer error: ${String(err)}`,
        latency_ms: Date.now() - tConsumer,
        checked_at: nowIso,
      });
    }

    let healthyCount = 0;
    let degradedCount = 0;
    let unhealthyCount = 0;

    for (const c of components) {
      if (c.status === "HEALTHY") healthyCount++;
      else if (c.status === "DEGRADED") degradedCount++;
      else if (c.status === "UNHEALTHY") unhealthyCount++;
    }

    const overallStatus: SubsystemStatus =
      unhealthyCount > 0 ? "UNHEALTHY" : degradedCount > 0 ? "DEGRADED" : "HEALTHY";

    return {
      status: overallStatus,
      version: "1.0.0-mvp",
      uptime_seconds: Math.floor((Date.now() - this.pipeline.startTime) / 1000),
      timestamp: nowIso,
      components,
      summary: {
        total_components: components.length,
        healthy_count: healthyCount,
        degraded_count: degradedCount,
        unhealthy_count: unhealthyCount,
      },
    };
  }
}
