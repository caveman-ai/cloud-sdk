---
name: caveman-listeners
description: >
  Create dynamic, TTL-bounded event-stream Listeners with deterministic
  predicate filters using `cvm listeners` and the TS/Python/Go `Listeners` and
  `Predicate` SDKs to wake agents, workflows, or Rooms at zero wasted tokens.
---

# Caveman Listeners (Zero-Token Event Sensors)

Agent-authored event sensors over webhooks, connector polls, Rooms, Drive
changes, SSE streams, or Kafka bridges that filter noise deterministically
before waking an agent, workflow, or Room. Dropped events spend zero LLM tokens.

## 1. 30-second start

```sh
cvm login
cvm listeners create acme-redlines \
  --source webhook \
  --filter-kind expression \
  --target-kind room_post \
  --target eng-swarm \
  --ttl 604800 \
  --filter '{"all":[{"rule":{"path":"sender.domain","op":"eq","value":"acmecorp.com"}},{"rule":{"path":"subject","op":"icontains","value":"redline"}}]}'
cvm listeners ingest acme-redlines '{"sender":{"domain":"acmecorp.com"},"subject":"MSA redline v2"}'
cvm listeners stats acme-redlines
```

## 2. Full `cvm listeners` CLI reference

- `cvm listeners list`
- `cvm listeners create NAME --source SOURCE --target-kind TARGET_KIND --target TARGET_ID [--filter-kind KIND] [--filter JSON] [--ttl SECONDS]`
  - `--source`: `webhook` | `connector_poll` | `room` | `drive_changes` | `sse` | `kafka_bridge`
  - `--filter-kind`: `expression` (default, zero tokens) | `code_js` | `model_fast` | `none`
  - `--target-kind`: `room_post` | `session_wake` | `deployment` | `workflow`
- `cvm listeners pause NAME` · `cvm listeners resume NAME` · `cvm listeners delete NAME`
- `cvm listeners ingest NAME JSON_PAYLOAD` (synthetic test event through the live filter)
- `cvm listeners events NAME` (recent matched/dropped deliveries)
- `cvm listeners stats NAME` (`events_seen`, `events_matched`, `events_dropped`, `drop_rate`, `spend_usd`, `filter_basis`)

When `--source webhook` is used, `create` returns `hook_id` and `hook_secret`
for external webhook registration and signature verification.

## 3. Deterministic Predicate AST & SDKs

Expression filters compose `all`, `any`, `not`, and `rule` (`{path, op, value}`).
All 13 operators: `eq`, `neq`, `contains`, `icontains`, `prefix`, `suffix`,
`regex`, `in`, `gt`, `gte`, `lt`, `lte`, `exists`.

**TypeScript** (`@caveman-ai/sdk/listeners`):
```ts
import { Listeners, Predicate } from '@caveman-ai/sdk/listeners';

const listeners = new Listeners({ controlURL: process.env.CAVE_API_URL!, apiKey: process.env.CAVE_TOKEN! });
const sensor = await listeners.create({
  name: 'high-value-refunds',
  source_kind: 'webhook',
  filter_kind: 'expression',
  filter_spec: Predicate.all(
    Predicate.eq('type', 'refund.requested'),
    Predicate.gte('data.amount_cents', 50000),
    Predicate.not(Predicate.inList('data.env', ['staging', 'test'])),
  ),
  target_kind: 'workflow',
  target_id: 'refund-approval',
  ttl_seconds: 86400 * 7,
});
const stats = await listeners.stats(sensor.name);
```

- **Python**: `from caveman_cloud import Listeners, Predicate` (`create`, `list`, `get`, `pause`, `resume`, `delete`, `ingest`, `stats`).
- **Go**: `github.com/caveman-ai/sdk-go` (`NewListeners`).

Pair with durable workflows: park at zero compute via `ctx.waitForSensor(sensor.id)`
until a matching event arrives.

## 4. Rules

- **Always set `--ttl` (`ttl_seconds`)** on temporary or task-scoped listeners so stale watches expire automatically.
- **Filter deterministically first**: prefer `expression` (or `code_js`) over `model_fast` so noise is dropped with zero LLM spend.
- **Untrusted payloads**: external webhook/ingest payloads are untrusted by default (only pass `trusted: true` from authenticated internal producers) and taint downstream sessions automatically.
- **Test before relying**: verify both a matching and a non-matching payload with `cvm listeners ingest` and check `cvm listeners stats`.
