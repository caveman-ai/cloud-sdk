# Caveman Cloud Go SDK

Typed resources over the same scoped operation contract as Cloud CLI/MCP.
Source package: `github.com/JuliusBrussee/caveman/sdk/go`, package name
`cavemancloud`. This Cloud-owned implementation has not been established as a
published public-module release. Use this checkout's `public` module locally.

```go
client, err := cavemancloud.New(cavemancloud.Options{
    ControlURL: controlURL, AccessToken: accessToken, ProjectID: projectID,
})
if err != nil { return err }
suites, err := client.ScenarioSuites.List(ctx, nil, cavemancloud.CallOptions{})
```

`CloudOperations` counterparts are generated Go input/result structs; JSON
unions and domain-owned documents use `json.RawMessage` or `any`. Server domain
validation and permissions remain authoritative. Required receipted mutations
need `CallOptions{IdempotencyKey: ...}`. No writes are automatically retried;
redirects are refused and responses/timeouts are bounded. Accepted is not passed.

## Gateway models: route, trim and compact

`NewGateway` addresses the gateway with a project key (the base URL and key the
TypeScript and Python `Cave` clients use). `Trim` is compression of one payload
against a query; `Compact` is compaction of a whole message history to a token
budget. A non-2xx answer returns an `*Error` with `Status`, `Code` (such as
`cave_model_allowance_exhausted`), `Message` and `RequestID`; nothing passes
through.

```go
gateway, err := cavemancloud.NewGateway(cavemancloud.GatewayOptions{
    BaseURL: gatewayURL, APIKey: projectKey, Agent: "support-agent",
})
if err != nil { return err }
decision, err := gateway.Route(ctx, map[string]any{"text": "Rename the helper and update its callers."})
trimmed, err := gateway.Trim(ctx, cavemancloud.TrimRequest{Input: toolOutput, Query: "why did the job fail?"})
compacted, err := gateway.Compact(ctx, cavemancloud.CompactRequest{Messages: messages, BudgetTokens: 8000})
```

`decision.Raw` keeps every field the router sent. `compacted.Messages` are the
gateway's JSON, in the input's message shape; the budget and token counts
exclude the leading system messages. The client sends `metadata` retention
unless `GatewayOptions.Retention` is `"configured"`; only then are recovery
handles returned.

## Run Caveman Code agents (Agents API)

```go
agents, err := cavemancloud.NewAgents(cavemancloud.AgentsOptions{ControlURL: "https://api.caveman.so", APIKey: os.Getenv("CAVEMAN_CODE_KEY")})
session, err := agents.StartSession(ctx, cavemancloud.AgentsStartSessionInput{RequestId: requestID, Repo: "acme/api", Task: "Fix the flaky test"})
err = agents.StreamEvents(ctx, session.Id, 0, func(e cavemancloud.CodeStreamEvent) error { fmt.Println(e.Type); return nil })
```

The key is a service account's `code:run` key; it sees and drives only that
account's sessions. A stream ends after 15 minutes: call `StreamEvents` again
with the last seq.

`UploadFile` and `DownloadFile` move a file's bytes; `StartSession` attaches
files (`Files`, mounted read-only at `/mnt/session/uploads/<name>`) and memory
stores (`MemoryStores`, `read_write` or `read_only`).

## Sandboxes: run commands in a Cloud computer

