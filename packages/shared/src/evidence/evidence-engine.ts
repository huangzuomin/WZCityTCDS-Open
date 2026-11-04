import { createHash, randomBytes } from 'node:crypto';
import {
  type EvidenceSpan,
  type SpanVerificationItem,
  type EvidenceVerificationReceipt,
  type OverallVerificationVerdict,
  type AuditorSignature,
  EvidenceVerificationReceiptSchema,
  EvidenceSpanSchema,
} from '../contracts/evidence.js';

export interface SourceNewsDocumentSnapshot {
  source_doc_id: string;
  source_url?: string;
  paragraphs: string[];
  is_retracted?: boolean;
}

/**
 * Computes deterministic SHA-256 for quoted evidence text.
 * Applies Unicode NFKC normalization and UTF-8 encoding.
 */
export function computeSpanHash(text: string): string {
  const normalized = text.normalize('NFKC');
  return createHash('sha256').update(normalized, 'utf8').digest('hex').toLowerCase();
}

/**
 * Computes deterministic SHA-256 digest over canonical JSON representation of receipt.
 */
export function computeReceiptDigest(
  receiptWithoutSignature: Omit<EvidenceVerificationReceipt, 'auditor_signature'>
): string {
  const canonical = JSON.stringify(receiptWithoutSignature, Object.keys(receiptWithoutSignature).sort());
  return createHash('sha256').update(canonical, 'utf8').digest('hex').toLowerCase();
}

export interface VerifyAssertionEvidenceParams {
  assertion_id: string;
  revision_id: string;
  spans: EvidenceSpan[];
  source_resolver: (sourceDocId: string) => SourceNewsDocumentSnapshot | undefined;
  verifier_engine_version?: string;
  signer_identity?: string;
  signature_type?: AuditorSignature['signature_type'];
}

export class EvidenceVerificationEngine {
  private readonly defaultEngineVersion: string;
  private readonly defaultSignerIdentity: string;

  constructor(options?: { engineVersion?: string; signerIdentity?: string }) {
    this.defaultEngineVersion = options?.engineVersion ?? 'EvidenceVerificationEngine/1.0.0-FPF-S4';
    this.defaultSignerIdentity = options?.signerIdentity ?? 'system:evidence-verifier-kernel';
  }

  /**
   * Verifies an individual EvidenceSpan against quoted text and source document paragraph.
   */
  public verifySpan(
    span: EvidenceSpan,
    sourceDoc?: SourceNewsDocumentSnapshot
  ): SpanVerificationItem {
    const computedHash = computeSpanHash(span.quoted_text);
    const hashMatched = computedHash === span.span_hash.toLowerCase();

    if (!hashMatched) {
      return {
        span_id: span.span_id,
        span_hash_matched: false,
        source_doc_verified: false,
        paragraph_exact_match: false,
        check_status: 'FAIL_HASH_MISMATCH',
        computed_hash: computedHash,
      };
    }

    if (!sourceDoc) {
      return {
        span_id: span.span_id,
        span_hash_matched: true,
        source_doc_verified: false,
        paragraph_exact_match: false,
        check_status: 'FAIL_SOURCE_NOT_FOUND',
        computed_hash: computedHash,
      };
    }

    const pIndex = span.paragraph_index;
    if (pIndex < 0 || pIndex >= sourceDoc.paragraphs.length) {
      return {
        span_id: span.span_id,
        span_hash_matched: true,
        source_doc_verified: true,
        paragraph_exact_match: false,
        check_status: 'FAIL_TEXT_NOT_FOUND',
        computed_hash: computedHash,
      };
    }

    const paragraph = sourceDoc.paragraphs[pIndex];
    const sliced = paragraph.substring(span.char_start, span.char_end);
    const exactMatch = sliced === span.quoted_text;

    if (!exactMatch) {
      return {
        span_id: span.span_id,
        span_hash_matched: true,
        source_doc_verified: true,
        paragraph_exact_match: false,
        check_status: 'FAIL_TEXT_NOT_FOUND',
        computed_hash: computedHash,
      };
    }

    return {
      span_id: span.span_id,
      span_hash_matched: true,
      source_doc_verified: true,
      paragraph_exact_match: true,
      check_status: 'PASS',
      computed_hash: computedHash,
    };
  }

