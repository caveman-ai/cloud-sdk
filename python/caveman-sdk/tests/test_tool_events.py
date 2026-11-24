"""Mirrored tool-event producer contract. See sdk-typescript tool-events.runtime.mjs."""

from __future__ import annotations

import asyncio
import json
import os
import queue
import threading
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from caveman_cloud import Cave

TRACE_ID = "aaaabbbbccccddddeeeeffff00001111"
SPAN_ID = "1122334455667788"


def _response() -> MagicMock:
    body = json.dumps({"ok": True}).encode()
    context = MagicMock()
    context.__enter__ = MagicMock(return_value=MagicMock(read=MagicMock(return_value=body)))
    context.__exit__ = MagicMock(return_value=False)
    return context


def _capture(*, fail: bool = False) -> tuple[list[dict[str, Any]], Any]:
    captured: list[dict[str, Any]] = []

    def fake_urlopen(req: Any, timeout: float) -> MagicMock:  # noqa: ANN401
        captured.append(
            {
                "url": req.full_url,
                "method": req.get_method(),
                "headers": {key.lower(): value for key, value in dict(req.headers).items()},
                "body": json.loads(req.data),
            }
        )
        if fail:
            raise OSError("telemetry-transport-secret")
        return _response()

    return captured, fake_urlopen


def _cave() -> Cave:
    return Cave(api_key="cave_live_test", base_url="http://localhost:8787", agent="tool-event-agent")


def _assert_event(request: dict[str, Any], *, name: str, outcome: str, sequence: int, workflow: str = "unlabeled-workflow") -> None:
    assert request["url"] == "http://localhost:8787/sdk/v1/events"
    assert request["method"] == "POST"
    assert request["headers"]["x-cave-trace-id"] == TRACE_ID
    assert request["headers"]["x-cave-parent-span-id"] == SPAN_ID
    assert request["headers"]["x-cave-workflow"] == workflow
    assert request["body"]["span_type"] == "tool.call"
    assert request["body"]["name"] == name
    assert request["body"]["workflow"] == workflow
    assert request["body"]["outcome"] == outcome
    assert request["body"]["sequence"] == sequence
    assert isinstance(request["body"]["sequence"], int) and not isinstance(request["body"]["sequence"], bool) and request["body"]["sequence"] > 0
    assert isinstance(request["body"]["duration_ms"], int) and not isinstance(request["body"]["duration_ms"], bool) and request["body"]["duration_ms"] >= 0
    assert sorted(request["body"]) == sorted(("duration_ms", "name", "options", "outcome", "sequence", "span_type", "tags", "workflow"))


def test_success_returns_original_value_and_emits_joined_ok_event() -> None:
    captured, fake_urlopen = _capture()
    original = {"exact": "result"}
    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        with _cave().trace(workflow="event-workflow", tags={"env": "test"}, trace_id=TRACE_ID, span_id=SPAN_ID) as trace:
            result = trace.tool("lookup", {"read_only": True}, lambda: original)
    assert result is original
    assert len(captured) == 1
    _assert_event(captured[0], name="lookup", outcome="ok", sequence=1, workflow="event-workflow")


def test_synchronous_and_asynchronous_failures_emit_error_without_exception_leakage() -> None:
    captured, fake_urlopen = _capture()
    sync_error = RuntimeError("private-sync-exception-message")

    def sync_failure() -> Any:
        raise sync_error

    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        with _cave().trace(trace_id=TRACE_ID, span_id=SPAN_ID) as trace:
            with pytest.raises(RuntimeError) as raised:
                trace.tool("sync-danger", {}, sync_failure)
    assert raised.value is sync_error
    _assert_event(captured[0], name="sync-danger", outcome="error", sequence=1)
    assert sync_error.args[0] not in json.dumps(captured[0]["body"])

    captured, fake_urlopen = _capture()
    async_error = RuntimeError("private-async-exception-message")

    async def async_failure() -> Any:
        raise async_error

    async def run_async_failure() -> None:
        with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
            with _cave().trace(trace_id=TRACE_ID, span_id=SPAN_ID) as trace:
                await trace.tool("async-danger", {}, async_failure)

    with pytest.raises(RuntimeError) as raised:
        asyncio.run(run_async_failure())
    assert raised.value is async_error
    _assert_event(captured[0], name="async-danger", outcome="error", sequence=1)
    wire = json.dumps(captured[0]["body"])
    assert async_error.args[0] not in wire
    assert "traceback" not in wire


