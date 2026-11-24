# Sandboxes quickstart (draft)

Draft of 2026-11-19, with no authority: the code and its tests decide. It becomes the console's docs page
`cloud/web/app/docs/sandboxes/page.mdx` (an entry in `cloud/web/lib/docs-nav.ts`, then
`make generate-markdown-routes`) once an installation outside local may turn sandboxes on
(`computers.api.enabled`: production refuses it until the founder rules on WAVE4's calls 1 to 4, and
any install but a local one refuses the Firecracker fleet it needs until C call 1). It cannot go to docs.caveman.so: that
site documents public capabilities only, and sandboxes are Caveman Cloud's.

Every snippet below is the body of an end-to-end test that runs against a real control-api and relay
(`Caveman Cloud API`); `public/cloud-cli/tests/sandbox.test.mjs` fails when a
snippet here and its test part ways. Each test's own variables (`api`, `relay`, `key`) are set at the top
of each snippet.

A sandbox is a computer in Caveman Cloud with nothing of Caveman inside it. You make one, run commands
in it from outside, take snapshots of it and make new sandboxes from them, put it to sleep and delete
it. Each is made and used with an organization's `code:run` key, which acts as its service account and
sees only the sandboxes that service account made.

## 1. Install

| | |
|---|---|
| CLI | `npm i -g @caveman-ai/cloud` (the `cvm` command) |
| TypeScript | `npm i @caveman-ai/sdk` (Node 22.13 or later; import `@caveman-ai/sdk/sandboxes`) |
| Python | `pip install https://github.com/caveman-ai/cloud-sdk/releases/download/v2.0.0/caveman_sdk-2.0.0-py3-none-any.whl` (3.13 or later; `from caveman_cloud import Sandboxes`) |
| Go | package `github.com/JuliusBrussee/caveman/sdk/go`; not yet a published module release: use the `public` module of a Caveman Cloud checkout |

## 2. Authenticate

Make a service account and a `code:run` key for it in the console (Settings > Service accounts), then:

```sh
export CAVE_TOKEN=cave_live_...                 # the key; every client below reads it
export CAVE_API_URL=https://app.caveman.so      # your Caveman Cloud: the API and the relay at one address
```

A command reaches a sandbox through the relay, which a Caveman Cloud serves at `/relay` beside
`/api/v1` on its app address, and whose streams into sandboxes it also serves on its API address
(`/relay/v1/computers`). Point the clients at either. Each sandbox says its own stream's address as
`exec_url` where the Cloud names one. Where the relay is elsewhere, set `CAVE_RELAY_URL` (`relayURL`,
`relay_url`, `RelayURL`).

## 3. Create, run a command, clean up

<!-- snippet: cli -->
```sh
cvm sandbox create --name quickstart-cli
cvm sandbox exec $ID -- sh -c 'echo hello from the sandbox; echo careful >&2; exit 3'
cvm sandbox delete $ID --yes
```

`create` waits until the sandbox runs and prints its id (`ID` above). `exec` streams the command's
stdout and stderr apart, and cvm exits with the command's exit code (3 here). `-i` sends your input
to the command.

<!-- snippet: typescript -->
```ts
import { Sandboxes } from '@caveman-ai/sdk/sandboxes';
const api = process.env.CAVE_API_URL!, relay = process.env.CAVE_RELAY_URL ?? api, key = process.env.CAVE_TOKEN!;

const sandboxes = new Sandboxes({controlURL: api, relayURL: relay, apiKey: key});
const box = await sandboxes.create({name: 'quickstart-ts'});
await sandboxes.waitFor(box.id, 'running');
const result = await sandboxes.run(box.id, ['sh', '-c', 'echo hello from the sandbox; echo careful >&2; exit 3']);
// result: {exitCode: 3, stdout: 'hello from the sandbox\n', stderr: 'careful\n'}
await sandboxes.delete(box.id);
```

<!-- snippet: python -->
```python
import os
from caveman_cloud import Sandboxes
API, KEY = os.environ["CAVE_API_URL"], os.environ["CAVE_TOKEN"]
RELAY = os.environ.get("CAVE_RELAY_URL", API)

sandboxes = Sandboxes(control_url=API, relay_url=RELAY, api_key=KEY)
box = sandboxes.create({"name": "quickstart-py"})
sandboxes.wait(box["id"], "running")
result = sandboxes.run(box["id"], ["sh", "-c", "echo hello from the sandbox; echo careful >&2; exit 3"])
# result: ExecResult(exit_code=3, stdout=b"hello from the sandbox\n", stderr=b"careful\n")
sandboxes.delete(box["id"])
```

