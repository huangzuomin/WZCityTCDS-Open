import { createHash, randomBytes } from 'node:crypto';
import {
  type PublicationSecurityGatePolicy,
  type GateVerdict,
  type RuleEvaluations,
  PublicationSecurityGatePolicySchema,
} from '../contracts/outlets.js';

export interface GateAssertionItem {
  assertion_id: string;
  lifecycle_state: string;
  evidence_hashes?: string[];
  raw_value?: unknown;
  source_doc_ids?: string[];
}

export interface GateEvidenceReceiptItem {
  overall_verification_verdict: string;
}

export interface EvaluateGateParams {
  snapshot_revision_id: string;
  assertions: GateAssertionItem[];
  evidence_receipts: Record<string, GateEvidenceReceiptItem>;
  retracted_source_doc_ids?: string[] | Set<string>;
  raw_payload_text?: string;
  controller_role?: 'FPF_PUBLICATION_SECURITY_GATE' | 'SECURITY_OFFICER';
}

const PRIVATE_IP_PATTERNS = [
  /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  /\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g,
  /\b192\.168\.\d{1,3}\.\d{1,3}\b/g,
  /\b[a-zA-Z0-9_.-]+\.(?:internal|local)\b/g,
];

const CREDENTIAL_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[a-zA-Z0-9]{36}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g,
];

export class PublicationSecurityGate {
  private readonly defaultControllerRole: 'FPF_PUBLICATION_SECURITY_GATE';

  constructor() {
    this.defaultControllerRole = 'FPF_PUBLICATION_SECURITY_GATE';
  }

  /**
   * Evaluates all 5 mandatory publication rules under Fail-Closed semantics.
   */
  public evaluate(params: EvaluateGateParams): PublicationSecurityGatePolicy {
    try {
      const {
        snapshot_revision_id,
        assertions,
        evidence_receipts,
        retracted_source_doc_ids,
        raw_payload_text,
        controller_role = this.defaultControllerRole,
      } = params;

      const retractedSet = new Set(retracted_source_doc_ids ?? []);
      const textToScan = raw_payload_text ?? JSON.stringify(assertions);

      // Rule 1: Only published state
      const nonPublishedCount = assertions.filter(
        (a) => a.lifecycle_state !== 'PUBLISHED'
      ).length;
      const rule1Passed = nonPublishedCount === 0;

      // Rule 2: Evidence receipt PASS
      const unverifiedCount = assertions.filter((a) => {
        const rcpt = evidence_receipts[a.assertion_id];
        return !rcpt || rcpt.overall_verification_verdict !== 'PASS';
      }).length;
      const rule2Passed = unverifiedCount === 0;

      // Rule 3: No private IP leaks
      const ipMatches: string[] = [];
      for (const pattern of PRIVATE_IP_PATTERNS) {
        pattern.lastIndex = 0;
        const found = textToScan.match(pattern);
        if (found) {
          ipMatches.push(...found);
        }
      }
      const uniqueIpMatches = Array.from(new Set(ipMatches));
      const rule3Passed = uniqueIpMatches.length === 0;

      // Rule 4: No credential patterns
      let credCount = 0;
      for (const pattern of CREDENTIAL_PATTERNS) {
        pattern.lastIndex = 0;
        const found = textToScan.match(pattern);
        if (found) {
          credCount += found.length;
        }
      }
      const rule4Passed = credCount === 0;

      // Rule 5: Source validity confirmed (no retracted sources)
      let retractedSourceCount = 0;
      for (const a of assertions) {
        if (a.source_doc_ids) {
          const hasRetracted = a.source_doc_ids.some((docId) => retractedSet.has(docId));
          if (hasRetracted) {
            retractedSourceCount++;
          }
        }
      }
      const rule5Passed = retractedSourceCount === 0;

      const allPassed =
        rule1Passed && rule2Passed && rule3Passed && rule4Passed && rule5Passed;
      const gateVerdict: GateVerdict = allPassed
        ? 'PASS_APPROVED_FOR_RELEASE'
        : 'FAIL_CLOSED_BLOCKED';

      const ruleEvaluations: RuleEvaluations = {
        rule_only_published_state: {
          passed: rule1Passed,
          non_published_count: nonPublishedCount,
        },
        rule_evidence_receipt_pass: {
          passed: rule2Passed,
          unverified_assertion_count: unverifiedCount,
        },
        rule_no_private_ip_leaks: {
          passed: rule3Passed,
          detected_matches: uniqueIpMatches,
        },
        rule_no_credential_patterns: {
          passed: rule4Passed,
          suspicious_token_count: credCount,
        },
        rule_source_validity_confirmed: {
          passed: rule5Passed,
          retracted_source_count: retractedSourceCount,
        },
      };

      const gateEvaluationId = 'gate_' + randomBytes(16).toString('hex');
      const evaluatedAt = new Date().toISOString();

      const signaturePayload = JSON.stringify({
        gate_evaluation_id: gateEvaluationId,
        snapshot_revision_id,
        evaluated_at: evaluatedAt,
        gate_verdict: gateVerdict,
        rule_evaluations: ruleEvaluations,
      });
      const signatureHash = createHash('sha256')
        .update(signaturePayload, 'utf8')
        .digest('hex')
        .toLowerCase();

      const policy: PublicationSecurityGatePolicy = {
        gate_evaluation_id: gateEvaluationId,
        snapshot_revision_id,
        evaluated_at: evaluatedAt,
        gate_verdict: gateVerdict,
        rule_evaluations: ruleEvaluations,
        gate_controller: {
          controller_role,
          signature_hash: signatureHash,
        },
      };

      return PublicationSecurityGatePolicySchema.parse(policy);
    } catch {
      // Fail-closed fallback: return a blocked evaluation record
      const gateEvaluationId = 'gate_' + randomBytes(16).toString('hex');
      const evaluatedAt = new Date().toISOString();
      const fallbackPolicy: PublicationSecurityGatePolicy = {
        gate_evaluation_id: gateEvaluationId,
        snapshot_revision_id: params.snapshot_revision_id,
        evaluated_at: evaluatedAt,
        gate_verdict: 'FAIL_CLOSED_BLOCKED',
        rule_evaluations: {
          rule_only_published_state: { passed: false, non_published_count: 1 },
          rule_evidence_receipt_pass: { passed: false, unverified_assertion_count: 1 },
          rule_no_private_ip_leaks: { passed: false, detected_matches: ['exception_triggered'] },
          rule_no_credential_patterns: { passed: false, suspicious_token_count: 1 },
          rule_source_validity_confirmed: { passed: false, retracted_source_count: 1 },
        },
        gate_controller: {
          controller_role: 'FPF_PUBLICATION_SECURITY_GATE',
          signature_hash: createHash('sha256').update('fail_closed', 'utf8').digest('hex'),
        },
      };
      return PublicationSecurityGatePolicySchema.parse(fallbackPolicy);
    }
  }
}
