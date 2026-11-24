---
name: caveman-deploy
description: Author, locally run, deploy, inspect, and time-travel fork durable agents on Caveman Cloud with `cvm agent`, `cvm deploy`, `cvm run`, and `cvm sessions`.
---

# Caveman Agent Deploys & Durable Sessions

Turn an `AGENT.md` folder (or BYO `invocations.v1` container) into an immutable Deployment with zero-compute durable parking, step fencing, PR previews, and 3-state forks.

## 30-second start

```sh
cvm agent init pr-reviewer ./my-agent
cvm agent build ./my-agent
cvm agent dev ./my-agent
cvm deploy ./my-agent --name pr-reviewer
cvm run pr-reviewer "Review PR #42"
```

## Core commands

- Author & develop: `cvm agent init`, `cvm agent build`, `cvm agent dev`
- Ship & manage: `cvm deploy`, `cvm run`, `cvm deployments`
- Durable ops & replay: `cvm sessions` (`waits`, `fork`, `to-eval`, `migrate`)
- Connectors: `cvm connect`

## Rules

- Keep connector tool cards within `budgets.tools` and declare `effect: external` on irreversible side effects so step fencing prevents duplicate calls on retries.
- Export failing production sessions with `cvm sessions` (`to-eval`) before deploying a fix.
