import { randomBytes } from 'crypto';
import {
  EntityCategory,
  EntityLookupMessage,
  EntityLookupMessageSchema,
  EntityLookupRequest,
  EntityLookupRequestInput,
  EntityLookupRequestSchema,
  EntityLookupResponse,
  EntityLookupResponseSchema,
  HubAdjudication,
  HubAdjudicationSchema,
  MatchedEntity,
  MatchedEntitySchema,
  ProposalSourceEvidence,
  ProposalSourceEvidenceSchema,
  ProposalStatus,
  ProposalStatusSchema,
  UnresolvedEntityProposal,
  UnresolvedEntityProposalSchema,
  assertContract,
  validateContract,
} from '../contracts/index.js';

export const ENTITY_ID_REGEX = /^ent_[a-z0-9_-]{8,64}$/;
export const PROPOSAL_ID_REGEX = /^prop_[a-zA-Z0-9_-]{12,64}$/;
export const MESSAGE_ID_REGEX = /^msg_[a-zA-Z0-9_-]{12,64}$/;

/**
 * Asserts that an entity ID strictly adheres to the Urban Spatio-Temporal Trusted Content Hub single-root format.
 * Throws an error if the ID is invalid or represents a forbidden local pseudo-master ID.
 */
export function assertValidEntityId(entityId: string): void {
  if (!ENTITY_ID_REGEX.test(entityId)) {
    throw new Error(
      `Invalid Hub entity_id format: "${entityId}". Must match ^ent_[a-z0-9_-]{8,64}$ as mandated by S1/S2 single-root contracts.`
    );
  }
}

/**
 * Transport interface for communicating with the Urban Spatio-Temporal Trusted Content Hub EntityResolver.
 */
export interface IHubEntityTransport {
  lookup(message: EntityLookupMessage): Promise<EntityLookupMessage>;
  submitProposal(proposal: UnresolvedEntityProposal): Promise<UnresolvedEntityProposal>;
  fetchProposal(proposalId: string): Promise<UnresolvedEntityProposal | null>;
}

/**
 * In-memory Mock Transport with default Wenzhou seed entities for testing and offline/local execution.
 */
export class MockHubEntityTransport implements IHubEntityTransport {
  private readonly allEntities: MatchedEntity[] = [];
  private readonly proposals = new Map<string, UnresolvedEntityProposal>();

  constructor(seedDefaultEntities = true) {
    if (seedDefaultEntities) {
      this.seedDefaults();
    }
  }

  private seedDefaults(): void {
    const defaultSeeds: MatchedEntity[] = [
      {
        entity_id: 'ent_wz_lucheng_gov_001',
        canonical_name: '温州市鹿城区人民政府',
        aliases: ['鹿城区政府', '鹿城区人民政府'],
        category: 'ADMIN_DIVISION',
        confidence: 0.98,
        hub_uri: 'https://hub.wenzhou.gov.cn/entities/ent_wz_lucheng_gov_001',
        spatial_coordinates: { longitude: 120.655, latitude: 28.016 },
      },
      {
        entity_id: 'ent_wz_wuma_street_002',
        canonical_name: '五马历史文化街区',
        aliases: ['五马街', '禅街', '五马步行街'],
        category: 'POI',
        confidence: 0.95,
        hub_uri: 'https://hub.wenzhou.gov.cn/entities/ent_wz_wuma_street_002',
        spatial_coordinates: { longitude: 120.662, latitude: 28.021 },
      },
      {
        entity_id: 'ent_wz_sanyang_wetland_003',
        canonical_name: '三垟湿地公园',
        aliases: ['三垟湿地', '温州生态园', '温州三垟湿地'],
        category: 'GEO_FEATURE',
        confidence: 0.92,
        hub_uri: 'https://hub.wenzhou.gov.cn/entities/ent_wz_sanyang_wetland_003',
        spatial_coordinates: { longitude: 120.718, latitude: 27.973 },
      },
      {
        entity_id: 'ent_wz_nanxi_river_004',
        canonical_name: '楠溪江风景名胜区',
        aliases: ['楠溪江', '永嘉楠溪江'],
        category: 'NATURAL_RESOURCE',
        confidence: 0.94,
        hub_uri: 'https://hub.wenzhou.gov.cn/entities/ent_wz_nanxi_river_004',
        spatial_coordinates: { longitude: 120.732, latitude: 28.188 },
      },
      // Ambiguous seed entries for testing MULTIPLE_MATCHES
      {
        entity_id: 'ent_wz_first_hospital_005',
        canonical_name: '温州医科大学附属第一医院',
        aliases: ['温州第一人民医院', '温医一院', '温州人民医院'],
        category: 'ORGANIZATION',
        confidence: 0.82,
        hub_uri: 'https://hub.wenzhou.gov.cn/entities/ent_wz_first_hospital_005',
        spatial_coordinates: { longitude: 120.687, latitude: 27.943 },
      },
      {
        entity_id: 'ent_wz_central_hospital_006',
        canonical_name: '温州市中心医院',
        aliases: ['温州市第二人民医院', '市中心医院', '温州人民医院'],
        category: 'ORGANIZATION',
        confidence: 0.81,
        hub_uri: 'https://hub.wenzhou.gov.cn/entities/ent_wz_central_hospital_006',
        spatial_coordinates: { longitude: 120.648, latitude: 28.025 },
      },
    ];

    for (const ent of defaultSeeds) {
      this.registerEntity(ent);
    }
  }

