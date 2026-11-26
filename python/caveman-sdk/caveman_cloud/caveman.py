"""Unified Caveman Cloud Python SDK client (`Caveman`).

One client, one scoped API key (`CAVEMAN_API_KEY` or `CAVE_TOKEN`), and one
Credits balance across all Caveman Cloud primitives:

- Inference: `inference` (models, multi-provider gateway, route, trim, compact)
- Managed Agents: `agents`, `sessions`, `sandboxes`
- State & Access: `drives`, `connectors`, `secrets` (write-only)
- Multi-Agent Apps: `rooms`, `apps`
- Quality & Control: `evals`, `approvals`, `credits`
"""
from __future__ import annotations

import os
from typing import Any
import urllib.parse

from .agents_generated import Agents
from .cloud import Cloud
from .core import Cave
from .evals import Eval, EvalProjectClient, EvalWorkbenchClient, upload_eval_result
from .gate import Gate
from .platform2027 import Apps, ComputerPools, PlatformError, Rooms, _PlatformTransport
from .sandboxes import Sandboxes

DEFAULT_GATEWAY_URL = "https://gateway.caveman.so"
DEFAULT_CONTROL_URL = "https://api.caveman.so"


class InferenceClient:
    """Unified inference gateway client (models, generations, provider clients, route/trim/compact)."""

    def __init__(
        self,
        *,
        base_url: str,
        control_url: str,
        api_key: str,
        agent: str = "default",
        timeout_seconds: float = 30.0,
        retries: int = 2,
        retry_delay_seconds: float = 0.25,
    ) -> None:
        self._tx = _PlatformTransport(
            control_url=base_url,
            api_key=api_key,
            timeout_seconds=timeout_seconds,
            retries=retries,
            retry_delay_seconds=retry_delay_seconds,
        )
        self.gateway = Cave(
            api_key=api_key,
            base_url=base_url,
            control_url=control_url,
            agent=agent,
        )

    def models(self) -> list[dict[str, Any]]:
        """List models available through the unified inference gateway (`GET /v1/models`)."""
        res = self._tx.request("GET", "/v1/models")
        return list(res.get("data") or [])

    def generation(self, generation_id: str) -> dict[str, Any]:
        """Fetch per-attempt routing and cost metadata for a generation (`GET /v1/generations/{id}`)."""
        return self._tx.request("GET", f"/v1/generations/{urllib.parse.quote(generation_id, safe='')}")

    def route(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.gateway.route(payload)

    def trim(self, text: str, query: str, **kwargs: Any) -> Any:
        return self.gateway.trim(text, query, **kwargs)

    def compact(self, messages: list[dict[str, Any]], *, budget_tokens: int) -> Any:
        return self.gateway.compact(messages, budget_tokens=budget_tokens)

    def compress(self, text: str, **kwargs: Any) -> Any:
        return self.gateway.compress(text, **kwargs)


class ManagedAgentsClient:
    """Managed Agents and immutable Deployments."""

    def __init__(self, raw: Agents) -> None:
        self._raw = raw

    def create(self, payload: dict[str, Any]) -> Any:
        return self._raw.create_agent(payload)

    def list(self, *, archived: bool | None = None) -> list[Any]:
        res = self._raw.list_agents(archived=archived)
        return list(res.get("agents") or [])

    def get(self, agent_id: str) -> Any:
        return self._raw.get_agent(agent_id)

    def update(self, agent_id: str, payload: dict[str, Any]) -> Any:
        return self._raw.update_agent(agent_id, payload)

    def versions(self, agent_id: str) -> list[Any]:
        res = self._raw.list_agent_versions(agent_id)
        return list(res.get("versions") or [])

    def archive(self, agent_id: str) -> Any:
        return self._raw.archive_agent(agent_id)

    def deploy(self, payload: dict[str, Any]) -> Any:
        return self._raw.deploy(payload)

    def list_deployments(self, *, archived: bool | None = None) -> list[Any]:
        res = self._raw.list_deployments(archived=archived)
        return list(res.get("deployments") or [])

    def get_deployment(self, deployment: str) -> Any:
        return self._raw.get_deployment(deployment)

    def revisions(self, deployment: str) -> list[Any]:
        res = self._raw.list_deployment_revisions(deployment)
        return list(res.get("revisions") or [])

    def rollback(self, deployment: str, *, revision: int) -> Any:
        return self._raw.rollback_deployment(deployment, {"revision": revision})

    def pause(self, deployment: str) -> Any:
        return self._raw.pause_deployment(deployment, {})

    def resume(self, deployment: str) -> Any:
        return self._raw.resume_deployment(deployment, {})

    def archive_deployment(self, deployment: str) -> Any:
        return self._raw.archive_deployment(deployment, {})

    def run(self, deployment: str, payload: dict[str, Any]) -> Any:
        """Start a durable session against a named live deployment."""
        return self._raw.start_deployment_session(deployment, payload)


class SessionsClient:
    """Durable agent execution sessions."""

    def __init__(self, raw: Agents) -> None:
        self._raw = raw

    def start(self, payload: dict[str, Any]) -> Any:
        return self._raw.start_session(payload)

    def list(self, **query: Any) -> list[Any]:
        res = self._raw.list_sessions(**query)
        return list(res.get("sessions") or [])

    def get(self, session_id: str) -> Any:
        return self._raw.get_session(session_id)

    def send(self, session_id: str, payload: dict[str, Any]) -> Any:
        return self._raw.send_event(session_id, payload)

    def events(self, session_id: str, **query: Any) -> Any:
        return self._raw.list_events(session_id, **query)

    def stream(self, session_id: str, **kwargs: Any) -> Any:
        return self._raw.stream_events(session_id, **kwargs)

    def approve(self, session_id: str, ask_id: str, request_id: str, message: str | None = None) -> Any:
        body: dict[str, Any] = {
            "request_id": request_id,
            "type": "user.approval",
            "ask_id": ask_id,
            "decision": "allow",
        }
        if message is not None:
            body["message"] = message
        return self._raw.send_event(session_id, body)

    def deny(self, session_id: str, ask_id: str, request_id: str, message: str | None = None) -> Any:
        body: dict[str, Any] = {
            "request_id": request_id,
            "type": "user.approval",
            "ask_id": ask_id,
            "decision": "deny",
        }
        if message is not None:
            body["message"] = message
        return self._raw.send_event(session_id, body)


class DriveHandle:
    """Fluent handle bound to one Caveman Drive (by name or UUID)."""

    def __init__(self, raw: Agents, drive_id: str) -> None:
        self._raw = raw
        self.id = drive_id

    def get(self) -> Any:
        return self._raw.get_drive(self.id)

    def update(self, payload: dict[str, Any]) -> Any:
        return self._raw.update_drive(self.id, payload)

    def archive(self) -> Any:
        return self._raw.archive_drive(self.id)

    def unarchive(self) -> Any:
        return self._raw.unarchive_drive(self.id)

    def files(self, **query: Any) -> Any:
        return self._raw.list_drive_files(self.id, **query)

    def read(self, payload: dict[str, Any]) -> Any:
        return self._raw.read_drive_text(self.id, payload)

    def write(self, payload: dict[str, Any]) -> Any:
        return self._raw.write_drive_text(self.id, payload)

    def edit(self, payload: dict[str, Any]) -> Any:
        return self._raw.edit_drive_file(self.id, payload)

    def append(self, payload: dict[str, Any]) -> Any:
        return self._raw.append_drive_file(self.id, payload)

    def move(self, payload: dict[str, Any]) -> Any:
        return self._raw.move_drive_file(self.id, payload)

    def delete(self, payload: dict[str, Any]) -> Any:
        return self._raw.delete_drive_file(self.id, payload)

    def history(self, **query: Any) -> Any:
        return self._raw.list_drive_file_versions(self.id, **query)

    def verify(self) -> Any:
        return self._raw.verify_drive(self.id)

    def grep(self, payload: dict[str, Any]) -> Any:
        return self._raw.grep_drive(self.id, payload)

    def changes(self, **query: Any) -> Any:
        return self._raw.list_drive_changes(self.id, **query)

    def restore(self, payload: dict[str, Any]) -> Any:
        return self._raw.restore_drive(self.id, payload)

    def fork(self, payload: dict[str, Any]) -> Any:
        return self._raw.fork_drive(self.id, payload)

    def merge(self, payload: dict[str, Any] | None = None) -> Any:
        return self._raw.merge_drive(self.id, payload or {})

    def diff(self, **query: Any) -> Any:
        return self._raw.diff_drive(self.id, **query)

    def changesets(self, **query: Any) -> Any:
        return self._raw.list_drive_changesets(self.id, **query)

    def get_changeset(self, changeset_id: str) -> Any:
        return self._raw.get_drive_changeset(self.id, changeset_id)

    def approve_changeset(self, changeset_id: str, payload: dict[str, Any]) -> Any:
        return self._raw.approve_drive_changeset(self.id, changeset_id, payload)

    def reject_changeset(self, changeset_id: str) -> Any:
        return self._raw.reject_drive_changeset(self.id, changeset_id)

    def undo_session(self, session_id: str) -> Any:
        return self._raw.undo_drive_session(self.id, {"session_id": session_id})

    def share(self, payload: dict[str, Any]) -> Any:
        return self._raw.share_drive(self.id, payload)

    def grants(self) -> list[Any]:
        res = self._raw.list_drive_grants(self.id)
        return list(res.get("grants") or [])

    def grant(self, payload: dict[str, Any]) -> Any:
        return self._raw.grant_drive(self.id, payload)

    def revoke_grant(self, grant_id: str) -> Any:
        return self._raw.revoke_drive_grant(self.id, grant_id)


class DrivesClient:
    """First-class client for Caveman Drives (durable versioned storage)."""

    def __init__(self, raw: Agents) -> None:
        self._raw = raw

    def create(self, payload: dict[str, Any]) -> Any:
        return self._raw.create_drive(payload)

    def list(self) -> list[Any]:
        res = self._raw.list_drives()
        return list(res.get("drives") or [])

    def get(self, drive_id: str) -> Any:
        return self._raw.get_drive(drive_id)

    def usage(self) -> Any:
        return self._raw.get_drive_usage()

    def drive(self, drive_id: str) -> DriveHandle:
        return DriveHandle(self._raw, drive_id)


class ConnectorsClient:
    """First-class client for team-authenticated SaaS and MCP connectors."""

    def __init__(self, tx: _PlatformTransport) -> None:
        self._tx = tx

    def list(self) -> list[dict[str, Any]]:
        res = self._tx.request("GET", "/api/v1/code/connectors")
        return list(res.get("connectors") or [])

    def get(self, connector: str) -> dict[str, Any]:
        return self._tx.request("GET", f"/api/v1/code/connectors/{urllib.parse.quote(connector, safe='')}")

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._tx.request("POST", "/api/v1/code/connectors", payload)

    def accept(self, connector: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._tx.request("POST", f"/api/v1/code/connectors/{urllib.parse.quote(connector, safe='')}/accept", payload or {})

    def pause(self, connector: str, *, reason: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if reason is not None:
            body["reason"] = reason
        return self._tx.request("POST", f"/api/v1/code/connectors/{urllib.parse.quote(connector, safe='')}/pause", body)

    def resume(self, connector: str) -> dict[str, Any]:
        return self._tx.request("POST", f"/api/v1/code/connectors/{urllib.parse.quote(connector, safe='')}/resume", {})

    def remove(self, connector: str) -> dict[str, Any]:
        return self._tx.request("POST", f"/api/v1/code/connectors/{urllib.parse.quote(connector, safe='')}/remove", {})

    def list_grants(self, connector: str) -> dict[str, Any]:
        return self._tx.request("GET", f"/api/v1/code/connectors/{urllib.parse.quote(connector, safe='')}/grants")

    def grant(self, connector: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._tx.request("POST", f"/api/v1/code/connectors/{urllib.parse.quote(connector, safe='')}/grants", payload)

    def revoke_grant(self, connector: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._tx.request("POST", f"/api/v1/code/connectors/{urllib.parse.quote(connector, safe='')}/grants/revoke", payload)


class SecretsClient:
    """First-class write-only Secrets client (values are never returned)."""

    def __init__(self, tx: _PlatformTransport) -> None:
        self._tx = tx

    def list(self) -> list[dict[str, Any]]:
        res = self._tx.request("GET", "/api/v1/code/secrets")
        return list(res.get("secrets") or [])

    def set(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._tx.request("PUT", "/api/v1/code/secrets", payload)

    def delete(self, name: str) -> dict[str, Any]:
        return self._tx.request("DELETE", f"/api/v1/code/secrets/{urllib.parse.quote(name, safe='')}")

    def list_org(self) -> list[dict[str, Any]]:
        res = self._tx.request("GET", "/api/v1/code/org-secrets")
        return list(res.get("secrets") or [])

    def create_org(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._tx.request("POST", "/api/v1/code/org-secrets", payload)

    def update_org(self, secret_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._tx.request("PATCH", f"/api/v1/code/org-secrets/{urllib.parse.quote(secret_id, safe='')}", payload)

    def delete_org(self, secret_id: str) -> dict[str, Any]:
        return self._tx.request("DELETE", f"/api/v1/code/org-secrets/{urllib.parse.quote(secret_id, safe='')}")


class CreditsClient:
    """Unified organization Credits balance."""

    def __init__(self, tx: _PlatformTransport) -> None:
        self._tx = tx

    def get(self) -> dict[str, Any]:
        return self._tx.request("GET", "/api/v1/credits")

    def models(self) -> dict[str, Any]:
        return self._tx.request("GET", "/api/v1/code/credits/models")


class EvalsClient:
    """Datasets, scorers, experiments, and CI eval gates."""

    Eval = Eval
    upload_result = staticmethod(upload_eval_result)

    def __init__(self, *, control_url: str, api_key: str, project_id: str | None, timeout_seconds: float) -> None:
        self._control_url = control_url
        self._api_key = api_key
        self._project_id = project_id
        self._timeout_seconds = timeout_seconds

    def workbench(self, workbench_id: str, project_id: str | None = None) -> EvalWorkbenchClient:
        pid = project_id or self._project_id
        if not pid:
            raise PlatformError("cave_project_required", "project_id is required for eval workbenches.", 0)
        return EvalWorkbenchClient(
            control_url=self._control_url,
            access_token=self._api_key,
            project_id=pid,
            workbench_id=workbench_id,
            timeout_seconds=self._timeout_seconds,
        )

    def project(self, project_id: str | None = None) -> EvalProjectClient:
        pid = project_id or self._project_id
        if not pid:
            raise PlatformError("cave_project_required", "project_id is required for eval project operations.", 0)
        return EvalProjectClient(
            control_url=self._control_url,
            access_token=self._api_key,
            project_id=pid,
            timeout_seconds=self._timeout_seconds,
        )


class Caveman:
    """Unified Caveman Cloud client.

    Reads ``CAVEMAN_API_KEY`` (or ``CAVE_TOKEN``) from the environment when
    ``api_key`` is omitted.
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        control_url: str | None = None,
        relay_url: str | None = None,
        project_id: str | None = None,
        agent: str = "default",
        timeout_seconds: float = 30.0,
        retries: int = 2,
        retry_delay_seconds: float = 0.25,
    ) -> None:
        resolved_key = (api_key or os.environ.get("CAVEMAN_API_KEY") or os.environ.get("CAVE_TOKEN") or "").strip()
        if not resolved_key:
            raise PlatformError("cave_auth_required", "api_key is required (pass api_key= or set CAVEMAN_API_KEY).", 0)
        resolved_gateway = (base_url or os.environ.get("CAVEMAN_GATEWAY_URL") or DEFAULT_GATEWAY_URL).rstrip("/")
        resolved_control = (control_url or os.environ.get("CAVEMAN_API_URL") or DEFAULT_CONTROL_URL).rstrip("/")

        tx = _PlatformTransport(
            control_url=resolved_control,
            api_key=resolved_key,
            timeout_seconds=timeout_seconds,
            retries=retries,
            retry_delay_seconds=retry_delay_seconds,
        )
        raw_agents = Agents(control_url=resolved_control, api_key=resolved_key, timeout_seconds=timeout_seconds)

        self.inference = InferenceClient(
            base_url=resolved_gateway,
            control_url=resolved_control,
            api_key=resolved_key,
            agent=agent,
            timeout_seconds=timeout_seconds,
            retries=retries,
            retry_delay_seconds=retry_delay_seconds,
        )
        self.agents = ManagedAgentsClient(raw_agents)
        self.sessions = SessionsClient(raw_agents)
        self.sandboxes = Sandboxes(
            control_url=resolved_control,
            api_key=resolved_key,
            relay_url=relay_url,
            timeout_seconds=timeout_seconds,
            retries=retries,
            retry_delay_seconds=retry_delay_seconds,
        )
        self.pools = ComputerPools(
            control_url=resolved_control,
            api_key=resolved_key,
            timeout_seconds=timeout_seconds,
            retries=retries,
            retry_delay_seconds=retry_delay_seconds,
        )
        self.drives = DrivesClient(raw_agents)
        self.connectors = ConnectorsClient(tx)
        self.secrets = SecretsClient(tx)
        self.rooms = Rooms(
            control_url=resolved_control,
            api_key=resolved_key,
            timeout_seconds=timeout_seconds,
            retries=retries,
            retry_delay_seconds=retry_delay_seconds,
        )
        self.apps = Apps(
            control_url=resolved_control,
            api_key=resolved_key,
            timeout_seconds=timeout_seconds,
            retries=retries,
            retry_delay_seconds=retry_delay_seconds,
        )
        self.evals = EvalsClient(
            control_url=resolved_control,
            api_key=resolved_key,
            project_id=project_id,
            timeout_seconds=timeout_seconds,
        )
        self.approvals = Gate(
            control_url=resolved_control,
            api_key=resolved_key,
            project_id=project_id,
            timeout_seconds=timeout_seconds,
            retries=retries,
            retry_delay_seconds=retry_delay_seconds,
        )
        self.credits = CreditsClient(tx)
        self.cloud = Cloud(
            control_url=resolved_control,
            access_token=resolved_key,
            project_id=project_id,
            timeout_seconds=timeout_seconds,
        )
