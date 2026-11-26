# Caveman Cloud SDK & CLI (`caveman-ai/cloud-sdk`)

Public developer surface for **Caveman Cloud** (Cloud for AI): the unified
zero-dependency TypeScript (`@caveman-ai/sdk`), Python (`caveman-sdk`), and Go
(`github.com/caveman-ai/sdk-go`) SDKs, the `cvm` CLI (`@caveman-ai/cloud`),
the `caveman-drive-mount` daemon, sanitized public API contracts, and official
Cloud agent skills.

`CLAUDE.md` is a symlink to this file.

## Ecosystem ownership

| Surface | Owning repository |
|---|---|
| Unified Cloud SDKs (TS/Py/Go), `cvm` CLI, Drive mount, public Cloud skills, sanitized OpenAPI contracts | **`caveman-ai/cloud-sdk` (this repo)** |
| Optional TypeScript Agent authoring framework & Harness v4 (`@caveman-ai/agent`, `@caveman-ai/harness`) | `caveman-ai/agent-sdk` |
| Public documentation site (`docs.caveman.so`) | `JuliusBrussee/caveman-docs` |
| Accountless local CLI, engine, proxy, memory, shrink | `JuliusBrussee/caveman` |
| Desktop/terminal coding agent | `caveman-ai/caveman-code` |

## Unified SDK architecture

All three language SDKs expose **one primary `Caveman` client** backed by a
single scoped API key (`CAVEMAN_API_KEY` / `CAVE_TOKEN`) and one Credits balance:

- **Inference:** `inference` (`models`, `generation`, `route`, `trim`, `compact`, provider clients)
- **Managed Agents:** `agents`, `sessions`, `sandboxes` (`pools`)
- **State & Access:** `drives` (durable versioned storage & changesets), `connectors`, `secrets` (write-only)
- **Multi-Agent Apps:** `rooms`, `apps` (plus `@caveman-ai/sdk/app-bridge` for browser iframes)
- **Quality & Control:** `evals`, `approvals` (Gate), `credits`, `cloud`

Legacy standalone subpath exports (`./cloud`, `./agents`, `./sandboxes`, `./evals`,
`./rooms`, `./apps`, `./gate`, `./router`, `./listeners`, `./workflows`, `./pools`)
remain available for backward compatibility, but all new features and docs target
the unified `Caveman` client and `./app-bridge`.

## Layout

| Path | Package / Role | License |
|---|---|---|
| `packages/sdk-ts/` | `@caveman-ai/sdk` (`Caveman` unified TS SDK + `./app-bridge`) | MIT |
| `packages/cli/` | `@caveman-ai/cloud` (`cvm` CLI & stdio MCP server) | Apache-2.0 |
| `packages/router-claude-code/` | `@caveman-ai/router-claude-code` (subagent model-routing hook) | Apache-2.0 |
| `python/caveman-sdk/` | `caveman-sdk` (stdlib-only Python 3.13+ SDK, `caveman_cloud.Caveman`) | MIT |
| `python/caveman-litellm/` | LiteLLM callback connector | MIT |
| `go/` | `github.com/caveman-ai/sdk-go` (`cavemancloud.NewCaveman`) | MIT |
| `drive-mount/` | `caveman-drive-mount` (zero-kext WebDAV mount daemon for `cvm drive mount`) | Apache-2.0 |
| `contracts/` | Sanitized public `openapi.json`, `operations.public.json`, JSON schemas | MIT |
| `parity/`, `packages/parity/`, `python/parity/` | Cross-language wire parity fixtures | MIT |
| `skills/` | Official public Cloud agent skills (`SKILL.md` bundles + budget gates) | MIT |
| `docs/` | Public SDK/CLI product docs aggregated into `docs.caveman.so` | MIT |

## Checks

```bash
pnpm install
pnpm -r build
pnpm -r test
(cd go && go test ./...)
PYTHONPATH=python/caveman-sdk pytest python/caveman-sdk/tests
node --test skills/budget.test.mjs
node scripts/check-public-hygiene.mjs
```

## Rules

- **Public repository.** Everything here is world-readable. Never add private repo names, private server paths, local paths, or internal notes. Always run `node scripts/check-public-hygiene.mjs`.
- **Zero runtime dependencies** in `@caveman-ai/sdk`, `@caveman-ai/cloud`, and `caveman-sdk` (stdlib-only Python).
- **Cross-language parity.** Wire changes update `contracts/` and parity fixtures alongside TS, Python, and Go implementations; missing handlers fail closed.
- **Scoped conventional commits** (`feat(sdk-ts): ...`, `fix(cli): ...`, `docs(repo): ...`).
