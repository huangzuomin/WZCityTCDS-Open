import { z } from 'zod';

export const OutletChannelSchema = z.enum([
  'PUBLIC_HTML_ARCHIVE',
  'REST_API_V1',
  'JSON_LD_CARD',
  'FEED_ATOM_V1',
  'XML_SITEMAP',
  'CHANGES_STREAM_NDJSON',
  'LLM_MCP_ENDPOINT',
]);
export type OutletChannel = z.infer<typeof OutletChannelSchema>;

export const PayloadFormatSchema = z.enum([
  'HTML',
  'JSON',
  'JSON_LD',
  'XML_ATOM',
  'XML_SITEMAP',
  'NDJSON',
]);
export type PayloadFormat = z.infer<typeof PayloadFormatSchema>;

export const DeliveryStatusSchema = z.enum([
  'ACTIVE_CURRENT',
  'SUPERSEDED_HISTORICAL',
  'REVOKED_TOMBSTONE',
]);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

export const TombstoneDetailsSchema = z
  .object({
    revoked_at: z.string().datetime({ offset: true }).optional(),
    revocation_notice: z.string().max(1024).optional(),
    http_status_code: z.union([z.literal(410), z.literal(404)]).optional(),
  })
  .strict();
export type TombstoneDetails = z.infer<typeof TombstoneDetailsSchema>;

export const CacheControlPolicySchema = z
  .object({
    cache_policy: z.enum(['PUBLIC_IMMUTABLE', 'PUBLIC_REVALIDATE', 'NO_STORE']),
    max_age_seconds: z.number().int().min(0),
  })
  .strict();
export type CacheControlPolicy = z.infer<typeof CacheControlPolicySchema>;

export const PublicOutletDeliverySchema = z
  .object({
    outlet_channel: OutletChannelSchema,
    publication_id: z.string().regex(/^pub_[a-zA-Z0-9_-]{12,64}$/),
    snapshot_revision_id: z.string().regex(/^pubrev_[a-zA-Z0-9_-]{12,64}$/),
    entity_id: z.string().regex(/^ent_[a-z0-9_-]{8,64}$/),
    canonical_url: z.string().url().optional(),
    published_at: z.string().datetime({ offset: true }),
    snapshot_digest_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    payload_format: PayloadFormatSchema,
    delivery_status: DeliveryStatusSchema,
    tombstone_details: TombstoneDetailsSchema.optional(),
    cache_control: CacheControlPolicySchema.optional(),
  })
  .strict();
export type PublicOutletDelivery = z.infer<typeof PublicOutletDeliverySchema>;

export const GateVerdictSchema = z.enum([
  'PASS_APPROVED_FOR_RELEASE',
  'FAIL_CLOSED_BLOCKED',
]);
export type GateVerdict = z.infer<typeof GateVerdictSchema>;

export const RuleEvaluationsSchema = z
  .object({
    rule_only_published_state: z
      .object({
        passed: z.boolean(),
        non_published_count: z.number().int().min(0),
      })
      .strict(),
    rule_evidence_receipt_pass: z
      .object({
        passed: z.boolean(),
        unverified_assertion_count: z.number().int().min(0),
      })
      .strict(),
    rule_no_private_ip_leaks: z
      .object({
        passed: z.boolean(),
        detected_matches: z.array(z.string()),
      })
      .strict(),
    rule_no_credential_patterns: z
      .object({
        passed: z.boolean(),
        suspicious_token_count: z.number().int().min(0),
      })
      .strict(),
    rule_source_validity_confirmed: z
      .object({
        passed: z.boolean(),
        retracted_source_count: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();
export type RuleEvaluations = z.infer<typeof RuleEvaluationsSchema>;

export const GateControllerSchema = z
  .object({
    controller_role: z.enum([
      'FPF_PUBLICATION_SECURITY_GATE',
      'SECURITY_OFFICER',
    ]),
    signature_hash: z.string().regex(/^[a-fA-F0-9]{64}$/),
  })
  .strict();
export type GateController = z.infer<typeof GateControllerSchema>;

export const PublicationSecurityGatePolicySchema = z
  .object({
    gate_evaluation_id: z.string().regex(/^gate_[a-zA-Z0-9_-]{12,64}$/),
    snapshot_revision_id: z.string().regex(/^pubrev_[a-zA-Z0-9_-]{12,64}$/),
    evaluated_at: z.string().datetime({ offset: true }),
    gate_verdict: GateVerdictSchema,
    rule_evaluations: RuleEvaluationsSchema,
    gate_controller: GateControllerSchema.optional(),
  })
  .strict();
export type PublicationSecurityGatePolicy = z.infer<typeof PublicationSecurityGatePolicySchema>;

export const StreamChangeTypeSchema = z.enum([
  'FACT_PUBLISHED',
  'FACT_CORRECTED',
  'FACT_REVOKED',
  'SNAPSHOT_SEALED',
]);
export type StreamChangeType = z.infer<typeof StreamChangeTypeSchema>;

export const AffectedRevisionSchema = z
  .object({
    revision_id: z.string(),
    property_path: z.string(),
    lifecycle_state: z.enum(['PUBLISHED', 'SUPERSEDED', 'REVOKED']),
    previous_revision_id: z.string().optional(),
    publication_snapshot_id: z.string().optional(),
  })
  .strict();
export type AffectedRevision = z.infer<typeof AffectedRevisionSchema>;

export const ChangesStreamEventSchema = z
  .object({
    change_event_id: z.string().regex(/^chg_[a-zA-Z0-9_-]{12,64}$/),
    change_sequence_num: z.number().int().min(1),
    change_type: StreamChangeTypeSchema,
    entity_id: z.string().regex(/^ent_[a-z0-9_-]{8,64}$/),
    event_timestamp: z.string().datetime({ offset: true }),
    event_digest_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    affected_revision: AffectedRevisionSchema,
  })
  .strict();
export type ChangesStreamEvent = z.infer<typeof ChangesStreamEventSchema>;
