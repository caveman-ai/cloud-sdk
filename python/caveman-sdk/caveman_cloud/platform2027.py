"""Zero-dependency typed clients for Caveman Cloud Phase 0/1/2 primitives:

- Rooms (decoupled multi-agent conversations, atomic leases, taint tracking)
- Apps & AppBridge (Drive-backed / Sandbox-backed forkable tenant apps)
- Listeners & Predicate (dynamic TTL-bounded event streams + deterministic filters)
- Workflows & WorkflowContext (code-first durable execution + two-phase replay)
- ComputerPools (org-wide N:M computer pools & multi-sandbox session leases)
"""
from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import json
import threading
import time
from typing import Any, TypeVar
import urllib.error
import urllib.parse
import urllib.request

from .cloud import CloudError

_T = TypeVar("_T")
_List = list
_LIMIT = 16 * 1024 * 1024


class PlatformError(CloudError):
    """Typed HTTP/contract error returned by Caveman Cloud Phase 0/1/2 APIs."""

    def __init__(
        self,
        code: str,
        message: str,
        status: int = 0,
        retry_after: int | None = None,
    ) -> None:
        super().__init__(code, message, status)
        self.retry_after = retry_after


class WorkflowUncertainEffectError(PlatformError):
    """Raised fail-closed when an external side-effect step crashed mid-flight."""

    def __init__(self, step_key: str, message: str | None = None) -> None:
        self.step_key = step_key
        super().__init__(
            "cave_workflow_uncertain_effect",
            message or f"Step {step_key} crashed mid-external effect; operator review required.",
            409,
        )


class WorkflowParkedError(PlatformError):
    """Control-flow exception raised when a workflow parks on a durable awakeable."""

    def __init__(self, wait: dict[str, Any]) -> None:
        self.wait = wait
        kind = str(wait.get("kind") or "wait")
        wait_id = str(wait.get("id") or "")
        super().__init__(
            "cave_workflow_parked",
            f"Workflow parked waiting on {kind} ({wait_id}).",
            202,
        )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> urllib.request.Request | None:
        raise PlatformError("cave_redirect_denied", "Cloud redirects are not followed.", code)


