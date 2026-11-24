# Caveman Cloud SDK & CLI (`caveman-ai/cloud-sdk`)

The public developer surface for Caveman Cloud: the `cvm` CLI, zero-dependency TypeScript, Python, and Go SDKs, the Caveman Router hook, the LiteLLM connector, and official Cloud agent skills. Built from sanitized public API contracts (`contracts/`) with zero private server code.

Looking for something else in Caveman?

| If you want to... | Use |
|---|---|
| Build custom agents in TypeScript or embed Harness v4 | [caveman-ai/agent-sdk](https://github.com/caveman-ai/agent-sdk) |
| Run the desktop app or terminal coding agent | [caveman-ai/caveman-code](https://github.com/caveman-ai/caveman-code) |
| Compress prompts and tool outputs locally without Cloud | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) |

## Install

```bash
# Cloud CLI & stdio MCP server (cvm)
npm install -g @caveman-ai/cloud

# TypeScript SDK (gateway, cloud, agents, sandboxes, evals, router)
npm install @caveman-ai/sdk

# Python SDK (stdlib-only, Python 3.13+, GitHub Release wheel)
pip install https://github.com/caveman-ai/cloud-sdk/releases/download/v2.0.0/caveman_sdk-2.0.0-py3-none-any.whl

# Go SDK (Cloud operations, Agents, Sandboxes)
go get github.com/caveman-ai/sdk-go
```

## 60-second quickstart

### Connect your coding agents to Caveman Cloud

```bash
cvm setup --project YOUR_PROJECT_ID
```

`cvm setup` signs you in via browser device flow, installs the Cloud skills, and registers the `caveman-cloud` stdio MCP server in Claude Code, Codex, Cursor, VS Code, Windsurf, Gemini CLI, and OpenCode.

### Deploy an agent and run a Firecracker sandbox

```bash
cvm deploy ./my-agent --budget 2
cvm run my-agent "Summarize open incidents from the last 24h"

export CAVE_TOKEN=cave_live_...
cvm sandbox create --name scratch
cvm sandbox exec SANDBOX_ID -- uname -a
```

### Call from TypeScript

```ts
import { Sandboxes } from "@caveman-ai/sdk/sandboxes";

const sandboxes = new Sandboxes({
  controlURL: "https://api.caveman.so",
  apiKey: process.env.CAVE_TOKEN!,
});

const sb = await sandboxes.create({ name: "scratch", size: "2cpu-4gb" });
const out = await sb.exec(["uname", "-a"]);
console.log(out.stdout);
await sb.delete();
```

## Packages in this repository

| Path | Package / Artifact | License | Purpose |
|---|---|---|---|
| `packages/cli/` | `@caveman-ai/cloud` (`cvm`) | Apache-2.0 | Cloud CLI (389 generated operations, `deploy`, `sandbox`, `evals`, `connect`, `sql`, `mcp`) |
| `packages/sdk-ts/` | `@caveman-ai/sdk` | MIT | Zero-dependency TS SDK (`.`, `/cloud`, `/agents`, `/sandboxes`, `/evals`, `/router`) |
| `packages/router-claude-code/` | `@caveman-ai/router-claude-code` | Apache-2.0 | Claude Code subagent model-routing hook |
| `python/caveman-sdk/` | `caveman-sdk` | MIT | Stdlib-only Python SDK (`caveman_cloud`) |
| `python/caveman-litellm/` | LiteLLM connector | MIT | Drop-in LiteLLM callback for Caveman routing & telemetry |
| `go/` | `github.com/caveman-ai/sdk-go` | MIT | Standalone Go client for Cloud, Agents, and Sandboxes |
| `skills/` | Official Cloud skills | MIT | Agent skills installed by `cvm setup` |
| `contracts/` | Public API contracts | MIT | Sanitized `openapi.json`, `operations.public.json`, `criterion-registry.json`, and JSON schemas |

## Documentation

Every page lives in [`docs/`](./docs/) and aggregates into `docs.caveman.so/sdk`:

- [Overview](./docs/index.mdx)
- [cvm CLI Reference](./docs/cli.mdx)
- [Sandboxes (CLI, TS, Python, Go)](./docs/sandboxes.mdx)
- [Deploy Agents & Org Connectors](./docs/deploy.mdx)
- [Evals & CI Gates](./docs/evals-ci.mdx)
- [TypeScript SDK](./docs/sdk-typescript.mdx)
- [Python SDK & LiteLLM](./docs/sdk-python.mdx)
- [Go SDK](./docs/sdk-go.mdx)
- [Cloud Agent Skills](./docs/skills.mdx)

## Development

```bash
pnpm install
pnpm --filter @caveman-ai/sdk test
pnpm --filter @caveman-ai/cloud test
(cd go && go test ./...)
PYTHONPATH=python/caveman-sdk pytest python/caveman-sdk/tests
```
