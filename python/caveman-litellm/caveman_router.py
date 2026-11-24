"""Caveman decision callback for an existing LiteLLM Proxy.

Install the package, run `caveman-router setup --help`, then start LiteLLM
with the generated config. Only the deployment alias changes. Provider
credentials, inference, retries, and streaming remain owned by LiteLLM.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections import Counter
from typing import Any

from litellm.integrations.custom_logger import CustomLogger

from caveman_router_client import RouterClient, model_map, timeout_seconds

logger = logging.getLogger("caveman.router")

# Request-owned provider settings cannot follow a route to another deployment.
PROVIDER_OVERRIDES = {
    "api_key",
    "api_base",
    "base_url",
    "api_version",
    "custom_llm_provider",
    "azure_ad_token",
    "extra_headers",
    "headers",
    "litellm_params",
    "model_list",
    "deployments",
    "deployment_id",
    "specific_deployment",
    "allowed_model_region",
}
# These need model capability/continuation guarantees that /v1/route does not carry.
PINNED_FIELDS = {
    "tools",
    "tool_choice",
    "functions",
    "function_call",
    "response_format",
    "audio",
    "modalities",
    "prediction",
    "reasoning_effort",
    "thinking",
    "previous_response_id",
    "logit_bias",
    "guardrails",
    "guardrail_config",
    "top_k",
    "min_p",
    "repetition_penalty",
    "drop_params",
    "web_search_options",
    "service_tier",
}

CHAT_PARAMETERS = {
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "frequency_penalty",
    "presence_penalty",
    "stop",
    "seed",
    "logprobs",
    "top_logprobs",
    "n",
    "stream",
    "stream_options",
}


def configured_models() -> dict[str, str]:
    raw = os.getenv("CAVEMAN_ROUTER_MODELS", "").strip()
    if raw.startswith("{"):
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError(
                "CAVEMAN_ROUTER_MODELS must be a JSON alias-to-model map or comma-separated list"
            )
        return model_map(value)
    models = [m.strip() for m in raw.split(",") if m.strip()]
    return model_map({m: m for m in models}) if models else {}


def request_is_portable(data: dict[str, Any]) -> bool:
    if any(key in data for key in PROVIDER_OVERRIDES):
        return False
    if any(key.startswith(("aws_", "vertex_", "azure_")) for key in data):
        return False
    if any(data.get(key) for key in PINNED_FIELDS):
        return False
    messages = data.get("messages")
    if not isinstance(messages, list) or not messages:
        return False
    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in {
            "system",
            "user",
            "assistant",
        }:
            return False
        if message.get("tool_calls") or message.get("function_call"):
            return False
        if set(message) - {"role", "content", "name"}:
            return False
        content = message.get("content")
        if isinstance(content, str):
            continue
        if not isinstance(content, list) or any(
            not isinstance(block, dict)
            or block.get("type") != "text"
            or not isinstance(block.get("text"), str)
            or set(block) - {"type", "text"}
            for block in content
        ):
            return False
    return True


def _field(auth, name, default=None):
    return auth.get(name, default) if isinstance(auth, dict) else getattr(auth, name, default)


def allowed_models(auth, models: dict[str, str]) -> set[str]:
    """Conservative local intersection before sending any prompt to the router."""
    allowed = set(models)
    if auth is None:
        return allowed
    # Those checks already ran for the inbound model. Keep it when we cannot
    # repeat all model-specific budget/rate/config semantics in a callback.
    for key in (
        "model_max_budget",
        "end_user_model_max_budget",
        "model_rpm_limit",
        "model_tpm_limit",
        "config",
        "aliases",
        "team_model_aliases",
    ):
        if _field(auth, key):
            return set()
    for key in ("models", "team_models"):
        scope = _field(auth, key, [])
        if scope is None or scope == []:
            continue  # LiteLLM's empty model list means unrestricted.
        if not isinstance(scope, list) or any(not isinstance(item, str) for item in scope):
            return set()
        if key == "models" and "all-team-models" in scope:
            scope = _field(auth, "team_models", [])
            if not scope:
                continue
        allowed &= set(scope)
    return allowed


def compatible_models(data: dict[str, Any], models: dict[str, str]) -> set[str]:
    """Use LiteLLM's local catalog and provider parameter contract; never probe providers."""
    import litellm

    def info(identity):
        identity = identity.replace(":", "/", 1)
        return (
            litellm.model_cost.get(identity)
            or litellm.model_cost.get(identity.split("/", 1)[-1])
            or {}
        )

    baseline = data.get("model")
    if baseline not in models:
        return set()
    # UTF-8 bytes plus framing is a conservative token upper bound for text.
    input_bound = 32 * len(data["messages"])
    for message in data["messages"]:
        content = message["content"]
        parts = [content] if isinstance(content, str) else [block["text"] for block in content]
        input_bound += sum(len(part.encode("utf-8")) for part in parts)
        input_bound += len(str(message.get("name", "")).encode("utf-8"))
    output_bound = data.get("max_completion_tokens", data.get("max_tokens"))
    if output_bound is None:
        output_bound = info(models[baseline]).get("max_output_tokens")
    eligible = {baseline}
    if not isinstance(output_bound, int) or isinstance(output_bound, bool) or output_bound <= 0:
        return eligible
    requested = {name for name in CHAT_PARAMETERS if name in data and data[name] is not None}
    for alias, identity in models.items():
        details = info(identity)
        max_input, max_output = details.get("max_input_tokens"), details.get("max_output_tokens")
        if (
            details.get("mode") != "chat"
            or not isinstance(max_input, int)
            or not isinstance(max_output, int)
            or input_bound + output_bound > max_input
            or output_bound > max_output
        ):
            continue
        if details.get("supports_reasoning") and any(
            name in data
            for name in ("temperature", "top_p", "frequency_penalty", "presence_penalty")
        ):
            continue
        supported = litellm.get_supported_openai_params(model=identity.replace(":", "/", 1))
        if supported is not None and requested <= set(supported):
            eligible.add(alias)
    return eligible


