import { z } from 'zod';

export const EvidenceSpanQualityStateSchema = z.enum([
  'VALIDATED',
  'PENDING_VERIFICATION',
  'STALE_SOURCE_RETRACTED',
  'TAMPERED_HASH_MISMATCH',
]);
export type EvidenceSpanQualityState = z.infer<typeof EvidenceSpanQualityStateSchema>;

export const ExtractorMetadataSchema = z
  .object({
    engine_version: z.string().optional(),
    confidence_score: z.number().min(0.0).max(1.0).optional(),
    model_fingerprint: z.string().optional(),
    prompt_template_id: z.string().optional(),
  })
  .strict();
export type ExtractorMetadata = z.infer<typeof ExtractorMetadataSchema>;

export const EvidenceSpanSchema = z
  .object({
    span_id: z.string().regex(/^span_[a-zA-Z0-9_-]{12,64}$/),
    source_doc_id: z.string().min(1).max(128),
    source_url: z.string().url().optional(),
    paragraph_index: z.number().int().min(0),
    char_start: z.number().int().min(0),
    char_end: z.number().int().min(1),
    quoted_text: z.string().min(1).max(8192),
    span_hash: z.string().regex(/^[a-fA-F0-9]{64}$/),
    extracted_at: z.string().datetime({ offset: true }),
    extractor_metadata: ExtractorMetadataSchema.optional(),
    quality_state: EvidenceSpanQualityStateSchema,
  })
  .strict();
export type EvidenceSpan = z.infer<typeof EvidenceSpanSchema>;

export const SpanVerificationItemSchema = z
  .object({
    span_id: z.string(),
    span_hash_matched: z.boolean(),
    source_doc_verified: z.boolean(),
    paragraph_exact_match: z.boolean(),
    check_status: z.enum([
      'PASS',
      'FAIL_HASH_MISMATCH',
      'FAIL_SOURCE_NOT_FOUND',
      'FAIL_TEXT_NOT_FOUND',
    ]),
    computed_hash: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  })
  .strict();
export type SpanVerificationItem = z.infer<typeof SpanVerificationItemSchema>;

export const OverallVerificationVerdictSchema = z.enum([
  'PASS',
  'FAIL_HASH_MISMATCH',
  'FAIL_SOURCE_RETRACTED',
  'FAIL_TEXT_NOT_FOUND',
  'FAIL_INSUFFICIENT_EVIDENCE',
]);
export type OverallVerificationVerdict = z.infer<typeof OverallVerificationVerdictSchema>;

export const AuditorSignatureSchema = z
  .object({
    signature_type: z.enum(['ENGINE_HMAC', 'SIGSTORE_OIDC', 'SYSTEM_KEY']),
    signer_identity: z.string(),
    digest_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  })
  .strict();
export type AuditorSignature = z.infer<typeof AuditorSignatureSchema>;

export const EvidenceVerificationReceiptSchema = z
  .object({
    receipt_id: z.string().regex(/^rcpt_[a-zA-Z0-9_-]{12,64}$/),
    assertion_id: z.string().regex(/^ast_[a-zA-Z0-9_-]{12,64}$/),
    revision_id: z.string().regex(/^rev_[a-zA-Z0-9_-]{12,64}$/),
    verified_at: z.string().datetime({ offset: true }),
    verifier_engine_version: z.string().min(1).max(64),
    span_verifications: z.array(SpanVerificationItemSchema).min(1),
    overall_verification_verdict: OverallVerificationVerdictSchema,
    auditor_signature: AuditorSignatureSchema,
  })
  .strict();
export type EvidenceVerificationReceipt = z.infer<typeof EvidenceVerificationReceiptSchema>;

export const SourceAuthorityLevelSchema = z.enum([
  'OFFICIAL_GOVERNMENT_RELEASE',
  'STATE_MEDIA_PRIMARY',
  'LOCAL_MEDIA_REPORT',
  'COMMERCIAL_PORTAL',
]);
export type SourceAuthorityLevel = z.infer<typeof SourceAuthorityLevelSchema>;

export const ConflictingSpanItemSchema = z
  .object({
    span_id: z.string(),
    source_doc_id: z.string(),
    reported_value: z.any(),
    source_authority_level: SourceAuthorityLevelSchema,
  })
  .strict();
export type ConflictingSpanItem = z.infer<typeof ConflictingSpanItemSchema>;

export const ConflictTypeSchema = z.enum([
  'NUMERICAL_DISCREPANCY',
  'TEMPORAL_SCOPE_MISMATCH',
  'STATUS_CONTRADICTION',
  'GEOGRAPHIC_BOUNDARY_DIVERGENCE',
]);
export type ConflictType = z.infer<typeof ConflictTypeSchema>;

export const ArbitrationStatusSchema = z.enum([
  'PENDING_ARBITRATION',
  'RESOLVED_ADOPTED',
  'RECONCILED_AS_RANGE',
  'REJECTED_UNRESOLVABLE',
]);
export type ArbitrationStatus = z.infer<typeof ArbitrationStatusSchema>;

export const ArbitrationDecisionSchema = z.enum([
  'ADOPT_HIGHER_AUTHORITY',
  'ADOPT_LATEST_TIMESTAMPS',
  'PUBLISH_AS_ESTIMATED_RANGE',
  'SUSPEND_PENDING_OFFICIAL_CLARIFICATION',
]);
export type ArbitrationDecision = z.infer<typeof ArbitrationDecisionSchema>;

export const ArbitrationAdjudicationSchema = z
  .object({
    adjudicated_at: z.string().datetime({ offset: true }).optional(),
    arbitrator_id: z.string().optional(),
    chosen_decision: ArbitrationDecisionSchema.optional(),
    adopted_span_id: z.string().optional(),
    arbitration_rationale: z.string().min(10).max(2048).optional(),
  })
  .strict();
export type ArbitrationAdjudication = z.infer<typeof ArbitrationAdjudicationSchema>;

export const EvidenceConflictArbitrationSchema = z
  .object({
    arbitration_id: z.string().regex(/^arb_[a-zA-Z0-9_-]{12,64}$/),
    assertion_id: z.string().regex(/^ast_[a-zA-Z0-9_-]{12,64}$/),
    conflicting_spans: z.array(ConflictingSpanItemSchema).min(2),
    conflict_type: ConflictTypeSchema,
    arbitration_status: ArbitrationStatusSchema,
    created_at: z.string().datetime({ offset: true }),
    adjudication: ArbitrationAdjudicationSchema.optional(),
  })
  .strict();
export type EvidenceConflictArbitration = z.infer<typeof EvidenceConflictArbitrationSchema>;
