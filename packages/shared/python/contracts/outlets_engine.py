"""Public outlets and publication security gate implementation (Python mirror)."""
from __future__ import annotations
import hashlib
import json
import re
import secrets
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

from pydantic import BaseModel, ConfigDict, Field

from packages.shared.python.contracts.outlets import (
    OutletChannel,
    PayloadFormat,
    DeliveryStatus,
    TombstoneDetails,
    CacheControlPolicy,
    PublicOutletDelivery,
    GateVerdict,
    RuleEvaluations,
    GateController,
    PublicationSecurityGatePolicy,
    StreamChangeType,
    AffectedRevision,
    ChangesStreamEvent,
)
from packages.shared.python.contracts.fact_revision import PublicationSnapshot

PRIVATE_IP_PATTERNS = [
    re.compile(r"\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"),
    re.compile(r"\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b"),
    re.compile(r"\b192\.168\.\d{1,3}\.\d{1,3}\b"),
    re.compile(r"\b[a-zA-Z0-9_.-]+\.(?:internal|local)\b"),
]

CREDENTIAL_PATTERNS = [
    re.compile(r"\bsk-[a-zA-Z0-9]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bghp_[a-zA-Z0-9]{36}\b"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b"),
]

CHANNEL_PAYLOAD_MAP: Dict[OutletChannel, PayloadFormat] = {
    OutletChannel.PUBLIC_HTML_ARCHIVE: PayloadFormat.HTML,
    OutletChannel.REST_API_V1: PayloadFormat.JSON,
    OutletChannel.JSON_LD_CARD: PayloadFormat.JSON_LD,
    OutletChannel.FEED_ATOM_V1: PayloadFormat.XML_ATOM,
    OutletChannel.XML_SITEMAP: PayloadFormat.XML_SITEMAP,
    OutletChannel.CHANGES_STREAM_NDJSON: PayloadFormat.NDJSON,
    OutletChannel.LLM_MCP_ENDPOINT: PayloadFormat.JSON,
}


def compute_stream_event_digest(event_dict: dict) -> str:
    """Computes deterministic SHA-256 digest over sorted canonical JSON representation of event."""
    canonical = json.dumps(event_dict, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest().lower()


class PublicationSecurityGate:
    def __init__(self, default_controller_role: str = "FPF_PUBLICATION_SECURITY_GATE"):
        self.default_controller_role = default_controller_role

    def evaluate(
        self,
        snapshot_revision_id: str,
        assertions: List[Dict[str, Any]],
        evidence_receipts: Dict[str, Dict[str, Any]],
        retracted_source_doc_ids: Optional[List[str]] = None,
        raw_payload_text: Optional[str] = None,
        controller_role: Optional[str] = None,
    ) -> PublicationSecurityGatePolicy:
        try:
            ctrl_role = controller_role or self.default_controller_role
            retracted_set: Set[str] = set(retracted_source_doc_ids or [])
            text_to_scan = raw_payload_text or json.dumps(assertions, ensure_ascii=False)

            # Rule 1: Only published state
            non_published_count = sum(
                1 for a in assertions if a.get("lifecycle_state") != "PUBLISHED"
            )
            rule1_passed = non_published_count == 0

            # Rule 2: Evidence receipt PASS
            unverified_count = 0
            for a in assertions:
                ast_id = a.get("assertion_id")
                rcpt = evidence_receipts.get(ast_id)
                if not rcpt or rcpt.get("overall_verification_verdict") != "PASS":
                    unverified_count += 1
            rule2_passed = unverified_count == 0

            # Rule 3: No private IP leaks
            ip_matches: List[str] = []
            for pat in PRIVATE_IP_PATTERNS:
                matches = pat.findall(text_to_scan)
                if matches:
                    ip_matches.extend(matches)
            unique_ip_matches = sorted(list(set(ip_matches)))
            rule3_passed = len(unique_ip_matches) == 0

            # Rule 4: No credential patterns
            cred_count = 0
            for pat in CREDENTIAL_PATTERNS:
                matches = pat.findall(text_to_scan)
                if matches:
                    cred_count += len(matches)
            rule4_passed = cred_count == 0

            # Rule 5: Source validity confirmed (no retracted sources)
            retracted_source_count = 0
            for a in assertions:
                doc_ids = a.get("source_doc_ids") or []
                if any(doc_id in retracted_set for doc_id in doc_ids):
                    retracted_source_count += 1
            rule5_passed = retracted_source_count == 0

            all_passed = (
                rule1_passed and rule2_passed and rule3_passed and rule4_passed and rule5_passed
            )
            gate_verdict = (
                GateVerdict.PASS_APPROVED_FOR_RELEASE
                if all_passed
                else GateVerdict.FAIL_CLOSED_BLOCKED
            )

            evaluations = RuleEvaluations(
                rule_only_published_state={
                    "passed": rule1_passed,
                    "non_published_count": non_published_count,
                },
                rule_evidence_receipt_pass={
                    "passed": rule2_passed,
                    "unverified_assertion_count": unverified_count,
                },
                rule_no_private_ip_leaks={
                    "passed": rule3_passed,
                    "detected_matches": unique_ip_matches,
                },
                rule_no_credential_patterns={
                    "passed": rule4_passed,
                    "suspicious_token_count": cred_count,
                },
                rule_source_validity_confirmed={
                    "passed": rule5_passed,
                    "retracted_source_count": retracted_source_count,
                },
            )

            gate_evaluation_id = f"gate_{secrets.token_hex(16)}"
            evaluated_at = datetime.now(timezone.utc).isoformat()

            sig_payload = json.dumps(
                {
                    "gate_evaluation_id": gate_evaluation_id,
                    "snapshot_revision_id": snapshot_revision_id,
                    "evaluated_at": evaluated_at,
                    "gate_verdict": gate_verdict.value,
                },
                sort_keys=True,
            )
            sig_hash = hashlib.sha256(sig_payload.encode("utf-8")).hexdigest().lower()

            return PublicationSecurityGatePolicy(
                gate_evaluation_id=gate_evaluation_id,
                snapshot_revision_id=snapshot_revision_id if re.match(r"^pubrev_[a-zA-Z0-9_-]{12,64}$", str(snapshot_revision_id)) else "pubrev_failclosed_000000",
                evaluated_at=evaluated_at,
                gate_verdict=gate_verdict,
                rule_evaluations=evaluations,
                gate_controller=GateController(
                    controller_role=ctrl_role,
                    signature_hash=sig_hash,
                ),
            )
        except Exception:
            gate_evaluation_id = f"gate_{secrets.token_hex(16)}"
            evaluated_at = datetime.now(timezone.utc).isoformat()
            return PublicationSecurityGatePolicy(
                gate_evaluation_id=gate_evaluation_id,
                snapshot_revision_id=snapshot_revision_id if re.match(r"^pubrev_[a-zA-Z0-9_-]{12,64}$", str(snapshot_revision_id)) else "pubrev_failclosed_000000",
                evaluated_at=evaluated_at,
                gate_verdict=GateVerdict.FAIL_CLOSED_BLOCKED,
                rule_evaluations=RuleEvaluations(
                    rule_only_published_state={"passed": False, "non_published_count": 1},
                    rule_evidence_receipt_pass={"passed": False, "unverified_assertion_count": 1},
                    rule_no_private_ip_leaks={"passed": False, "detected_matches": ["exception"]},
                    rule_no_credential_patterns={"passed": False, "suspicious_token_count": 1},
                    rule_source_validity_confirmed={"passed": False, "retracted_source_count": 1},
                ),
                gate_controller=GateController(
                    controller_role="FPF_PUBLICATION_SECURITY_GATE",
                    signature_hash="f" * 64,
                ),
            )


class OutletDeliveryProjector:
    def __init__(self, default_base_url: str = "https://facts.wenzhou.gov.cn"):
        self.default_base_url = default_base_url

    def project_snapshot(
        self,
        snapshot: PublicationSnapshot,
        channel: OutletChannel,
        is_superseded: bool = False,
        base_url: Optional[str] = None,
    ) -> PublicOutletDelivery:
        b_url = base_url or self.default_base_url
        format_type = CHANNEL_PAYLOAD_MAP[channel]
        canonical_url = f"{b_url}/entities/{snapshot.entity_id}"
        delivery_status = (
            DeliveryStatus.SUPERSEDED_HISTORICAL if is_superseded else DeliveryStatus.ACTIVE_CURRENT
        )
        max_age = 86400 * 30 if is_superseded else 3600
        cache_policy = "PUBLIC_IMMUTABLE" if is_superseded else "PUBLIC_REVALIDATE"

        return PublicOutletDelivery(
            outlet_channel=channel,
            publication_id=snapshot.publication_id,
            snapshot_revision_id=snapshot.snapshot_revision_id,
            entity_id=snapshot.entity_id,
            canonical_url=canonical_url,
            published_at=snapshot.generated_at,
            snapshot_digest_sha256=snapshot.snapshot_digest_sha256,
            payload_format=format_type,
            delivery_status=delivery_status,
            cache_control=CacheControlPolicy(
                cache_policy=cache_policy,
                max_age_seconds=max_age,
            ),
        )

    def project_tombstone(
        self,
        channel: OutletChannel,
        publication_id: str,
        snapshot_revision_id: str,
        entity_id: str,
        snapshot_digest_sha256: str,
        revocation_notice: str,
        revoked_at: Optional[str] = None,
        http_status_code: int = 410,
        base_url: Optional[str] = None,
    ) -> PublicOutletDelivery:
        b_url = base_url or self.default_base_url
        format_type = CHANNEL_PAYLOAD_MAP[channel]
        t_time = revoked_at or datetime.now(timezone.utc).isoformat()
        canonical_url = f"{b_url}/entities/{entity_id}"

        return PublicOutletDelivery(
            outlet_channel=channel,
            publication_id=publication_id,
            snapshot_revision_id=snapshot_revision_id if re.match(r"^pubrev_[a-zA-Z0-9_-]{12,64}$", str(snapshot_revision_id)) else "pubrev_failclosed_000000",
            entity_id=entity_id,
            canonical_url=canonical_url,
            published_at=t_time,
            snapshot_digest_sha256=snapshot_digest_sha256,
            payload_format=format_type,
            delivery_status=DeliveryStatus.REVOKED_TOMBSTONE,
            tombstone_details=TombstoneDetails(
                revoked_at=t_time,
                revocation_notice=revocation_notice,
                http_status_code=http_status_code,
            ),
            cache_control=CacheControlPolicy(
                cache_policy="NO_STORE",
                max_age_seconds=0,
            ),
        )

    def render_payload(self, snapshot: PublicationSnapshot, channel: OutletChannel) -> str:
        if channel in (OutletChannel.REST_API_V1, OutletChannel.LLM_MCP_ENDPOINT):
            return json.dumps(snapshot.model_dump(), indent=2, ensure_ascii=False)
        elif channel == OutletChannel.PUBLIC_HTML_ARCHIVE:
            items = "".join(
                f"<li><strong>{getattr(a, 'property_path', a.get('property_path') if isinstance(a, dict) else '')}</strong>: "
                f"{getattr(a, 'raw_value', a.get('raw_value') if isinstance(a, dict) else '')} "
                f"(Rev: {getattr(a, 'revision_id', a.get('revision_id') if isinstance(a, dict) else '')})</li>"
                for a in snapshot.published_assertions
            )
            return (
                f"<!DOCTYPE html><html><head><title>Official City Fact Record - {snapshot.entity_id}</title>"
                f'<meta name="fact-snapshot-digest" content="{snapshot.snapshot_digest_sha256}"></head>'
                f"<body><h1>Entity Fact Record: {snapshot.entity_id}</h1><ul>{items}</ul></body></html>"
            )
        elif channel == OutletChannel.JSON_LD_CARD:
            return json.dumps(
                {
                    "@context": "https://schema.org",
                    "@type": "City",
                    "@id": f"urn:entity:{snapshot.entity_id}",
                    "identifier": snapshot.entity_id,
                    "subjectOf": {
                        "@type": "Dataset",
                        "name": "Authoritative City Fact Assertions",
                        "version": snapshot.snapshot_revision_id,
                        "sha256": snapshot.snapshot_digest_sha256,
                        "variableMeasured": [(a.property_path if hasattr(a, "property_path") else a["property_path"]) for a in snapshot.published_assertions],
                    },
                },
                indent=2,
            )
        elif channel == OutletChannel.FEED_ATOM_V1:
            return (
                '<?xml version="1.0" encoding="utf-8"?>\n'
                '<entry xmlns="http://www.w3.org/2005/Atom">\n'
                f'  <id>urn:pubrev:{snapshot.snapshot_revision_id}</id>\n'
                f'  <title>Fact Update: {snapshot.entity_id}</title>\n'
                f'  <updated>{snapshot.generated_at}</updated>\n'
                f'  <summary>{len(snapshot.published_assertions)} verified assertions.</summary>\n'
                '</entry>'
            )
        elif channel == OutletChannel.XML_SITEMAP:
            return (
                '<url>\n'
                f'  <loc>{self.default_base_url}/entities/{snapshot.entity_id}</loc>\n'
                f'  <lastmod>{snapshot.generated_at.split("T")[0]}</lastmod>\n'
                '  <changefreq>daily</changefreq>\n'
                '</url>'
            )
        elif channel == OutletChannel.CHANGES_STREAM_NDJSON:
            return json.dumps(
                {
                    "entity_id": snapshot.entity_id,
                    "snapshot_revision_id": snapshot.snapshot_revision_id,
                    "digest": snapshot.snapshot_digest_sha256,
                    "timestamp": snapshot.generated_at,
                }
            )
        return json.dumps(snapshot.model_dump(), ensure_ascii=False)


class ChangesStreamManager:
    def __init__(self, initial_sequence_num: int = 0):
        self.current_sequence_num = initial_sequence_num
        self.events: List[ChangesStreamEvent] = []

    def get_sequence(self) -> int:
        return self.current_sequence_num

    def get_all_events(self) -> List[ChangesStreamEvent]:
        return list(self.events)

    def emit_event(
        self,
        change_type: StreamChangeType,
        entity_id: str,
        affected_revision: AffectedRevision,
        event_timestamp: Optional[str] = None,
    ) -> ChangesStreamEvent:
        self.current_sequence_num += 1
        change_event_id = f"chg_{secrets.token_hex(16)}"
        timestamp = event_timestamp or datetime.now(timezone.utc).isoformat()

        raw_event = {
            "change_event_id": change_event_id,
            "change_sequence_num": self.current_sequence_num,
            "change_type": change_type.value,
            "entity_id": entity_id,
            "event_timestamp": timestamp,
            "affected_revision": affected_revision.model_dump(),
        }

        digest = compute_stream_event_digest(raw_event)
        event = ChangesStreamEvent(
            change_event_id=change_event_id,
            change_sequence_num=self.current_sequence_num,
            change_type=change_type,
            entity_id=entity_id,
            event_timestamp=timestamp,
            event_digest_sha256=digest,
            affected_revision=affected_revision,
        )

        self.events.append(event)
        return event

    def serialize_ndjson(self, since_sequence_num: int = 0) -> str:
        return "\n".join(
            json.dumps(e.model_dump())
            for e in self.events
            if e.change_sequence_num > since_sequence_num
        )
