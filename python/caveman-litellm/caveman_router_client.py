"""Gateway-neutral, bounded client for Caveman's existing /v1/route contract."""

from __future__ import annotations

import asyncio
import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

# Caveman Cloud reads the ask from messages (/v1/route's messages path): the
# last user turn with words is the ask, the one before it the previous ask, the
# newest assistant text before it the agent's reply, and the user turns before
# it the turn. Its model reads the first 1,500 characters of the previous ask
# and the last 2,000 of the reply, and only counts the earlier asks. Each
# message is at most 64 KiB encoded and the body at most 256 KiB, so the client
# sends no more than that, keeping the end of an over-long ask as the hub does.
ASK_BYTES = 60 * 1024
PREVIOUS_ASK_CHARS = 1500
REPLY_CHARS = 2000
EARLIER_ASK = "…"  # an earlier ask's stand-in: Cloud counts it and reads nothing else
MAX_MESSAGES = 256
MAX_RESPONSE_BYTES = 65536
MAX_MODELS = 64


def route_url(value: str) -> str:
    parts = urlsplit(value.strip())
    if (
        parts.scheme not in {"http", "https"}
        or not parts.hostname
        or parts.username
        or parts.password
        or parts.query
        or parts.fragment
    ):
        raise ValueError(
            "Router URL must be an http(s) origin or /v1/route URL without credentials or query"
        )
    path = parts.path.rstrip("/")
    if path not in {"", "/v1", "/v1/route"}:
        raise ValueError("Router URL path must be empty, /v1, or /v1/route")
    return urlunsplit((parts.scheme, parts.netloc, "/v1/route", "", ""))


def timeout_seconds(value: Any = 0.15) -> float:
    try:
        result = float(value)
    except (ValueError, TypeError):
        return 0.15
    return result if math.isfinite(result) and 0 < result <= 5 else 0.15


def model_map(value: Mapping[str, str]) -> dict[str, str]:
    if not 1 <= len(value) <= MAX_MODELS:
        raise ValueError("Configure 1 to 64 model aliases")
    result = {}
    for alias, identity in value.items():
        if any(
            not isinstance(x, str) or not x.strip() or x != x.strip() or len(x) > 256
            for x in (alias, identity)
        ):
            raise ValueError(
                "Model aliases and identities must be non-empty strings of at most 256 characters"
            )
        result[alias] = identity
    return result


_REMINDER_OPEN, _REMINDER_CLOSE = "<system-reminder>", "</system-reminder>"


def _strip_system_reminders(text: str) -> str:
    # Linear scan: a lazy regex is quadratic on a turn of unclosed openers.
    kept, pos = [], 0
    while (start := text.find(_REMINDER_OPEN, pos)) != -1:
        end = text.find(_REMINDER_CLOSE, start + len(_REMINDER_OPEN))
        if end == -1:
            break
        kept.append(text[pos:start])
        pos = end + len(_REMINDER_CLOSE)
    kept.append(text[pos:])
    return "".join(kept)


def _message_text(content: Any, *, human: bool) -> str:
    """Text blocks only; a human turn carrying a tool result is not a human turn.

    A reply's blocks are joined by a space, as the router's ReplyTail joins them.
    """
    blocks = [content] if isinstance(content, str) else content if isinstance(content, list) else []
    if human and any(
        isinstance(b, dict) and b.get("type") in {"tool_result", "function_call_output"}
        for b in blocks
    ):
        return ""
    parts = []
    for block in blocks:
        text = (
            block
            if isinstance(block, str)
            else block.get("text")
            if isinstance(block, dict) and block.get("type") in {"text", "input_text"}
            else None
        )
        if isinstance(text, str):
            text = (_strip_system_reminders(text) if human else text).strip()
            if text:
                parts.append(text)
    return ("\n" if human else " ").join(parts)


def _encoded_bytes(text: str) -> int:
    return len(json.dumps(text, ensure_ascii=False).encode("utf-8"))


