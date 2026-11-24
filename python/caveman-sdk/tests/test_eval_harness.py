"""Local eval harness and prompts.get(slug) against a fake control plane. Mirrors tests/eval-harness.runtime.mjs."""

from __future__ import annotations

import io
import json
import re
import threading
import time
from concurrent.futures import CancelledError
import urllib.error
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from caveman_cloud import Cloud, CloudError, Eval, EvalUploadError, upload_eval_result
from caveman_cloud.cloud import _OPERATIONS

PARITY = json.loads((Path(__file__).resolve().parents[2] / "parity" / "eval-harness.json").read_text())

PROJECT = "11111111-1111-4111-8111-111111111111"
CRITERION = "22222222-2222-4222-8222-222222222222"
DATASET = "33333333-3333-4333-8333-333333333333"


class Response(io.BytesIO):
    def __init__(self, body: Any, status: int = 200) -> None:
        super().__init__(json.dumps(body).encode())
        self.status = status


def envelope(operation: str, data: Any) -> dict[str, Any]:
    meta = _OPERATIONS[operation]
    return {"schema_version": 1, "operation": operation, "version": meta["version"], "contract_sha256": meta["contract"], "ok": True, "status": "completed", "data": data}


class FakeControl:
    """Answers Cloud operations by name and records every call."""

    def __init__(self, handlers: dict[str, Any]) -> None:
        self.handlers = handlers
        self.calls: list[tuple[str, Any]] = []

    def open(self, request: Any, timeout: float) -> Response:
        operation = request.full_url.rsplit("/", 1)[1]
        body = json.loads(request.data)
        self.calls.append((operation, body))
        handler = self.handlers[operation]
        return Response(envelope(operation, handler(body) if callable(handler) else handler))

    def bodies(self, operation: str) -> list[dict[str, Any]]:
        return [body for name, body in self.calls if name == operation]


def cloud_with(fake: FakeControl) -> Cloud:
    cloud = Cloud(control_url="https://control.example", access_token="secret", project_id=PROJECT)
    cloud._opener = fake  # type: ignore[assignment]
    return cloud


def graded_run(passed: bool = True, *, saved_baseline: bool = False) -> dict[str, Any]:
    """Handlers for a run Caveman grades at once: every output sent gets one verdict from the criterion "grounded"."""
    state: dict[str, Any] = {"outputs": []}

    def run(body: dict[str, Any]) -> dict[str, Any]:
        state["outputs"] = body["outputs"]
        return {"run": {"id": "run-1", "project_id": PROJECT, "workbench_id": "workbench-1", "status": "queued"}, "outbox_id": "o", "delivery_status": "pending"}

    def result(_: dict[str, Any]) -> dict[str, Any]:
        cells = [{"dataset_row_key": output["row_key"], "trial": output["trial"], "target_key": "local_task", "status": "completed",
                  "evaluator_results": [{"key": "grounded", "name": "Grounded", "status": "completed", "passed": passed, "score": 1.0 if passed else 0.0, "calibrated": True}]} for output in state["outputs"]]
        quality = {"status": "passed" if passed else "failed", "passed": len(cells) if passed else 0, "failed": 0 if passed else len(cells), "cells": len(cells), "evidence_basis": "external_output_grading"}
        return {"run": {"id": "run-1", "status": "completed", "progress_completed": len(cells), "progress_total": len(cells)}, "cells": cells, "quality": quality}

    return {
        "criteria.get": {"id": CRITERION, "name": "Grounded", "version": 3},
        "datasets.create": {"id": "dataset-1", "project_id": PROJECT, "revision": 1, "status": "active"},
        "evals.create": {"id": "workbench-1", "project_id": PROJECT, "revision": 1, "status": "active"},
        "evals.run": run,
        "evals.ingest_evidence": lambda body: {"accepted": len(body["items"]), "rejected": 0, "duplicate": 0, "conflict": 0, "dry_run": False, "errors": []},
        "evals.result": result,
        "evals.get_baseline": {"experiment": {"workbench_id": "workbench-1", "run_id": "run-0", "target_key": "", "set_by": None, "set_at": "2026-10-08T00:00:00Z"} if saved_baseline else None, "project": None},
        "evals.compare": PARITY["comparison"],
    }


