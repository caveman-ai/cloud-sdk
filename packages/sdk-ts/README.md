# @caveman-ai/sdk

Zero-runtime-dependency TypeScript client for Caveman gateway cooperation.

```bash
npm install @caveman-ai/sdk
```

```ts
import { Cave } from "@caveman-ai/sdk";

const cave = new Cave({
  apiKey: process.env.CAVE_API_KEY!,
  baseURL: "http://127.0.0.1:8787",
  agent: "support-agent",
});

const result = await cave.compress("large payload");
console.log(result.output, result.basis); // basis is inferred
```

## Per-request control

Optimizations are a project-level setting. A single request can ask for an optimization or disable it. The gateway
checks the project policy, capability, and evidence gate before applying any
opt-in; a request never grants itself permission.

```ts
// Pass this one request through byte-identical.
await cave.openai().responses.create(body, { cave: { optimize: "off" } });

// Or switch individual optimizations off: → x-cave-optimize: no-compress,no-cache
await cave.openai().responses.create(body, { cave: { optimize: { compress: false, cacheHints: false } } });
```

`{ compress: true }` requests compression; `{ compress: false }` disables it.
Read the response receipt to distinguish applied and denied requests.
Unknown tokens are rejected by the gateway with 400
`cave_invalid_optimize_override`; nothing is guessed.

Model routing is chosen by the model name: send `model: "cave-auto"` and the
project's router picks the model that answers, on every request. A named model
is kept. If the project has nothing to route from (no provider connection or
baseline model), the gateway returns 400 `cave_routing_not_enabled` naming what
is missing instead of forwarding `cave-auto` upstream.

Every response carries the gateway's per-call disclosure headers. `parseReceipt`
reads them; a header the gateway did not send stays absent, never defaulted:

```ts
import { parseReceipt } from "@caveman-ai/sdk";

const response = await cave.openai().raw("/v1/responses", { method: "POST", body });
const receipt = parseReceipt(response.headers);
// { mode, optimizations, cacheStatus, requestId, compressionRatio?, tokensBefore?, tokensAfter?, recoveryHandle? }
```

`tokensBefore`/`tokensAfter` are inferred estimates from the compressor's
counter, not provider counts, and `recoveryHandle` retrieves the byte-exact
original.

Main surfaces: provider clients, `compress`, deferred tool search, reversible
checkpoints and artifacts, retry-loop interruption, runtime policy, and a
dependency-free OTLP/JSON exporter. Async jobs are reserved and fail locally
with `cave_async_jobs_unavailable`; they send no request.

Requires Node.js 22.13 or newer. Package is MIT licensed. Connected calls need
a Caveman gateway key; local Engine compression remains accountless and ships
through the separate Caveman runtime.

