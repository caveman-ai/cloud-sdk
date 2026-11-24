"""Installed package -> generated YAML -> real LiteLLM -> local provider socket.

Provider and ranking responses are deterministic fixtures. This proves gateway
integration, not model quality, production deployment, or monetary savings.
"""

from __future__ import annotations

import base64
import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest

from caveman_router_setup import setup

pytestmark = pytest.mark.conformance


def isolated_env(**values):
    # Do not inherit provider credentials or service URLs from a developer/CI shell.
    return {
        **{
            key: os.environ[key]
            for key in ("PATH", "SYSTEMROOT", "TMPDIR", "TEMP", "LANG")
            if key in os.environ
        },
        **values,
    }


class FixtureServer(ThreadingHTTPServer):
    daemon_threads = True
    route_mode = "ranked"
    provider_error = False
    all_providers_error = False

    def __init__(self):
        super().__init__(("127.0.0.1", 0), FixtureHandler)
        self.calls = []
        self.exports = []


class FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass  # Expected when the adapter enforces its deadline.

    def do_POST(self):
        raw = self.rfile.read(int(self.headers["content-length"]))
        if self.path == "/v1/traces":
            from google.protobuf.json_format import MessageToDict
            from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
                ExportTraceServiceRequest,
            )

            payload = ExportTraceServiceRequest.FromString(raw)
            body = MessageToDict(payload, use_integers_for_enums=True)
            for resource in body.get("resourceSpans", []):
                for scope in resource.get("scopeSpans", []):
                    for span in scope.get("spans", []):
                        for key in ("traceId", "spanId", "parentSpanId"):
                            if key in span:
                                span[key] = base64.b64decode(span[key]).hex()
            self.server.exports.append(
                {"body": body, "headers": dict(self.headers)}
            )
            self.send_response(200)
            self.send_header("content-type", "application/x-protobuf")
            self.send_header("content-length", "0")
            self.end_headers()
            return
        body = json.loads(raw)
        self.server.calls.append({"path": self.path, "body": body, "headers": dict(self.headers)})
        if self.path == "/v1/route":
            mode = self.server.route_mode
            if mode == "timeout":
                time.sleep(0.5)
            if mode == "error":
                self.reply(503, {"error": "unavailable"})
            else:
                # "unavailable": Cloud made no decision and answers the asked
                # model, models[0].
                self.reply(
                    200,
                    {
                        "model": {
                            "invalid": "unregistered-model",
                            "anthropic": "anthropic/claude-haiku-4-5-20251001",
                            "unavailable": body["models"][0],
                        }.get(mode, "openai/gpt-4o-mini"),
                        "reason": "no_features" if mode == "unavailable" else "ask_xlow",
                    },
                )
            return
        if self.server.all_providers_error or (self.server.provider_error and self.path.startswith("/cheap/")):
            self.reply(503, {"error": {"message": "provider unavailable", "type": "server_error"}})
            return
        if self.path.endswith("/chat/completions"):
            if body.get("stream"):
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.end_headers()
                for delta, finish in [({"role": "assistant", "content": "OK"}, None), ({}, "stop")]:
                    chunk = {
                        "id": "chatcmpl-fixture",
                        "object": "chat.completion.chunk",
                        "created": 1,
                        "model": body["model"],
                        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                    }
                    self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                    self.wfile.flush()
                if body.get("stream_options", {}).get("include_usage"):
                    chunk["choices"] = []
                    chunk["usage"] = {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3}
                    self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                self.wfile.write(b"data: [DONE]\n\n")
            else:
                self.reply(
                    200,
                    {
                        "id": "chatcmpl-fixture",
                        "object": "chat.completion",
                        "created": 1,
                        "model": body["model"],
                        "choices": [
                            {
                                "index": 0,
                                "message": {"role": "assistant", "content": "OK"},
                                "finish_reason": "stop",
                            }
                        ],
                        "usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3},
                    },
                )
            return
        if self.path == "/anthropic/v1/messages":
            self.reply(
                200,
                {
                    "id": "msg_fixture",
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-haiku-4-5-20251001",
                    "content": [{"type": "text", "text": "OK"}],
                    "stop_reason": "end_turn",
                    "usage": {"input_tokens": 2, "output_tokens": 1},
                },
            )
            return
        self.reply(404, {"error": "fixture endpoint unsupported"})


