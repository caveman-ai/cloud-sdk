"""Sandboxes: computers made and used from outside them, the API's /code/computers, for an organization's
code:run key (a sandbox is a computer as the console shows it).

The plain calls (list, create, get, sleep, resume, delete, and a sandbox's snapshots: snapshot, list_snapshots,
get_snapshot, delete_snapshot, restore, fork) and the wire types are generated from the contract
(sandboxes_generated.py, scripts/generate-cloud-sdk.mjs). This module is what a generator does not do well: the
transport with its retries and typed errors, a command's stream into a sandbox (a WebSocket on the relay,
subprotocol caveman.computer.v1, spoken here with the standard library alone), waiting for a state (the API holds a
read until the state, GET's wait_for; a Caveman Cloud that does not is polled), and waiting for a snapshot to be
taken or restored (polled).

A port at its own URL (``url()``, where the installation serves https://<port>-<sandbox>.<domain>) is a token and a
link from the API; a port's dial (``dial_port``) is a stream at the relay that needs no URL.

The key decides everything: the organization and the service account come from it, never from a request, and a
key sees only the sandboxes its service account made.
"""

from __future__ import annotations

import base64
import hashlib
import http.client
import json
import os
import socket
import ssl
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable, Iterator, Sequence
from dataclasses import dataclass
from typing import Any, BinaryIO, Literal, NotRequired, TextIO, TypedDict, cast, overload

from .cloud import CloudError
from .sandboxes_generated import SANDBOX_ERROR_PREFIXES, SANDBOX_REASONS, SANDBOX_ROUTES, SANDBOX_STREAM, CodeComputer, CodeComputerSnapshot, SandboxesAPI, SandboxRoute

_LIMIT = 16 * 1024 * 1024
_LOOPBACK = ("localhost", "127.0.0.1", "::1")
# How long the API holds one waiting read at most (GET /code/computers/{id}'s timeout), in seconds, and the header it says
# how the wait ended in; a Caveman Cloud that does not wait sends none.
_MAX_WAIT_SECONDS = 60
_WAIT_HEADER = "cave-wait"
# The longest this client waits before asking again: a Retry-After past it (an organization's start ceiling names up to a
# day) is the caller's to wait out, not a retry's.
_MAX_RETRY_WAIT_SECONDS = 30


class SandboxError(CloudError):
    """A refusal from the API: its error code (one the contract documents, or a later one), message and HTTP status,
    and ``retry_after``, the seconds it asked to wait before asking again (its Retry-After), None when it named none."""

    def __init__(self, code: str, message: str, status: int = 0, request_id: str | None = None, retry_after: int | None = None) -> None:
        super().__init__(code, message, status)
        self.request_id = request_id
        self.retry_after = retry_after

    @property
    def limit_reached(self) -> bool:
        """A limit reached on making or waking a sandbox (the plan's or the installation's)."""
        return any(self.code.startswith(prefix) for prefix in SANDBOX_ERROR_PREFIXES)


class SandboxExecError(CloudError):
    """A command's stream that ended without the command's exit code.

    Refused before it opened (``status`` is the HTTP status), or ended by the sandbox or the relay (``code`` is one of
    ``SANDBOX_STREAM["errors"]``; ``close_code`` the WebSocket close code when the stream closed without saying why;
    ``retry_after`` the seconds the far end asked to wait before opening the stream again, as a Retry-After or an
    error's retry_after says).
    """

    def __init__(self, code: str, message: str, status: int = 0, close_code: int | None = None, retry_after: float | None = None) -> None:
        super().__init__(code, message, status)
        self.close_code = close_code
        self.retry_after = retry_after


class SandboxFileError(SandboxExecError):
    """A file operation's or a port's stream that ended without its answer: what the sandbox's file system refused
    (cave_code_computer_file_not_found, _file_permission, _file_exists, _file_too_large, _file_refused, with the
    system's own words), nothing listening on the port (cave_code_computer_port_refused), or any of a stream's codes."""


class SandboxFileInfo(TypedDict):
    """A file in a sandbox, as a file operation describes it: mode is its permission bits, mtime UTC (RFC 3339)."""

    name: str
    type: Literal["file", "dir", "symlink", "other"]
    size: int
    mode: int
    mtime: str
    link: NotRequired[str]  # where a symbolic link points


class SandboxStateError(CloudError):
    """A wait that cannot end in the state it waits for: the sandbox failed, its reason needs the caller (its
    observed_reason_code is one whose wait ends: ended, out_of_memory, disk_lost, ...), or it is asked to be something
    else."""

    def __init__(self, sandbox: CodeComputer, want: str) -> None:
        reason = sandbox.get("observed_reason") or ""
        said = f": {reason}" if reason else "."
        if sandbox["observed_state"] == "failed":
            message = f"Sandbox {sandbox['id']} failed{said}"
        elif _wait_ends(sandbox):
            message = f"Sandbox {sandbox['id']} is {sandbox['observed_state']}{said}"
        else:
            message = f"Sandbox {sandbox['id']} is asked to be {sandbox['desired_state']}, so it will not be {want}."
        super().__init__("cave_sandbox_state", message)
        self.sandbox, self.want = sandbox, want


class SnapshotStateError(CloudError):
    """A wait for a snapshot that cannot end as it waits: waiting for it to be ready, it failed (its reason_code says
    why), or it is deleted or being deleted; waiting for its restore, the restore failed (its restore's reason_code says
    why), or none was asked. ``snapshot`` is the snapshot as last read, ``want`` ready or restored."""

    def __init__(self, snapshot: CodeComputerSnapshot, want: str) -> None:
        if want == "restored":
            restore = snapshot["restore"]
            reason = restore.get("reason") or ""
            said = f": {reason}" if reason else "."
            if restore["state"] == "none":
                message = f"Snapshot {snapshot['id']} was never asked to be restored."
            else:
                message = f"The restore of snapshot {snapshot['id']} {restore['state']}{said}"
        else:
            reason = snapshot.get("reason") or ""
            said = f": {reason}" if reason else "."
            if snapshot["state"] == "failed":
                message = f"Snapshot {snapshot['id']} failed{said}"
            else:
                message = f"Snapshot {snapshot['id']} is {snapshot['state']}{said}"
        super().__init__("cave_snapshot_state", message)
        self.snapshot, self.want = snapshot, want


