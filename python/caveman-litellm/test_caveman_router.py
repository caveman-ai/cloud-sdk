from __future__ import annotations

import asyncio
import copy
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from caveman_router import CavemanRouterHook, allowed_models, request_is_portable
from caveman_router_client import (
    ASK_BYTES,
    PREVIOUS_ASK_CHARS,
    REPLY_CHARS,
    RouterClient,
    route_messages,
    route_url,
    timeout_seconds,
)
from caveman_router_setup import CALLBACK, discover_models, main, read_config, setup

POOL = {"premium": "openai/gpt-4o", "cheap": "openai/gpt-4o-mini"}
MESSAGES = [{"role": "user", "content": "hi"}]


def request(**kwargs):
    return {"model": "premium", "messages": copy.deepcopy(MESSAGES), **kwargs}


def run(coroutine):
    return asyncio.run(coroutine)


def client(handler, **kwargs):
    result = RouterClient("http://localhost:8092", POOL, **kwargs)
    result._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return result


def test_route_maps_identity_back_to_alias_and_only_sends_messages_and_models():
    def handler(req):
        assert json.loads(req.content) == {"messages": MESSAGES, "models": list(POOL.values())}
        assert req.headers["Authorization"] == "Bearer router-only"
        assert req.headers["Content-Type"] == "application/json"
        return httpx.Response(200, json={"reason": "ask_xlow", "model": POOL["cheap"]})

    async def exercise():
        async with client(handler, token="router-only") as router:
            result = await router.decide("premium", MESSAGES)
            assert (result.model, result.reason) == ("cheap", "ask_xlow")

    run(exercise())


@pytest.mark.parametrize(
    "reply",
    [
        None,
        [],
        "garbage",
        {},
        {"model": "evil", "reason": "ranked"},
        {"model": " " + POOL["cheap"], "reason": "ranked"},
        {"reason": "ask_xlow"},
    ],
)
def test_untrusted_or_unavailable_decision_cannot_change_model(reply):
    async def exercise():
        async with client(lambda req: httpx.Response(200, json=reply)) as router:
            assert (await router.decide("premium", MESSAGES)).model == "premium"

    run(exercise())


@pytest.mark.parametrize("status", [302, 401, 429, 500])
def test_http_failures_preserve_model(status):
    async def exercise():
        async with client(
            lambda req: httpx.Response(status, headers={"location": "http://attacker.invalid"})
        ) as router:
            result = await router.decide("premium", MESSAGES)
            assert (result.model, result.reason) == ("premium", "router_http_error")

    run(exercise())


def test_oversized_and_non_json_reply():
    async def exercise():
        for body in (b"x" * 65537, b"not json"):
            async with client(lambda req, body=body: httpx.Response(200, content=body)) as router:
                assert (await router.decide("premium", MESSAGES)).model == "premium"

    run(exercise())


def test_deadline_and_no_queue_under_saturation():
    async def handler(req):
        await asyncio.sleep(1)
        return httpx.Response(200, json={})

    async def exercise():
        async with client(handler, timeout=0.02, max_concurrency=1) as router:
            task = asyncio.create_task(router.decide("premium", MESSAGES))
            await asyncio.sleep(0)
            assert (await router.decide("premium", MESSAGES)).reason == "router_busy"
            assert (await task).reason == "router_timeout"

    run(exercise())


def test_cancellation_propagates():
    async def handler(req):
        raise asyncio.CancelledError()

    async def exercise():
        async with client(handler) as router:
            with pytest.raises(asyncio.CancelledError):
                await router.decide("premium", MESSAGES)

    run(exercise())


def test_scope_and_ambiguous_deployments_never_call_router():
    def handler(req):
        pytest.fail("should not call router")

    async def exercise():
        async with client(handler) as router:
            assert (await router.decide("fine-tune", MESSAGES)).reason == "out_of_scope"
            assert (
                await router.decide("premium", MESSAGES, allowed_models={"premium"})
            ).reason == "no_alternative"
            assert (
                await router.decide("premium", MESSAGES, allowed_models={"cheap"})
            ).reason == "not_authorized"
            router.models["cheap-canary"] = POOL["cheap"]
            assert (await router.decide("premium", MESSAGES)).reason == "no_alternative"

    run(exercise())


