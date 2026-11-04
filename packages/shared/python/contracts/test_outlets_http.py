"""Tests for Outlets HTTP Router (Python mirror)."""
from __future__ import annotations
import json
import unittest

from packages.shared.python.contracts.fact_revision import (
    PublicationSnapshot,
    PublishedAssertionItem,
    ProjectionMetadata,
)
from packages.shared.python.contracts.outlets import (
    OutletChannel,
    StreamChangeType,
    AffectedRevision,
)
from packages.shared.python.contracts.outlets_engine import (
    ChangesStreamManager,
)
from packages.shared.python.contracts.outlets_http import (
    OutletsHttpRequest,
    OutletsHttpRouter,
    SnapshotRecord,
)


def create_mock_snapshot(**kwargs) -> PublicationSnapshot:
    data = {
        "publication_id": "pub_wenzhou_gdp_20261104_001",
        "snapshot_revision_id": "pubrev_wenzhou_20261104_v1",
        "entity_id": "ent_wenzhou_330300",
        "generated_at": "2026-11-04T10:00:00.000Z",
        "snapshot_digest_sha256": "a" * 64,
        "published_assertions": [
            PublishedAssertionItem(
                assertion_id="ast_gdp_annual_2026_wz",
                revision_id="rev_gdp_2026_v001",
                property_path="economy.gdp.annual",
                raw_value=7120.5,
                evidence_hashes=["b" * 64],
            )
        ],
        "projection_metadata": ProjectionMetadata(
            kernel_system="WZCityTCDS-PublicationKernel",
            publisher_role="CHIEF_FACT_EDITOR",
            outlet_scopes=["PUBLIC_HTML_ARCHIVE", "REST_API", "FEED_ATOM", "MCP_ENDPOINT"],
            is_latest_snapshot=True,
        ),
    }
    data.update(kwargs)
    return PublicationSnapshot(**data)


class MockOutletsStore:
    def __init__(self, records_by_id, stream_manager, retracted=None):
        self.records_by_id = records_by_id
        self.stream_manager = stream_manager
        self.retracted = retracted or []

    def get_snapshot_record_by_id(self, snapshot_id: str):
        return self.records_by_id.get(snapshot_id)

    def get_snapshot_record_by_entity(self, entity_id: str):
        for rec in self.records_by_id.values():
            if rec.snapshot.entity_id == entity_id:
                return rec
        return None

    def list_public_snapshots(self, limit: int = 50):
        return list(self.records_by_id.values())[:limit]

    def get_changes_stream_manager(self):
        return self.stream_manager

    def get_retracted_source_doc_ids(self):
        return self.retracted


