"""Outlets HTTP Router and request dispatcher implementation (Python mirror)."""
from __future__ import annotations
import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Protocol

from pydantic import BaseModel, ConfigDict, Field

from packages.shared.python.contracts.fact_revision import PublicationSnapshot
from packages.shared.python.contracts.outlets import (
    OutletChannel,
    PublicationSecurityGatePolicy,
    GateVerdict,
)
from packages.shared.python.contracts.outlets_engine import (
    PublicationSecurityGate,
    OutletDeliveryProjector,
    ChangesStreamManager,
)


class OutletsHttpRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    method: str = "GET"
    path: str = "/"
    query: Dict[str, Optional[str]] = Field(default_factory=dict)
    headers: Dict[str, Optional[str]] = Field(default_factory=dict)
    body: Optional[Any] = None


class OutletsHttpResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    status_code: int = 200
    headers: Dict[str, str] = Field(default_factory=dict)
    body: str = ""


class SnapshotRecord(BaseModel):
    model_config = ConfigDict(extra="ignore")
    snapshot: PublicationSnapshot
    receipts: Dict[str, Dict[str, Any]] = Field(default_factory=dict)
    is_revoked: bool = False
    revocation_notice: Optional[str] = None
    revoked_at: Optional[str] = None
    source_doc_ids: Dict[str, List[str]] = Field(default_factory=dict)
    lifecycle_states: Dict[str, str] = Field(default_factory=dict)


class OutletsStore(Protocol):
    def get_snapshot_record_by_id(self, snapshot_id: str) -> Optional[SnapshotRecord]: ...
    def get_snapshot_record_by_entity(self, entity_id: str) -> Optional[SnapshotRecord]: ...
    def list_public_snapshots(self, limit: int = 50) -> List[SnapshotRecord]: ...
    def get_changes_stream_manager(self) -> ChangesStreamManager: ...
    def get_retracted_source_doc_ids(self) -> List[str]: ...