def test_original_model_is_first_in_decision_pool():
    def handler(req):
        assert json.loads(req.content)["models"][0] == POOL["cheap"]
        # Cloud keeps models[0] when it makes no decision; the reason is its own.
        return httpx.Response(200, json={"model": POOL["cheap"], "reason": "no_alternative"})

    async def exercise():
        async with client(handler) as router:
            assert (await router.decide("cheap", MESSAGES)).model == "cheap"

    run(exercise())


@pytest.mark.parametrize("call_type", ["completion", "acompletion"])
def test_hook_dispatches_real_and_legacy_call_type_and_changes_only_model(call_type):
    async def exercise():
        hook = CavemanRouterHook()
        hook._client = client(
            lambda req: httpx.Response(200, json={"model": POOL["cheap"], "reason": "ask_xlow"})
        )
        data = request(stream=True, temperature=0.2, metadata={"workflow": "support"})
        before = copy.deepcopy(data)
        result = await hook.async_pre_call_hook(None, None, data, call_type)
        assert result is data
        assert result == {**before, "model": "cheap"}
        assert hook.counts == {"ask_xlow": 1}
        await hook.aclose()

    run(exercise())


@pytest.mark.parametrize(
    "call_type",
    ["aembedding", "embeddings", "aresponses", "anthropic_messages", "anthropic_passthrough"],
)
def test_unsupported_endpoint_is_untouched(call_type):
    hook = CavemanRouterHook()
    data = request()
    assert run(hook.async_pre_call_hook(None, None, data, call_type)) is data
    assert hook._client is None


@pytest.mark.parametrize(
    "kwargs",
    [
        {"tools": [{"type": "function"}]},
        {"response_format": {"type": "json_object"}},
        {"api_key": "provider-secret"},
        {"api_base": "https://private.example"},
        {"extra_headers": {"Authorization": "secret"}},
        {"aws_region_name": "eu-west-1"},
        {"messages": [{"role": "tool", "content": "private tool output"}]},
        {
            "messages": [
                {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "x"}}]}
            ]
        },
    ],
)
def test_requests_requiring_provider_or_capability_guarantees_are_pinned(kwargs):
    assert not request_is_portable(request(**kwargs))


@pytest.mark.parametrize(
    "auth, expected",
    [
        ({"models": ["premium"]}, {"premium"}),
        ({"models": [], "team_models": ["cheap"]}, {"cheap"}),
        ({"models": ["all-team-models"], "team_models": ["premium"]}, {"premium"}),
        ({"models": ["premium", "cheap"], "team_models": ["premium"]}, {"premium"}),
        ({"models": ["some-access-group"]}, set()),
        ({"model_max_budget": {"cheap": 1}}, set()),
        ({"model_tpm_limit": {"cheap": 1}}, set()),
        ({"team_model_aliases": {"cheap": "private"}}, set()),
        ({"models": []}, set(POOL)),
    ],
)
def test_tenant_scope(auth, expected):
    assert allowed_models(SimpleNamespace(**auth), POOL) == expected


def test_reauthorization_rejection_keeps_original(monkeypatch):
    from litellm.proxy.auth import auth_checks

    recheck = AsyncMock(side_effect=PermissionError("denied"))
    monkeypatch.setattr(auth_checks, "can_key_call_resolved_model", recheck)

    async def exercise():
        hook = CavemanRouterHook()
        hook._client = client(
            lambda req: httpx.Response(200, json={"model": POOL["cheap"], "reason": "ask_xlow"})
        )
        data = request()
        before = copy.deepcopy(data)
        await hook.async_pre_call_hook(SimpleNamespace(models=[]), None, data, "acompletion")
        assert data == before
        assert recheck.await_count == 1
        await hook.aclose()

    run(exercise())


@pytest.mark.parametrize(
    "reason, kept",
    [("easy_turn", "easy_turn"), ("no_alternative", "no_alternative"), (None, "decided"), (7, "decided"),
     ("Ranked By <b>", "decided"), ("x" * 41, "decided")],
)
def test_clouds_reason_is_kept_when_it_is_a_label(reason, kept):
    async def exercise():
        async with client(lambda req: httpx.Response(200, json={"model": POOL["premium"], "reason": reason})) as router:
            assert (await router.decide("premium", MESSAGES)).reason == kept

    run(exercise())