<!-- snippet: go -->
```go
// import cavemancloud "github.com/JuliusBrussee/caveman/sdk/go"
api, relay, key := os.Getenv("CAVE_API_URL"), os.Getenv("CAVE_RELAY_URL"), os.Getenv("CAVE_TOKEN")
check := func(err error) {
	if err != nil {
		log.Fatal(err)
	}
}

sandboxes, err := cavemancloud.NewSandboxes(cavemancloud.SandboxesOptions{ControlURL: api, RelayURL: relay, APIKey: key})
check(err)
name := "quickstart-go"
box, err := sandboxes.Create(ctx, cavemancloud.SandboxesCreateInput{Name: &name})
check(err)
_, err = sandboxes.Wait(ctx, box.Id, cavemancloud.SandboxStateRunning)
check(err)
result, err := sandboxes.Run(ctx, box.Id, []string{"sh", "-c", "echo hello from the sandbox; echo careful >&2; exit 3"}, nil)
check(err)
// result.ExitCode is 3, result.Stdout "hello from the sandbox\n", result.Stderr "careful\n"
_, err = sandboxes.Delete(ctx, box.Id)
check(err)
```

## 4. What else

- **Sleep and wake.** `sleep` stops a sandbox and keeps its disk; `resume` wakes it (each client's wait
  says when it runs again).
- **Waiting.** Each client's wait (`waitFor`, `wait`, `Wait`, and `cvm sandbox create`, `resume` and
  `sleep --wait`) is one read the API holds until the state, up to a minute at a time:
  `GET /api/v1/code/computers/{id}?wait_for=running&timeout=60`, whose `Cave-Wait` header says
  `satisfied`, `unreachable` or `timeout` (ask again). One request to the rate limits however long
  it waits; a caller holds at most 16 at once (`429 cave_code_computer_waits_limit`). A Caveman Cloud
  that answers no `Cave-Wait` does not wait, and the clients poll it instead. A sandbox also goes to sleep after it went unused for its
  `sleep_after_seconds` (10 minutes unless set at create; 0 never). Use is what Caveman Cloud sees:
  made, woken, a command started, and every 30 seconds while one runs.
- **Streams.** `exec` (TypeScript and Go `Exec`, Python `exec`) streams output as it comes and takes
  stdin; `tty` asks for a terminal. A command takes an environment, a folder, a user and its
  terminal's size, and while it runs a resize and a signal (INT, TERM, HUP, QUIT, KILL, USR1, USR2,
  WINCH, CONT, STOP, TSTP) through each SDK's command control; one the sandbox does not act on is
  answered refused and the command goes on. Ending the stream ends the command.
- **Errors.** A refusal carries the API's code: `cave_not_found` (no such sandbox for this key),
  `cave_code_computer_limit_*` (a limit reached), `cave_code_credits_exhausted`, `cave_bad_request`.
  A command that cannot run says why: `not_running` (resume it first), `computer_stopped` (put to
  sleep or deleted while it ran), `too_many_streams`, `rate_limited`.
- **Lifetime and network.** `lifetime_seconds` (60 to 2592000) deletes a sandbox that long after
  its create, whatever it is doing, as `DELETE` does; its answers say when, as `expires_at`.
  `network: "none"` gives it no network device (commands, files and ports still reach it through the
  relay), `"internet"` the installation's egress; absent, the installation's default. An idle pause
  (`idle.pause_after_seconds`) on an installation whose hosts pause nothing in place, or a network
  its hosts cannot give, is refused (`409 cave_code_computer_unsupported`); out of bounds is
  `cave_code_computer_lifetime_invalid`, an unknown network `cave_code_computer_network_invalid`.
- **Sizes.** `size` is `<cores>cpu-<gigabytes>gb` (`--size 2cpu-4gb`), up to what your plan and the
  installation allow; absent, the installation's default.
- **Switched off.** An installation offers sandboxes only with `computers.api.enabled`. Off, every route
  answers exactly as it did before sandboxes existed, so no error code says "off"; each caller learns it from
  what it gets. A key: `403 cave_api_key_route_forbidden` on a list, a get or any route on one sandbox, and
  `405 cave_method_not_allowed` on a create (while sandboxes are on, a key gets neither on these routes). A
  person's sign-in: the list answers without `computers_api` (present, and `true`, only while sandboxes are
  on), and a get without `bare`. A stream is refused before it opens (404). `cvm sandbox` turns each of these
  into one line, `cave_sandboxes_off` (exit 4); each SDK raises the API's code as it came.
- **A device sign-in.** `cvm login` cannot make or enter a sandbox (`403
  cave_code_computer_device_login_forbidden`): use a `code:run` key, as above.