class CavemanRouterHook(CustomLogger):
    def __init__(
        self,
        *,
        url: str | None = None,
        models: dict[str, str] | None = None,
        timeout: float | None = None,
        token: str | None = None,
        client: RouterClient | None = None,
    ):
        super().__init__()
        self.url = url
        self.models = model_map(models) if models is not None else None
        self.timeout = timeout
        self.token = token
        self.counts: Counter[str] = Counter()
        self._client = client

    def _get_client(self) -> RouterClient | None:
        if self._client is None:
            url = self.url or os.getenv("CAVEMAN_ROUTER_URL", "").strip()
            models = self.models if self.models is not None else configured_models()
            if not url or not models:
                return None
            self._client = RouterClient(
                url,
                models,
                token=self.token
                if self.token is not None
                else os.getenv("CAVEMAN_ROUTER_TOKEN") or os.getenv("CAVE_API_KEY", ""),
                timeout=timeout_seconds(
                    self.timeout
                    if self.timeout is not None
                    else os.getenv("CAVEMAN_ROUTER_TIMEOUT", "0.15")
                ),
            )
        return self._client

    async def aclose(self):
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _record(self, reason: str):
        self.counts[reason] += 1
        # Bounded labels only: no prompts, tenant ids, headers, or exception text.
        logger.debug("caveman_route reason=%s", reason)
        if (
            reason
            in {
                "not_configured",
                "routing_unavailable",
                "router_http_error",
                "invalid_response",
                "router_error",
                "router_timeout",
                "allowance",
                "billing_limit",
                "no_features",
            }
            and self.counts[reason] == 1
        ):
            logger.warning(
                "Caveman router: %s; keeping the requested model. Run caveman-router check.", reason
            )

    async def async_pre_call_hook(self, user_api_key_dict, cache, data: dict, call_type: str):
        if call_type not in {"completion", "acompletion"}:
            return data
        try:
            client = self._get_client()
            if client is None:
                self._record("not_configured")
                return data
            if not request_is_portable(data):
                self._record("request_pinned")
                return data
            allowed = allowed_models(user_api_key_dict, client.models) & compatible_models(
                data, client.models
            )
            # One wall-clock deadline also bounds LiteLLM's authorization recheck.
            async with asyncio.timeout(client.timeout):
                decision = await client.decide(
                    data.get("model"), data.get("messages"), allowed_models=allowed
                )
                if decision.model != data.get("model"):
                    if user_api_key_dict is not None:
                        from litellm.proxy.auth.auth_checks import can_key_call_resolved_model
                        from litellm.proxy.proxy_server import llm_model_list, llm_router

                        await can_key_call_resolved_model(
                            model=decision.model,
                            llm_model_list=llm_model_list,
                            valid_token=user_api_key_dict,
                            llm_router=llm_router,
                        )
                    data["model"] = decision.model
                self._record(decision.reason)
        except TimeoutError:
            self._record("router_timeout")
        except Exception:  # noqa: BLE001 - optional routing must preserve inference on failure
            self._record("routing_unavailable")
        return data


router_hook = CavemanRouterHook()
