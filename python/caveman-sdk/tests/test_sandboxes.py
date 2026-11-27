import base64
import io
import json
import socket
import threading
import time
import urllib.parse
from typing import Any

import pytest
from sandbox_fake import KEY, WIRE, Fake, answer

from caveman_cloud import CloudError, ExecResult, SandboxCommand, SandboxError, SandboxExecError, SandboxFileError, SandboxPortURL, SandboxRefusal, Sandboxes, SandboxStateError, SnapshotStateError
from caveman_cloud.sandboxes_generated import SANDBOX_ERROR_CODES

ID = WIRE["rest"]["create"]["answer"]["id"]
# The sandbox the lab took its snapshot of, and the snapshot.
SNAP = WIRE["rest"]["snapshot"]["answer"]
BOX, SID = SNAP["computer_id"], SNAP["id"]


@pytest.fixture
def fake():
    f = Fake()
    yield f
    f.close()


def client(url):
    s = Sandboxes(control_url=url, api_key=KEY, retry_delay_seconds=0)
    s._sleep = lambda _: None
    return s


def test_plain_calls_send_the_key_route_and_body_and_read_the_recorded_answers(fake):
    sandboxes = client(fake.url)
    made = sandboxes.create({"name": "wire", "sleep_after_seconds": 0})
    assert made["id"] == ID and made["bare"] is True and made["sleep_after_seconds"] == 0
    # A create answers its idle pause too: none asked, never (0).
    assert made.get("idle") == {"pause_after_seconds": 0}
    got = sandboxes.get(ID)
    assert got["observed_state"] == "running"
    # Get answers the sandbox's idle pause as its create did; a create that asked no lifetime or network answers neither.
    assert got.get("idle") == {"pause_after_seconds": 0} and "expires_at" not in made and "network" not in made
    listed = sandboxes.list()
    assert listed["cloud_computers"] is True and [c["id"] for c in listed["computers"]] == [ID]
    assert len(sandboxes.list(mine=True)["computers"]) == 1
    assert sandboxes.sleep(ID)["desired_state"] == "suspended"
    assert sandboxes.resume(ID)["desired_state"] == "running"
    assert sandboxes.delete(ID)["desired_state"] == "deleted"
    # A delete asked again answers the deleted sandbox, as the first did.
    assert sandboxes.delete(ID)["desired_state"] == "deleted"
    for call, code, status in [
        (lambda: sandboxes.get(WIRE["rest"]["get_unknown"]["path"].rsplit("/", 1)[1]), "cave_not_found", 404),
        (lambda: sandboxes.create({"size": "huge"}), "cave_bad_request", 400),
        (lambda: sandboxes.create({"image": "ubuntu"}), "cave_bad_request", 400),  # type: ignore[typeddict-unknown-key]
    ]:
        with pytest.raises(SandboxError) as error:
            call()
        assert isinstance(error.value, CloudError)
        assert (error.value.code, error.value.status) == (code, status) and error.value.request_id and not error.value.limit_reached
    assert "cave_not_found" in SANDBOX_ERROR_CODES
    # An unknown field's refusal names every field the body takes, idle among them.
    with pytest.raises(SandboxError) as unknown:
        sandboxes.create({"image": "ubuntu"})  # type: ignore[typeddict-unknown-key]
    assert str(unknown.value) == "The body is size, name, sleep_after_seconds, idle, lifetime_seconds and network, and nothing else."
    assert fake.errors == []
    assert fake.seen[:2] == [("POST", "/api/v1/code/computers", "Bearer " + KEY), ("GET", f"/api/v1/code/computers/{ID}", "Bearer " + KEY)]


def test_snapshot_calls_send_the_key_route_and_body_and_read_the_recorded_answers(fake):
    sandboxes = client(fake.url)
    taken = sandboxes.snapshot(BOX, {"name": "wire"})
    assert (taken["id"], taken["computer_id"], taken["state"], taken["name"]) == (SID, BOX, "taking", "wire")
    assert taken["reason_code"] is None and taken["restore"]["state"] == "none"
    ready = sandboxes.get_snapshot(BOX, SID)
    assert ready["state"] == "ready" and ready["ready_at"]
    assert [s["id"] for s in sandboxes.list_snapshots(BOX)["snapshots"]] == [SID]
    restoring = sandboxes.restore(BOX, SID)
    assert restoring["restore"]["state"] == "restoring" and restoring["restore"]["asked_at"]
    assert sandboxes.get_snapshot(BOX, SID)["restore"]["state"] == "restored"
    child = sandboxes.fork(BOX, SID, {"name": "wire-fork", "sleep_after_seconds": 0})
    assert child["bare"] is True and child["id"] not in (BOX, SID) and child["name"] == "wire-fork"
    assert sandboxes.delete_snapshot(BOX, SID)["state"] == "deleting"
    # A delete asked again answers the snapshot as it is: deleted, once its copies went.
    assert sandboxes.delete_snapshot(BOX, SID)["state"] == "deleted"
    unknown = WIRE["rest"]["get_snapshot_unknown"]["path"].rsplit("/", 1)[1]
    for call, code, status in [
        (lambda: sandboxes.get_snapshot(BOX, unknown), "cave_not_found", 404),
        (lambda: sandboxes.snapshot(BOX, {"computer_id": BOX}), "cave_bad_request", 400),  # type: ignore[typeddict-unknown-key]
        (lambda: sandboxes.fork(BOX, SID), "cave_code_computer_snapshot_not_ready", 409),
    ]:
        with pytest.raises(SandboxError) as error:
            call()
        assert (error.value.code, error.value.status) == (code, status) and error.value.request_id
        assert error.value.code in SANDBOX_ERROR_CODES
    assert fake.errors == []
    snapshots = f"/api/v1/code/computers/{BOX}/snapshots"
    assert [(m, p) for m, p, _ in fake.seen] == [
        ("POST", snapshots), ("GET", f"{snapshots}/{SID}"), ("GET", snapshots), ("POST", f"{snapshots}/{SID}/restore"),
        ("GET", f"{snapshots}/{SID}"), ("POST", f"{snapshots}/{SID}/fork"), ("DELETE", f"{snapshots}/{SID}"),
        ("DELETE", f"{snapshots}/{SID}"), ("GET", f"{snapshots}/{unknown}"), ("POST", snapshots), ("POST", f"{snapshots}/{SID}/fork"),
    ]
    assert all(key == "Bearer " + KEY for _, _, key in fake.seen)


