import {
  type PublicOutletDelivery,
  type OutletChannel,
  type PayloadFormat,
  type DeliveryStatus,
  type TombstoneDetails,
  PublicOutletDeliverySchema,
} from '../contracts/outlets.js';
import { type PublicationSnapshot } from '../contracts/fact-revision.js';

export interface ProjectOutletOptions {
  channel: OutletChannel;
  baseUrl?: string;
  isSuperseded?: boolean;
}

export interface RevokeTombstoneOptions {
  channel: OutletChannel;
  publication_id: string;
  snapshot_revision_id: string;
  entity_id: string;
  snapshot_digest_sha256: string;
  revocation_notice: string;
  revoked_at?: string;
  http_status_code?: 410 | 404;
  baseUrl?: string;
}

const CHANNEL_PAYLOAD_MAP: Record<OutletChannel, PayloadFormat> = {
  PUBLIC_HTML_ARCHIVE: 'HTML',
  REST_API_V1: 'JSON',
  JSON_LD_CARD: 'JSON_LD',
  FEED_ATOM_V1: 'XML_ATOM',
  XML_SITEMAP: 'XML_SITEMAP',
  CHANGES_STREAM_NDJSON: 'NDJSON',
  LLM_MCP_ENDPOINT: 'JSON',
};

export class OutletDeliveryProjector {
  private readonly defaultBaseUrl: string;

  constructor(options?: { defaultBaseUrl?: string }) {
    this.defaultBaseUrl = options?.defaultBaseUrl ?? 'https://facts.wenzhou.gov.cn';
  }

  /**
   * Projects a verified PublicationSnapshot to an active PublicOutletDelivery record.
   */
  public projectSnapshot(
    snapshot: PublicationSnapshot,
    options: ProjectOutletOptions
  ): PublicOutletDelivery {
    const { channel, isSuperseded = false } = options;
    const baseUrl = options.baseUrl ?? this.defaultBaseUrl;
    const format = CHANNEL_PAYLOAD_MAP[channel];
    const canonicalUrl = `${baseUrl}/entities/${snapshot.entity_id}`;

    const deliveryStatus: DeliveryStatus = isSuperseded
      ? 'SUPERSEDED_HISTORICAL'
      : 'ACTIVE_CURRENT';

    const maxAge = isSuperseded ? 86400 * 30 : 3600;
    const cachePolicy = isSuperseded ? 'PUBLIC_IMMUTABLE' : 'PUBLIC_REVALIDATE';

    const delivery: PublicOutletDelivery = {
      outlet_channel: channel,
      publication_id: snapshot.publication_id,
      snapshot_revision_id: snapshot.snapshot_revision_id,
      entity_id: snapshot.entity_id,
      canonical_url: canonicalUrl,
      published_at: snapshot.generated_at,
      snapshot_digest_sha256: snapshot.snapshot_digest_sha256,
      payload_format: format,
      delivery_status: deliveryStatus,
      cache_control: {
        cache_policy: cachePolicy,
        max_age_seconds: maxAge,
      },
    };

    return PublicOutletDeliverySchema.parse(delivery);
  }

  /**
   * Generates a Tombstone PublicOutletDelivery record for a revoked fact entity.
   */
  public projectTombstone(options: RevokeTombstoneOptions): PublicOutletDelivery {
    const {
      channel,
      publication_id,
      snapshot_revision_id,
      entity_id,
      snapshot_digest_sha256,
      revocation_notice,
      revoked_at = new Date().toISOString(),
      http_status_code = 410,
    } = options;
    const baseUrl = options.baseUrl ?? this.defaultBaseUrl;
    const format = CHANNEL_PAYLOAD_MAP[channel];
    const canonicalUrl = `${baseUrl}/entities/${entity_id}`;

    const tombstone: TombstoneDetails = {
      revoked_at,
      revocation_notice,
      http_status_code,
    };

    const delivery: PublicOutletDelivery = {
      outlet_channel: channel,
      publication_id,
      snapshot_revision_id,
      entity_id,
      canonical_url: canonicalUrl,
      published_at: revoked_at,
      snapshot_digest_sha256,
      payload_format: format,
      delivery_status: 'REVOKED_TOMBSTONE',
      tombstone_details: tombstone,
      cache_control: {
        cache_policy: 'NO_STORE',
        max_age_seconds: 0,
      },
    };

    return PublicOutletDeliverySchema.parse(delivery);
  }

  /**
   * Renders the canonical representation for a given delivery format.
   */
  public renderPayload(
    snapshot: PublicationSnapshot,
    channel: OutletChannel
  ): string {
    switch (channel) {
      case 'REST_API_V1':
      case 'LLM_MCP_ENDPOINT':
        return JSON.stringify(snapshot, null, 2);

      case 'PUBLIC_HTML_ARCHIVE':
        return (
          '<!DOCTYPE html>\n<html>\n<head>\n' +
          '<title>Official City Fact Record - ' +
          snapshot.entity_id +
          '</title>\n' +
          '<meta name="fact-snapshot-digest" content="' +
          snapshot.snapshot_digest_sha256 +
          '">\n' +
          '</head>\n<body>\n' +
          '<h1>Entity Fact Record: ' +
          snapshot.entity_id +
          '</h1>\n' +
          '<p>Snapshot Revision: ' +
          snapshot.snapshot_revision_id +
          '</p>\n' +
          '<ul>\n' +
          snapshot.published_assertions
            .map(
              (a) =>
                '<li><strong>' +
                a.property_path +
                '</strong>: ' +
                JSON.stringify(a.raw_value) +
                ' (Rev: ' +
                a.revision_id +
                ')</li>'
            )
            .join('\n') +
          '\n</ul>\n</body>\n</html>'
        );

      case 'JSON_LD_CARD':
        return JSON.stringify(
          {
            '@context': 'https://schema.org',
            '@type': 'City',
            '@id': `urn:entity:${snapshot.entity_id}`,
            identifier: snapshot.entity_id,
            subjectOf: {
              '@type': 'Dataset',
              name: 'Authoritative City Fact Assertions',
              version: snapshot.snapshot_revision_id,
              sha256: snapshot.snapshot_digest_sha256,
              variableMeasured: snapshot.published_assertions.map((a) => a.property_path),
            },
          },
          null,
          2
        );

      case 'FEED_ATOM_V1':
        return (
          '<?xml version="1.0" encoding="utf-8"?>\n' +
          '<entry xmlns="http://www.w3.org/2005/Atom">\n' +
          '  <id>urn:pubrev:' +
          snapshot.snapshot_revision_id +
          '</id>\n' +
          '  <title>Fact Update: ' +
          snapshot.entity_id +
          '</title>\n' +
          '  <updated>' +
          snapshot.generated_at +
          '</updated>\n' +
          '  <summary>' +
          snapshot.published_assertions.length +
          ' verified assertions.</summary>\n' +
          '</entry>'
        );

      case 'XML_SITEMAP':
        return (
          '<url>\n' +
          '  <loc>' +
          this.defaultBaseUrl +
          '/entities/' +
          snapshot.entity_id +
          '</loc>\n' +
          '  <lastmod>' +
          snapshot.generated_at.split('T')[0] +
          '</lastmod>\n' +
          '  <changefreq>daily</changefreq>\n' +
          '</url>'
        );

      case 'CHANGES_STREAM_NDJSON':
        return JSON.stringify({
          entity_id: snapshot.entity_id,
          snapshot_revision_id: snapshot.snapshot_revision_id,
          digest: snapshot.snapshot_digest_sha256,
          timestamp: snapshot.generated_at,
        });
    }
  }
}