def test_cancellation_is_error_and_original_cancellation_propagates() -> None:
    captured, fake_urlopen = _capture()

    async def cancelled() -> Any:
        raise asyncio.CancelledError("private-cancel-message")

    async def run_cancelled() -> None:
        with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
            with _cave().trace(trace_id=TRACE_ID, span_id=SPAN_ID) as trace:
                await trace.tool("cancelled", {}, cancelled)

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(run_cancelled())
    _assert_event(captured[0], name="cancelled", outcome="error", sequence=1)
    assert "private-cancel-message" not in json.dumps(captured[0]["body"])


def test_telemetry_failure_never_changes_successful_return_or_original_throw() -> None:
    captured, fake_urlopen = _capture(fail=True)
    value = {"preserved": True}
    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        with _cave().trace(trace_id=TRACE_ID, span_id=SPAN_ID) as trace:
            assert trace.tool("ok", {}, lambda: value) is value
    _assert_event(captured[0], name="ok", outcome="ok", sequence=1)

    captured, fake_urlopen = _capture(fail=True)
    original = RuntimeError("original-tool-secret")

    def fail() -> Any:
        raise original

    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        with _cave().trace(trace_id=TRACE_ID, span_id=SPAN_ID) as trace:
            with pytest.raises(RuntimeError) as raised:
                trace.tool("bad", {}, fail)
    assert raised.value is original
    _assert_event(captured[0], name="bad", outcome="error", sequence=1)
    assert original.args[0] not in json.dumps(captured[0]["body"])


def test_sequence_follows_start_order_when_async_completions_reverse() -> None:
    captured, fake_urlopen = _capture()

    async def run() -> None:
        first_gate = asyncio.Event()

        async def first() -> str:
            await first_gate.wait()
            return "first-result"

        async def second() -> str:
            return "second-result"

        with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
            with _cave().trace(trace_id=TRACE_ID, span_id=SPAN_ID) as trace:
                first_call = trace.tool("first", {}, first)
                second_call = trace.tool("second", {}, second)
                assert await second_call == "second-result"
                first_gate.set()
                assert await first_call == "first-result"

    asyncio.run(run())
    assert len(captured) == 2
    sent = {request["body"]["name"]: request for request in captured}
    _assert_event(sent["second"], name="second", outcome="ok", sequence=2)
    _assert_event(sent["first"], name="first", outcome="ok", sequence=1)


def test_each_trace_owns_independent_sequence() -> None:
    captured, fake_urlopen = _capture()
    cave = _cave()
    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        with cave.trace(trace_id=TRACE_ID, span_id=SPAN_ID) as first:
            first.tool("one", {}, lambda: 1)
        with cave.trace(trace_id=TRACE_ID, span_id=SPAN_ID) as second:
            second.tool("two", {}, lambda: 2)
    assert [request["body"]["sequence"] for request in captured] == [1, 1]


def test_sequence_increment_is_thread_safe() -> None:
    captured, fake_urlopen = _capture()
    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        with _cave().trace(trace_id=TRACE_ID, span_id=SPAN_ID) as trace:
            with ThreadPoolExecutor(max_workers=8) as executor:
                results = list(executor.map(lambda index: trace.tool(f"tool-{index}", {}, lambda: index), range(64)))
    assert results == list(range(64))
    assert sorted(request["body"]["sequence"] for request in captured) == list(range(1, 65))


def test_tool_returns_before_its_telemetry_post_and_trace_exit_waits_for_it() -> None:
    captured, fake_urlopen = _capture()
    release = threading.Event()
    sent = threading.Event()

    def slow_urlopen(req: Any, timeout: float) -> MagicMock:  # noqa: ANN401
        response = fake_urlopen(req, timeout)
        release.wait(5)
        sent.set()
        return response

    threading.Timer(0.5, release.set).start()
    with patch("caveman_cloud.core._OPENER.open", side_effect=slow_urlopen):
        with _cave().trace(trace_id=TRACE_ID, span_id=SPAN_ID) as trace:
            started = time.monotonic()
            assert trace.tool("slow-telemetry", {}, lambda: "result") == "result"
            assert time.monotonic() - started < 0.25, "tool waited for its telemetry POST"
            assert not sent.is_set()
        assert sent.is_set(), "trace exit returned before the tool event was sent"
    _assert_event(captured[0], name="slow-telemetry", outcome="ok", sequence=1)