def test_a_snapshots_delete_is_asked_again_and_a_take_a_restore_and_a_fork_never_are():
    counts: dict[str, int] = {}

    def rest(h, _body):
        counts[h.command + " " + h.path] = counts.get(h.command + " " + h.path, 0) + 1
        if h.command == "DELETE" and counts[h.command + " " + h.path] <= 2:
            answer(h, 503, b'{"error":{"type":"cave_gateway_error","code":"cave_unavailable","message":"Ask again.","request_id":"r"}}')
        elif h.command == "DELETE":
            answer(h, 200, json.dumps(WIRE["rest"]["delete_snapshot"]["answer"]).encode())
        else:
            answer(h, 503, b'{"error":{"type":"cave_gateway_error","code":"cave_unavailable","message":"Ask again.","request_id":"r"}}')

    f = Fake(rest)
    try:
        sandboxes = client(f.url)
        assert sandboxes.delete_snapshot(BOX, SID)["state"] == "deleting"
        for call in (lambda: sandboxes.snapshot(BOX), lambda: sandboxes.restore(BOX, SID), lambda: sandboxes.fork(BOX, SID)):
            with pytest.raises(SandboxError) as error:
                call()
            assert error.value.status == 503
        snapshots = f"/api/v1/code/computers/{BOX}/snapshots"
        assert counts == {f"DELETE {snapshots}/{SID}": 3, f"POST {snapshots}": 1, f"POST {snapshots}/{SID}/restore": 1, f"POST {snapshots}/{SID}/fork": 1}
    finally:
        f.close()


def test_waiting_for_a_snapshot_reads_until_it_is_ready_or_its_restore_is_done_and_stops_on_a_failure():
    state: dict[str, Any] = {"answers": []}
    reads: list[str] = []

    def rest(h, _body):
        reads.append(h.path)
        answers = state["answers"]
        found = answers.pop(0) if len(answers) > 1 else answers[0]
        answer(h, 200, json.dumps(found).encode())

    def snapshot(state_: str, restore: str = "none", **said: Any) -> dict[str, Any]:
        r = dict(SNAP["restore"], state=restore, reason_code=said.get("restore_code"), reason=said.get("restore_reason", ""))
        return dict(SNAP, state=state_, reason_code=said.get("code"), reason=said.get("reason", ""), restore=r)

    f = Fake(rest)
    try:
        sandboxes = client(f.url)
        slept: list[float] = []
        sandboxes._sleep = slept.append
        state["answers"] = [snapshot("taking"), snapshot("taking"), snapshot("taking"), snapshot("ready")]
        assert sandboxes.wait_for_snapshot(BOX, SID, interval_seconds=1.0)["state"] == "ready"
        # Read four times, from a quarter of a second doubling to the interval.
        assert reads == [f"/api/v1/code/computers/{BOX}/snapshots/{SID}"] * 4 and slept == [0.25, 0.5, 1.0]
        failed = "Cloud could not take this snapshot (reference 0a1b2c3d); the operator can find why with that reference. Take another."
        state["answers"] = [snapshot("taking"), snapshot("failed", code="internal_error", reason=failed)]
        with pytest.raises(SnapshotStateError, match="failed: Cloud could not take this snapshot") as error:
            sandboxes.wait_for_snapshot(BOX, SID, interval_seconds=0.01)
        assert error.value.code == "cave_snapshot_state" and error.value.snapshot["reason_code"] == "internal_error" and error.value.want == "ready"
        for gone in ("deleting", "deleted"):
            state["answers"] = [snapshot(gone)]
            with pytest.raises(SnapshotStateError, match=f"is {gone}"):
                sandboxes.wait_for_snapshot(BOX, SID)
        # Past its timeout: cave_timeout, after the one read.
        reads.clear()
        state["answers"] = [snapshot("taking")]
        with pytest.raises(SandboxError) as timed:
            sandboxes.wait_for_snapshot(BOX, SID, timeout_seconds=0)
        assert timed.value.code == "cave_timeout" and "taking" in str(timed.value) and len(reads) == 1

        state["answers"] = [snapshot("ready", "restoring"), snapshot("ready", "restoring"), snapshot("ready", "restored")]
        assert sandboxes.wait_for_restore(BOX, SID, interval_seconds=0.01)["restore"]["state"] == "restored"
        elsewhere = ("This snapshot is kept on another host than the sandbox runs on now, and a snapshot is restored only where "
                     "it is kept: make a new sandbox from it instead.")
        state["answers"] = [snapshot("ready", "restoring"), snapshot("ready", "failed", restore_code="snapshot_elsewhere", restore_reason=elsewhere)]
        with pytest.raises(SnapshotStateError, match="restore of snapshot .* failed: This snapshot is kept on another host") as error:
            sandboxes.wait_for_restore(BOX, SID, interval_seconds=0.01)
        assert error.value.snapshot["restore"]["reason_code"] == "snapshot_elsewhere" and error.value.want == "restored"
        state["answers"] = [snapshot("ready")]
        with pytest.raises(SnapshotStateError, match="never asked to be restored"):
            sandboxes.wait_for_restore(BOX, SID)
    finally:
        f.close()


