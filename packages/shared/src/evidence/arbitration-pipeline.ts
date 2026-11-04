import { randomBytes } from 'node:crypto';
import {
  type EvidenceConflictArbitration,
  type ConflictingSpanItem,
  type ConflictType,
  type SourceAuthorityLevel,
  type ArbitrationDecision,
  EvidenceConflictArbitrationSchema,
} from '../contracts/evidence.js';

export const AUTHORITY_RANK: Record<SourceAuthorityLevel, number> = {
  OFFICIAL_GOVERNMENT_RELEASE: 1,
  STATE_MEDIA_PRIMARY: 2,
  LOCAL_MEDIA_REPORT: 3,
  COMMERCIAL_PORTAL: 4,
};

export interface CreateConflictParams {
  assertion_id: string;
  conflicting_spans: ConflictingSpanItem[];
  conflict_type: ConflictType;
}

export interface AdjudicationOptions {
  policy?: 'AUTO_PRIORITY' | 'ALLOW_RANGE' | 'MANUAL';
  arbitrator_id?: string;
  chosen_decision?: ArbitrationDecision;
  adopted_span_id?: string;
  custom_rationale?: string;
}

export class ConflictArbitrationPipeline {
  private readonly defaultArbitratorId: string;

  constructor(options?: { defaultArbitratorId?: string }) {
    this.defaultArbitratorId = options?.defaultArbitratorId ?? 'system:conflict-arbitration-kernel';
  }

  /**
   * Registers a detected conflict between two or more evidence spans.
   */
  public createConflictArbitration(params: CreateConflictParams): EvidenceConflictArbitration {
    const { assertion_id, conflicting_spans, conflict_type } = params;
    if (conflicting_spans.length < 2) {
      throw new Error('Conflict arbitration requires at least 2 conflicting spans');
    }

    const arbitrationId = 'arb_' + randomBytes(16).toString('hex');
    const arbitration: EvidenceConflictArbitration = {
      arbitration_id: arbitrationId,
      assertion_id,
      conflicting_spans,
      conflict_type,
      arbitration_status: 'PENDING_ARBITRATION',
      created_at: new Date().toISOString(),
    };

    return EvidenceConflictArbitrationSchema.parse(arbitration);
  }

  /**
   * Evaluates authority hierarchy and adjudicates the conflict.
   */
  public adjudicate(
    arbitration: EvidenceConflictArbitration,
    options?: AdjudicationOptions
  ): EvidenceConflictArbitration {
    const policy = options?.policy ?? 'AUTO_PRIORITY';
    const arbitratorId = options?.arbitrator_id ?? this.defaultArbitratorId;
    const now = new Date().toISOString();

    if (policy === 'ALLOW_RANGE') {
      const rationale =
        options?.custom_rationale ??
        ('Numerical / temporal divergence reconciled as authoritative estimated range across multiple reliable sources (' +
          arbitration.conflicting_spans.length +
          ' reporting channels).');

      const adjudicated: EvidenceConflictArbitration = {
        ...arbitration,
        arbitration_status: 'RECONCILED_AS_RANGE',
        adjudication: {
          adjudicated_at: now,
          arbitrator_id: arbitratorId,
          chosen_decision: 'PUBLISH_AS_ESTIMATED_RANGE',
          arbitration_rationale: rationale,
        },
      };
      return EvidenceConflictArbitrationSchema.parse(adjudicated);
    }

    if (policy === 'MANUAL' && options?.chosen_decision) {
      const decision = options.chosen_decision;
      let status: EvidenceConflictArbitration['arbitration_status'] = 'PENDING_ARBITRATION';
      if (decision === 'ADOPT_HIGHER_AUTHORITY' || decision === 'ADOPT_LATEST_TIMESTAMPS') {
        status = 'RESOLVED_ADOPTED';
      } else if (decision === 'PUBLISH_AS_ESTIMATED_RANGE') {
        status = 'RECONCILED_AS_RANGE';
      } else if (decision === 'SUSPEND_PENDING_OFFICIAL_CLARIFICATION') {
        status = 'PENDING_ARBITRATION';
      }

      const rationale =
        options.custom_rationale ??
        ('Manual adjudication decided by authorized arbitrator ' +
          arbitratorId +
          ' under governance policy.');

      const adjudicated: EvidenceConflictArbitration = {
        ...arbitration,
        arbitration_status: status,
        adjudication: {
          adjudicated_at: now,
          arbitrator_id: arbitratorId,
          chosen_decision: decision,
          adopted_span_id: options.adopted_span_id,
          arbitration_rationale: rationale,
        },
      };
      return EvidenceConflictArbitrationSchema.parse(adjudicated);
    }

    // Default policy: AUTO_PRIORITY
    // Sort conflicting spans by rank (ascending: 1 is highest priority)
    const sorted = [...arbitration.conflicting_spans].sort((a, b) => {
      const rankA = AUTHORITY_RANK[a.source_authority_level] ?? 99;
      const rankB = AUTHORITY_RANK[b.source_authority_level] ?? 99;
      return rankA - rankB;
    });

    const topSpan = sorted[0];
    const topRank = AUTHORITY_RANK[topSpan.source_authority_level];

    // Check if there is a tie at topRank with different values
    const topTiedSpans = sorted.filter(
      (s) => AUTHORITY_RANK[s.source_authority_level] === topRank
    );

    const distinctValues = new Set(topTiedSpans.map((s) => JSON.stringify(s.reported_value)));

    if (topTiedSpans.length > 1 && distinctValues.size > 1) {
      // Same-tier contradiction cannot be auto-resolved
      const rationale =
        options?.custom_rationale ??
        ('Major contradiction detected between equal-tier authority sources (' +
          topSpan.source_authority_level +
          '). Automatic resolution suspended pending official clarification.');

      const adjudicated: EvidenceConflictArbitration = {
        ...arbitration,
        arbitration_status: 'PENDING_ARBITRATION',
        adjudication: {
          adjudicated_at: now,
          arbitrator_id: arbitratorId,
          chosen_decision: 'SUSPEND_PENDING_OFFICIAL_CLARIFICATION',
          arbitration_rationale: rationale,
        },
      };
      return EvidenceConflictArbitrationSchema.parse(adjudicated);
    }

    // Highest authority strictly dominates lower-tier sources
    const adopted = topSpan;
    const rationale =
      options?.custom_rationale ??
      ('Adopted higher authority level (' +
        adopted.source_authority_level +
        ') from span ' +
        adopted.span_id +
        ' over subordinate reporting channels.');

    const adjudicated: EvidenceConflictArbitration = {
      ...arbitration,
      arbitration_status: 'RESOLVED_ADOPTED',
      adjudication: {
        adjudicated_at: now,
        arbitrator_id: arbitratorId,
        chosen_decision: 'ADOPT_HIGHER_AUTHORITY',
        adopted_span_id: adopted.span_id,
        arbitration_rationale: rationale,
      },
    };
    return EvidenceConflictArbitrationSchema.parse(adjudicated);
  }
}