def test_async_tool_never_blocks_the_event_loop_on_telemetry() -> None:
    captured, fake_urlopen = _capture()
    release = threading.Event()

    def slow_urlopen(req: Any, timeout: float) -> MagicMock:  # noqa: ANN401
        release.wait(5)
        return fake_urlopen(req, timeout)

    async def tool() -> str:
        return "result"

    async def run() -> float:
        with patch("caveman_cloud.core._OPENER.open", side_effect=slow_urlopen):
            with _cave().trace(trace_id=TRACE_ID, span_id=SPAN_ID) as trace:
                started = time.monotonic()
                assert await trace.tool("async-slow-telemetry", {}, tool) == "result"
                elapsed = time.monotonic() - started
                release.set()
        return elapsed

    assert asyncio.run(run()) < 0.25, "the event loop waited for a telemetry POST"
    _assert_event(captured[0], name="async-slow-telemetry", outcome="ok", sequence=1)


def test_tool_event_past_the_queue_bound_is_dropped_counted_and_logged(caplog: pytest.LogCaptureFixture) -> None:
    from caveman_cloud import core

    full: queue.Queue[Any] = queue.Queue(maxsize=1)
    full.put_nowait(object())
    with patch.object(core, "_tool_events", full), patch.object(core, "_tool_events_dropped", 0):
        trace = core.Trace(_cave(), "unlabeled-workflow", {}, trace_id=TRACE_ID, span_id=SPAN_ID)
        with caplog.at_level("WARNING", logger="caveman_cloud"):
            assert trace.tool("dropped", {}, lambda: "result") == "result"
            assert trace.tool("dropped-again", {}, lambda: "result") == "result"
        assert full.qsize() == 1
        assert core._tool_events_dropped == 2
        assert trace._pending_tool_events.wait(0), "a dropped event left its trace waiting"
    assert [record.getMessage() for record in caplog.records] == ["caveman_cloud: tool-event queue full (1000); dropping tool events"]


def test_concurrent_traces_wait_only_for_their_own_events() -> None:
    """Traces exiting together each wait about one send, not for each other or
    for a stuck event another trace queued."""
    from caveman_cloud import core

    captured, fake_urlopen = _capture()
    stuck = threading.Event()

    def slow_urlopen(req: Any, timeout: float) -> MagicMock:  # noqa: ANN401
        response = fake_urlopen(req, timeout)
        if json.loads(req.data)["name"] == "stuck":
            stuck.wait(10)
        else:
            time.sleep(0.2)
        return response

    cave = _cave()

    def run(name: str | None) -> float:
        with cave.trace(trace_id=TRACE_ID, span_id=SPAN_ID) as trace:
            if name is not None:
                trace.tool(name, {}, lambda: name)
            started = time.monotonic()
        return time.monotonic() - started

    with patch("caveman_cloud.core._OPENER.open", side_effect=slow_urlopen):
        try:
            core.Trace(cave, "unlabeled-workflow", {}, trace_id=TRACE_ID, span_id=SPAN_ID).tool("stuck", {}, lambda: None)
            with ThreadPoolExecutor(max_workers=7) as executor:
                waits = list(executor.map(run, [f"tool-{index}" for index in range(6)] + [None]))
        finally:
            stuck.set()
            assert core._tool_events_pending.wait(5)
    assert max(waits[:6]) < 0.5, f"trace exits waited {waits[:6]} for a 0.2 s send"
    assert waits[6] < 0.1, f"a trace with no tool calls waited {waits[6]:.2f} s"
    assert len(captured) == 7