def test_with_the_switch_off_a_key_is_refused_and_a_create_says_sandboxes_are_not_offered():
    def rest(h, _body):
        call = WIRE["rest"]["off_create" if h.command == "POST" else "off_list"]
        answer(h, call["status"], json.dumps(call["answer"]).encode())

    f = Fake(rest)
    try:
        sandboxes = client(f.url)
        with pytest.raises(SandboxError) as error:
            sandboxes.list()
        assert (error.value.code, error.value.status) == ("cave_api_key_route_forbidden", 403)
        with pytest.raises(SandboxError) as error:
            sandboxes.create()
        assert error.value.status == 405 and "computers.api.enabled" in str(error.value)
    finally:
        f.close()


STATUS = {
    "state": "degraded", "checked_at": "2026-11-19T12:00:05Z", "last_round_at": "2026-11-19T12:00:00Z",
    "interval_seconds": 60, "stale_after_seconds": 300, "window_seconds": 3600,
    "probes": [
        {"name": "create", "state": "ok", "last_success_at": "2026-11-19T12:00:00Z", "attempts": 60, "failures": 0, "p50_ms": 210, "p95_ms": 480},
        {"name": "running", "state": "ok", "last_success_at": "2026-11-19T12:00:00Z", "attempts": 60, "failures": 0, "p50_ms": 800, "p95_ms": 1200},
        {"name": "exec_open", "state": "degraded", "last_success_at": "2026-11-19T12:00:00Z", "attempts": 60, "failures": 2, "p50_ms": 50, "p95_ms": 90},
        {"name": "command", "state": "ok", "last_success_at": "2026-11-19T12:00:00Z", "attempts": 58, "failures": 0, "p50_ms": 100, "p95_ms": 140},
        {"name": "delete", "state": "unknown", "last_success_at": None, "attempts": 0, "failures": 0, "p50_ms": None, "p95_ms": None},
    ],
    "create_to_command": {"state": "ok", "threshold_ms": 2000, "p95_ms": 1400},
}


def test_status_reads_whether_sandboxes_work_and_an_install_that_does_not_serve_it_answers_404():
    served = {"on": True}
    seen = []

    def rest(h, _body):
        seen.append((h.command, h.path))
        if served["on"]:
            answer(h, 200, json.dumps(STATUS).encode())
        else:
            answer(h, 404, b'{"error":{"type":"cave_gateway_error","code":"cave_not_found","message":"Not found.","request_id":"req_1"}}')

    f = Fake(rest)
    try:
        sandboxes = client(f.url)
        status = sandboxes.status()
        assert status["state"] == "degraded" and [p["name"] for p in status["probes"]] == ["create", "running", "exec_open", "command", "delete"]
        assert status["probes"][2]["failures"] == 2 and status["probes"][4]["last_success_at"] is None
        assert seen == [("GET", "/api/v1/status/sandboxes")]
        served["on"] = False
        with pytest.raises(SandboxError) as error:
            sandboxes.status()
        assert (error.value.code, error.value.status) == ("cave_not_found", 404)
    finally:
        f.close()


