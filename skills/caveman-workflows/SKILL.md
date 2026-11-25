---
name: caveman-workflows
description: >
  Define and run code-first durable workflows mixing deterministic steps, agent
  runs, zero-compute timers, sensor waits, and Inbox approvals on the shared
  Session step ledger with `cvm workflows` and the TS/Python/Go `Workflows` SDK.
---

# Caveman Durable Workflows

Code-defined workflows backed 1:1 by Caveman Sessions, two-phase step fencing
on the Session step ledger, and durable zero-compute awakeables. Every run
shares the same event log, cost ledger, and Inbox approvals as agents.

## 1. 30-second start

```sh
cvm login
cvm drive create finance
cvm drive put ./invoice.ts finance/workflows/invoice.ts
cvm workflows create invoice-close \
  --runtime typescript \
  --drive finance \
  --path workflows/invoice.ts \
  --description "Close monthly invoices with approval gate"
cvm workflows run invoice-close --input '{"invoice_id":"inv_123"}' --idempotency-key close-inv-123
cvm workflows get RUN_ID
```

## 2. Full `cvm workflows` CLI reference

- `cvm workflows list`
- `cvm workflows create NAME [--runtime typescript|python|go] [--drive NAME --path FILE] [--description TEXT]`
- `cvm workflows run NAME [--input JSON] [--idempotency-key KEY]`
- `cvm workflows get RUN_ID` (status: `queued` | `running` | `waiting` | `completed` | `failed` | `cancelled`, `session_id`, `output`, `error_code`)

Because every run has a 1:1 `session_id`, all durable session commands work on
it directly: `cvm sessions waits SESSION_ID`, `cvm sessions fork SESSION_ID`,
and `cvm sessions to-eval SESSION_ID`.

## 3. Authoring durable workflows in SDKs

**TypeScript** (`@caveman-ai/sdk/workflows`):
```ts
import { Workflows, WorkflowUncertainEffectError } from '@caveman-ai/sdk/workflows';

const wf = new Workflows({ controlURL: process.env.CAVE_API_URL!, apiKey: process.env.CAVE_TOKEN! });

const { run, output, parked } = await wf.execute(
  'invoice-close',
  { invoiceId: 'inv_123', amountUsd: 1200 },
  async (ctx, input) => {
    const draft = await ctx.step(
      'fetch-invoice',
      { toolName: 'stripe.get_invoice', effect: 'read', kind: 'connector', input },
      async () => fetchInvoice(input.invoiceId),
    );
    if (draft.amountUsd > 500) {
      // Parks at zero compute and files a human Inbox decision item:
      await ctx.waitForApproval(`approve-${input.invoiceId}`, `Approve $${draft.amountUsd} close`);
    }
    // Park until a zero-token sensor fires:
    // await ctx.waitForSensor(listenerId, 'Wait for bank settlement webhook');
    // Or durable timer: await ctx.sleep(3600, 'Cool-down before receipt');
    return ctx.step(
      'charge-invoice',
      { toolName: 'stripe.pay', effect: 'external', kind: 'connector', input: { id: input.invoiceId } },
      async () => payInvoice(input.invoiceId),
    );
  },
  { idempotencyKey: 'invoice-close:inv_123' },
);
```

- **Step `effect` values**: `read` | `write` | `idempotent` | `external`.
- **Step `kind` values**: `code_tool` | `subagent` | `connector` | `drive` | `sandbox` | `model`.
- **Parking helpers on `WorkflowContext`**: `sleep(seconds, reason)`, `waitForApproval(askId, reason)`, `approve(askId, reason, {expiresAt})`, `waitForSensor(listenerId, reason, {expiresAt})`, `wait({kind, ask_id, target_id, reason, expires_at})`. Each throws `WorkflowParkedError` cleanly (caught by `wf.execute` and returned as `{ run: { status: 'waiting' }, parked }`).
- **Python**: `from caveman_cloud import Workflows, WorkflowContext, WorkflowParkedError, WorkflowUncertainEffectError`.
- **Go**: `github.com/caveman-ai/sdk-go` (`NewWorkflows`).

## 4. Rules & crash-safety invariants

- **Stable `step_key` per logical step**: never include timestamps or random UUIDs in `step_key`; replays match by `(run_id, step_key)` and return cached results.
- **Explicit `effect: "external"`**: mark every non-idempotent external write `external`. If a worker crashes mid-call, replay throws `WorkflowUncertainEffectError` (HTTP 409) instead of blindly retrying — escalate to a human operator.
- **Always pass `--idempotency-key` / `idempotencyKey`** when starting runs from webhooks or retries.
- **Zero-compute waits**: never `setTimeout` or sleep-poll inside a worker for long waits; use `ctx.sleep`, `ctx.waitForSensor`, or `ctx.waitForApproval`.
