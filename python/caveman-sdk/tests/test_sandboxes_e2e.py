"""End to end against a real control-api and relay.

the Caveman sandbox test harness runs this with CAVE_SANDBOX_E2E_API, _RELAY and _KEY (a code:run key); a file
goes in CAVE_SANDBOX_E2E_DIR (/tmp when unset), and CAVE_SANDBOX_E2E_PORT, when set, is a port in the sandbox that
answers what it reads upper-cased. The quickstart's Python snippet is the first test's body, between the quickstart
markers.
"""

import io
import json
import os
from pathlib import Path

import pytest

from caveman_cloud import ExecResult, SandboxCommand, SandboxError, SandboxExecError, SandboxFileError, Sandboxes

API, RELAY, KEY = os.environ.get("CAVE_SANDBOX_E2E_API"), os.environ.get("CAVE_SANDBOX_E2E_RELAY"), os.environ.get("CAVE_SANDBOX_E2E_KEY")
pytestmark = pytest.mark.skipif(not (API and KEY), reason="set CAVE_SANDBOX_E2E_API and CAVE_SANDBOX_E2E_KEY (the Caveman sandbox test harness runs it)")


def test_a_sandbox_made_a_command_run_in_it_and_the_sandbox_deleted():
    # quickstart:python
    sandboxes = Sandboxes(control_url=API, relay_url=RELAY, api_key=KEY)
    box = sandboxes.create({"name": "quickstart-py"})
    sandboxes.wait(box["id"], "running")
    result = sandboxes.run(box["id"], ["sh", "-c", "echo hello from the sandbox; echo careful >&2; exit 3"])
    # result: ExecResult(exit_code=3, stdout=b"hello from the sandbox\n", stderr=b"careful\n")
    sandboxes.delete(box["id"])
    # quickstart:end
    assert result == ExecResult(3, b"hello from the sandbox\n", b"careful\n")