def _wait_ends(sandbox: CodeComputer) -> bool:
    """Whether a wait ends on what a sandbox reads now, it not being in the state waited for: by its reason's code
    (SANDBOX_REASONS), one that passes by itself never (not even while it reads failed), one that needs the caller
    always; with no code, or one this client does not know, once it has failed."""
    wait = SANDBOX_REASONS.get(sandbox.get("observed_reason_code") or "", "ends_if_failed")
    return wait == "ends" or (wait == "ends_if_failed" and sandbox["observed_state"] == "failed")


@dataclass(frozen=True)
class SandboxRefusal:
    """A sandbox's answer to a resize or a signal it did not act on: ``of`` is resize or signal, ``code`` the API's."""

    of: str
    code: str
    message: str


class SandboxCommand:
    """Speaks to a running command (exec's ``control``): resizes its terminal and sends its process group a signal.

    What is asked before the command's stream opens is sent once it does; what the sandbox does not act on comes back
    to exec's ``on_refused``. One command at a time.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._send: Callable[[dict[str, Any]], None] | None = None
        self._pending: list[dict[str, Any]] = []

    def resize(self, cols: int, rows: int) -> None:
        """The terminal's new size, each 1 to ``SANDBOX_STREAM["options"]["max_term_size"]``."""
        _check_size(cols, rows)
        self._post({"type": SANDBOX_STREAM["types"]["resize"], "cols": cols, "rows": rows})

    def send_signal(self, name: str = "TERM") -> None:
        """Sends the command's process group a signal by name (TERM or SIGTERM): one of ``SANDBOX_STREAM["options"]["signals"]``."""
        bare = name[3:] if isinstance(name, str) and name.startswith("SIG") else name
        if bare not in SANDBOX_STREAM["options"]["signals"]:
            raise SandboxExecError("cave_bad_request", f"A command may be sent {', '.join(SANDBOX_STREAM['options']['signals'])}, not {name}.")
        self._post({"type": SANDBOX_STREAM["types"]["signal"], "signal": bare})

    def _post(self, message: dict[str, Any]) -> None:
        with self._lock:
            if self._send is None:
                self._pending.append(message)
                return
            send = self._send
        send(message)

    def _bind(self, send: Callable[[dict[str, Any]], None] | None) -> None:
        with self._lock:
            self._send = send
            pending, self._pending = (self._pending, []) if send is not None else ([], self._pending)
        for message in pending:
            send(message)  # type: ignore[misc]


@dataclass(frozen=True)
class ExecResult:
    """A command run to its end, with its output kept."""

    exit_code: int
    stdout: bytes
    stderr: bytes


@dataclass(frozen=True)
class SandboxPortURL:
    """A sandbox's port at its own URL, as ``url()`` answers it. Times are RFC 3339, as the API says them.

    A program sends ``headers`` (``{"Caveman-Port-Token": token}``; the relay takes it off) with each request to
    ``url``, until ``expires_at``. A person opens ``link`` in a browser before ``link_expires_at`` (a few minutes; it is a
    credential while it lasts), and the browser then holds a cookie for that host alone until ``expires_at``.
    ``visibility`` is the port's now: private (a token opens it) or public (anyone with the address)."""

    url: str
    link: str
    link_expires_at: str
    token: str
    headers: dict[str, str]
    expires_at: str
    visibility: str


# Where a command's output goes: a function given each piece, a binary file, or nowhere.
Output = Callable[[bytes], object] | BinaryIO | None
# What a command reads: bytes, text (sent as UTF-8), a file (binary or text) read to its end, or pieces of bytes.
Input = bytes | str | BinaryIO | TextIO | Iterable[bytes] | None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        raise SandboxError("cave_redirect_denied", "Cloud redirects are not followed.", code)


def _origin(raw: str, what: str) -> str:
    url = urllib.parse.urlsplit(raw)
    if (url.username or url.password or url.query or url.fragment or not url.hostname or url.path.strip("/")
            or (url.scheme != "https" and not (url.scheme == "http" and url.hostname in _LOOPBACK))):
        raise CloudError("cave_endpoint_invalid", f"{what}: use an HTTPS origin, or HTTP on this machine, with no path, credentials, query or fragment.")
    return f"{url.scheme}://{url.netloc}"


