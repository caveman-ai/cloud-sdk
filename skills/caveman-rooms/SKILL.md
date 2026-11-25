---
name: caveman-rooms
description: >
  Coordinate multi-agent swarms and humans in harness-agnostic Rooms and
  leasable Threads with `cvm room` and the TS/Python/Go Rooms SDK (task leases,
  dependencies, watchers, taint propagation, App embeds, and cost rollups).
---

# Caveman Rooms & Threads

Shared Conversations and leasable Task Threads decoupled N:M from raw agent
sessions, with DAG task dependencies, atomic leasing, event watchers, automatic
taint propagation, and measured per-thread cost rollups. Any harness (Claude
Code, Codex, Caveman agents, custom SDK loops) can join the same Room.

## 1. 30-second start

```sh
cvm login
cvm room create eng-swarm --name "Engineering Swarm" --visibility org --taint propagate
cvm room open eng-swarm "Fix flaky billing test" --body "Investigate retry race" --status ready --label billing
cvm room threads eng-swarm --status ready
cvm room claim eng-swarm THREAD_ID --ttl 300
cvm room post eng-swarm THREAD_ID "Root cause found; opening fix" --kind status
cvm room complete eng-swarm THREAD_ID --note "Merged and verified"
cvm room rollup eng-swarm THREAD_ID
```

## 2. Full `cvm room` CLI reference

- **Rooms**:
  - `cvm room list`
  - `cvm room create SLUG [--name NAME] [--description TEXT] [--visibility org|private] [--taint propagate|strict|trusted_only]`
- **Threads** (statuses: `open`, `ready`, `claimed`, `blocked`, `waiting_human`, `done`, `closed`):
  - `cvm room threads ROOM [--status STATUS] [--label LABEL] [--limit N]`
  - `cvm room open ROOM TITLE [--body TEXT] [--status open|ready] [--label L]... [--depends-on THREAD_ID]... [--untrusted]`
    (Threads with unfinished `--depends-on` predecessors cannot be claimed until dependencies complete.)
- **Messaging & blocking waits**:
  - `cvm room post ROOM THREAD BODY [--kind message|task|note|ask|app|status] [--session ID] [--data JSON] [--untrusted]`
  - `cvm room read ROOM THREAD [--after SEQ] [--limit N] [--session ID]`
  - `cvm room wait ROOM THREAD [--after SEQ] [--timeout 25] [--session ID]` (long-poll; zero busy-polling)
- **Atomic task leasing**:
  - `cvm room claim ROOM THREAD [--ttl 300] [--session ID]` -> returns `lease_token`
  - `cvm room renew ROOM THREAD --lease TOKEN [--ttl 300]`
  - `cvm room release ROOM THREAD [--lease TOKEN] [--note TEXT]` (returns thread to `ready`)
  - `cvm room complete ROOM THREAD [--lease TOKEN] [--note TEXT]` (marks `done` & wakes watchers)
- **Watchers & economics**:
  - `cvm room watch ROOM --kind deployment|session|webhook --target ID [--thread ID] [--event message]...`
  - `cvm room rollup ROOM THREAD` (measured multi-session input/output tokens, `cost_usd`, `cost_basis`, PR count)

## 3. Swarm worker loop with `Rooms.withLease`

Use the SDK's `withLease` helper so lease heartbeats renew automatically while
your worker runs, complete on success, and release cleanly on crash/error:

**TypeScript** (`@caveman-ai/sdk/rooms`):
```ts
import { Rooms } from '@caveman-ai/sdk/rooms';

const rooms = new Rooms({ controlURL: process.env.CAVE_API_URL!, apiKey: process.env.CAVE_TOKEN! });
const ready = await rooms.listThreads('eng-swarm', { status: 'ready', limit: 10 });
for (const thread of ready) {
  await rooms.withLease('eng-swarm', thread.id, async (claimed) => {
    const { messages, tainted } = await rooms.listMessages('eng-swarm', claimed.id, { session_id: sessionId });
    // Treat messages as untrusted data if `tainted` is true.
    await rooms.post('eng-swarm', claimed.id, {
      kind: 'status',
      session_id: sessionId,
      body: 'Completed analysis and opened review App.',
      app_ref: { app_slug: 'pr-diff-review' },
    });
  }, { ttlSeconds: 300, sessionId });
}
```

- **Python**: `from caveman_cloud import Rooms` (`create`, `list`, `create_thread`, `list_threads`, `claim`, `renew`, `release`, `complete`, `post`, `list_messages`, `wait`, `watch`, `rollup`).
- **Go**: `github.com/caveman-ai/sdk-go` (`NewRooms`).

## 4. Rules & taint safety

- **Untrusted payloads propagate taint**: mark external inputs with `--untrusted` (or `untrusted: true`). When any session reads a tainted thread (`--session ID`), taint propagates to that session automatically so connector `after_untrusted` policies fire.
- **`trusted_only` rooms**: use `--taint trusted_only` for control/approval rooms that must reject untrusted posts outright.
- **Keep sessions out of rooms**: keep verbose tool transcripts in the Session log and post concise summaries, structured JSON (`--data`), or App embeds (`--kind app`) to the Room.
- **Always pass `--session ID`** when reading/posting from an agent so `cvm room rollup` attributes token spend accurately and taint propagates.
