from __future__ import annotations

import json
import threading
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from caveman_cloud import Cave, OTelExporter, OTelSpan


def _fake_urlopen(response_data: dict[str, Any]) -> MagicMock:
    """Return a context-manager mock that yields a fake HTTP response."""
    body = json.dumps(response_data).encode()
    cm = MagicMock()
    cm.__enter__ = MagicMock(return_value=MagicMock(read=MagicMock(return_value=body)))
    cm.__exit__ = MagicMock(return_value=False)
    return cm


def _attr_map(otlp_attrs: list[dict[str, Any]]) -> dict[str, Any]:
    """Flatten an OTLP attribute list back into {key: scalar} for assertions."""
    out: dict[str, Any] = {}
    for kv in otlp_attrs:
        v = kv["value"]
        if "stringValue" in v:
            out[kv["key"]] = v["stringValue"]
        elif "intValue" in v:
            out[kv["key"]] = v["intValue"]  # proto3 int64 → JSON string
        elif "doubleValue" in v:
            out[kv["key"]] = v["doubleValue"]
        elif "boolValue" in v:
            out[kv["key"]] = v["boolValue"]
    return out


def test_exporter_is_otel_exporter() -> None:
    cave = Cave(api_key="k", base_url="http://localhost:8787", agent="a")
    exp = cave.exporter()
    assert isinstance(exp, OTelExporter)
    assert exp.service_name == "a"
    assert exp.pending == 0


def test_record_span_maps_genai_attributes_and_ids() -> None:
    cave = Cave(api_key="k", base_url="http://localhost:8787", agent="billing-agent")
    exp = cave.exporter()
    span = exp.record_span(
        "chat gpt-5.5",
        provider="openai",
        model="gpt-5.5",
        operation="chat",
        input_tokens=1200,
        output_tokens=350,
        cached_tokens=800,
        cost_usd=0.0145,
        workflow="invoice-flow",
    )
    assert isinstance(span, OTelSpan)
    # Generated ids: 32-hex trace, 16-hex span.
    assert len(span.trace_id) == 32
    assert len(span.span_id) == 16
    assert exp.pending == 1

    attrs = span.attributes
    assert attrs["gen_ai.provider.name"] == "openai"
    assert attrs["gen_ai.request.model"] == "gpt-5.5"
    assert attrs["gen_ai.response.model"] == "gpt-5.5"
    assert attrs["gen_ai.operation.name"] == "chat"
    assert attrs["gen_ai.usage.input_tokens"] == 1200
    assert attrs["gen_ai.usage.output_tokens"] == 350
    assert attrs["gen_ai.usage.cache_read.input_tokens"] == 800
    assert attrs["gen_ai.usage.cost_usd"] == 0.0145
    assert attrs["cave.agent"] == "billing-agent"
    assert attrs["cave.workflow"] == "invoice-flow"


def test_record_span_canonicalizes_valid_ids_and_replaces_or_drops_malformed_ids() -> None:
    exp = Cave(api_key="k", base_url="http://localhost:8787", agent="agent").exporter()
    canonical = exp.record_span(
        "canonical",
        trace_id="ABCDEF0123456789ABCDEF0123456789",
        span_id="ABCDEF0123456789",
        parent_span_id="FEDCBA9876543210",
    )
    assert canonical.trace_id == "abcdef0123456789abcdef0123456789"
    assert canonical.span_id == "abcdef0123456789"
    assert canonical.parent_span_id == "fedcba9876543210"

    malformed = exp.record_span(
        "malformed",
        trace_id="not-a-trace",
        span_id="0" * 16,
        parent_span_id="bad-parent",
    )
    assert len(malformed.trace_id) == 32 and all(c in "0123456789abcdef" for c in malformed.trace_id)
    assert len(malformed.span_id) == 16 and all(c in "0123456789abcdef" for c in malformed.span_id)
    assert malformed.span_id != "0" * 16
    assert malformed.parent_span_id == ""