def test_a_command_streams_its_output_answers_its_exit_code_reads_stdin_and_large_output_arrives_whole(fake):
    sandboxes = client(fake.url)
    assert sandboxes.run(ID, ["sh", "-c", "echo hello from the sandbox; echo careful >&2; exit 7"]) == ExecResult(7, b"hello from the sandbox\n", b"careful\n")
    assert sandboxes.run(ID, ["cat"], stdin="stdin reaches it") == ExecResult(0, b"stdin reaches it", b"")
    assert sandboxes.run(ID, ["cat"], stdin=io.BytesIO(b"stdin reaches it")).stdout == b"stdin reaches it"
    assert sandboxes.run(ID, ["cat"], stdin=io.StringIO("stdin reaches it")).stdout == b"stdin reaches it"

    def failing():
        yield b"stdin reaches it"
        raise RuntimeError("the pipe broke")

    # A stdin that fails after its first piece: the command's input ends there.
    assert sandboxes.run(ID, ["cat"], stdin=failing()) == ExecResult(0, b"stdin reaches it", b"")
    out = io.BytesIO()
    pieces = []
    assert sandboxes.exec(ID, ["sh", "-c", "head -c 40000 /dev/zero | tr '\\0' a"], stdout=lambda b: (pieces.append(len(b)), out.write(b))) == 0
    # Each piece as the sandbox sent it (the recording's frames), none past max_output, 40000 bytes in all.
    sent = [len(base64.b64decode(m["base64"]) if m.get("base64") else m.get("data", "").encode()) for m in WIRE["exec"]["large"]["server"] if "text" not in m]
    assert pieces == sent and all(n <= 32768 for n in pieces) and out.getvalue() == b"a" * 40000
    assert fake.errors == []


def test_what_ends_a_stream_without_an_exit_is_a_sandbox_exec_error_with_the_streams_code(fake):
    sandboxes = client(fake.url)

    def refused(**setup):
        fake.replay, fake.refuse, fake.close_raw = setup.get("replay", ""), setup.get("refuse", ""), setup.get("close_raw")
        with pytest.raises(SandboxExecError) as error:
            sandboxes.run(ID, ["true"])
        return error.value

    # A sandbox that takes no options closes a start that asks for one with unsupported.
    e = refused(replay="stdin", close_raw=4405)
    assert (e.code, e.close_code) == ("cave_code_computer_unsupported", 4405)
    e = refused(refuse="asleep")
    assert (e.code, e.status) == ("cave_code_computer_not_running", 409)
    e = refused(refuse="unknown")
    assert (e.code, e.status) == ("cave_not_found", 404)
    assert "computers.api.enabled" in str(refused(refuse="switched_off"))
    for close, code in [(4401, "cave_unauthorized"), (4404, "cave_code_computer_stream_ended"), (4410, "cave_code_computer_stopped"), (1001, "cave_code_computer_stream_ended")]:
        e = refused(replay="stdin", close_raw=close)
        assert (e.code, e.close_code) == (code, close)
    with pytest.raises(SandboxExecError):
        sandboxes.exec(ID, [])
    assert fake.errors == []


def test_a_commands_options_reach_it_a_signal_ends_it_and_what_the_sandbox_did_not_act_on_comes_back(fake):
    sandboxes = client(fake.url)

    def said(name):
        return "".join(m.get("data", "") for m in WIRE["exec"][name]["server"] if m.get("channel") == 1).encode()

    assert sandboxes.run(ID, ["pwd"], cwd="/tmp") == ExecResult(0, said("start_with_cwd"), b"")
    assert sandboxes.run(ID, ["sh", "-c", 'echo "$GREETING"'], env={"GREETING": "hello env"}) == ExecResult(0, b"hello env\n", b"")
    # A signal asked before the stream opens goes once it does: the command ends on it (128 + SIGINT).
    command = SandboxCommand()
    command.send_signal("SIGINT")
    assert sandboxes.exec(ID, ["sleep", "5"], control=command) == 130
    # A resize of a command with no terminal is refused on its own; the command runs to its exit.
    refusals: list[SandboxRefusal] = []
    resized = SandboxCommand()
    resized.resize(80, 24)
    assert sandboxes.exec(ID, ["sh", "-c", "sleep 1"], control=resized, on_refused=refusals.append) == 0
    assert refusals == [SandboxRefusal("resize", "cave_code_computer_unsupported", "the command has no terminal to resize")]
    # What the sandbox would refuse is refused here, before a stream opens.
    opened = len(fake.seen)
    for call in (lambda: command.send_signal("BOGUS"), lambda: command.resize(0, 24), lambda: command.resize(80, 65536)):
        with pytest.raises(SandboxExecError) as error:
            call()
        assert error.value.code == "cave_bad_request"
    many = {f"V{i}": "x" for i in range(257)}
    for options in ({"cols": 80, "rows": 24}, {"tty": True, "cols": 80}, {"cwd": "relative"}, {"env": {"A=B": "x"}}, {"env": {"": "x"}},
                    {"env": {"A": "a\0b"}}, {"env": many}):
        with pytest.raises(SandboxExecError) as error:
            sandboxes.exec(ID, ["true"], **options)  # type: ignore[arg-type]
        assert error.value.code == "cave_bad_request", options
    assert len(fake.seen) == opened
    assert fake.errors == []