def refused(status: int, code: str, message: str) -> Any:
    def handler(_: dict[str, Any]) -> dict[str, Any]:
        raise urllib.error.HTTPError("https://control.example", status, "refused", {}, io.BytesIO(json.dumps({"error": {"code": code, "message": message}}).encode()))  # type: ignore[arg-type]

    return handler


def exact(*, output: Any, expected: Any, **_: Any) -> bool:
    return output == expected


def test_dry_run_runs_trials_and_local_criteria_without_network() -> None:
    events: list[dict[str, Any]] = []
    contexts: list[dict[str, Any]] = []

    async def task(value: int, context: dict[str, Any]) -> int:
        contexts.append(context)
        return value + 1

    with patch("urllib.request.OpenerDirector.open", side_effect=AssertionError("dry run must not connect")):
        result = Eval("adder", data=[{"input": 1, "expected": 2}, {"id": "two", "input": 2, "expected": 9}], task=task, criteria=[exact, CRITERION, {"type": "contains", "fragments": ["3"]}],
                      trials=2, dry_run=True, on_progress=events.append, quiet=True)

    # A trial is a trial of its row, not a row of its own.
    assert [(row["row_key"], row["trial"]) for row in result["rows"]] == [("row-1", 1), ("row-1", 2), ("two", 1), ("two", 2)]
    assert result["summary"]["local"] == {"passed": 2, "failed": 2, "errors": 0, "trusted": False}
    assert result["summary"]["server"] is None and result["summary"]["not_graded"] == [CRITERION, "contains"]
    assert result["passed"] is False and result["upload"] is None
    local, library, inline = result["rows"][0]["verdicts"]
    assert local == {"criterion": "exact", "graded_by": "local", "status": "completed", "passed": True}
    assert (library["graded_by"], library["status"], library["passed"]) == ("caveman", "skipped", None)
    assert (inline["criterion"], inline["graded_by"], inline["status"]) == ("contains", "caveman", "skipped")
    # Every task call gets its own trace id, and the row carries it.
    assert all(re.fullmatch(r"[0-9a-f]{32}", row["trace_id"]) for row in result["rows"])
    assert sorted(context["trace_id"] for context in contexts) == sorted(row["trace_id"] for row in result["rows"])
    assert len({row["trace_id"] for row in result["rows"]}) == 4
    assert [event["type"] for event in events] == ["start", "row", "row", "row", "row", "done"]
    assert events[-2]["completed"] == events[-2]["total"] == 4


def test_dry_run_with_ungraded_library_criteria_claims_nothing() -> None:
    result = Eval("adder", data=[{"input": 1}], task=lambda value: value, criteria=["Grounded"], dry_run=True, quiet=True)
    assert result["passed"] is None


def test_named_eval_wire_matches_the_parity_fixture() -> None:
    """The requests of one named eval, byte for byte what the TypeScript SDK sends (parity/eval-harness.json)."""
    fake = FakeControl(graded_run(saved_baseline=True))
    result = Eval(PARITY["name"], cloud=cloud_with(fake), data=PARITY["data"], task=lambda question: question.replace("q", "a"),
                  criteria=[*PARITY["inline"], PARITY["criterion"]["id"]], trials=PARITY["trials"], budget_usd=PARITY["budget_usd"], concurrency=1, quiet=True)

    assert [name for name, _ in fake.calls] == ["criteria.get", "datasets.create", "evals.create", "evals.run", "evals.result", "evals.get_baseline", "evals.compare"]
    for operation, expected in PARITY["requests"].items():
        body = fake.bodies(operation)[0]
        if operation == "evals.run":
            assert all(re.fullmatch(r"[0-9a-f]{32}", output.pop("trace_id")) and output.pop("latency_ms") >= 0 for output in body["outputs"])
        assert body == expected, operation
    # The verdict against the experiment's saved baseline is the server's.
    assert result["baseline"] == PARITY["baseline"]
    assert result["passed"] is True  # need_more_data is not a failure