def test_record_span_omits_malformed_counters_and_reserved_overrides() -> None:
    cave = Cave(api_key="k", base_url="http://localhost:8787", agent="real-agent")
    span = cave.exporter().record_span(
        "bad telemetry",
        input_tokens=10,
        output_tokens=-1,
        cached_tokens=20,
        cost_usd=float("nan"),
        attributes={
            "gen_ai.usage.input_tokens": 999999,
            "gen_ai.usage.cost_usd": 999999,
            "cave.agent": "spoofed-agent",
        },
    )

    assert span.attributes["gen_ai.usage.input_tokens"] == 10
    assert "gen_ai.usage.output_tokens" not in span.attributes
    assert "gen_ai.usage.cache_read.input_tokens" not in span.attributes
    assert "gen_ai.usage.cost_usd" not in span.attributes
    assert span.attributes["cave.agent"] == "real-agent"


def test_export_posts_otlp_payload_with_headers_and_attrs() -> None:
    cave = Cave(
        api_key="cave_live_test_key",
        base_url="http://localhost:8787",
        agent="billing-agent",
        default_workflow="invoice-flow",
    )
    exp = cave.exporter()

    trace = exp.new_trace_id()
    chat = exp.record_span(
        "chat gpt-5.5",
        trace_id=trace,
        provider="openai",
        model="gpt-5.5",
        operation="chat",
        input_tokens=1200,
        output_tokens=350,
        cached_tokens=800,
    )
    exp.record_span(
        "tool_call fetch_invoice",
        trace_id=trace,
        parent_span_id=chat.span_id,
        operation="tool_call",
        tool_name="fetch_invoice",
    )

    captured: list[tuple[str, dict[str, str], dict[str, Any]]] = []

    def fake_urlopen(req, timeout):  # type: ignore[no-untyped-def]
        captured.append((req.full_url, dict(req.headers), json.loads(req.data)))
        return _fake_urlopen({"ok": True, "spans_accepted": 2, "spans_total": 2, "otel_schema_version": "genai-2026-06"})

    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        result = exp.export()

    assert len(captured) == 1
    url, hdrs, body = captured[0]

    # POSTs to the OTLP traces endpoint.
    assert url == "http://localhost:8787/v1/traces"

    # Caveman headers (urllib capitalises keys).
    assert hdrs["X-cave-api-key"] == "cave_live_test_key"
    assert hdrs["X-cave-agent"] == "billing-agent"
    assert "X-cave-workflow" not in hdrs
    assert hdrs["Content-type"] == "application/json"

    # OTLP/JSON shape: resourceSpans -> scopeSpans -> spans.
    rs = body["resourceSpans"]
    assert len(rs) == 1
    res_attrs = _attr_map(rs[0]["resource"]["attributes"])
    assert res_attrs["service.name"] == "billing-agent"
    spans = rs[0]["scopeSpans"][0]["spans"]
    assert len(spans) == 2

    chat_span = spans[0]
    assert chat_span["traceId"] == trace
    assert chat_span["parentSpanId"] == ""
    assert chat_span["status"]["code"] == 1
    # Nanosecond timestamps are encoded as strings (proto3 int64 → JSON string).
    assert isinstance(chat_span["startTimeUnixNano"], str)
    chat_attrs = _attr_map(chat_span["attributes"])
    assert chat_attrs["gen_ai.provider.name"] == "openai"
    assert chat_attrs["gen_ai.response.model"] == "gpt-5.5"
    # Token counts encoded as intValue strings.
    assert chat_attrs["gen_ai.usage.input_tokens"] == "1200"
    assert chat_attrs["gen_ai.usage.output_tokens"] == "350"
    assert chat_attrs["gen_ai.usage.cache_read.input_tokens"] == "800"

    tool_span = spans[1]
    assert tool_span["parentSpanId"] == chat.span_id
    tool_attrs = _attr_map(tool_span["attributes"])
    assert tool_attrs["gen_ai.tool.name"] == "fetch_invoice"
    assert tool_attrs["gen_ai.operation.name"] == "tool_call"

    # Parsed gateway response returned; buffer cleared.
    assert result["ok"] is True
    assert result["spans_accepted"] == 2
    assert exp.pending == 0