def test_messages_are_bounded_and_skip_tool_results():
    messages = [
        {"role": "tool", "content": "do not send"},
        {"role": "user", "content": "🙂" * 100_000},
    ]
    sent = route_messages(messages)
    assert [m["role"] for m in sent] == ["user"]
    assert len(json.dumps(sent[0]["content"], ensure_ascii=False).encode()) <= ASK_BYTES
    # An over-long ask keeps its end, where a harness puts the person's words.
    long_ask = "x" * 100_000 + "\nfix the tests"
    assert route_messages([{"role": "user", "content": long_ask}])[0]["content"].endswith("fix the tests")
    assert "do not send" not in json.dumps(sent)
    assert route_messages([None, {"content": 7}]) == []
    assert route_messages("text") == []


def test_messages_hold_what_cloud_reads_of_an_ask():
    # The ask, the previous ask (its head), the reply before the ask (its
    # tail), and each earlier ask cut to a count. System prompts, tool output
    # and reminders are never sent.
    messages = [
        {"role": "system", "content": "You are a helpful assistant. " * 250},
        {"role": "user", "content": "Open the billing repository and read it all. " * 10},
        {"role": "assistant", "content": "older reply " * 500},
        {"role": "user", "content": "now look at the invoices " * 200},
        {"role": "assistant", "content": [{"type": "text", "text": "x" * 5000}, {"type": "text", "text": "Want me to split it?"}]},
        {"role": "tool", "content": "tool output " * 500},
        {"role": "user", "content": [{"type": "tool_result", "content": "result"}]},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Refactor the invoice parser into two modules."},
                {"type": "text", "text": "<system-reminder>harness text</system-reminder>"},
            ],
        },
    ]
    sent = route_messages(messages)
    assert [m["role"] for m in sent] == ["user", "user", "assistant", "user"]
    earlier, previous, reply, ask = (m["content"] for m in sent)
    assert earlier == "…"  # Cloud only counts it
    assert previous.startswith("now look at the invoices") and len(previous) == PREVIOUS_ASK_CHARS
    assert reply.endswith("x Want me to split it?") and len(reply) == REPLY_CHARS
    assert ask == "Refactor the invoice parser into two modules."
    body = json.dumps(sent)
    assert "helpful assistant" not in body and "tool output" not in body and "older reply" not in body
    assert "harness text" not in body


def test_long_conversations_stay_under_clouds_caps():
    messages = [{"role": "user", "content": "\u0001" * 3000}, {"role": "assistant", "content": "é" * 9000}] * 400
    messages.append({"role": "user", "content": "\u0001" * 200_000})
    sent = route_messages(messages)
    assert len(sent) <= 256
    assert all(len(json.dumps(m["content"], ensure_ascii=False).encode()) <= 64 * 1024 for m in sent)
    assert len(json.dumps({"messages": sent, "models": ["a", "b"]}, ensure_ascii=False).encode()) <= 256 * 1024


def test_unclosed_system_reminders_strip_in_linear_time():
    # 340 KB of openers with no closer took 20 s with a lazy regex, on the
    # proxy's event loop where the route deadline cannot interrupt it.
    script = (
        "from caveman_router_client import route_messages\n"
        "sent = route_messages([{'role': 'user', 'content': '<system-reminder>' * 20000}])\n"
        "assert sent[0]['content'].endswith('<system-reminder>')\n"
    )
    subprocess.run([sys.executable, "-c", script], cwd=Path(__file__).parent, check=True, timeout=2)
    kept = "a<system-reminder>x</system-reminder>b<system-reminder>y</system-reminder>c<system-reminder>open"
    assert route_messages([{"role": "user", "content": kept}]) == [{"role": "user", "content": "abc<system-reminder>open"}]


@pytest.mark.parametrize("value", ["nan", "inf", "-1", "0", "no", "100"])
def test_invalid_timeouts_stay_bounded(value):
    assert timeout_seconds(value) == 0.15


@pytest.mark.parametrize(
    "url",
    [
        "file:///secret",
        "https://user:secret@example.com",
        "https://example.com?key=secret",
        "https://example.com/w/x",
        "https://example.com/#token",
    ],
)
def test_invalid_url_rejected(url):
    with pytest.raises(ValueError):
        route_url(url)


CONFIG = """# Keep this comment and provider credentials in the existing environment.
model_list:
  - model_name: premium
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY
  - model_name: cheap
    litellm_params:
      model: openai/gpt-4o-mini
      api_key: os.environ/OTHER_KEY
litellm_settings:
  callbacks: existing.handler
router_settings:
  num_retries: 2
  fallbacks: [{cheap: [premium]}]
"""


