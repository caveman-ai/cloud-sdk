"""Caveman Gate — Agent-native human approval checkpoints backed by Caveman Cloud's
server-enforced Inbox decision queue (`POST /api/v1/code/gates`, `GET /api/v1/code/gates/{id}`).

Security invariants:
- Agents (with a `code:run` API key or session token) may ONLY file a gate and poll its
  status; the server permanently blocks agents/API keys/device tokens from approving or denying.
- Gates are immutable once filed: retrying with the same `dedupe_key` returns the original
  item untouched (no mid-review bait-and-switch, no post-decision audit wipe).
- Diff artifacts are sent with `patch` and `data_untrusted: True`.
- Every wait fails closed: denial raises `GateDeniedError`, timeout raises `GateTimeoutError`.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
import functools
import math
import re
import time
from typing import Any, Literal, TypeVar

from .platform2027 import PlatformError, _PlatformTransport, _quote

_T = TypeVar("_T")
GateRisk = Literal["low", "medium", "high", "critical"]

_MIN_POLL_INTERVAL_SECONDS = 0.25
_WORKFLOW_SLUG_RE = re.compile(r"^[a-z0-9_-]{1,200}$")


def _validate_positive_finite(name: str, value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise GateError("cave_gate_invalid_option", f"{name} must be a positive finite number.")
    return float(value)


def _validate_non_negative_finite(name: str, value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise GateError("cave_gate_invalid", f"{name} must be a non-negative finite number.")
    return float(value)


@dataclass(frozen=True)
class GatePending:
    item_id: str
    action: str
    title: str
    dedupe_key: str
    status: str
    created_at: str


@dataclass(frozen=True)
class GateDecision:
    item_id: str
    action: str
    approved: bool
    decision: Literal["approved", "denied"]
    decided_by: str
    decided_at: str


class GateError(PlatformError):
    """Base error raised by Caveman Gate."""

    def __init__(self, code: str, message: str, status: int = 0, item_id: str | None = None) -> None:
        super().__init__(code, message, status)
        self.item_id = item_id


class GateDeniedError(GateError):
    """Raised when a human denies (or archives without approving) a gated action."""

    def __init__(self, decision: GateDecision, message: str | None = None) -> None:
        self.decision = decision
        who = decision.decided_by or "human reviewer"
        super().__init__(
            "cave_gate_denied",
            message or f'Action "{decision.action}" was denied by {who}.',
            403,
            item_id=decision.item_id,
        )


class GateTimeoutError(GateError):
    """Raised fail-closed when no human decision arrives before timeout_seconds."""

    def __init__(self, pending: GatePending, timeout_seconds: float) -> None:
        self.pending = pending
        super().__init__(
            "cave_gate_timeout",
            f'Timed out after {timeout_seconds:.1f}s waiting for human decision on "{pending.action}" ({pending.item_id}).',
            408,
            item_id=pending.item_id,
        )


def _priority_for_risk(risk: str) -> int:
    if risk in ("critical", "high"):
        return 1
    if risk == "low":
        return 3
    return 2


class Gate:
    """First-class human approval checkpoint client built into `caveman_cloud`."""

    def __init__(
        self,
        *,
        control_url: str,
        api_key: str,
        workflow: str | None = None,
        project_id: str | None = None,
        default_timeout_seconds: float = 600.0,
        default_poll_interval_seconds: float = 1.5,
        timeout_seconds: float = 30.0,
        retries: int = 2,
        retry_delay_seconds: float = 0.25,
        opener: Any = None,
    ) -> None:
        self._tx = _PlatformTransport(
            control_url=control_url,
            api_key=api_key,
            timeout_seconds=timeout_seconds,
            retries=retries,
            retry_delay_seconds=retry_delay_seconds,
            opener=opener,
        )
        if workflow is not None and not _WORKFLOW_SLUG_RE.match(workflow):
            raise GateError("cave_gate_invalid_option", "workflow must match ^[a-z0-9_-]{1,200}$.")
        self._workflow = workflow
        self._project_id = project_id
        self._default_timeout = _validate_positive_finite("default_timeout_seconds", default_timeout_seconds)
        poll = _validate_positive_finite("default_poll_interval_seconds", default_poll_interval_seconds)
        self._default_poll = max(_MIN_POLL_INTERVAL_SECONDS, poll)

    def request(
        self,
        *,
        action: str,
        summary: str,
        title: str | None = None,
        risk: GateRisk = "medium",
        facts: list[dict[str, str]] | None = None,
        diff: dict[str, str] | None = None,
        note: dict[str, str] | None = None,
        cost_usd: float | None = None,
        workflow: str | None = None,
        project_id: str | None = None,
        dedupe_key: str | None = None,
        href: str = "",
    ) -> GatePending:
        """File a human-only approval checkpoint via `POST /api/v1/code/gates`."""
        act = action.strip()
        if not act:
            raise GateError("cave_gate_invalid", "action is required.")
        summ = summary.strip()
        if not summ:
            raise GateError("cave_gate_invalid", "summary is required.")
        if cost_usd is not None:
            cost_usd = _validate_non_negative_finite("cost_usd", cost_usd)
        wf = workflow if workflow is not None else self._workflow
        if wf is not None and not _WORKFLOW_SLUG_RE.match(wf):
            raise GateError("cave_gate_invalid", "workflow must match ^[a-z0-9_-]{1,200}$.")

        item_title = ((title or "").strip() or f"Approve {act}")[:200]
        fact_rows: list[dict[str, str]] = [
            {"label": "Action", "value": act},
            {"label": "Risk", "value": risk},
        ]
        if cost_usd is not None:
            fact_rows.append({"label": "Estimated impact", "value": f"${cost_usd:.2f}"})
        if facts:
            for row in facts:
                lbl = str(row.get("label") or "").strip()
                if lbl and "value" in row:
                    fact_rows.append({"label": lbl, "value": str(row["value"])})

        artifacts: list[dict[str, Any]] = [
            {"type": "facts", "title": "Action details", "facts": fact_rows},
        ]
        if diff and diff.get("patch"):
            artifacts.append(
                {
                    "type": "diff",
                    "title": str(diff.get("title") or "Proposed diff").strip() or "Proposed diff",
                    "patch": str(diff["patch"]),
                    "data_untrusted": True,
                }
            )
        if note and note.get("text"):
            artifacts.append(
                {
                    "type": "text",
                    "title": str(note.get("title") or "Details").strip() or "Details",
                    "text": str(note["text"]),
                }
            )

        body: dict[str, Any] = {
            "kind": "needs_you",
            "priority": _priority_for_risk(risk),
            "source": "agents",
            "scope": f"gate:{act}",
            "title": item_title,
            "summary": summ,
            "ref_type": "agent_gate",
            "ref_id": act,
            "href": href,
            "dedupe_key": dedupe_key or "",
            "artifacts": artifacts,
        }
        pid = project_id or self._project_id
        if pid:
            body["project_id"] = pid
        if wf:
            body["data"] = {"workflow": wf}

        item = self._tx.request("POST", "/api/v1/code/gates", body)
        item_id = str(item.get("id") or "")
        if not item_id or item.get("ref_type") != "agent_gate" or item.get("ref_id") != act:
            raise GateError(
                "cave_gate_protocol_error",
                f'Server returned an unexpected or mismatched gate response (expected action "{act}", got "{item.get("ref_id") or ""}").',
            )
        return GatePending(
            item_id=item_id,
            action=act,
            title=str(item.get("title") or item_title),
            dedupe_key=str(item.get("dedupe_key") or ""),
            status=str(item.get("status") or "open"),
            created_at=str(item.get("created_at") or ""),
        )

    def wait(
        self,
        pending: GatePending,
        *,
        timeout_seconds: float | None = None,
        poll_interval_seconds: float | None = None,
    ) -> GateDecision:
        """Poll `GET /api/v1/code/gates/{id}` until a verified human approves or denies."""
        timeout = (
            _validate_positive_finite("timeout_seconds", timeout_seconds)
            if timeout_seconds is not None
            else self._default_timeout
        )
        poll = max(
            _MIN_POLL_INTERVAL_SECONDS,
            _validate_positive_finite("poll_interval_seconds", poll_interval_seconds)
            if poll_interval_seconds is not None
            else self._default_poll,
        )
        deadline = time.monotonic() + timeout

        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise GateTimeoutError(pending, timeout)
            try:
                item = self._tx.request(
                    "GET",
                    f"/api/v1/code/gates/{_quote(pending.item_id)}",
                    timeout_seconds=max(0.05, remaining),
                    deadline_monotonic=deadline,
                )
            except PlatformError as exc:
                if exc.code == "cave_timeout":
                    raise GateTimeoutError(pending, timeout) from None
                raise
            except TimeoutError:
                if time.monotonic() >= deadline:
                    raise GateTimeoutError(pending, timeout) from None
                raise
            if item.get("id") != pending.item_id or item.get("ref_type") != "agent_gate" or item.get("ref_id") != pending.action:
                raise GateError("cave_gate_protocol_error", "Server returned mismatched gate item.", item_id=pending.item_id)

            if time.monotonic() > deadline:
                raise GateTimeoutError(pending, timeout)

            data = item.get("data") if isinstance(item.get("data"), dict) else {}
            gate_decision = data.get("gate_decision")
            decided_by = str(data.get("gate_decided_by") or "")
            decided_at = str(item.get("resolved_at") or datetime.now(timezone.utc).isoformat())
            status = str(item.get("status") or "open")

            if gate_decision == "approved":
                return GateDecision(
                    item_id=str(item.get("id") or pending.item_id),
                    action=pending.action,
                    approved=True,
                    decision="approved",
                    decided_by=decided_by,
                    decided_at=decided_at,
                )
            if gate_decision == "denied" or status in ("resolved", "archived"):
                decision = GateDecision(
                    item_id=str(item.get("id") or pending.item_id),
                    action=pending.action,
                    approved=False,
                    decision="denied",
                    decided_by=decided_by,
                    decided_at=decided_at,
                )
                raise GateDeniedError(decision)

            after_remaining = deadline - time.monotonic()
            if after_remaining <= 0:
                raise GateTimeoutError(pending, timeout)
            time.sleep(min(poll, after_remaining))

    def require(
        self,
        *,
        action: str,
        summary: str,
        title: str | None = None,
        risk: GateRisk = "medium",
        facts: list[dict[str, str]] | None = None,
        diff: dict[str, str] | None = None,
        note: dict[str, str] | None = None,
        cost_usd: float | None = None,
        workflow: str | None = None,
        project_id: str | None = None,
        dedupe_key: str | None = None,
        href: str = "",
        timeout_seconds: float | None = None,
        poll_interval_seconds: float | None = None,
    ) -> GateDecision:
        """File a human approval checkpoint and block until approved (raises GateDeniedError / GateTimeoutError)."""
        pending = self.request(
            action=action,
            summary=summary,
            title=title,
            risk=risk,
            facts=facts,
            diff=diff,
            note=note,
            cost_usd=cost_usd,
            workflow=workflow,
            project_id=project_id,
            dedupe_key=dedupe_key,
            href=href,
        )
        return self.wait(
            pending,
            timeout_seconds=timeout_seconds,
            poll_interval_seconds=poll_interval_seconds,
        )

    def guard(
        self,
        *,
        action: str,
        summary: Callable[..., str],
        risk: GateRisk = "high",
        title: Callable[..., str] | None = None,
        facts: Callable[..., list[dict[str, str]]] | None = None,
        diff: Callable[..., dict[str, str] | None] | None = None,
        cost_usd: Callable[..., float | None] | None = None,
        when: Callable[..., bool] | None = None,
        timeout_seconds: float | None = None,
        poll_interval_seconds: float | None = None,
    ) -> Callable[[Callable[..., _T]], Callable[..., _T]]:
        """Decorator that places any sensitive tool or function behind a Caveman Gate."""

        def decorator(fn: Callable[..., _T]) -> Callable[..., _T]:
            @functools.wraps(fn)
            def wrapped(*args: Any, **kwargs: Any) -> _T:
                if when is not None and not when(*args, **kwargs):
                    return fn(*args, **kwargs)
                self.require(
                    action=action,
                    summary=summary(*args, **kwargs),
                    title=title(*args, **kwargs) if title is not None else None,
                    risk=risk,
                    facts=facts(*args, **kwargs) if facts is not None else None,
                    diff=diff(*args, **kwargs) if diff is not None else None,
                    cost_usd=cost_usd(*args, **kwargs) if cost_usd is not None else None,
                    timeout_seconds=timeout_seconds,
                    poll_interval_seconds=poll_interval_seconds,
                )
                return fn(*args, **kwargs)

            return wrapped

        return decorator
