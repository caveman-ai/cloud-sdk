from __future__ import annotations

from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import threading
from typing import Any

import pytest

from caveman_cloud import Caveman, PlatformError


class _MockServer:
    def __init__(self) -> None:
        self.requests: list[tuple[str, str, Any]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:
                return

            def _handle(self, method: str) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length).decode("utf-8") if length else ""
                body = json.loads(raw) if raw else None
                outer.requests.append((method, self.path, body))
                status = 200
                resp: dict[str, Any] = {}
                if self.path == "/v1/models":
                    resp = {"data": [{"id": "anthropic/claude-sonnet-4-6"}]}
                elif self.path == "/api/v1/credits":
                    resp = {"balance_usd": 25.0}
                elif self.path == "/api/v1/code/drives":
                    resp = {"drives": [{"id": "drv_1", "name": "knowledge"}]}
                elif self.path == "/api/v1/code/drives/knowledge/grep":
                    resp = {"matches": [{"path": "/policy.md", "line": 2, "text": "refund", "cut": False, "version": 1}], "coverage": {}}
                elif self.path == "/api/v1/code/connectors":
                    resp = {"connectors": [{"name": "slack", "state": "connected"}]}
                elif self.path == "/api/v1/code/secrets" and method == "PUT":
                    resp = {"name": "STRIPE_KEY", "scope": "org"}
                elif self.path == "/api/v1/code/secrets" and method == "GET":
                    resp = {"secrets": [{"name": "STRIPE_KEY", "scope": "org"}]}
                elif self.path == "/api/v1/code/deployments/triage/sessions":
                    resp = {"id": "sess_1", "status": "running"}
                elif self.path == "/api/v1/code/rooms":
                    resp = {"rooms": [{"id": "rm_1", "slug": "ops"}]}
                elif self.path == "/api/v1/code/apps":
                    resp = {"apps": [{"id": "app_1", "slug": "dash"}]}
                else:
                    status = 404
                    resp = {"error": {"code": "not_found", "message": self.path}}
                payload = json.dumps(resp).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self) -> None:
                self._handle("GET")

            def do_POST(self) -> None:
                self._handle("POST")

            def do_PUT(self) -> None:
                self._handle("PUT")

            def do_DELETE(self) -> None:
                self._handle("DELETE")

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def test_caveman_requires_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CAVEMAN_API_KEY", raising=False)
    monkeypatch.delenv("CAVE_TOKEN", raising=False)
    with pytest.raises(PlatformError) as exc:
        Caveman()
    assert exc.value.code == "cave_auth_required"


def test_caveman_unified_namespaces() -> None:
    srv = _MockServer()
    try:
        cv = Caveman(api_key="cave_live_test", base_url=srv.url, control_url=srv.url)
        assert cv.inference.models()[0]["id"] == "anthropic/claude-sonnet-4-6"
        assert cv.credits.get()["balance_usd"] == 25.0
        assert cv.drives.list()[0]["name"] == "knowledge"
        assert cv.drives.drive("knowledge").grep({"pattern": "refund"})["matches"][0]["path"] == "/policy.md"
        assert cv.connectors.list()[0]["name"] == "slack"
        assert cv.secrets.set({"name": "STRIPE_KEY", "value": "sk_test"})["name"] == "STRIPE_KEY"
        assert cv.secrets.list()[0]["name"] == "STRIPE_KEY"
        assert cv.agents.run("triage", {"request_id": "req_1", "task": "Inspect"})["id"] == "sess_1"
        assert cv.rooms.list()[0]["slug"] == "ops"
        assert cv.apps.list()[0]["slug"] == "dash"
    finally:
        srv.close()