class Sandboxes(SandboxesAPI):
    """Makes, runs commands in, and puts away sandboxes."""

    def __init__(self, *, control_url: str, api_key: str, relay_url: str | None = None, timeout_seconds: float = 30,
                 retries: int = 3, retry_delay_seconds: float = 0.25) -> None:
        self.endpoint = _origin(control_url, "control_url") + "/api/v1"
        self.relay = _origin(relay_url, "relay_url") if relay_url else _origin(control_url, "control_url")
        if not api_key.strip():
            raise CloudError("cave_auth_required", "A code:run key is required.")
        if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float)) or not 0.1 <= timeout_seconds <= 600:
            raise CloudError("cave_timeout_invalid", "timeout_seconds must be 0.1–600.")
        self.api_key, self.timeout_seconds = api_key, timeout_seconds
        self.retries, self.retry_delay_seconds = max(0, retries), max(0.0, retry_delay_seconds)
        self._opener = urllib.request.build_opener(_NoRedirect())
        self._sleep: Callable[[float], None] = time.sleep

    def _send(self, route: SandboxRoute, path: str, query: dict[str, Any] | None, body: Any) -> Any:
        """One call, made again while the API says it may be.

        A GET (safe) after a dropped connection or a 502, 503 or 504; any call refused with 429 (the server did
        nothing); a call refused with one of the route's retry_on codes (a delete's cave_code_computer_busy). A
        Retry-After is waited for, up to 30 seconds; one longer is raised at once, its seconds on the error
        (``retry_after``), for the caller to decide. Nothing else is repeated: a create whose answer was lost is not
        made twice.
        """
        return self._request(route, path, query, body)[0]

    def _request(self, route: SandboxRoute, path: str, query: dict[str, Any] | None, body: Any,
                 timeout_seconds: float | None = None) -> tuple[Any, Any]:
        """_send, answering the response's headers too; timeout_seconds bounds this call in place of the client's."""
        pairs = [(k, str(v).lower() if isinstance(v, bool) else str(v)) for k, v in (query or {}).items() if v is not None]
        url = self.endpoint + path + ("?" + urllib.parse.urlencode(pairs) if pairs else "")
        data = None if body is None else json.dumps(body).encode()
        attempt = 0
        while True:
            status, wait = 0, self.retry_delay_seconds * 2 ** min(attempt, 4)
            after: int | None = None  # the answer's Retry-After, in seconds
            headers = {"authorization": "Bearer " + self.api_key, "accept": "application/json"}
            if data is not None:
                headers["content-type"] = "application/json"
            request = urllib.request.Request(url, data=data, headers=headers, method=route.method)
            failure: SandboxError
            try:
                try:
                    response = self._opener.open(request, timeout=timeout_seconds or self.timeout_seconds)
                except urllib.error.HTTPError as refused:
                    response = refused
                with response:
                    status = response.status
                    raw = response.read(_LIMIT + 1)
                    headers = response.headers
                    retry_after = headers.get("retry-after")
                    header_request_id = headers.get("x-cave-request-id")
            except SandboxError:
                raise
            except (OSError, http.client.HTTPException):
                status = 0  # no answer was read whole: as a dropped connection
                failure = SandboxError("cave_network_error", "Could not reach Caveman Cloud.")
            else:
                if len(raw) > _LIMIT:
                    raise SandboxError("cave_response_too_large", "The response is larger than this SDK reads.", status)
                try:
                    parsed = json.loads(raw) if raw else None
                except (ValueError, UnicodeError):
                    parsed = None
                if 200 <= status < 300:
                    if parsed is None and status != 204:
                        raise SandboxError("cave_response_invalid", "The response is not JSON.", status)
                    return parsed, headers
                envelope = parsed.get("error") if isinstance(parsed, dict) else None
                if not isinstance(envelope, dict):
                    envelope = {}
                message = str(envelope.get("message", f"Request failed ({status})."))
                if status == 405:
                    message += " This Caveman Cloud does not offer sandboxes through its API (computers.api.enabled is off)."
                if retry_after is not None and retry_after.isascii() and retry_after.isdigit():
                    after = int(retry_after)
                failure = SandboxError(str(envelope.get("code", "cave_request_failed")), message, status,
                                       cast(str | None, envelope.get("request_id")) or header_request_id, after)
                if after is not None:
                    wait = float(after)
            if status == 0:
                again = route.safe
            elif status == 429:
                again = True
            elif status in (502, 503, 504):
                again = route.safe
            else:
                again = failure.code in route.retry_on
            if not again or attempt >= self.retries or (after is not None and after > _MAX_RETRY_WAIT_SECONDS):
                raise failure
            self._sleep(wait)
            attempt += 1

    @overload
    def wait(self, sandbox_id: str, state: Literal["pending", "starting", "running", "stopping", "stopped", "suspended", "failed"] = "running", *,
             timeout_seconds: float = 600, interval_seconds: float = 1.0) -> CodeComputer: ...

    @overload
    def wait(self, sandbox_id: str, state: Literal["deleted"], *, timeout_seconds: float = 600, interval_seconds: float = 1.0) -> None: ...

    def wait(self, sandbox_id: str, state: str = "running", *, timeout_seconds: float = 600, interval_seconds: float = 1.0) -> CodeComputer | None:
        """Reads a sandbox until it is in ``state`` (an observed_state: running, suspended, stopped) and answers it then.

        A sandbox that failed, whose reason needs the caller, or that is asked to be something else (put to sleep while
        waited on to run, for one), ends the wait with SandboxStateError. A reason that passes by itself (its
        observed_reason_code: waiting_for_capacity, host_unavailable, ...; SANDBOX_REASONS) does not, even while the
        sandbox reads failed. Waiting for ``deleted`` ends when the sandbox is gone (not found), answering None.

        The API holds each read until the state, up to a minute (GET's wait_for: one request, however long, to its rate
        limits), and says how the wait ended (Cave-Wait): unreachable ends it, by the same reason codes. A Caveman Cloud
        whose answer says nothing of the wait (no Cave-Wait) does not hold it: the client then reads again,
        ``interval_seconds`` apart at most, and judges by SANDBOX_REASONS itself. At the API's cap on one caller's waits
        at once, one read is a plain one.
        """
        deadline = time.monotonic() + timeout_seconds
        interval = max(0.01, interval_seconds / 2)
        waits = True  # until an answer says the API does not
        path = f"/code/computers/{urllib.parse.quote(sandbox_id, safe='')}"
        while True:
            outcome: str | None = None
            asked = time.monotonic()
            seconds = min(_MAX_WAIT_SECONDS, int(deadline - asked))
            try:
                if waits and seconds >= 1:
                    try:
                        found, headers = self._request(SANDBOX_ROUTES["get"], path, {"wait_for": state, "timeout": seconds}, None,
                                                       timeout_seconds=max(self.timeout_seconds, seconds + 15))
                        sandbox = cast(CodeComputer, found)
                        outcome = headers.get(_WAIT_HEADER)
                        waits = outcome is not None
                    except SandboxError as refused:
                        if refused.code != "cave_code_computer_waits_limit":
                            raise
                        sandbox = self.get(sandbox_id)
                else:
                    sandbox = self.get(sandbox_id)
            except SandboxError as error:
                if state == "deleted" and error.status == 404:
                    return None
                raise
            if sandbox["observed_state"] == state:
                return sandbox
            desired = sandbox["desired_state"]
            heading = {"running": desired == "running", "suspended": desired in ("suspended", "stopped"),
                       "stopped": desired in ("suspended", "stopped"), "deleted": desired == "deleted"}.get(state, True)
            if outcome == "unreachable" or (outcome is None and _wait_ends(sandbox)) or not heading:
                raise SandboxStateError(sandbox, state)
            if time.monotonic() >= deadline:
                raise SandboxError("cave_timeout", f"Sandbox {sandbox_id} is {sandbox['observed_state']}, not yet {state}.")
            if outcome is not None and time.monotonic() - asked >= 1:
                continue  # the API held the read: ask again at once (an early answer of timeout is waited for as a poll)
            interval = min(interval * 2, interval_seconds)
            self._sleep(max(0.0, min(interval, deadline - time.monotonic())))

    def wait_for_snapshot(self, sandbox_id: str, snapshot_id: str, *, timeout_seconds: float = 600,
                          interval_seconds: float = 1.0) -> CodeComputerSnapshot:
        """Reads a sandbox's snapshot until it is ready (taken, so it can be restored and forked) and answers it then.

        A snapshot that failed (its reason_code: computer_not_placed, snapshots_unsupported, internal_error, ...), or
        that is deleted or being deleted, never will be: SnapshotStateError. The API does not hold a snapshot's read, so
        this polls, from a quarter of a second (or ``interval_seconds`` when shorter) doubling to ``interval_seconds``;
        past ``timeout_seconds``, SandboxError cave_timeout.
        """
        return self._wait_snapshot(sandbox_id, snapshot_id, "ready", timeout_seconds, interval_seconds)

    def wait_for_restore(self, sandbox_id: str, snapshot_id: str, *, timeout_seconds: float = 600,
                         interval_seconds: float = 1.0) -> CodeComputerSnapshot:
        """Reads a sandbox's snapshot until its restore (restore, into the sandbox it was taken of) is done, and
        answers it then: the sandbox runs on the snapshot's disk. A restore that failed (its restore's reason_code:
        snapshot_elsewhere, snapshot_gone, computer_not_placed, ...), or a snapshot no restore was asked of, raises
        SnapshotStateError. Polled as wait_for_snapshot is."""
        return self._wait_snapshot(sandbox_id, snapshot_id, "restored", timeout_seconds, interval_seconds)

    def _wait_snapshot(self, sandbox_id: str, snapshot_id: str, want: str, timeout_seconds: float,
                       interval_seconds: float) -> CodeComputerSnapshot:
        """wait_for_snapshot (want ready) and wait_for_restore (want restored)."""
        deadline = time.monotonic() + timeout_seconds
        interval = max(0.01, min(0.25, interval_seconds))
        while True:
            snapshot = self.get_snapshot(sandbox_id, snapshot_id)
            state: str
            if want == "restored":
                state = snapshot["restore"]["state"]
                done, ends = state == "restored", state in ("failed", "none")
            else:
                state = snapshot["state"]
                done, ends = state == "ready", state in ("failed", "deleting", "deleted")
            if done:
                return snapshot
            if ends:
                raise SnapshotStateError(snapshot, want)
            if time.monotonic() >= deadline:
                raise SandboxError("cave_timeout", f"Snapshot {snapshot_id} is {state}, not yet {want}.")
            self._sleep(max(0.0, min(interval, deadline - time.monotonic())))
            interval = min(interval * 2, interval_seconds)

    def run(self, sandbox_id: str, argv: Sequence[str], *, stdin: Input = None, timeout_seconds: float | None = None,
            env: dict[str, str] | None = None, cwd: str | None = None, user: str | None = None) -> ExecResult:
        """Runs ``argv`` in a sandbox and keeps its output."""
        out: list[bytes] = []
        err: list[bytes] = []
        code = self.exec(sandbox_id, argv, stdin=stdin, stdout=out.append, stderr=err.append, timeout_seconds=timeout_seconds,
                         env=env, cwd=cwd, user=user)
        return ExecResult(code, b"".join(out), b"".join(err))

    def exec(self, sandbox_id: str, argv: Sequence[str], *, stdin: Input = None, stdout: Output = None, stderr: Output = None,
             tty: bool = False, timeout_seconds: float | None = None, env: dict[str, str] | None = None, cwd: str | None = None,
             user: str | None = None, cols: int | None = None, rows: int | None = None, control: SandboxCommand | None = None,
             on_refused: Callable[[SandboxRefusal], object] | None = None) -> int:
        """Runs ``argv`` in a running sandbox, streaming its output, and answers the command's exit code.

        ``tty`` runs it on a terminal (its stderr comes on stdout), ``cols`` and ``rows`` its size. ``env`` (beside the
        sandbox's), ``cwd`` (absolute) and ``user`` are the command's; a sandbox that takes no options refuses a start
        asking for one (cave_code_computer_unsupported). ``control`` resizes the terminal and sends the command a
        signal while it runs; one the sandbox does not act on comes to ``on_refused``, and the command goes on.
        Leaving early (an exception, Ctrl-C, or ``timeout_seconds`` passing) closes the stream, and the sandbox ends
        the command.

        A stream the sandbox says to open again (``SANDBOX_STREAM["retry"]``: its host restarting, before the command
        started) is opened again after the wait it asks, at most ``tries`` times within ``within_ms``, while nothing of
        the command came back and its stdin can be sent again (none, text or bytes; a file or an iterable is read
        once): never a second run of a command.
        """
        argv = list(argv)
        _check_argv(argv)
        start: dict[str, Any] = {"type": SANDBOX_STREAM["types"]["start"], "argv": argv}
        if tty:
            start["tty"] = True
        start.update(_options(env, cwd, user, cols, rows, tty))
        retry = SANDBOX_STREAM["retry"]
        again = stdin is None or isinstance(stdin, (str, bytes, bytearray))
        first = time.monotonic()
        attempt = 1
        while True:
            heard = [False]
            try:
                return self._exec_once(sandbox_id, start, stdin, stdout, stderr, timeout_seconds, heard, control, on_refused)
            except SandboxExecError as error:
                if error.code not in retry["codes"] or not again or heard[0] or attempt >= retry["tries"]:
                    raise
                wait = max(0.0, error.retry_after if error.retry_after is not None else float(retry["after_seconds"]))
                if (time.monotonic() - first + wait) * 1000 > retry["within_ms"]:
                    raise
                self._sleep(wait)
                attempt += 1

    def _exec_once(self, sandbox_id: str, start: dict[str, Any], stdin: Input, stdout: Output, stderr: Output,
                   timeout_seconds: float | None, heard: list[bool], control: SandboxCommand | None,
                   on_refused: Callable[[SandboxRefusal], object] | None) -> int:
        """One stream of exec: ``heard[0]`` says whether any of the command's output came."""
        stream = self._open(self._stream_path(SANDBOX_STREAM["path"], sandbox_id))
        timer = None
        if timeout_seconds is not None:
            timer = threading.Timer(timeout_seconds, stream.abort)
            timer.daemon = True
            timer.start()
        try:
            stream.send(_TEXT, json.dumps(start).encode())
            if control is not None:
                # Controls go after the start, each a message of its own; once the stream is gone, nothing.
                def send(message: dict[str, Any]) -> None:
                    try:
                        stream.send(_TEXT, json.dumps(message).encode())
                    except OSError:
                        pass  # the stream is gone: its read says why
                control._bind(send)
            threading.Thread(target=stream.pump, args=(stdin,), daemon=True).start()
            limit = 1 + SANDBOX_STREAM["limits"]["max_output"] + SANDBOX_STREAM["limits"]["max_control"]
            while True:
                try:
                    op, data = stream.read(limit)
                except _Closed as closed:
                    # The close's reason is the API's code when the far end gave one; else its close code's.
                    code = closed.reason if closed.reason.startswith("cave_") else SANDBOX_STREAM["close_codes"].get(str(closed.code), "cave_code_computer_stream_ended")
                    raise SandboxExecError(code, SANDBOX_STREAM["errors"].get(code) or closed.reason or "The stream ended.", close_code=closed.code) from None
                except OSError:
                    if stream.aborted:
                        raise SandboxExecError("cave_timeout", "The command ran past timeout_seconds; the stream was closed.") from None
                    raise SandboxExecError("cave_code_computer_stream_ended", SANDBOX_STREAM["errors"]["cave_code_computer_stream_ended"]) from None
                if op == _BINARY:
                    if not data:
                        raise SandboxExecError("cave_bad_request", "The sandbox sent output with no channel.")
                    heard[0] = True
                    target = stderr if data[0] == SANDBOX_STREAM["channels"]["stderr"] else stdout
                    if target is not None and len(data) > 1:
                        _write(target, data[1:])
                    continue
                try:
                    message = json.loads(data)
                except (ValueError, UnicodeError):
                    raise SandboxExecError("cave_bad_request", "The sandbox sent a message this client cannot read.") from None
                kind = message.get("type") if isinstance(message, dict) else None
                if kind == SANDBOX_STREAM["types"]["exit"]:
                    if not isinstance(message.get("code"), int):
                        raise SandboxExecError("cave_bad_request", "The sandbox sent an exit with no code.")
                    stream.close(1000)
                    return int(message["code"])
                if kind == SANDBOX_STREAM["types"]["error"]:
                    after = message.get("retry_after")
                    raise SandboxExecError(str(message.get("code", "cave_internal")), str(message.get("message", "The command failed.")),
                                           retry_after=float(after) if isinstance(after, (int, float)) and not isinstance(after, bool) else None)
                if kind == SANDBOX_STREAM["types"]["refused"]:
                    if on_refused is not None:
                        on_refused(SandboxRefusal(str(message.get("of", "")), str(message.get("code", "")), str(message.get("message", ""))))
                    continue
                # A message type this client does not know is a later version's: it is read past.
        finally:
            if control is not None:
                control._bind(None)
            if timer is not None:
                timer.cancel()
            stream.shutdown()

    def read_file(self, sandbox_id: str, path: str, *, root: bool = False, timeout_seconds: float | None = None) -> bytes:
        """Reads a file of a sandbox whole (as its tool-process user, or ``root``: a full sandbox's root)."""
        parts: list[bytes] = []
        self._files(sandbox_id, {"op": "read", "path": path}, root, timeout_seconds, sink=parts.append, again=parts.clear)
        return b"".join(parts)

    def stream_file(self, sandbox_id: str, path: str, sink: Callable[[bytes], object] | BinaryIO, *, root: bool = False,
                    timeout_seconds: float | None = None) -> SandboxFileInfo:
        """Reads a file of a sandbox to ``sink`` (a function given each piece, or a binary file) and describes it."""
        return cast(SandboxFileInfo, self._files(sandbox_id, {"op": "read", "path": path}, root, timeout_seconds, sink=sink)[0])

    def write_file(self, sandbox_id: str, path: str, data: Input, *, root: bool = False, mode: int | None = None,
                   atomic: bool = False, timeout_seconds: float | None = None) -> SandboxFileInfo:
        """Makes or replaces a file of a sandbox with ``data`` (its folder must be there) and describes it once written.

        ``data`` is what exec's stdin may be. ``mode`` is a new file's permission bits (0o644 when absent); ``atomic``
        writes beside the path and renames over it, so a reader finds the old file or the new one. A file or an
        iterable is read once: a stream the sandbox asks to open again is opened again only for text or bytes.
        """
        first: dict[str, Any] = {"op": "write", "path": path}
        if mode:
            first["mode"] = mode
        if atomic:
            first["atomic"] = True
        return cast(SandboxFileInfo, self._files(sandbox_id, first, root, timeout_seconds, data=data)[0])

    def list_files(self, sandbox_id: str, path: str, *, root: bool = False, timeout_seconds: float | None = None) -> list[SandboxFileInfo]:
        """Lists a folder of a sandbox, in no order."""
        return self._files(sandbox_id, {"op": "list", "path": path}, root, timeout_seconds)[1]

    def stat_file(self, sandbox_id: str, path: str, *, root: bool = False, timeout_seconds: float | None = None) -> SandboxFileInfo:
        """Describes a file of a sandbox, a symbolic link as itself."""
        return cast(SandboxFileInfo, self._files(sandbox_id, {"op": "stat", "path": path}, root, timeout_seconds)[0])

    def make_dir(self, sandbox_id: str, path: str, *, parents: bool = False, root: bool = False, timeout_seconds: float | None = None) -> None:
        """Makes a folder of a sandbox; with ``parents``, the folders above it that are not there (one there is no error)."""
        self._files(sandbox_id, {"op": "mkdir", "path": path, **({"parents": True} if parents else {})}, root, timeout_seconds)

    def remove_file(self, sandbox_id: str, path: str, *, all: bool = False, root: bool = False, timeout_seconds: float | None = None) -> None:  # noqa: A002 - the wire's name
        """Removes a file or empty folder of a sandbox; with ``all``, a folder and all it holds."""
        self._files(sandbox_id, {"op": "remove", "path": path, **({"all": True} if all else {})}, root, timeout_seconds)

    def rename_file(self, sandbox_id: str, path: str, to: str, *, root: bool = False, timeout_seconds: float | None = None) -> None:
        """Renames a file or folder of a sandbox, replacing a file at ``to`` as rename(2) does."""
        self._files(sandbox_id, {"op": "rename", "path": path, "to": to}, root, timeout_seconds)

    def _files(self, sandbox_id: str, first: dict[str, Any], root: bool, timeout_seconds: float | None, *,
               sink: Callable[[bytes], object] | BinaryIO | None = None, data: Input = None,
               again: Callable[[], object] | None = None) -> tuple[SandboxFileInfo | None, list[SandboxFileInfo]]:
        """One file operation on its own stream (SANDBOX_STREAM["files"]): the first message, ``data`` then close_stdin
        (a write's), and the answer: bytes to ``sink``, a file, entries, or done. A stream the sandbox says to open
        again is, as exec's is, while nothing came back and ``data`` can be sent again."""
        _check_path(first["path"])
        if "to" in first:
            _check_path(first["to"])
        message = {"type": SANDBOX_STREAM["types"]["files"], **first, **({"root": True} if root else {})}
        retry = SANDBOX_STREAM["retry"]
        replayable = data is None or isinstance(data, (str, bytes, bytearray))
        began = time.monotonic()
        attempt = 1
        while True:
            heard = [False]
            try:
                return self._files_once(sandbox_id, message, timeout_seconds, sink, data, heard)
            except SandboxExecError as error:
                if error.code not in retry["codes"] or not replayable or heard[0] or attempt >= retry["tries"]:
                    raise
                wait = max(0.0, error.retry_after if error.retry_after is not None else float(retry["after_seconds"]))
                if (time.monotonic() - began + wait) * 1000 > retry["within_ms"]:
                    raise
                if again is not None:
                    again()
                self._sleep(wait)
                attempt += 1

    def _files_once(self, sandbox_id: str, first: dict[str, Any], timeout_seconds: float | None,
                    sink: Callable[[bytes], object] | BinaryIO | None, data: Input,
                    heard: list[bool]) -> tuple[SandboxFileInfo | None, list[SandboxFileInfo]]:
        stream = self._open(self._stream_path(SANDBOX_STREAM["files"]["path"], sandbox_id))
        timer = None
        if timeout_seconds is not None:
            timer = threading.Timer(timeout_seconds, stream.abort)
            timer.daemon = True
            timer.start()
        entries: list[SandboxFileInfo] = []
        try:
            stream.send(_TEXT, json.dumps(first).encode())
            if first["op"] == "write":
                threading.Thread(target=stream.pump, args=(data,), daemon=True).start()
            limit = SANDBOX_STREAM["limits"]["max_output"] + SANDBOX_STREAM["limits"]["max_control"]
            while True:
                op, payload = _next(stream, limit, "The file operation ran past timeout_seconds; the stream was closed.")
                if op == _BINARY:
                    heard[0] = True
                    if sink is not None and payload:
                        _write(sink, payload)
                    continue
                control = _control(payload)
                kind = control.get("type")
                if kind in (SANDBOX_STREAM["types"]["file"], SANDBOX_STREAM["types"]["done"]):
                    stream.close(1000)
                    return (cast(SandboxFileInfo, control.get("file")) if kind == SANDBOX_STREAM["types"]["file"] else None), entries
                if kind == SANDBOX_STREAM["types"]["entries"]:
                    heard[0] = True
                    entries.extend(cast(list[SandboxFileInfo], control.get("entries") if isinstance(control.get("entries"), list) else []))
                    continue
                if kind == SANDBOX_STREAM["types"]["error"]:
                    raise _error_of(control)
                # A message type this client does not know is a later version's: it is read past.
        finally:
            if timer is not None:
                timer.cancel()
            stream.shutdown()

    def url(self, sandbox_id: str, port: int, *, ttl_seconds: int | None = None, public: bool | None = None) -> SandboxPortURL:
        """A sandbox's port at its own URL (https://<port>-<sandbox>.<domain>), where the Caveman Cloud serves ports so
        (computers.portUrls; elsewhere the call is refused, 404 or 405): its token and a link (POST
        /code/computers/{computerId}/ports/{port}/token). ``ttl_seconds`` (60 to 86400; an hour when None) is how long the
        token, and the cookie a link leaves, open the port. ``public=True`` first makes the port public (anyone with the
        address reaches it; the sandbox's maker alone may), ``False`` private again; None leaves it as it is. The token
        stops working once the key is revoked or the sandbox deleted."""
        if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
            raise SandboxError("cave_bad_request", "The port is a number from 1 to 65535.")
        if ttl_seconds is not None and (not isinstance(ttl_seconds, int) or isinstance(ttl_seconds, bool) or not 60 <= ttl_seconds <= 86400):
            raise SandboxError("cave_bad_request", "ttl_seconds is from 60 to 86400.")
        if public is not None:
            self.set_port(sandbox_id, port, {"visibility": "public" if public else "private"})
        token = self.port_token(sandbox_id, port, {} if ttl_seconds is None else {"ttl_seconds": ttl_seconds})
        return SandboxPortURL(url=token["url"], link=token["link"], link_expires_at=token["link_expires_at"], token=token["token"],
                              headers={token["header"]: token["token"]}, expires_at=token["expires_at"], visibility=token["visibility"])

    def dial_port(self, sandbox_id: str, port: int) -> SandboxConnection:
        """Opens a TCP connection to ``port`` on a sandbox's own loopback (SANDBOX_STREAM["dial"]), through the relay."""
        if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
            raise SandboxFileError("cave_bad_request", "The port is a number from 1 to 65535.")
        path = self._stream_path(SANDBOX_STREAM["dial"]["path"], sandbox_id).replace("{port}", str(port))
        return SandboxConnection(self._open(path))

    def _stream_path(self, template: str, sandbox_id: str) -> str:
        return template.replace("{computerId}", urllib.parse.quote(sandbox_id, safe=""))

    def _open(self, path: str) -> _Stream:
        """Upgrades GET <relay><path> (a stream's path: exec, files, dial) to a WebSocket on the stream's subprotocol,
        the key as the bearer.

        A refusal before the upgrade is a SandboxExecError with the HTTP status: the sandbox service's own code when it
        said one, else the status's.
        """
        url = urllib.parse.urlsplit(self.relay)
        host, secure = url.hostname or "", url.scheme == "https"
        port = url.port or (443 if secure else 80)
        try:
            raw = socket.create_connection((host, port), timeout=30)
            sock: socket.socket = ssl.create_default_context().wrap_socket(raw, server_hostname=host) if secure else raw
        except OSError:
            raise SandboxExecError("cave_network_error", "Could not reach the relay.") from None
        key = base64.b64encode(os.urandom(16)).decode()
        request = (f"GET {path} HTTP/1.1\r\nHost: {url.netloc}\r\nAuthorization: Bearer {self.api_key}\r\nConnection: Upgrade\r\n"
                   f"Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\n"
                   f"Sec-WebSocket-Protocol: {SANDBOX_STREAM['subprotocol']}\r\n\r\n")
        try:
            sock.sendall(request.encode())
            response = http.client.HTTPResponse(sock, method="GET")
            response.begin()
        except (OSError, http.client.HTTPException):
            sock.close()
            raise SandboxExecError("cave_network_error", "The relay did not answer.") from None
        if response.status != 101:
            try:
                body = response.read(SANDBOX_STREAM["limits"]["max_control"])
            except (OSError, http.client.HTTPException):
                body = b""
            sock.close()
            raise _refusal(response.status, body.decode(errors="replace"), response.getheader("retry-after"))
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        if response.getheader("sec-websocket-accept") != accept or response.getheader("sec-websocket-protocol") != SANDBOX_STREAM["subprotocol"]:
            sock.close()
            raise SandboxExecError("cave_bad_request", f"The relay did not open the stream as {SANDBOX_STREAM['subprotocol']}.", response.status)
        sock.settimeout(None)
        return _Stream(sock, response)