  /**
   * Performs full 3-step verification on all EvidenceSpans supporting an assertion.
   * Generates a signed, schema-compliant EvidenceVerificationReceipt.
   */
  public verifyAssertionEvidence(
    params: VerifyAssertionEvidenceParams
  ): EvidenceVerificationReceipt {
    const {
      assertion_id,
      revision_id,
      spans,
      source_resolver,
      verifier_engine_version = this.defaultEngineVersion,
      signer_identity = this.defaultSignerIdentity,
      signature_type = 'ENGINE_HMAC',
    } = params;

    const receiptId = 'rcpt_' + randomBytes(16).toString('hex');
    const verifiedAt = new Date().toISOString();

    if (spans.length === 0) {
      const dummySpanItem: SpanVerificationItem = {
        span_id: 'span_missing_dummy_none',
        span_hash_matched: false,
        source_doc_verified: false,
        paragraph_exact_match: false,
        check_status: 'FAIL_TEXT_NOT_FOUND',
      };

      const receiptWithoutSig = {
        receipt_id: receiptId,
        assertion_id,
        revision_id,
        verified_at: verifiedAt,
        verifier_engine_version,
        span_verifications: [dummySpanItem],
        overall_verification_verdict: 'FAIL_INSUFFICIENT_EVIDENCE' as const,
      };

      const digest = computeReceiptDigest(receiptWithoutSig);
      const receipt: EvidenceVerificationReceipt = {
        ...receiptWithoutSig,
        auditor_signature: {
          signature_type,
          signer_identity,
          digest_sha256: digest,
        },
      };

      return EvidenceVerificationReceiptSchema.parse(receipt);
    }

    const spanVerifications: SpanVerificationItem[] = [];
    let hasSourceRetracted = false;
    let hasHashMismatch = false;
    let hasTextNotFound = false;
    let hasSourceNotFound = false;

    for (const span of spans) {
      const sourceDoc = source_resolver(span.source_doc_id);
      if (sourceDoc?.is_retracted) {
        hasSourceRetracted = true;
      }

      const item = this.verifySpan(span, sourceDoc);
      spanVerifications.push(item);

      if (item.check_status === 'FAIL_HASH_MISMATCH') {
        hasHashMismatch = true;
      } else if (item.check_status === 'FAIL_SOURCE_NOT_FOUND') {
        hasSourceNotFound = true;
      } else if (item.check_status === 'FAIL_TEXT_NOT_FOUND') {
        hasTextNotFound = true;
      }
    }

    let overallVerdict: OverallVerificationVerdict = 'PASS';
    if (hasSourceRetracted) {
      overallVerdict = 'FAIL_SOURCE_RETRACTED';
    } else if (hasHashMismatch) {
      overallVerdict = 'FAIL_HASH_MISMATCH';
    } else if (hasSourceNotFound || hasTextNotFound) {
      overallVerdict = 'FAIL_TEXT_NOT_FOUND';
    }

    const receiptWithoutSig = {
      receipt_id: receiptId,
      assertion_id,
      revision_id,
      verified_at: verifiedAt,
      verifier_engine_version,
      span_verifications: spanVerifications,
      overall_verification_verdict: overallVerdict,
    };

    const digest = computeReceiptDigest(receiptWithoutSig);
    const receipt: EvidenceVerificationReceipt = {
      ...receiptWithoutSig,
      auditor_signature: {
        signature_type,
        signer_identity,
        digest_sha256: digest,
      },
    };

    return EvidenceVerificationReceiptSchema.parse(receipt);
  }

  /**
   * Handles upstream source retraction (NEWS_RETRACTED):
   * Identifies affected EvidenceSpans and marks their quality state as STALE_SOURCE_RETRACTED.
   */
  public handleSourceRetraction(
    retractedSourceDocId: string,
    spans: EvidenceSpan[]
  ): { affected_spans: EvidenceSpan[]; updated_spans: EvidenceSpan[] } {
    const affected: EvidenceSpan[] = [];
    const updated = spans.map((span) => {
      if (span.source_doc_id === retractedSourceDocId) {
        const marked: EvidenceSpan = {
          ...span,
          quality_state: 'STALE_SOURCE_RETRACTED',
        };
        EvidenceSpanSchema.parse(marked);
        affected.push(marked);
        return marked;
      }
      return span;
    });

    return { affected_spans: affected, updated_spans: updated };
  }
}