def test_a_stream_whose_host_is_restarting_is_opened_again_within_its_bound_only_when_nothing_came_back(fake):
    sandboxes = client(fake.url)
    waits = []
    sandboxes._sleep = waits.append

    def opens():
        return sum(1 for s in fake.seen if s[1].endswith("/exec"))

    # Twice, then the command runs: three opens, the third's answer, the far end's wait each time.
    fake.host_down, fake.retry_after = 2, 0
    assert sandboxes.run(ID, ["cat"], stdin="stdin reaches it") == ExecResult(0, b"stdin reaches it", b"")
    assert opens() == 3 and waits == [0.0, 0.0]
    # Five opens at most, then the code to the caller.
    before = opens()
    fake.host_down = 9
    with pytest.raises(SandboxExecError) as error:
        sandboxes.run(ID, ["true"])
    assert (error.value.code, error.value.retry_after) == ("cave_code_computer_host_unreachable", 0)
    assert opens() - before == 5
    # A file is read once: never opened again; nor after output came (the command had started).
    for setup in ({"stdin": io.BytesIO(b"once")}, {"output": True}):
        before = opens()
        fake.host_down, fake.host_down_output = 1, bool(setup.get("output"))
        with pytest.raises(SandboxExecError) as error:
            sandboxes.run(ID, ["cat"], stdin=setup.get("stdin"))
        assert error.value.code == "cave_code_computer_host_unreachable" and opens() - before == 1
    # A wait past the bound (the far end's retry_after, 30 s): not opened again.
    before = opens()
    fake.host_down, fake.host_down_output, fake.retry_after = 1, False, 30
    with pytest.raises(SandboxExecError):
        sandboxes.run(ID, ["true"])
    assert opens() - before == 1
    fake.host_down = 0
    assert fake.errors == []


def test_files_are_written_read_listed_described_moved_and_removed_each_on_a_stream_of_its_own(fake):
    sandboxes = client(fake.url)
    written = sandboxes.write_file(ID, "/notes.txt", "hello file", mode=0o600, atomic=True)
    assert (written["name"], written["type"], written["size"], written["mode"]) == ("notes.txt", "file", 10, 0o600)
    assert sandboxes.read_file(ID, "/notes.txt") == b"hello file"
    # A file read to a sink a piece at a time; data from a binary file, read once.
    pieces: list[bytes] = []
    assert sandboxes.stream_file(ID, "/notes.txt", pieces.append)["size"] == 10
    assert pieces == [b"hello", b" file"]
    sandboxes.write_file(ID, "/big.bin", io.BytesIO(b"x" * 70000), root=True)
    out = io.BytesIO()
    sandboxes.stream_file(ID, "/big.bin", out)
    assert out.getvalue() == b"x" * 70000
    sandboxes.make_dir(ID, "/work", parents=True)
    sandboxes.rename_file(ID, "/notes.txt", "/work/notes.txt")
    assert sorted(f["name"] for f in sandboxes.list_files(ID, "/")) == ["big.bin", "work"]
    assert sandboxes.stat_file(ID, "/work")["type"] == "dir"
    sandboxes.remove_file(ID, "/work", all=True)
    assert [f["name"] for f in sandboxes.list_files(ID, "/")] == ["big.bin"]
    first = fake.file_ops[0]
    assert first == {"type": "files", "op": "write", "path": "/notes.txt", "mode": 0o600, "atomic": True}
    assert [o["op"] for o in fake.file_ops] == ["write", "read", "read", "write", "read", "mkdir", "rename", "list", "stat", "remove", "list"]
    assert fake.file_ops[3].get("root") is True and fake.file_ops[5]["parents"] is True and fake.file_ops[9]["all"] is True
    assert all(s[1] == f"/relay/v1/computers/{ID}/files" for s in fake.seen if "/relay/" in s[1])
    # What the file system refused is its code and its words.
    for call, code in [
        (lambda: sandboxes.read_file(ID, "/gone"), "cave_code_computer_file_not_found"),
        (lambda: sandboxes.read_file(ID, "/"), "cave_code_computer_file_refused"),
        (lambda: sandboxes.make_dir(ID, "/big.bin"), "cave_code_computer_file_exists"),
    ]:
        with pytest.raises(SandboxFileError) as error:
            call()
        assert isinstance(error.value, SandboxExecError) and error.value.code == code
        assert str(error.value).startswith(("open /", "mkdir /"))
    # A path that is not one is refused here, before anything is sent.
    before = len(fake.file_ops)
    for path in ("relative", "/a\0b", "/" + "a" * 4096):
        with pytest.raises(SandboxFileError) as error:
            sandboxes.read_file(ID, path)
        assert error.value.code == "cave_bad_request"
    with pytest.raises(SandboxFileError):
        sandboxes.rename_file(ID, "/big.bin", "nowhere")
    assert len(fake.file_ops) == before
    assert fake.errors == []


def test_a_file_stream_whose_host_is_restarting_is_opened_again_only_when_its_data_can_be_sent_again(fake):
    sandboxes = client(fake.url)
    sandboxes._sleep = lambda _: None
    fake.host_down = 2
    sandboxes.write_file(ID, "/again.txt", b"bytes are sent again")
    assert sandboxes.read_file(ID, "/again.txt") == b"bytes are sent again"
    fake.host_down = 1
    with pytest.raises(SandboxFileError) as error:
        sandboxes.write_file(ID, "/once.txt", io.BytesIO(b"read once"))
    assert error.value.code == "cave_code_computer_host_unreachable"
    assert sum(1 for s in fake.seen if s[1].endswith("/files")) == 5
    assert fake.errors == []


