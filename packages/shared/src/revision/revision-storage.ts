import { createHash, randomBytes } from 'crypto';
import {
  AssertionValue,
  AssertionValueSchema,
  FactLifecycleState,
  FactRevisionLifecycle,
  FactRevisionLifecycleSchema,
  OutletScope,
  PublishedAssertionItem,
  PublishedAssertionItemSchema,
  PublicationSnapshot,
  PublicationSnapshotSchema,
  RevisionMetadata,
  RevisionMetadataSchema,
  RevisionReason,
  RevisionRole,
  RevisionStateTransition,
  RevisionStateTransitionSchema,
  RevisionTransitionRole,
  RevisionTransitionTrigger,
  assertContract,
} from '../contracts/index.js';

export const ASSERTION_ID_REGEX = /^ast_[a-zA-Z0-9_-]{12,64}$/;
export const REVISION_ID_REGEX = /^rev_[a-zA-Z0-9_-]{12,64}$/;
export const PUBLICATION_ID_REGEX = /^pub_[a-zA-Z0-9_-]{12,64}$/;
export const PUBREV_ID_REGEX = /^pubrev_[a-zA-Z0-9_-]{12,64}$/;
export const TRANSITION_ID_REGEX = /^trans_[a-zA-Z0-9_-]{12,64}$/;

/**
 * Computes canonical SHA-256 digest of a FactRevisionLifecycle for hash-chaining.
 */
export function computeRevisionDigest(rev: FactRevisionLifecycle): string {
  const canonicalPayload = JSON.stringify({
    assertion_id: rev.assertion_id,
    revision_id: rev.revision_id,
    entity_id: rev.entity_id,
    property_path: rev.property_path,
    assertion_value: {
      raw_value: rev.assertion_value.raw_value,
      data_type: rev.assertion_value.data_type,
      unit: rev.assertion_value.unit,
      temporal_validity: rev.assertion_value.temporal_validity,
      spatial_scope: rev.assertion_value.spatial_scope,
    },
    parent_revision_sha256: rev.revision_metadata.parent_revision_sha256,
    evidence_span_hashes: rev.revision_metadata.evidence_span_hashes.slice().sort(),
  });

  return createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
}

/**
 * Computes canonical aggregate SHA-256 digest of published assertion items for publication snapshot.
 */
export function computeSnapshotDigest(items: PublishedAssertionItem[]): string {
  const sorted = items
    .slice()
    .sort((a, b) => a.property_path.localeCompare(b.property_path) || a.assertion_id.localeCompare(b.assertion_id));

  const canonicalPayload = JSON.stringify(
    sorted.map((item) => ({
      assertion_id: item.assertion_id,
      revision_id: item.revision_id,
      property_path: item.property_path,
      raw_value: item.raw_value,
      unit: item.unit,
      evidence_hashes: item.evidence_hashes.slice().sort(),
    }))
  );

  return createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
}

export interface CreateRevisionParams {
  assertion_id: string;
  entity_id: string;
  property_path: string;
  assertion_value: AssertionValue;
  created_by_role: RevisionRole;
  author_id?: string;
  revision_reason: RevisionReason;
  reason_description?: string;
  evidence_span_hashes: string[];
  initial_state?: 'DRAFT' | 'PENDING_REVIEW';
}

export interface TransitionStateParams {
  revision_id: string;
  trigger: RevisionTransitionTrigger;
  authorized_role: RevisionTransitionRole;
  operator_id?: string;
  revocation_reason?: string;
  superseded_by_revision_id?: string;
}

export interface SnapshotOptions {
  publisher_role?: 'CHIEF_FACT_EDITOR' | 'AUTOMATED_RELEASE_BOT';
  outlet_scopes?: OutletScope[];
  entity_canonical_name?: string;
}

/**
 * Append-Only Fact Revision Chain Storage Engine & Publication State Machine.
 * Enforces S3 immutability, cryptographic hash-chaining, and strict role-gated state transitions.
 */
export class FactRevisionStorage {
  private readonly revisionsById = new Map<string, FactRevisionLifecycle>();
  private readonly revisionDigestsById = new Map<string, string>();
  private readonly chainsByAssertionId = new Map<string, string[]>();
  private readonly transitionsByRevisionId = new Map<string, RevisionStateTransition[]>();
  private readonly snapshotsByEntityId = new Map<string, PublicationSnapshot[]>();