def test_the_lifecycle():
    sandboxes = Sandboxes(control_url=API, relay_url=RELAY, api_key=KEY)
    box = sandboxes.create({"name": "e2e-py", "sleep_after_seconds": 0})
    assert box["bare"] is True and box["sleep_after_seconds"] == 0
    sandboxes.wait(box["id"], "running")
    out = io.BytesIO()
    assert sandboxes.exec(box["id"], ["cat"], stdin=io.BytesIO(b"stdin reaches it"), stdout=out) == 0
    assert out.getvalue() == b"stdin reaches it"
    # Quiet for longer than the relay's ping interval (the lab pings every second): the pings are answered.
    assert sandboxes.run(box["id"], ["sh", "-c", "sleep 3; echo still here"]) == ExecResult(0, b"still here\n", b"")
    # A file written is read back, listed and removed.
    folder = os.environ.get("CAVE_SANDBOX_E2E_DIR") or "/tmp"
    path = f"{folder}/e2e-py-{box['id']}.txt"
    written = sandboxes.write_file(box["id"], path, "a file through the relay\n", mode=0o600)
    assert (written["size"], written["mode"]) == (25, 0o600)
    assert sandboxes.read_file(box["id"], path) == b"a file through the relay\n"
    assert any(f"{folder}/{f['name']}" == path for f in sandboxes.list_files(box["id"], folder))
    # A command's options: its environment and folder (the file is there); a signal ends it.
    listed = sandboxes.run(box["id"], ["sh", "-c", 'echo "$GREETING"; ls'], env={"GREETING": "hello env"}, cwd=folder)
    assert listed.exit_code == 0 and listed.stdout.startswith(b"hello env\n") and path.rsplit("/", 1)[1].encode() in listed.stdout
    command = SandboxCommand()
    command.send_signal("INT")
    assert sandboxes.exec(box["id"], ["sleep", "30"], control=command) == 130
    sandboxes.remove_file(box["id"], path)
    with pytest.raises(SandboxFileError) as missing:
        sandboxes.read_file(box["id"], path)
    assert missing.value.code == "cave_code_computer_file_not_found"
    if os.environ.get("CAVE_SANDBOX_E2E_PORT"):
        with sandboxes.dial_port(box["id"], int(os.environ["CAVE_SANDBOX_E2E_PORT"])) as conn:
            conn.write(b"hello port")
            conn.close_write()
            assert b"".join(conn) == b"HELLO PORT"
    # Its snapshots: one taken while it runs, listed, restored into it, made into a new sandbox, deleted.
    snap = sandboxes.snapshot(box["id"], {"name": "e2e-py"})
    assert (snap["state"], snap["computer_id"], snap["name"]) == ("taking", box["id"], "e2e-py")
    assert sandboxes.wait_for_snapshot(box["id"], snap["id"])["state"] == "ready"
    assert any(s["id"] == snap["id"] for s in sandboxes.list_snapshots(box["id"])["snapshots"])
    assert sandboxes.restore(box["id"], snap["id"])["restore"]["state"] == "restoring"
    assert sandboxes.wait_for_restore(box["id"], snap["id"])["restore"]["state"] == "restored"
    sandboxes.wait(box["id"], "running")
    child = sandboxes.fork(box["id"], snap["id"], {"name": "e2e-py-fork", "sleep_after_seconds": 0})
    assert child["bare"] is True and child["id"] != box["id"]
    sandboxes.wait(child["id"], "running")
    sandboxes.delete(child["id"])
    assert sandboxes.delete_snapshot(box["id"], snap["id"])["state"] in ("deleting", "deleted")
    assert sandboxes.get_snapshot(box["id"], snap["id"])["state"] in ("deleting", "deleted")
    assert any(c["id"] == box["id"] for c in sandboxes.list()["computers"])
    sandboxes.sleep(box["id"])
    sandboxes.wait(box["id"], "suspended")
    with pytest.raises(SandboxExecError) as refused:
        sandboxes.run(box["id"], ["true"])
    assert (refused.value.code, refused.value.status) == ("cave_code_computer_not_running", 409)
    sandboxes.resume(box["id"])
    sandboxes.wait(box["id"], "running")
    assert sandboxes.run(box["id"], ["echo", "awake"]).stdout == b"awake\n"
    sandboxes.delete(box["id"])
    assert sandboxes.wait(box["id"], "deleted") is None
    with pytest.raises(SandboxError) as gone:
        sandboxes.get(box["id"])
    assert gone.value.code == "cave_not_found"
    with pytest.raises(SandboxExecError) as missing:
        sandboxes.run(box["id"], ["true"])
    assert missing.value.status == 404


ROOM = os.environ.get("CAVE_SANDBOX_E2E_ROOM")


@pytest.mark.skipif(not ROOM, reason="set CAVE_SANDBOX_E2E_ROOM (the Caveman sandbox test harness runs it)")
def test_a_sandbox_the_fleet_has_no_room_for_says_so_and_a_wait_for_it_goes_on():
    """The sandbox the lab made larger than its one host: it says why it is not running in the vocabulary's sentence
    (public/sdk/parity/sandbox-reasons.json), never failed, and a wait for it goes on to its end."""
    reasons = json.loads((Path(__file__).resolve().parents[2] / "parity" / "sandbox-reasons.json").read_text())["codes"]
    sandboxes = Sandboxes(control_url=API, relay_url=RELAY, api_key=KEY)
    box = sandboxes.get(ROOM)
    assert box.get("observed_reason") == reasons["waiting_for_capacity"]["sentence"]
    assert box["observed_state"] != "failed"
    assert box.get("observed_reason_code") == "waiting_for_capacity"
    with pytest.raises(SandboxError) as waited:
        sandboxes.wait(ROOM, "running", timeout_seconds=2, interval_seconds=0.2)
    assert waited.value.code == "cave_timeout"