def test_a_dialed_port_carries_bytes_both_ways_and_a_refused_one_says_so(fake):
    sandboxes = client(fake.url)
    with sandboxes.dial_port(ID, 8080) as connection:
        connection.write(b"hello ")
        connection.write("port")
        connection.close_write()
        assert b"".join(connection) == b"HELLO PORT"
        assert connection.read() == b""
    assert fake.dialed == ["8080"]
    assert any(s[1] == f"/relay/v1/computers/{ID}/dial/8080" for s in fake.seen)
    fake.port_refused = True
    with sandboxes.dial_port(ID, 5432) as connection:
        with pytest.raises(SandboxFileError) as error:
            connection.read()
        assert (error.value.code, str(error.value)) == ("cave_code_computer_port_refused", "nothing listens on port 5432")
    for port in (0, 65536, True):
        with pytest.raises(SandboxFileError) as error:
            sandboxes.dial_port(ID, port)  # type: ignore[arg-type]
        assert error.value.code == "cave_bad_request"
    assert fake.dialed == ["8080", "5432"]
    assert fake.errors == []


def test_a_command_past_its_timeout_is_ended():
    listener = socket.create_server(("127.0.0.1", 0))
    closed = threading.Event()

    def serve():
        conn, _ = listener.accept()
        request = b""
        while b"\r\n\r\n" not in request:
            request += conn.recv(4096)
        key = next(line.split(b": ", 1)[1] for line in request.split(b"\r\n") if line.lower().startswith(b"sec-websocket-key"))
        import base64
        import hashlib
        accept = base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
        conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept
                     + b"\r\nSec-WebSocket-Protocol: caveman.computer.v1\r\n\r\n")
        while conn.recv(4096):
            continue
        closed.set()

    threading.Thread(target=serve, daemon=True).start()
    sandboxes = client(f"http://127.0.0.1:{listener.getsockname()[1]}")
    with pytest.raises(SandboxExecError) as error:
        sandboxes.exec(ID, ["sleep", "60"], timeout_seconds=0.3)
    assert error.value.code == "cave_timeout"
    assert closed.wait(5)
    listener.close()


def test_retries_only_what_the_api_says_may_be_asked_again():
    counts = {"GET": 0, "POST": 0, "DELETE": 0, "busy": 0}

    def envelope(code):
        return json.dumps({"error": {"type": "cave_gateway_error", "code": code, "message": "Ask again.", "request_id": "r"}}).encode()

    def rest(h, body):
        counts[h.command] += 1
        n = counts[h.command]
        if h.command == "GET":
            answer(h, 503, envelope("cave_unavailable")) if n <= 2 else answer(h, 200, json.dumps(WIRE["rest"]["get"]["answer"]).encode())
        elif h.command == "DELETE":
            answer(h, 409, envelope("cave_code_computer_busy")) if n == 1 else answer(h, 200, json.dumps(WIRE["rest"]["delete"]["answer"]).encode())
        elif b"busy" in body:
            counts["busy"] += 1
            answer(h, 429, envelope("cave_rate_limited"), {"retry-after": "0"})
        else:
            answer(h, 503, envelope("cave_unavailable"))

    f = Fake(rest)
    try:
        sandboxes = client(f.url)
        assert sandboxes.get(ID)["id"] == ID and counts["GET"] == 3
        with pytest.raises(SandboxError) as error:
            sandboxes.create()
        assert error.value.status == 503 and counts["POST"] == 1
        assert sandboxes.delete(ID)["desired_state"] == "deleted" and counts["DELETE"] == 2
        with pytest.raises(SandboxError) as error:
            sandboxes.create({"name": "busy"})
        assert error.value.status == 429 and counts["busy"] == 4
    finally:
        f.close()


def test_a_wait_past_the_clients_longest_is_raised_at_once_and_one_within_it_is_waited_for():
    # An organization's start ceiling names up to a day: past 30 s the caller decides, with the seconds on the error.
    asks = {"n": 0, "after": "3600"}

    def rest(h, body):
        asks["n"] += 1
        if asks["after"] == "2" and asks["n"] > 1:
            answer(h, 201, json.dumps(WIRE["rest"]["create"]["answer"]).encode())
            return
        refusal = {"error": {"type": "cave_gateway_error", "code": "cave_code_computer_start_ceiling", "message": "Try again in about 60 minutes.", "request_id": "r"}}
        answer(h, 429, json.dumps(refusal).encode(), {"retry-after": asks["after"]})

    f = Fake(rest)
    try:
        sandboxes = Sandboxes(control_url=f.url, api_key=KEY)
        slept: list[float] = []
        sandboxes._sleep = slept.append
        began = time.monotonic()
        with pytest.raises(SandboxError) as error:
            sandboxes.create()
        assert (error.value.status, error.value.code, error.value.retry_after) == (429, "cave_code_computer_start_ceiling", 3600)
        assert time.monotonic() - began < 1 and asks["n"] == 1 and slept == []
        asks.update(n=0, after="2")
        assert sandboxes.create()["id"] == ID
        assert asks["n"] == 2 and slept == [2.0]
    finally:
        f.close()

