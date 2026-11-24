from __future__ import annotations

import io
import json
import math
import unittest

from caveman_cloud import (
    Cave,
    Gate,
    GateDeniedError,
    GateError,
    GateTimeoutError,
    WorkflowContext,
    WorkflowParkedError,
    Workflows,
)


class _FakeResponse:
    def __init__(self, status: int, body: dict, headers: dict[str, str] | None = None) -> None:
        self.status = status
        self._raw = json.dumps(body).encode("utf-8")
        self.headers = headers or {"content-type": "application/json"}

    def read(self, n: int = -1) -> bytes:
        return self._raw if n < 0 else self._raw[:n]

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None


class _FakeOpener:
    def __init__(self, handlers: dict) -> None:
        self.handlers = handlers
        self.calls: list[tuple[str, str, dict | None]] = []

    def open(self, req, timeout: float = 30.0) -> _FakeResponse:
        method = req.get_method().upper()
        url = req.full_url
        path = url.split("://", 1)[1].split("/", 1)[1]
        path = "/" + path
        body = json.loads(req.data.decode("utf-8")) if req.data else None
        self.calls.append((method, path, body))
        handler = self.handlers.get(f"{method} {path}")
        if handler is None:
            return _FakeResponse(404, {"error": {"code": "not_found", "message": "not found"}})
        status, payload = handler(body)
        return _FakeResponse(status, payload)