class TestOutletsHttpRouter(unittest.TestCase):
    def setUp(self):
        self.valid_snap = create_mock_snapshot()
        self.valid_record = SnapshotRecord(
            snapshot=self.valid_snap,
            receipts={"ast_gdp_annual_2026_wz": {"overall_verification_verdict": "PASS"}},
            source_doc_ids={"ast_gdp_annual_2026_wz": ["news_valid_doc_001"]},
        )

        self.revoked_snap = create_mock_snapshot(
            publication_id="pub_lucheng_revoked_01",
            snapshot_revision_id="pubrev_lucheng_revoked_01",
            entity_id="ent_wz_lucheng_revoked",
        )
        self.revoked_record = SnapshotRecord(
            snapshot=self.revoked_snap,
            receipts={"ast_gdp_annual_2026_wz": {"overall_verification_verdict": "PASS"}},
            is_revoked=True,
            revocation_notice="Administrative policy retraction #410",
            revoked_at="2026-11-04T12:00:00.000Z",
        )

        self.leak_snap = create_mock_snapshot(
            publication_id="pub_lucheng_leak_01",
            snapshot_revision_id="pubrev_lucheng_leak_01",
            entity_id="ent_wz_lucheng_leak",
            published_assertions=[
                PublishedAssertionItem(
                    assertion_id="ast_leak_001",
                    revision_id="rev_leak_001",
                    property_path="internal.server",
                    evidence_hashes=["b" * 64],
                    raw_value="192.168.1.100 internal host",
                )
            ],
        )
        self.leak_record = SnapshotRecord(
            snapshot=self.leak_snap,
            receipts={"ast_leak_001": {"overall_verification_verdict": "PASS"}},
        )

        self.stream = ChangesStreamManager()
        self.stream.emit_event(
            change_type=StreamChangeType.FACT_PUBLISHED,
            entity_id=self.valid_snap.entity_id,
            affected_revision=AffectedRevision(
                revision_id="rev_gdp_2026_v001",
                property_path="economy.gdp.annual",
                lifecycle_state="PUBLISHED",
                publication_snapshot_id=self.valid_snap.snapshot_revision_id,
            ),
        )
        self.stream.emit_event(
            change_type=StreamChangeType.FACT_CORRECTED,
            entity_id=self.valid_snap.entity_id,
            affected_revision=AffectedRevision(
                revision_id="rev_gdp_2026_v002",
                property_path="economy.gdp.annual",
                lifecycle_state="PUBLISHED",
                previous_revision_id="rev_gdp_2026_v001",
                publication_snapshot_id=self.valid_snap.snapshot_revision_id,
            ),
        )

        self.records_map = {
            self.valid_snap.snapshot_revision_id: self.valid_record,
            self.revoked_snap.snapshot_revision_id: self.revoked_record,
            self.leak_snap.snapshot_revision_id: self.leak_record,
        }
        self.store = MockOutletsStore(self.records_map, self.stream)
        self.router = OutletsHttpRouter(self.store)

    def test_01_get_snapshot_success(self):
        req = OutletsHttpRequest(method="GET", path=f"/api/v1/outlets/snapshot/{self.valid_snap.snapshot_revision_id}")
        res = self.router.handle_request(req)
        self.assertEqual(res.status_code, 200)
        self.assertIn("application/json", res.headers["Content-Type"])
        self.assertIn("public", res.headers["Cache-Control"])
        body = json.loads(res.body)
        self.assertEqual(body["snapshot_revision_id"], self.valid_snap.snapshot_revision_id)

    def test_02_get_snapshot_revoked_410(self):
        req = OutletsHttpRequest(method="GET", path=f"/outlets/snapshot/{self.revoked_snap.snapshot_revision_id}")
        res = self.router.handle_request(req)
        self.assertEqual(res.status_code, 410)
        self.assertEqual(res.headers["Cache-Control"], "no-store")
        self.assertEqual(res.headers["X-Fact-Revocation-Notice"], "REVOKED")
        body = json.loads(res.body)
        self.assertEqual(body["delivery_status"], "REVOKED_TOMBSTONE")

    def test_03_get_snapshot_security_gate_blocked_403(self):
        req = OutletsHttpRequest(method="GET", path=f"/outlets/snapshot/{self.leak_snap.snapshot_revision_id}")
        res = self.router.handle_request(req)
        self.assertEqual(res.status_code, 403)
        body = json.loads(res.body)
        self.assertEqual(body["error"], "PUBLICATION_SECURITY_GATE_BLOCKED")
        self.assertFalse(body["policy"]["rule_evaluations"]["rule_no_private_ip_leaks"]["passed"])

    def test_04_get_snapshot_not_found_404(self):
        req = OutletsHttpRequest(method="GET", path="/outlets/snapshot/missing_snapshot_999")
        res = self.router.handle_request(req)
        self.assertEqual(res.status_code, 404)

    def test_05_get_archive_html_success(self):
        req = OutletsHttpRequest(method="GET", path=f"/outlets/archive/{self.valid_snap.entity_id}")
        res = self.router.handle_request(req)
        self.assertEqual(res.status_code, 200)
        self.assertIn("text/html", res.headers["Content-Type"])
        self.assertIn("<!DOCTYPE html>", res.body)

    def test_06_get_archive_revoked_410(self):
        req = OutletsHttpRequest(method="GET", path=f"/outlets/archive/{self.revoked_snap.entity_id}")
        res = self.router.handle_request(req)
        self.assertEqual(res.status_code, 410)
        self.assertIn("410 Fact Revoked", res.body)

    def test_07_get_archive_blocked_403(self):
        req = OutletsHttpRequest(method="GET", path=f"/outlets/archive/{self.leak_snap.entity_id}")
        res = self.router.handle_request(req)
        self.assertEqual(res.status_code, 403)
        self.assertIn("403 Publication Blocked", res.body)

    def test_08_get_archive_not_found_404(self):
        req = OutletsHttpRequest(method="GET", path="/outlets/archive/non_existent_entity")
        res = self.router.handle_request(req)
        self.assertEqual(res.status_code, 404)
        self.assertIn("404 Not Found", res.body)

    def test_09_get_jsonld_success(self):
        req = OutletsHttpRequest(method="GET", path=f"/outlets/jsonld/{self.valid_snap.snapshot_revision_id}")
        res = self.router.handle_request(req)
        self.assertEqual(res.status_code, 200)
        self.assertIn("application/ld+json", res.headers["Content-Type"])
        body = json.loads(res.body)
        self.assertEqual(body["@context"], "https://schema.org")

    def test_10_get_feed_atom_success(self):
        req = OutletsHttpRequest(method="GET", path="/outlets/feed.atom")
        res = self.router.handle_request(req)
        self.assertEqual(res.status_code, 200)
        self.assertIn("application/atom+xml", res.headers["Content-Type"])
        self.assertIn('<feed xmlns="http://www.w3.org/2005/Atom">', res.body)
        self.assertIn("<entry", res.body)

    def test_11_get_sitemap_xml_success(self):
        req = OutletsHttpRequest(method="GET", path="/outlets/sitemap.xml")
        res = self.router.handle_request(req)
        self.assertEqual(res.status_code, 200)
        self.assertIn("application/xml", res.headers["Content-Type"])
        self.assertIn("<urlset", res.body)
        self.assertIn("<loc>", res.body)

    def test_12_get_changes_stream_ndjson(self):
        req = OutletsHttpRequest(method="GET", path="/outlets/changes.ndjson", query={"since_seq": "1"})
        res = self.router.handle_request(req)
        self.assertEqual(res.status_code, 200)
        self.assertIn("application/x-ndjson", res.headers["Content-Type"])
        lines = res.body.strip().split("\n")
        self.assertEqual(len(lines), 1)
        event = json.loads(lines[0])
        self.assertEqual(event["change_sequence_num"], 2)

    def test_13_post_mcp_invocation(self):
        req = OutletsHttpRequest(
            method="POST",
            path="/outlets/mcp",
            body={"entity_id": self.valid_snap.entity_id},
        )
        res = self.router.handle_request(req)
        self.assertEqual(res.status_code, 200)
        body = json.loads(res.body)
        self.assertEqual(body["tool"], "query_facts")
        self.assertEqual(body["total_results"], 1)

    def test_14_unknown_route_and_fail_closed(self):
        req_unknown = OutletsHttpRequest(method="GET", path="/unknown/random/path")
        res_unknown = self.router.handle_request(req_unknown)
        self.assertEqual(res_unknown.status_code, 404)

        class BrokenStore:
            def get_snapshot_record_by_id(self, _id):
                raise RuntimeError("Database connection broken")

        broken_router = OutletsHttpRouter(BrokenStore())
        res_fail = broken_router.handle_request(OutletsHttpRequest(method="GET", path="/outlets/snapshot/test"))
        self.assertEqual(res_fail.status_code, 500)
        body = json.loads(res_fail.body)
        self.assertEqual(body["error"], "INTERNAL_GATE_ROUTER_FAIL_CLOSED")


if __name__ == "__main__":
    unittest.main()