def test_upload_sends_outputs_for_server_grading_and_local_criteria_as_untrusted_evidence(capsys: pytest.CaptureFixture[str]) -> None:
    fake = FakeControl(graded_run())
    result = Eval("support", cloud=cloud_with(fake), data=[{"input": "q1", "expected": "a1"}, {"input": "q2", "expected": "a2"}], task=lambda question: question.replace("q", "a"),
                  criteria=[CRITERION, exact], console_url="https://console.example/")

    # The dataset and the experiment are found or made before the task runs, the outputs travel with the run.
    assert [name for name, _ in fake.calls] == ["criteria.get", "datasets.create", "evals.create", "evals.run", "evals.ingest_evidence", "evals.result", "evals.get_baseline"]
    dataset = fake.bodies("datasets.create")[0]
    assert dataset["name"] == "support" and dataset["upsert"] is True
    # The dataset is the cases: no output is stored in it.
    assert dataset["document"]["rows"] == [{"row_key": "row-1", "values": {"input": "q1", "expected": "a1"}}, {"row_key": "row-2", "values": {"input": "q2", "expected": "a2"}}]
    experiment = fake.bodies("evals.create")[0]
    assert experiment["name"] == "support" and experiment["upsert"] is True
    assert experiment["document"]["targets"] == [{"key": "local_task", "name": "Local task (run by the SDK)", "kind": "external", "input_mapping": {}, "config": {}}]
    # The library criterion is named, not graded here: Caveman grades it in the run.
    assert experiment["document"]["evaluators"] == [{"key": "grounded", "name": "Grounded", "source": "criterion", "criterion_id": CRITERION, "criterion_version": 3}]
    run = fake.bodies("evals.run")[0]
    assert run["scope"] == {"kind": "all"}
    assert [(output["row_key"], output["trial"], output["output"], output["attempts"], output["trace_id"]) for output in run["outputs"]] == [
        ("row-1", 1, "a1", 1, result["rows"][0]["trace_id"]), ("row-2", 1, "a2", 1, result["rows"][1]["trace_id"])]
    evidence = fake.bodies("evals.ingest_evidence")[0]["items"]
    assert len(evidence) == 2
    assert {key: evidence[0][key] for key in ("source_system", "evaluator_name", "evaluator_type", "status", "passed", "source_run_id", "source_case_id", "trace_id", "idempotency_key")} == {
        "source_system": "caveman-sdk-local-eval", "evaluator_name": "exact", "evaluator_type": "local_function", "status": "processed", "passed": True,
        "source_run_id": "run-1", "source_case_id": "row-1", "trace_id": result["rows"][0]["trace_id"], "idempotency_key": "run-1/row-1/1/exact"}
    assert "authority" not in evidence[0]  # the server stamps external_observed; the client cannot claim more.

    assert result["passed"] is True
    assert result["summary"]["server"]["status"] == "passed" and result["summary"]["local"]["trusted"] is False
    assert [(v["criterion"], v["graded_by"], v["passed"]) for v in result["rows"][0]["verdicts"]] == [("exact", "local", True), ("Grounded", "caveman", True)]
    assert result["rows"][0]["verdicts"][1]["detail"]["calibrated"] is True
    assert result["upload"] == {"dataset_id": "dataset-1", "workbench_id": "workbench-1", "run_id": "run-1", "run_status": "completed",
                                "url": "https://console.example/experiments/workbenches/workbench-1", "local_evidence": {"accepted": 2, "rejected": 0, "duplicate": 0, "conflict": 0}}
    # No baseline named and none saved: nothing was compared, and nothing is claimed.
    assert result["baseline"] is None and "evals.compare" not in [name for name, _ in fake.calls]
    assert "https://console.example/experiments/workbenches/workbench-1" in capsys.readouterr().err


