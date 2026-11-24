"""Unit tests for Caveman Cloud Phase 0/1/2 Python SDK primitives."""
from __future__ import annotations

import io
import json
from typing import Any
import urllib.error

import pytest

from caveman_cloud import (
    AppBridge,
    Apps,
    ComputerPools,
    Listeners,
    PlatformError,
    Predicate,
    Rooms,
    WorkflowContext,
    Workflows,
    WorkflowUncertainEffectError,
)


class _FakeResponse:
    def __init__(self, status: int, body: Any, headers: dict[str, str] | None = None) -> None:
        self.status = status
        self.code = status
        self._raw = json.dumps(body).encode("utf-8") if body is not None else b""
        self.headers = headers or {}

    def read(self, amt: int = -1) -> bytes:
        return self._raw if amt < 0 else self._raw[:amt]

    def __enter__(self) -> _FakeResponse:
        return self

    def __exit__(self, *args: Any) -> None:
        return None


class _MockOpener:
    def __init__(self, handler: Any) -> None:
        self.handler = handler
        self.calls: list[tuple[str, str, dict[str, Any] | None, dict[str, str]]] = []

    def open(self, req: Any, timeout: float = 30.0) -> Any:
        method = req.get_method()
        full_url = req.full_url
        path = full_url.split("://", 1)[1].split("/", 1)[1]
        path = "/" + path
        body = json.loads(req.data.decode("utf-8")) if req.data else None
        headers = {k.lower(): v for k, v in req.header_items()}
        self.calls.append((method, path, body, headers))
        status, resp_body, resp_headers = self.handler(method, path, body, headers)
        if status >= 400:
            fp = io.BytesIO(json.dumps(resp_body).encode("utf-8"))
            err = urllib.error.HTTPError(full_url, status, "err", resp_headers or {}, fp)  # type: ignore[arg-type]
            raise err
        return _FakeResponse(status, resp_body, resp_headers)


def test_rooms_lease_completes_on_success_and_releases_on_error() -> None:
    events: list[str] = []

    def handler(method: str, path: str, body: Any, headers: dict[str, str]) -> tuple[int, Any, dict[str, str]]:
        events.append(f"{method} {path}")
        if path.endswith("/claim"):
            return 200, {"id": "thr_1", "lease_token": "tok_abc", "status": "claimed"}, {}
        if path.endswith("/complete"):
            assert body["lease_token"] == "tok_abc"
            return 200, {"id": "thr_1", "status": "done"}, {}
        if path.endswith("/release"):
            assert body["lease_token"] == "tok_abc"
            assert "boom" in body["note"]
            return 200, {"id": "thr_1", "status": "ready"}, {}
        if path.endswith("/messages"):
            assert headers.get("idempotency-key") == "msg-1"
            return 201, {"id": "msg_1", "seq": 1, "body": body["body"]}, {}
        return 404, {"error": {"code": "not_found", "message": "not found"}}, {}

    opener = _MockOpener(handler)
    rooms = Rooms(control_url="http://127.0.0.1:8080", api_key="cave_live_test", opener=opener)

    with rooms.lease("eng", "thr_1", ttl_seconds=60, session_id="sess_1") as thread:
        assert thread["lease_token"] == "tok_abc"
        msg = rooms.post("eng", "thr_1", body="done", idempotency_key="msg-1")
        assert msg["seq"] == 1

    assert events == [
        "POST /api/v1/code/rooms/eng/threads/thr_1/claim",
        "POST /api/v1/code/rooms/eng/threads/thr_1/messages",
        "POST /api/v1/code/rooms/eng/threads/thr_1/complete",
    ]

    events.clear()
    with pytest.raises(RuntimeError, match="boom"):
        with rooms.lease("eng", "thr_1", ttl_seconds=60):
            raise RuntimeError("boom")

    assert events == [
        "POST /api/v1/code/rooms/eng/threads/thr_1/claim",
        "POST /api/v1/code/rooms/eng/threads/thr_1/release",
    ]


def test_listeners_predicate_and_retry() -> None:
    attempts = 0

    def handler(method: str, path: str, body: Any, headers: dict[str, str]) -> tuple[int, Any, dict[str, str]]:
        nonlocal attempts
        if method == "POST" and path == "/api/v1/code/listeners":
            attempts += 1
            if attempts == 1:
                return 429, {"error": {"code": "rate_limited", "message": "slow down"}}, {"Retry-After": "0"}
            assert body["filter_spec"]["all"][0]["rule"]["op"] == "icontains"
            return 201, {"id": "lst_1", "name": body["name"], "enabled": True}, {}
        if method == "POST" and path == "/api/v1/code/listeners/lst_1/ingest?trusted=true":
            return 200, {"matched": True, "dispatched_target_id": "thr_9"}, {}
        return 404, {"error": {"code": "not_found", "message": "missing"}}, {}

    opener = _MockOpener(handler)
    listeners = Listeners(
        control_url="https://app.caveman.so",
        api_key="cave_live_test",
        retry_delay_seconds=0.0,
        opener=opener,
    )
    pred = Predicate.all_of(
        Predicate.icontains("from", "@acmecorp.com"),
        Predicate.gte("priority", 2),
    )
    created = listeners.create(
        name="acme-watch",
        source_kind="webhook",
        filter_kind="expression",
        filter_spec=pred,
        target_kind="room_post",
        target_id="thr_9",
        ttl_seconds=86400,
    )
    assert created["id"] == "lst_1"
    assert attempts == 2

    ingested = listeners.ingest("lst_1", {"from": "ceo@acmecorp.com", "priority": 3}, trusted=True)
    assert ingested["matched"] is True


