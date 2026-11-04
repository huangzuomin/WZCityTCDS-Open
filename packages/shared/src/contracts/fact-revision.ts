import { z } from 'zod';

export const FactLifecycleStateSchema = z.enum([
  'DRAFT',
  'PENDING_REVIEW',
  'PUBLISHED',
  'SUPERSEDED',
  'REVOKED',
]);
export type FactLifecycleState = z.infer<typeof FactLifecycleStateSchema>;

export const FactDataTypeSchema = z.enum([
  'STRING',
  'NUMBER',
  'BOOLEAN',
  'QUANTITY',
  'TEMPORAL_RANGE',
  'GEO_SHAPE',
]);
export type FactDataType = z.infer<typeof FactDataTypeSchema>;

export const TemporalValiditySchema = z
  .object({
    valid_from: z.string().datetime({ offset: true }).optional(),
    valid_to: z.string().datetime({ offset: true }).optional(),
    statistical_period: z.string().max(64).optional(),
  })
  .strict();
export type TemporalValidity = z.infer<typeof TemporalValiditySchema>;

export const SpatialScopeSchema = z
  .object({
    region_code: z.string().regex(/^[0-9]{6}$/).optional(),
    region_name: z.string().optional(),
  })
  .strict();
export type SpatialScope = z.infer<typeof SpatialScopeSchema>;

export const AssertionValueSchema = z
  .object({
    raw_value: z.any(),
    data_type: FactDataTypeSchema,
    unit: z.string().max(32).optional(),
    temporal_validity: TemporalValiditySchema.optional(),
    spatial_scope: SpatialScopeSchema.optional(),
  })
  .strict();
export type AssertionValue = z.infer<typeof AssertionValueSchema>;

export const RevisionRoleSchema = z.enum([
  'FACT_EXTRACTOR',
  'FACT_REVIEWER',
  'FACT_ARBITRATOR',
  'SYSTEM_MIGRATION',
]);
export type RevisionRole = z.infer<typeof RevisionRoleSchema>;

export const RevisionReasonSchema = z.enum([
  'INITIAL_PUBLISH',
  'STATISTICAL_UPDATE',
  'ERRATUM_CORRECTION',
  'SOURCE_EXPANSION',
  'SOURCE_RETRACTION_ADJUSTMENT',
]);
export type RevisionReason = z.infer<typeof RevisionReasonSchema>;

export const RevisionMetadataSchema = z
  .object({
    parent_revision_sha256: z.string().regex(/^([a-fA-F0-9]{64}|GENESIS)$/),
    created_at: z.string().datetime({ offset: true }),
    created_by_role: RevisionRoleSchema,
    author_id: z.string().min(1).max(64).optional(),
    revision_reason: RevisionReasonSchema,
    reason_description: z.string().max(1024).optional(),
    evidence_span_hashes: z.array(z.string().regex(/^[a-fA-F0-9]{64}$/)).min(1),
  })
  .strict();
export type RevisionMetadata = z.infer<typeof RevisionMetadataSchema>;

export const FactRevisionLifecycleSchema = z
  .object({
    assertion_id: z.string().regex(/^ast_[a-zA-Z0-9_-]{12,64}$/),
    revision_id: z.string().regex(/^rev_[a-zA-Z0-9_-]{12,64}$/),
    revision_number: z.number().int().min(1).optional(),
    entity_id: z.string().regex(/^ent_[a-z0-9_-]{8,64}$/),
    property_path: z.string().min(1).max(128),
    assertion_value: AssertionValueSchema,
    lifecycle_state: FactLifecycleStateSchema,
    revision_metadata: RevisionMetadataSchema,
  })
  .strict();
export type FactRevisionLifecycle = z.infer<typeof FactRevisionLifecycleSchema>;

export const PublishedAssertionItemSchema = z
  .object({
    assertion_id: z.string(),
    revision_id: z.string(),
    property_path: z.string(),
    raw_value: z.any(),
    unit: z.string().optional(),
    evidence_hashes: z.array(z.string().regex(/^[a-fA-F0-9]{64}$/)).min(1),
  })
  .strict();
