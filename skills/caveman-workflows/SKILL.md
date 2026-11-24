---
name: caveman-workflows
description: Define and run code-first durable workflows that mix deterministic steps, agent runs, timers, and Inbox approvals on the shared Session ledger with `cvm workflows`.
---

# Caveman Durable Workflows

Code-defined workflows backed 1:1 by Caveman Sessions, two-phase step fencing (`code_session_steps`), and durable awakeables (`code_session_waits`).

## 30-second start

```sh
cvm workflows create invoice-close --runtime typescript --drive finance --path workflows/invoice.ts
cvm workflows run invoice-close --input '{"invoice_id":"inv_123"}'
cvm workflows get RUN_ID
```

## Core commands

- Manage & run: `cvm workflows list`, `cvm workflows create`, `cvm workflows run`, `cvm workflows get`
- SDKs: `@caveman-ai/sdk/workflows` (TypeScript), `caveman_cloud.Workflow` (Python), `cavemancloud.Workflows` (Go)

## Rules

- Give every side-effecting step a stable `step_key` and explicit `effect` (`read`, `write`, `idempotent`, `external`) so crashes replay cleanly without duplicating external writes.
- Use `waitForApproval` for risky actions; the run parks at zero compute and surfaces in the org Inbox.
