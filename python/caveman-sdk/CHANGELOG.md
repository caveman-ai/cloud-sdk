# Changelog

## Unreleased

- `caveman_cloud.Agents`: the Agents API client: start, list and read Caveman
  Code sessions, send them messages, interrupts and approvals, stream their
  events, and publish versioned agents, with a service account's `code:run` key.
- `caveman_cloud.Agents` applies, lists, reads and runs Cloud automations
  (`apply_automations`, `run_automation`, `list_automation_runs` and the reads).
- `caveman_cloud.Agents` uploads, lists, downloads and deletes files
  (`upload_file`, `download_file`, `list_session_files` for a session's
  outputs) and manages memory stores and their memories (`put_memory` with
  `if_sha256`, `list_memory_versions`); `start_session` attaches both with
  `files` and `memory_stores`.
- `Eval`: a task call past `task_timeout_seconds` has its
  `context["cancel_event"]` set before it is retried, so a task that checks it
  stops instead of running twice against the agent. `cancel_event=` stops the
  eval: no new task call starts, calls in flight are told to stop, and
  `Eval` raises `CancelledError` without adding a run.
- `cave.route()`, `cave.trim()` and `cave.compact()` call the gateway's route,
  trim-1 (compression of one payload) and compact-1 (compaction of a whole
  history) models; failures raise `CaveRequestError`.
- `Eval(..., gate_policy="strict" | "kernel")` stores the policy on the
  experiment, where the console and `cvm` read it too; `result["baseline"]`
  names the `policy` that decided and its `policy_source`.
- A server that speaks another API version (`cave_operation_version_conflict`)
  is reported in one line that says to upgrade and how.
- `Eval(name, data=, task=, criteria=, …)` runs a task locally and adds a run to
  the experiment of that name, on one dataset per name: outputs travel with the
  run, library criteria and inline graders (`{"type": "contains", ...}`) are
  graded by Caveman, local criterion functions are recorded as untrusted
  evidence, and the verdict against the saved baseline is the server's. A task
  call that raises is retried (`retries`, default 2), `task_timeout_seconds`
  bounds one call, and an upload that fails writes what ran to a file that
  `upload_eval_result` sends later.
- `cloud.prompts.get(slug, environment= | version=, fallback=)` resolves a
  promoted prompt with a 60 s cache, stale-on-error and a fallback;
  `get({"prompt_id": ...})` is unchanged.
- `optimize={"compress": "lossless"}` sends `x-cave-optimize: compress=lossless`:
  only the gateway's lossless tier, never the elision tier.
- `trace.tool` (sync and async) returns without waiting for its tool-event
  POST: events go to a bounded queue (1,000; overflow is dropped, and the
  first drop and the exit total are logged on the `caveman_cloud` logger)
  sent by 8 daemon threads. Leaving `cave.trace` waits only for that trace's
  own events and interpreter exit for all of them, at most 5 s each. A forked
  child starts a fresh queue. An event the gateway did not take (429, 503)
  or could not be offered (connection refused) is sent again, up to 3 times;
  events that stay undelivered are counted, and the first one and the exit
  total are logged.

## 1.0.0 — 2026-07-26

- Recorded stable Python SDK API and `/sdk/v1/*` wire baseline.
- Pinned coordinated-major and parity rules with TypeScript SDK.