def test_dataset_reference_by_name_version_and_split_and_server_baseline_verdict() -> None:
    handlers = graded_run(passed=False)
    column = {"key": "question", "name": "Question", "type": "string", "role": "input"}
    handlers["datasets.list"] = {"data": [{"id": DATASET, "name": "Support Cases"}], "next_cursor": None}
    handlers["datasets.get"] = {"dataset": {"id": DATASET, "columns": [column]}, "rows": [], "versions": [{"version": 2, "document_sha256": "a" * 64, "document": {"schema_version": 1, "columns": [column], "rows": [
        {"row_key": "kept", "values": {"question": "hi"}, "tags": ["split:test"]}, {"row_key": "dropped", "values": {"question": "no"}, "tags": ["split:train"]}]}}]}
    handlers["criteria.list"] = {"data": [{"id": CRITERION, "name": "Grounded", "version": 3}, {"id": "other", "name": "Grounded answers", "version": 1}], "next_cursor": None}
    handlers["evals.compare"] = {**PARITY["comparison"], "baseline_run_id": "old", "baseline_source": "query", "quality": "failed", "regressions": 1,
                                 "changed_cases": [{"row_key": "kept", "target_key": "local_task", "change": "regressed"}]}
    fake = FakeControl(handlers)

    seen: list[Any] = []

    def task(question: Any) -> str:
        seen.append(question)
        return "answer"

    result = Eval("support", cloud=cloud_with(fake), data={"dataset": "support cases", "version": 2, "split": "test"}, task=task,
                  criteria=["grounded"], baseline={"workbench_id": "workbench-1", "run_id": "old"}, quiet=True)

    assert seen == ["hi"]
    assert fake.bodies("datasets.get") == [{"dataset_id": DATASET}]
    assert fake.bodies("criteria.list") == [{"q": "grounded", "limit": 100}]
    # A stored dataset is used as it is, pinned to the version asked for: nothing is copied.
    assert fake.bodies("datasets.create") == []
    assert fake.bodies("evals.create")[0]["document"]["datasets"] == [{"key": "cases", "dataset_id": DATASET, "version": 2, "document_sha256": "a" * 64}]
    assert [output["row_key"] for output in fake.bodies("evals.run")[0]["outputs"]] == ["kept"]
    assert fake.bodies("evals.compare") == [{"workbench_id": "workbench-1", "candidate_run_id": "run-1", "baseline_run_id": "old"}]
    assert fake.bodies("evals.get_baseline") == []
    assert result["summary"]["server"]["status"] == "failed"
    baseline = result["baseline"]
    assert (baseline["run_id"], baseline["source"], baseline["verdict"], baseline["regressions"], baseline["computed_by"]) == ("old", "query", "failed", 1, "caveman")
    assert baseline["changed_cases"] == [{"row_key": "kept", "target_key": "local_task", "change": "regressed"}]
    assert result["passed"] is False


def test_gate_policy_is_stored_on_the_experiment_and_the_comparison_names_none() -> None:
    """One source of truth: the policy is the experiment's, and the comparison reports the one that decided."""
    handlers = graded_run(saved_baseline=True)
    handlers["evals.set_baseline"] = {"experiment": None, "project": None, "gate_policy": "strict"}
    handlers["evals.compare"] = {**PARITY["comparison"], "policy": "strict", "quality": "passed"}
    fake = FakeControl(handlers)
    result = Eval("support", cloud=cloud_with(fake), data=[{"id": "one", "input": "q"}], task=lambda question: "a", criteria=[CRITERION], gate_policy="strict", quiet=True)
    assert fake.bodies("evals.set_baseline") == [{"workbench_id": "workbench-1", "gate_policy": "strict"}]
    assert fake.bodies("evals.compare") == [{"workbench_id": "workbench-1", "candidate_run_id": "run-1"}]
    assert (result["baseline"]["policy"], result["baseline"]["policy_source"], result["baseline"]["verdict"]) == ("strict", "experiment", "passed")
    with pytest.raises(ValueError, match="gate_policy"):
        Eval("support", data=[{"id": "one", "input": "q"}], task=lambda question: "a", criteria=[], gate_policy="lenient", dry_run=True)


