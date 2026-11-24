"""Generate an additive LiteLLM config and check the configured decision service."""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import io
import json
import os
import shlex
import sys
from pathlib import Path
from urllib.parse import urlsplit

from ruamel.yaml import YAML

from caveman_router_client import RouterClient, model_map, route_url, timeout_seconds

CALLBACK = "caveman_router.router_hook"


# Caveman Cloud's reasons for a decision it made; any other answer keeps the
# requested model. ask_work is route-work-v1's (an ask routed by its work
# type). "ranked" and "exploration" are what a Cloud from before the
# in-gateway ask model answers, so check passes against one not yet upgraded.
DECISIONS = {"ask_xlow", "ask_low", "ask_medium", "ask_high", "ask_work", "easy_turn", "hard_turn", "no_cheaper_model", "ranked", "exploration"}


def read_config(path: Path):
    yaml = YAML()
    yaml.preserve_quotes = True
    with path.open() as stream:
        config = yaml.load(stream)
    if not isinstance(config, dict) or not isinstance(config.get("model_list"), list):
        raise TypeError("LiteLLM config must contain model_list")
    return yaml, config


def discover_models(
    config: dict, selected: list[str] | None = None, overrides: dict[str, str] | None = None
) -> dict[str, str]:
    models: dict[str, str] = {}
    excluded: set[str] = set()
    overrides = overrides or {}
    for entry in config["model_list"]:
        if not isinstance(entry, dict):
            continue
        alias = entry.get("model_name")
        params = entry.get("litellm_params") or {}
        info = entry.get("model_info") or {}
        if not isinstance(alias, str) or not isinstance(params, dict) or not isinstance(info, dict):
            continue
        identity = overrides.get(alias) or info.get("base_model") or params.get("model")
        if (
            not isinstance(identity, str)
            or identity.startswith(("os.environ/", "azure/", "bedrock/"))
            or "*" in alias
            or "*" in identity
            or info.get("mode", "chat") != "chat"
            or params.get("guardrails")
            or info.get("guardrails")
        ):
            excluded.add(alias)
            continue
        if alias in models and models[alias] != identity:
            excluded.add(alias)
        models[alias] = identity
    for alias in excluded:
        models.pop(alias, None)
    if selected:
        missing = set(selected) - models.keys()
        if missing:
            raise ValueError(
                "Unusable model aliases: "
                + ", ".join(sorted(missing))
                + ". Set model_info.base_model or --map alias=provider/model for opaque deployments."
            )
        models = {alias: models[alias] for alias in selected}
    unknown = overrides.keys() - models.keys()
    if unknown:
        raise ValueError(
            "Mapped aliases are not eligible model_list entries: " + ", ".join(sorted(unknown))
        )
    if len(set(models.values())) < 2:
        raise ValueError(
            "Need at least two distinct chat models; use --models and --map for deployment aliases"
        )
    return model_map(models)


def setup(
    config_path: Path,
    *,
    url: str,
    output: Path | None = None,
    selected: list[str] | None = None,
    overrides: dict[str, str] | None = None,
) -> Path:
    yaml, config = read_config(config_path)
    models = discover_models(config, selected, overrides)
    endpoint = route_url(url)
    output = output or config_path.with_name(
        config_path.stem.removesuffix(".caveman") + ".caveman.yaml"
    )
    if output.resolve() == config_path.resolve():
        raise ValueError("Output must differ from the input config; the original is your rollback")
    if output.resolve().parent != config_path.resolve().parent:
        raise ValueError(
            "Output must stay beside the original config so relative callback paths keep working"
        )
    settings = config.setdefault("litellm_settings", {})
    env = config.setdefault("environment_variables", {})
    if not isinstance(settings, dict) or not isinstance(env, dict):
        raise TypeError("litellm_settings and environment_variables must be mappings")
    callbacks = settings.get("callbacks", [])
    callbacks = [callbacks] if isinstance(callbacks, str) else callbacks
    if not isinstance(callbacks, list):
        raise TypeError("litellm_settings.callbacks must be a string or list")
    # Route first so subsequent callbacks observe the selected alias.
    settings["callbacks"] = [CALLBACK] + [item for item in callbacks if item != CALLBACK]
    env["CAVEMAN_ROUTER_URL"] = endpoint
    env["CAVEMAN_ROUTER_MODELS"] = json.dumps(models, separators=(",", ":"))
    text = io.StringIO()
    yaml.dump(config, text)
    rendered = text.getvalue()
    if output.exists():
        if output.read_text() == rendered:
            return output
        raise ValueError(
            f"Output already exists with different content: {output}. Choose another --output beside the config."
        )
    # Config may already contain provider secrets. Avoid creating a world-readable copy.
    with open(output, "x", opener=lambda name, flags: os.open(name, flags, 0o600)) as stream:
        stream.write(rendered)
    return output


def _env_value(env: dict, name: str, default="") -> str:
    value = env.get(name, os.getenv(name, default))
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string")
    if value.startswith("os.environ/"):
        # A config file may name only its own variable. os.environ/OPENAI_API_KEY
        # under CAVEMAN_ROUTER_TOKEN would send that key to the configured router.
        if value.removeprefix("os.environ/") != name:
            raise ValueError(f"{name} may only reference os.environ/{name}")
        value = os.getenv(name, "")
    return value