- **A port at its own URL.** Where the installation turns it on (`computers.portUrls`, on in hosted
  Cloud), what listens on a port in a sandbox has an address of its own,
  `https://<port>-<sandbox id>.<domain>`, on a domain that is the installation's and never under
  caveman.so. A port is private until the key or person that made the sandbox makes it public:
  `cvm sandbox url <id> 3000` prints a link to open in a browser (it opens once, within five
  minutes, then the browser keeps a cookie for that host until the token's expiry, an hour unless `--ttl` says
  otherwise), and each SDK's `url` (`sandboxes.url(id, 3000)`, Go `sandboxes.URL(ctx, id, 3000,
  cavemancloud.URLOptions{})`) answers the address, the link, and the header a program sends
  (`Caveman-Port-Token`). `--public` (`{public: true}`, `public=True`, `URLOptions{Public: &yes}`)
  opens the port to anyone with the address; `--private` closes it again, within about 30 seconds
  for a request already open. A token opens one port of one sandbox, and stops once its maker may
  no longer enter the sandbox. The sandbox sees the request as sent, with its Host, minus the token
  header and the cookie; a dev server that checks its host (Vite's `server.allowedHosts`) has to
  allow `.<domain>`. `/_caveman/open` is the link's own path and never reaches the sandbox. Where the
  installation does not serve them, the routes answer 404 (`cvm`: `cave_sandbox_ports_off`), and
  `cvm sandbox port-forward` and each SDK's `dialPort` reach a port from your machine either way.
- **An agent or MCP connection.** It reaches sandboxes only as a service account its approver bound
  to it: when an Owner or Admin approves the connection (the device page, or the MCP client's consent
  page), they may choose one of the connection's project's enabled service accounts under Sandboxes.
  The connection then makes and uses sandboxes as that account, exactly as its `code:run` key would
  (its limits, the start ceiling, funding; the organization pays), and over MCP through the `computers.*`
  operations. One with none bound is refused (`403 cave_agent_operation_forbidden`); approve it
  again and choose an account.

## 5. Snapshots and forks

A snapshot is a copy of a sandbox's disk, taken while it runs (its writes flushed and the sandbox
paused for the copy) or while it sleeps, and kept on the host that took it. It is the key's alone:
the service account that made the sandbox takes, lists, restores, forks and deletes it, and no other
key sees it. A take and a restore are asked, then done by Caveman Cloud: each client waits for them.

| | cvm | TypeScript | Python | Go |
|---|---|---|---|---|
| Take one, wait until ready | `cvm sandbox snapshot $ID [--name N]` | `snapshot`, `waitForSnapshot` | `snapshot`, `wait_for_snapshot` | `Snapshot`, `WaitForSnapshot` |
| List, read | `cvm sandbox snapshots $ID` | `listSnapshots`, `getSnapshot` | `list_snapshots`, `get_snapshot` | `ListSnapshots`, `GetSnapshot` |
| A new sandbox from one | `cvm sandbox fork $ID $SNAPSHOT [--name N]` | `fork` | `fork` | `Fork` |
| Put one back under its sandbox | `cvm sandbox restore $ID $SNAPSHOT` | `restore`, `waitForRestore` | `restore`, `wait_for_restore` | `Restore`, `WaitForRestore` |
| Delete one | `cvm sandbox snapshot-delete $ID $SNAPSHOT --yes` | `deleteSnapshot` | `delete_snapshot` | `DeleteSnapshot` |

The routes are under the sandbox: `POST /api/v1/code/computers/{id}/snapshots` (201, `state`
`taking` until `ready`), `GET .../snapshots` and `.../snapshots/{snapshotId}`, `DELETE
.../snapshots/{snapshotId}` (safe to repeat: `deleting`, then `deleted`), `POST
.../snapshots/{snapshotId}/restore` (202: `restore.state` `restoring` until `restored`) and `POST
.../snapshots/{snapshotId}/fork` (201: a new sandbox, the create's body and limits). An
`Idempotency-Key` makes a take and a fork safe to repeat.

- **Fork** makes a new sandbox from the snapshot, at the snapshot's size unless asked another,
  placed on the host that keeps it. Its sandbox may since have been deleted. A snapshot deleted
  before the new sandbox is made fails it (`observed_reason_code` `snapshot_gone`); it is never made
  from anything else.
- **Restore** puts the snapshot back under the sandbox it was taken of, which must be running: its
  processes end and it starts again on the snapshot's disk, under the same id. Only where the
  snapshot is kept: a sandbox that moved to another host since is refused (`409
  cave_code_computer_unsupported`; fork the snapshot instead).
- **Failed.** A take that could not be made reads `failed` with a `reason_code`:
  `computer_not_placed` (the sandbox has no disk on any host), `snapshots_unsupported`, or
  `internal_error` with a reference. A restore's own `restore.reason_code` adds `snapshot_elsewhere`
  and `snapshot_gone`.
- **Refused.** `409 cave_code_computer_unsupported` where the installation cannot keep a snapshot of
  the sandbox, `cave_code_computer_snapshot_not_ready` (a fork or restore of one not ready),
  `cave_code_computer_snapshot_busy` (a second restore of a sandbox), `cave_code_computer_asleep`
  (wake it before a restore), `cave_code_computer_limit_snapshots` (a key keeps at most 32 snapshots
  taking or ready at once).
- **Not charged yet.** A kept snapshot costs nothing today; its price is still to be set.
