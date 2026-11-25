---
name: caveman-deploy
description: >
  Author, build, run locally, connect tools to, deploy, roll back, gate human
  approvals in, and time-travel fork durable agents on Caveman Cloud with
  `cvm agent`, `cvm connect`, `cvm deploy`, `cvm run`, `cvm deployments`,
  `cvm sessions`, and the `Gate` SDK.
---

# Caveman Agent Deploys, Sessions & Gates

Turn an `AGENT.md` folder (or single `.md`) into an immutable Deployment with
zero-compute parking, step fencing, channels, schedules, Git deploys, and
time-travel forks.

## 1. 30-second start

Templates: `ask`, `support-slack`, `pr-reviewer`, `researcher-drive`, `ts-tools`.

```sh
cvm agent init support-slack ./my-agent   # scaffold (no network)
cvm agent build ./my-agent                # deterministic agent.json + SHA-256
cvm agent dev ./my-agent --port 4317      # hot-reload UI + .caveman/drives/
cvm deploy ./my-agent --dry-run           # inspect plan, drives, grants
cvm deploy ./my-agent --name support-bot --budget 2
cvm run support-bot "Draft response for invoice #4021"
```

## 2. Folder layout & limits (`cvm agent build`)

- `AGENT.md` (<= 256 KiB): frontmatter + system instructions.
- `skills/<slug>/SKILL.md`: on-demand playbooks (`load_skill`).
- `tools/<name>.{mjs,ts,js,py}`: code tools with a top metadata comment:
  ```js
  // @caveman-tool {"description":"Prorate refund","effect":"read","input_schema":{"type":"object","required":["cents"],"properties":{"cents":{"type":"integer"}}}}
  export default function execute({ cents }) { return { refund_cents: cents }; }
  ```
  (`# @caveman-tool {...}` for `.py`). JS tools upgrade `computer: none` to `code`; Python tools upgrade to `linux`.
- `agents/<name>/AGENT.md`: nested subagents (no `tools/` inside subagents).
- `evals/<name>.eval.{json,yaml,yml}`: bundled regression tests.
- Limits: regular UTF-8 files only (no symlinks), <= 1,000 files, <= 2 MiB/file, <= 8 MiB total.

## 3. `AGENT.md` frontmatter schema

All 13 keys (no YAML anchors or `|`/`>` block scalars):

```yaml
---
name: support-bot
description: Durable Slack support agent with KB drive and Linear triage.
engine: caveman                 # caveman | claude-agent | codex
model: claude-sonnet-5-5        # model id or class (e.g. auto)
computer: none                  # none | code | linux
budgets:
  tools: 6000                   # 100..100000 token ceiling for tool cards
connectors:
  linear:
    tools: [list_issues, create_issue]
    as: { read: shared, write: user }   # shared | user | end_user
    args: { team: SUP }                 # pin up to 16 scalar args
    approve: [create_issue]
    after_untrusted: approve            # allow | approve | deny
drives:
  /kb: support-kb                       # shorthand: read-only whole drive
  /cases: { drive: customers, folder: "accounts/{customer}", write: true, review: true, trusted: false, description: "Workspace" }
channels:
  slack: { events: [app_mention, direct_message], thread_mode: session, approvals: interactive }
schedules:
  daily: { cron: "0 9 * * 1-5", timezone: "UTC", task: "Summarize open tickets", concurrency: skip, budget_usd: 2 }
subagents:
  - { name: billing, deployment: billing-specialist }
output_schema: { type: object, required: [summary], properties: { summary: { type: string } } }
---
```

Caller tools go in `tools:` as built-in names or `{type: custom, name, description, input_schema}`.
Up to 8 drive mounts and 16 `{subject}` placeholders (`--subject customer=acme-42`).

## 4. Local dev, connectors & deploys

```sh
cvm agent dev ./my-agent --trigger schedule:daily   # simulate trigger
# Set CAVEMAN_RUNTIME_BIN for live LLM turns in `cvm agent dev`.

cvm connect add linear && cvm connect ls            # add + org OAuth
cvm connect test linear && cvm connect diff linear  # check tool changes
cvm connect accept linear --effect create_issue=external --yes
cvm connect allow-writes linear --in production
cvm connect grant linear --to support-bot --tools list_issues,create_issue --ceiling external
cvm connect requests                                # held deploy grants
cvm connect rotate linear                           # refresh OAuth
cvm connect pause linear --reason "incident"        # kill switch (`connect resume`)

cvm deploy ./my-agent --name support-bot --model claude-sonnet-5-5 --budget 2
cvm run support-bot "Check ticket 99" --subject customer=acme-42 --timeout 900
cvm run --session SESSION_ID                        # re-attach
cvm deployments list && cvm deployments get support-bot
cvm deployments revisions support-bot && cvm deployments rollback support-bot 3
cvm deployments pause support-bot                   # or resume / archive NAME --yes
cvm deployments schedules support-bot               # or channels / sources
cvm deployments connect-repo acme/agents --path ./support --name support-bot
```

`cvm run` exits `0` (`end_turn`/`idle`), `6` (`requires_action`/timeout), or `1` (error/budget).

## 5. Durable sessions, Agents SDK & 1-line Human Gates

```sh
cvm sessions waits SESSION_ID                        # timers, approvals
cvm sessions fork SESSION_ID --at 42 --model claude-opus-4-6 --message "Retry"
cvm sessions to-eval SESSION_ID --out evals/regression.eval.json
cvm sessions migrate SESSION_ID --revision 5         # migrate parked session
```

```ts
import { Gate } from '@caveman-ai/sdk/gate'; // or '@caveman-ai/sdk/agents'
const gate = new Gate({ controlURL: process.env.CAVE_API_URL!, apiKey: process.env.CAVE_TOKEN! });
await gate.guard({ action: 'refund_customer', summary: 'Refund $1,200', risk: 'high', costUsd: 1200 }, () => refund());
const safeTool = gate.tool(refundTool, { when: (a) => Number(a.amount) > 100, risk: 'high' });
```

SDKs: `@caveman-ai/sdk/agents` (`Agents`, `Gate`), `caveman_cloud` (`Agents`, `Gate`), Go `github.com/caveman-ai/sdk-go` (`NewAgents`).

## 6. Rules

- Mark irreversible writes `effect: external` so step fencing prevents duplicate calls on retry.
- Export failing sessions with `cvm sessions to-eval` before deploying fixes.
- Person-only decisions: agents cannot self-approve `Gate` items (`403 cave_gate_person_only`) or grants; fail closed.
