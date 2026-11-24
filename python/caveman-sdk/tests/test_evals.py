from __future__ import annotations

import io
import json
import urllib.error
from email.message import Message
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from caveman_cloud import EvalControlError, EvalProjectClient, EvalWorkbenchClient


def _response(body: dict[str, Any]) -> MagicMock:
    context = MagicMock()
    context.__enter__ = MagicMock(return_value=MagicMock(read=MagicMock(return_value=json.dumps(body).encode())))
    context.__exit__ = MagicMock(return_value=False)
    return context


def test_eval_client_runs_and_waits_on_same_persisted_control_run() -> None:
    captured: list[tuple[str, str, dict[str, str], dict[str, Any] | None]] = []
    responses = iter([
        _response({"run": {"id": "run-1", "status": "queued"}, "cells": []}),
        _response({"run": {"id": "run-1", "status": "completed"}, "cells": [{"id": "cell-1"}]}),
    ])

    def fake_urlopen(request: Any, timeout: int) -> MagicMock:  # noqa: ANN401
        captured.append((request.full_url, request.get_method(), dict(request.headers), json.loads(request.data) if request.data else None))
        assert timeout == 30
        return next(responses)

    client = EvalWorkbenchClient(
        access_token="access-token",
        control_url="https://control.example/",
        project_id="project-1",
        workbench_id="workbench-1",
    )
    with patch("caveman_cloud.evals._OPENER.open", side_effect=fake_urlopen):
        result = client.run_and_wait(scope={"kind": "target", "target_key": "candidate"}, concurrency=2, poll_seconds=0.001)

    assert result["run"]["status"] == "completed"
    assert len(result["cells"]) == 1
    assert captured[0][0] == "https://control.example/api/v1/projects/project-1/eval-workbenches/workbench-1/runs"
    assert captured[0][1] == "POST"
    assert captured[0][2]["Authorization"] == "Bearer access-token"
    assert captured[0][2]["X-cave-csrf"] == "sdk"
    assert captured[0][3] == {"scope": {"kind": "target", "target_key": "candidate"}, "concurrency": 2}
    assert captured[1][0].endswith("/runs/run-1")
    assert captured[1][1] == "GET"


def test_eval_client_preserves_structured_control_errors() -> None:
    body = json.dumps({"error": {"code": "cave_scope_forbidden", "message": "Connection scope lacks required permission."}}).encode()
    error = urllib.error.HTTPError("https://control.example", 403, "Forbidden", Message(), io.BytesIO(body))
    client = EvalWorkbenchClient(access_token="access-token", control_url="https://control.example", project_id="project-1", workbench_id="workbench-1")
    with patch("caveman_cloud.evals._OPENER.open", side_effect=error), pytest.raises(EvalControlError) as raised:
        client.run()
    assert raised.value.status == 403
    assert raised.value.code == "cave_scope_forbidden"
    assert str(raised.value) == "Connection scope lacks required permission."


def test_eval_client_rejects_invalid_concurrency_before_network() -> None:
    client = EvalWorkbenchClient(access_token="access-token", control_url="https://control.example", project_id="project-1", workbench_id="workbench-1")
    with patch("caveman_cloud.evals._OPENER.open") as request, pytest.raises(ValueError, match="concurrency must be an integer from 1 to 24"):
        client.run(concurrency=25)
    request.assert_not_called()


def test_project_client_authors_same_versioned_experiment_shape_used_by_ui() -> None:
    captured: list[tuple[str, str, dict[str, Any]]] = []
    responses = iter([
        _response({"id": "dataset-1", "name": "Cases"}),
        _response({"id": "workbench-1", "name": "Quality"}),
    ])

    def fake_urlopen(request: Any, timeout: int) -> MagicMock:  # noqa: ANN401
        assert timeout == 30
        captured.append((request.full_url, request.get_method(), json.loads(request.data)))
        return next(responses)

    project = EvalProjectClient(access_token="access-token", control_url="https://control.example", project_id="project-1")
    with patch("caveman_cloud.evals._OPENER.open", side_effect=fake_urlopen):
        experiment = project.create_experiment(
            name="Quality",
            dataset_key="regression",
            dataset={
                "name": "Cases",
                "document": {"schema_version": 1, "columns": [{"key": "input", "name": "Input", "type": "string", "role": "input"}], "rows": [{"row_key": "one", "values": {"input": "hello"}}]},
            },
            document={
                "schema_version": 1,
                "targets": [{"key": "candidate", "name": "Candidate", "kind": "http", "input_mapping": {"input": "input"}, "config": {"endpoint": "https://agent.example/run", "method": "POST", "authentication": {"type": "none"}}}],
                "evaluators": [{"key": "safe", "name": "No PII", "source": "inline", "grader_type": "no_pii", "options": {}, "input_mapping": {"candidate": {"source": "target", "key": "$target"}}}],
                "settings": {"concurrency": 4, "row_height": "compact", "judge_order": "randomized"},
            },
        )

    assert experiment["dataset"]["id"] == "dataset-1"
    assert experiment["workbench"]["id"] == "workbench-1"
    assert isinstance(experiment["runs"], EvalWorkbenchClient)
    assert captured[0][0] == "https://control.example/api/v1/projects/project-1/eval-datasets"
    assert captured[1][0] == "https://control.example/api/v1/projects/project-1/eval-workbenches"
    assert captured[1][2]["document"]["active_dataset_key"] == "regression"
    assert captured[1][2]["document"]["datasets"] == [{"key": "regression", "dataset_id": "dataset-1"}]


def test_wait_returns_error_and_rejects_unknown_without_repolling() -> None:
    client = EvalWorkbenchClient(access_token="token", control_url="https://control.example", project_id="project", workbench_id="bench")
    for status in ("error", "unknown"):
        with patch("caveman_cloud.evals._OPENER.open", return_value=_response({"run": {"id": "run", "status": status}, "cells": []})) as request:
            if status == "error":
                assert client.wait("run")["run"]["status"] == "error"
            else:
                with pytest.raises(ValueError, match="eval_unknown_status"):
                    client.wait("run")
            assert request.call_count == 1


def test_takes_context_ignores_a_defaulted_setting() -> None:
    from caveman_cloud.evals import _takes_context

    assert _takes_context(lambda value, context: None)
    assert _takes_context(lambda value, context=None: None)
    assert not _takes_context(lambda value, temperature=0.2: None)
    assert not _takes_context(lambda value: None)