  public registerEntity(entity: MatchedEntity): void {
    assertContract(MatchedEntitySchema, entity, 'MockHubEntityTransport.registerEntity');
    if (!this.allEntities.some((e) => e.entity_id === entity.entity_id)) {
      this.allEntities.push(entity);
    }
  }

  public async lookup(message: EntityLookupMessage): Promise<EntityLookupMessage> {
    assertContract(EntityLookupMessageSchema, message, 'MockHubEntityTransport.lookup.input');
    const req = message.request;
    if (!req) {
      throw new Error('LOOKUP_REQUEST must contain a valid request body');
    }

    const query = req.query_text.trim();
    const matches: MatchedEntity[] = [];

    for (const ent of this.allEntities) {
      if (matches.some((m) => m.entity_id === ent.entity_id)) {
        continue;
      }
      if (ent.canonical_name === query || (ent.aliases && ent.aliases.includes(query))) {
        matches.push(ent);
        continue;
      }
      if (ent.canonical_name.includes(query) || query.includes(ent.canonical_name)) {
        matches.push(ent);
        continue;
      }
      if (ent.aliases && ent.aliases.some((a) => a.includes(query) || query.includes(a))) {
        matches.push(ent);
      }
    }

    // Apply category filter if specified
    const filteredMatches = req.expected_categories && req.expected_categories.length > 0
      ? matches.filter((m) => req.expected_categories!.includes(m.category))
      : matches;

    const maxCandidates = req.max_candidates ?? 5;
    const finalMatches = filteredMatches.slice(0, maxCandidates);

    // Classify resolution status
    let resolution_status: 'EXACT_MATCH' | 'MULTIPLE_MATCHES' | 'UNRESOLVED_NOT_FOUND' = 'UNRESOLVED_NOT_FOUND';
    let selected_entity_id: string | undefined = undefined;

    if (finalMatches.length === 1 && finalMatches[0].confidence >= 0.85) {
      resolution_status = 'EXACT_MATCH';
      selected_entity_id = finalMatches[0].entity_id;
    } else if (finalMatches.length > 1) {
      const top = finalMatches[0];
      const second = finalMatches[1];
      if (top.confidence >= 0.85 && top.confidence - second.confidence >= 0.15) {
        resolution_status = 'EXACT_MATCH';
        selected_entity_id = top.entity_id;
      } else {
        resolution_status = 'MULTIPLE_MATCHES';
      }
    } else if (finalMatches.length === 1) {
      resolution_status = 'MULTIPLE_MATCHES';
    }

    const responsePayload: EntityLookupResponse = {
      resolution_status,
      selected_entity_id,
      matches: finalMatches,
    };

    const responseEnvelope: EntityLookupMessage = {
      protocol_version: '1.0.0',
      message_id: `msg_resp_${Date.now()}_${randomBytes(4).toString('hex')}`,
      timestamp: new Date().toISOString(),
      message_type: 'LOOKUP_RESPONSE',
      response: responsePayload,
    };

    assertContract(EntityLookupMessageSchema, responseEnvelope, 'MockHubEntityTransport.lookup.output');
    return responseEnvelope;
  }

  public async submitProposal(proposal: UnresolvedEntityProposal): Promise<UnresolvedEntityProposal> {
    assertContract(UnresolvedEntityProposalSchema, proposal, 'MockHubEntityTransport.submitProposal');
    this.proposals.set(proposal.proposal_id, { ...proposal });
    return proposal;
  }

