# caveman

Stdlib-only Python client for Caveman gateway cooperation.

Distribution name: `caveman-sdk`. Import package: `caveman_cloud`. Install the
wheel directly from GitHub Releases:

```bash
python -m pip install https://github.com/caveman-ai/cloud-sdk/releases/download/v2.0.0/caveman_sdk-2.0.0-py3-none-any.whl
```

Requires Python 3.13 or newer.

For editable work from this source directory, use `python -m pip install -e .`.

```python
import os
from caveman_cloud import Cave

cave = Cave(
    api_key=os.environ["CAVE_API_KEY"],
    base_url="http://127.0.0.1:8787",
    agent="support-agent",
)

result = cave.compress("large payload")
print(result.output, result.basis)  # basis is inferred
```

## Per-request control

Optimizations are a project-level setting. A single request can ask for an optimization or disable it. The gateway
checks the project policy, capability, and evidence gate before applying any
opt-in; a request never grants itself permission.

```python
# Pass this one request through byte-identical.
cave.openai().responses.create(body, optimize="off")

# Or switch individual optimizations off: -> x-cave-optimize: no-compress,no-cache
cave.openai().responses.create(body, optimize={"compress": False, "cache_hints": False})
```

`{"compress": True}` requests compression; `{"compress": False}` disables it.
Read the response receipt to distinguish applied and denied requests.
Unknown tokens are rejected by the gateway with 400
`cave_invalid_optimize_override`; nothing is guessed.

Model routing is chosen by the model name: send `model="cave-auto"` and the
project's router picks the model that answers, on every request. A named model
is kept. If the project has nothing to route from (no provider connection or
baseline model), the gateway returns 400 `cave_routing_not_enabled` naming what
is missing instead of forwarding `cave-auto` upstream.

Every response carries the gateway's per-call disclosure headers.
`parse_receipt` reads them; a header the gateway did not send stays `None`,
never defaulted:

```python
from caveman_cloud import parse_receipt

receipt = parse_receipt(response.headers)  # any urllib response, dict, or pairs
# Receipt(mode, optimizations, cache_status, request_id,
#         compression_ratio, tokens_before, tokens_after, recovery_handle)
```

`tokens_before`/`tokens_after` are inferred estimates from the compressor's
counter, not provider counts, and `recovery_handle` retrieves the byte-exact
original.

Main surfaces: provider clients, `compress`, deferred tool search, reversible
checkpoints and artifacts, retry-loop interruption, runtime policy, and a
stdlib-only OTLP/JSON exporter. Async jobs are reserved and fail locally with
`cave_async_jobs_unavailable`; they send no request.

Package is MIT licensed. Connected calls need a Caveman gateway key; local Engine
compression remains accountless and ships through the separate Caveman runtime.