def test_setup_preserves_config_comments_credentials_callbacks_and_is_idempotent(tmp_path):
    original = tmp_path / "config.yaml"
    original.write_text(CONFIG)
    output = setup(original, url="http://localhost:8092")
    assert original.read_text() == CONFIG
    assert "# Keep this comment" in output.read_text()
    _, original_config = read_config(original)
    _, updated = read_config(output)
    assert updated["model_list"] == original_config["model_list"]
    assert updated["router_settings"] == original_config["router_settings"]
    assert updated["litellm_settings"]["callbacks"] == [CALLBACK, "existing.handler"]
    assert json.loads(updated["environment_variables"]["CAVEMAN_ROUTER_MODELS"]) == POOL
    assert output.stat().st_mode & 0o777 == 0o600
    assert setup(original, url="http://localhost:8092") == output
    with pytest.raises(ValueError, match="different content"):
        setup(original, url="http://localhost:9999")
    with pytest.raises(ValueError, match="rollback"):
        setup(original, url="http://localhost", output=original)
    with pytest.raises(ValueError, match="relative callback"):
        setup(original, url="http://localhost", output=tmp_path / "other" / "config.yaml")


def test_azure_mapping_and_conflicting_aliases(tmp_path):
    original = tmp_path / "config.yaml"
    original.write_text(CONFIG)
    _, config = read_config(original)
    config["model_list"][0]["litellm_params"]["model"] = "azure/production-eu"
    with pytest.raises(ValueError, match="two distinct"):
        discover_models(config)
    assert discover_models(config, overrides={"premium": "openai/gpt-4o"}) == POOL
    config["model_list"].append(
        {"model_name": "cheap", "litellm_params": {"model": "anthropic/other"}}
    )
    with pytest.raises(ValueError):
        discover_models(config, overrides={"premium": "openai/gpt-4o"})


def test_cli_preserves_master_key_and_explains_startup_requirement(tmp_path, capsys):
    config = tmp_path / "config.yaml"
    config.write_text(CONFIG + "\ngeneral_settings:\n  master_key: fixture-existing-master\n")
    assert main(["setup", "--config", str(config), "--router", "http://localhost"]) == 0
    stdout = capsys.readouterr().out
    assert "LITELLM_MASTER_KEY" in stdout
    assert "general_settings.master_key" in stdout
    assert stdout.index("Before starting:") < stdout.index("Start:")
    assert "fixture-existing-master" not in stdout
    _, generated = read_config(tmp_path / "config.caveman.yaml")
    assert generated["general_settings"]["master_key"] == "fixture-existing-master"


def test_cli_errors_do_not_print_config_contents(tmp_path, capsys):
    config = tmp_path / "bad.yaml"
    config.write_text('model_list: [\n api_key: "secret-value"\n')
    assert main(["setup", "--config", str(config), "--router", "http://localhost"]) == 1
    assert "secret-value" not in capsys.readouterr().err


@pytest.mark.parametrize(
    "router,token,message",
    [
        # A config from someone else must not pick which secret of this shell is sent.
        ("https://router.example", "os.environ/OPENAI_API_KEY", "CAVEMAN_ROUTER_TOKEN may only reference"),
        ("http://router.example", "os.environ/CAVEMAN_ROUTER_TOKEN", "plain HTTP"),
        ("http://router.example", "inline-router-token", "plain HTTP"),
    ],
)
def test_check_never_sends_a_token_the_config_chose_or_in_the_clear(
    tmp_path, monkeypatch, capsys, router, token, message
):
    class Unreachable:
        def __init__(self, *args, **kwargs):
            raise AssertionError("check contacted the router")

    monkeypatch.setattr("caveman_router_setup.RouterClient", Unreachable)
    monkeypatch.setattr("caveman_router_setup.importlib.util.find_spec", lambda name: object())
    monkeypatch.setenv("OPENAI_API_KEY", "provider-secret")
    monkeypatch.setenv("CAVEMAN_ROUTER_TOKEN", "router-secret")
    monkeypatch.delenv("CAVE_API_KEY", raising=False)
    original = tmp_path / "config.yaml"
    original.write_text(CONFIG)
    generated = setup(original, url=router)
    yaml, config = read_config(generated)
    config["environment_variables"]["CAVEMAN_ROUTER_TOKEN"] = token
    with generated.open("w") as stream:
        yaml.dump(config, stream)
    assert main(["check", "--config", str(generated)]) == 1
    err = capsys.readouterr().err
    assert message in err
    assert "provider-secret" not in err and "router-secret" not in err


