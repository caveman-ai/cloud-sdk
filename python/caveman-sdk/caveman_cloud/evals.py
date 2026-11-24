from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import CancelledError, ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import quote, urlsplit

from .core import _OPENER


class EvalControlError(RuntimeError):
    """Structured non-success response from control-plane eval API."""

    def __init__(self, status: int, code: str, message: str) -> None:
        self.status = status
        self.code = code
        super().__init__(message)


def _required(value: str, name: str) -> str:
    if not value or value.strip() != value:
        raise ValueError(f"{name} is required without surrounding whitespace")
    return value


def _service_url(value: str) -> str:
    if value.strip() != value:
        raise ValueError("control_url must not contain surrounding whitespace")
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("control_url must be an absolute http(s) URL without credentials, query, or fragment")
    return value.rstrip("/")


def _positive_integer(value: int | None, fallback: int, name: str, maximum: int) -> int:
    parsed = fallback if value is None else value
    if isinstance(parsed, bool) or not isinstance(parsed, int) or parsed < 1 or parsed > maximum:
        raise ValueError(f"{name} must be an integer from 1 to {maximum}")
    return parsed


def _object(value: Any, message: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(message)
    return value


def _detail(value: Any) -> dict[str, Any]:
    envelope = _object(value, "eval response must be a JSON object")
    run = _object(envelope.get("run"), "eval response omitted run")
    cells = envelope.get("cells")
    if not isinstance(run.get("id"), str) or not isinstance(run.get("status"), str) or not isinstance(cells, list):
        raise ValueError("eval response has invalid run detail")
    return {"run": run, "cells": cells}


def _list(value: Any, message: str) -> list[dict[str, Any]]:
    envelope = _object(value, message)
    items = envelope.get("data")
    if not isinstance(items, list):
        raise ValueError(f"{message} omitted data")
    return items


def _control_request(
    *,
    access_token: str,
    control_url: str,
    project_id: str,
    request_timeout_seconds: int,
    path: str,
    method: str = "GET",
    body: dict[str, Any] | None = None,
) -> Any:
    request = urllib.request.Request(
        f"{control_url}/api/v1/projects/{quote(project_id, safe='')}{path}",
        data=json.dumps(body or {}).encode() if method != "GET" else None,
        headers={
            "authorization": f"Bearer {access_token}",
            **({"content-type": "application/json", "x-cave-csrf": "sdk"} if method != "GET" else {}),
        },
        method=method,
    )
    try:
        with _OPENER.open(request, timeout=request_timeout_seconds) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        try:
            decoded = json.loads(error.read())
        except (json.JSONDecodeError, UnicodeDecodeError):
            decoded = {}
        envelope = decoded.get("error") if isinstance(decoded, dict) else None
        if not isinstance(envelope, dict):
            envelope = {}
        code = envelope.get("code")
        message = envelope.get("message")
        raise EvalControlError(
            error.code,
            code if isinstance(code, str) else "cave_eval_request_failed",
            message if isinstance(message, str) else f"eval request failed ({error.code})",
        ) from error


class EvalProjectClient:
    """Author versioned eval resources, then open workbench run clients."""

    def __init__(
        self,
        *,
        access_token: str,
        control_url: str,
        project_id: str,
        request_timeout_seconds: int = 30,
    ) -> None:
        self.access_token = _required(access_token, "access_token")
        self.control_url = _service_url(control_url)
        self.project_id = _required(project_id, "project_id")
        self.request_timeout_seconds = _positive_integer(request_timeout_seconds, 30, "request_timeout_seconds", 86_400)

    def workbench(self, workbench_id: str) -> EvalWorkbenchClient:
        return EvalWorkbenchClient(
            access_token=self.access_token,
            control_url=self.control_url,
            project_id=self.project_id,
            workbench_id=workbench_id,
            request_timeout_seconds=self.request_timeout_seconds,
        )

    def list_datasets(self) -> list[dict[str, Any]]:
        return _list(self._request("/eval-datasets"), "eval datasets response")

    def create_dataset(self, *, name: str, document: dict[str, Any], description: str = "") -> dict[str, Any]:
        return _object(self._request("/eval-datasets", method="POST", body={"name": _required(name, "dataset.name"), "description": description, "document": document}), "eval dataset response must be a JSON object")

    def list_evaluators(self) -> list[dict[str, Any]]:
        return _list(self._request("/eval-evaluators"), "eval evaluators response")

    def create_evaluator(self, *, name: str, config: dict[str, Any], description: str = "") -> dict[str, Any]:
        return _object(self._request("/eval-evaluators", method="POST", body={"name": _required(name, "evaluator.name"), "description": description, "config": config}), "eval evaluator response must be a JSON object")

    def list_workbenches(self) -> list[dict[str, Any]]:
        return _list(self._request("/eval-workbenches"), "eval workbenches response")

    def create_workbench(self, *, name: str, document: dict[str, Any], description: str = "") -> dict[str, Any]:
        return _object(self._request("/eval-workbenches", method="POST", body={"name": _required(name, "workbench.name"), "description": description, "document": document}), "eval workbench response must be a JSON object")

    def create_experiment(
        self,
        *,
        name: str,
        dataset: dict[str, Any],
        document: dict[str, Any],
        description: str = "",
        dataset_key: str = "cases",
    ) -> dict[str, Any]:
        created_dataset = self.create_dataset(
            name=_required(str(dataset.get("name", "")), "dataset.name"),
            description=str(dataset.get("description", "")),
            document=_object(dataset.get("document"), "dataset.document must be a JSON object"),
        )
        key = _required(dataset_key, "dataset_key")
        workbench_document = {**document, "datasets": [{"key": key, "dataset_id": created_dataset["id"]}], "active_dataset_key": key}
        workbench = self.create_workbench(name=name, description=description, document=workbench_document)
        return {"dataset": created_dataset, "workbench": workbench, "runs": self.workbench(workbench["id"])}

    def _request(self, path: str, *, method: str = "GET", body: dict[str, Any] | None = None) -> Any:
        return _control_request(
            access_token=self.access_token,
            control_url=self.control_url,
            project_id=self.project_id,
            request_timeout_seconds=self.request_timeout_seconds,
            path=path,
            method=method,
            body=body,
        )


class EvalWorkbenchClient:
    """Run and inspect one versioned eval workbench through control API.

    ``access_token`` is a Caveman member or narrowed-agent access token, not a
    provider key. Server-side role and connection scopes remain authoritative.
    """

    def __init__(
        self,
        *,
        access_token: str,
        control_url: str,
        project_id: str,
        workbench_id: str,
        request_timeout_seconds: int = 30,
    ) -> None:
        self.access_token = _required(access_token, "access_token")
        self.control_url = _service_url(control_url)
        self.project_id = _required(project_id, "project_id")
        self.workbench_id = _required(workbench_id, "workbench_id")
        self.request_timeout_seconds = _positive_integer(request_timeout_seconds, 30, "request_timeout_seconds", 86_400)

    def list(self) -> list[dict[str, Any]]:
        response = _object(self._request(""), "eval runs response must be a JSON object")
        runs = response.get("data")
        if not isinstance(runs, list):
            raise ValueError("eval runs response omitted data")
        return runs

    def run(self, *, scope: dict[str, Any] | None = None, concurrency: int = 4) -> dict[str, Any]:
        concurrency = _positive_integer(concurrency, 4, "concurrency", 24)
        return _detail(self._request("", method="POST", body={"scope": scope or {"kind": "all"}, "concurrency": concurrency}))

    def get(self, run_id: str) -> dict[str, Any]:
        return _detail(self._request(f"/{quote(_required(run_id, 'run_id'), safe='')}"))

    def cancel(self, run_id: str) -> dict[str, Any]:
        response = _object(self._request(f"/{quote(_required(run_id, 'run_id'), safe='')}/cancel", method="POST", body={}), "eval cancel response must be a JSON object")
        if not isinstance(response.get("id"), str) or not isinstance(response.get("status"), str):
            raise ValueError("eval cancel response has invalid run")
        return response

    def wait(self, run_id: str, *, timeout_seconds: int = 1800, poll_seconds: float = 1.0) -> dict[str, Any]:
        timeout_seconds = _positive_integer(timeout_seconds, 1800, "timeout_seconds", 86_400)
        if isinstance(poll_seconds, bool) or not isinstance(poll_seconds, (int, float)) or poll_seconds <= 0 or poll_seconds > 60:
            raise ValueError("poll_seconds must be a number greater than 0 and at most 60")
        deadline = time.monotonic() + timeout_seconds
        while True:
            current = self.get(run_id)
            if current["run"]["status"] in ("completed", "failed", "error", "cancelled"):
                return current
            if current["run"]["status"] not in ("queued", "running", "cancelling"):
                raise ValueError("eval_unknown_status")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("eval_wait_timeout")
            time.sleep(min(float(poll_seconds), remaining))

    def run_and_wait(
        self,
        *,
        scope: dict[str, Any] | None = None,
        concurrency: int = 4,
        timeout_seconds: int = 1800,
        poll_seconds: float = 1.0,
    ) -> dict[str, Any]:
        created = self.run(scope=scope, concurrency=concurrency)
        if created["run"]["status"] in ("completed", "failed", "error", "cancelled"):
            return created
        return self.wait(created["run"]["id"], timeout_seconds=timeout_seconds, poll_seconds=poll_seconds)

    def _request(self, path: str, *, method: str = "GET", body: dict[str, Any] | None = None) -> Any:
        return _control_request(
            access_token=self.access_token,
            control_url=self.control_url,
            project_id=self.project_id,
            request_timeout_seconds=self.request_timeout_seconds,
            path=f"/eval-workbenches/{quote(self.workbench_id, safe='')}/runs{path}",
            method=method,
            body=body,
        )


# --- Local eval harness ------------------------------------------------------
#
# Eval() keeps one experiment and one dataset per name. It runs the caller's
# task in this process, then starts a run of that experiment that carries the
# outputs: the experiment's one target is "external", so Caveman grades the
# outputs and never reads them as its own execution. Library criteria and
# inline graders ({"type": ...}) are graded by Caveman in that run and decide
# it; the verdict against a baseline is the server's too. Local criterion
# functions run here and are sent as external evidence, which the server
# stamps ``external_observed``: shown, never trusted, never gating.

_ROW_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$")
_UUID = re.compile(r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$", re.I)
_TERMINAL = ("completed", "failed", "error", "cancelled")


class EvalUploadError(RuntimeError):
    """The task and local criteria finished, the upload did not.

    ``result`` holds what ran. ``saved_path`` is the file that
    ``upload_eval_result`` sends later without running the task again; None
    when it could not be written.
    """

    def __init__(self, message: str, result: dict[str, Any], saved_path: str | None = None) -> None:
        super().__init__(message)
        self.result = result
        self.saved_path = saved_path


def _call(cloud: Any, operation: str, input: dict[str, Any], idempotency_key: str | None = None) -> Any:
    return cloud.execute(operation, input, idempotency_key=idempotency_key)["data"]


def _load_eval_data(data: Any, cloud: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str, dict[str, Any] | None]:
    """Columns, rows as ``{"key", "values", "tags"}``, a phrase naming the source, and the stored dataset the rows came from."""
    if isinstance(data, list):
        columns = [{"key": "input", "name": "Input", "type": "json", "role": "input"}]
        for key, role in (("expected", "expected"), ("metadata", "metadata")):
            if any(key in row for row in data):
                columns.append({"key": key, "name": key.capitalize(), "type": "json", "role": role})
        rows = [{"key": row.get("id") or f"row-{index + 1}", "values": {key: row[key] for key in ("input", "expected", "metadata") if key in row}, "tags": row.get("tags") or []} for index, row in enumerate(data)]
        return columns, rows, "inline rows", None
    if cloud is None:
        raise ValueError("a dataset reference needs `cloud`; pass inline rows to run offline")
    dataset_id = _required(str(data.get("dataset", "")), "data.dataset")
    if not _UUID.fullmatch(dataset_id):
        found = [item for item in _call(cloud, "datasets.list", {}).get("data") or [] if item["name"].lower() == dataset_id.lower()]
        if not found:
            raise ValueError(f'dataset "{dataset_id}" was not found in this project')
        dataset_id = found[0]["id"]
    detail = _call(cloud, "datasets.get", {"dataset_id": dataset_id})
    version, split = data.get("version"), data.get("split")
    reference: dict[str, Any] = {"key": "cases", "dataset_id": dataset_id}
    if version is None:
        columns = detail["dataset"]["columns"]
        rows = [{"key": row["row_key"], "values": row["values"], "tags": row.get("tags") or []} for row in sorted(detail.get("rows") or [], key=lambda row: row["position"])]
    else:
        snapshot = next((item for item in detail.get("versions") or [] if item["version"] == version), None)
        if snapshot is None:
            raise ValueError(f"dataset {dataset_id} has no version {version}")
        columns = snapshot["document"]["columns"]
        rows = [{"key": row["row_key"], "values": row["values"], "tags": row.get("tags") or []} for row in snapshot["document"]["rows"]]
        reference.update({"version": version, "document_sha256": snapshot["document_sha256"]})
    if split:
        rows = [row for row in rows if f"split:{split}" in row["tags"]]
    return columns, rows, f"dataset {dataset_id}" + (f" version {version}" if version is not None else "") + (f" split {split}" if split else ""), reference


def _role_value(columns: list[dict[str, Any]], values: dict[str, Any], role: str) -> Any:
    """One column of a role is its value; several are a dict by column key."""
    keys = [column["key"] for column in columns if column["role"] == role]
    if len(keys) <= 1:
        return values.get(keys[0]) if keys else None
    return {key: values.get(key) for key in keys}


def _resolve_library_criteria(cloud: Any, names: list[str]) -> list[dict[str, Any]]:
    out = []
    for name in names:
        if _UUID.fullmatch(name):
            criterion = _call(cloud, "criteria.get", {"criterion_id": name})
        else:
            found = [item for item in _call(cloud, "criteria.list", {"q": name, "limit": 100}).get("data") or [] if item["name"].lower() == name.lower()]
            if len(found) != 1:
                raise ValueError(f'criterion "{name}" was not found in this project\'s library' if not found else f'criterion name "{name}" is ambiguous; pass its id')
            criterion = found[0]
        out.append({"id": criterion["id"], "name": criterion["name"], "version": criterion["version"]})
    return out


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")[:64] or "criterion"


def _evaluators(resolved: list[dict[str, Any]], inline: list[dict[str, Any]], columns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The experiment's server-graded criteria: library criteria at their version, and inline graders on the task's output."""
    expected = next((column["key"] for column in columns if column["role"] == "expected"), None)
    mapping = {"candidate": {"source": "target", "key": "$target"}, **({"reference": {"source": "dataset", "key": expected}} if expected else {})}
    drafts = [{"name": criterion["name"], "source": "criterion", "criterion_id": criterion["id"], "criterion_version": criterion["version"]} for criterion in resolved]
    drafts += [{"name": str(grader.get("name") or grader["type"]), "source": "inline", "grader_type": grader["type"],
                "options": {key: value for key, value in grader.items() if key not in ("type", "name")}, "input_mapping": mapping} for grader in inline]
    out, taken = [], set()
    for draft in drafts:
        key, count = _slug(draft["name"]), 1
        while key in taken:
            count += 1
            key = f"{_slug(draft['name'])}_{count}"
        taken.add(key)
        out.append({"key": key, **draft})
    # Keyed by name and sorted: two runs compare when their criteria are the
    # same, whatever order the caller listed them in.
    return sorted(out, key=lambda evaluator: evaluator["key"])


async def _await(value: Any) -> Any:
    return await value


def _awaited(value: Any) -> Any:
    # Task calls run on worker threads, which own no event loop.
    return asyncio.run(_await(value)) if inspect.isawaitable(value) else value


# How often a call in flight looks at the eval's cancel_event.
_STOP_POLL = 0.05


def _cancelled() -> CancelledError:
    return CancelledError("the eval was cancelled")


def _within(call: Callable[[threading.Event], Any], timeout: float | None, stop: threading.Event | None) -> Any:
    """``call(cancel)``, raising TimeoutError once ``timeout`` seconds pass and
    CancelledError once ``stop`` is set; ``cancel`` is set then too."""
    cancel = threading.Event()
    if timeout is None and stop is None:
        return call(cancel)
    box: dict[str, Any] = {}
    done = threading.Event()

    def target() -> None:
        try:
            box["value"] = call(cancel)
        except BaseException as error:  # noqa: BLE001 - handed to the waiting thread.
            box["error"] = error
        finally:
            done.set()

    # ponytail: Python cannot stop a running call. A call past its timeout is
    # told so through its cancel event; one that ignores it is left to finish
    # on its daemon thread and its answer is dropped.
    threading.Thread(target=target, daemon=True).start()
    deadline = None if timeout is None else time.monotonic() + timeout
    while True:
        left = None if deadline is None else max(0.0, deadline - time.monotonic())
        if done.wait(_STOP_POLL if left is None else left if stop is None else min(left, _STOP_POLL)):
            break
        if stop is not None and stop.is_set():
            cancel.set()
            raise _cancelled()
        if deadline is not None and time.monotonic() >= deadline:
            cancel.set()
            raise TimeoutError(f"the task took longer than {timeout:g} s")
    if "error" in box:
        raise box["error"]
    return box["value"]


def _takes_context(function: Callable[..., Any]) -> bool:
    try:
        parameters = list(inspect.signature(function).parameters.values())
    except (TypeError, ValueError):
        return True
    positional = [p for p in parameters if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]
    # A defaulted second parameter (temperature=0.2) is the task's own setting, unless it is named for the context.
    second = positional[1] if len(positional) >= 2 else None
    return any(p.kind is p.VAR_POSITIONAL for p in parameters) or (second is not None and (second.default is second.empty or second.name in ("context", "ctx")))


def _progress(on_progress: Callable[[dict[str, Any]], None] | None, quiet: bool) -> Callable[[dict[str, Any], str], None]:
    def emit(event: dict[str, Any], line: str) -> None:
        if on_progress:
            on_progress(event)
        if not quiet:
            print(f"[caveman eval] {line}", file=sys.stderr)

    return emit


def _locally_passed(summary: dict[str, Any]) -> bool:
    return summary["task_errors"] == 0 and summary["local"]["failed"] == 0 and summary["local"]["errors"] == 0


def Eval(
    name: str,
    *,
    data: list[dict[str, Any]] | dict[str, Any],
    task: Callable[..., Any],
    criteria: list[Any],
    trials: int = 1,
    baseline: dict[str, str] | None = None,
    gate_policy: str | None = None,
    cloud: Any = None,
    cave: Any = None,
    dry_run: bool = False,
    concurrency: int = 4,
    on_progress: Callable[[dict[str, Any]], None] | None = None,
    quiet: bool = False,
    console_url: str | None = None,
    poll_seconds: float = 1.0,
    timeout_seconds: int = 1800,
    retries: int = 2,
    task_timeout_seconds: float | None = None,
    budget_usd: float | None = None,
    results_dir: str | None = ".",
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    """Run ``task`` over ``data`` here, grade with ``criteria``, add a run to the experiment named ``name``.

    The same ``name`` is the same experiment and the same dataset every time,
    so its runs line up: unchanged rows reuse the dataset's version, and the
    run is read against the experiment's saved baseline on the server.

    ``data`` is inline rows (``{"input", "expected"?, "metadata"?, "id"?, "tags"?}``),
    kept as the dataset named ``name``, or a stored dataset
    (``{"dataset": id or name, "version"?: int, "split"?: str}``).
    ``task(input)`` or ``task(input, context)`` may be sync or async; ``context``
    carries ``name``, ``row_key``, ``trial``, ``trace_id``, ``expected``,
    ``cancel_event`` (a ``threading.Event`` set when this call runs past
    ``task_timeout_seconds`` or the eval is cancelled) and, when ``cave`` is
    given, the open ``trace``.

    In ``criteria`` a string names a library criterion (id or name) and a dict
    with ``"type"`` is an inline grader (``{"type": "contains", ...}``; every
    other key is one of its options, ``"name"`` its label). Caveman grades both
    in the run and both decide ``passed``. A function, or ``{"name", "grade"}``,
    is a local criterion called with ``input``, ``output``, ``expected``,
    ``row_key`` and ``trial`` keywords and returning a bool or
    ``{"passed", "score"?, "reason"?}``. Local verdicts are never trusted.

    A task call that raises, or runs past ``task_timeout_seconds``, is tried
    again up to ``retries`` times; a failed verdict never is. A call past its
    timeout has its ``context["cancel_event"]`` set before it is tried again.
    Setting ``cancel_event`` stops the eval: no task call starts after it, the
    calls in flight have their context's event set, and ``Eval`` raises
    ``concurrent.futures.CancelledError`` without writing a run. ``trials`` runs
    each row that many times as trials of one case. ``budget_usd`` caps what
    grading the run may spend (an agent connection must name one).
    ``baseline`` is ``{"run_id"}`` of a finished run of this experiment;
    without it the experiment's saved baseline is used, when it has one.
    ``gate_policy`` (``"kernel"`` or ``"strict"``) is stored on the experiment
    as the rule its comparisons are read by, here, in ``cvm`` and in the
    console; without it the experiment's stored policy decides.

    Returns the result dict; it never exits the process, so a test asserts on
    ``result["passed"]``, which is None when no server criterion was graded
    (dry run). ``result["baseline"]`` is the server's comparison. ``dry_run``
    writes nothing. A run whose upload fails after the task ran raises
    ``EvalUploadError``; what ran is written under ``results_dir`` (None
    writes nothing) for ``upload_eval_result``.
    """
    _required(name, "name")
    if gate_policy not in (None, "kernel", "strict"):
        raise ValueError('gate_policy must be "kernel" or "strict"')
    trials = _positive_integer(trials, 1, "trials", 10)
    concurrency = _positive_integer(concurrency, 4, "concurrency", 64)
    if isinstance(retries, bool) or not isinstance(retries, int) or not 0 <= retries <= 10:
        raise ValueError("retries must be an integer from 0 to 10")
    if task_timeout_seconds is not None and (isinstance(task_timeout_seconds, bool) or not isinstance(task_timeout_seconds, (int, float)) or task_timeout_seconds <= 0):
        raise ValueError("task_timeout_seconds must be a number greater than 0")
    if cancel_event is not None and not isinstance(cancel_event, threading.Event):
        raise TypeError("cancel_event must be a threading.Event")
    if cancel_event is not None and cancel_event.is_set():
        raise _cancelled()
    if not dry_run and cloud is None:
        raise ValueError("Eval needs `cloud` to upload; pass dry_run=True to run without uploading")
    emit = _progress(on_progress, quiet)

    library = [criterion for criterion in criteria if isinstance(criterion, str)]
    inline = [criterion for criterion in criteria if isinstance(criterion, dict) and "type" in criterion]
    functions = [criterion for criterion in criteria if not isinstance(criterion, str) and not (isinstance(criterion, dict) and "type" in criterion)]
    local = [criterion if isinstance(criterion, dict) else {"name": getattr(criterion, "__name__", "<").startswith("<") and f"local_{index + 1}" or criterion.__name__, "grade": criterion}
             for index, criterion in enumerate(functions)]
    if len({criterion["name"] for criterion in local}) != len(local):
        raise ValueError("local criteria need distinct names")
    if any(not isinstance(grader["type"], str) or not grader["type"] for grader in inline):
        raise ValueError('an inline grader names its type: {"type": "contains", ...}')
    server_names = library + [str(grader.get("name") or grader["type"]) for grader in inline]

    columns, rows, source, reference = _load_eval_data(data, cloud)
    units: list[dict[str, Any]] = [{"row": row, "trial": trial} for row in rows for trial in range(1, trials + 1)]
    if not units:
        raise ValueError(f"{source} has no rows to run")
    if len(rows) > 10_000:
        raise ValueError("a dataset holds at most 10000 rows")
    if len({row["key"] for row in rows}) != len(rows) or any(not isinstance(row["key"], str) or not _ROW_KEY.fullmatch(row["key"]) for row in rows):
        raise ValueError("row ids must be unique and match [A-Za-z0-9][A-Za-z0-9_-]{0,95}")

    # Before the task runs: a misspelled criterion, an unknown grader type or a
    # missing permission should not cost a full run.
    pending: dict[str, Any] = {"schema_version": 1, "name": name, "trials": trials, "request_id": secrets.token_hex(16), "server_criteria": bool(server_names),
                               "baseline_run_id": (baseline or {}).get("run_id"), "budget_usd": budget_usd, "dataset_id": None, "workbench_id": None}
    if not dry_run:
        resolved = _resolve_library_criteria(cloud, library) if library else []
        provenance = f'Local eval "{name}" run by the Caveman SDK. Outputs are produced by the caller\'s task, not by Caveman.'
        if reference is None:
            emit({"type": "upload", "step": "dataset"}, "saving the cases as a dataset")
            dataset = _call(cloud, "datasets.create", {
                "name": name, "description": provenance, "upsert": True,
                "document": {"schema_version": 1, "columns": columns, "rows": [{"row_key": row["key"], "values": row["values"], **({"tags": row["tags"]} if row["tags"] else {})} for row in rows]},
            }, f"{pending['request_id']}:dataset")
            reference = {"key": "cases", "dataset_id": dataset["id"]}
        emit({"type": "upload", "step": "experiment"}, "finding or creating the experiment")
        workbench = _call(cloud, "evals.create", {
            "name": name, "description": provenance, "upsert": True,
            "document": {"schema_version": 1, "datasets": [reference],
                         "targets": [{"key": "local_task", "name": "Local task (run by the SDK)", "kind": "external", "input_mapping": {}, "config": {}}],
                         "evaluators": _evaluators(resolved, inline, columns)},
        }, f"{pending['request_id']}:experiment")
        if gate_policy:
            _call(cloud, "evals.set_baseline", {"workbench_id": workbench["id"], "gate_policy": gate_policy})
        pending.update({"dataset_id": reference["dataset_id"], "workbench_id": workbench["id"]})

    emit({"type": "start", "name": name, "rows": len(rows), "trials": trials}, f"{name}: {len(rows)} rows x {trials} trial(s) from {source}")
    with_context = _takes_context(task)
    completed = 0
    progress = threading.Lock()

    def run_unit(unit: dict[str, Any]) -> dict[str, Any]:
        nonlocal completed
        row, trial, key = unit["row"], unit["trial"], unit["row"]["key"]
        task_input, expected = _role_value(columns, row["values"], "input"), _role_value(columns, row["values"], "expected")
        trace_id = secrets.token_hex(16)
        context = {"name": name, "row_key": key, "trial": trial, "trace_id": trace_id, "expected": expected}
        outcome: dict[str, Any] = {"row_key": key, "source_row_key": key, "trial": trial, "input": task_input, "expected": expected, "output": None, "duration_ms": 0, "trace_id": trace_id, "attempts": 0, "verdicts": []}

        def attempt(cancel: threading.Event) -> Any:
            if cave is not None:
                with cave.trace(name, {"eval": name, "eval_row": key, "eval_trial": str(trial)}, trace_id=trace_id) as trace:
                    return _awaited(task(task_input, {**context, "cancel_event": cancel, "trace": trace}) if with_context else task(task_input))
            return _awaited(task(task_input, {**context, "cancel_event": cancel}) if with_context else task(task_input))

        while True:
            # Cancelled: this row is not finished, and nothing more starts.
            if cancel_event is not None and cancel_event.is_set():
                raise _cancelled()
            outcome["attempts"] += 1
            started = time.monotonic()
            try:
                output = _within(attempt, task_timeout_seconds, cancel_event)
                try:
                    # The upload is JSON: a value it cannot carry fails this row now, not the whole run at the end.
                    json.dumps(output, allow_nan=False)
                except (TypeError, ValueError) as unencodable:
                    raise TypeError(f"the task's output is not JSON: {unencodable}") from None
                outcome["output"] = output
                outcome.pop("error", None)
            except Exception as error:  # noqa: BLE001 - the caller's task failed; the row records why.
                outcome["error"] = str(error) or type(error).__name__
            outcome["duration_ms"] = int((time.monotonic() - started) * 1000)
            if cancel_event is not None and cancel_event.is_set():
                raise _cancelled()
            if "error" not in outcome or outcome["attempts"] > retries:
                break
            backoff = min(0.5 * 2 ** (outcome["attempts"] - 1), 8.0)
            if cancel_event is None:
                time.sleep(backoff)
            else:
                cancel_event.wait(backoff)
        for criterion in local:
            if "error" in outcome:
                outcome["verdicts"].append({"criterion": criterion["name"], "graded_by": "local", "status": "skipped", "passed": None, "reason": "the task failed"})
                continue
            try:
                verdict = _awaited(criterion["grade"](input=task_input, output=outcome["output"], expected=expected, row_key=key, trial=trial))
                if isinstance(verdict, bool):
                    verdict = {"passed": verdict}
                if not isinstance(verdict, dict) or not isinstance(verdict.get("passed"), bool):
                    raise TypeError("a local criterion returns a bool or {'passed', 'score'?, 'reason'?}")
                outcome["verdicts"].append({"criterion": criterion["name"], "graded_by": "local", "status": "completed", "passed": verdict["passed"], **{k: verdict[k] for k in ("score", "reason") if verdict.get(k) is not None}})
            except Exception as error:  # noqa: BLE001 - the caller's criterion failed; the verdict records why.
                outcome["verdicts"].append({"criterion": criterion["name"], "graded_by": "local", "status": "error", "passed": None, "reason": str(error) or type(error).__name__})
        outcome["finished_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        with progress:
            completed += 1
            emit({"type": "row", "row_key": key, "trial": trial, "completed": completed, "total": len(units), "status": "error" if "error" in outcome else "completed", "trace_id": trace_id, "attempts": outcome["attempts"]},
                 f"{completed}/{len(units)} {key}" + (f" trial {trial}" if trials > 1 else "") + (f" error: {outcome['error']}" if "error" in outcome else " ok") + (f" (attempt {outcome['attempts']})" if outcome["attempts"] > 1 else ""))
        return outcome

    with ThreadPoolExecutor(max_workers=min(concurrency, len(units))) as pool:
        outcomes = list(pool.map(run_unit, units))
    if cancel_event is not None and cancel_event.is_set():
        raise _cancelled()

    verdicts = [verdict for outcome in outcomes for verdict in outcome["verdicts"]]
    result: dict[str, Any] = {
        "name": name, "passed": None, "dry_run": dry_run, "rows": outcomes, "upload": None, "baseline": None,
        "summary": {
            "rows": len(outcomes),
            "task_errors": sum("error" in outcome for outcome in outcomes),
            "retried": sum(outcome["attempts"] > 1 for outcome in outcomes),
            "local": {"passed": sum(v["passed"] is True for v in verdicts), "failed": sum(v["passed"] is False for v in verdicts), "errors": sum(v["status"] == "error" for v in verdicts), "trusted": False},
            "server": None,
            "not_graded": server_names if dry_run else [],
        },
    }
    if dry_run:
        for outcome in outcomes:
            outcome["verdicts"] += [{"criterion": criterion, "graded_by": "caveman", "status": "skipped", "passed": None, "reason": "dry run: Caveman grades this criterion on upload"} for criterion in server_names]
        local_passed = _locally_passed(result["summary"])
        result["passed"] = local_passed if not server_names else (None if local_passed else False)
        emit({"type": "done", "passed": result["passed"], "url": None}, f"{name}: dry run, nothing uploaded" + (f"; not graded: {', '.join(server_names)}" if server_names else ""))
        return result

    pending["result"] = result
    try:
        return _upload(pending, cloud, emit, console_url, poll_seconds, timeout_seconds)
    except Exception as error:
        saved_path = _save(pending, results_dir)
        raise EvalUploadError(f'eval "{name}" ran but its upload failed: {error}' + (f"; what ran is in {saved_path}, send it with upload_eval_result" if saved_path else ""), result, saved_path) from error


def _save(pending: dict[str, Any], results_dir: str | None) -> str | None:
    if results_dir is None:
        return None
    path = os.path.join(results_dir, f"caveman-eval-{_slug(pending['name'])}-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{secrets.token_hex(3)}.json")
    try:
        # Encode first: a value json cannot write must not leave half a file behind.
        text = json.dumps(pending, allow_nan=False)
        with open(path, "w", encoding="utf-8") as file:
            file.write(text)
    except (OSError, TypeError, ValueError):
        return None
    return path


def upload_eval_result(
    saved: str | dict[str, Any],
    *,
    cloud: Any,
    on_progress: Callable[[dict[str, Any]], None] | None = None,
    quiet: bool = False,
    console_url: str | None = None,
    poll_seconds: float = 1.0,
    timeout_seconds: int = 1800,
) -> dict[str, Any]:
    """Send a finished eval whose upload failed, from the file ``EvalUploadError.saved_path`` names.

    The task is not run again: the saved outputs and local verdicts are sent
    as they were. A run the first attempt already started is waited for, not
    started twice. Returns what ``Eval`` would have; raises ``EvalUploadError``
    when the upload fails again (the file is left as it is).
    """
    if isinstance(saved, str):
        with open(saved, encoding="utf-8") as file:
            saved = json.load(file)
    pending = _object(saved, "a saved eval result must be a JSON object")
    if pending.get("schema_version") != 1 or not isinstance(pending.get("result"), dict) or not pending.get("workbench_id"):
        raise ValueError("not a saved eval result")
    try:
        return _upload(pending, cloud, _progress(on_progress, quiet), console_url, poll_seconds, timeout_seconds)
    except Exception as error:
        raise EvalUploadError(f'eval "{pending["name"]}" upload failed: {error}', pending["result"]) from error


def _upload(pending: dict[str, Any], cloud: Any, emit: Callable[[dict[str, Any], str], None], console_url: str | None, poll_seconds: float, timeout_seconds: int) -> dict[str, Any]:
    """Start the run that carries the outputs, wait for Caveman to grade it, and read it against the baseline."""
    name, result, workbench_id = pending["name"], pending["result"], pending["workbench_id"]
    outcomes, summary = result["rows"], result["summary"]
    url = f"{console_url.rstrip('/')}/experiments/workbenches/{workbench_id}" if console_url else None
    if not (result.get("upload") or {}).get("run_id"):
        emit({"type": "upload", "step": "run"}, "starting the run")
        scope = {"kind": "all", **({"trials": pending["trials"]} if pending["trials"] > 1 else {}), **({"budget_usd": pending["budget_usd"]} if pending.get("budget_usd") else {})}
        run = _call(cloud, "evals.run", {"workbench_id": workbench_id, "scope": scope, "outputs": [{
            "row_key": outcome["row_key"], "trial": outcome["trial"], "trace_id": outcome["trace_id"], "latency_ms": outcome["duration_ms"], "attempts": outcome["attempts"],
            **({"error": outcome["error"][:2000]} if "error" in outcome else {"output": outcome["output"]}),
        } for outcome in outcomes]}, f"{pending['request_id']}:run")["run"]
        result["upload"] = {"dataset_id": pending["dataset_id"], "workbench_id": workbench_id, "run_id": run["id"], "run_status": run["status"], "url": url, "local_evidence": None}
    upload = result["upload"]
    upload["url"] = url
    run_id = upload["run_id"]

    evidence = []
    for outcome in outcomes:
        # A second upload of a saved result reads the server's verdicts again.
        outcome["verdicts"] = [verdict for verdict in outcome["verdicts"] if verdict["graded_by"] == "local"]
        for verdict in outcome["verdicts"]:
            if verdict["status"] == "skipped":
                continue
            item = {
                "observed_at": outcome["finished_at"], "result_at": outcome["finished_at"], "trace_id": outcome["trace_id"],
                "source_system": "caveman-sdk-local-eval", "source_run_id": run_id, "source_suite_id": workbench_id, "source_case_id": outcome["row_key"],
                "evaluator_name": verdict["criterion"], "evaluator_type": "local_function", "evaluator_version": "local",
                "evaluator_config_digest": hashlib.sha256(f"local_function:{verdict['criterion']}".encode()).hexdigest(),
                "completeness": "complete", "idempotency_key": f"{run_id}/{outcome['row_key']}/{outcome['trial']}/{verdict['criterion']}",
            }
            if verdict["status"] == "completed":
                item.update({"status": "processed", "passed": verdict["passed"], **({"score": verdict["score"]} if "score" in verdict else {})})
            else:
                item.update({"status": "error", "fault": "customer"})
            if verdict.get("reason"):
                item["explanation"] = str(verdict["reason"])[:1000]
            evidence.append(item)
    if evidence:
        emit({"type": "upload", "step": "local_criteria"}, "recording local criteria as external evidence (never trusted)")
        totals = {"accepted": 0, "rejected": 0, "duplicate": 0, "conflict": 0}
        for start in range(0, len(evidence), 500):
            batch = _call(cloud, "evals.ingest_evidence", {"items": evidence[start:start + 500]})
            for key in totals:
                totals[key] += batch[key]
        upload["local_evidence"] = totals
        if totals["rejected"]:
            raise RuntimeError(f"Caveman rejected {totals['rejected']} local criterion result(s)")

    deadline = time.monotonic() + _positive_integer(timeout_seconds, 1800, "timeout_seconds", 86_400)
    detail = _call(cloud, "evals.result", {"workbench_id": workbench_id, "run_id": run_id})
    while detail["run"]["status"] not in _TERMINAL:
        emit({"type": "grading", "completed": detail["run"]["progress_completed"], "total": detail["run"]["progress_total"], "status": detail["run"]["status"]},
             f"grading {detail['run']['progress_completed']}/{detail['run']['progress_total']}")
        if time.monotonic() >= deadline:
            raise TimeoutError("eval_wait_timeout")
        time.sleep(poll_seconds)
        detail = _call(cloud, "evals.result", {"workbench_id": workbench_id, "run_id": run_id})
    upload["run_status"] = detail["run"]["status"]
    by_cell = {(outcome["row_key"], outcome["trial"]): outcome for outcome in outcomes}
    for cell in detail.get("cells") or []:
        outcome = by_cell.get((cell["dataset_row_key"], cell.get("trial") or 1))
        graded_list = cell.get("evaluator_results")
        if outcome is None or not isinstance(graded_list, list):
            continue
        for graded in graded_list:
            done = graded.get("status") == "completed"
            verdict = {"criterion": str(graded.get("name") or graded.get("key")), "graded_by": "caveman", "status": "completed" if done else "error",
                       "passed": graded.get("passed") if done and isinstance(graded.get("passed"), bool) else None, "detail": graded}
            for key in ("score", "reason"):
                if graded.get(key) is not None:
                    verdict[key] = graded[key]
            outcome["verdicts"].append(verdict)
    graded_by_server = bool(pending["server_criteria"])
    if graded_by_server:
        summary["server"] = detail["quality"]

    # The verdict against a baseline is the server's: the run named, else the
    # experiment's saved baseline. With neither there is nothing to read it against.
    explicit = pending.get("baseline_run_id")
    result["baseline"] = None
    if graded_by_server and detail["run"]["status"] == "completed":
        saved_baseline = {} if explicit else _call(cloud, "evals.get_baseline", {"workbench_id": workbench_id})
        if explicit or saved_baseline.get("experiment") or saved_baseline.get("project"):
            try:
                compared = _call(cloud, "evals.compare", {"workbench_id": workbench_id, "candidate_run_id": run_id, **({"baseline_run_id": explicit} if explicit else {})})
            except Exception as error:  # noqa: BLE001 - only no baseline and a refusal to compare are answers.
                # A project default that is another experiment's run is no baseline of this one.
                code = getattr(error, "code", None)
                if code not in ("cave_eval_no_baseline", "cave_eval_comparison_incompatible"):
                    raise
                if code == "cave_eval_comparison_incompatible":
                    result["baseline"] = {"run_id": explicit, "comparable": False, "reason": str(error), "computed_by": "caveman"}
            else:
                result["baseline"] = {"run_id": compared["baseline_run_id"], "source": compared.get("baseline_source"), "comparable": True, "computed_by": "caveman",
                                      "verdict": compared["quality"], "policy": compared.get("policy"), "policy_source": compared.get("policy_source"), "summary": compared.get("summary"),
                                      "paired_cases": compared["paired_cells"], "regressions": compared["regressions"], "improvements": compared["improvements"],
                                      "unchanged": compared.get("unchanged"), "unpaired": compared.get("unpaired"),
                                      "changed_cases": compared.get("changed_cases") or [], "statistics": compared.get("statistics")}

    compared_to = result["baseline"] or {}
    result["passed"] = (_locally_passed(summary) and detail["run"]["status"] == "completed" and (not graded_by_server or detail["quality"]["status"] == "passed")
                        and compared_to.get("verdict") != "failed")
    against = f"; against the baseline: {compared_to.get('summary') or compared_to['verdict']}" if compared_to.get("comparable") else ("; not compared: " + compared_to["reason"] if compared_to else "")
    emit({"type": "done", "passed": result["passed"], "url": url}, f"{name}: {'passed' if result['passed'] else 'failed'}{against}; " + (url or f"experiment {workbench_id} run {run_id}"))
    return result