See [Python SDK documentation](https://caveman.so/docs/sdk/python).

OTLP exporters flush explicitly with `export()` or `flush()`. Each request holds
at most 10,000 spans and 4 MiB of encoded JSON. Failed exports retain unsent
spans for caller retries; a single oversized span raises an error and stays
buffered. Trace exporters inherit the trace workflow, and individual spans can
override it. Partial-success rejections remain visible in the returned response.

## Models: route, trim and compact

Three Caveman models on the same gateway, base URL and key. `trim` is
compression of one payload against a query; `compact` is compaction of a whole
message history to a token budget. Each is an explicit model call: a non-2xx
answer raises `CaveRequestError` with `status`, `code` (such as
`cave_model_allowance_exhausted` or `cave_rate_limit_exceeded`), `message` and
`request_id`. Unlike `compress`, nothing passes through.

```python
from caveman_cloud import CaveRequestError

# route: which model, and effort, should take this task (key scope router:write).
decision = cave.route({"text": "Rename the helper and update its callers.", "models": ["claude-sonnet-4-5", "gpt-5-mini"]})
# {"model", "effort", "reason", "router_version", ...any further fields}

# trim: trim-1 cuts what the query does not need from one payload (scope sdk:write).
trimmed = cave.trim(tool_output, "why did the job fail?", level="aggressive")
# TrimResult(output, tokens_before, tokens_after, model="trim-1", recovery_handle)

# compact: compact-1 fits a whole OpenAI or Anthropic history into a budget (scope sdk:write).
try:
    compacted = cave.compact(messages, budget_tokens=8000)
except CaveRequestError as error:
    print(error.status, error.code, error.request_id)
# CompactResult(messages (same shape as the input), tokens_before, tokens_after, model="compact-1", recovery_handles)
```

For `compact`, the budget and the token counts exclude the leading system
messages. Recovery handles are `None` when nothing was stored, which includes
requests under `metadata` or `zdr` retention. The client sends `metadata` unless
you pass `retention="configured"`, so set that to get handles.

## Cloud control-plane resources

```python
from caveman_cloud import Cloud
cloud = Cloud(control_url=control_url, access_token=access_token, project_id=project_id)
suites = cloud.scenario_suites.list()
result = cloud.evals.result({"workbench_id": workbench_id, "run_id": run_id})
if result["data"]["quality"]["status"] != "passed":
    raise RuntimeError("Evaluation did not pass")
```

Typed resource inputs/results are generated from the reviewed operation catalog.
Use a Cloud access token, separate from gateway inference keys. Server permissions
remain authoritative. Receipted writes need `idempotency_key=`; no write is retried
automatically. Accepted work is not a passing result. See the
[Cloud SDK guide](../../../cloud/web/app/docs/cloud-sdk/page.mdx).

`Cave.jobs` is deprecated and unavailable: methods fail locally with
`cave_async_jobs_unavailable`. Use specific eval/scenario/native-run resources.

## Run Caveman Code agents (Agents API)

```python
import os, uuid
from caveman_cloud import Agents

agents = Agents(control_url="https://api.caveman.so", api_key=os.environ["CAVEMAN_CODE_KEY"])
session = agents.start_session({"request_id": str(uuid.uuid4()), "repo": "acme/api", "task": "Fix the flaky test"})
for event in agents.stream_events(session["id"]):
    print(event["type"], event["data"])
```

The key is a service account's `code:run` key (Settings > Service accounts); it
sees and drives only that account's sessions. A stream ends after 15 minutes:
call `stream_events` again with `after=` the last seq to continue.

Files and memory stores go with a session. An uploaded file mounts read-only at
`/mnt/session/uploads/<name>`; a memory store attached `read_only` refuses
writes from the session.

```python
file = agents.upload_file("spec.md", b"# Spec", media_type="text/markdown")
store = agents.create_memory_store({"name": "api conventions"})
agents.start_session({"request_id": str(uuid.uuid4()), "repo": "acme/api", "task": "Follow the spec",
                      "files": [file["id"]], "memory_stores": [{"id": store["id"], "access": "read_only"}]})
```

## Sandboxes: run commands in a Cloud computer

```python
import os
from caveman_cloud import Sandboxes

sandboxes = Sandboxes(control_url="https://app.caveman.so", api_key=os.environ["CAVE_TOKEN"])
box = sandboxes.create({"name": "quickstart-py"})
sandboxes.wait(box["id"], "running")
result = sandboxes.run(box["id"], ["sh", "-c", "echo hello from the sandbox; echo careful >&2; exit 3"])
# result: ExecResult(exit_code=3, stdout=b"hello from the sandbox\n", stderr=b"careful\n")
sandboxes.delete(box["id"])
```

The key is an organization's `code:run` key; it sees only the sandboxes its
service account made. `exec(id, argv, stdin=..., stdout=..., stderr=..., tty=...)`
streams instead of collecting; `sleep`, `resume`, `list` and `get` are the rest.
A command takes `env`, `cwd` (absolute), `user`, and with `tty` its terminal's
`cols` and `rows`; a `SandboxCommand` passed as `control` resizes its terminal
(`resize(cols, rows)`) and sends it a signal (`send_signal("TERM")`) while it
runs. A resize or a signal the sandbox does not act on comes to `on_refused` as a
`SandboxRefusal`, and the command goes on; a sandbox that takes no options refuses
a start asking for one (`cave_code_computer_unsupported`).
`status()` reads whether sandboxes work right now, where the Cloud publishes it
(GET /api/v1/status/sandboxes: public, so the key is ignored there).
`wait(id, state)` is one read the API holds until the state (up to a minute at a
time, one request to its rate limits); a Caveman Cloud that does not wait is polled.
`list` answers a page, newest first: ask again with `cursor=page["next_cursor"]`
until `next_cursor` is None (`limit` sets the page's size, at most 500).
A refusal is a `SandboxError` (the API's code, such as `cave_not_found`), a
command's stream that ends without an exit a `SandboxExecError` (such as
`cave_code_computer_not_running`). The stream is a WebSocket on the relay at `relay_url` (default
`control_url`), spoken with the standard library: no proxy is used. Sandboxes
are behind the installation's `computers.api.enabled` switch. A command whose sandbox's host is
restarting (`cave_code_computer_host_unreachable`) is opened again for up to 15 seconds before it starts,
when its stdin is none, text or bytes. `wait` reads a sandbox's `observed_reason_code` beside its sentence:
it waits on through one that passes by itself (`waiting_for_capacity`, `host_unavailable`, ...: see
`SANDBOX_REASONS`), even while the sandbox reads failed, and raises `SandboxStateError` on one that needs
you (`stopped_by_host`, `out_of_memory`, ...).

```python
sandboxes.write_file(box["id"], "/tmp/in.txt", "hello")
text = sandboxes.read_file(box["id"], "/tmp/in.txt").decode()
names = [f["name"] for f in sandboxes.list_files(box["id"], "/tmp")]
with sandboxes.dial_port(box["id"], 8080) as web:  # a TCP connection to the sandbox's own port 8080
    web.write(b"GET / HTTP/1.0\r\n\r\n")
    page = b"".join(web)
```

A sandbox's files are read and written as streams through the relay, one operation each
(`read_file`, `stream_file`, `write_file` with `mode` and `atomic`, `list_files`, `stat_file`,
`make_dir`, `remove_file`, `rename_file`; `root=True` acts as the sandbox's root). What its file
system refuses is a `SandboxFileError` (`cave_code_computer_file_not_found`, `_permission`,
`_exists`, `_too_large`, `_refused`, with the system's words). `dial_port` reaches a port on the
sandbox's loopback only: `read` (or iterate) it for the bytes back, `write`, `close_write` and
`close` it; nothing listening is `cave_code_computer_port_refused`.

### Snapshots

```python
snap = sandboxes.snapshot(box["id"], {"name": "after setup"})   # a copy of its disk, taking
sandboxes.wait_for_snapshot(box["id"], snap["id"])              # until ready
child = sandboxes.fork(box["id"], snap["id"], {"name": "try-2"})  # a new sandbox made from it
sandboxes.wait(child["id"], "running")
sandboxes.restore(box["id"], snap["id"])                        # put it back under the sandbox it was taken of
sandboxes.wait_for_restore(box["id"], snap["id"])
sandboxes.delete_snapshot(box["id"], snap["id"])
```

A snapshot is its taker's alone: the key whose service account made the sandbox sees, restores,
forks and deletes it (`list_snapshots`, `get_snapshot`). A restore ends the sandbox's processes and
starts it again on the snapshot's disk, only on the host that keeps the snapshot (else
`snapshot_elsewhere`: fork it instead). A snapshot that failed, or a restore that failed, raises
`SnapshotStateError` from the wait, its `reason_code` saying why; what the installation cannot do
is refused at once (`cave_code_computer_unsupported`).

Where the Caveman Cloud serves ports at their own URLs (`https://<port>-<sandbox>.<domain>`),
`url` answers one: a port is private until its sandbox's maker makes it public.

```python
web = sandboxes.url(box["id"], 3000)  # SandboxPortURL: url, link, headers, expires_at, ...
page = urllib.request.urlopen(urllib.request.Request(web.url, headers=web.headers)).read()
print(web.link)  # a person opens this in a browser, within minutes
sandboxes.url(box["id"], 3000, public=True)  # anyone with the address, no token
```

`ttl_seconds` (60 to 86400, an hour by default) is how long the token, and the cookie a link
leaves, open the port. `ports`, `set_port` and `port_token` are the plain calls under it.

## Run an eval from your code

`Eval` runs your task here and adds a run to the experiment of that name. The
same name is the same experiment and the same dataset every time, so runs line
up and the server can compare them.

```python
from caveman_cloud import Cloud, Eval

def contains_expected(*, output, expected, **_):
    return str(expected) in str(output)

result = Eval(
    "support-reply",
    cloud=Cloud(control_url=control_url, access_token=access_token, project_id=project_id),
    data=[{"input": "Where is my order?", "expected": "tracking link"}],  # or {"dataset": "Support cases", "version": 2, "split": "test"}
    task=lambda question, context: answer(question, context["trace_id"]),  # sync or async; task(input) also works
    criteria=["Grounded", {"type": "contains", "fragments": ["tracking"]}, contains_expected],
    trials=3,
    console_url="https://console.example",  # prints a link to the experiment
)
```

- **Who grades what.** A string names a criterion of your library (id or name).
  A dict with `"type"` is an inline grader (`contains`, `tool_called`,
  `json_schema`, ...; every other key is one of its options, `"name"` its
  label). Caveman grades both in the run and both decide `passed`
  (`graded_by: "caveman"`, `summary["server"]`). A function is a local
  criterion: it runs here, is uploaded as external evidence, and is never
  trusted and never gates (`graded_by: "local"`, `summary["local"]["trusted"]` is `False`).
- **What is kept.** Inline rows are the dataset named like the eval: unchanged
  rows reuse its version, changed rows cut the next one. A stored dataset is
  used as it is. The experiment has one external step, so each output belongs
  to its run, labelled as produced by your task and not by Caveman. `trials`
  are trials of one case. The upload needs `eval:write`, `experiment:run` and
  `payload:read`; an agent connection also names `budget_usd`.
- **Baseline.** The run is read against the experiment's saved baseline, or
  `baseline={"run_id": ...}`, by the server: `result["baseline"]` holds its
  verdict (`passed`, `failed`, `need_more_data` or `incomplete`), its one-line
  summary and the changed cases. A `failed` verdict fails the eval. With no
  baseline saved it is `None`; a run the server cannot compare says why.
  `gate_policy="strict"` (or `"kernel"`) is stored on the experiment, so the
  console and `cvm` read the comparison by the same rule; `result["baseline"]`
  names the `policy` that decided.
- **Traces.** Each task call gets a fresh trace id (`context["trace_id"]`, also
  on the row). Pass `cave=` and the task runs inside `cave.trace` with that id,
  as `context["trace"]`; otherwise open `cave.trace(trace_id=...)` yourself.
- **Dry run.** `dry_run=True` writes nothing and, with inline rows, makes no
  request. Server criteria are then not graded and `passed` is `None`.
- **Retries and timeouts.** A task call that raises is tried again, twice by
  default (`retries`), and the row carries its `attempts`. A failed verdict is
  never retried. `task_timeout_seconds` fails a call that runs past it and
  sets its `context["cancel_event"]` (a `threading.Event`) before it is tried
  again. Python cannot stop a call, so a task that should stop checks the
  event; one that ignores it is left to finish on its thread.
- **Cancelling.** `cancel_event=threading.Event()` stops the eval once set: no
  task call starts after it, the calls in flight have their context's event
  set, and `Eval` raises `concurrent.futures.CancelledError` without adding a
  run.
- **Progress.** `on_progress` gets `start`, `row`, `upload`, `grading` and
  `done` events; the same lines go to stderr unless `quiet=True`.
- **Failures.** A criterion or grader Caveman does not know, or a missing
  permission, stops the eval before the task runs. An upload that fails after
  it ran raises `EvalUploadError`: `error.result` holds what ran and
  `error.saved_path` names the file it was written to (`results_dir`, default
  the working directory). `upload_eval_result(path, cloud=cloud)` sends it
  later without running the task again.

Tasks run on worker threads (`concurrency`, default 4). Under pytest, assert on
the result; `Eval` never exits the process:

```python
def test_support_replies_stay_grounded(cloud):
    result = Eval("support-reply", cloud=cloud, data=DATA, task=answer, criteria=["Grounded"], quiet=True)
    assert result["passed"] is True, result["summary"]
```

## Prompts by name

```python
prompt = cloud.prompts.get("support-reply", environment="staging")  # or version=3; default environment "production"
texts = prompt.render({"question": question})  # raises on a variable with no value
headers = {**gateway_headers(...), **prompt.headers()}
```

`prompt.source` says where it came from: `server`, `cache` (answers are kept
60 s, `prompt_cache_ttl_seconds` on `Cloud`), `stale` (the refresh failed, so
the last good value is served) or `fallback` (nothing cached and you passed
`fallback={"user_text": ...}`). With neither, the error is raised.
`prompt.headers()` is `x-cave-tags: cave.prompt.id=…,cave.prompt.version=…,cave.prompt.environment=…`,
which makes the gateway record the prompt version on the call.
`cloud.prompts.get({"prompt_id": ...})` is unchanged: the read by id.

The gateway can also do the substitution: send `x-cave-prompt: <slug>@<environment>`
(and optionally `x-cave-prompt-variables: <JSON object of strings>`) on a model
call. If the prompt cannot be resolved, the gateway sends your own messages.