  public async fetchProposal(proposalId: string): Promise<UnresolvedEntityProposal | null> {
    const found = this.proposals.get(proposalId);
    return found ? { ...found } : null;
  }

  public adjudicateProposal(
    proposalId: string,
    status: ProposalStatus,
    adjudication: HubAdjudication
  ): UnresolvedEntityProposal {
    const existing = this.proposals.get(proposalId);
    if (!existing) {
      throw new Error(`Proposal not found: ${proposalId}`);
    }

    assertContract(HubAdjudicationSchema, adjudication, 'adjudicateProposal.adjudication');
    const updated: UnresolvedEntityProposal = {
      ...existing,
      proposal_status: status,
      hub_adjudication: adjudication,
    };

    assertContract(UnresolvedEntityProposalSchema, updated, 'adjudicateProposal.updated');
    this.proposals.set(proposalId, updated);
    return updated;
  }
}

/**
 * Options for configuring the Hub Entity Master Data Adapter.
 */
export interface HubEntityAdapterOptions {
  transport?: IHubEntityTransport;
  confidenceThreshold?: number;
  enableCache?: boolean;
  cacheTtlMs?: number;
  proposerSystem?: 'WZCityTCDS' | 'WZCityTCDS-ExtractionEngine';
}

interface CacheEntry {
  response: EntityLookupResponse;
  expiresAt: number;
}

/**
 * Urban Spatio-Temporal Trusted Content Hub Entity Master Data Single Root Alignment Adapter.
 * Bridges fact extraction and verification pipelines with the central Hub EntityResolver.
 */