def _refusal(status: int, body: str, retry_after: str | None = None) -> SandboxExecError:
    """A refusal before the upgrade: the API's error envelope the relay answers with, else (a proxy's page) a code for the status."""
    after = float(retry_after) if retry_after is not None and retry_after.isdigit() and len(retry_after) <= 4 else None
    try:
        answer = json.loads(body)
    except ValueError:
        answer = None  # not the relay's answer: a proxy's page
    error = answer.get("error") if isinstance(answer, dict) else None
    if isinstance(error, dict) and error.get("code"):
        return SandboxExecError(str(error["code"]), str(error.get("message", "")), status, retry_after=after)
    code = {401: "cave_unauthorized", 403: "cave_forbidden", 404: "cave_not_found", 429: "cave_rate_limit_exceeded"}.get(status, "cave_request_failed")
    message = ("No such sandbox for this key, or this Caveman Cloud does not offer sandbox commands (computers.api.enabled is off)."
               if status == 404 else body.strip() or f"The stream was refused ({status}).")
    return SandboxExecError(code, message, status)


class SandboxConnection:
    """A TCP connection to a port on a sandbox's own loopback, through the relay (Sandboxes.dial_port).

    ``read`` answers what the sandbox sends, a piece at a time, and b"" once its side half-closes or the connection
    ends; iterating the connection reads to that end. A refusal (nothing listening: cave_code_computer_port_refused)
    or a broken stream is raised there as a SandboxFileError. ``write`` sends, ``close_write`` says this side sends no
    more (the sandbox's side may go on sending), and ``close`` (or leaving a ``with`` block) ends the connection.
    """

    def __init__(self, stream: _Stream) -> None:
        self._stream = stream
        self._ended = False

    def read(self) -> bytes:
        while not self._ended:
            try:
                op, payload = _next(self._stream, SANDBOX_STREAM["limits"]["max_output"] + SANDBOX_STREAM["limits"]["max_control"], "")
            except SandboxFileError as error:
                self._ended = True
                if error.close_code == 1000:
                    return b""
                raise
            if op == _BINARY:
                if payload:
                    return payload
                continue
            control = _control(payload)
            if control.get("type") == SANDBOX_STREAM["types"]["close_write"]:
                self._ended = True
            elif control.get("type") == SANDBOX_STREAM["types"]["error"]:
                self._ended = True
                raise _error_of(control)
        return b""

    def __iter__(self) -> Iterator[bytes]:
        while chunk := self.read():
            yield chunk

    def write(self, data: bytes | str) -> None:
        payload = data.encode() if isinstance(data, str) else bytes(data)
        size = SANDBOX_STREAM["limits"]["max_input"]
        try:
            for at in range(0, len(payload), size):
                self._stream.send(_BINARY, payload[at:at + size])
        except OSError:
            raise SandboxFileError("cave_code_computer_stream_ended", SANDBOX_STREAM["errors"]["cave_code_computer_stream_ended"]) from None

    def close_write(self) -> None:
        try:
            self._stream.send(_TEXT, json.dumps({"type": SANDBOX_STREAM["types"]["close_write"]}).encode())
        except OSError:
            raise SandboxFileError("cave_code_computer_stream_ended", SANDBOX_STREAM["errors"]["cave_code_computer_stream_ended"]) from None

    def close(self) -> None:
        self._stream.close(1000)
        self._stream.shutdown()

    def __enter__(self) -> SandboxConnection:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def _next(stream: _Stream, limit: int, timed_out: str) -> tuple[int, bytes]:
    """The next message of a files or dial stream; its close is a SandboxFileError with the API's code its reason gave,
    else its close code's (a normal close is cave_code_computer_stream_ended with close_code 1000)."""
    try:
        return stream.read(limit)
    except _Closed as closed:
        code = closed.reason if closed.reason.startswith("cave_") else SANDBOX_STREAM["close_codes"].get(str(closed.code), "cave_code_computer_stream_ended")
        raise SandboxFileError(code, SANDBOX_STREAM["errors"].get(code) or closed.reason or "The stream ended.", close_code=closed.code) from None
    except SandboxFileError:
        raise
    except SandboxExecError as error:
        raise SandboxFileError(error.code, str(error)) from None
    except OSError:
        if stream.aborted and timed_out:
            raise SandboxFileError("cave_timeout", timed_out) from None
        raise SandboxFileError("cave_code_computer_stream_ended", SANDBOX_STREAM["errors"]["cave_code_computer_stream_ended"]) from None