@pytest.mark.skipif(not hasattr(os, "fork"), reason="needs os.fork")
def test_forked_child_queues_tool_events_while_the_parent_held_the_lock() -> None:
    from caveman_cloud import core

    held, release = threading.Event(), threading.Event()

    def hold() -> None:
        with core._tool_events_lock:
            held.set()
            release.wait(10)

    holder = threading.Thread(target=hold)
    holder.start()
    try:
        assert held.wait(5)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)  # fork() with threads running
            pid = os.fork()
        if pid == 0:
            code = 1
            try:
                with patch("caveman_cloud.core._OPENER.open", side_effect=_capture()[1]):
                    with _cave().trace(trace_id=TRACE_ID, span_id=SPAN_ID) as trace:
                        trace.tool("in-child", {}, lambda: None)
                code = 0
            except BaseException as error:  # noqa: BLE001 — report, then leave the child.
                os.write(2, f"child: {error!r}\n".encode())
            finally:
                os._exit(code)
        deadline = time.monotonic() + 10
        while (status := os.waitpid(pid, os.WNOHANG))[0] == 0 and time.monotonic() < deadline:
            time.sleep(0.02)
        if status[0] == 0:
            os.kill(pid, 9)
            os.waitpid(pid, 0)
            pytest.fail("forked child deadlocked queueing a tool event")
        assert os.waitstatus_to_exitcode(status[1]) == 0
    finally:
        release.set()
        holder.join()


class _Gateway:
    """A loopback gateway whose /sdk/v1/events answers the scripted statuses,
    then 202."""

    def __init__(self, statuses: list[int], retry_after: str | None = None) -> None:
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        self.statuses = list(statuses)
        self.names: list[str] = []
        gateway = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                gateway.names.append(body["name"])
                status = gateway.statuses.pop(0) if gateway.statuses else 202
                self.send_response(status)
                if status != 202 and retry_after is not None:
                    self.send_header("Retry-After", retry_after)
                self.send_header("content-length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.cave = Cave(api_key="cave_live_test", base_url=f"http://127.0.0.1:{self.server.server_port}", agent="tool-event-agent")

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.mark.parametrize("status", [503, 429])
def test_tool_event_the_gateway_did_not_take_is_sent_again(status: int) -> None:
    """503 cave_event_backpressure / cave_gateway_draining and 429 mean the
    event was not accepted; the gateway asks for a retry."""
    gateway = _Gateway([status, status], retry_after="0.01")
    try:
        with gateway.cave.trace(trace_id=TRACE_ID, span_id=SPAN_ID) as trace:
            assert trace.tool("retried", {}, lambda: "result") == "result"
        assert gateway.names == ["retried"] * 3
    finally:
        gateway.close()


def test_tool_event_refused_for_good_is_not_resent() -> None:
    gateway = _Gateway([400])
    try:
        with gateway.cave.trace(trace_id=TRACE_ID, span_id=SPAN_ID) as trace:
            trace.tool("invalid", {}, lambda: None)
        assert gateway.names == ["invalid"]
    finally:
        gateway.close()


def test_undelivered_tool_events_are_counted_and_logged_once(caplog: pytest.LogCaptureFixture) -> None:
    from caveman_cloud import core

    gateway = _Gateway([401, 401])
    try:
        with patch.object(core, "_tool_events_failed", 0), caplog.at_level("WARNING", logger="caveman_cloud"):
            with gateway.cave.trace(trace_id=TRACE_ID, span_id=SPAN_ID) as trace:
                assert trace.tool("lost", {}, lambda: "result") == "result"
                assert trace.tool("lost-again", {}, lambda: "result") == "result"
            assert core._tool_events_failed == 2
            core._drain_tool_events()
    finally:
        gateway.close()
    assert [record.getMessage() for record in caplog.records] == [
        "caveman_cloud: a tool event was not delivered (HTTP 401); later failures are counted, not logged",
        "caveman_cloud: 2 tool events were not delivered",
    ]


def test_retry_after_longer_than_the_flush_window_is_not_slept() -> None:
    gateway = _Gateway([429], retry_after="60")
    try:
        started = time.monotonic()
        with gateway.cave.trace(trace_id=TRACE_ID, span_id=SPAN_ID) as trace:
            trace.tool("rate-limited", {}, lambda: None)
        assert time.monotonic() - started < 2
        assert gateway.names == ["rate-limited"]
    finally:
        gateway.close()
