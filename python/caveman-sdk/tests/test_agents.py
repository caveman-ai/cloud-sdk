import io
import json
from unittest.mock import patch

import pytest

from caveman_cloud import Agents, CloudError


class Response(io.BytesIO):
    def __init__(self, body, status=200):
        super().__init__(body if isinstance(body, bytes) else json.dumps(body).encode())
        self.status = status


def test_agents_api_sends_key_route_and_body():
    agents = Agents(control_url="https://control.example/", api_key="cave_live_x")
    session = {"id": "s1", "workspace_id": "w1", "origin": "api", "status": "starting"}
    with patch.object(agents._opener, "open", return_value=Response(session, 201)) as request:
        assert agents.start_session({"request_id": "r1", "repo": "acme/api", "task": "Fix it"})["id"] == "s1"
        sent = request.call_args.args[0]
        assert sent.full_url == "https://control.example/api/v1/code/sessions"
        assert sent.get_method() == "POST"
        assert sent.headers["Authorization"] == "Bearer cave_live_x"
        assert json.loads(sent.data) == {"request_id": "r1", "repo": "acme/api", "task": "Fix it"}
    with patch.object(agents._opener, "open", return_value=Response({"events": []})) as request:
        agents.list_events("s 1", after=2)
        assert request.call_args.args[0].full_url == "https://control.example/api/v1/code/sessions/s%201/events?after=2"
    with patch.object(agents._opener, "open", return_value=Response({"error": {"code": "cave_not_found", "message": "Session not found."}}, 404)):
        with pytest.raises(CloudError) as error:
            agents.get_session("gone")
        assert error.value.code == "cave_not_found" and error.value.status == 404


def test_session_stream_yields_events_in_order_and_surfaces_errors():
    agents = Agents(control_url="http://127.0.0.1:8080", api_key="cave_live_x")
    frames = b': caveman session events\n\nid: 1\nevent: session.status\ndata: {"status":"running"}\n\nid: 2\nevent: agent.message\ndata: {"text":"Looking."}\n\n'
    with patch.object(agents._opener, "open", return_value=Response(frames)) as request:
        got = list(agents.stream_events("s1", after=0))
        assert request.call_args.args[0].full_url == "http://127.0.0.1:8080/api/v1/code/sessions/s1/events/stream?after=0"
    assert got == [{"seq": 1, "type": "session.status", "data": {"status": "running"}}, {"seq": 2, "type": "agent.message", "data": {"text": "Looking."}}]
    with patch.object(agents._opener, "open", return_value=Response(b'event: error\ndata: {"code":"cave_unauthorized"}\n\n')):
        with pytest.raises(CloudError) as error:
            list(agents.stream_events("s1"))
        assert error.value.code == "cave_unauthorized"
    with pytest.raises(CloudError):
        Agents(control_url="http://control.example", api_key="k")


def test_files_upload_as_multipart_download_as_bytes_and_memories_read_by_path():
    agents = Agents(control_url="https://control.example", api_key="cave_live_x")
    file = {"id": "f1", "name": "notes.txt", "media_type": "text/plain", "size_bytes": 5, "sha256": "x", "purpose": "input"}
    with patch.object(agents._opener, "open", return_value=Response(file, 201)) as request:
        assert agents.upload_file('no"tes.txt', b"hello", media_type="text/plain")["id"] == "f1"
        sent = request.call_args.args[0]
        boundary = sent.headers["Content-type"].split("boundary=")[1]
        assert sent.full_url == "https://control.example/api/v1/code/files" and sent.get_method() == "POST"
        assert sent.data == (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="no_tes.txt"\r\n'
                             f"Content-Type: text/plain\r\n\r\nhello\r\n--{boundary}--\r\n").encode()
    with pytest.raises(CloudError) as error:
        agents.upload_file("a.txt", b"x", media_type="text/plain\r\nX-Injected: 1")
    assert error.value.code == "cave_media_type_invalid"
    with patch.object(agents._opener, "open", return_value=Response(b"\x01\x02\x03")) as request:
        assert agents.download_file("f 1") == b"\x01\x02\x03"
        assert request.call_args.args[0].full_url == "https://control.example/api/v1/code/files/f%201/content"
    with patch.object(agents._opener, "open", return_value=Response({"path": "a/b.md", "content": "hi"})) as request:
        assert agents.get_memory("m1", path="a/b.md")["content"] == "hi"
        assert request.call_args.args[0].full_url == "https://control.example/api/v1/code/memory-stores/m1/memories?path=a%2Fb.md"
    with patch.object(agents._opener, "open", return_value=Response(b"", 204)):
        assert agents.delete_file("f1") == {}