```go
sandboxes, err := cavemancloud.NewSandboxes(cavemancloud.SandboxesOptions{ControlURL: "https://app.caveman.so", APIKey: os.Getenv("CAVE_TOKEN")})
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

The key is an organization's `code:run` key; it sees only the sandboxes its
service account made. `Exec` streams to an `io.Writer` and reads an `io.Reader`;
`ExecOptions` takes `Env`, `Cwd` (absolute), `User`, and with `TTY` the terminal's
`Cols` and `Rows`; a `*SandboxCommand` as `Control` resizes the terminal (`Resize`)
and sends the command a signal (`SendSignal(cavemancloud.SandboxSignalTerm)`) while it
runs, what the sandbox does not act on coming to `OnRefused`, the command going on.
`Sleep`, `Resume`, `List` and `Get` are the rest; `Status(ctx)` reads whether sandboxes work
right now, where the Cloud publishes it (GET /api/v1/status/sandboxes: public, so the key is
ignored there). `Wait(ctx, id, state)` is one read
the API holds until the state (up to a minute at a time, one request to its rate
limits); a Caveman Cloud that does not wait is polled. `List` answers a page, newest
first: ask again with `SandboxesListQuery{Cursor: page.NextCursor}` until
`NextCursor` is nil (`Limit` sets the page's size, at most 500). A refusal is an `*Error` with
the API's code (`SandboxErrorNotFound`, ...), a command's stream that ends
without an exit a `*SandboxExecError` (such as `cave_code_computer_not_running`). The stream is a
WebSocket on the relay at `RelayURL` (default `ControlURL`), with the standard
library alone. Sandboxes are behind the installation's `computers.api.enabled` switch.
A command whose sandbox's host is restarting (`cave_code_computer_host_unreachable`) is
opened again for up to 15 seconds before it starts, when its Stdin is nil or an io.Seeker.
`Wait` reads a sandbox's `ObservedReasonCode` beside its sentence: it waits on through one
that passes by itself (`SandboxReasonWaitingForCapacity`, `SandboxReasonHostUnavailable`, ...),
even while the sandbox reads failed, and ends with a `*SandboxStateError` on one that needs you
(`SandboxReasonStoppedByHost`, `SandboxReasonOutOfMemory`, ...).

```go
_, err = sandboxes.WriteFile(ctx, box.Id, "/tmp/in.txt", strings.NewReader("hello"), cavemancloud.WriteFileOptions{})
text, err := sandboxes.ReadFile(ctx, box.Id, "/tmp/in.txt", cavemancloud.FileOptions{})
files, err := sandboxes.ListFiles(ctx, box.Id, "/tmp", cavemancloud.FileOptions{})
web, err := sandboxes.DialPort(ctx, box.Id, 8080) // a TCP connection to the sandbox's own port 8080
```

A sandbox's files are read and written as streams through the relay, one operation each
(`ReadFile`, `StreamFile`, `WriteFile` with `Mode` and `Atomic`, `ListFiles`, `StatFile`,
`MakeDir`, `RemoveFile`, `RenameFile`; `Root` acts as the sandbox's root). What its file system
refuses is a `*SandboxFileError` (`cave_code_computer_file_not_found`, `_permission`, `_exists`,
`_too_large`, `_refused`, with the system's words), a `*SandboxExecError` to `errors.As` too.
`DialPort` reaches a port on the sandbox's loopback only: a `*SandboxConn` to `Read`, `Write`,
`CloseWrite` and `Close`; nothing listening is `cave_code_computer_port_refused`.

```go
snap, err := sandboxes.Snapshot(ctx, box.Id, cavemancloud.SandboxesSnapshotInput{Name: &name})
snap, err = sandboxes.WaitForSnapshot(ctx, box.Id, snap.Id)                           // ready
child, err := sandboxes.Fork(ctx, box.Id, snap.Id, cavemancloud.SandboxesForkInput{}) // a new sandbox from it
_, err = sandboxes.Restore(ctx, box.Id, snap.Id)                                      // its disk back under box
_, err = sandboxes.WaitForRestore(ctx, box.Id, snap.Id)
_, err = sandboxes.DeleteSnapshot(ctx, box.Id, snap.Id)
```

A snapshot is a copy of a sandbox's disk, kept on the host that took it, and the key's alone
(`ListSnapshots`, `GetSnapshot`). `Fork` makes a new sandbox from it, as `Create` does, at the
snapshot's size unless asked another; `Restore` puts it back under the sandbox it was taken of,
which must be running (its processes end and it starts again on the snapshot's disk). A take or a
restore that cannot end as asked ends `WaitForSnapshot` or `WaitForRestore` with a
`*SnapshotStateError` carrying the snapshot (`ReasonCode` and `Reason`, or `Restore.ReasonCode`:
`snapshot_elsewhere` when the sandbox moved from the host keeping it; fork it instead). A
`DeleteSnapshot` is safe to ask again.

Where the Caveman Cloud serves ports at their own URLs (`https://<port>-<sandbox>.<domain>`),
`URL` answers one: a port is private until its sandbox's maker makes it public.

```go
web, err := sandboxes.URL(ctx, box.Id, 3000, cavemancloud.URLOptions{TTL: time.Hour})
req, _ := http.NewRequestWithContext(ctx, "GET", web.URL, nil)
req.Header = web.Headers.Clone() // Caveman-Port-Token; web.Link opens it in a browser, within minutes
public := true
_, err = sandboxes.URL(ctx, box.Id, 3000, cavemancloud.URLOptions{Public: &public}) // anyone with the address
```

`TTL` (a minute to a day, an hour when zero) is how long the token, and the cookie a link leaves,
open the port. `Ports`, `SetPort` and `PortToken` are the plain calls under it.
The quickstart: [`docs/sandboxes-quickstart.md`](../../../docs/sandboxes-quickstart.md).

Run `go test ./sdk/go` from `public/`. Regenerate from the repository root with
`node scripts/generate-cloud-sdk.mjs --language=go`; CI checks exact output parity.

[Workflow and SDK guide](../../../cloud/web/app/docs/cloud-sdk/page.mdx).