class OutletsHttpRouter:
    def __init__(self, store: Any, base_url: str = "https://facts.wenzhou.gov.cn") -> None:
        self.store = store
        self.gate = PublicationSecurityGate()
        self.projector = OutletDeliveryProjector(default_base_url=base_url)

    def handle_request(self, req: OutletsHttpRequest) -> OutletsHttpResponse:
        try:
            method = (req.method or "GET").upper()
            raw_path = (req.path or "/").split("?")[0]
            normalized_path = re.sub(r"/+$", "", raw_path) or "/"

            if method == "GET":
                # 1. /api/v1/outlets/snapshot/:id or /outlets/snapshot/:id
                m_snap = re.match(r"^(?:/api/v1)?/outlets/snapshot/([^/]+)$", normalized_path)
                if m_snap:
                    return self._handle_get_snapshot(m_snap.group(1))

                # 2. /outlets/archive/:entity_id
                m_arch = re.match(r"^/outlets/archive/([^/]+)$", normalized_path)
                if m_arch:
                    return self._handle_get_archive(m_arch.group(1))

                # 3. /outlets/jsonld/:id
                m_jld = re.match(r"^/outlets/jsonld/([^/]+)$", normalized_path)
                if m_jld:
                    return self._handle_get_jsonld(m_jld.group(1))

                # 4. /outlets/feed.atom or /feed.atom
                if normalized_path in ("/outlets/feed.atom", "/feed.atom"):
                    return self._handle_get_feed()

                # 5. /outlets/sitemap.xml or /sitemap.xml
                if normalized_path in ("/outlets/sitemap.xml", "/sitemap.xml"):
                    return self._handle_get_sitemap()

                # 6. /outlets/changes.ndjson or /changes.ndjson
                if normalized_path in ("/outlets/changes.ndjson", "/changes.ndjson"):
                    since_seq_str = req.query.get("since_seq") or req.query.get("sinceSequenceNum")
                    since_seq = int(since_seq_str) if since_seq_str and since_seq_str.isdigit() else 0
                    return self._handle_get_changes_stream(since_seq)

            # 7. POST /outlets/mcp
            if method == "POST" and normalized_path in ("/outlets/mcp", "/api/outlets/mcp"):
                return self._handle_mcp_invocation(req.body)

            # 404 Route Not Found
            return OutletsHttpResponse(
                status_code=404,
                headers={"Content-Type": "application/json; charset=utf-8"},
                body=json.dumps({"error": "NOT_FOUND", "message": f"Route {method} {normalized_path} not found"}),
            )
        except Exception as exc:
            # Fail-closed fallback: 500 with no-store
            return OutletsHttpResponse(
                status_code=500,
                headers={"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"},
                body=json.dumps({
                    "error": "INTERNAL_GATE_ROUTER_FAIL_CLOSED",
                    "message": "Outlets router encountered unexpected error and failed closed.",
                    "detail": str(exc),
                }),
            )

    def _evaluate_record_gate(self, record: SnapshotRecord, retracted_sources: List[str]) -> PublicationSecurityGatePolicy:
        assertions: List[Dict[str, Any]] = []
        for a in record.snapshot.published_assertions:
            state = record.lifecycle_states.get(a.assertion_id, "PUBLISHED")
            doc_ids = record.source_doc_ids.get(a.assertion_id, [])
            assertions.append({
                "assertion_id": a.assertion_id,
                "lifecycle_state": state,
                "raw_value": a.raw_value,
                "evidence_hashes": a.evidence_hashes,
                "source_doc_ids": doc_ids,
            })

        return self.gate.evaluate(
            snapshot_revision_id=record.snapshot.snapshot_revision_id,
            assertions=assertions,
            evidence_receipts=record.receipts,
            retracted_source_doc_ids=retracted_sources,
        )

    def _handle_get_snapshot(self, snapshot_id: str) -> OutletsHttpResponse:
        record = self.store.get_snapshot_record_by_id(snapshot_id)
        if not record:
            return OutletsHttpResponse(
                status_code=404,
                headers={"Content-Type": "application/json; charset=utf-8"},
                body=json.dumps({"error": "SNAPSHOT_NOT_FOUND", "snapshot_id": snapshot_id}),
            )

        if record.is_revoked:
            tombstone = self.projector.project_tombstone(
                channel=OutletChannel.REST_API_V1,
                publication_id=record.snapshot.publication_id,
                snapshot_revision_id=record.snapshot.snapshot_revision_id,
                entity_id=record.snapshot.entity_id,
                snapshot_digest_sha256=record.snapshot.snapshot_digest_sha256,
                revocation_notice=record.revocation_notice or "Formal administrative retraction",
                revoked_at=record.revoked_at,
                http_status_code=410,
            )
            return OutletsHttpResponse(
                status_code=410,
                headers={
                    "Content-Type": "application/json; charset=utf-8",
                    "Cache-Control": "no-store",
                    "X-Fact-Revocation-Notice": "REVOKED",
                },
                body=tombstone.model_dump_json(),
            )

        retracted = self.store.get_retracted_source_doc_ids()
        policy = self._evaluate_record_gate(record, retracted)
        if policy.gate_verdict != GateVerdict.PASS_APPROVED_FOR_RELEASE:
            return OutletsHttpResponse(
                status_code=403,
                headers={"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"},
                body=json.dumps({"error": "PUBLICATION_SECURITY_GATE_BLOCKED", "policy": policy.model_dump()}),
            )

        payload = self.projector.render_payload(record.snapshot, OutletChannel.REST_API_V1)
        return OutletsHttpResponse(
            status_code=200,
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "public, max-age=3600",
                "ETag": f'"{record.snapshot.snapshot_digest_sha256}"',
            },
            body=payload,
        )

    def _handle_get_archive(self, entity_id: str) -> OutletsHttpResponse:
        record = self.store.get_snapshot_record_by_entity(entity_id)
        if not record:
            return OutletsHttpResponse(
                status_code=404,
                headers={"Content-Type": "text/html; charset=utf-8"},
                body="<html><body><h1>404 Not Found</h1><p>Public archive item not found.</p></body></html>",
            )

        if record.is_revoked:
            return OutletsHttpResponse(
                status_code=410,
                headers={
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-store",
                    "X-Fact-Revocation-Notice": "REVOKED",
                },
                body=f"<!DOCTYPE html><html><head><title>410 Revoked</title></head><body><h1>410 Fact Revoked</h1><p>{record.revocation_notice or 'This fact record was formally revoked.'}</p><p>Entity ID: {entity_id}</p></body></html>",
            )

        retracted = self.store.get_retracted_source_doc_ids()
        policy = self._evaluate_record_gate(record, retracted)
        if policy.gate_verdict != GateVerdict.PASS_APPROVED_FOR_RELEASE:
            return OutletsHttpResponse(
                status_code=403,
                headers={"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"},
                body=f"<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body><h1>403 Publication Blocked</h1><p>Security Gate rejected publication.</p></body></html>",
            )

        html = self.projector.render_payload(record.snapshot, OutletChannel.PUBLIC_HTML_ARCHIVE)
        return OutletsHttpResponse(
            status_code=200,
            headers={"Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600"},
            body=html,
        )

    def _handle_get_jsonld(self, snapshot_id: str) -> OutletsHttpResponse:
        record = self.store.get_snapshot_record_by_id(snapshot_id)
        if not record:
            return OutletsHttpResponse(
                status_code=404,
                headers={"Content-Type": "application/json; charset=utf-8"},
                body=json.dumps({"error": "SNAPSHOT_NOT_FOUND", "snapshot_id": snapshot_id}),
            )

        if record.is_revoked:
            return OutletsHttpResponse(
                status_code=410,
                headers={"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"},
                body=json.dumps({"error": "FACT_REVOKED_TOMBSTONE", "snapshot_id": snapshot_id}),
            )

        retracted = self.store.get_retracted_source_doc_ids()
        policy = self._evaluate_record_gate(record, retracted)
        if policy.gate_verdict != GateVerdict.PASS_APPROVED_FOR_RELEASE:
            return OutletsHttpResponse(
                status_code=403,
                headers={"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"},
                body=json.dumps({"error": "SECURITY_GATE_BLOCKED", "policy": policy.model_dump()}),
            )

        jsonld = self.projector.render_payload(record.snapshot, OutletChannel.JSON_LD_CARD)
        return OutletsHttpResponse(
            status_code=200,
            headers={"Content-Type": "application/ld+json; charset=utf-8", "Cache-Control": "public, max-age=3600"},
            body=jsonld,
        )

    def _handle_get_feed(self) -> OutletsHttpResponse:
        snapshots = self.store.list_public_snapshots(50)
        retracted = self.store.get_retracted_source_doc_ids()

        approved = [
            rec for rec in snapshots
            if not rec.is_revoked and self._evaluate_record_gate(rec, retracted).gate_verdict == GateVerdict.PASS_APPROVED_FOR_RELEASE
        ]

        entries = [self.projector.render_payload(rec.snapshot, OutletChannel.FEED_ATOM_V1) for rec in approved]
        feed_xml = "\n".join([
            '<?xml version="1.0" encoding="utf-8"?>',
            '<feed xmlns="http://www.w3.org/2005/Atom">',
            '  <title>WZCityTCDS Public Fact Publications</title>',
            '  <id>urn:wzcitytcds:feed</id>',
            f'  <updated>{datetime.now(timezone.utc).isoformat()}</updated>',
            *entries,
            '</feed>',
        ])

        return OutletsHttpResponse(
            status_code=200,
            headers={"Content-Type": "application/atom+xml; charset=utf-8", "Cache-Control": "public, max-age=600"},
            body=feed_xml,
        )

    def _handle_get_sitemap(self) -> OutletsHttpResponse:
        snapshots = self.store.list_public_snapshots(100)
        retracted = self.store.get_retracted_source_doc_ids()

        approved = [
            rec for rec in snapshots
            if not rec.is_revoked and self._evaluate_record_gate(rec, retracted).gate_verdict == GateVerdict.PASS_APPROVED_FOR_RELEASE
        ]

        urls = [self.projector.render_payload(rec.snapshot, OutletChannel.XML_SITEMAP) for rec in approved]
        sitemap_xml = "\n".join([
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
            *urls,
            '</urlset>',
        ])

        return OutletsHttpResponse(
            status_code=200,
            headers={"Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600"},
            body=sitemap_xml,
        )

    def _handle_get_changes_stream(self, since_seq: int) -> OutletsHttpResponse:
        stream_manager = self.store.get_changes_stream_manager()
        ndjson = stream_manager.serialize_ndjson(since_seq)

        return OutletsHttpResponse(
            status_code=200,
            headers={"Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform"},
            body=ndjson,
        )

    def _handle_mcp_invocation(self, body: Any) -> OutletsHttpResponse:
        payload = body if isinstance(body, dict) else {}
        entity_id = payload.get("entity_id") if isinstance(payload.get("entity_id"), str) else None

        snapshots = self.store.list_public_snapshots(50)
        retracted = self.store.get_retracted_source_doc_ids()

        matched = [
            rec for rec in snapshots
            if (not entity_id or rec.snapshot.entity_id == entity_id)
            and not rec.is_revoked
            and self._evaluate_record_gate(rec, retracted).gate_verdict == GateVerdict.PASS_APPROVED_FOR_RELEASE
        ]

        results = [
            {
                "entity_id": rec.snapshot.entity_id,
                "snapshot_revision_id": rec.snapshot.snapshot_revision_id,
                "payload": json.loads(self.projector.render_payload(rec.snapshot, OutletChannel.LLM_MCP_ENDPOINT)),
            }
            for rec in matched
        ]

        return OutletsHttpResponse(
            status_code=200,
            headers={"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache"},
            body=json.dumps({"tool": "query_facts", "total_results": len(results), "results": results}),
        )
