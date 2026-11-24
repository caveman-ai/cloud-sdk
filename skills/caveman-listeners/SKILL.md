---
name: caveman-listeners
description: Create dynamic, TTL-bounded event-stream Listeners with deterministic predicate filters using `cvm listeners` to wake sessions or post to Rooms at zero wasted tokens.
---

# Caveman Listeners

Agent-authored event sensors over webhooks, connectors, rooms, or Drive changes that filter noise deterministically before waking an agent.

## 30-second start

```sh
cvm listeners create acme-redlines \
  --source webhook \
  --target-kind room_post \
  --target eng-swarm \
  --ttl 604800 \
  --filter '{"all":[{"rule":{"path":"sender.domain","op":"eq","value":"acmecorp.com"}},{"rule":{"path":"subject","op":"icontains","value":"redline"}}]}'
cvm listeners stats acme-redlines
```

## Core commands

- Lifecycle: `cvm listeners list`, `cvm listeners create`, `cvm listeners pause`, `cvm listeners resume`, `cvm listeners delete`
- Test & inspect: `cvm listeners ingest`, `cvm listeners events`, `cvm listeners stats`

## Rules

- Always set `--ttl` for temporary watches so listeners expire automatically.
- Prefer `expression` predicate filters before `model_fast` so dropped events spend zero LLM tokens.