def test_a_run_the_server_cannot_compare_says_so_and_keeps_its_own_verdict() -> None:
    handlers = graded_run(saved_baseline=True)
    handlers["evals.compare"] = refused(409, "cave_eval_comparison_incompatible", "Evaluation runs are not compatible for comparison.")
    result = Eval("support", cloud=cloud_with(FakeControl(handlers)), data=[{"input": "q"}], task=lambda question: "a", criteria=[CRITERION], quiet=True)
    assert result["baseline"] == {"run_id": None, "comparable": False, "reason": "Evaluation runs are not compatible for comparison.", "computed_by": "caveman"}
    assert result["passed"] is True


def test_a_project_default_that_is_another_experiments_run_is_no_baseline() -> None:
    handlers = graded_run(saved_baseline=True)
    handlers["evals.compare"] = refused(409, "cave_eval_no_baseline", "No baseline is saved for this experiment. Name a baseline run, or save one.")
    result = Eval("support", cloud=cloud_with(FakeControl(handlers)), data=[{"input": "q"}], task=lambda question: "a", criteria=[CRITERION], quiet=True)
    assert result["baseline"] is None
    assert result["passed"] is True


def test_a_task_that_raises_is_retried_and_the_attempts_are_uploaded() -> None:
    fake = FakeControl(graded_run())
    calls: list[str] = []

    def flaky(question: str) -> str:
        calls.append(question)
        if question == "q1" and calls.count("q1") < 3:
            raise RuntimeError("rate limited")
        if question == "q3":
            raise RuntimeError("model unavailable")
        return "a"

    with patch("caveman_cloud.evals.time.sleep") as sleep:
        result = Eval("support", cloud=cloud_with(fake), data=[{"input": "q1"}, {"input": "q2"}, {"input": "q3"}], task=flaky, criteria=[CRITERION], concurrency=1, quiet=True)
    assert [row["attempts"] for row in result["rows"]] == [3, 1, 3]
    assert "error" not in result["rows"][0] and result["rows"][0]["output"] == "a"
    assert result["rows"][2]["error"] == "model unavailable"
    assert [call.args[0] for call in sleep.call_args_list[:2]] == [0.5, 1.0]
    assert result["summary"]["retried"] == 2 and result["summary"]["task_errors"] == 1 and result["passed"] is False
    outputs = fake.bodies("evals.run")[0]["outputs"]
    assert [(output["attempts"], output.get("output"), output.get("error")) for output in outputs] == [(3, "a", None), (1, "a", None), (3, None, "model unavailable")]


def test_task_timeout_fails_the_call_and_retries_none_when_told_not_to() -> None:
    def slow(value: int) -> int:
        time.sleep(0.5)
        return value

    result = Eval("adder", data=[{"input": 1}], task=slow, criteria=[exact], task_timeout_seconds=0.05, retries=0, dry_run=True, quiet=True)
    assert result["rows"][0]["error"] == "the task took longer than 0.05 s" and result["rows"][0]["attempts"] == 1
    assert result["rows"][0]["verdicts"][0]["status"] == "skipped" and result["passed"] is False


def test_a_call_past_its_timeout_has_its_cancel_event_set_before_it_is_tried_again() -> None:
    events: list[threading.Event] = []

    def task(value: int, context: dict[str, Any]) -> int:
        events.append(context["cancel_event"])
        if len(events) == 1:
            # The first call waits until it is told to stop, as a task that checks its event does.
            assert context["cancel_event"].wait(5)
            raise RuntimeError("stopped")
        assert events[0].is_set(), "the timed-out call was told to stop before its retry started"
        return value

    result = Eval("adder", data=[{"input": 1, "expected": 1}], task=task, criteria=[exact], task_timeout_seconds=0.05, retries=1, dry_run=True, quiet=True)
    assert result["rows"][0]["attempts"] == 2 and result["rows"][0]["output"] == 1 and "error" not in result["rows"][0]
    assert not events[1].is_set(), "each call has its own event"