class _PlatformTransport:
    def __init__(
        self,
        *,
        control_url: str,
        api_key: str,
        timeout_seconds: float = 30.0,
        retries: int = 2,
        retry_delay_seconds: float = 0.25,
        opener: Any = None,
    ) -> None:
        parsed = urllib.parse.urlsplit(control_url)
        if (
            parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or not parsed.hostname
            or (
                parsed.scheme != "https"
                and not (
                    parsed.scheme == "http"
                    and parsed.hostname in ("localhost", "127.0.0.1", "::1")
                )
            )
        ):
            raise PlatformError(
                "cave_endpoint_invalid",
                "control_url must be HTTPS or loopback HTTP without credentials, query, or fragment.",
                0,
            )
        if not api_key or not api_key.strip():
            raise PlatformError("cave_auth_required", "api_key is required.", 0)
        if (
            isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, (int, float))
            or not 0.1 <= timeout_seconds <= 120.0
        ):
            raise PlatformError("cave_timeout_invalid", "timeout_seconds must be between 0.1 and 120.", 0)
        self.base_url = control_url.rstrip("/")
        self.api_key = api_key.strip()
        self.timeout_seconds = float(timeout_seconds)
        self.retries = max(0, int(retries))
        self.retry_delay_seconds = max(0.0, float(retry_delay_seconds))
        self._opener = opener if opener is not None else urllib.request.build_opener(_NoRedirect())

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        idempotency_key: str | None = None,
        timeout_seconds: float | None = None,
        deadline_monotonic: float | None = None,
    ) -> dict[str, Any]:
        attempt = 0
        while True:
            headers = {
                "authorization": f"Bearer {self.api_key}",
                "x-cave-client": "caveman-sdk-python",
            }
            if idempotency_key:
                headers["idempotency-key"] = idempotency_key
            data: bytes | None = None
            if body is not None:
                headers["content-type"] = "application/json"
                data = json.dumps(body).encode("utf-8")
                if len(data) > _LIMIT:
                    raise PlatformError("cave_input_invalid", "Request payload exceeds 16 MiB.", 400)
            req = urllib.request.Request(
                f"{self.base_url}{path}",
                data=data,
                headers=headers,
                method=method,
            )
            eff_timeout = self.timeout_seconds
            if timeout_seconds is not None and timeout_seconds > 0:
                eff_timeout = max(0.05, min(eff_timeout, float(timeout_seconds)))
            if deadline_monotonic is not None:
                rem = deadline_monotonic - time.monotonic()
                if rem <= 0:
                    raise PlatformError("cave_timeout", "Request deadline exceeded.", 408)
                eff_timeout = max(0.001, min(eff_timeout, rem))
            status = 0
            raw = b""
            retry_after: int | None = None
            try:
                resp = self._opener.open(req, timeout=eff_timeout)
            except urllib.error.HTTPError as err:
                resp = err
            except TimeoutError:
                if deadline_monotonic is not None and time.monotonic() >= deadline_monotonic:
                    raise PlatformError("cave_timeout", "Request deadline exceeded.", 408) from None
                raise
            with resp:
                status = int(getattr(resp, "status", 0) or getattr(resp, "code", 0))
                resp_headers = getattr(resp, "headers", None)
                if resp_headers is not None:
                    ra = resp_headers.get("retry-after")
                    if ra is not None:
                        try:
                            parsed_ra = int(float(ra))
                            if parsed_ra >= 0:
                                retry_after = min(parsed_ra, 60)
                        except ValueError:
                            retry_after = None
                raw = resp.read(_LIMIT + 1)
            if len(raw) > _LIMIT:
                raise PlatformError("cave_result_too_large", "Response exceeds 16 MiB.", status)
            parsed: dict[str, Any] = {}
            if raw:
                try:
                    loaded = json.loads(raw.decode("utf-8"))
                    if isinstance(loaded, dict):
                        parsed = loaded
                except (ValueError, UnicodeError):
                    parsed = {}
            if 200 <= status < 300:
                return parsed
            if (status == 429 or status >= 500) and attempt < self.retries:
                attempt += 1
                wait = (
                    float(retry_after)
                    if retry_after is not None and retry_after >= 0
                    else self.retry_delay_seconds * (2 ** (attempt - 1))
                )
                if deadline_monotonic is not None:
                    rem = deadline_monotonic - time.monotonic()
                    if rem <= 0 or wait >= rem:
                        raise PlatformError("cave_timeout", "Request deadline exceeded during retry backoff.", 408)
                if wait > 0:
                    time.sleep(wait)
                continue
            raw_err = parsed.get("error")
            err_obj: dict[str, Any] = raw_err if isinstance(raw_err, dict) else {}
            code = str(err_obj.get("code") or f"http_{status}")
            message = str(err_obj.get("message") or f"HTTP {status}")
            raise PlatformError(code, message, status, retry_after=retry_after)


def _quote(value: str) -> str:
    return urllib.parse.quote(value, safe="")


# ================================== ROOMS ==================================