  /**
   * Creates a new immutable FactRevision node.
   * If this is the first revision of the assertion, parent_revision_sha256 is "GENESIS".
   * Otherwise, it is linked to the SHA-256 digest of the immediately preceding revision.
   */
  public createRevision(params: CreateRevisionParams): FactRevisionLifecycle {
    assertContract(AssertionValueSchema, params.assertion_value, 'createRevision.assertion_value');

    const chain = this.chainsByAssertionId.get(params.assertion_id) || [];
    let parentHash = 'GENESIS';
    let revisionNumber = 1;

    if (chain.length > 0) {
      const lastRevisionId = chain[chain.length - 1];
      const lastDigest = this.revisionDigestsById.get(lastRevisionId);
      if (!lastDigest) {
        throw new Error(`Corrupted state: digest missing for previous revision ${lastRevisionId}`);
      }
      parentHash = lastDigest;
      revisionNumber = chain.length + 1;
    }

    const revisionId = `rev_${Date.now()}_${randomBytes(6).toString('hex')}`;
    const metadata: RevisionMetadata = {
      parent_revision_sha256: parentHash,
      created_at: new Date().toISOString(),
      created_by_role: params.created_by_role,
      author_id: params.author_id,
      revision_reason: params.revision_reason,
      reason_description: params.reason_description,
      evidence_span_hashes: params.evidence_span_hashes,
    };
    assertContract(RevisionMetadataSchema, metadata, 'createRevision.metadata');

    const newRev: FactRevisionLifecycle = {
      assertion_id: params.assertion_id,
      revision_id: revisionId,
      revision_number: revisionNumber,
      entity_id: params.entity_id,
      property_path: params.property_path,
      assertion_value: params.assertion_value,
      lifecycle_state: params.initial_state || 'DRAFT',
      revision_metadata: metadata,
    };
    assertContract(FactRevisionLifecycleSchema, newRev, 'createRevision.FactRevisionLifecycle');

    const digest = computeRevisionDigest(newRev);

    this.revisionsById.set(revisionId, Object.freeze({ ...newRev }));
    this.revisionDigestsById.set(revisionId, digest);

    if (!this.chainsByAssertionId.has(params.assertion_id)) {
      this.chainsByAssertionId.set(params.assertion_id, []);
    }
    this.chainsByAssertionId.get(params.assertion_id)!.push(revisionId);

    return { ...newRev };
  }

  /**
   * Retrieves an immutable revision by ID.
   */
  public getRevision(revisionId: string): FactRevisionLifecycle | null {
    const rev = this.revisionsById.get(revisionId);
    return rev ? { ...rev } : null;
  }

  /**
   * Retrieves all revisions for an assertion in chronological order.
   */
  public getRevisionsForAssertion(assertionId: string): FactRevisionLifecycle[] {
    const chain = this.chainsByAssertionId.get(assertionId) || [];
    return chain.map((id) => ({ ...this.revisionsById.get(id)! }));
  }

  /**
   * Retrieves the latest revision for an assertion.
   */
  public getLatestRevision(assertionId: string): FactRevisionLifecycle | null {
    const chain = this.chainsByAssertionId.get(assertionId) || [];
    if (chain.length === 0) return null;
    return { ...this.revisionsById.get(chain[chain.length - 1])! };
  }

  /**
   * Validates the cryptographic hash chain integrity of an assertion's revisions from GENESIS to head.
   */
  public validateChainIntegrity(assertionId: string): { isValid: boolean; errors: string[]; chainLength: number } {
    const chain = this.chainsByAssertionId.get(assertionId) || [];
    const errors: string[] = [];

    if (chain.length === 0) {
      return { isValid: true, errors: [], chainLength: 0 };
    }

    let expectedParentHash = 'GENESIS';

    for (let i = 0; i < chain.length; i++) {
      const revId = chain[i];
      const rev = this.revisionsById.get(revId);
      if (!rev) {
        errors.push(`Revision ${revId} referenced in chain is missing from storage`);
        continue;
      }

      if (rev.revision_metadata.parent_revision_sha256 !== expectedParentHash) {
        errors.push(
          `Chain break at index ${i} (${revId}): expected parent ${expectedParentHash}, got ${rev.revision_metadata.parent_revision_sha256}`
        );
      }

      const computedDigest = computeRevisionDigest(rev);
      const storedDigest = this.revisionDigestsById.get(revId);
      if (computedDigest !== storedDigest) {
        errors.push(
          `Payload tamper detected at index ${i} (${revId}): computed digest ${computedDigest} != stored ${storedDigest}`
        );
      }

      expectedParentHash = computedDigest;
    }

    return {
      isValid: errors.length === 0,
      errors,
      chainLength: chain.length,
    };
  }

