import { z } from 'zod';

export const EntityCategorySchema = z.enum([
  'POI',
  'ADMIN_DIVISION',
  'ORGANIZATION',
  'PERSON',
  'EVENT',
  'GEO_FEATURE',
  'NATURAL_RESOURCE',
]);
export type EntityCategory = z.infer<typeof EntityCategorySchema>;

export const SpatialFilterSchema = z
  .object({
    region_code: z.string().regex(/^[0-9]{6}$/).optional(),
    bounding_box: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  })
  .strict();
export type SpatialFilter = z.infer<typeof SpatialFilterSchema>;

export const EntityLookupRequestSchema = z
  .object({
    query_text: z.string().min(1).max(256),
    context_snippet: z.string().max(2048).optional(),
    expected_categories: z.array(EntityCategorySchema).optional(),
    spatial_filter: SpatialFilterSchema.optional(),
    max_candidates: z.number().int().min(1).max(50).default(5),
  })
  .strict();
export type EntityLookupRequest = z.infer<typeof EntityLookupRequestSchema>;
export type EntityLookupRequestInput = z.input<typeof EntityLookupRequestSchema>;

export const SpatialCoordinatesSchema = z
  .object({
    longitude: z.number().min(-180.0).max(180.0),
    latitude: z.number().min(-90.0).max(90.0),
  })
  .strict();
export type SpatialCoordinates = z.infer<typeof SpatialCoordinatesSchema>;

export const MatchedEntitySchema = z
  .object({
    entity_id: z.string().regex(/^ent_[a-z0-9_-]{8,64}$/),
    canonical_name: z.string().min(1).max(256),
    aliases: z.array(z.string()).optional(),
    category: EntityCategorySchema,
    confidence: z.number().min(0.0).max(1.0),
    hub_uri: z.string().url().optional(),
    spatial_coordinates: SpatialCoordinatesSchema.optional(),
  })
  .strict();
export type MatchedEntity = z.infer<typeof MatchedEntitySchema>;

export const EntityResolutionStatusSchema = z.enum([
  'EXACT_MATCH',
  'MULTIPLE_MATCHES',
  'UNRESOLVED_NOT_FOUND',
]);
export type EntityResolutionStatus = z.infer<typeof EntityResolutionStatusSchema>;

export const EntityLookupResponseSchema = z
  .object({
    resolution_status: EntityResolutionStatusSchema,
    selected_entity_id: z.string().regex(/^ent_[a-z0-9_-]{8,64}$/).optional(),
    matches: z.array(MatchedEntitySchema),
  })
  .strict();
export type EntityLookupResponse = z.infer<typeof EntityLookupResponseSchema>;

export const EntityLookupMessageSchema = z
  .object({
    protocol_version: z.enum(['1.0', '1.0.0']),
    message_id: z.string().regex(/^msg_[a-zA-Z0-9_-]{12,64}$/),
    timestamp: z.string().datetime({ offset: true }),
    message_type: z.enum(['LOOKUP_REQUEST', 'LOOKUP_RESPONSE']),
    request: EntityLookupRequestSchema.optional(),
    response: EntityLookupResponseSchema.optional(),
  })
  .strict();
export type EntityLookupMessage = z.infer<typeof EntityLookupMessageSchema>;

export const ProposalSourceEvidenceSchema = z
  .object({
    source_doc_id: z.string().min(1).max(128),
    context_snippet: z.string().min(1).max(4096),
    evidence_span_hash: z.string().regex(/^[a-fA-F0-9]{64}$/),
  })
  .strict();
export type ProposalSourceEvidence = z.infer<typeof ProposalSourceEvidenceSchema>;

export const ProposalStatusSchema = z.enum([
  'SUBMITTED',
  'IN_HUB_REVIEW',
  'ACCEPTED_ALLOCATED',
  'MERGED_AS_ALIAS',
  'REJECTED',
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const HubAdjudicationSchema = z
  .object({
    adjudicated_at: z.string().datetime({ offset: true }).optional(),
    allocated_entity_id: z.string().regex(/^ent_[a-z0-9_-]{8,64}$/).optional(),
    canonical_name: z.string().optional(),
    resolution_notes: z.string().optional(),
  })
  .strict();
export type HubAdjudication = z.infer<typeof HubAdjudicationSchema>;

export const UnresolvedEntityProposalSchema = z
  .object({
    proposal_id: z.string().regex(/^prop_[a-zA-Z0-9_-]{12,64}$/),
    proposer_system: z.enum(['WZCityTCDS', 'WZCityTCDS-ExtractionEngine']),
    submitted_at: z.string().datetime({ offset: true }),
    candidate_name: z.string().min(1).max(256),
    suggested_aliases: z.array(z.string()).optional(),
    suggested_category: EntityCategorySchema.optional(),
    source_evidence: ProposalSourceEvidenceSchema,
    proposal_status: ProposalStatusSchema,
    hub_adjudication: HubAdjudicationSchema.optional(),
  })
  .strict();
export type UnresolvedEntityProposal = z.infer<typeof UnresolvedEntityProposalSchema>;