def _control(payload: bytes) -> dict[str, Any]:
    """A text message of a files or dial stream, read as JSON."""
    try:
        control = json.loads(payload)
    except (ValueError, UnicodeError):
        control = None
    if not isinstance(control, dict):
        raise SandboxFileError("cave_bad_request", "The sandbox sent a message this client cannot read.")
    return control


def _error_of(control: dict[str, Any]) -> SandboxFileError:
    """An error message of a files or dial stream."""
    code = str(control.get("code") or "cave_internal")
    message = control.get("message") if isinstance(control.get("message"), str) and control.get("message") else SANDBOX_STREAM["errors"].get(code, "The operation failed.")
    after = control.get("retry_after")
    return SandboxFileError(code, str(message), retry_after=float(after) if isinstance(after, (int, float)) and not isinstance(after, bool) else None)


def _check_path(path: object) -> None:
    if not isinstance(path, str) or not path.startswith("/") or "\0" in path or len(path.encode()) > SANDBOX_STREAM["files"]["max_path"]:
        raise SandboxFileError("cave_bad_request", f"A sandbox's path is absolute, with no NUL byte, at most {SANDBOX_STREAM['files']['max_path']} bytes.")


def _check_size(cols: object, rows: object) -> None:
    most = SANDBOX_STREAM["options"]["max_term_size"]
    if not all(isinstance(n, int) and not isinstance(n, bool) and 1 <= n <= most for n in (cols, rows)):
        raise SandboxExecError("cave_bad_request", f"A terminal's cols and rows are each from 1 to {most}.")


