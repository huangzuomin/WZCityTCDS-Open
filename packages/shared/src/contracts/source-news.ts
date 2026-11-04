import { z } from 'zod';

export const SourceNewsEventTypeSchema = z.enum([
  'NEWS_PUBLISHED',
  'NEWS_UPDATED',
  'NEWS_RETRACTED',
]);
export type SourceNewsEventType = z.infer<typeof SourceNewsEventTypeSchema>;

export const CmsOriginSchema = z
  .object({
    publisher_name: z.string().min(1).max(128),
    channel_id: z.string().min(1).max(64),
    author: z.string().max(128).optional(),
    editor: z.string().max(128).optional(),
  })
  .strict();
export type CmsOrigin = z.infer<typeof CmsOriginSchema>;

export const NewsParagraphSchema = z
  .object({
    paragraph_index: z.number().int().min(0),
    char_start: z.number().int().min(0).optional(),
    char_end: z.number().int().min(0).optional(),
    text: z.string(),
    paragraph_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  })
  .strict();
export type NewsParagraph = z.infer<typeof NewsParagraphSchema>;

export const NewsPayloadSchema = z
  .object({
    title: z.string().min(1).max(512),
    url: z.string().url().optional(),
    publish_time: z.string().datetime({ offset: true }),
    content_text: z.string().min(1),
    content_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    paragraphs: z.array(NewsParagraphSchema),
    copyright_notice: z.string().optional(),
  })
  .strict();
export type NewsPayload = z.infer<typeof NewsPayloadSchema>;

export const NewsRetractionPayloadSchema = z
  .object({
    retraction_time: z.string().datetime({ offset: true }),
    retraction_reason: z.string().min(1).max(1024),
    replaced_by_doc_id: z.string().max(128).optional(),
  })
  .strict();
export type NewsRetractionPayload = z.infer<typeof NewsRetractionPayloadSchema>;

export const SourceNewsEventSchema = z
  .object({
    event_id: z.string().regex(/^evt_[a-zA-Z0-9_-]{12,64}$/),
    event_type: SourceNewsEventTypeSchema,
    event_time: z.string().datetime({ offset: true }),
    source_doc_id: z.string().min(1).max(128),
    cms_origin: CmsOriginSchema,
    news_payload: NewsPayloadSchema.optional(),
    retraction_payload: NewsRetractionPayloadSchema.optional(),
  })
  .strict();
export type SourceNewsEvent = z.infer<typeof SourceNewsEventSchema>;