@pytest.fixture(scope="module")
def gateway(tmp_path_factory, request):
    root = tmp_path_factory.mktemp("litellm-conformance")
    fixture = FixtureServer()
    thread = threading.Thread(target=fixture.serve_forever, daemon=True)
    thread.start()
    origin = f"http://127.0.0.1:{fixture.server_port}"
    # Existing callback proves that setup keeps relative module resolution and order.
    (root / "existing.py").write_text("""from litellm.integrations.custom_logger import CustomLogger
class Existing(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        data["user"] = "callback-saw-" + data["model"]
        return data
handler = Existing()
""")
    (root / "auth.py").write_text("""from litellm.proxy._types import UserAPIKeyAuth
async def authenticate(request, api_key):
    models = ["premium"] if api_key == "restricted" else []
    return UserAPIKeyAuth(api_key=api_key, models=models)
""")
    config = root / "config.yaml"
    config.write_text(f"""model_list:
  - model_name: premium
    litellm_params:
      model: openai/gpt-4o
      api_base: {origin}/premium/v1
      api_key: os.environ/PREMIUM_KEY
  - model_name: cheap
    litellm_params:
      model: openai/gpt-4o-mini
      api_base: {origin}/cheap/v1
      api_key: os.environ/CHEAP_KEY
  - model_name: anthropic-cheap
    litellm_params:
      model: anthropic/claude-haiku-4-5-20251001
      api_base: {origin}/anthropic
      api_key: os.environ/ANTHROPIC_KEY
litellm_settings:
  callbacks: existing.handler
  telemetry: false
router_settings:
  num_retries: 0
  fallbacks: [{{cheap: [premium]}}]
general_settings:
  custom_auth: auth.authenticate
""")
    mode = getattr(request, "param", "routing")
    generated = setup(config, url=origin) if mode == "routing" else config
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = isolated_env(
        LITELLM_LOCAL_MODEL_COST_MAP="True",
        LITELLM_TELEMETRY="False",
        LITELLM_MASTER_KEY="fixture-litellm-master-key",
        PREMIUM_KEY="premium-provider-key",
        CHEAP_KEY="cheap-provider-key",
        ANTHROPIC_KEY="anthropic-provider-key",
        CAVEMAN_ROUTER_TOKEN="router-only-token",
        NO_PROXY="127.0.0.1,localhost",
        LITELLM_OTEL_V2="true",
        OTEL_EXPORTER="otlp_http",
        OTEL_ENDPOINT=origin,
        OTEL_HEADERS="x-cave-api-key=trace-only-token,x-cave-source-system=litellm",
        OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT="span_only" if mode == "content" else "no_content",
        OTEL_BSP_SCHEDULE_DELAY="100",
    )
    log = root / "proxy.log"
    with log.open("w") as stream:
        process = subprocess.Popen(
            [
                str(Path(sys.executable).with_name("litellm")),
                "--config",
                str(generated),
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
            ],
            cwd=root,
            env=env,
            stdout=stream,
            stderr=subprocess.STDOUT,
        )
    base = f"http://127.0.0.1:{port}"
    try:
        with httpx.Client(
            base_url=base,
            trust_env=False,
            timeout=15,
            headers={"Authorization": "Bearer unrestricted"},
        ) as proxy:
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    pytest.fail("LiteLLM startup failed:\n" + log.read_text()[-6000:])
                try:
                    if proxy.get("/health/liveliness").status_code == 200:
                        break
                except httpx.TransportError:
                    pass
                time.sleep(0.1)
            else:
                pytest.fail("LiteLLM startup timed out:\n" + log.read_text()[-6000:])
            yield proxy, fixture, generated, log
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        fixture.shutdown()
        fixture.server_close()
        thread.join(timeout=2)


def complete(proxy, **kwargs):
    return proxy.post(
        "/v1/chat/completions",
        json={
            "model": "premium",
            "messages": [{"role": "user", "content": "Reply with OK."}],
            "max_tokens": 8,
            **kwargs,
        },
    )


