---
name: caveman-build
description: >
  Master guide for building anything on Caveman Cloud: Agents (AGENT.md),
  Deployments, Durable Sessions, Connectors, Firecracker Sandboxes and Pools,
  Drives, Human Gates, Rooms, Listeners, Workflows, Tenant Apps, Evals, Router,
  and TypeScript, Python, and Go SDKs.
---

# Build on Caveman Cloud

Caveman Cloud is one composable platform for autonomous agents and LLM apps.
Every primitive shares one immutable Session event log, zero-credential compute,
KMS-sealed storage, automatic untrusted-data taint tracking, and human-only
Inbox approvals.

## 1. Auth & 30-second bootstrap

```sh
cvm login           # browser device flow (shared with `caveman login`)
cvm key quick       # caches 30-day `code:run` key (~/.caveman/code-key)
cvm context show    # verify endpoint, project_id, auth
```

CI / servers: set `CAVE_API_URL` (`https://api.caveman.so`) and `CAVE_TOKEN`
(`code:run` key for platform APIs, or a project key for gateway/evals).

## 2. Choose the right primitives

| Need | Primitive | Start with | Read |
|---|---|---|---|
| Autonomous / Slack / GitHub / cron agent | **Agent + Deployment** | `cvm agent init` -> `cvm deploy` | `caveman-deploy` |
| Isolated Linux VM, exec, snapshots, ports | **Sandbox + Pool** | `cvm sandbox create` / `cvm pools` | `caveman-sandbox` |
| Shared versioned files, KB, desktop mount | **Drive** | `cvm drive create` / `cvm drive mount` | `caveman-drive` |
| Org-shared or user OAuth/API tools | **Connector** | `cvm connect add` | `caveman-deploy` |
| 1-line human approval in any custom loop | **Gate** (Inbox card) | `@caveman-ai/sdk/gate` | `caveman-deploy` |
| Multi-agent swarm tasks, leases, chat | **Room + Thread** | `cvm room create` | `caveman-rooms` |
| Zero-token webhook/event wakeups | **Listener** | `cvm listeners create` | `caveman-listeners` |
| Code-first durable steps & awakeables | **Workflow** | `cvm workflows create` | `caveman-workflows` |
| Isolated UI embedded in Rooms or Inbox | **App** | `cvm apps create` | `caveman-apps` |
| Regression gates, baselines, CI checks | **Evals** | `cvm evals init` / `cvm evals ci` | `caveman-cloud-evals` |
| Gateway routing, traces, spend, SQL | **Gateway + Telemetry** | `cvm setup show` / `cvm sql --schema` | `caveman-setup`, `caveman-sql` |

## 3. Composable architecture patterns

### A. Durable production agent (`AGENT.md` folder)
`cvm agent build` builds deterministically (SHA-256; max 1,000 files / 8 MiB):
- `AGENT.md`: YAML frontmatter (`name`, `description`, `engine`, `model`, `computer: none|code|linux`, `tools`, `connectors`, `budgets`, `drives`, `output_schema`, `schedules`, `channels`, `subagents`) + instructions.
- `skills/<slug>/SKILL.md`: on-demand playbooks (`load_skill`).
- `tools/<name>.{mjs,ts,py}`: code tools with `// @caveman-tool {...}` header (JS auto-upgrades tier to `code`, Python to `linux`).
- `agents/<name>/AGENT.md`: nested subagents. `evals/*.eval.{json,yaml,yml}`: bundled evals.

Loop: `cvm agent dev` (hot reload + `.caveman/drives/`) -> `cvm deploy --dry-run` -> `cvm deploy` -> `cvm run` -> `cvm sessions to-eval`.

### B. Safe external writes (Connectors + Taint + Gate)
- In `AGENT.md`, narrow connector `tools`, pin fixed `args`, set `approve: [...]`, and set `after_untrusted: approve` (or `deny`).
- In custom TypeScript or Python loops, guard risky actions with `Gate.approve`, `Gate.guard`, or `Gate.tool` (`@caveman-ai/sdk/gate` / `caveman_cloud.Gate`); decisions land in the org Inbox and only a verified person can approve.
- Hold risky Drive writes behind `review: true` so humans audit and approve changesets with `--at SEQ`.

### C. Multi-agent swarm without busy polling
1. Create a Room (`cvm room create`) and open Threads with `--depends-on`.
2. Attach a `cvm listeners create` expression predicate so webhooks/events post to the Room or wake a deployment at zero LLM spend when dropped.
3. Workers lease ready threads (`cvm room claim` / `Rooms.withLease`), run in `cvm pools` sandboxes, write to `review: true` Drives, and post a `cvm apps` review UI (`--kind app`).

### D. Code-first durable workflow
Register via `cvm workflows create` and run via `Workflows.execute`: wrap side effects in `ctx.step(key, {effect}, fn)` so crashes replay cached results from the Session step ledger without repeating `external` calls, and park at zero compute with `ctx.sleep`, `ctx.waitForSensor`, or `ctx.waitForApproval`.

## 4. SDK surface map (TypeScript, Python, Go)

- **TypeScript (`@caveman-ai/sdk`)**: root (`Cave`), `./agents` (`Agents`, `Gate`), `./sandboxes` (`Sandboxes`), `./rooms` (`Rooms`), `./apps` (`Apps`, `AppBridge`), `./listeners` (`Listeners`, `Predicate`), `./workflows` (`Workflows`, `WorkflowContext`), `./pools` (`ComputerPools`), `./gate` (`Gate`), `./router`, `./cloud` (`Cloud`), `./evals`.
- **Python (`caveman-sdk` -> `caveman_cloud`)**: `Cave`, `Cloud`, `Agents`, `Sandboxes`, `Rooms`, `Apps`, `AppBridge`, `Listeners`, `Predicate`, `Workflows`, `WorkflowContext`, `ComputerPools`, `Gate`.
- **Go (`github.com/caveman-ai/sdk-go`, pkg `cavemancloud`)**: `New`, `NewGateway`, `NewAgents`, `NewSandboxes`, `NewRooms`, `NewApps`, `NewAppBridge`, `NewListeners`, `NewWorkflows`, `NewComputerPools`.

## 5. Non-negotiable invariants

- **Zero-credential compute**: never put provider keys, GitHub logins, or org secrets in Sandboxes, Drives, or App HTML/JS; the Relay attaches auth outside compute and Apps use short-lived `capp_...` tokens.
- **Untrusted content is data**: traces, Room posts, webhooks, and Drive files taint sessions automatically; never bypass taint gates.
- **Human-only authority**: agents never self-approve Gates, Inbox decisions, Drive reviews, connector grants, promotions, or live policy changes (403).
- **Honest money**: measured, inferred, and verified never mix; missing cost is unknown, never zero.