def _options(env: dict[str, str] | None, cwd: str | None, user: str | None, cols: int | None, rows: int | None, tty: bool) -> dict[str, Any]:
    """A start's options, refused here as the sandbox would refuse them."""
    options: dict[str, Any] = {}
    if env:
        bounds = SANDBOX_STREAM["options"]
        if any(not isinstance(k, str) or not k or "=" in k or "\0" in k or not isinstance(v, str) or "\0" in v for k, v in env.items()):
            raise SandboxExecError("cave_bad_request", "An environment variable's name is not empty and holds no = or NUL, and its value is text with no NUL.")
        if len(env) > bounds["max_env"] or sum(len(k.encode()) + 1 + len(v.encode()) for k, v in env.items()) > bounds["max_env_bytes"]:
            raise SandboxExecError("cave_bad_request", f"A command's environment is at most {bounds['max_env']} variables and {bounds['max_env_bytes']} bytes.")
        options["env"] = dict(env)
    if cwd is not None:
        if not isinstance(cwd, str) or not cwd.startswith("/") or "\0" in cwd:
            raise SandboxExecError("cave_bad_request", "cwd is an absolute path in the sandbox.")
        options["cwd"] = cwd
    if user:
        options["user"] = user
    if cols is not None or rows is not None:
        if not tty:
            raise SandboxExecError("cave_bad_request", "cols and rows are a terminal's: ask for tty.")
        _check_size(cols, rows)
        options["cols"], options["rows"] = cols, rows
    return options


