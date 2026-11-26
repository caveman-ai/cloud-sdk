# Caveman Cloud SDK

Use `cvm` to deploy agents and run evals from a terminal or CI. The TypeScript, Python and Go SDKs let you call Caveman Cloud from your own code.

[CLI & MCP](#cli-and-mcp) · [Run a sandbox](#run-a-sandbox) · [Deploy an agent](#deploy-an-agent) · [Gate CI on evals](#gate-ci-on-evals) · [API contract](./contracts/openapi.json)

## CLI and MCP

Requires Node 22.13 or later.

```bash
npm install -g @caveman-ai/cloud
cvm setup
```

Setup uses browser sign-in when needed and selects a project. It installs the Caveman Cloud skill and registers the stdio MCP server for the coding agents you select. Supported clients include Claude Code, Codex, Cursor, VS Code, Windsurf, Gemini CLI and OpenCode.

| To | Run |
|---|---|
| Sign in without configuring a coding agent | `cvm login` |
| Set up two specific agents | `cvm setup --agent claude,codex` |
| Choose a project up front | `cvm setup --project UUID` |
| Remove the skill and MCP entries setup added | `cvm setup --remove` |
| Start the stdio MCP server yourself | `cvm mcp` |
| Inspect a public operation's input schema | `cvm tools describe datasets.create` |

For CI or services, set `CAVE_TOKEN` to a scoped key with permission for the operation. Set `CAVE_PROJECT_ID` for project requests. The CLI defaults to `https://api.caveman.so`; set `CAVE_API_URL` if your API runs elsewhere.

## Run a sandbox

These examples need a Cloud instance with the sandbox API enabled. If yours uses a different API origin, set `CAVE_API_URL` before running them.

Create an organization service account key with `code:run` in Settings → Service accounts. Set it as `CAVE_TOKEN` for these examples. The key acts as the service account and can access the sandboxes that account created.

### CLI

```bash
(
  set -e
  box=$(cvm sandbox create --name scratch --size 2cpu-4gb --format json)
  id=$(node -p 'JSON.parse(process.argv[1]).id' "$box")
  trap 'cvm sandbox delete "$id" --yes >/dev/null' EXIT
  cvm sandbox exec "$id" -- uname -a
)
```

`create` waits for the sandbox to run. `exec` streams stdout and stderr separately and returns the command's exit status. Each example asks the API to delete its scratch sandbox on exit.

### TypeScript

Install with `npm install @caveman-ai/sdk` (Node 22.13+). Save as `sandbox.mts` and run `node --experimental-strip-types sandbox.mts`.

```ts
import { Sandboxes } from "@caveman-ai/sdk/sandboxes";

const token = process.env.CAVE_TOKEN;
if (!token) throw new Error("Set CAVE_TOKEN to a code:run key.");

const sandboxes = new Sandboxes({
  controlURL: process.env.CAVE_API_URL ?? "https://api.caveman.so",
  apiKey: token,
});
const box = await sandboxes.create({ name: "scratch" });
try {
  await sandboxes.waitFor(box.id, "running");
  const result = await sandboxes.run(box.id, ["uname", "-a"]);
  console.log(result.stdout);
} finally {
  await sandboxes.delete(box.id);
}
```

### Python

Use Python 3.13+. PyPI's `caveman-sdk` is still 1.2.0, the older gateway client. Install the 2.0.0 release wheel for `Sandboxes`.

```bash
python -m pip install https://github.com/caveman-ai/cloud-sdk/releases/download/v2.0.0/caveman_sdk-2.0.0-py3-none-any.whl
```

```python
import os
from caveman_cloud import Sandboxes

sandboxes = Sandboxes(
    control_url=os.environ.get("CAVE_API_URL", "https://api.caveman.so"),
    api_key=os.environ["CAVE_TOKEN"],
)
box = sandboxes.create({"name": "scratch"})
try:
    sandboxes.wait(box["id"], "running")
    result = sandboxes.run(box["id"], ["uname", "-a"])
    print(result.stdout.decode(), end="")
finally:
    sandboxes.delete(box["id"])
```

### Go

The Go SDK requires Go 1.24 or later. Until `github.com/caveman-ai/sdk-go` has its own release, clone this repo next to your project:

```bash
git clone https://github.com/caveman-ai/cloud-sdk.git
```

In your project's `go.mod`:

```gomod
require github.com/caveman-ai/sdk-go v0.0.0

replace github.com/caveman-ai/sdk-go => ../cloud-sdk/go
```

Save as `main.go` and run `go run .`:

```go
package main

import (
	"context"
	"fmt"
	"log"
	"os"

	cavemancloud "github.com/caveman-ai/sdk-go"
)

func run() error {
	ctx := context.Background()
	api := os.Getenv("CAVE_API_URL")
	if api == "" {
		api = "https://api.caveman.so"
	}
	sandboxes, err := cavemancloud.NewSandboxes(cavemancloud.SandboxesOptions{
		ControlURL: api,
		APIKey:     os.Getenv("CAVE_TOKEN"),
	})
	if err != nil {
		return err
	}
	name := "scratch"
	box, err := sandboxes.Create(ctx, cavemancloud.SandboxesCreateInput{Name: &name})
	if err != nil {
		return err
	}
	defer func() {
		if _, err := sandboxes.Delete(ctx, box.Id); err != nil {
			log.Printf("delete sandbox %s: %v", box.Id, err)
		}
	}()
	if _, err := sandboxes.Wait(ctx, box.Id, cavemancloud.SandboxStateRunning); err != nil {
		return err
	}
	result, err := sandboxes.Run(ctx, box.Id, []string{"uname", "-a"}, nil)
	if err != nil {
		return err
	}
	fmt.Print(string(result.Stdout))
	return nil
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
```

A sandbox sleeps after 10 idle minutes by default and keeps its disk. Use `cvm sandbox --help` for file copy, port access and snapshots, or inspect the [sandbox CLI source](./packages/cli/bin/sandbox.mjs).

## Deploy an agent

Use your project sign-in or a key with deploy permissions for these commands. An agent is a folder with an `AGENT.md`. The first deploy below previews what would be sent without making API calls.

```bash
cvm agent init ts-tools
cvm deploy ./ts-tools --budget 2 --dry-run
cvm deploy ./ts-tools --budget 2
cvm run ts-tools "Prorate a USD 30 monthly plan for 10 of 30 days."
cvm deployments revisions ts-tools
```

The budget is in US dollars per session. Every time the build or deploy settings change, Caveman Cloud records an immutable revision under the same deployment name. Pick an earlier revision number and pass it to `cvm deployments rollback ts-tools REVISION`. See the [deployment guide](./docs/deploy.mdx) for connecting MCP tools to an agent.

## Gate CI on evals

`init` writes a runnable sample. Replace its task with your app's command when you're ready to score your own output.

```bash
cvm evals init
cvm evals validate example.eval.json --offline
cvm evals run example.eval.json --set-baseline-on-pass
cvm evals ci example.eval.json --junit-out evals.xml
```

Save the baseline from the version you trust. Run the last command on proposed changes; set `CAVE_TOKEN` and `CAVE_PROJECT_ID` in CI. Exit `5` means a regression failed the gate. Exit `6` means there was no verdict.

## Version files in a Drive

Use a Cloud instance with Drives enabled.

```bash
cvm drive create research
printf 'Draft plan\n' | cvm drive put - research/plan.md
cvm drive log research/plan.md
```

Each write records a commit. Use `cvm drive restore` to bring back an earlier version, or fork a Drive and preview the merge with `cvm drive merge FORK --dry-run`.

### Mount a Drive from source

The npm CLI at 2.0.0 ships without `drive mount`. Build the current CLI and the `caveman-drive-mount` helper from the repo root. This example uses a macOS or Linux shell; you'll need Node 24, pnpm 10.14.0 and Go 1.24+.

```bash
pnpm install --frozen-lockfile
pnpm --filter @caveman-ai/cloud build
mkdir -p "$HOME/.local/bin"
(cd drive-mount && go build -o "$HOME/.local/bin/caveman-drive-mount" ./cmd/caveman-drive-mount)
CAVEMAN_DRIVE_MOUNT_BIN="$HOME/.local/bin/caveman-drive-mount" \
  node packages/cli/bin/cvm.mjs drive mount research "$HOME/Drives/research"
```

The helper uses loopback WebDAV. Mounts are read-only unless you pass `--read-write`. Protected paths such as `.git` and `AGENTS.md` stay hidden by default. On Linux a native mount needs davfs2 or GVFS; use `--webdav-only` to serve WebDAV without mounting it.

## Query request traffic

Use SQL to count requests by model in your project:

```bash
cvm sql --schema requests
cvm sql "SELECT model, count() AS n FROM requests GROUP BY model ORDER BY n DESC" --window 7d
```

## API reference

The [operation catalog](./contracts/operations.public.json) lists 389 public operations in this checkout. Browse them in the terminal with `cvm tools list`.

| TypeScript entry point | Use |
|---|---|
| `@caveman-ai/sdk` | Gateway client, tracing and OpenTelemetry export |
| `@caveman-ai/sdk/cloud` | Typed client for the public Cloud API |
| `@caveman-ai/sdk/agents` | Sessions and their event streams |
| `@caveman-ai/sdk/sandboxes` | Sandbox lifecycle and command streams |
| `@caveman-ai/sdk/evals` | Datasets, experiments and baseline verdicts |
| `@caveman-ai/sdk/router` | Model routing and task execution |

`cvm` and the TypeScript, Python and Go SDKs have no runtime package dependencies. [The Claude Code router hook](./packages/router-claude-code/README.md) is a separate npm package: `@caveman-ai/router-claude-code@0.1.0`. The repo also includes a [LiteLLM connector](./python/caveman-litellm/README.md).

See [Contributing](./CONTRIBUTING.md) for SDK parity checks and [Security](./SECURITY.md) for private reports. The SDKs are MIT; the CLI, router hook and mount helper are Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
