# Caveman Cloud SDK & CLI (`caveman-ai/cloud-sdk`)

The public developer surface for **Caveman Cloud**: one unified SDK (`@caveman-ai/sdk` for TypeScript, `caveman-sdk` for Python, `github.com/caveman-ai/sdk-go` for Go), the `cvm` CLI (`@caveman-ai/cloud`), the `caveman-drive-mount` desktop bridge, sanitized public API contracts, and official Cloud agent skills.

Looking for another part of Caveman?

| If you want to... | Use |
|---|---|
| Author custom agents in TypeScript or embed Harness v4 | [caveman-ai/agent-sdk](https://github.com/caveman-ai/agent-sdk) |
| Run the desktop app or terminal coding agent | [caveman-ai/caveman-code](https://github.com/caveman-ai/caveman-code) |
| Compress prompts and tool outputs locally without Cloud | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) |
| Read or edit public documentation | [docs.caveman.so](https://docs.caveman.so) |

## The 10 Platform Primitives (1 Key, 1 Wallet, 1 Client)

Every Caveman Cloud capability is accessible individually or together through one scoped API key (`CAVEMAN_API_KEY`) and one unified Credits balance:

| Layer | Primitives | Unified SDK Namespace |
|---|---|---|
| **Inference** | Models & Unified Gateway (`route`, `trim`, `compact`, failover, caching) | `cv.inference` |
| **Managed Agents** | Agents & Deployments, Durable Sessions, Firecracker Sandboxes | `cv.agents`, `cv.sessions`, `cv.sandboxes` |
| **State & Access** | Drives (versioned storage & changesets), Connectors, Secrets (write-only) | `cv.drives`, `cv.connectors`, `cv.secrets` |
| **Multi-Agent Apps** | Rooms (N:M threads, leases, taint, cost rollups), Apps (`AppBridge`) | `cv.rooms`, `cv.apps` |
| **Quality & Control** | Evals, Approvals (Inbox Gates), Credits | `cv.evals`, `cv.approvals`, `cv.credits` |

## Install

```bash
# Cloud CLI & stdio MCP server (cvm)
npm install -g @caveman-ai/cloud

# Unified TypeScript SDK
npm install @caveman-ai/sdk

# Unified Python SDK (stdlib-only, Python 3.13+)
pip install caveman-sdk

# Unified Go SDK
go get github.com/caveman-ai/sdk-go
```

## Quickstart

### 1. Unified TypeScript SDK (`new Caveman()`)

```ts
import { Caveman } from "@caveman-ai/sdk";

const cv = new Caveman(); // reads CAVEMAN_API_KEY

// Inference: list models or call any provider via gateway.caveman.so/v1
const models = await cv.inference.models();

// Drives: zero-VM search over versioned team files
const hits = await cv.drives.drive("knowledge").grep({ pattern: "refund policy" });

// Sandboxes: $0-idle Firecracker microVMs
const sb = await cv.sandboxes.create({ name: "scratch", size: "2cpu-4gb" });
const out = await sb.exec(["uname", "-a"]);
await sb.delete();

// Managed Agents: start a durable session on a live deployment
const session = await cv.agents.run("triage", {
  request_id: crypto.randomUUID(),
  task: "Summarize open incidents from the last 24h",
});
```

### 2. Unified Python SDK

```python
from caveman_cloud import Caveman

cv = Caveman()  # reads CAVEMAN_API_KEY
models = cv.inference.models()
hits = cv.drives.drive("knowledge").grep({"pattern": "refund policy"})
rooms = cv.rooms.list()
```

### 3. Unified Go SDK

```go
cv, err := cavemancloud.NewCaveman(cavemancloud.CavemanOptions{}) // reads CAVEMAN_API_KEY
models, err := cv.ListModels(ctx)
drives, err := cv.Drives.List(ctx)
```

### 4. Browser App Bridge (`@caveman-ai/sdk/app-bridge`)

```ts
import { AppBridge } from "@caveman-ai/sdk/app-bridge";

const bridge = new AppBridge("my-app", {
  controlURL: "https://api.caveman.so",
  apiKey: appCapabilityToken, // short-lived capp_... token
});
const doc = await bridge.driveRead("/reports/latest.md");
```

### 5. Deploy & Operate from the CLI (`cvm`)

```bash
cvm login
cvm deploy ./my-agent --budget 2
cvm run my-agent "Summarize open incidents from the last 24h"
cvm drive grep "refund" knowledge/
cvm sandbox create --name scratch
```

## Packages in this repository

| Path | Package / Artifact | License | Purpose |
|---|---|---|---|
| `packages/sdk-ts/` | `@caveman-ai/sdk` | MIT | Unified zero-dependency TS SDK (`Caveman` + `./app-bridge` + modular subpath exports) |
| `packages/cli/` | `@caveman-ai/cloud` (`cvm`) | Apache-2.0 | Cloud CLI (`deploy`, `dev`, `run`, `sandbox`, `drive`, `connect`, `room`, `apps`, `evals`, `mcp`) |
| `python/caveman-sdk/` | `caveman-sdk` | MIT | Stdlib-only Python SDK (`Caveman`, `caveman_cloud`) |
| `go/` | `github.com/caveman-ai/sdk-go` | MIT | Standalone Go client (`NewCaveman`) |
| `drive-mount/` | `caveman-drive-mount` | Apache-2.0 | Zero-kext WebDAV desktop mount daemon for `cvm drive mount` |
| `packages/router-claude-code/` | `@caveman-ai/router-claude-code` | Apache-2.0 | Claude Code subagent model-routing hook |
| `python/caveman-litellm/` | LiteLLM connector | MIT | Drop-in LiteLLM callback for Caveman routing |
| `skills/` | Official Cloud skills | MIT | Customer-facing agent skills installed via `cvm` or `npx skills add caveman-ai/cloud-sdk` |
| `contracts/` | Public API contracts | MIT | Sanitized `openapi.json`, `operations.public.json`, and JSON schemas |

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
(cd go && go test ./...)
PYTHONPATH=python/caveman-sdk pytest python/caveman-sdk/tests
node scripts/check-public-hygiene.mjs
```