def _check_argv(argv: list[str]) -> None:
    if not argv or not argv[0]:
        raise SandboxExecError("cave_bad_request", "Name a command to run.")
    if any(not isinstance(a, str) or "\0" in a for a in argv):
        raise SandboxExecError("cave_bad_request", "A command's arguments are strings with no NUL byte.")
    limits = SANDBOX_STREAM["limits"]
    if len(argv) > limits["max_args"] or sum(len(a.encode()) for a in argv) > limits["max_argv_bytes"]:
        raise SandboxExecError("cave_bad_request", f"A command is at most {limits['max_args']} arguments and {limits['max_argv_bytes']} bytes.")


def _write(target: Callable[[bytes], object] | BinaryIO, data: bytes) -> None:
    write = getattr(target, "write", None)
    if write is not None:
        write(data)
        flush = getattr(target, "flush", None)
        if flush is not None:
            flush()
    else:
        cast(Callable[[bytes], object], target)(data)


# The WebSocket of a command's stream (RFC 6455, a client's part): frames masked out, unmasked in, no extensions, a
# message whole once its last fragment came, a ping answered, a close returned.
_CONTINUATION, _TEXT, _BINARY, _CLOSE, _PING, _PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


class _Closed(Exception):
    def __init__(self, code: int, reason: str) -> None:
        super().__init__(f"stream closed ({code} {reason})")
        self.code, self.reason = code, reason