export class HubEntityAdapter {
  private readonly transport: IHubEntityTransport;
  private readonly confidenceThreshold: number;
  private readonly enableCache: boolean;
  private readonly cacheTtlMs: number;
  private readonly proposerSystem: 'WZCityTCDS' | 'WZCityTCDS-ExtractionEngine';
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: HubEntityAdapterOptions = {}) {
    this.transport = options.transport ?? new MockHubEntityTransport();
    this.confidenceThreshold = options.confidenceThreshold ?? 0.85;
    this.enableCache = options.enableCache ?? true;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
    this.proposerSystem = options.proposerSystem ?? 'WZCityTCDS';
  }

  private buildCacheKey(req: EntityLookupRequest): string {
    const parts = [
      req.query_text.trim().toLowerCase(),
      req.context_snippet ? req.context_snippet.slice(0, 128) : '',
      req.expected_categories ? req.expected_categories.slice().sort().join(',') : '',
      req.spatial_filter?.region_code ?? '',
    ];
    return parts.join('|');
  }

  /**
   * Look up and resolve an entity mention against the Hub.
   */
  public async lookupEntity(
    request: EntityLookupRequestInput,
    options?: { bypassCache?: boolean }
  ): Promise<EntityLookupResponse> {
    const parsedRequest = assertContract(
      EntityLookupRequestSchema,
      request,
      'HubEntityAdapter.lookupEntity.request'
    );

    const cacheKey = this.buildCacheKey(parsedRequest);
    const now = Date.now();

    if (this.enableCache && !options?.bypassCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        return cached.response;
      }
    }

    const messageId = `msg_req_${Date.now()}_${randomBytes(4).toString('hex')}`;
    const envelope: EntityLookupMessage = {
      protocol_version: '1.0.0',
      message_id: messageId,
      timestamp: new Date().toISOString(),
      message_type: 'LOOKUP_REQUEST',
      request: parsedRequest,
    };

    const respEnvelope = await this.transport.lookup(envelope);
    assertContract(EntityLookupMessageSchema, respEnvelope, 'HubEntityAdapter.lookupEntity.respEnvelope');

    if (!respEnvelope.response) {
      throw new Error(`Invalid response envelope from Hub EntityResolver: missing response field.`);
    }

    const rawResponse = respEnvelope.response;
    assertContract(EntityLookupResponseSchema, rawResponse, 'HubEntityAdapter.lookupEntity.response');

    // Post-classify according to configured confidenceThreshold
    const classifiedResponse = this.classifyResponse(rawResponse);

    if (this.enableCache) {
      this.cache.set(cacheKey, {
        response: classifiedResponse,
        expiresAt: now + this.cacheTtlMs,
      });
    }

    return classifiedResponse;
  }

  /**
   * Deterministically classifies the candidate matches into EXACT_MATCH, MULTIPLE_MATCHES, or UNRESOLVED_NOT_FOUND.
   */
  public classifyResponse(raw: EntityLookupResponse): EntityLookupResponse {
    const matches = raw.matches;
    if (!matches || matches.length === 0) {
      return {
        resolution_status: 'UNRESOLVED_NOT_FOUND',
        selected_entity_id: undefined,
        matches: [],
      };
    }

    const top = matches[0];
    if (matches.length === 1) {
      if (top.confidence >= this.confidenceThreshold) {
        assertValidEntityId(top.entity_id);
        return {
          resolution_status: 'EXACT_MATCH',
          selected_entity_id: top.entity_id,
          matches,
        };
      }
      return {
        resolution_status: 'MULTIPLE_MATCHES',
        selected_entity_id: undefined,
        matches,
      };
    }

    const second = matches[1];
    if (top.confidence >= this.confidenceThreshold && top.confidence - second.confidence >= 0.15) {
      assertValidEntityId(top.entity_id);
      return {
        resolution_status: 'EXACT_MATCH',
        selected_entity_id: top.entity_id,
        matches,
      };
    }

    return {
      resolution_status: 'MULTIPLE_MATCHES',
      selected_entity_id: undefined,
      matches,
    };
  }

  /**
   * Submits an unresolved candidate entity proposal to the central Hub governance team.
   * Strictly enforces cryptographic evidence binding via SHA-256 evidence_span_hash.
   */
  public async submitUnresolvedProposal(input: {
    candidate_name: string;
    source_evidence: ProposalSourceEvidence;
    suggested_aliases?: string[];
    suggested_category?: EntityCategory;
  }): Promise<UnresolvedEntityProposal> {
    assertContract(ProposalSourceEvidenceSchema, input.source_evidence, 'submitUnresolvedProposal.source_evidence');

    const proposalId = `prop_${Date.now()}_${randomBytes(6).toString('hex')}`;
    const proposal: UnresolvedEntityProposal = {
      proposal_id: proposalId,
      proposer_system: this.proposerSystem,
      submitted_at: new Date().toISOString(),
      candidate_name: input.candidate_name.trim(),
      suggested_aliases: input.suggested_aliases,
      suggested_category: input.suggested_category,
      source_evidence: input.source_evidence,
      proposal_status: 'SUBMITTED',
    };

    assertContract(UnresolvedEntityProposalSchema, proposal, 'submitUnresolvedProposal.proposal');
    const result = await this.transport.submitProposal(proposal);
    return result;
  }

  /**
   * Retrieves an unresolved proposal status from the transport.
   */
  public async getProposal(proposalId: string): Promise<UnresolvedEntityProposal | null> {
    if (!PROPOSAL_ID_REGEX.test(proposalId)) {
      throw new Error(`Invalid proposal_id format: ${proposalId}`);
    }
    return this.transport.fetchProposal(proposalId);
  }

  /**
   * Applies an adjudication decision to a proposal.
   */
  public applyAdjudication(
    proposal: UnresolvedEntityProposal,
    newStatus: ProposalStatus,
    adjudication: HubAdjudication
  ): UnresolvedEntityProposal {
    assertContract(ProposalStatusSchema, newStatus, 'applyAdjudication.newStatus');
    assertContract(HubAdjudicationSchema, adjudication, 'applyAdjudication.adjudication');

    if (newStatus === 'ACCEPTED_ALLOCATED') {
      if (!adjudication.allocated_entity_id) {
        throw new Error('ACCEPTED_ALLOCATED status requires an allocated_entity_id from Hub.');
      }
      assertValidEntityId(adjudication.allocated_entity_id);
    } else if (newStatus === 'MERGED_AS_ALIAS') {
      if (!adjudication.allocated_entity_id) {
        throw new Error('MERGED_AS_ALIAS status requires an allocated_entity_id for the target entity.');
      }
      assertValidEntityId(adjudication.allocated_entity_id);
    }

    const updated: UnresolvedEntityProposal = {
      ...proposal,
      proposal_status: newStatus,
      hub_adjudication: {
        ...adjudication,
        adjudicated_at: adjudication.adjudicated_at ?? new Date().toISOString(),
      },
    };

    assertContract(UnresolvedEntityProposalSchema, updated, 'applyAdjudication.updated');
    return updated;
  }

  /**
   * Clear in-memory lookup cache.
   */
  public clearCache(): void {
    this.cache.clear();
  }
}