def test_the_eval_cancel_event_stops_new_cases_tells_the_call_in_flight_and_writes_no_run() -> None:
    fake = FakeControl(graded_run())
    stop = threading.Event()
    started: list[str] = []
    in_flight: list[threading.Event] = []

    def task(question: str, context: dict[str, Any]) -> str:
        started.append(question)
        if question == "q1":
            return "a"
        in_flight.append(context["cancel_event"])
        stop.set()
        context["cancel_event"].wait(5)
        return "late"

    with pytest.raises(CancelledError, match="the eval was cancelled"):
        Eval("support", cloud=cloud_with(fake), data=[{"input": "q1"}, {"input": "q2"}, {"input": "q3"}], task=task, criteria=[CRITERION], concurrency=1, cancel_event=stop, quiet=True)
    assert started == ["q1", "q2"], "q3 never started"
    assert in_flight[0].is_set(), "the call in flight was told to stop"
    assert fake.bodies("evals.run") == [], "a cancelled eval adds no run"


def test_an_eval_cancelled_before_it_starts_makes_no_request_and_runs_no_task() -> None:
    fake = FakeControl(graded_run())
    stop = threading.Event()
    stop.set()
    ran: list[int] = []
    with pytest.raises(CancelledError):
        Eval("support", cloud=cloud_with(fake), data=[{"input": "q1"}], task=lambda value: ran.append(1), criteria=[CRITERION], cancel_event=stop, quiet=True)
    assert ran == [] and fake.calls == []
    with pytest.raises(TypeError, match="threading.Event"):
        Eval("support", data=[{"input": "q1"}], task=lambda value: value, criteria=[exact], cancel_event=True, dry_run=True, quiet=True)  # type: ignore[arg-type]


def test_task_error_fails_the_run_and_skips_local_criteria() -> None:
    def task(value: int) -> int:
        raise RuntimeError("model unavailable")

    result = Eval("adder", data=[{"input": 1}], task=task, criteria=[exact], retries=0, dry_run=True, quiet=True)
    assert result["passed"] is False and result["summary"]["task_errors"] == 1
    assert result["rows"][0]["error"] == "model unavailable"
    assert result["rows"][0]["verdicts"][0]["status"] == "skipped"


def test_a_refused_experiment_stops_before_the_task_runs() -> None:
    handlers = graded_run()
    handlers["evals.create"] = refused(403, "cave_scope_forbidden", "Scope denied.")
    fake = FakeControl(handlers)
    ran: list[Any] = []
    with pytest.raises(CloudError, match="Scope denied") as raised:
        Eval("support", cloud=cloud_with(fake), data=[{"input": "q"}], task=ran.append, criteria=[CRITERION, {"type": "contains", "fragments": ["a"]}], quiet=True)
    assert raised.value.code == "cave_scope_forbidden" and ran == []


