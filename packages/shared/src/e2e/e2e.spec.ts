import { EndToEndIntegrationPipeline, SystemHealthEvaluator, type GoldenPathCandidateInput } from "./e2e-pipeline.js";
import { type SourceNewsDocumentSnapshot, computeSpanHash } from "../evidence/evidence-engine.js";
import { type EvidenceSpan } from "../contracts/evidence.js";
import { computeUpstreamChangeDigest } from "../hub/changes-consumer.js";

async function runE2ETests(): Promise<void> {
  console.log("=== Running FPF Slice R4 End-to-End Integration & Acceptance Tests ===");
  let passed = 0;
  let failed = 0;

  function check(name: string, condition: boolean, extra = ""): void {
    if (condition) {
      console.log(`[PASS] Check ${passed + failed + 1}: ${name}`);
      passed++;
    } else {
      console.error(`[FAIL] Check ${passed + failed + 1}: ${name} ${extra}`);
      failed++;
    }
  }

  // Setup sample source document and candidate fact
  const paragraph = "2026年温州市全市数字经济核心产业增加值达到985.4亿元，同比增长11.2%。";
  const quotedText = "985.4亿元";
  const startIndex = paragraph.indexOf(quotedText);
  const endIndex = startIndex + quotedText.length;
  const spanHash = computeSpanHash(quotedText);

  const sourceDoc: SourceNewsDocumentSnapshot = {
    source_doc_id: "news_wz_2026_digital_economy",
    source_url: "https://news.wenzhou.gov.cn/2026/economy/digital.html",
    paragraphs: [paragraph],
    is_retracted: false,
  };

  const goldenCandidate: GoldenPathCandidateInput = {
    entity_id: "ent_wz_economy_stat_2026",
    field_id: "digital_economy_added_value",
    value: "985.4亿元",
    evidence_spans: [
      {
        source_doc_id: sourceDoc.source_doc_id,
        paragraph_index: 0,
        start_char: startIndex,
        end_char: endIndex,
        quoted_text: quotedText,
        span_hash: spanHash,
        source_authority_level: "OFFICIAL_GOVERNMENT",
      },
    ],
    submitted_by: "editorial_ingest_bot",
    notes: "2026 annual digital economy benchmark",
  };

  // Check 1: Golden Path Full Lifecycle
  const pipeline = new EndToEndIntegrationPipeline();
  const goldenResult = await pipeline.executeGoldenPath({
    candidate: goldenCandidate,
    sourceDoc,
    reviewerId: "reviewer_alice",
  });
  check(
    "Golden path completes full 9-step lifecycle successfully",
    goldenResult.success === true &&
      goldenResult.steps.length === 9 &&
      goldenResult.outlets_verified.length >= 4 &&
      Boolean(goldenResult.hub_receipt) &&
      goldenResult.hub_receipt?.status === "ACCEPTED",
    JSON.stringify(goldenResult.error)
  );

  // Check 2: Preflight Evidence Failure halts pipeline
  const brokenCandidate: GoldenPathCandidateInput = {
    ...goldenCandidate,
    entity_id: "ent_wz_economy_stat_broken",
    evidence_spans: [
      {
        source_doc_id: sourceDoc.source_doc_id,
        paragraph_index: 0,
        start_char: 0,
        end_char: 5,
        quoted_text: "wrong",
        span_hash: "a".repeat(64),
      },
    ],
  };
  const brokenPipeline = new EndToEndIntegrationPipeline();
  const brokenResult = await brokenPipeline.executeGoldenPath({
    candidate: brokenCandidate,
    sourceDoc,
    reviewerId: "reviewer_bob",
  });
  check(
    "Preflight evidence failure halts pipeline with error and zero outlets verified",
    brokenResult.success === false &&
      brokenResult.outlets_verified.length === 0 &&
      Boolean(brokenResult.error?.includes("Preflight evidence verification failed")),
    String(brokenResult.error)
  );

  // Check 3: Conflict detection in review workbench
  const pipeConflict = new EndToEndIntegrationPipeline();
  const spanItem: EvidenceSpan = {
    span_id: `span_conf_123456789012`,
    source_doc_id: sourceDoc.source_doc_id,
    paragraph_index: 0,
    char_start: startIndex,
    char_end: endIndex,
    quoted_text: quotedText,
    span_hash: spanHash,
    extracted_at: new Date().toISOString(),
    quality_state: "VALIDATED",
  };
  await pipeConflict.workbench.ingestCandidate({
    entity_id: "ent_wz_digital_conflict_1",
    property_path: "gdp.growth",
    candidate_assertion: {
      assertion_id: "ast_conflict_0000000001",
      property_path: "gdp.growth",
      assertion_value: { raw_value: "11.2%", data_type: "STRING" },
      evidence_span_ids: [spanItem.span_id],
      created_at: new Date().toISOString(),
    },
    evidence_spans: [spanItem],
    submitted_by: "bot_a",
  });
  const t2 = await pipeConflict.workbench.ingestCandidate({
    entity_id: "ent_wz_digital_conflict_1",
    property_path: "gdp.growth",
    candidate_assertion: {
      assertion_id: "ast_conflict_0000000002",
      property_path: "gdp.growth",
      assertion_value: { raw_value: "12.0%", data_type: "STRING" },
      evidence_span_ids: [spanItem.span_id],
      created_at: new Date().toISOString(),
    },
    evidence_spans: [spanItem],
    submitted_by: "bot_b",
    existing_published_assertion: {
      revision_id: "rev_existing_pub_12345678",
      raw_value: "11.2%",
    },
  });
  const task2After = await pipeConflict.workbench.getTask(t2.task_id);
  check(
    "Conflicting candidate on divergent value triggers ARBITRATION_REQUIRED",
    task2After?.status === "ARBITRATION_REQUIRED" && Boolean(task2After.conflict_context)
  );

  // Check 4: Security gate fail-closed on private IP leak
  const secResultIp = await pipeline.executeSecurityGateFailClosed({
    candidate: { ...goldenCandidate, entity_id: "ent_wz_sec_ip_leak" },
    sourceDoc,
    reviewerId: "reviewer_carol",
    leakedIp: "192.168.1.100",
  });
  check(
    "Security gate blocks candidate leaking private IPv4 and outlets return 403",
    secResultIp.success === true &&
      secResultIp.security_gate_policy?.gate_verdict === "FAIL_CLOSED_BLOCKED" &&
      secResultIp.security_gate_policy.rule_evaluations.rule_no_private_ip_leaks.passed === false
  );

  // Check 5: Security gate fail-closed on API key leak
  const secResultKey = await pipeline.executeSecurityGateFailClosed({
    candidate: { ...goldenCandidate, entity_id: "ent_wz_sec_key_leak" },
    sourceDoc,
    reviewerId: "reviewer_carol",
    leakedSecret: ["sk", "test12345678901234567890123456"].join("-"),
  });
  check(
    "Security gate blocks candidate leaking API key credentials",
    secResultKey.success === true &&
      secResultKey.security_gate_policy?.gate_verdict === "FAIL_CLOSED_BLOCKED" &&
      secResultKey.security_gate_policy.rule_evaluations.rule_no_credential_patterns.passed === false
  );

  // Check 6: Retracted source document triggers verification failure
  const retractedDoc: SourceNewsDocumentSnapshot = { ...sourceDoc, is_retracted: true };
  const pipeRetract = new EndToEndIntegrationPipeline();
  const spanRetract: EvidenceSpan = {
    span_id: `span_retract_123456789012`,
    source_doc_id: retractedDoc.source_doc_id,
    paragraph_index: 0,
    char_start: startIndex,
    char_end: endIndex,
    quoted_text: quotedText,
    span_hash: spanHash,
    extracted_at: new Date().toISOString(),
    quality_state: "VALIDATED",
  };
  const rTask = await pipeRetract.workbench.ingestCandidate({
    entity_id: "ent_wz_retracted_source",
    property_path: "stats",
    candidate_assertion: {
      assertion_id: "ast_retract_00000000001",
      property_path: "stats",
      assertion_value: { raw_value: "985.4亿元", data_type: "STRING" },
      evidence_span_ids: [spanRetract.span_id],
      created_at: new Date().toISOString(),
    },
    evidence_spans: [spanRetract],
    submitted_by: "bot_test",
  });
  const rReceipt = await pipeRetract.workbench.verifyEvidence(rTask.task_id, [retractedDoc], "reviewer_dan");
  check(
    "Retracted source document triggers FAIL_SOURCE_RETRACTED in evidence verification",
    rReceipt.overall_verification_verdict === "FAIL_SOURCE_RETRACTED"
  );

  // Check 7: Option A single-root Hub entity ID enforcement
  let invalidIdBlocked = false;
  try {
    await pipeline.hubProjector.projectSnapshot({
      publication_id: "pub_1234567890123",
      snapshot_revision_id: "pubrev_1234567890123",
      entity_id: "INVALID_ID_WITHOUT_PREFIX",
      generated_at: new Date().toISOString(),
      snapshot_digest_sha256: "0".repeat(64),
      published_assertions: [],
      projection_metadata: {
        kernel_system: "WZCityTCDS-PublicationKernel",
        publisher_role: "CHIEF_FACT_EDITOR",
        outlet_scopes: ["REST_API"],
        is_latest_snapshot: true,
      },
    });
  } catch (err: unknown) {
    invalidIdBlocked = String(err).includes("Must match ^ent_") || String(err).includes("Option A");
  }
  check("Hub projector strictly enforces Option A entity ID format ent_[a-z0-9_-]{8,64}", invalidIdBlocked);

  // Check 8: Hub signed receipt structure
  const lastReceipt = pipeline.hubProjector.getLatestReceipt(goldenCandidate.entity_id);
  check(
    "Hub signed receipt verified with valid assigned slot and SHA-256 signature",
    Boolean(lastReceipt) &&
      lastReceipt?.status === "ACCEPTED" &&
      Boolean(lastReceipt.hub_slot_id) &&
      lastReceipt.receipt_signature_sha256.length === 64
  );

  // Check 9: Upstream entity created and updated state sync
  const consumer = pipeline.changesConsumer;
  const rawEvt9 = {
    hub_change_event_id: "hchg_upd_000000001",
    hub_sequence_num: 10,
    change_type: "ENTITY_UPDATED" as const,
    category: "ORGANIZATION" as const,
    entity_id: goldenCandidate.entity_id,
    canonical_name: "温州市大数据局",
    aliases: ["温州数据局"],
    timestamp: new Date().toISOString(),
  };
  consumer.consumeHubEvent({
    ...rawEvt9,
    digest_sha256: computeUpstreamChangeDigest(rawEvt9),
  });
  const stateAfterUpdate = consumer.getEntityState(goldenCandidate.entity_id);
  check(
    "Upstream entity update event correctly syncs projected entity state",
    stateAfterUpdate?.entity_id === goldenCandidate.entity_id &&
      stateAfterUpdate?.is_tombstoned === false &&
      consumer.getHubCursor() === 10
  );

  // Check 10: Upstream entity tombstoned propagation
  const rawEvt10 = {
    hub_change_event_id: "hchg_tomb_000000002",
    hub_sequence_num: 11,
    change_type: "TOMBSTONED" as const,
    category: "ORGANIZATION" as const,
    entity_id: goldenCandidate.entity_id,
    canonical_name: "温州市大数据局",
    aliases: [],
    timestamp: new Date().toISOString(),
    tombstone_reason: "Government organization restructured",
  };
  consumer.consumeHubEvent({
    ...rawEvt10,
    digest_sha256: computeUpstreamChangeDigest(rawEvt10),
  });
  const stateAfterTomb = consumer.getEntityState(goldenCandidate.entity_id);
  check(
    "Upstream TOMBSTONED event transitions entity is_tombstoned to true",
    stateAfterTomb?.is_tombstoned === true && consumer.getHubCursor() === 11
  );

  // Check 11: Multi-outlet content consistency
  const registeredSnapshotId = goldenResult.security_gate_policy?.snapshot_revision_id || "";
  const restOut = await pipeline.httpRouter.handleRequest({ method: "GET", path: `/outlets/snapshot/${registeredSnapshotId}` });
  const htmlOut = await pipeline.httpRouter.handleRequest({ method: "GET", path: `/outlets/archive/${goldenCandidate.entity_id}` });
  const jsonldOut = await pipeline.httpRouter.handleRequest({ method: "GET", path: `/outlets/jsonld/${registeredSnapshotId}` });
  const mcpOut = await pipeline.httpRouter.handleRequest({ method: "POST", path: "/outlets/mcp", body: { entity_id: goldenCandidate.entity_id } });

  check(
    "Multi-outlet consistency: REST, HTML, JSON-LD, and MCP share exact fact values and version",
    restOut.statusCode === 200 &&
      htmlOut.statusCode === 200 &&
      jsonldOut.statusCode === 200 &&
      mcpOut.statusCode === 200 &&
      String(htmlOut.body).includes("985.4") &&
      String(jsonldOut.body).includes(goldenCandidate.entity_id) &&
      String(mcpOut.body).includes("985.4")
  );

  // Check 12: Changes stream sequence monotonicity and idempotency
  const initSeq = pipeline.changesManager.getSequence();
  const evtA = pipeline.changesManager.emitEvent({
    change_type: "FACT_PUBLISHED",
    entity_id: "ent_mono_000000001",
    affected_revision: {
      revision_id: "rev_mono_000000000001",
      property_path: "p1",
      lifecycle_state: "PUBLISHED",
    },
  });
  const evtB = pipeline.changesManager.emitEvent({
    change_type: "FACT_PUBLISHED",
    entity_id: "ent_mono_000000002",
    affected_revision: {
      revision_id: "rev_mono_000000000002",
      property_path: "p2",
      lifecycle_state: "PUBLISHED",
    },
  });
  check(
    "Outlet changes stream sequence numbers increment strictly monotonically",
    evtA.change_sequence_num === initSeq + 1 && evtB.change_sequence_num === initSeq + 2
  );

  // Check 13: NDJSON stream ingestion and dead-letter queue
  const rawEvt13a = {
    hub_change_event_id: "hchg_ndjson_good_1",
    hub_sequence_num: 30,
    category: "ORGANIZATION" as const,
    entity_id: "ent_ndjson_good",
    canonical_name: "测试单位",
    aliases: [],
    timestamp: "2026-03-01T00:00:00.000Z",
    change_type: "ENTITY_CREATED" as const,
  };
  const validEventJson = JSON.stringify({
    ...rawEvt13a,
    digest_sha256: computeUpstreamChangeDigest(rawEvt13a),
  });

  const rawEvt13b = {
    hub_change_event_id: "hchg_ndjson_good_2",
    hub_sequence_num: 31,
    category: "ORGANIZATION" as const,
    entity_id: "ent_ndjson_good",
    canonical_name: "测试单位2",
    aliases: [],
    timestamp: "2026-03-01T00:00:00.000Z",
    change_type: "ENTITY_UPDATED" as const,
  };
  const validEventJson2 = JSON.stringify({
    ...rawEvt13b,
    digest_sha256: computeUpstreamChangeDigest(rawEvt13b),
  });
  const mixedNdjson = `${validEventJson}\nMALFORMED_NON_JSON_LINE\n${validEventJson2}\n`;
  const ndjsonStats = consumer.consumeNdjson(mixedNdjson);
  check(
    "NDJSON ingestion processes valid events and records dead letters without failure",
    ndjsonStats.processed === 2 &&
      ndjsonStats.deadLetters === 1 &&
      consumer.getDeadLetters().length >= 1
  );

  // Check 14: SystemHealthEvaluator produces comprehensive report
  const evaluator = new SystemHealthEvaluator(pipeline);
  const healthReport = evaluator.evaluateHealth();
  check(
    "SystemHealthEvaluator produces schema-valid report with all components tracked",
    (healthReport.status === "DEGRADED" || healthReport.status === "HEALTHY") &&
      healthReport.components.length === 6 &&
      healthReport.summary.total_components === 6
  );

  // Check 15: Clean evaluator produces HEALTHY status with 0 dead letters
  const cleanPipe = new EndToEndIntegrationPipeline();
  const cleanEvaluator = new SystemHealthEvaluator(cleanPipe);
  const cleanReport = cleanEvaluator.evaluateHealth();
  check(
    "Clean pipeline evaluator reports overall HEALTHY status with zero warnings",
    cleanReport.status === "HEALTHY" &&
      cleanReport.summary.healthy_count === 6 &&
      cleanReport.summary.degraded_count === 0 &&
      cleanReport.summary.unhealthy_count === 0
  );

  console.log("\n=== FPF Slice R4 E2E Test Suite Results ===");
  console.log(`Total checks: ${passed + failed}`);
  console.log(`Passed:       ${passed}`);
  console.log(`Failed:       ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
  console.log("\nALL 15 END-TO-END INTEGRATION CHECKS PASSED!\n");
}

runE2ETests().catch((err) => {
  console.error("Unexpected error in E2E tests:", String(err && err.stack ? err.stack : err));
  process.exit(1);
});