export type PublishedAssertionItem = z.infer<typeof PublishedAssertionItemSchema>;

export const OutletScopeSchema = z.enum([
  'HUB_ONE_WAY_PROJECTION',
  'PUBLIC_HTML_ARCHIVE',
  'REST_API',
  'FEED_ATOM',
  'MCP_ENDPOINT',
]);
export type OutletScope = z.infer<typeof OutletScopeSchema>;

export const ProjectionMetadataSchema = z
  .object({
    kernel_system: z.literal('WZCityTCDS-PublicationKernel'),
    publisher_role: z.enum(['CHIEF_FACT_EDITOR', 'AUTOMATED_RELEASE_BOT']),
    outlet_scopes: z.array(OutletScopeSchema).min(1),
    is_latest_snapshot: z.boolean(),
  })
  .strict();
export type ProjectionMetadata = z.infer<typeof ProjectionMetadataSchema>;

export const PublicationSnapshotSchema = z
  .object({
    publication_id: z.string().regex(/^pub_[a-zA-Z0-9_-]{12,64}$/),
    snapshot_revision_id: z.string().regex(/^pubrev_[a-zA-Z0-9_-]{12,64}$/),
    entity_id: z.string().regex(/^ent_[a-z0-9_-]{8,64}$/),
    entity_canonical_name: z.string().min(1).max(256).optional(),
    generated_at: z.string().datetime({ offset: true }),
    snapshot_digest_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    published_assertions: z.array(PublishedAssertionItemSchema).min(1),
    projection_metadata: ProjectionMetadataSchema,
  })
  .strict();
export type PublicationSnapshot = z.infer<typeof PublicationSnapshotSchema>;

export const RevisionTransitionFromStateSchema = z.enum([
  'DRAFT',
  'PENDING_REVIEW',
  'PUBLISHED',
]);
export type RevisionTransitionFromState = z.infer<typeof RevisionTransitionFromStateSchema>;

export const RevisionTransitionToStateSchema = z.enum([
  'PENDING_REVIEW',
  'PUBLISHED',
  'SUPERSEDED',
  'REVOKED',
  'REJECTED',
]);
export type RevisionTransitionToState = z.infer<typeof RevisionTransitionToStateSchema>;

export const RevisionTransitionTriggerSchema = z.enum([
  'SUBMIT_FOR_REVIEW',
  'APPROVE_AND_PUBLISH',
  'SUPERSEDE_WITH_NEW_REVISION',
  'REVOKE_PUBLISHED_FACT',
  'REJECT_CANDIDATE',
]);
export type RevisionTransitionTrigger = z.infer<typeof RevisionTransitionTriggerSchema>;

export const RevisionTransitionRoleSchema = z.enum([
  'FACT_EXTRACTOR',
  'FACT_REVIEWER',
  'FACT_ARBITRATOR',
  'CHIEF_EDITOR',
]);
export type RevisionTransitionRole = z.infer<typeof RevisionTransitionRoleSchema>;

export const RevisionStateTransitionSchema = z
  .object({
    transition_id: z.string().regex(/^trans_[a-zA-Z0-9_-]{12,64}$/),
    assertion_id: z.string().regex(/^ast_[a-zA-Z0-9_-]{12,64}$/),
    revision_id: z.string().regex(/^rev_[a-zA-Z0-9_-]{12,64}$/),
    from_state: RevisionTransitionFromStateSchema,
    to_state: RevisionTransitionToStateSchema,
    transition_trigger: RevisionTransitionTriggerSchema,
    authorized_role: RevisionTransitionRoleSchema,
    operator_id: z.string().min(1).max(64).optional(),
    transition_timestamp: z.string().datetime({ offset: true }),
    superseded_by_revision_id: z.string().regex(/^rev_[a-zA-Z0-9_-]{12,64}$/).optional(),
    revocation_reason: z.string().min(5).max(1024).optional(),
  })
  .strict();
export type RevisionStateTransition = z.infer<typeof RevisionStateTransitionSchema>;