def test_upload_failure_saves_what_ran_and_a_later_upload_does_not_run_the_task_again(tmp_path: Any) -> None:
    handlers = graded_run()
    handlers["evals.run"] = refused(503, "cave_unavailable", "Try again.")
    ran: list[str] = []

    def task(question: str) -> str:
        ran.append(question)
        return "a"

    with pytest.raises(EvalUploadError, match="Try again") as raised:
        Eval("support", cloud=cloud_with(FakeControl(handlers)), data=[{"input": "q", "expected": "a"}], task=task, criteria=[CRITERION, exact], quiet=True, results_dir=str(tmp_path))
    error = raised.value
    assert isinstance(error.__cause__, CloudError) and error.__cause__.code == "cave_unavailable"
    assert error.result["rows"][0]["output"] == "a" and error.result["passed"] is None
    assert error.saved_path is not None and error.saved_path.startswith(str(tmp_path)) and error.saved_path in str(error)

    fake = FakeControl(graded_run())
    result = upload_eval_result(error.saved_path, cloud=cloud_with(fake), quiet=True)
    assert ran == ["q"]  # the task ran once, in the first process
    assert [name for name, _ in fake.calls] == ["evals.run", "evals.ingest_evidence", "evals.result", "evals.get_baseline"]
    run = fake.bodies("evals.run")[0]
    assert run["workbench_id"] == "workbench-1" and run["outputs"][0]["output"] == "a" and run["outputs"][0]["trace_id"] == error.result["rows"][0]["trace_id"]
    assert result["passed"] is True and result["upload"]["run_id"] == "run-1"
    assert [(v["criterion"], v["graded_by"]) for v in result["rows"][0]["verdicts"]] == [("exact", "local"), ("Grounded", "caveman")]


def test_a_saved_result_whose_run_started_waits_for_that_run() -> None:
    handlers = graded_run()
    handlers["evals.result"] = refused(502, "cave_unavailable", "Bad gateway.")
    with pytest.raises(EvalUploadError) as raised:
        Eval("support", cloud=cloud_with(FakeControl(handlers)), data=[{"input": "q"}], task=lambda question: "a", criteria=[CRITERION], quiet=True, results_dir=None)
    assert raised.value.saved_path is None and raised.value.result["upload"]["run_id"] == "run-1"

    saved = {"schema_version": 1, "name": "support", "trials": 1, "request_id": "r", "server_criteria": True, "baseline_run_id": None, "budget_usd": None,
             "dataset_id": "dataset-1", "workbench_id": "workbench-1", "result": raised.value.result}
    working = graded_run()
    working["evals.run"] = refused(500, "cave_internal", "a second run must not start")
    fake = FakeControl(working)
    # The fake grades the outputs its evals.run saw; this run started elsewhere.
    fake.handlers["evals.result"] = {"run": {"id": "run-1", "status": "completed", "progress_completed": 1, "progress_total": 1}, "quality": {"status": "passed", "passed": 1, "failed": 0, "cells": 1, "evidence_basis": "external_output_grading"},
                                     "cells": [{"dataset_row_key": "row-1", "trial": 1, "evaluator_results": [{"key": "grounded", "name": "Grounded", "status": "completed", "passed": True}]}]}
    result = upload_eval_result(saved, cloud=cloud_with(fake), quiet=True)
    assert [name for name, _ in fake.calls] == ["evals.result", "evals.get_baseline"]
    assert result["passed"] is True


def test_upload_needs_a_cloud_client() -> None:
    with pytest.raises(ValueError, match="dry_run=True"):
        Eval("support", data=[{"input": "q"}], task=lambda question: "a", criteria=[])


# --- prompts.get(slug) --------------------------------------------------------

PROMPT = {"prompt_id": "44444444-4444-4444-8444-444444444444", "slug": "support-reply", "name": "Support-Reply", "version": 3, "version_id": "v", "environment": "production",
          "system_text": "Be brief.", "user_text": "Answer {{ question }} for {{name}}.", "variables": [], "model_parameters": {"model": "m"}, "tools": [], "resolved_at": "2026-10-08T00:00:00Z"}


def prompt_cloud(responses: list[Any], **options: Any) -> tuple[Cloud, list[str]]:
    cloud = Cloud(control_url="https://control.example", access_token="secret", project_id=PROJECT, **options)
    urls: list[str] = []

    def open_(request: Any, timeout: float) -> Response:
        urls.append(request.full_url)
        response = responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    cloud._opener = type("Opener", (), {"open": staticmethod(open_)})()  # type: ignore[assignment]
    return cloud, urls


