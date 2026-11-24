# Changelog

## Unreleased

- `@caveman-ai/sdk/agents`: the Agents API client (`Agents`): start, list and read Caveman Code
  sessions, send them messages, interrupts and approvals, stream their events,
  and publish versioned agents, with a service account's `code:run` key.
- `Agents` applies, lists, reads and runs Cloud automations (`applyAutomations`,
  `runAutomation`, `listAutomationRuns` and the reads).
- `Agents` uploads, lists, downloads and deletes files (`uploadFile`,
  `downloadFile`, `listSessionFiles` for a session's outputs) and manages
  memory stores and their memories (`putMemory` with `if_sha256`,
  `listMemoryVersions`); `startSession` attaches both with `files` and
  `memory_stores`.
- `Eval`: a task call past `taskTimeoutMs` has its `context.signal` aborted
  before it is retried, so a task that hands the signal to `fetch` or its
  model SDK no longer runs twice against the agent. `signal` stops the eval:
  no new task call starts, calls in flight are aborted, and nothing is added.
- `cave.route()`, `cave.trim()` and `cave.compact()` call the gateway's route,
  trim-1 (compression of one payload) and compact-1 (compaction of a whole
  history) models; failures throw `CaveRequestError`.
- `Eval(name, {gatePolicy: "strict" | "kernel"})` stores the policy on the
  experiment, where the console and `cvm` read it too; `result.baseline` names
  the `policy` that decided and its `policySource`.
- A server that speaks another API version (`cave_operation_version_conflict`)
  is reported in one line that says to upgrade and how.
- `Eval(name, {data, task, criteria, …})` in `@caveman-ai/sdk/evals` runs a task
  locally and adds a run to the experiment of that name, on one dataset per
  name: outputs travel with the run, library criteria and inline graders
  (`{type: "contains", ...}`) are graded by Caveman, local criterion functions
  are recorded as untrusted evidence, and the verdict against the saved
  baseline is the server's. A task call that throws is retried (`retries`,
  default 2), `taskTimeoutMs` bounds one call, and an upload that fails writes
  what ran to a file that `uploadEvalResult` sends later.
- `cloud.prompts.get(slug, {environment | version, fallback})` resolves a
  promoted prompt with a 60 s cache, stale-on-error and a fallback;
  `get({prompt_id})` is unchanged.
- `optimize: { compress: "lossless" }` sends `x-cave-optimize: compress=lossless`:
  only the gateway's lossless tier, never the elision tier.
- `trace.tool` returns without waiting for its tool-event POST; `cave.trace`
  waits once for events still in flight before it settles.
  `CaveTrace.flushToolEvents()` does the same for a trace used afterwards.
  A trace has at most 4 tool-event POSTs in flight; later ones queue.
  `cave.trace` holds its result at most 5 s for them. An event the gateway
  did not take (429, 503) or could not be offered (connection refused) is
  sent again, up to 3 times; the first event that stays undelivered is
  logged with `console.warn`.

## 1.0.0 — 2026-07-26

- Recorded stable TypeScript SDK API and `/sdk/v1/*` wire baseline.
- Pinned coordinated-major and parity rules with Python SDK.
