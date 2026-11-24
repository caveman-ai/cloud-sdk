"""Typed Cloud resources over the same authenticated operation contract as CLI/MCP."""
from __future__ import annotations
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from importlib.resources import files
from typing import Any
from .cloud_generated import CloudResources, PromptsResource

_OPERATIONS = json.loads(files(__package__).joinpath("cloud_operations.json").read_text())
_UUID = re.compile(r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$", re.I)
_LIMIT = 16 * 1024 * 1024
# A server that no longer speaks this build's operation contract answers a bare 409: say what to do about it.
_VERSION_CONFLICT = "This caveman-sdk and the Caveman server speak different API versions. Upgrade the SDK (pip install -U caveman-sdk), or install the version that matches a self-hosted server, then run again."

class CloudError(RuntimeError):
    def __init__(self, code: str, message: str, status: int = 0) -> None:
        super().__init__(message)
        self.code, self.status = code, status

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        raise CloudError("cave_redirect_denied", "Cloud redirects are not followed.", code)

_PROMPT_VARIABLE = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")

class ResolvedPrompt(dict[str, Any]):
    """A prompt version as ``GET /prompts/resolve`` returns it, plus where it came from.

    ``source`` is ``"server"`` (just fetched), ``"cache"`` (within the TTL),
    ``"stale"`` (the refresh failed, last good value) or ``"fallback"`` (the caller's own).
    """

    def __init__(self, content: dict[str, Any], source: str) -> None:
        super().__init__({"prompt_id": "", "slug": "", "name": "", "version": 0, "version_id": "", "environment": None, "system_text": "", "user_text": "", "variables": [], "model_parameters": {}, "tools": [], "resolved_at": "", **content})
        self.source = source

    def render(self, variables: dict[str, str] | None = None) -> dict[str, str]:
        """Substitute ``{{name}}`` in both texts; a variable with no value raises ``cave_prompt_variable_unmapped``."""
        values = variables or {}

        def fill(match: re.Match[str]) -> str:
            value = values.get(match.group(1))
            if not isinstance(value, str):
                raise CloudError("cave_prompt_variable_unmapped", f'Prompt variable "{match.group(1)}" has no value.')
            return value

        return {"system_text": _PROMPT_VARIABLE.sub(fill, self["system_text"]), "user_text": _PROMPT_VARIABLE.sub(fill, self["user_text"])}

    def headers(self) -> dict[str, str]:
        """Headers for the model call so the gateway records which prompt version produced it. Empty for a fallback with no id."""
        if not self["prompt_id"]:
            return {}
        tags = [f"cave.prompt.id={self['prompt_id']}", f"cave.prompt.version={self['version']}"]
        if self["environment"]:
            tags.append(f"cave.prompt.environment={self['environment']}")
        return {"x-cave-tags": ",".join(tags)}

class _Prompts(PromptsResource):
    def get(self, input: Any, *, environment: str | None = None, version: int | None = None, fallback: dict[str, Any] | None = None, idempotency_key: str | None = None) -> Any:
        """``get({"prompt_id": ...})`` is the generated read by id; ``get(slug, environment=... | version=...)`` resolves the promoted version, cached."""
        if isinstance(input, str):
            return self._client._resolve_prompt(input, environment, version, fallback)
        return super().get(input, idempotency_key=idempotency_key)

class Cloud(CloudResources):
    prompts: _Prompts  # type: ignore[assignment]

    def __init__(self, *, control_url: str, access_token: str, project_id: str | None = None, timeout_seconds: float = 30, prompt_cache_ttl_seconds: float = 60) -> None:
        url = urllib.parse.urlsplit(control_url)
        if url.username or url.password or url.query or url.fragment or not url.hostname or (url.scheme != "https" and not (url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1"))):
            raise CloudError("cave_endpoint_invalid", "Use HTTPS or loopback HTTP without credentials, query, or fragment.")
        if not access_token.strip():
            raise CloudError("cave_auth_required", "A Cloud access token is required.")
        if project_id is not None and not _UUID.fullmatch(project_id):
            raise CloudError("cave_project_required", "project_id must be a UUID.")
        if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float)) or not 0.1 <= timeout_seconds <= 120:
            raise CloudError("cave_timeout_invalid", "timeout_seconds must be 0.1–120.")
        self.control_url, self.access_token, self.project_id = control_url.rstrip("/"), access_token, project_id
        self.timeout_seconds = timeout_seconds
        self._opener = urllib.request.build_opener(_NoRedirect())
        self._bind_resources()
        self.prompts = _Prompts(self)
        self.prompt_cache_ttl_seconds = prompt_cache_ttl_seconds
        self._prompt_cache: dict[str, tuple[float, dict[str, Any]]] = {}

    def _resolve_prompt(self, slug: str, environment: str | None, version: int | None, fallback: dict[str, Any] | None) -> ResolvedPrompt:
        if not self.project_id:
            raise CloudError("cave_project_required", "Select a project before calling this resource.")
        if environment is not None and version is not None:
            raise CloudError("cave_input_invalid", "Pass environment or version, not both.")
        selector = ("version", str(version)) if version is not None else ("environment", environment or "production")
        key = f"{self.project_id}|{slug.lower()}|{selector[0]}={selector[1]}"
        cached = self._prompt_cache.get(key)
        if cached and cached[0] > time.monotonic():
            return ResolvedPrompt(cached[1], "cache")
        request = urllib.request.Request(f"{self.control_url}/api/v1/projects/{self.project_id}/prompts/resolve?{urllib.parse.urlencode([('slug', slug), selector])}", headers={"authorization": "Bearer " + self.access_token}, method="GET")
        try:
            try:
                response = self._opener.open(request, timeout=self.timeout_seconds)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                status = response.status
                raw = response.read(_LIMIT + 1)
            try:
                body = json.loads(raw)
            except (ValueError, UnicodeError):
                body = None
            if not 200 <= status < 300 or not isinstance(body, dict) or not isinstance(body.get("prompt_id"), str):
                failure = body.get("error") if isinstance(body, dict) else None
                if not isinstance(failure, dict):
                    failure = {}
                raise CloudError(failure.get("code", "cave_request_failed"), failure.get("message", f"Prompt request failed ({status})."), status)
        except (CloudError, OSError):
            if cached:
                return ResolvedPrompt(cached[1], "stale")
            if fallback is not None:
                return ResolvedPrompt(fallback, "fallback")
            raise
        self._prompt_cache[key] = (time.monotonic() + self.prompt_cache_ttl_seconds, body)
        return ResolvedPrompt(body, "server")

    def execute(self, operation: str, input: dict[str, Any], *, idempotency_key: str | None = None) -> dict[str, Any]:
        op = _OPERATIONS.get(operation)
        if op is None:
            raise CloudError("cave_unknown_operation", "Unknown Cloud operation.")
        if op["scope"] == "project" and not self.project_id:
            raise CloudError("cave_project_required", "Select a project before calling this resource.")
        if op["transactional"] and not (idempotency_key and idempotency_key.strip()):
            raise CloudError("cave_idempotency_key_required", "This write requires an idempotency key; reuse it only for identical retries.")
        body = json.dumps(input, allow_nan=False).encode()
        if not isinstance(input, dict) or len(body) > _LIMIT:
            raise CloudError("cave_input_invalid", "Input must be an object of at most 16 MiB.")
        scope = "/projects/" + (self.project_id or "") if op["scope"] == "project" else ""
        headers = {"authorization": "Bearer " + self.access_token, "content-type": "application/json", "x-cave-operation-contract": op["contract"]}
        if idempotency_key:
            headers["idempotency-key"] = idempotency_key
        request = urllib.request.Request(self.control_url + "/api/v1" + scope + "/cloud/operations/" + urllib.parse.quote(operation, safe=""), data=body, headers=headers, method="POST")
        try:
            response = self._opener.open(request, timeout=self.timeout_seconds)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            status = response.status
            raw = response.read(_LIMIT + 1)
        if len(raw) > _LIMIT:
            raise CloudError("cave_result_too_large", "Result exceeds 16 MiB; narrow the query.")
        try:
            result = json.loads(raw)
        except (ValueError, UnicodeError) as error:
            raise CloudError("cave_invalid_response", "Cloud returned invalid JSON.", status) from error
        if not isinstance(result, dict):
            raise CloudError("cave_invalid_response", "Cloud returned an invalid envelope.", status)
        if not 200 <= status < 300:
            failure = result.get("error", result)
            if isinstance(failure, dict):
                failure = failure.get("error", failure)
            if not isinstance(failure, dict):
                failure = {}
            code = failure.get("code", "cave_request_failed")
            raise CloudError(code, _VERSION_CONFLICT if code == "cave_operation_version_conflict" else failure.get("message", f"Cloud request failed ({status})."), status)
        if result.get("schema_version") != 1 or result.get("operation") != operation or result.get("version") != op["version"] or result.get("contract_sha256") != op["contract"] or result.get("ok") is not True or result.get("status") not in ("completed", "accepted") or "data" not in result:
            raise CloudError("cave_operation_version_conflict", _VERSION_CONFLICT, status)
        return result