class Rooms:
    """Decoupled multi-agent conversations, atomic task leases, and watchers."""

    def __init__(
        self,
        *,
        control_url: str,
        api_key: str,
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

    def create(
        self,
        *,
        slug: str,
        name: str | None = None,
        description: str | None = None,
        visibility: str = "org",
        taint_policy: str = "propagate",
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "slug": slug,
            "visibility": visibility,
            "taint_policy": taint_policy,
        }
        if name is not None:
            payload["name"] = name
        if description is not None:
            payload["description"] = description
        return self._tx.request("POST", "/api/v1/code/rooms", payload)

    def list(self) -> list[dict[str, Any]]:
        res = self._tx.request("GET", "/api/v1/code/rooms")
        items = res.get("rooms")
        return list(items) if isinstance(items, list) else []

    def get(self, room: str) -> dict[str, Any]:
        return self._tx.request("GET", f"/api/v1/code/rooms/{_quote(room)}")

    def archive(self, room: str) -> dict[str, Any]:
        return self._tx.request("POST", f"/api/v1/code/rooms/{_quote(room)}/archive", {})

    def create_thread(
        self,
        room: str,
        *,
        title: str,
        body: str | None = None,
        status: str | None = None,
        labels: _List[str] | None = None,
        depends_on: _List[str] | None = None,
        session_id: str | None = None,
        structured_data: Any = None,
        app_ref: Any = None,
        untrusted: bool = False,
        taint_source: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"title": title}
        if body is not None:
            payload["body"] = body
        if status is not None:
            payload["status"] = status
        if labels is not None:
            payload["labels"] = labels
        if depends_on is not None:
            payload["depends_on"] = depends_on
        if session_id is not None:
            payload["session_id"] = session_id
        if structured_data is not None:
            payload["structured_data"] = structured_data
        if app_ref is not None:
            payload["app_ref"] = app_ref
        if untrusted:
            payload["untrusted"] = True
        if taint_source is not None:
            payload["taint_source"] = taint_source
        return self._tx.request("POST", f"/api/v1/code/rooms/{_quote(room)}/threads", payload)

    def list_threads(
        self,
        room: str,
        *,
        status: str | None = None,
        label: str | None = None,
        limit: int | None = None,
    ) -> _List[dict[str, Any]]:
        params: list[tuple[str, str]] = []
        if status is not None:
            params.append(("status", status))
        if label is not None:
            params.append(("label", label))
        if limit is not None:
            params.append(("limit", str(limit)))
        qs = f"?{urllib.parse.urlencode(params)}" if params else ""
        res = self._tx.request("GET", f"/api/v1/code/rooms/{_quote(room)}/threads{qs}")
        items = res.get("threads")
        return list(items) if isinstance(items, list) else []

    def get_thread(self, room: str, thread_id: str) -> dict[str, Any]:
        return self._tx.request(
            "GET",
            f"/api/v1/code/rooms/{_quote(room)}/threads/{_quote(thread_id)}",
        )

    def claim(
        self,
        room: str,
        thread_id: str,
        *,
        ttl_seconds: int = 300,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"ttl_seconds": ttl_seconds}
        if session_id is not None:
            payload["session_id"] = session_id
        return self._tx.request(
            "POST",
            f"/api/v1/code/rooms/{_quote(room)}/threads/{_quote(thread_id)}/claim",
            payload,
        )

    def renew(
        self,
        room: str,
        thread_id: str,
        *,
        lease_token: str,
        ttl_seconds: int = 300,
    ) -> dict[str, Any]:
        return self._tx.request(
            "POST",
            f"/api/v1/code/rooms/{_quote(room)}/threads/{_quote(thread_id)}/renew",
            {"lease_token": lease_token, "ttl_seconds": ttl_seconds},
        )

    def release(
        self,
        room: str,
        thread_id: str,
        *,
        lease_token: str | None = None,
        note: str | None = None,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        if lease_token is not None:
            payload["lease_token"] = lease_token
        if note is not None:
            payload["note"] = note
        if session_id is not None:
            payload["session_id"] = session_id
        return self._tx.request(
            "POST",
            f"/api/v1/code/rooms/{_quote(room)}/threads/{_quote(thread_id)}/release",
            payload,
        )

    def complete(
        self,
        room: str,
        thread_id: str,
        *,
        lease_token: str | None = None,
        note: str | None = None,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        if lease_token is not None:
            payload["lease_token"] = lease_token
        if note is not None:
            payload["note"] = note
        if session_id is not None:
            payload["session_id"] = session_id
        return self._tx.request(
            "POST",
            f"/api/v1/code/rooms/{_quote(room)}/threads/{_quote(thread_id)}/complete",
            payload,
        )

    def post(
        self,
        room: str,
        thread_id: str,
        *,
        body: str,
        kind: str = "message",
        sender_name: str | None = None,
        session_id: str | None = None,
        structured_data: Any = None,
        app_ref: Any = None,
        untrusted: bool = False,
        taint_source: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"body": body, "kind": kind}
        if sender_name is not None:
            payload["sender_name"] = sender_name
        if session_id is not None:
            payload["session_id"] = session_id
        if structured_data is not None:
            payload["structured_data"] = structured_data
        if app_ref is not None:
            payload["app_ref"] = app_ref
        if untrusted:
            payload["untrusted"] = True
        if taint_source is not None:
            payload["taint_source"] = taint_source
        return self._tx.request(
            "POST",
            f"/api/v1/code/rooms/{_quote(room)}/threads/{_quote(thread_id)}/messages",
            payload,
            idempotency_key=idempotency_key,
        )

    def list_messages(
        self,
        room: str,
        thread_id: str,
        *,
        after_seq: int | None = None,
        limit: int | None = None,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        params: list[tuple[str, str]] = []
        if after_seq is not None:
            params.append(("after_seq", str(after_seq)))
        if limit is not None:
            params.append(("limit", str(limit)))
        if session_id is not None:
            params.append(("session_id", session_id))
        qs = f"?{urllib.parse.urlencode(params)}" if params else ""
        return self._tx.request(
            "GET",
            f"/api/v1/code/rooms/{_quote(room)}/threads/{_quote(thread_id)}/messages{qs}",
        )

    def wait(
        self,
        room: str,
        thread_id: str,
        *,
        after_seq: int | None = None,
        timeout: int | None = None,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        params: list[tuple[str, str]] = []
        if after_seq is not None:
            params.append(("after_seq", str(after_seq)))
        if timeout is not None:
            params.append(("timeout", str(timeout)))
        if session_id is not None:
            params.append(("session_id", session_id))
        qs = f"?{urllib.parse.urlencode(params)}" if params else ""
        return self._tx.request(
            "GET",
            f"/api/v1/code/rooms/{_quote(room)}/threads/{_quote(thread_id)}/wait{qs}",
        )

    def watch(
        self,
        room: str,
        *,
        watcher_kind: str,
        target_id: str,
        thread_id: str | None = None,
        filter_labels: _List[str] | None = None,
        on_events: _List[str] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "watcher_kind": watcher_kind,
            "target_id": target_id,
        }
        if thread_id is not None:
            payload["thread_id"] = thread_id
        if filter_labels is not None:
            payload["filter_labels"] = filter_labels
        if on_events is not None:
            payload["on_events"] = on_events
        return self._tx.request("POST", f"/api/v1/code/rooms/{_quote(room)}/watchers", payload)

    def rollup(self, room: str, thread_id: str) -> dict[str, Any]:
        return self._tx.request(
            "GET",
            f"/api/v1/code/rooms/{_quote(room)}/threads/{_quote(thread_id)}/rollup",
        )

    @contextmanager
    def lease(
        self,
        room: str,
        thread_id: str,
        *,
        ttl_seconds: int = 300,
        session_id: str | None = None,
        renew_every_seconds: float | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Atomically claim a thread, heartbeat-renew while active, complete on clean exit or release on exception."""
        claimed = self.claim(room, thread_id, ttl_seconds=ttl_seconds, session_id=session_id)
        lease_token = str(claimed.get("lease_token") or "")
        stop_event = threading.Event()
        interval = (
            float(renew_every_seconds)
            if renew_every_seconds is not None
            else max(5.0, float(ttl_seconds) / 2.0)
        )

        def _heartbeat() -> None:
            while not stop_event.wait(interval):
                try:
                    self.renew(room, thread_id, lease_token=lease_token, ttl_seconds=ttl_seconds)
                except Exception:
                    pass

        worker = threading.Thread(target=_heartbeat, name=f"cave-lease-{thread_id}", daemon=True)
        worker.start()
        try:
            yield claimed
        except BaseException as exc:
            stop_event.set()
            worker.join(timeout=1.0)
            try:
                self.release(
                    room,
                    thread_id,
                    lease_token=lease_token,
                    session_id=session_id,
                    note=str(exc) or "worker failed",
                )
            except Exception:
                pass
            raise
        else:
            stop_event.set()
            worker.join(timeout=1.0)
            self.complete(room, thread_id, lease_token=lease_token, session_id=session_id)


# =================================== APPS ==================================


class Apps:
    """Forkable Drive-backed and Sandbox-backed tenant Apps."""

    def __init__(
        self,
        *,
        control_url: str,
        api_key: str,
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

    def create(
        self,
        *,
        slug: str,
        kind: str = "drive_static",
        name: str | None = None,
        description: str | None = None,
        drive: str | None = None,
        drive_folder: str | None = None,
        entry_file: str | None = None,
        computer_id: str | None = None,
        port: int | None = None,
        visibility: str = "org",
        manifest: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"slug": slug, "kind": kind, "visibility": visibility}
        if name is not None:
            payload["name"] = name
        if description is not None:
            payload["description"] = description
        if drive is not None:
            payload["drive"] = drive
        if drive_folder is not None:
            payload["drive_folder"] = drive_folder
        if entry_file is not None:
            payload["entry_file"] = entry_file
        if computer_id is not None:
            payload["computer_id"] = computer_id
        if port is not None:
            payload["port"] = port
        if manifest is not None:
            payload["manifest"] = manifest
        return self._tx.request("POST", "/api/v1/code/apps", payload)

    def list(self) -> list[dict[str, Any]]:
        res = self._tx.request("GET", "/api/v1/code/apps")
        items = res.get("apps")
        return list(items) if isinstance(items, list) else []

    def get(self, app: str) -> dict[str, Any]:
        return self._tx.request("GET", f"/api/v1/code/apps/{_quote(app)}")

    def fork(
        self,
        app: str,
        *,
        slug: str,
        name: str | None = None,
        drive_name: str | None = None,
        description: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"slug": slug}
        if name is not None:
            payload["name"] = name
        if drive_name is not None:
            payload["drive_name"] = drive_name
        if description is not None:
            payload["description"] = description
        return self._tx.request("POST", f"/api/v1/code/apps/{_quote(app)}/fork", payload)

    def issue_token(
        self,
        app: str,
        *,
        ttl_seconds: int | None = None,
        scopes: _List[str] | None = None,
        inbox_item_id: str | None = None,
        room_thread_id: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        if ttl_seconds is not None:
            payload["ttl_seconds"] = ttl_seconds
        if scopes is not None:
            payload["scopes"] = scopes
        if inbox_item_id is not None:
            payload["inbox_item_id"] = inbox_item_id
        if room_thread_id is not None:
            payload["room_thread_id"] = room_thread_id
        return self._tx.request("POST", f"/api/v1/code/apps/{_quote(app)}/token", payload)

    def archive(self, app: str) -> dict[str, Any]:
        return self._tx.request("POST", f"/api/v1/code/apps/{_quote(app)}/archive", {})


class AppBridge:
    """Scoped capability bridge client for isolated tenant Apps."""

    def __init__(
        self,
        app_id: str,
        *,
        control_url: str,
        api_key: str,
        timeout_seconds: float = 30.0,
        retries: int = 2,
        retry_delay_seconds: float = 0.25,
        opener: Any = None,
    ) -> None:
        self.app_id = app_id
        self._tx = _PlatformTransport(
            control_url=control_url,
            api_key=api_key,
            timeout_seconds=timeout_seconds,
            retries=retries,
            retry_delay_seconds=retry_delay_seconds,
            opener=opener,
        )

    def drive_read(self, path: str) -> dict[str, Any]:
        return self._tx.request(
            "POST",
            f"/api/v1/code/apps/{_quote(self.app_id)}/bridge",
            {"action": "drive.read", "payload": {"path": path}},
        )

    def drive_write(self, path: str, content: str) -> dict[str, Any]:
        return self._tx.request(
            "POST",
            f"/api/v1/code/apps/{_quote(self.app_id)}/bridge",
            {"action": "drive.write", "payload": {"path": path, "content": content}},
        )

    def room_post(
        self,
        room: str,
        thread_id: str,
        body: str,
        *,
        structured_data: Any = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"room": room, "thread_id": thread_id, "body": body}
        if structured_data is not None:
            payload["structured_data"] = structured_data
        return self._tx.request(
            "POST",
            f"/api/v1/code/apps/{_quote(self.app_id)}/bridge",
            {"action": "room.post", "payload": payload},
        )


# ================================ LISTENERS ================================


class Predicate:
    """Composable deterministic predicate builder for Caveman Listeners."""

    @staticmethod
    def all_of(*items: dict[str, Any]) -> dict[str, Any]:
        return {"all": list(items)}

    @staticmethod
    def any_of(*items: dict[str, Any]) -> dict[str, Any]:
        return {"any": list(items)}

    @staticmethod
    def not_(item: dict[str, Any]) -> dict[str, Any]:
        return {"not": item}

    @staticmethod
    def eq(path: str, value: Any) -> dict[str, Any]:
        return {"rule": {"path": path, "op": "eq", "value": value}}

    @staticmethod
    def neq(path: str, value: Any) -> dict[str, Any]:
        return {"rule": {"path": path, "op": "neq", "value": value}}

    @staticmethod
    def contains(path: str, value: str) -> dict[str, Any]:
        return {"rule": {"path": path, "op": "contains", "value": value}}

    @staticmethod
    def icontains(path: str, value: str) -> dict[str, Any]:
        return {"rule": {"path": path, "op": "icontains", "value": value}}

    @staticmethod
    def prefix(path: str, value: str) -> dict[str, Any]:
        return {"rule": {"path": path, "op": "prefix", "value": value}}

    @staticmethod
    def suffix(path: str, value: str) -> dict[str, Any]:
        return {"rule": {"path": path, "op": "suffix", "value": value}}

    @staticmethod
    def regex(path: str, pattern: str) -> dict[str, Any]:
        return {"rule": {"path": path, "op": "regex", "value": pattern}}

    @staticmethod
    def in_list(path: str, values: list[Any]) -> dict[str, Any]:
        return {"rule": {"path": path, "op": "in", "value": values}}

    @staticmethod
    def gt(path: str, value: float) -> dict[str, Any]:
        return {"rule": {"path": path, "op": "gt", "value": value}}

    @staticmethod
    def gte(path: str, value: float) -> dict[str, Any]:
        return {"rule": {"path": path, "op": "gte", "value": value}}

    @staticmethod
    def lt(path: str, value: float) -> dict[str, Any]:
        return {"rule": {"path": path, "op": "lt", "value": value}}

    @staticmethod
    def lte(path: str, value: float) -> dict[str, Any]:
        return {"rule": {"path": path, "op": "lte", "value": value}}

    @staticmethod
    def exists(path: str, value: bool = True) -> dict[str, Any]:
        return {"rule": {"path": path, "op": "exists", "value": value}}


class Listeners:
    """Dynamic TTL-bounded event listeners and deterministic filters."""

    def __init__(
        self,
        *,
        control_url: str,
        api_key: str,
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

    def create(
        self,
        *,
        name: str,
        source_kind: str,
        target_kind: str,
        target_id: str,
        description: str | None = None,
        source_config: dict[str, Any] | None = None,
        filter_kind: str | None = None,
        filter_spec: dict[str, Any] | None = None,
        target_config: dict[str, Any] | None = None,
        ttl_seconds: int | None = None,
        budget_usd: float | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "name": name,
            "source_kind": source_kind,
            "target_kind": target_kind,
            "target_id": target_id,
        }
        if description is not None:
            payload["description"] = description
        if source_config is not None:
            payload["source_config"] = source_config
        if filter_kind is not None:
            payload["filter_kind"] = filter_kind
        if filter_spec is not None:
            payload["filter_spec"] = filter_spec
        if target_config is not None:
            payload["target_config"] = target_config
        if ttl_seconds is not None:
            payload["ttl_seconds"] = ttl_seconds
        if budget_usd is not None:
            payload["budget_usd"] = budget_usd
        return self._tx.request("POST", "/api/v1/code/listeners", payload)

    def list(self) -> list[dict[str, Any]]:
        res = self._tx.request("GET", "/api/v1/code/listeners")
        items = res.get("listeners")
        return list(items) if isinstance(items, list) else []

    def get(self, ref: str) -> dict[str, Any]:
        return self._tx.request("GET", f"/api/v1/code/listeners/{_quote(ref)}")

    def pause(self, ref: str) -> dict[str, Any]:
        return self._tx.request("POST", f"/api/v1/code/listeners/{_quote(ref)}/pause", {})

    def resume(self, ref: str) -> dict[str, Any]:
        return self._tx.request("POST", f"/api/v1/code/listeners/{_quote(ref)}/resume", {})

    def delete(self, ref: str) -> dict[str, Any]:
        return self._tx.request("DELETE", f"/api/v1/code/listeners/{_quote(ref)}")

    def ingest(
        self,
        ref: str,
        payload: Any,
        *,
        trusted: bool = False,
    ) -> dict[str, Any]:
        qs = "?trusted=true" if trusted else ""
        return self._tx.request(
            "POST",
            f"/api/v1/code/listeners/{_quote(ref)}/ingest{qs}",
            payload,
        )

    def stats(self, ref: str) -> dict[str, Any]:
        return self._tx.request("GET", f"/api/v1/code/listeners/{_quote(ref)}/stats")


# ================================ WORKFLOWS ================================


class WorkflowContext:
    """Replay-safe execution context passed into code-first workflow handlers."""

    def __init__(self, workflows: Workflows, run_id: str, session_id: str) -> None:
        self._wf = workflows
        self.run_id = run_id
        self.session_id = session_id

    def step(
        self,
        step_key: str,
        fn: Callable[[], _T],
        *,
        tool_name: str | None = None,
        effect: str = "idempotent",
        kind: str = "code_tool",
        input: Any = None,
    ) -> _T:
        """Execute a deterministic/replayable step backed by code_session_steps."""
        begun = self._wf.begin_step(
            self.run_id,
            step_key=step_key,
            tool_name=tool_name or step_key,
            effect=effect,
            kind=kind,
            input=input,
        )
        action = str(begun.get("action") or "")
        if action == "cached":
            err_code = begun.get("error_code")
            if err_code:
                raise PlatformError(
                    str(err_code),
                    str(begun.get("error_message") or "Cached step failed."),
                    500,
                )
            return begun.get("result")  # type: ignore[return-value]
        if action == "uncertain":
            raise WorkflowUncertainEffectError(step_key)
        try:
            value = fn()
            self._wf.complete_step(
                self.run_id,
                step_key=step_key,
                state="completed",
                result=value,
            )
            return value
        except Exception as exc:
            try:
                self._wf.complete_step(
                    self.run_id,
                    step_key=step_key,
                    state="failed",
                    error_code="step_error",
                    error_message=str(exc),
                )
            except Exception:
                pass
            raise

    def wait(
        self,
        *,
        kind: str,
        ask_id: str | None = None,
        target_id: str | None = None,
        barrier_id: str | None = None,
        expires_at: str | None = None,
        reason: str | None = None,
    ) -> dict[str, Any]:
        """Park the workflow run on a durable awakeable and raise WorkflowParkedError while pending.

        On replay, if the wait already reached a terminal state (resolved, denied, timed_out,
        cancelled), returns the terminal wait row so the workflow proceeds cleanly.
        """
        wait_row = self._wf.park_wait(
            self.run_id,
            kind=kind,
            ask_id=ask_id,
            target_id=target_id,
            barrier_id=barrier_id,
            expires_at=expires_at,
            reason=reason,
        )
        st = str(wait_row.get("status") or "pending").lower()
        if st in ("pending", "waiting", ""):
            raise WorkflowParkedError(wait_row)
        return wait_row

    def sleep(self, seconds: float, *, reason: str = "durable sleep") -> dict[str, Any]:
        """Park on a zero-compute durable timer; returns the resolved wait row on replay."""
        expires = (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")
        return self.wait(kind="timer", expires_at=expires, reason=reason)

    def wait_for_approval(self, ask_id: str, reason: str) -> dict[str, Any]:
        """Park and file an Inbox human decision item automatically; fails closed unless approved/resolved."""
        wait_row = self.wait(kind="approval", ask_id=ask_id, reason=reason)
        st = str(wait_row.get("status") or "").lower()
        if st not in ("resolved", "approved"):
            raise PlatformError(
                "workflow_approval_denied",
                f'Workflow approval "{ask_id}" was not approved (status={st or "unknown"}).',
                403,
            )
        return wait_row

    def approve(self, ask_id: str, reason: str, *, expires_at: str | None = None) -> dict[str, Any]:
        """Caveman Gate alias inside durable workflows: parks at zero compute until human approval; fails closed unless approved/resolved."""
        wait_row = self.wait(kind="approval", ask_id=ask_id, reason=reason, expires_at=expires_at)
        st = str(wait_row.get("status") or "").lower()
        if st not in ("resolved", "approved"):
            raise PlatformError(
                "workflow_approval_denied",
                f'Workflow approval "{ask_id}" was not approved (status={st or "unknown"}).',
                403,
            )
        return wait_row

    def wait_for_sensor(
        self,
        sensor_id: str,
        *,
        ask_id: str | None = None,
        reason: str | None = None,
        expires_at: str | None = None,
    ) -> dict[str, Any]:
        """Park at zero compute until a Caveman Sensor (`listener_event`) matches and wakes this workflow."""
        return self.wait(
            kind="listener_event",
            target_id=sensor_id,
            ask_id=ask_id or f"sensor:{sensor_id}",
            reason=reason,
            expires_at=expires_at,
        )


class Workflows:
    """Code-first durable workflows backed by code_sessions + two-phase replay ledger."""

    def __init__(
        self,
        *,
        control_url: str,
        api_key: str,
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

    def create(
        self,
        *,
        name: str,
        runtime: str = "python",
        description: str | None = None,
        source_drive: str | None = None,
        source_path: str | None = None,
        entry_code: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"name": name, "runtime": runtime}
        if description is not None:
            payload["description"] = description
        if source_drive is not None:
            payload["source_drive"] = source_drive
        if source_path is not None:
            payload["source_path"] = source_path
        if entry_code is not None:
            payload["entry_code"] = entry_code
        return self._tx.request("POST", "/api/v1/code/workflows", payload)

    def list(self) -> list[dict[str, Any]]:
        res = self._tx.request("GET", "/api/v1/code/workflows")
        items = res.get("workflows")
        return list(items) if isinstance(items, list) else []

    def start_run(
        self,
        workflow: str,
        *,
        input: Any = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        if input is not None:
            payload["input"] = input
        if idempotency_key is not None:
            payload["idempotency_key"] = idempotency_key
        return self._tx.request(
            "POST",
            f"/api/v1/code/workflows/{_quote(workflow)}/runs",
            payload,
            idempotency_key=idempotency_key,
        )

    def get_run(self, run_id: str) -> dict[str, Any]:
        return self._tx.request("GET", f"/api/v1/code/workflows/runs/{_quote(run_id)}")

    def begin_step(
        self,
        run_id: str,
        *,
        step_key: str,
        tool_name: str,
        effect: str = "idempotent",
        kind: str = "code_tool",
        input: Any = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "step_key": step_key,
            "tool_name": tool_name,
            "effect": effect,
            "kind": kind,
        }
        if input is not None:
            payload["input"] = input
        return self._tx.request(
            "POST",
            f"/api/v1/code/workflows/runs/{_quote(run_id)}/steps/begin",
            payload,
        )

    def complete_step(
        self,
        run_id: str,
        *,
        step_key: str,
        state: str = "completed",
        result: Any = None,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"step_key": step_key, "state": state}
        if result is not None:
            payload["result"] = result
        if error_code is not None:
            payload["error_code"] = error_code
        if error_message is not None:
            payload["error_message"] = error_message
        return self._tx.request(
            "POST",
            f"/api/v1/code/workflows/runs/{_quote(run_id)}/steps/complete",
            payload,
        )

    def park_wait(
        self,
        run_id: str,
        *,
        kind: str,
        ask_id: str | None = None,
        target_id: str | None = None,
        barrier_id: str | None = None,
        expires_at: str | None = None,
        reason: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"kind": kind}
        if ask_id is not None:
            payload["ask_id"] = ask_id
        if target_id is not None:
            payload["target_id"] = target_id
        if barrier_id is not None:
            payload["barrier_id"] = barrier_id
        if expires_at is not None:
            payload["expires_at"] = expires_at
        if reason is not None:
            payload["reason"] = reason
        return self._tx.request(
            "POST",
            f"/api/v1/code/workflows/runs/{_quote(run_id)}/wait",
            payload,
        )

    def finish_run(
        self,
        run_id: str,
        *,
        status: str,
        output: Any = None,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"status": status}
        if output is not None:
            payload["output"] = output
        if error_code is not None:
            payload["error_code"] = error_code
        if error_message is not None:
            payload["error_message"] = error_message
        return self._tx.request(
            "POST",
            f"/api/v1/code/workflows/runs/{_quote(run_id)}/finish",
            payload,
        )

    def execute(
        self,
        workflow: str,
        input: Any,
        handler: Callable[[WorkflowContext, Any], _T],
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Start or resume a durable workflow run, execute handler with WorkflowContext, and commit result."""
        run = self.start_run(workflow, input=input, idempotency_key=idempotency_key)
        ctx = WorkflowContext(self, str(run.get("id") or ""), str(run.get("session_id") or ""))
        try:
            output = handler(ctx, input)
            finished = self.finish_run(ctx.run_id, status="completed", output=output)
            return {"run": finished, "output": output}
        except WorkflowParkedError as parked:
            return {"run": {**run, "status": "waiting"}, "parked": parked.wait}
        except Exception as exc:
            try:
                self.finish_run(
                    ctx.run_id,
                    status="failed",
                    error_code="workflow_error",
                    error_message=str(exc),
                )
            except Exception:
                pass
            raise


# ============================= COMPUTER POOLS ==============================


class ComputerPools:
    """Org-wide warm computer pools and N:M session computer leases."""

    def __init__(
        self,
        *,
        control_url: str,
        api_key: str,
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

    def create(
        self,
        *,
        name: str,
        size: str | None = None,
        network: str | None = None,
        min_warm: int | None = None,
        max_size: int | None = None,
        description: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"name": name}
        if size is not None:
            payload["size"] = size
        if network is not None:
            payload["network"] = network
        if min_warm is not None:
            payload["min_warm"] = min_warm
        if max_size is not None:
            payload["max_size"] = max_size
        if description is not None:
            payload["description"] = description
        return self._tx.request("POST", "/api/v1/code/computer-pools", payload)

    def list(self) -> list[dict[str, Any]]:
        res = self._tx.request("GET", "/api/v1/code/computer-pools")
        items = res.get("pools")
        return list(items) if isinstance(items, list) else []

    def lease_for_session(
        self,
        session_id: str,
        *,
        pool: str | None = None,
        computer_id: str | None = None,
        role: str = "worker",
        label: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"role": role}
        if pool is not None:
            payload["pool"] = pool
        if computer_id is not None:
            payload["computer_id"] = computer_id
        if label is not None:
            payload["label"] = label
        return self._tx.request(
            "POST",
            f"/api/v1/code/sessions/{_quote(session_id)}/computers",
            payload,
        )

    def list_for_session(self, session_id: str) -> _List[dict[str, Any]]:
        res = self._tx.request(
            "GET",
            f"/api/v1/code/sessions/{_quote(session_id)}/computers",
        )
        items = res.get("computers")
        return list(items) if isinstance(items, list) else []

    def release_for_session(self, session_id: str, computer_id: str) -> dict[str, Any]:
        return self._tx.request(
            "DELETE",
            f"/api/v1/code/sessions/{_quote(session_id)}/computers/{_quote(computer_id)}",
        )

    def list_unified(self, scope: str = "all") -> _List[dict[str, Any]]:
        res = self._tx.request(
            "GET",
            f"/api/v1/code/computers/unified?scope={_quote(scope)}",
        )
        items = res.get("computers")
        return list(items) if isinstance(items, list) else []
