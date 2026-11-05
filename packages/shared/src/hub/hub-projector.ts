import { createHash, randomBytes } from 'node:crypto';
import {
  type HubProjectionPayload,
  type HubProjectionReceipt,
  type HubProjectionTarget,
  type SpatialAnchor,
  type ProjectedAssertionItem,
  HubProjectionPayloadSchema,
  HubProjectionReceiptSchema,
} from '../contracts/hub-projection.js';
import { type PublicationSnapshot } from '../contracts/fact-revision.js';
import { type PublicationSecurityGatePolicy } from '../contracts/outlets.js';
import { assertValidEntityId } from '../adapters/hub-entity.js';

export interface ProjectSnapshotOptions {
  target?: HubProjectionTarget;
  gatePolicy?: PublicationSecurityGatePolicy;
  spatialAnchor?: SpatialAnchor;
  validityWindow?: {
    valid_from: string;
    valid_to?: string;
  };
}

export interface IHubProjectionTransport {
  project(payload: HubProjectionPayload): Promise<HubProjectionReceipt>;
  healthCheck(): Promise<{ ok: boolean; status: string }>;
}

export function computeReceiptSignature(
  receiptWithoutSig: Omit<HubProjectionReceipt, 'receipt_signature_sha256'>
): string {
  const canonical = JSON.stringify(
    receiptWithoutSig,
    Object.keys(receiptWithoutSig).sort()
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex').toLowerCase();
}

/**
 * Mock transport for testing and local/offline simulation of Hub one-way fact projection.
 */
export class MockHubProjectionTransport implements IHubProjectionTransport {
  private readonly receivedProjections: HubProjectionPayload[] = [];
  private readonly receipts = new Map<string, HubProjectionReceipt>();
  public shouldFail = false;
  public failureReason = 'Hub ingestion temporary failure';

  public async project(payload: HubProjectionPayload): Promise<HubProjectionReceipt> {
    const validated = HubProjectionPayloadSchema.parse(payload);
    this.receivedProjections.push(validated);

    const now = new Date().toISOString();
    const receiptId = 'rcpt_' + randomBytes(16).toString('hex');

    if (this.shouldFail) {
      const rawRejected = {
        receipt_id: receiptId,
        projection_id: validated.projection_id,
        status: 'REJECTED' as const,
        acknowledged_at: now,
        rejection_reason: this.failureReason,
      };
      const sig = computeReceiptSignature(rawRejected);
      const receipt: HubProjectionReceipt = {
        ...rawRejected,
        receipt_signature_sha256: sig,
      };
      const checked = HubProjectionReceiptSchema.parse(receipt);
      this.receipts.set(validated.projection_id, checked);
      return checked;
    }

    const slotId = `slot_${validated.entity_id}_${randomBytes(6).toString('hex')}`;
    const rawAccepted = {
      receipt_id: receiptId,
      projection_id: validated.projection_id,
      status: 'ACCEPTED' as const,
      hub_slot_id: slotId,
      acknowledged_at: now,
    };
    const sig = computeReceiptSignature(rawAccepted);
    const receipt: HubProjectionReceipt = {
      ...rawAccepted,
      receipt_signature_sha256: sig,
    };
    const checked = HubProjectionReceiptSchema.parse(receipt);
    this.receipts.set(validated.projection_id, checked);
    return checked;
  }

  public async healthCheck(): Promise<{ ok: boolean; status: string }> {
    return {
      ok: !this.shouldFail,
      status: this.shouldFail ? 'DEGRADED' : 'HEALTHY_ONLINE',
    };
  }

  public getReceivedProjections(): readonly HubProjectionPayload[] {
    return this.receivedProjections;
  }

  public getReceipt(projection_id: string): HubProjectionReceipt | null {
    return this.receipts.get(projection_id) ?? null;
  }
}

/**
 * HubOneWayProjector
 * Bridges WZCityTCDS published fact snapshots into the central Urban Spatio-Temporal Trusted Content Hub.
 * Enforces Option A invariant: Strictly push-only projection of published facts with verified evidence receipts.
 */
export class HubOneWayProjector {
  private readonly transport: IHubProjectionTransport;
  private readonly receipts: HubProjectionReceipt[] = [];
  private readonly entityToReceipts = new Map<string, HubProjectionReceipt[]>();

  constructor(transport?: IHubProjectionTransport) {
    this.transport = transport ?? new MockHubProjectionTransport();
  }

  /**
   * Projects a verified PublicationSnapshot to the Hub.
   */
  public async projectSnapshot(
    snapshot: PublicationSnapshot,
    options?: ProjectSnapshotOptions
  ): Promise<HubProjectionReceipt> {
    assertValidEntityId(snapshot.entity_id);

    // Fail-closed gate check: if gate policy is provided, it must be PASS
    if (options?.gatePolicy) {
      if (options.gatePolicy.gate_verdict !== 'PASS_APPROVED_FOR_RELEASE') {
        throw new Error(
          `Security gate fail-closed: publication cannot be projected to Hub. Gate verdict: ${options.gatePolicy.gate_verdict}`
        );
      }
    }

    // Verify snapshot has assertions
    if (!snapshot.published_assertions || snapshot.published_assertions.length === 0) {
      throw new Error(`Cannot project empty snapshot for entity ${snapshot.entity_id}: zero published assertions`);
    }

    // Build projected assertions list
    const assertions: ProjectedAssertionItem[] = snapshot.published_assertions.map((a) => ({
      property_path: a.property_path,
      raw_value: a.raw_value,
      revision_id: a.revision_id,
      confidence: 1.0,
    }));

    const projectionId = 'prj_' + randomBytes(16).toString('hex');
    const target = options?.target ?? 'URBAN_SPATIAL_HUB';
    const projectedAt = new Date().toISOString();

    const payload: HubProjectionPayload = {
      projection_id: projectionId,
      snapshot_revision_id: snapshot.snapshot_revision_id,
      entity_id: snapshot.entity_id,
      target,
      projected_at: projectedAt,
      snapshot_digest_sha256: snapshot.snapshot_digest_sha256,
      assertions,
      spatial_anchor: options?.spatialAnchor,
      validity_window: options?.validityWindow,
    };

    const validatedPayload = HubProjectionPayloadSchema.parse(payload);
    const receipt = await this.transport.project(validatedPayload);
    const validatedReceipt = HubProjectionReceiptSchema.parse(receipt);

    this.receipts.push(validatedReceipt);
    const list = this.entityToReceipts.get(snapshot.entity_id) ?? [];
    list.push(validatedReceipt);
    this.entityToReceipts.set(snapshot.entity_id, list);

    return validatedReceipt;
  }

  public getHistory(entity_id?: string): readonly HubProjectionReceipt[] {
    if (entity_id) {
      return this.entityToReceipts.get(entity_id) ?? [];
    }
    return this.receipts;
  }

  public getLatestReceipt(entity_id: string): HubProjectionReceipt | null {
    const list = this.entityToReceipts.get(entity_id);
    if (!list || list.length === 0) return null;
    return list[list.length - 1];
  }
}