def test_error_status_maps_to_code_2() -> None:
    cave = Cave(api_key="k", base_url="http://localhost:8787", agent="a")
    exp = cave.exporter()
    span = exp.record_span("failed-call", status="error")
    assert span.to_otlp()["status"]["code"] == 2


def test_unknown_runtime_status_fails_closed_to_unset() -> None:
    cave = Cave(api_key="k", base_url="http://localhost:8787", agent="a")
    span = cave.exporter().record_span("future-status", status="future-status")
    assert span.to_otlp()["status"]["code"] == 0


def test_export_empty_is_noop_no_network() -> None:
    cave = Cave(api_key="k", base_url="http://localhost:8787", agent="a")
    exp = cave.exporter()

    def boom(req, timeout):  # type: ignore[no-untyped-def]
        raise AssertionError("export() must not hit the network when empty")

    with patch("caveman_cloud.core._OPENER.open", side_effect=boom):
        result = exp.export()
    assert result == {"ok": True, "spans_accepted": 0, "spans_total": 0}


def test_overlapping_exports_serialize_without_duplicate_or_dropped_spans() -> None:
    cave = Cave(api_key="k", base_url="http://localhost:8787", agent="a")
    exp = cave.exporter()
    exp.record_span("before-export")
    first_started = threading.Event()
    release_first = threading.Event()
    captured: list[list[str]] = []
    errors: list[BaseException] = []

    def fake_urlopen(req, timeout):  # type: ignore[no-untyped-def]
        payload = json.loads(req.data)
        spans = payload["resourceSpans"][0]["scopeSpans"][0]["spans"]
        captured.append([span["name"] for span in spans])
        if len(captured) == 1:
            first_started.set()
            assert release_first.wait(timeout=2)
        return _fake_urlopen({})

    def run_export() -> None:
        try:
            exp.export()
        except BaseException as exc:
            errors.append(exc)

    with patch("caveman_cloud.core._OPENER.open", side_effect=fake_urlopen):
        first = threading.Thread(target=run_export)
        first.start()
        assert first_started.wait(timeout=2)
        exp.record_span("during-export")
        second = threading.Thread(target=run_export)
        second.start()
        assert exp.pending == 2
        assert captured == [["before-export"]]
        release_first.set()
        first.join(timeout=2)
        second.join(timeout=2)

    assert not first.is_alive()
    assert not second.is_alive()
    assert errors == []
    assert captured == [["before-export"], ["during-export"]]
    assert exp.pending == 0


def test_custom_service_name() -> None:
    cave = Cave(api_key="k", base_url="http://localhost:8787", agent="a")
    exp = cave.exporter(service_name="custom-svc")
    exp.record_span("op")
    payload = exp.build_payload()
    res_attrs = _attr_map(payload["resourceSpans"][0]["resource"]["attributes"])
    assert res_attrs["service.name"] == "custom-svc"


def test_trace_and_mixed_span_workflows_are_not_overridden_by_export_headers() -> None:
    cave = Cave(api_key="k", base_url="http://localhost:8787", agent="a", default_workflow="default-job")
    with cave.trace(workflow="invoice-job") as trace:
        exp = trace.exporter()
        exp.record_span("inherited")
        exp.record_span("explicit", workflow="other-job")
        captured = []
        def send(req, timeout):
            captured.append(req)
            return _fake_urlopen({})
        with patch("caveman_cloud.core._OPENER.open", side_effect=send):
            exp.export()
    assert "X-cave-workflow" not in captured[0].headers
    spans = json.loads(captured[0].data)["resourceSpans"][0]["scopeSpans"][0]["spans"]
    assert [_attr_map(s["attributes"])["cave.workflow"] for s in spans] == ["invoice-job", "other-job"]