def test_prompt_cache_hit_expiry_and_stale_on_error() -> None:
    cloud, urls = prompt_cloud([Response(PROMPT), Response({**PROMPT, "version": 4}), OSError("down")])
    clock = [100.0]
    with patch("caveman_cloud.cloud.time.monotonic", side_effect=lambda: clock[0]):
        first = cloud.prompts.get("Support-Reply")
        assert (first.source, first["version"]) == ("server", 3)
        assert urls == [f"https://control.example/api/v1/projects/{PROJECT}/prompts/resolve?slug=Support-Reply&environment=production"]
        assert cloud.prompts.get("support-reply", environment="production").source == "cache"
        assert len(urls) == 1
        clock[0] += 61
        refreshed = cloud.prompts.get("support-reply")
        assert (refreshed.source, refreshed["version"]) == ("server", 4)
        clock[0] += 61
        stale = cloud.prompts.get("support-reply")
        assert (stale.source, stale["version"]) == ("stale", 4)
    assert len(urls) == 3


def test_prompt_version_is_its_own_cache_entry_and_ttl_is_configurable() -> None:
    cloud, urls = prompt_cloud([Response({**PROMPT, "environment": None}), Response({**PROMPT, "environment": None})], prompt_cache_ttl_seconds=0)
    by_version = cloud.prompts.get("support-reply", version=3)
    assert urls[0].endswith("/prompts/resolve?slug=support-reply&version=3")
    assert by_version.headers() == {"x-cave-tags": f"cave.prompt.id={PROMPT['prompt_id']},cave.prompt.version=3"}
    assert cloud.prompts.get("support-reply", version=3).source == "server"
    with pytest.raises(CloudError) as error:
        cloud.prompts.get("support-reply", version=3, environment="staging")
    assert error.value.code == "cave_input_invalid"


def test_prompt_fallback_then_raise_when_nothing_is_cached() -> None:
    missing = {"error": {"code": "cave_prompt_environment_unset", "message": "Nothing is promoted to staging."}}
    cloud, _ = prompt_cloud([Response(missing, 404), Response(missing, 404)])
    fallback = cloud.prompts.get("support-reply", environment="staging", fallback={"user_text": "Answer {{question}}."})
    assert (fallback.source, fallback.render({"question": "why"})["user_text"], fallback.headers()) == ("fallback", "Answer why.", {})
    with pytest.raises(CloudError) as error:
        cloud.prompts.get("support-reply", environment="staging")
    assert (error.value.code, error.value.status) == ("cave_prompt_environment_unset", 404)


def test_prompt_render_and_header_helper() -> None:
    cloud, _ = prompt_cloud([Response(PROMPT)])
    prompt = cloud.prompts.get("support-reply")
    assert prompt.render({"question": "why", "name": "Ada"}) == {"system_text": "Be brief.", "user_text": "Answer why for Ada."}
    with pytest.raises(CloudError) as error:
        prompt.render({"question": "why"})
    assert error.value.code == "cave_prompt_variable_unmapped"
    assert prompt.headers() == {"x-cave-tags": f"cave.prompt.id={PROMPT['prompt_id']},cave.prompt.version=3,cave.prompt.environment=production"}


def test_prompt_get_by_id_still_calls_the_generated_operation() -> None:
    fake = FakeControl({"prompts.get": {"prompt": {"id": PROMPT["prompt_id"]}, "versions": []}})
    assert cloud_with(fake).prompts.get({"prompt_id": PROMPT["prompt_id"]})["data"]["prompt"]["id"] == PROMPT["prompt_id"]
    assert fake.calls == [("prompts.get", {"prompt_id": PROMPT["prompt_id"]})]


def test_a_task_output_json_cannot_carry_fails_its_row_not_the_upload() -> None:
    result = Eval("adder", data=[{"input": 1}], task=lambda value: {1, 2}, criteria=[exact], retries=0, dry_run=True, quiet=True)
    assert "not JSON" in result["rows"][0]["error"]
    assert result["rows"][0]["output"] is None
