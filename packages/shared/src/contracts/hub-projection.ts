import { z } from 'zod';
import { EntityCategorySchema } from './entity-lookup.js';

export const HubProjectionTargetSchema = z.enum([
  'URBAN_SPATIAL_HUB',
  'HUB_FACT_LAKE',
  'HUB_SEARCH_INDEX',
]);
export type HubProjectionTarget = z.infer<typeof HubProjectionTargetSchema>;

export const ProjectedAssertionItemSchema = z
  .object({
    property_path: z.string().min(1).max(256),
    raw_value: z.unknown(),
    revision_id: z.string().min(1),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type ProjectedAssertionItem = z.infer<typeof ProjectedAssertionItemSchema>;

export const SpatialAnchorSchema = z
  .object({
    longitude: z.number().min(-180).max(180),
    latitude: z.number().min(-90).max(90),
    region_code: z.string().optional(),
    address: z.string().optional(),
  })
  .strict();
export type SpatialAnchor = z.infer<typeof SpatialAnchorSchema>;

export const HubProjectionPayloadSchema = z
  .object({
    projection_id: z.string().regex(/^prj_[a-zA-Z0-9_-]{12,64}$/),
    snapshot_revision_id: z.string().regex(/^pubrev_[a-zA-Z0-9_-]{12,64}$/),
    entity_id: z.string().regex(/^ent_[a-z0-9_-]{8,64}$/),
    target: HubProjectionTargetSchema,
    projected_at: z.string().datetime({ offset: true }),
    snapshot_digest_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    assertions: z.array(ProjectedAssertionItemSchema).min(1),
    spatial_anchor: SpatialAnchorSchema.optional(),
    validity_window: z
      .object({
        valid_from: z.string().datetime({ offset: true }),
        valid_to: z.string().datetime({ offset: true }).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type HubProjectionPayload = z.infer<typeof HubProjectionPayloadSchema>;

export const HubProjectionReceiptStatusSchema = z.enum([
  'ACCEPTED',
  'REJECTED',
  'QUEUED',
]);
export type HubProjectionReceiptStatus = z.infer<typeof HubProjectionReceiptStatusSchema>;

export const HubProjectionReceiptSchema = z
  .object({
    receipt_id: z.string().regex(/^rcpt_[a-zA-Z0-9_-]{12,64}$/),
    projection_id: z.string().regex(/^prj_[a-zA-Z0-9_-]{12,64}$/),
    status: HubProjectionReceiptStatusSchema,
    hub_slot_id: z.string().optional(),
    acknowledged_at: z.string().datetime({ offset: true }),
    rejection_reason: z.string().max(1024).optional(),
    receipt_signature_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  })
  .strict();
export type HubProjectionReceipt = z.infer<typeof HubProjectionReceiptSchema>;

export const HubUpstreamChangeTypeSchema = z.enum([
  'ENTITY_CREATED',
  'ENTITY_UPDATED',
  'ALIAS_ADDED',
  'MERGED_INTO',
  'TOMBSTONED',
]);
export type HubUpstreamChangeType = z.infer<typeof HubUpstreamChangeTypeSchema>;

export const HubUpstreamChangeEventSchema = z
  .object({
    hub_change_event_id: z.string().regex(/^hchg_[a-zA-Z0-9_-]{12,64}$/),
    hub_sequence_num: z.number().int().min(1),
    change_type: HubUpstreamChangeTypeSchema,
    entity_id: z.string().regex(/^ent_[a-z0-9_-]{8,64}$/),
    canonical_name: z.string().min(1).max(256),
    aliases: z.array(z.string()).default([]),
    category: EntityCategorySchema,
    spatial_coordinates: z
      .object({
        longitude: z.number().min(-180).max(180),
        latitude: z.number().min(-90).max(90),
      })
      .strict()
      .optional(),
    target_merged_entity_id: z
      .string()
      .regex(/^ent_[a-z0-9_-]{8,64}$/)
      .optional(),
    tombstone_reason: z.string().max(512).optional(),
    timestamp: z.string().datetime({ offset: true }),
    digest_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  })
  .strict();
export type HubUpstreamChangeEvent = z.infer<typeof HubUpstreamChangeEventSchema>;