def test_export_splits_count_and_retries_only_unsent_chunks() -> None:
    exp = Cave(api_key="k", base_url="http://localhost:8787", agent="a").exporter()
    for i in range(10001):
        exp.record_span(str(i))
    sent = []
    def send(req, timeout):
        spans = json.loads(req.data)["resourceSpans"][0]["scopeSpans"][0]["spans"]
        sent.append([span["name"] for span in spans])
        if len(sent) == 2:
            assert exp.pending == 1
            exp.record_span("concurrent")
            raise OSError("fixture failure")
        return _fake_urlopen({})
    with patch("caveman_cloud.core._OPENER.open", side_effect=send):
        with pytest.raises(OSError, match="fixture failure"):
            exp.export()
        assert exp.pending == 2
        exp.export()
    assert [len(batch) for batch in sent] == [10000, 1, 2]
    assert sent[-1] == ["10000", "concurrent"]
    assert exp.pending == 0


def test_export_bounds_encoded_bytes_and_keeps_partial_success_visible() -> None:
    exp = Cave(api_key="k", base_url="http://localhost:8787", agent="a").exporter()
    for i in range(5):
        exp.record_span(str(i), attributes={"label": "漢" * 350000})
    sent = []
    def send(req, timeout):
        sent.append(req.data)
        return _fake_urlopen({"partialSuccess": {"rejectedSpans": "1", "errorMessage": "fixture rejection"}} if len(sent) == 1 else {})
    with patch("caveman_cloud.core._OPENER.open", side_effect=send):
        result = exp.export()
    assert len(sent) > 1
    assert all(len(body) <= 4 * 1024 * 1024 for body in sent)
    assert sum(len(json.loads(body)["resourceSpans"][0]["scopeSpans"][0]["spans"]) for body in sent) == 5
    assert result["partialSuccess"] == {"rejectedSpans": "1", "errorMessage": "fixture rejection"}
    assert exp.pending == 0


def test_single_oversized_span_fails_explicitly_once_and_keeps_every_other_span() -> None:
    exp = Cave(api_key="k", base_url="http://localhost:8787", agent="a").exporter()
    exp.record_span("small")
    exp.record_span("oversized", attributes={"label": "x" * (4 * 1024 * 1024)})
    with patch("caveman_cloud.core._OPENER.open") as send:
        with pytest.raises(ValueError, match="OTLP span exceeds"):
            exp.export()
        send.assert_not_called()
    # The span that can never fit is gone; it no longer blocks the ones behind it.
    assert exp.pending == 1
    sent = []
    def deliver(req, timeout):
        sent.extend(span["name"] for span in json.loads(req.data)["resourceSpans"][0]["scopeSpans"][0]["spans"])
        return _fake_urlopen({})
    with patch("caveman_cloud.core._OPENER.open", side_effect=deliver):
        exp.export()
    assert sent == ["small"]
    assert exp.pending == 0


def test_a_batch_the_gateway_refuses_for_its_content_is_dropped_and_a_transient_failure_is_kept() -> None:
    import io
    import urllib.error

    exp = Cave(api_key="k", base_url="http://localhost:8787", agent="a").exporter()

    def refuse(code: int):
        def send(req, timeout):
            raise urllib.error.HTTPError(req.full_url, code, "refused", {}, io.BytesIO(b"{}"))
        return send

    # 503 is the gateway's problem: the spans wait for the next export.
    exp.record_span("kept")
    with patch("caveman_cloud.core._OPENER.open", side_effect=refuse(503)):
        with pytest.raises(urllib.error.HTTPError):
            exp.export()
    assert exp.pending == 1
    # 400 is the batch's: re-queued, it would fail every later export and hold back the rest.
    with patch("caveman_cloud.core._OPENER.open", side_effect=refuse(400)):
        with pytest.raises(urllib.error.HTTPError):
            exp.export()
    assert exp.pending == 0
    exp.record_span("after")
    sent = []
    def deliver(req, timeout):
        sent.extend(span["name"] for span in json.loads(req.data)["resourceSpans"][0]["scopeSpans"][0]["spans"])
        return _fake_urlopen({})
    with patch("caveman_cloud.core._OPENER.open", side_effect=deliver):
        exp.export()
    assert sent == ["after"]
    assert exp.pending == 0