def test_workflows_replay_uncertain_effect_and_park() -> None:
    executed_steps: list[str] = []

    def handler(method: str, path: str, body: Any, headers: dict[str, str]) -> tuple[int, Any, dict[str, str]]:
        if path == "/api/v1/code/workflows/deploy-flow/runs":
            return 201, {"id": "run_1", "session_id": "sess_w1", "status": "running"}, {}
        if path == "/api/v1/code/workflows/runs/run_1/steps/begin":
            key = body["step_key"]
            if key == "cached-step":
                return 200, {"action": "cached", "step_key": key, "result": {"ok": True}}, {}
            if key == "uncertain-step":
                return 200, {"action": "uncertain", "step_key": key}, {}
            return 200, {"action": "execute", "step_key": key}, {}
        if path == "/api/v1/code/workflows/runs/run_1/steps/complete":
            return 200, {"ok": True}, {}
        if path == "/api/v1/code/workflows/runs/run_1/wait":
            return 200, {"id": "wait_1", "kind": body["kind"], "ask_id": body.get("ask_id"), "status": "waiting"}, {}
        if path == "/api/v1/code/workflows/runs/run_1/finish":
            return 200, {"id": "run_1", "status": body["status"], "output": body.get("output")}, {}
        return 404, {"error": {"code": "not_found", "message": "missing"}}, {}

    opener = _MockOpener(handler)
    workflows = Workflows(control_url="http://localhost:8080", api_key="cave_live_test", opener=opener)

    # 1. Replay skips cached step and runs live step
    def happy(ctx: WorkflowContext, inp: dict[str, Any]) -> dict[str, Any]:
        def run_cached() -> Any:
            executed_steps.append("should-not-run")
            return None

        def run_live() -> dict[str, Any]:
            executed_steps.append("ran-live")
            return {"env": inp["env"]}

        cached = ctx.step("cached-step", run_cached)
        live = ctx.step("live-step", run_live)
        return {"cached": cached, "live": live}

    result = workflows.execute("deploy-flow", {"env": "prod"}, happy, idempotency_key="run-idem-1")
    assert result["output"] == {"cached": {"ok": True}, "live": {"env": "prod"}}
    assert executed_steps == ["ran-live"]

    # 2. Uncertain external effect fails closed
    with pytest.raises(WorkflowUncertainEffectError) as exc_info:
        workflows.execute(
            "deploy-flow",
            {},
            lambda ctx, _: ctx.step("uncertain-step", lambda: "never", effect="external"),
        )
    assert exc_info.value.step_key == "uncertain-step"

    # 3. Park on human approval returns parked wait cleanly
    parked = workflows.execute(
        "deploy-flow",
        {},
        lambda ctx, _: ctx.wait_for_approval("ask_42", "Approve production deploy"),
    )
    assert parked["run"]["status"] == "waiting"
    assert parked["parked"]["ask_id"] == "ask_42"


def test_apps_bridge_and_computer_pools() -> None:
    def handler(method: str, path: str, body: Any, headers: dict[str, str]) -> tuple[int, Any, dict[str, str]]:
        if path == "/api/v1/code/apps/review-ui/fork":
            return 201, {"id": "app_2", "slug": body["slug"]}, {}
        if path == "/api/v1/code/apps/app_2/bridge":
            if body["action"] == "drive.read":
                return 200, {"path": body["payload"]["path"], "text": "hello", "version": 3}, {}
            if body["action"] == "room.post":
                return 200, {"message": {"id": "msg_9", "body": body["payload"]["body"]}}, {}
        if path == "/api/v1/code/sessions/sess_7/computers":
            if method == "POST":
                return 201, {"id": "lease_1", "computer_id": "cmp_9", "role": body["role"]}, {}
            return 200, {"computers": [{"id": "lease_1", "computer_id": "cmp_9"}]}, {}
        if path == "/api/v1/code/computers/unified?scope=org_pool":
            return 200, {"computers": [{"id": "cmp_9", "scope": "org_pool"}]}, {}
        return 404, {"error": {"code": "not_found", "message": "missing"}}, {}

    opener = _MockOpener(handler)
    apps = Apps(control_url="http://127.0.0.1:8080", api_key="cave_live_test", opener=opener)
    forked = apps.fork("review-ui", slug="review-ui-acme")
    assert forked["slug"] == "review-ui-acme"

    bridge = AppBridge("app_2", control_url="http://127.0.0.1:8080", api_key="capp_tok", opener=opener)
    doc = bridge.drive_read("/report.md")
    assert doc["text"] == "hello"
    posted = bridge.room_post("eng", "thr_1", "Approved via app")
    assert posted["message"]["id"] == "msg_9"

    pools = ComputerPools(control_url="http://127.0.0.1:8080", api_key="cave_live_test", opener=opener)
    lease = pools.lease_for_session("sess_7", pool="gpu-eval", role="experiment")
    assert lease["computer_id"] == "cmp_9"
    assert len(pools.list_for_session("sess_7")) == 1
    assert pools.list_unified("org_pool")[0]["scope"] == "org_pool"


def test_endpoint_validation_rejects_insecure_remote_http() -> None:
    with pytest.raises(PlatformError) as exc:
        Rooms(control_url="http://example.com", api_key="cave_live_test")
    assert exc.value.code == "cave_endpoint_invalid"