class GateTests(unittest.TestCase):
    def test_require_posts_code_gates_with_patch_untrusted_and_polls_approval(self) -> None:
        polls = {"n": 0}

        def handle_create(body: dict) -> tuple[int, dict]:
            self.assertEqual(body["ref_type"], "agent_gate")
            self.assertEqual(body["priority"], 1)
            self.assertNotIn("actions", body)
            diff_art = [a for a in body["artifacts"] if a["type"] == "diff"][0]
            self.assertEqual(diff_art["patch"], "-a\n+b")
            self.assertNotIn("text", diff_art)
            self.assertTrue(diff_art["data_untrusted"])
            return 201, {
                "id": "gate-1",
                "status": "open",
                "ref_type": "agent_gate",
                "ref_id": "stripe.refund",
                "title": body["title"],
                "dedupe_key": "k1",
                "created_at": "2026-11-23T00:00:00Z",
                "data": {},
            }

        def handle_get(_body: dict | None) -> tuple[int, dict]:
            polls["n"] += 1
            if polls["n"] == 1:
                return 200, {"id": "gate-1", "status": "open", "ref_type": "agent_gate", "ref_id": "stripe.refund", "data": {}}
            return 200, {
                "id": "gate-1",
                "status": "resolved",
                "ref_type": "agent_gate",
                "ref_id": "stripe.refund",
                "resolved_at": "2026-11-23T00:01:00Z",
                "data": {"gate_decision": "approved", "gate_decided_by": "alice@acme.test"},
            }

        opener = _FakeOpener(
            {
                "POST /api/v1/code/gates": handle_create,
                "GET /api/v1/code/gates/gate-1": handle_get,
            }
        )
        gate = Gate(control_url="https://app.caveman.so", api_key="cave_live_k", opener=opener)
        decision = gate.require(
            action="stripe.refund",
            summary="Refund $499",
            risk="high",
            cost_usd=499.0,
            diff={"patch": "-a\n+b"},
            poll_interval_seconds=0.25,
            timeout_seconds=5.0,
        )
        self.assertTrue(decision.approved)
        self.assertEqual(decision.decided_by, "alice@acme.test")
        self.assertEqual(polls["n"], 2)

    def test_fails_closed_on_denial_archive_timeout_and_mismatch(self) -> None:
        # Denial
        opener = _FakeOpener(
            {
                "POST /api/v1/code/gates": lambda _b: (
                    201,
                    {"id": "g-deny", "status": "open", "ref_type": "agent_gate", "ref_id": "db.drop", "title": "Drop", "dedupe_key": "k", "created_at": "2026-11-23T00:00:00Z"},
                ),
                "GET /api/v1/code/gates/g-deny": lambda _b: (
                    200,
                    {"id": "g-deny", "status": "resolved", "ref_type": "agent_gate", "ref_id": "db.drop", "data": {"gate_decision": "denied", "gate_decided_by": "bob@acme.test"}},
                ),
            }
        )
        gate = Gate(control_url="https://app.caveman.so", api_key="cave_live_k", opener=opener)
        with self.assertRaises(GateDeniedError) as ctx:
            gate.require(action="db.drop", summary="Drop table", poll_interval_seconds=0.25, timeout_seconds=2.0)
        self.assertEqual(ctx.exception.decision.decided_by, "bob@acme.test")

        # Timeout
        opener_to = _FakeOpener(
            {
                "POST /api/v1/code/gates": lambda _b: (
                    201,
                    {"id": "g-to", "status": "open", "ref_type": "agent_gate", "ref_id": "db.drop", "title": "Drop", "dedupe_key": "k", "created_at": "2026-11-23T00:00:00Z"},
                ),
                "GET /api/v1/code/gates/g-to": lambda _b: (
                    200,
                    {"id": "g-to", "status": "open", "ref_type": "agent_gate", "ref_id": "db.drop", "data": {}},
                ),
            }
        )
        gate_to = Gate(control_url="https://app.caveman.so", api_key="cave_live_k", opener=opener_to)
        with self.assertRaises(GateTimeoutError):
            gate_to.require(action="db.drop", summary="Drop", poll_interval_seconds=0.25, timeout_seconds=0.1)

        # Mismatch
        opener_bad = _FakeOpener(
            {
                "POST /api/v1/code/gates": lambda _b: (
                    201,
                    {"id": "g-ok", "status": "open", "ref_type": "agent_gate", "ref_id": "a", "title": "A", "dedupe_key": "k", "created_at": "2026-11-23T00:00:00Z"},
                ),
                "GET /api/v1/code/gates/g-ok": lambda _b: (
                    200,
                    {"id": "wrong-id", "status": "resolved", "ref_type": "demo", "data": {"gate_decision": "approved"}},
                ),
            }
        )
        gate_bad = Gate(control_url="https://app.caveman.so", api_key="cave_live_k", opener=opener_bad)
        with self.assertRaises(GateError):
            gate_bad.require(action="a", summary="s", poll_interval_seconds=0.25, timeout_seconds=2.0)

    def test_validates_nan_and_cave_gate_and_guard_and_workflow_helpers(self) -> None:
        with self.assertRaises(GateError):
            Gate(control_url="https://app.caveman.so", api_key="k", default_timeout_seconds=math.nan)
        with self.assertRaises(GateError):
            Gate(control_url="https://app.caveman.so", api_key="k", default_poll_interval_seconds=False)  # type: ignore[arg-type]

        seen_facts: list = []

        def handle_create(body: dict) -> tuple[int, dict]:
            seen_facts.append(body["artifacts"][0]["facts"])
            return 201, {"id": "g1", "status": "open", "ref_type": "agent_gate", "ref_id": body["ref_id"], "title": body["title"], "dedupe_key": "k", "created_at": "2026-11-23T00:00:00Z"}

        opener = _FakeOpener(
            {
                "POST /api/v1/code/gates": handle_create,
                "GET /api/v1/code/gates/g1": lambda _b: (
                    200,
                    {"id": "g1", "status": "resolved", "ref_type": "agent_gate", "ref_id": "wire.send", "data": {"gate_decision": "approved", "gate_decided_by": "cfo@acme.test"}},
                ),
                "POST /api/v1/code/workflows/runs/run-1/wait": lambda b: (
                    201,
                    {"id": "w1", "session_id": "s1", "kind": b["kind"], "ask_id": b.get("ask_id"), "target_id": b.get("target_id"), "status": "pending"},
                ),
            }
        )
        cave = Cave(api_key="cave_live_k", base_url="https://gw.caveman.so", control_url="https://app.caveman.so", agent="bot", default_workflow="billing")
        gate = cave.gate(opener=opener)

        @gate.guard(
            action="wire.send",
            summary=lambda amt: f"Send ${amt}",
            facts=lambda amt: [{"label": "Amount", "value": str(amt)}],
            when=lambda amt: amt >= 100,
        )
        def send_wire(amt: int) -> str:
            return f"sent:{amt}"

        self.assertEqual(send_wire(50), "sent:50")
        self.assertEqual(len(seen_facts), 0)
        self.assertEqual(send_wire(500), "sent:500")
        self.assertEqual(len(seen_facts), 1)
        self.assertTrue(any(f["label"] == "Amount" and f["value"] == "500" for f in seen_facts[0]))

        wf = Workflows(control_url="https://app.caveman.so", api_key="cave_live_k", opener=opener)
        wctx = WorkflowContext(wf, "run-1", "s1")
        with self.assertRaises(WorkflowParkedError) as c1:
            wctx.approve("deploy-1", "Deploy prod")
        self.assertEqual(c1.exception.wait["kind"], "approval")
        with self.assertRaises(WorkflowParkedError) as c2:
            wctx.wait_for_sensor("sensor-99", reason="Wait CI")
        self.assertEqual(c2.exception.wait["kind"], "listener_event")
        self.assertEqual(c2.exception.wait["target_id"], "sensor-99")

    def test_security_action_mismatch_deadline_overrun_and_workflow_replay(self) -> None:
        # 1. Dedupe key returning a gate for a different action must fail closed.
        reuse_opener = _FakeOpener(
            {
                "POST /api/v1/code/gates": lambda _b: (
                    200,
                    {"id": "g-old", "status": "resolved", "ref_type": "agent_gate", "ref_id": "read.balance", "title": "Read", "dedupe_key": "k1", "created_at": "2026-11-23T00:00:00Z", "data": {"gate_decision": "approved"}},
                ),
            }
        )
        g_reuse = Gate(control_url="https://app.caveman.so", api_key="cave_live_k", opener=reuse_opener)
        with self.assertRaises(GateError) as err_ctx:
            g_reuse.request(action="db.drop_table", summary="Drop prod", dedupe_key="k1")
        self.assertEqual(err_ctx.exception.code, "cave_gate_protocol_error")

        # 2. 429 Retry-After exceeding wait deadline must raise GateTimeoutError, not accept late approval.
        poll_calls = {"n": 0}

        class _RateLimitOpener(_FakeOpener):
            def open(self, req, timeout: float = 30.0) -> _FakeResponse:
                method = req.get_method().upper()
                path = "/" + req.full_url.split("://", 1)[1].split("/", 1)[1]
                if f"{method} {path}" == "GET /api/v1/code/gates/g-rl":
                    poll_calls["n"] += 1
                    if poll_calls["n"] == 1:
                        return _FakeResponse(429, {"error": {"code": "rate_limited", "message": "slow"}}, headers={"retry-after": "2"})
                    return _FakeResponse(200, {"id": "g-rl", "status": "resolved", "ref_type": "agent_gate", "ref_id": "deploy.prod", "data": {"gate_decision": "approved"}})
                return super().open(req, timeout=timeout)

        rl_opener = _RateLimitOpener(
            {
                "POST /api/v1/code/gates": lambda b: (
                    201,
                    {"id": "g-rl", "status": "open", "ref_type": "agent_gate", "ref_id": b["ref_id"], "title": b["title"], "dedupe_key": "k", "created_at": "2026-11-23T00:00:00Z"},
                ),
            }
        )
        g_rl = Gate(control_url="https://app.caveman.so", api_key="cave_live_k", opener=rl_opener, retries=2)
        with self.assertRaises(GateTimeoutError):
            g_rl.require(action="deploy.prod", summary="Deploy", timeout_seconds=0.12, poll_interval_seconds=0.25)
        self.assertEqual(poll_calls["n"], 1)

        # 3. WorkflowContext replay returns terminal wait row instead of re-raising WorkflowParkedError.
        replay_opener = _FakeOpener(
            {
                "POST /api/v1/code/workflows/runs/run-1/wait": lambda b: (
                    200,
                    {"id": "w-done", "session_id": "s1", "kind": b["kind"], "ask_id": b.get("ask_id"), "target_id": b.get("target_id"), "status": "resolved", "resolved_by": "alice@acme.test"},
                ),
            }
        )
        wf = Workflows(control_url="https://app.caveman.so", api_key="cave_live_k", opener=replay_opener)
        wctx = WorkflowContext(wf, "run-1", "s1")
        row = wctx.approve("deploy-1", "Deploy prod")
        self.assertEqual(row["status"], "resolved")
        srow = wctx.wait_for_sensor("sensor-99", reason="Wait CI")
        self.assertEqual(srow["status"], "resolved")


if __name__ == "__main__":
    unittest.main()