See [TypeScript SDK documentation](https://caveman.so/docs/sdk/typescript).

OTLP exporters flush explicitly with `export()` or `flush()`. Each request holds
at most 10,000 spans and 4 MiB of encoded JSON. Failed exports retain unsent
spans for caller retries; a single oversized span raises an error and stays
buffered. Trace exporters inherit the trace workflow, and individual spans can
override it. Partial-success rejections remain visible in the returned response.

## Models: route, trim and compact

Three Caveman models on the same gateway, base URL and key. `trim` is
compression of one payload against a query; `compact` is compaction of a whole
message history to a token budget. Each is an explicit model call: a non-2xx
answer throws `CaveRequestError` with `status`, `code` (such as
`cave_model_allowance_exhausted` or `cave_rate_limit_exceeded`), `message` and
`requestId`. Unlike `compress`, nothing passes through.

```ts
// route: which model, and effort, should take this task (key scope router:write).
const decision = await cave.route({ text: "Rename the helper and update its callers.", models: ["claude-sonnet-4-5", "gpt-5-mini"] });
// { model, effort, reason, router_version, ...any further fields }

// trim: trim-1 cuts what the query does not need from one payload (scope sdk:write).
const trimmed = await cave.trim(toolOutput, "why did the job fail?", { level: "aggressive" });
// { output, tokensBefore, tokensAfter, recoveryHandle?, model: "trim-1" }

// compact: compact-1 fits a whole OpenAI or Anthropic history into a budget (scope sdk:write).
const compacted = await cave.compact(messages, { budgetTokens: 8000 });
// { messages (same shape as the input), tokensBefore, tokensAfter, recoveryHandles?, model: "compact-1" }
```

For `compact`, the budget and the token counts exclude the leading system
messages. Recovery handles are absent when nothing was stored, which includes
requests under `metadata` or `zdr` retention. The client sends `metadata` unless
you pass `retention: "configured"`, so set that to get handles.

## Cloud control-plane resources

```ts
import { Cloud } from '@caveman-ai/sdk/cloud';
const cloud = new Cloud({controlURL, accessToken, projectId});
const suites = await cloud.scenarioSuites.list();
const result = await cloud.evals.result({workbench_id, run_id});
if (result.data.quality.status !== 'passed') throw new Error('Evaluation did not pass');
```

Generated typed resources cover the reviewed operation catalog. They use the
control URL and a Cloud access token, separate from gateway inference keys.
Server permissions remain authoritative. Receipted writes need an explicit
`{idempotencyKey}`; no write is automatically retried. Accepted work is not a
passing result. See the [Cloud SDK guide](../../../cloud/web/app/docs/cloud-sdk/page.mdx).

`Cave.jobs` is deprecated and unavailable: methods fail locally with
`cave_async_jobs_unavailable`. Use specific eval/scenario/native-run resources.

## Run Caveman Code agents (Agents API)

```ts
import { Agents } from '@caveman-ai/sdk/agents';
const agents = new Agents({controlURL: 'https://api.caveman.so', apiKey: process.env.CAVEMAN_CODE_KEY!});
const session = await agents.startSession({request_id: crypto.randomUUID(), repo: 'acme/api', task: 'Fix the flaky test'});
for await (const event of agents.streamEvents(session.id)) console.log(event.type, event.data);
await agents.sendEvent(session.id, {request_id: crypto.randomUUID(), type: 'user.message', text: 'Also update the changelog.'});
```

The key is a service account's `code:run` key (Settings > Service accounts); it
sees and drives only that account's sessions. Each session runs on its own
Cloud computer. A stream ends after 15 minutes: call `streamEvents` again with
`{after: lastSeq}` to continue.

Files and memory stores go with a session. An uploaded file mounts read-only at
`/mnt/session/uploads/<name>`; a memory store attached `read_only` refuses
writes from the session.

```ts
const file = await agents.uploadFile('spec.md', new TextEncoder().encode('# Spec'), {mediaType: 'text/markdown'});
const store = await agents.createMemoryStore({name: 'api conventions'});
await agents.startSession({request_id: crypto.randomUUID(), repo: 'acme/api', task: 'Follow the spec',
  files: [file.id], memory_stores: [{id: store.id, access: 'read_only'}]});
```

## Sandboxes: run commands in a Cloud computer

```ts
import { Sandboxes } from '@caveman-ai/sdk/sandboxes';
const sandboxes = new Sandboxes({controlURL: 'https://app.caveman.so', apiKey: process.env.CAVE_TOKEN!});
const box = await sandboxes.create({name: 'quickstart-ts'});
await sandboxes.waitFor(box.id, 'running');
const result = await sandboxes.run(box.id, ['sh', '-c', 'echo hello from the sandbox; echo careful >&2; exit 3']);
// result: {exitCode: 3, stdout: 'hello from the sandbox\n', stderr: 'careful\n'}
await sandboxes.delete(box.id);
```

The key is an organization's `code:run` key; it sees only the sandboxes its
service account made. `exec(id, argv, {stdin, stdout, stderr, tty, signal})`
streams instead of collecting; `sleep`, `resume`, `list` and `get` are the rest.
A command takes `env`, `cwd` (absolute), `user`, and with `tty` its terminal's
`cols` and `rows`; a `SandboxCommand` passed as `control` resizes its terminal
(`resize(cols, rows)`) and sends it a signal (`sendSignal('TERM')`) while it runs.
A resize or a signal the sandbox does not act on comes to `onRefused`, and the
command goes on; a sandbox that takes no options refuses a start asking for one
(`cave_code_computer_unsupported`).
`status()` reads whether sandboxes work right now, where the Cloud publishes it
(GET /api/v1/status/sandboxes: public, so the key is ignored there).
`waitFor(id, state)` is one read the API holds until the state (up to a minute
at a time, one request to its rate limits); a Caveman Cloud that does not wait is polled.
`list` answers a page, newest first: ask again with `{cursor: page.next_cursor}`
until `next_cursor` is null (`limit` sets the page's size, at most 500).
A refusal is a `SandboxError` (the API's code, such as `cave_not_found`), a
command's stream that ends without an exit a `SandboxExecError` (such as
`cave_code_computer_not_running`). A command's stream needs Node and reaches the relay at
`relayURL` (default `controlURL`). Sandboxes are behind the installation's
`computers.api.enabled` switch. A command whose sandbox's host is restarting
(`cave_code_computer_host_unreachable`) is opened again for up to 15 seconds
before it starts, when its stdin is none, text or bytes. `waitFor` reads a
sandbox's `observed_reason_code` beside its sentence: it waits on through one
that passes by itself (`waiting_for_capacity`, `host_unavailable`, ...: see
`sandboxReasons`), even while the sandbox reads failed, and ends with a
`SandboxStateError` on one that needs you (`stopped_by_host`, `out_of_memory`, ...).

```ts
await sandboxes.writeFile(box.id, '/tmp/in.txt', 'hello');
const text = new TextDecoder().decode(await sandboxes.readFile(box.id, '/tmp/in.txt'));
const names = (await sandboxes.listFiles(box.id, '/tmp')).map(f => f.name);
const web = await sandboxes.dialPort(box.id, 8080); // a TCP connection to the sandbox's own port 8080
```

A sandbox's files are read and written as streams through the relay, one operation each
(`readFile`, `streamFile`, `writeFile` with `mode` and `atomic`, `listFiles`, `statFile`,
`makeDir`, `removeFile`, `renameFile`; `root: true` acts as the sandbox's root). What its file
system refuses is a `SandboxFileError` (`cave_code_computer_file_not_found`, `_permission`,
`_exists`, `_too_large`, `_refused`, with the system's words). `dialPort` reaches a port on the
sandbox's loopback only: iterate it for the bytes back, `write`, `closeWrite` and `close` it;
nothing listening is `cave_code_computer_port_refused`.

### Snapshots

```ts
const snap = await sandboxes.snapshot(box.id, {name: 'after setup'});
await sandboxes.waitForSnapshot(box.id, snap.id);               // taking -> ready
const child = await sandboxes.fork(box.id, snap.id, {name: 'try-2'}); // a new sandbox from its disk
await sandboxes.waitFor(child.id, 'running');
await sandboxes.restore(box.id, snap.id);                        // the sandbox back on the snapshot's disk
await sandboxes.waitForRestore(box.id, snap.id);
const {snapshots} = await sandboxes.listSnapshots(box.id);
await sandboxes.deleteSnapshot(box.id, snap.id);
```

A snapshot is a copy of a sandbox's disk, kept on the host that took it; only the key whose
service account made the sandbox sees it. `fork` makes a new sandbox from it (the same body as
`create`; the snapshot's size unless asked); `restore` puts it back under the sandbox it was taken
of, ending its processes, and only where the snapshot is kept (one that moved is refused
`cave_code_computer_unsupported`: fork instead). `waitForSnapshot` and `waitForRestore` read
until it is ready or restored; a failed take or restore, or a deleted snapshot, ends the wait with
a `SnapshotStateError` whose `snapshot` says why (`reason_code`, `restore.reason_code`).
`getSnapshot` reads one; `deleteSnapshot` is safe to repeat. Each caller keeps at most 32 at once
(`cave_code_computer_limit_snapshots`).

Where the Caveman Cloud serves ports at their own URLs (`https://<port>-<sandbox>.<domain>`),
`url` answers one: a port is private until its sandbox's maker makes it public.

```ts
const web = await sandboxes.url(box.id, 3000);           // {url, link, headers, expiresAt, ...}
await fetch(web.url, {headers: web.headers});            // a program sends Caveman-Port-Token
console.log(web.link);                                   // a person opens this in a browser, within minutes
await sandboxes.url(box.id, 3000, {public: true});       // anyone with the address, no token
```

`ttlSeconds` (60 to 86400, an hour by default) is how long the token, and the cookie a link
leaves, open the port. `ports`, `setPort` and `portToken` are the plain calls under it.

## Run an eval from your code

`Eval` runs your task here and adds a run to the experiment of that name. The
same name is the same experiment and the same dataset every time, so runs line
up and the server can compare them.

```ts
import { Cloud } from '@caveman-ai/sdk/cloud';
import { Eval } from '@caveman-ai/sdk/evals';

const result = await Eval('support-reply', {
  cloud: new Cloud({controlURL, accessToken, projectId}),
  data: [{input: 'Where is my order?', expected: 'tracking link'}], // or {dataset: 'Support cases', version: 2, split: 'test'}
  task: async (input, {traceId}) => answer(input, traceId),
  criteria: ['Grounded', {type: 'contains', fragments: ['tracking']}, ({output, expected}) => String(output).includes(String(expected))],
  trials: 3,
  consoleURL: 'https://console.example', // prints a link to the experiment
});
```

- **Who grades what.** A string names a criterion of your library (id or name).
  An object with `type` is an inline grader (`contains`, `tool_called`,
  `json_schema`, ...; every other key is one of its options, `name` its label).
  Caveman grades both in the run and both decide `passed`
  (`gradedBy: "caveman"`, `summary.server`). A function is a local criterion:
  it runs here, is uploaded as external evidence, and is never trusted and
  never gates (`gradedBy: "local"`, `summary.local.trusted: false`).
- **What is kept.** Inline rows are the dataset named like the eval: unchanged
  rows reuse its version, changed rows cut the next one. A stored dataset is
  used as it is. The experiment has one external step, so each output belongs
  to its run, labelled as produced by your task and not by Caveman. `trials`
  are trials of one case. The upload needs `eval:write`, `experiment:run` and
  `payload:read`; an agent connection also names `budgetUSD`.
- **Baseline.** The run is read against the experiment's saved baseline, or
  `baseline: {runId}`, by the server: `result.baseline` holds its verdict
  (`passed`, `failed`, `need_more_data` or `incomplete`), its one-line summary
  and the changed cases. A `failed` verdict fails the eval. With no baseline
  saved it is `null`; a run the server cannot compare says why.
  `gatePolicy: "strict"` (or `"kernel"`) is stored on the experiment, so the
  console and `cvm` read the comparison by the same rule; `result.baseline`
  names the `policy` that decided.
- **Traces.** Each task call gets a fresh trace id (`context.traceId`, also on
  the row). Pass `cave` and the task runs inside `cave.trace` with that id, as
  `context.trace`; otherwise send it yourself with `cave.trace({traceId}, …)`.
- **Dry run.** `dryRun: true` writes nothing and, with inline rows, makes no
  request. Server criteria are then not graded and `passed` is `null`.
- **Retries and timeouts.** A task call that throws is tried again, twice by
  default (`retries`), and the row carries its `attempts`. A failed verdict is
  never retried. `taskTimeoutMs` fails a call that runs past it and aborts
  its `context.signal` before it is tried again: hand the signal to `fetch`
  or the model SDK and the call stops there (one that ignores it runs on).
- **Stopping.** `signal` (an `AbortSignal`) stops the eval: no task call
  starts after it aborts, the calls in flight see their `context.signal`
  abort, and `Eval` rejects with its reason without adding a run.
- **Progress.** `onProgress` gets `start`, `row`, `upload`, `grading` and `done`
  events; the same lines go to stderr unless `quiet`.
- **Failures.** A criterion or grader Caveman does not know, or a missing
  permission, stops the eval before the task runs. An upload that fails after
  it ran throws `EvalUploadError`: `error.result` holds what ran and
  `error.savedPath` names the file it was written to (`resultsDir`, default
  the working directory). `uploadEvalResult(path, {cloud})` sends it later
  without running the task again.

In a test (vitest, jest, `node:test`), assert on the result; `Eval` never exits
the process:

```ts
test('support replies stay grounded', async () => {
  const result = await Eval('support-reply', {cloud, data, task, criteria: ['Grounded'], quiet: true});
  expect(result.passed).toBe(true);
}, 600_000);
```

## Prompts by name

```ts
const prompt = await cloud.prompts.get('support-reply', {environment: 'staging'}); // or {version: 3}; default environment "production"
const {system_text, user_text} = prompt.render({question}); // throws on a variable with no value
await fetch(gatewayURL, {headers: {...gatewayHeaders(options), ...prompt.headers()}, …});
```

`prompt.source` says where it came from: `server`, `cache` (answers are kept
60 s, `promptCacheTtlMs` on `Cloud`), `stale` (the refresh failed, so the last
good value is served) or `fallback` (nothing cached and you passed
`{fallback: {user_text, …}}`). With neither, the error is thrown.
`prompt.headers()` is `x-cave-tags: cave.prompt.id=…,cave.prompt.version=…,cave.prompt.environment=…`,
which makes the gateway record the prompt version on the call.
`cloud.prompts.get({prompt_id})` is unchanged: the read by id.

The gateway can also do the substitution: send `x-cave-prompt: <slug>@<environment>`
(and optionally `x-cave-prompt-variables: <JSON object of strings>`) on a model
call. If the prompt cannot be resolved, the gateway sends your own messages.