class _Stream:
    def __init__(self, sock: socket.socket, response: http.client.HTTPResponse) -> None:
        # The upgrade's response is kept: its buffered reader holds the first frames, and collecting the response
        # would close it.
        self.sock, self.response = sock, response
        self.reader = cast(BinaryIO, response.fp)
        self.lock = threading.Lock()
        self.close_sent = False
        self.aborted = False
        self.ended = False

    def send(self, op: int, payload: bytes) -> None:
        with self.lock:
            if self.close_sent or self.ended:
                raise OSError("the stream is closing")
            if op == _CLOSE:
                self.close_sent = True
            n = len(payload)
            head = bytes([0x80 | op]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n)
                                         if n <= 0xFFFF else bytes([0x80 | 127]) + struct.pack(">Q", n))
            mask = os.urandom(4)
            masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            self.sock.sendall(head + mask + masked)

    def close(self, code: int) -> None:
        try:
            self.send(_CLOSE, struct.pack(">H", code))
        except OSError:
            pass  # the far end went first

    def pump(self, stdin: Input) -> None:
        """Copies stdin to the stream in messages of at most max_input bytes, then says stdin ended.

        Text (a str, a text file such as sys.stdin) is sent as UTF-8. A stdin that fails to read ends the command's
        input there, as one that ended does. Once the stream is gone nothing more is sent.
        """
        size = SANDBOX_STREAM["limits"]["max_input"]

        def send(chunk: bytes | bytearray | str) -> None:
            data = chunk.encode() if isinstance(chunk, str) else bytes(chunk)
            for at in range(0, len(data), size):
                self.send(_BINARY, data[at:at + size])

        try:
            if isinstance(stdin, (str, bytes, bytearray)):
                send(stdin)
            elif stdin is not None and hasattr(stdin, "read"):
                reader = cast(BinaryIO, stdin)
                read = getattr(reader, "read1", None) or reader.read
                while chunk := read(size):
                    send(chunk)
            elif stdin is not None:
                for piece in cast(Iterable[bytes], stdin):
                    send(piece)
        except OSError:
            if self.ended:
                return  # the stream is gone: the read side says why
        except Exception:  # noqa: BLE001 - a stdin that fails to read ends the command's input, whatever it raised
            pass
        try:
            self.send(_TEXT, json.dumps({"type": SANDBOX_STREAM["types"]["close_stdin"]}).encode())
        except OSError:
            pass  # the stream is gone: the read side says why

    def _exactly(self, n: int) -> bytes:
        data = self.reader.read(n)
        if len(data) != n:
            raise OSError("the stream ended")
        return data

    def read(self, limit: int) -> tuple[int, bytes]:
        """The next whole message; a close from the far end raises _Closed, once answered."""
        op, parts, size = 0, [], 0
        while True:
            first, second = self._exactly(2)
            if first & 0x70 or second & 0x80:
                raise SandboxExecError("cave_bad_request", "The stream sent a frame this client cannot read.")
            fin, frame_op, n = first & 0x80, first & 0x0F, second & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._exactly(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._exactly(8))[0]
            if n > limit:
                raise SandboxExecError("cave_bad_request", "The stream sent a message over its bound.")
            payload = self._exactly(n) if n else b""
            if frame_op == _PING:
                try:
                    self.send(_PONG, payload)
                except OSError:
                    pass  # the connection is going: the next read says how, a close sent first among them
                continue
            if frame_op == _PONG:
                continue
            if frame_op == _CLOSE:
                code = struct.unpack(">H", payload[:2])[0] if len(payload) >= 2 else 1005
                self.close(1000)
                raise _Closed(code, payload[2:].decode(errors="replace"))
            if (frame_op == _CONTINUATION) != (op != 0) or frame_op not in (_CONTINUATION, _TEXT, _BINARY):
                raise SandboxExecError("cave_bad_request", "The stream sent a fragment out of order.")
            if frame_op != _CONTINUATION:
                op = frame_op
            size += len(payload)
            if size > limit:
                raise SandboxExecError("cave_bad_request", "The stream sent a message over its bound.")
            parts.append(payload)
            if fin:
                return op, b"".join(parts)

    def abort(self) -> None:
        self.aborted = True
        self.shutdown()

    def shutdown(self) -> None:
        # The stdin thread may outlive the stream (a read that waits on sys.stdin): it sends nothing more, and the
        # socket's descriptor is released here, the response's buffered reader with it.
        self.ended = True
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass  # already closed
        self.response.close()
        self.sock.close()