def _tail(text: str, budget: int) -> str:
    # Slice characters first so a huge turn is never encoded whole.
    text = text[-budget:]
    while _encoded_bytes(text) > budget:
        text = text[len(text) // 4 :]
    return text


def route_messages(messages: Any) -> list[dict[str, str]]:
    """The conversation as Cloud reads an ask from it, bounded to what it reads."""
    if not isinstance(messages, list):
        return []
    turns = []
    for message in messages:
        if isinstance(message, dict) and message.get("role") in {"user", "assistant"}:
            human = message["role"] == "user"
            if text := _message_text(message.get("content"), human=human):
                turns.append((message["role"], text))
    asks = [i for i, (role, _) in enumerate(turns) if role == "user"]
    if not asks:
        return []
    last = asks[-1]
    previous = asks[-2] if len(asks) > 1 else None
    reply = next((i for i in range(last - 1, -1, -1) if turns[i][0] == "assistant"), None)
    out = []
    for i, (role, text) in enumerate(turns[: last + 1]):
        if i == last:
            out.append({"role": "user", "content": _tail(text, ASK_BYTES)})
        elif i == previous:
            out.append({"role": "user", "content": text[:PREVIOUS_ASK_CHARS]})
        elif i == reply:
            out.append({"role": "assistant", "content": text[-REPLY_CHARS:]})
        elif role == "user":
            out.append({"role": "user", "content": EARLIER_ASK})
    return out[-MAX_MESSAGES:]


# Cloud's reasons are short snake_case words; anything else is no label to count.
_REASON = re.compile(r"[a-z][a-z0-9_]{0,39}")


@dataclass(frozen=True)
class Decision:
    model: str
    reason: str
    status_code: int | None = None


class RouterClient:
    """One client per application/event loop. Use async with or call aclose().

    Keys in models are deployment aliases; values are router model identities.
    The router receives the conversation's text and identities only, never
    provider credentials.
    """

    def __init__(
        self,
        url: str,
        models: Mapping[str, str],
        *,
        token: str = "",
        timeout: float = 0.15,
        max_concurrency: int = 32,
        http_client: httpx.AsyncClient | None = None,
    ):
        self.url = route_url(url)
        self.models = model_map(models)
        self.token = token
        self.timeout = timeout_seconds(timeout)
        if not 1 <= max_concurrency <= 256:
            raise ValueError("max_concurrency must be from 1 to 256")
        self._slots = asyncio.Semaphore(max_concurrency)
        # Inject a caller-owned HTTPX client for custom TLS, corporate proxies,
        # or an in-process ASGI transport. Its lifetime stays with the caller.
        self._owns_client = http_client is None
        self._client = http_client

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.aclose()

    async def aclose(self):
        if self._client is not None and self._owns_client:
            await self._client.aclose()
            self._client = None

    async def decide(self, model: str, messages: Any, *, allowed_models=None) -> Decision:
        fallback = lambda reason, status_code=None: Decision(model, reason, status_code)
        if model not in self.models:
            return fallback("out_of_scope")
        pool = dict(self.models)
        if allowed_models is not None:
            pool = {key: value for key, value in pool.items() if key in allowed_models}
        if model not in pool:
            return fallback("not_authorized")
        # Never guess between two deployment aliases with the same identity.
        counts = {identity: list(pool.values()).count(identity) for identity in pool.values()}
        pool = {key: value for key, value in pool.items() if counts[value] == 1 or key == model}
        if len(pool) < 2:
            return fallback("no_alternative")
        conversation = route_messages(messages)
        if not conversation:
            return fallback("no_text")
        if self._slots.locked():
            return fallback("router_busy")
        try:
            # Covers connection, pool wait, headers, and the entire response body.
            async with asyncio.timeout(self.timeout), self._slots:
                if self._client is None:
                    self._client = httpx.AsyncClient(
                        follow_redirects=False,
                        trust_env=False,
                        limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
                    )
                identities = [pool[model]] + [v for k, v in pool.items() if k != model]
                headers = {"Content-Type": "application/json"}
                if self.token:
                    headers["Authorization"] = "Bearer " + self.token
                body = json.dumps(
                    {"messages": conversation, "models": identities},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8")
                async with self._client.stream(
                    "POST",
                    self.url,
                    content=body,
                    headers=headers,
                    timeout=self.timeout,
                    follow_redirects=False,
                ) as response:
                    if response.status_code != 200:
                        return fallback("router_http_error", response.status_code)
                    answer = bytearray()
                    async for chunk in response.aiter_bytes(chunk_size=8192):
                        answer.extend(chunk)
                        if len(answer) > MAX_RESPONSE_BYTES:
                            return fallback("invalid_response")

                reply = json.loads(answer)
                if not isinstance(reply, dict):
                    return fallback("invalid_response")
                # Any answer naming a model of the pool is the answer, kept
                # with Cloud's reason (it names models[0] when it made no
                # decision, and says why).
                selected = reply.get("model")
                if not isinstance(selected, str) or selected not in pool.values():
                    return fallback("invalid_response")
                alias = next(key for key, value in pool.items() if value == selected)
                reason = reply.get("reason")
                if not isinstance(reason, str) or not _REASON.fullmatch(reason):
                    reason = "decided"
                return Decision(alias, reason)
        except TimeoutError:
            return fallback("router_timeout")
        except Exception:  # noqa: BLE001 - transport/decoding failures keep the caller's model
            # Never emit exception text: transport errors can contain the token or prompt.
            return fallback("router_error")