  /**
   * Executes a role-gated state transition on a revision node.
   * Records an audited RevisionStateTransition event.
   */
  public transitionState(params: TransitionStateParams): {
    revision: FactRevisionLifecycle;
    transition: RevisionStateTransition;
  } {
    const currentRev = this.revisionsById.get(params.revision_id);
    if (!currentRev) {
      throw new Error(`Cannot transition non-existent revision: ${params.revision_id}`);
    }

    const fromState = currentRev.lifecycle_state;
    let toState: FactLifecycleState;

    // Validate Transition Rules according to Section 3.2
    switch (params.trigger) {
      case 'SUBMIT_FOR_REVIEW':
        if (fromState !== 'DRAFT') {
          throw new Error(`Invalid transition: SUBMIT_FOR_REVIEW can only be triggered from DRAFT (current: ${fromState})`);
        }
        if (params.authorized_role !== 'FACT_EXTRACTOR') {
          throw new Error(`Unauthorized role: SUBMIT_FOR_REVIEW requires FACT_EXTRACTOR (current: ${params.authorized_role})`);
        }
        if (currentRev.revision_metadata.evidence_span_hashes.length === 0) {
          throw new Error('Precondition failed: At least 1 evidence_span_hash is required to submit for review');
        }
        toState = 'PENDING_REVIEW';
        break;

      case 'APPROVE_AND_PUBLISH':
        if (fromState !== 'PENDING_REVIEW') {
          throw new Error(`Invalid transition: APPROVE_AND_PUBLISH can only be triggered from PENDING_REVIEW (current: ${fromState})`);
        }
        if (params.authorized_role !== 'FACT_REVIEWER' && params.authorized_role !== 'CHIEF_EDITOR') {
          throw new Error(`Unauthorized role: APPROVE_AND_PUBLISH requires FACT_REVIEWER or CHIEF_EDITOR (current: ${params.authorized_role})`);
        }
        toState = 'PUBLISHED';
        break;

      case 'REJECT_CANDIDATE':
        if (fromState !== 'PENDING_REVIEW') {
          throw new Error(`Invalid transition: REJECT_CANDIDATE can only be triggered from PENDING_REVIEW (current: ${fromState})`);
        }
        if (params.authorized_role !== 'FACT_REVIEWER') {
          throw new Error(`Unauthorized role: REJECT_CANDIDATE requires FACT_REVIEWER (current: ${params.authorized_role})`);
        }
        toState = 'REVOKED';
        break;

      case 'SUPERSEDE_WITH_NEW_REVISION':
        if (fromState !== 'PUBLISHED') {
          throw new Error(`Invalid transition: SUPERSEDE_WITH_NEW_REVISION can only be triggered from PUBLISHED (current: ${fromState})`);
        }
        if (!params.superseded_by_revision_id) {
          throw new Error('Precondition failed: superseded_by_revision_id is required');
        }
        toState = 'SUPERSEDED';
        break;

      case 'REVOKE_PUBLISHED_FACT':
        if (fromState !== 'PUBLISHED') {
          throw new Error(`Invalid transition: REVOKE_PUBLISHED_FACT can only be triggered from PUBLISHED (current: ${fromState})`);
        }
        if (params.authorized_role !== 'CHIEF_EDITOR') {
          throw new Error(`Unauthorized role: REVOKE_PUBLISHED_FACT requires CHIEF_EDITOR (current: ${params.authorized_role})`);
        }
        if (!params.revocation_reason || params.revocation_reason.trim().length < 5) {
          throw new Error('Precondition failed: revocation_reason with min 5 characters is required');
        }
        toState = 'REVOKED';
        break;

      default:
        throw new Error(`Unknown trigger: ${params.trigger}`);
    }

    const transitionId = `trans_${Date.now()}_${randomBytes(6).toString('hex')}`;
    const transitionRecord: RevisionStateTransition = {
      transition_id: transitionId,
      assertion_id: currentRev.assertion_id,
      revision_id: currentRev.revision_id,
      from_state: fromState as any,
      to_state: toState as any,
      transition_trigger: params.trigger,
      authorized_role: params.authorized_role,
      operator_id: params.operator_id,
      transition_timestamp: new Date().toISOString(),
      superseded_by_revision_id: params.superseded_by_revision_id,
      revocation_reason: params.revocation_reason,
    };
    assertContract(RevisionStateTransitionSchema, transitionRecord, 'transitionState.transitionRecord');

    const updatedRev: FactRevisionLifecycle = {
      ...currentRev,
      lifecycle_state: toState,
    };
    assertContract(FactRevisionLifecycleSchema, updatedRev, 'transitionState.updatedRev');

    this.revisionsById.set(params.revision_id, Object.freeze(updatedRev));

    if (!this.transitionsByRevisionId.has(params.revision_id)) {
      this.transitionsByRevisionId.set(params.revision_id, []);
    }
    this.transitionsByRevisionId.get(params.revision_id)!.push(transitionRecord);

    return {
      revision: { ...updatedRev },
      transition: transitionRecord,
    };
  }