async def check(config_path: Path) -> int:
    if importlib.util.find_spec("litellm") is None:
        raise ValueError(
            "LiteLLM is not installed in this Python environment; install the connector where LiteLLM runs"
        )
    _, config = read_config(config_path)
    callbacks = (config.get("litellm_settings") or {}).get("callbacks", [])
    if CALLBACK not in ([callbacks] if isinstance(callbacks, str) else callbacks):
        raise ValueError("Caveman callback is absent; run caveman-router setup first")
    env = config.get("environment_variables") or {}
    raw = _env_value(env, "CAVEMAN_ROUTER_MODELS")
    models = (
        json.loads(raw)
        if raw.startswith("{")
        else {m.strip(): m.strip() for m in raw.split(",") if m.strip()}
    )
    models = model_map(models)
    # Catch deployment drift before calling the decision service.
    actual = {entry.get("model_name") for entry in config["model_list"] if isinstance(entry, dict)}
    if not models.keys() <= actual:
        raise ValueError("Routing pool contains aliases missing from model_list; rerun setup")
    # The URL comes from the config file and the token from this shell: say where
    # the token is about to go, and never send it in the clear off this machine.
    router = urlsplit(route_url(_env_value(env, "CAVEMAN_ROUTER_URL")))
    token = _env_value(env, "CAVEMAN_ROUTER_TOKEN") or _env_value(env, "CAVE_API_KEY")
    print(f"caveman-router: checking {router.scheme}://{router.netloc}", file=sys.stderr)
    if token and router.scheme != "https" and router.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("Refusing to send the router token over plain HTTP to a non-loopback host; use https")
    async with RouterClient(
        router.geturl(),
        models,
        token=token,
        timeout=timeout_seconds(_env_value(env, "CAVEMAN_ROUTER_TIMEOUT", "0.15")),
    ) as client:
        original = next(iter(models))
        decision = await client.decide(original, [{"role": "user", "content": "Reply with OK."}])
    print(
        json.dumps(
            {
                "check": "decision_api",
                "reason": decision.reason,
                "requested_model": original,
                "selected_model": decision.model,
                "router_http_status": decision.status_code,
                "inference_sent": False,
                "hint": (
                    "Check the router token. Caveman Cloud requires a project key with router:write."
                    if decision.status_code in {401, 403}
                    else {
                        "no_alternative": "Configure at least two unambiguous model identities.",
                        "no_features": "Caveman Cloud made no decision: its ask model is unavailable (gateway log: ask model).",
                        "allowance": "The free routing allowance is used for this month; add a card: caveman billing.",
                        "billing_limit": "The routing billing limit is reached for this month; raise it: caveman billing.",
                        "router_timeout": "Check router latency or increase CAVEMAN_ROUTER_TIMEOUT (seconds, maximum 5).",
                        "router_error": "Check the router URL, connection, and TLS configuration.",
                    }.get(decision.reason, "")
                ),
            }
        )
    )
    return 0 if decision.reason in DECISIONS else 2


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Add Caveman decisions to your existing LiteLLM gateway."
    )
    sub = parser.add_subparsers(dest="command", required=True)
    install = sub.add_parser(
        "setup", help="Write a separate config; retain provider settings and existing callbacks"
    )
    install.add_argument("--config", required=True, type=Path)
    install.add_argument(
        "--router",
        default=os.getenv("CAVEMAN_ROUTER_URL")
        or os.getenv("CAVE_GATEWAY_URL")
        or "https://gateway.caveman.so",
        help="Decision service origin or /v1/route URL (default: Caveman Cloud)",
    )
    install.add_argument("--output", type=Path)
    install.add_argument(
        "--models", help="Comma-separated model_list aliases; defaults to eligible chat models"
    )
    install.add_argument(
        "--map",
        action="append",
        default=[],
        metavar="ALIAS=PROVIDER/MODEL",
        help="Identify Azure/custom deployments; repeat as needed",
    )
    verify = sub.add_parser(
        "check", help="Check callback config and router with synthetic text; no provider call"
    )
    verify.add_argument("--config", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "check":
            return asyncio.run(check(args.config))
        if not args.router:
            raise ValueError("Pass --router or set CAVEMAN_ROUTER_URL to your decision service")
        overrides = {}
        for value in args.map:
            alias, separator, identity = value.partition("=")
            if not separator or not alias or not identity:
                raise ValueError("--map must be ALIAS=PROVIDER/MODEL")
            overrides[alias] = identity
        output = setup(
            args.config,
            url=args.router,
            output=args.output,
            selected=[m.strip() for m in args.models.split(",")] if args.models else None,
            overrides=overrides,
        )
        print(f"Created {output}. Original config retained.")
        print("Check: caveman-router check --config " + shlex.quote(str(output)))
        print(
            "Before starting: retain your existing general_settings.master_key or set "
            "LITELLM_MASTER_KEY in the proxy environment. LiteLLM refuses to start without it."
        )
        print("Start: litellm --config " + shlex.quote(str(output)))
        print(
            "Caveman Cloud: set CAVE_API_KEY to a project key with router:write. Self-hosted router: set CAVEMAN_ROUTER_TOKEN if required."
        )
        print(
            "Scope: text chat completions. Tools, multimodal, structured output, and provider overrides keep the original model."
        )
        return 0
    except (ValueError, OSError, TypeError) as error:
        # YAML parser errors can contain config secrets; only our bounded errors are printed.
        print(f"caveman-router: {error}", file=sys.stderr)
        return 1
    except Exception:  # noqa: BLE001 - do not expose YAML lines containing credentials
        print(
            "caveman-router: could not read config; check YAML syntax and dependencies",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