@pytest.mark.parametrize("gateway", ["routing", "observe", "content"], indirect=True)
@pytest.mark.parametrize("stream", [False, True])
def test_native_otel_keeps_trace_tree_and_single_inference_hop(gateway, tmp_path, request, stream):
    proxy, fixture, _, log = gateway
    mode = request.node.callspec.params["gateway"]
    trace_id = "1234567890abcdef1234567890abcdef"
    fixture.calls.clear()
    response = proxy.post(
        "/v1/chat/completions",
        headers={"traceparent": f"00-{trace_id}-0123456789abcdef-01"},
        json={
            "model": "premium",
            "messages": [{"role": "user", "content": "Reply with OK."}],
            "max_tokens": 8,
            **({"stream": True, "stream_options": {"include_usage": True}} if stream else {}),
        },
    )
    assert response.status_code == 200, response.text
    deadline = time.monotonic() + 10
    spans = []
    while time.monotonic() < deadline:
        spans = [
            span
            for export in fixture.exports
            for resource in export["body"].get("resourceSpans", [])
            for scope in resource.get("scopeSpans", [])
            for span in scope.get("spans", [])
            if span["traceId"] == trace_id
        ]
        if any(span["kind"] == 2 for span in spans):
            break
        time.sleep(0.1)
    assert len(spans) >= 2, log.read_text()[-5000:]
    server = next(span for span in spans if span["kind"] == 2)
    assert server["parentSpanId"] == "0123456789abcdef"
    assert any(span.get("parentSpanId") == server["spanId"] for span in spans)
    llm = next(span for span in spans if span["name"].startswith("chat "))
    attrs = {attr["key"]: attr["value"] for attr in llm["attributes"]}
    assert attrs["gen_ai.usage.input_tokens"] == {"intValue": "2"}
    assert attrs["gen_ai.usage.output_tokens"] == {"intValue": "1"}
    assert attrs["litellm.cost.total"]["doubleValue"] > 0
    assert ("gen_ai.input.messages" in attrs) == (mode == "content")
    assert [call["path"] for call in fixture.calls] == (
        ["/v1/route", "/cheap/v1/chat/completions"] if mode == "routing" else ["/premium/v1/chat/completions"]
    )
    assert "trace-only-token" not in json.dumps(fixture.calls)
    assert all(httpx.Headers(export["headers"])["x-cave-source-system"] == "litellm" for export in fixture.exports)
    # Feed the actual exporter bytes through Caveman's production mapper.
    payload = tmp_path / "litellm-export.json"
    payload.write_text(json.dumps({"resourceSpans": [
        resource for export in fixture.exports for resource in export["body"].get("resourceSpans", [])
    ]}))
    result = subprocess.run(
        ["go", "test", "./Caveman Cloud Gateway", "./Caveman Cloud Gateway", "-run", "^TestLiteLLMLive(Export|Ingestion)$", "-count=1"],
        cwd=Path(__file__).resolve().parents[3],
        env={**os.environ, "CAVEMAN_LITELLM_EXPORT": str(payload), "CAVEMAN_LITELLM_CONTENT": "1" if mode == "content" else "0", "CAVEMAN_LITELLM_CAPTURE_BUNDLE": str(tmp_path / "capture.json")},
        capture_output=True, text=True, timeout=300, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    if mode == "content":
        read = subprocess.run(
            ["go", "test", "./Caveman Cloud API", "-run", "^TestLiteLLMLiveCapturedRead$", "-count=1"],
            cwd=Path(__file__).resolve().parents[3],
            env={**os.environ, "CAVEMAN_LITELLM_CAPTURE_BUNDLE": str(tmp_path / "capture.json")},
            capture_output=True, text=True, timeout=300, check=False,
        )
        assert read.returncode == 0, read.stdout + read.stderr


@pytest.mark.parametrize("gateway", ["observe"], indirect=True)
def test_native_otel_records_provider_failure(gateway):
    proxy, fixture, _, log = gateway
    trace_id = "abcdef1234567890abcdef1234567890"
    fixture.all_providers_error = True
    try:
        response = proxy.post("/v1/chat/completions", headers={"traceparent": f"00-{trace_id}-0123456789abcdef-01"},
                              json={"model": "premium", "messages": [{"role": "user", "content": "OK?"}]})
        assert response.status_code >= 500, response.text
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            spans = [span for export in fixture.exports for resource in export["body"].get("resourceSpans", [])
                     for scope in resource.get("scopeSpans", []) for span in scope.get("spans", []) if span["traceId"] == trace_id]
            if any(span.get("status", {}).get("code") == 2 for span in spans):
                break
            time.sleep(0.1)
        assert any(span.get("status", {}).get("code") == 2 for span in spans), log.read_text()[-5000:]
    finally:
        fixture.all_providers_error = False


def test_generated_config_routes_one_inference_hop_with_target_credentials(gateway):
    proxy, fixture, _, log = gateway
    fixture.calls.clear()
    result = complete(proxy)
    assert result.status_code == 200, result.text + "\n" + log.read_text()[-3000:]
    # LiteLLM preserves the requested public alias in the client response.
    assert result.json()["model"] == "premium", fixture.calls
    assert [call["path"] for call in fixture.calls] == ["/v1/route", "/cheap/v1/chat/completions"]
    route, provider = fixture.calls
    assert set(route["body"]) == {"messages", "models"}
    assert route["body"]["messages"] == [{"role": "user", "content": "Reply with OK."}]
    assert httpx.Headers(route["headers"])["Authorization"] == "Bearer router-only-token"
    assert httpx.Headers(provider["headers"])["Authorization"] == "Bearer cheap-provider-key"
    assert provider["body"]["model"] == "gpt-4o-mini"
    assert provider["body"]["user"] == "callback-saw-cheap"
    assert provider["body"]["messages"] == [{"role": "user", "content": "Reply with OK."}]
    assert "router-only-token" not in json.dumps(provider)
    assert "provider-key" not in json.dumps(route)


def test_streaming_survives_routing(gateway):
    proxy, fixture, _, _ = gateway
    fixture.calls.clear()
    response = complete(proxy, stream=True)
    assert response.status_code == 200, response.text
    assert "data: [DONE]" in response.text and '"content":"OK"' in response.text.replace(" ", "")
    assert [call["path"] for call in fixture.calls] == ["/v1/route", "/cheap/v1/chat/completions"]


@pytest.mark.parametrize("mode", ["timeout", "error", "invalid", "unavailable"])
def test_router_failure_runs_original_deployment(gateway, mode):
    proxy, fixture, _, _ = gateway
    fixture.calls.clear()
    fixture.route_mode = mode
    try:
        response = complete(proxy)
        assert response.status_code == 200, response.text
        assert response.json()["model"] == "premium"
        provider = next(
            call for call in fixture.calls if call["path"].endswith("/chat/completions")
        )
        assert provider["path"] == "/premium/v1/chat/completions"
        assert httpx.Headers(provider["headers"])["Authorization"] == "Bearer premium-provider-key"
    finally:
        fixture.route_mode = "ranked"


def test_restricted_key_cannot_route_to_other_model(gateway):
    proxy, fixture, _, _ = gateway
    fixture.calls.clear()
    response = proxy.post(
        "/v1/chat/completions",
        headers={"Authorization": "Bearer restricted"},
        json={"model": "premium", "messages": [{"role": "user", "content": "OK"}]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["model"] == "premium"
    assert [call["path"] for call in fixture.calls] == ["/premium/v1/chat/completions"]


def test_tools_keep_original_model_and_payload(gateway):
    proxy, fixture, _, _ = gateway
    fixture.calls.clear()
    tools = [{"type": "function", "function": {"name": "lookup", "parameters": {"type": "object"}}}]
    response = complete(proxy, tools=tools)
    assert response.status_code == 200, response.text
    assert [call["path"] for call in fixture.calls] == ["/premium/v1/chat/completions"]
    assert fixture.calls[0]["body"]["tools"] == tools


def test_cli_check_reports_decision_only(gateway):
    _, fixture, generated, _ = gateway
    fixture.calls.clear()
    result = subprocess.run(
        [
            str(Path(sys.executable).with_name("caveman-router")),
            "check",
            "--config",
            str(generated),
        ],
        env=isolated_env(CAVEMAN_ROUTER_TOKEN="router-only-token"),
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert result.returncode == 0, result.stderr + result.stdout
    assert json.loads(result.stdout)["inference_sent"] is False
    assert [call["path"] for call in fixture.calls] == ["/v1/route"]


def test_existing_provider_fallback_still_runs(gateway):
    proxy, fixture, _, _ = gateway
    fixture.calls.clear()
    fixture.provider_error = True
    try:
        response = complete(proxy)
        assert response.status_code == 200, response.text
        assert sum(call["path"] == "/v1/route" for call in fixture.calls) == 1
        providers = [call for call in fixture.calls if call["path"].endswith("/chat/completions")]
        assert providers[0]["path"] == "/cheap/v1/chat/completions"
        assert providers[-1]["path"] == "/premium/v1/chat/completions"
        assert (
            httpx.Headers(providers[-1]["headers"])["Authorization"]
            == "Bearer premium-provider-key"
        )
    finally:
        fixture.provider_error = False


def test_cross_provider_route_uses_anthropic_protocol_and_credentials(gateway):
    proxy, fixture, _, _ = gateway
    fixture.calls.clear()
    fixture.route_mode = "anthropic"
    try:
        response = complete(proxy)
        assert response.status_code == 200, response.text
        assert response.json()["choices"][0]["message"]["content"] == "OK"
        assert [call["path"] for call in fixture.calls] == ["/v1/route", "/anthropic/v1/messages"]
        provider = fixture.calls[-1]
        headers = httpx.Headers(provider["headers"])
        assert headers["x-api-key"] == "anthropic-provider-key"
        assert "authorization" not in headers
        assert "premium-provider-key" not in json.dumps(provider)
        assert "router-only-token" not in json.dumps(provider)
    finally:
        fixture.route_mode = "ranked"