def test_waiting_reads_until_the_state_and_stops_on_a_failure_or_another_ask():
    state = {"states": ["pending", "starting", "running"], "desired": "running", "reason": None, "code": None}

    def rest(h, _body):
        c = dict(WIRE["rest"]["get"]["answer"], observed_state=state["states"][0], desired_state=state["desired"])
        if state["reason"]:
            c["observed_reason"] = state["reason"]
        if state["code"]:
            c["observed_reason_code"] = state["code"]
        if len(state["states"]) > 1:
            state["states"] = state["states"][1:]
        answer(h, 200, json.dumps(c).encode())

    f = Fake(rest)
    try:
        sandboxes = client(f.url)
        assert sandboxes.wait(ID, "running", interval_seconds=0.01)["observed_state"] == "running"
        state.update(states=["starting", "failed"], reason="image missing")
        with pytest.raises(SandboxStateError, match="image missing"):
            sandboxes.wait(ID, "running", interval_seconds=0.01)
        state.update(states=["starting"], desired="suspended", reason=None)
        with pytest.raises(SandboxStateError) as error:
            sandboxes.wait(ID, "running", interval_seconds=0.01)
        assert error.value.sandbox["desired_state"] == "suspended"
        # A reason that passes by itself: the wait goes on, even while the sandbox reads failed (its host restarting).
        state.update(states=["failed", "failed", "running"], desired="running", code="host_unavailable",
                     reason="Its host is restarting or not answering just now; Cloud tries again in a moment.")
        assert sandboxes.wait(ID, "running", interval_seconds=0.01)["observed_state"] == "running"
        # One that needs the caller ends it, whatever the state.
        state.update(states=["stopped"], code="stopped_by_host",
                     reason="Its host restarted or ran short of memory, so it was stopped; its disk is kept. Start it again.")
        with pytest.raises(SandboxStateError, match="is stopped: Its host restarted"):
            sandboxes.wait(ID, "running", interval_seconds=0.01)
        # Cloud's own ends it once the sandbox has failed, and a code this client does not know reads as none.
        for unknown in ("internal_error", "a_later_code"):
            state.update(states=["starting", "starting", "failed"], code=unknown, reason="went wrong")
            with pytest.raises(SandboxStateError, match="failed: went wrong"):
                sandboxes.wait(ID, "running", interval_seconds=0.01)
            assert state["states"] == ["failed"]
    finally:
        f.close()


def test_the_api_holds_the_read_until_the_state_and_a_cloud_that_does_not_wait_is_polled(monkeypatch):
    asked: list[str] = []
    state: dict[str, Any] = {"answers": [("running", "satisfied", 0.0)]}
    now = [1000.0]

    def rest(h, _body):
        asked.append(urllib.parse.urlsplit(h.path).query)
        answers = state["answers"]
        observed, wait, after, *code = answers.pop(0) if len(answers) > 1 else answers[0]
        now[0] += after
        found = dict(WIRE["rest"]["get"]["answer"], observed_state=observed, **({"observed_reason_code": code[0]} if code else {}))
        answer(h, 200, json.dumps(found).encode(), {"cave-wait": wait} if wait else None)

    monkeypatch.setattr("caveman_cloud.sandboxes.time.monotonic", lambda: now[0])
    f = Fake(rest)
    try:
        sandboxes = client(f.url)
        # Held until it runs: one request, as long as the wait (at most the API's minute).
        assert sandboxes.wait(ID, "running")["observed_state"] == "running"
        assert asked == ["wait_for=running&timeout=60"]
        asked.clear()
        sandboxes.wait(ID, "running", timeout_seconds=3.5)
        assert asked == ["wait_for=running&timeout=3"]
        asked.clear()
        # A held read that timed out is asked again at once; one the API says cannot end there ends the wait.
        state["answers"] = [("starting", "timeout", 1.1), ("running", "satisfied", 0.0)]
        slept: list[float] = []
        sandboxes._sleep = slept.append
        assert sandboxes.wait(ID, "running", interval_seconds=60)["observed_state"] == "running"
        assert len(asked) == 2 and slept == []
        asked.clear()
        state["answers"] = [("starting", "unreachable", 0.0)]
        with pytest.raises(SandboxStateError):
            sandboxes.wait(ID, "running")
        asked.clear()
        # The API's verdict decides, by the same reason codes: a failed sandbox whose host is restarting, which it held
        # and answered timeout, is waited on.
        state["answers"] = [("failed", "timeout", 1.1, "host_unavailable"), ("running", "satisfied", 0.0)]
        assert sandboxes.wait(ID, "running", interval_seconds=60)["observed_state"] == "running"
        assert len(asked) == 2
        asked.clear()
        state["answers"] = [("failed", "unreachable", 0.0, "out_of_memory")]
        with pytest.raises(SandboxStateError):
            sandboxes.wait(ID, "running")
        asked.clear()
        # No Cave-Wait: polled from then on, never asked to wait again.
        state["answers"] = [("pending", None, 0.0), ("starting", None, 0.0), ("running", None, 0.0)]
        assert sandboxes.wait(ID, "running", interval_seconds=0.01)["observed_state"] == "running"
        assert asked == ["wait_for=running&timeout=60", "", ""]
    finally:
        f.close()