  /**
   * Generates an immutable PublicationSnapshot for an entity by aggregating all currently PUBLISHED assertions.
   */
  public generatePublicationSnapshot(entityId: string, options: SnapshotOptions = {}): PublicationSnapshot {
    const publishedItems: PublishedAssertionItem[] = [];

    // Find all assertions for this entity
    for (const [assertionId, chain] of this.chainsByAssertionId.entries()) {
      if (chain.length === 0) continue;
      const latestId = chain[chain.length - 1];
      const rev = this.revisionsById.get(latestId);
      if (rev && rev.entity_id === entityId && rev.lifecycle_state === 'PUBLISHED') {
        const item: PublishedAssertionItem = {
          assertion_id: rev.assertion_id,
          revision_id: rev.revision_id,
          property_path: rev.property_path,
          raw_value: rev.assertion_value.raw_value,
          unit: rev.assertion_value.unit,
          evidence_hashes: rev.revision_metadata.evidence_span_hashes,
        };
        assertContract(PublishedAssertionItemSchema, item, 'generatePublicationSnapshot.item');
        publishedItems.push(item);
      }
    }

    if (publishedItems.length === 0) {
      throw new Error(`Cannot generate PublicationSnapshot: zero PUBLISHED assertions found for entity ${entityId}`);
    }

    const digest = computeSnapshotDigest(publishedItems);
    const pubId = `pub_${Date.now()}_${randomBytes(6).toString('hex')}`;
    const pubrevId = `pubrev_${Date.now()}_${randomBytes(6).toString('hex')}`;

    // Mark previous snapshots of this entity as not latest
    const existingSnapshots = this.snapshotsByEntityId.get(entityId) || [];
    for (const s of existingSnapshots) {
      s.projection_metadata.is_latest_snapshot = false;
    }

    const snapshot: PublicationSnapshot = {
      publication_id: pubId,
      snapshot_revision_id: pubrevId,
      entity_id: entityId,
      entity_canonical_name: options.entity_canonical_name,
      generated_at: new Date().toISOString(),
      snapshot_digest_sha256: digest,
      published_assertions: publishedItems,
      projection_metadata: {
        kernel_system: 'WZCityTCDS-PublicationKernel',
        publisher_role: options.publisher_role || 'CHIEF_FACT_EDITOR',
        outlet_scopes: options.outlet_scopes || ['HUB_ONE_WAY_PROJECTION', 'REST_API', 'PUBLIC_HTML_ARCHIVE'],
        is_latest_snapshot: true,
      },
    };
    assertContract(PublicationSnapshotSchema, snapshot, 'generatePublicationSnapshot.snapshot');

    if (!this.snapshotsByEntityId.has(entityId)) {
      this.snapshotsByEntityId.set(entityId, []);
    }
    this.snapshotsByEntityId.get(entityId)!.push(snapshot);

    return snapshot;
  }

  /**
   * Retrieves the latest publication snapshot for an entity.
   */
  public getLatestSnapshot(entityId: string): PublicationSnapshot | null {
    const list = this.snapshotsByEntityId.get(entityId) || [];
    if (list.length === 0) return null;
    return { ...list[list.length - 1] };
  }

  /**
   * Retrieves the audit history of transitions for a revision.
   */
  public getTransitions(revisionId: string): RevisionStateTransition[] {
    const list = this.transitionsByRevisionId.get(revisionId) || [];
    return list.map((t) => ({ ...t }));
  }
}
