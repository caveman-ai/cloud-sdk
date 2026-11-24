"""A fake Caveman Cloud for the Sandboxes client.

It answers what the branch's control-api, the fleet's stream endpoint and a relay answered a code:run key, as
recorded in public/sdk/parity/sandboxes-wire.json (the Caveman sandbox test harness, SANDBOX_LAB_RECORD): REST
calls by method, path and body; a command's stream by replaying the recording its client messages match (or the one
named in ``replay``); a refusal before the upgrade by ``refuse``.
"""

from __future__ import annotations

import base64
import hashlib
import json
import pathlib
import socket
import struct
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

WIRE: dict[str, Any] = json.loads((pathlib.Path(__file__).parents[2] / "parity" / "sandboxes-wire.json").read_text())
# The order the lab made its REST recordings in: a route's recordings are answered in it.
RECORDED = ["create", "get", "list", "list_mine", "get_unknown", "create_bad_size", "create_unknown_field",
            "snapshot", "get_snapshot", "list_snapshots", "get_snapshot_unknown", "snapshot_unknown_field", "restore",
            "get_snapshot_restored", "fork", "delete_snapshot", "delete_snapshot_again", "fork_deleted",
            "sleep", "resume", "delete", "delete_again", "get_deleted"]
KEY = "cave_live_wire"


def _json_equal(a: Any, b: Any) -> bool:
    """Whether two bodies say the same: none, an empty one and an empty object are one body (a call with no input
    sends {})."""

    def said(v: Any) -> Any:
        if v and isinstance(v, (str, bytes)):
            v = json.loads(v)
        return v or None

    try:
        return bool(said(a) == said(b))
    except ValueError:
        return False


def server_frame(op: int, payload: bytes) -> bytes:
    n = len(payload)
    head = bytes([0x80 | op]) + (bytes([n]) if n < 126 else bytes([126]) + struct.pack(">H", n) if n <= 0xFFFF else bytes([127]) + struct.pack(">Q", n))
    return head + payload


def _read_exactly(f: Any, n: int) -> bytes:
    data = f.read(n)
    if len(data) != n:
        raise EOFError
    return data


def client_frame(f: Any) -> tuple[int, bytes]:
    first, second = _read_exactly(f, 2)
    n = second & 0x7F
    if n == 126:
        n = struct.unpack(">H", _read_exactly(f, 2))[0]
    elif n == 127:
        n = struct.unpack(">Q", _read_exactly(f, 8))[0]
    if not second & 0x80:
        raise ValueError("an unmasked client frame")
    mask = _read_exactly(f, 4)
    payload = bytes(b ^ mask[i % 4] for i, b in enumerate(_read_exactly(f, n)))
    return first & 0x0F, payload