def test_at_the_apis_cap_on_waits_the_read_is_a_plain_one():
    asked: list[str] = []

    def rest(h, _body):
        asked.append(urllib.parse.urlsplit(h.path).query)
        if "wait_for" in h.path:
            refusal = {"error": {"type": "cave_gateway_error", "code": "cave_code_computer_waits_limit", "message": "As many waits as it may.", "request_id": "r"}}
            answer(h, 429, json.dumps(refusal).encode(), {"retry-after": "0"})
        else:
            answer(h, 200, json.dumps(WIRE["rest"]["get"]["answer"]).encode())

    f = Fake(rest)
    try:
        assert client(f.url).wait(ID, "running")["observed_state"] == "running"
        assert asked == ["wait_for=running&timeout=60"] * 4 + [""]
    finally:
        f.close()


@pytest.mark.parametrize("options", [
    {"control_url": "http://cloud.example", "api_key": "k"},
    {"control_url": "https://cloud.example/api", "api_key": "k"},
    {"control_url": "https://u:p@cloud.example", "api_key": "k"},
    {"control_url": "https://cloud.example", "api_key": " "},
    {"control_url": "https://cloud.example", "relay_url": "http://relay.example", "api_key": "k"},
])
def test_the_client_refuses_what_it_cannot_use(options):
    with pytest.raises(CloudError):
        Sandboxes(**options)


# A token and a link for port 3000, as the API answers POST .../ports/3000/token (CodeComputerPortToken).
PORT_URL = f"https://3000-{ID}.sandbox.example.dev"
PORT_TOKEN = {"computer_id": ID, "port": 3000, "visibility": "private", "url": PORT_URL, "link": PORT_URL + "/_caveman/open?token=cvp_link",
              "link_expires_at": "2026-11-20T12:05:00Z", "token": "cvp_access", "header": "Caveman-Port-Token", "expires_at": "2026-11-20T13:00:00Z"}


def test_url_answers_a_port_at_its_own_url_its_link_its_token_and_the_header_a_program_sends():
    seen: list[tuple[str, str, bytes]] = []

    def rest(h, body):
        seen.append((h.command, h.path, body))
        if h.command == "PUT" and h.path == f"/api/v1/code/computers/{ID}/ports/3000":
            answer(h, 200, json.dumps({"port": 3000, "visibility": json.loads(body)["visibility"], "url": PORT_URL}).encode())
        elif h.command == "POST" and h.path == f"/api/v1/code/computers/{ID}/ports/3000/token":
            public = any(s[0] == "PUT" for s in seen)
            ttl = json.loads(body or b"{}").get("ttl_seconds")
            answer(h, 200, json.dumps({**PORT_TOKEN, "visibility": "public" if public else "private",
                                       "expires_at": "2026-11-20T12:10:00Z" if ttl == 600 else PORT_TOKEN["expires_at"]}).encode())
        else:
            answer(h, 404, b'{"error":{"type":"cave_gateway_error","code":"cave_not_found","message":"Not found.","request_id":"req_port"}}')

    f = Fake(rest)
    try:
        sandboxes = client(f.url)
        assert sandboxes.url(ID, 3000) == SandboxPortURL(url=PORT_URL, link=PORT_TOKEN["link"], link_expires_at="2026-11-20T12:05:00Z", token="cvp_access",
                                                         headers={"Caveman-Port-Token": "cvp_access"}, expires_at="2026-11-20T13:00:00Z", visibility="private")
        assert seen == [("POST", f"/api/v1/code/computers/{ID}/ports/3000/token", b"{}")]
        assert all(auth == "Bearer " + KEY for _, _, auth in f.seen)
        # public=True makes the port public before the token is asked; ttl_seconds is sent as asked.
        seen.clear()
        opened = sandboxes.url(ID, 3000, public=True, ttl_seconds=600)
        assert (opened.visibility, opened.expires_at) == ("public", "2026-11-20T12:10:00Z")
        assert [(m, p, json.loads(b)) for m, p, b in seen] == [("PUT", f"/api/v1/code/computers/{ID}/ports/3000", {"visibility": "public"}),
                                                                ("POST", f"/api/v1/code/computers/{ID}/ports/3000/token", {"ttl_seconds": 600})]
        # A port or a ttl out of range is refused before anything is sent.
        seen.clear()
        for bad in (0, 65536, True, "3000"):
            with pytest.raises(SandboxError) as error:
                sandboxes.url(ID, bad)  # type: ignore[arg-type]
            assert (error.value.code, error.value.status) == ("cave_bad_request", 0)
        for ttl in (59, 86401):
            with pytest.raises(SandboxError) as error:
                sandboxes.url(ID, 3000, ttl_seconds=ttl)
            assert error.value.code == "cave_bad_request"
        assert seen == []
        # A Caveman Cloud that does not serve ports at their own URLs answers the route as an unknown one: a typed refusal.
        with pytest.raises(SandboxError) as error:
            sandboxes.url(ID, 8080)
        assert (error.value.code, error.value.status, error.value.request_id) == ("cave_not_found", 404, "req_port")
        # The plain calls are there too: a port made private again.
        assert sandboxes.set_port(ID, 3000, {"visibility": "private"})["visibility"] == "private"
        assert f.errors == []
    finally:
        f.close()