def test_check_names_the_router_and_sends_its_own_token_over_https_or_loopback(tmp_path, monkeypatch, capsys):
    seen = {}

    class Recorder:
        def __init__(self, url, models, *, token, timeout):
            seen.update(url=url, token=token)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def decide(self, model, messages):
            return SimpleNamespace(reason="ask_xlow", model=model, status_code=200)

    monkeypatch.setattr("caveman_router_setup.RouterClient", Recorder)
    monkeypatch.setattr("caveman_router_setup.importlib.util.find_spec", lambda name: object())
    monkeypatch.setenv("CAVEMAN_ROUTER_TOKEN", "router-secret")
    original = tmp_path / "config.yaml"
    original.write_text(CONFIG)
    for router in ("http://localhost:8092", "https://router.example"):
        generated = setup(original, url=router, output=tmp_path / (router.split("//")[1].split(":")[0] + ".caveman.yaml"))
        assert main(["check", "--config", str(generated)]) == 0
        assert seen == {"url": router + "/v1/route", "token": "router-secret"}
        assert f"caveman-router: checking {router}\n" in capsys.readouterr().err


@pytest.mark.parametrize(
    "reason, code, hint",
    [
        ("ask_medium", 0, ""),
        ("ask_work", 0, ""),
        ("no_cheaper_model", 0, ""),
        ("decided", 2, ""),
        ("no_alternative", 2, "two unambiguous model identities"),
        ("no_features", 2, "ask model is unavailable"),
        ("allowance", 2, "caveman billing"),
        ("billing_limit", 2, "raise it"),
    ],
)
def test_check_passes_only_on_a_decision(tmp_path, monkeypatch, capsys, reason, code, hint):
    class Answer:
        def __init__(self, url, models, *, token, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def decide(self, model, messages):
            return SimpleNamespace(reason=reason, model=model, status_code=200)

    monkeypatch.setattr("caveman_router_setup.RouterClient", Answer)
    monkeypatch.setattr("caveman_router_setup.importlib.util.find_spec", lambda name: object())
    original = tmp_path / "config.yaml"
    original.write_text(CONFIG)
    generated = setup(original, url="http://localhost:8092")
    assert main(["check", "--config", str(generated)]) == code
    report = json.loads(capsys.readouterr().out)
    assert report["reason"] == reason and hint in report["hint"] and bool(report["hint"]) == bool(hint)


def test_context_output_limits_and_unknown_models_cannot_be_selected(monkeypatch):
    import litellm

    from caveman_router import compatible_models

    assert compatible_models(request(max_tokens=8), POOL) == set(POOL)
    monkeypatch.setitem(
        litellm.model_cost,
        POOL["cheap"],
        {
            "mode": "chat",
            "max_input_tokens": 100,
            "max_output_tokens": 10,
        },
    )
    assert compatible_models(request(max_tokens=11), POOL) == {"premium"}
    assert compatible_models(
        request(max_tokens=8, messages=[{"role": "user", "content": "x" * 101}]), POOL
    ) == {"premium"}
    assert compatible_models(request(max_tokens=8), {**POOL, "custom": "private/unknown"}) == set(
        POOL
    )


def test_unsupported_sampling_parameter_cannot_follow_route(monkeypatch):
    import litellm

    from caveman_router import compatible_models

    monkeypatch.setattr(litellm, "get_supported_openai_params", lambda **kwargs: ["max_tokens"])
    assert compatible_models(request(max_tokens=8, temperature=0.2), POOL) == {"premium"}


def test_cloud_key_is_used_without_provider_key_fallback(monkeypatch):
    monkeypatch.setenv("CAVE_API_KEY", "cloud-project-key")
    monkeypatch.setenv("CAVEMAN_ROUTER_TOKEN", "")
    monkeypatch.setenv("OPENAI_API_KEY", "provider-key")
    hook = CavemanRouterHook(url="https://gateway.caveman.so", models=POOL)
    assert hook._get_client().token == "cloud-project-key"


def test_custom_transport_is_reusable_and_owned_by_caller():
    async def exercise():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda req: httpx.Response(200, json={"model": POOL["cheap"], "reason": "ask_xlow"})
            )
        ) as transport:
            async with RouterClient("http://in-process", POOL, http_client=transport) as router:
                hook = CavemanRouterHook(client=router)
                data = request(max_tokens=8)
                await hook.async_pre_call_hook(None, None, data, "acompletion")
                assert data["model"] == "cheap"
                await hook.aclose()
            assert not transport.is_closed

    run(exercise())
