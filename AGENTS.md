# Caveman Cloud SDK & CLI (`caveman-ai/cloud-sdk`)

Public developer surface for Caveman Cloud: the `cvm` CLI (`@caveman-ai/cloud`),
zero-dependency TypeScript (`@caveman-ai/sdk`), Python (`caveman-sdk`), and Go
(`github.com/caveman-ai/sdk-go`) SDKs, the Claude Code router hook
(`@caveman-ai/router-claude-code`), LiteLLM connector, sanitized API contracts,
and official Cloud agent skills.

`CLAUDE.md` is a symlink to this file.

## Layout

| Path | Package / Role | License |
|---|---|---|
| `packages/cli/` | `@caveman-ai/cloud` (`cvm` CLI & stdio MCP server) | Apache-2.0 |
| `packages/sdk-ts/` | `@caveman-ai/sdk` (zero-dep TS SDK: gateway, cloud, agents, sandboxes, evals, router) | MIT |
| `packages/router-claude-code/` | `@caveman-ai/router-claude-code` (Claude Code subagent model-routing hook) | Apache-2.0 |
| `python/caveman-sdk/` | `caveman-sdk` (stdlib-only Python 3.13+ SDK, `caveman_cloud`) | MIT |
| `python/caveman-litellm/` | LiteLLM callback connector for Caveman routing & telemetry | MIT |
| `go/` | `github.com/caveman-ai/sdk-go` (standalone Go client) | MIT |
| `contracts/` | Sanitized public `openapi.json`, `operations.public.json`, `criterion-registry.json`, JSON schemas | MIT |
| `parity/`, `packages/parity/`, `python/parity/` | Cross-language wire parity fixtures (TS, Python, Go must agree) | MIT |
| `skills/` | Official Cloud agent skills (`SKILL.md` bundles + `compile.mjs` + verb/budget gates) | MIT |
| `docs/` | Public product docs aggregated into `docs.caveman.so/sdk` | MIT |

## Checks

```bash
# TypeScript workspace (Node 24, pnpm 10)
pnpm install
pnpm -r build
pnpm -r test

# Go SDK (Go 1.23+)
(cd go && go test ./...)

# Python SDK (Python 3.13+)
PYTHONPATH=python/caveman-sdk pytest python/caveman-sdk/tests

# Skills budget gate
node --test skills/budget.test.mjs
```

## Rules

- **Public repository.** Everything here is world-readable. Never add private server paths, internal design memos, or credentials.
- **Zero runtime dependencies** in `@caveman-ai/sdk`, `@caveman-ai/cloud`, and `caveman-sdk` (stdlib-only Python). Keep bundles and wheels dependency-free.
- **Cross-language parity.** Wire changes update `contracts/` and parity fixtures alongside TS, Python, and Go implementations; missing handlers fail closed.
- **Generated contracts.** `contracts/openapi.json` and `contracts/operations.public.json` are sanitized exports from Caveman Cloud's API contract — keep client generation deterministic and never hand-edit generated files without updating their source.
- **Scoped conventional commits** (`feat(sdk-ts): ...`, `fix(cli): ...`, `docs(repo): ...`).