class Fake:
    def __init__(self, rest: Callable[[BaseHTTPRequestHandler, bytes], None] | None = None) -> None:
        self.replay, self.refuse, self.close_raw = "", "", None
        # host_down streams answer as a computer whose host is restarting does (the lab cannot make one: the
        # sandbox stream wire contract): its error with retry_after, then close 4503; with
        # host_down_output, after some output (the command had started).
        self.host_down, self.retry_after, self.host_down_output = 0, 0, False
        # A sandbox's files, as the files wire answers them (the sandbox files wire protocol): a path to
        # {"data", "mode"} for a file or {"dir": True} for a folder; port_refused: nothing listens on a dialed port.
        self.files: dict[str, dict[str, Any]] = {"/": {"dir": True}}
        self.file_ops: list[dict[str, Any]] = []
        self.port_refused = False
        self.dialed: list[str] = []
        self.used: set[str] = set()
        self.seen: list[tuple[str, str, str]] = []
        self.errors: list[str] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_: Any) -> None:
                return

            def _body(self) -> bytes:
                return self.rfile.read(int(self.headers.get("content-length") or 0))

            def _answer(self) -> None:
                body = self._body()
                fake.seen.append((self.command, self.path, self.headers.get("authorization", "")))
                if self.headers.get("authorization") != "Bearer " + KEY:
                    fake.errors.append(f"{self.command} {self.path} without the key")
                if self.path.startswith("/relay/v1/computers/"):
                    fake.stream(self)
                    return
                if rest is not None:
                    rest(self, body)
                    return
                match = [n for n in RECORDED if WIRE["rest"][n]["method"] == self.command and WIRE["rest"][n]["path"] == self.path
                         and _json_equal(WIRE["rest"][n].get("body"), body)]
                if not match:
                    fake.errors.append(f"no recording for {self.command} {self.path} {body!r}")
                    self.send_response(418)
                    self.send_header("content-length", "0")
                    self.end_headers()
                    return
                name = next((m for m in match if m not in fake.used), match[-1])
                fake.used.add(name)
                call = WIRE["rest"][name]
                answer(self, call["status"], json.dumps(call["answer"]).encode())

            do_GET = do_POST = do_PUT = do_DELETE = _answer

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stream(self, h: BaseHTTPRequestHandler) -> None:
        if self.refuse:
            refusal = WIRE["refusals"][self.refuse]
            body = refusal["body"].encode()
            h.send_response(refusal["status"])
            h.send_header("content-type", refusal["content_type"])
            h.send_header("content-length", str(len(body)))
            h.send_header("connection", "close")
            h.end_headers()
            h.wfile.write(body)
            h.close_connection = True
            return
        if h.headers.get("sec-websocket-protocol") != "caveman.computer.v1" or h.headers.get("sec-websocket-version") != "13":
            self.errors.append(f"upgrade headers {dict(h.headers)}")
        accept = base64.b64encode(hashlib.sha1((h.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        h.wfile.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                       f"Sec-WebSocket-Accept: {accept}\r\nSec-WebSocket-Protocol: caveman.computer.v1\r\n\r\n").encode())
        h.wfile.flush()
        h.close_connection = True
        if "/dial/" in h.path:
            self.dial(h)
            return
        try:
            op, start = client_frame(h.rfile)
            if self.host_down > 0:
                self.host_down -= 1
                code = "cave_code_computer_host_unreachable"
                if self.host_down_output:
                    h.wfile.write(server_frame(2, b"\x01started\n"))
                h.wfile.write(server_frame(1, json.dumps({"type": "error", "code": code, "retry_after": self.retry_after,
                                                          "message": "the computer's host is not answering just now"}).encode()))
                h.wfile.write(server_frame(8, struct.pack(">H", 4503) + code.encode()))
                h.wfile.flush()
                h.connection.settimeout(2)
                while client_frame(h.rfile)[0] != 8:
                    continue
                return
            if h.path.endswith("/files"):
                self.file_op(h, json.loads(start))
                return
            name = self.replay or next((n for n, r in WIRE["exec"].items() if _json_equal(r["client"][0]["text"], start)), "")
            record = WIRE["exec"].get(name)
            if record is None:
                self.errors.append(f"no recording starts {start!r}")
                return
            if not self.replay:
                for want in record["client"][1:]:
                    op, payload = client_frame(h.rfile)
                    ok = (op == 2 and payload.decode() == want["stdin"]) if "stdin" in want else (op == 1 and _json_equal(want["text"], payload))
                    if not ok:
                        self.errors.append(f"{name}: client sent {op} {payload!r}; recorded {want}")
            for m in record["server"] if self.close_raw is None else []:
                if "text" in m:
                    h.wfile.write(server_frame(1, m["text"].encode()))
                else:
                    data = base64.b64decode(m["base64"]) if m.get("base64") else m.get("data", "").encode()
                    h.wfile.write(server_frame(2, bytes([m["channel"]]) + data))
            code = self.close_raw if self.close_raw is not None else record["close"]["code"]
            reason = "" if self.close_raw is not None else record["close"]["reason"]
            h.wfile.write(server_frame(8, struct.pack(">H", code) + reason.encode()))
            h.wfile.flush()
            h.connection.settimeout(2)
            while client_frame(h.rfile)[0] != 8:
                continue
        except (EOFError, OSError, socket.timeout):
            return

    def file_op(self, h: BaseHTTPRequestHandler, op: dict[str, Any]) -> None:
        self.file_ops.append(op)
        files, path = self.files, op["path"]
        at, parent = files.get(path), path.rsplit("/", 1)[0] or "/"

        def info(p: str, f: dict[str, Any]) -> dict[str, Any]:
            return {"name": p.rsplit("/", 1)[1] or "/", "type": "dir" if f.get("dir") else "file", "size": 0 if f.get("dir") else len(f["data"]),
                    "mode": f.get("mode") or (0o755 if f.get("dir") else 0o644), "mtime": "2026-11-20T05:00:00Z"}

        def send(v: dict[str, Any]) -> None:
            h.wfile.write(server_frame(1, json.dumps(v).encode()))

        closes = {"cave_code_computer_file_not_found": 4601, "cave_code_computer_file_exists": 4603, "cave_code_computer_file_refused": 4604}
        failed = ""

        def fail(code: str, message: str) -> None:
            nonlocal failed
            send({"type": "error", "code": code, "message": message})
            failed = code

        kind = op["op"]
        if kind == "read":
            if at is None or at.get("dir"):
                fail("cave_code_computer_file_refused" if at else "cave_code_computer_file_not_found", f"open {path}: {'is a directory' if at else 'no such file or directory'}")
            else:
                for i in range(0, len(at["data"]), 5):
                    h.wfile.write(server_frame(2, at["data"][i:i + 5]))
                send({"type": "file", "file": info(path, at)})
        elif kind == "write":
            parts = []
            while True:
                fop, payload = client_frame(h.rfile)
                if fop == 2:
                    parts.append(payload)
                elif fop == 1 and json.loads(payload)["type"] == "close_stdin":
                    break
            if not files.get(parent, {}).get("dir"):
                fail("cave_code_computer_file_not_found", f"open {path}: no such file or directory")
            else:
                files[path] = {"data": b"".join(parts), "mode": op.get("mode")}
                send({"type": "file", "file": info(path, files[path])})
        elif kind == "list":
            if not (at or {}).get("dir"):
                fail("cave_code_computer_file_not_found", f"open {path}: no such file or directory")
            else:
                prefix = "/" if path == "/" else path + "/"
                inside = [(p, f) for p, f in files.items() if p != path and p.startswith(prefix) and "/" not in p[len(prefix):]]
                for i in range(0, len(inside), 2):
                    send({"type": "entries", "entries": [info(p, f) for p, f in inside[i:i + 2]]})
                send({"type": "done"})
        elif kind == "stat":
            if at is None:
                fail("cave_code_computer_file_not_found", f"lstat {path}: no such file or directory")
            else:
                send({"type": "file", "file": info(path, at)})
        elif kind == "mkdir":
            if at is not None:
                fail("cave_code_computer_file_exists", f"mkdir {path}: file exists")
            else:
                files[path] = {"dir": True}
                send({"type": "done"})
        elif kind == "remove":
            if at is None:
                fail("cave_code_computer_file_not_found", f"remove {path}: no such file or directory")
            else:
                for p in [p for p in files if p == path or (op.get("all") and p.startswith(path + "/"))]:
                    del files[p]
                send({"type": "done"})
        elif kind == "rename":
            if at is None:
                fail("cave_code_computer_file_not_found", f"rename {path}: no such file or directory")
            else:
                files[op["to"]] = files.pop(path)
                send({"type": "done"})
        h.wfile.write(server_frame(8, struct.pack(">H", closes.get(failed, 4500) if failed else 1000) + failed.encode()))
        h.wfile.flush()
        h.connection.settimeout(2)
        while client_frame(h.rfile)[0] != 8:
            continue

    def dial(self, h: BaseHTTPRequestHandler) -> None:
        """A port that echoes what it is sent, upper-cased, and half-closes when the client does."""
        port = h.path.rsplit("/", 1)[1]
        self.dialed.append(port)
        try:
            if self.port_refused:
                code = "cave_code_computer_port_refused"
                h.wfile.write(server_frame(1, json.dumps({"type": "error", "code": code, "message": f"nothing listens on port {port}"}).encode()))
                h.wfile.write(server_frame(8, struct.pack(">H", 4606) + code.encode()))
                h.wfile.flush()
                h.connection.settimeout(2)
            while True:
                op, payload = client_frame(h.rfile)
                if op == 8:
                    return
                if op == 2 and not self.port_refused:
                    h.wfile.write(server_frame(2, payload.upper()))
                elif op == 1 and json.loads(payload)["type"] == "close_write" and not self.port_refused:
                    h.wfile.write(server_frame(1, json.dumps({"type": "close_write"}).encode()))
                    h.wfile.write(server_frame(8, struct.pack(">H", 1000)))
                    h.wfile.flush()
                    h.connection.settimeout(2)
        except (EOFError, OSError, socket.timeout):
            return

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def answer(h: BaseHTTPRequestHandler, status: int, body: bytes, headers: dict[str, str] | None = None) -> None:
    h.send_response(status)
    h.send_header("content-type", "application/json")
    h.send_header("content-length", str(len(body)))
    for k, v in (headers or {}).items():
        h.send_header(k, v)
    h.end_headers()
    h.wfile.write(body)
