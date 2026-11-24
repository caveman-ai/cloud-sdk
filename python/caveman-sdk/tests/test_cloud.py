import io
import json
from unittest.mock import patch

import pytest

from caveman_cloud import Cloud, CloudError
from caveman_cloud.cloud import _OPERATIONS

PROJECT = "11111111-1111-4111-8111-111111111111"


class Response(io.BytesIO):
    def __init__(self, body, status=200):
        super().__init__(json.dumps(body).encode())
        self.status = status


def envelope(operation, data=None):
    meta = _OPERATIONS[operation]
    return {"schema_version": 1, "operation": operation, "version": meta["version"], "contract_sha256": meta["contract"], "ok": True, "status": "completed", "data": data or {}}


def test_resource_preserves_scope_contract_retry_identity():
    cloud = Cloud(control_url="https://control.example", access_token="secret", project_id=PROJECT)
    with patch.object(cloud._opener, "open", return_value=Response(envelope("datasets.create", {"id": "saved"}))) as request:
        with pytest.raises(CloudError) as error:
            cloud.datasets.create({"name": "Cases", "document": {}})
        assert error.value.code == "cave_idempotency_key_required"
        request.assert_not_called()
        result = cloud.datasets.create({"name": "Cases", "document": {}}, idempotency_key="same-request")
        assert result["data"]["id"] == "saved"
        sent = request.call_args.args[0]
        assert sent.full_url == f"https://control.example/api/v1/projects/{PROJECT}/cloud/operations/datasets.create"
        assert sent.get_header("Authorization") == "Bearer secret"
        assert sent.get_header("Idempotency-key") == "same-request"
        assert sent.get_header("X-cave-operation-contract") == _OPERATIONS["datasets.create"]["contract"]
        assert request.call_count == 1


def test_mismatched_response_and_scope_denial_never_retry():
    cloud = Cloud(control_url="https://control.example", access_token="secret", project_id=PROJECT)
    responses = [Response(envelope("prompts.list")), Response({"error": {"error": {"code": "cave_scope_forbidden", "message": "Scope denied."}}}, 403),
                 Response({"error": {"code": "cave_operation_version_conflict", "message": "Installed operation contract differs from server; refresh client discovery."}}, 409)]
    with patch.object(cloud._opener, "open", side_effect=responses) as request:
        with pytest.raises(CloudError) as error:
            cloud.datasets.list()
        assert error.value.code == "cave_operation_version_conflict"
        # One plain line: what is wrong and how to fix it.
        upgrade = "This caveman-sdk and the Caveman server speak different API versions. Upgrade the SDK (pip install -U caveman-sdk), or install the version that matches a self-hosted server, then run again."
        assert str(error.value) == upgrade
        with pytest.raises(CloudError) as error:
            cloud.datasets.list()
        assert (error.value.code, error.value.status) == ("cave_scope_forbidden", 403)
        # A server built after a contract change refuses an older SDK with a bare 409: the SDK says the same line.
        with pytest.raises(CloudError) as error:
            cloud.datasets.list()
        assert (error.value.code, error.value.status, str(error.value)) == ("cave_operation_version_conflict", 409, upgrade)
        assert request.call_count == 3


def test_missing_project_and_remote_plaintext_are_rejected():
    with pytest.raises(CloudError):
        Cloud(control_url="http://remote.example", access_token="secret")
    cloud = Cloud(control_url="https://control.example", access_token="secret")
    with patch.object(cloud._opener, "open") as request, pytest.raises(CloudError) as error:
        cloud.prompts.list()
    assert error.value.code == "cave_project_required"
    request.assert_not_called()
