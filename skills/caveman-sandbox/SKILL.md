---
name: caveman-sandbox
description: >
  Create, run commands in, copy files to/from, snapshot, fork, expose ports on,
  and pool zero-credential Firecracker sandboxes with `cvm sandbox`, `cvm pools`,
  and the TS/Python/Go Sandboxes and ComputerPools SDKs.
---

# Caveman Sandboxes & Computer Pools

Zero-credential Firecracker microVMs driven from outside through the Caveman
Relay. Paused/sleeping sandboxes keep their disk at zero compute cost.

## 1. 30-second start

```sh
cvm login
cvm key quick                                          # caches personal 30-day code:run key
cvm sandbox create --name dev-box --size 4cpu-16gb --sleep-after 10m
cvm sandbox exec dev-box -- sh -c 'uname -a && node -v'
cvm sandbox cp ./script.py dev-box:/tmp/script.py
cvm sandbox url dev-box 3000 --ttl 1h                  # private URL + Caveman-Port-Token
cvm sandbox sleep dev-box --wait
```

`cvm sandbox` automatically uses `~/.caveman/code-key` (from `cvm key quick`)
unless `CAVE_TOKEN` or `CAVE_NO_AUTO_KEY=1` is set.

## 2. Full `cvm sandbox` CLI reference

- **Lifecycle**:
  - `cvm sandbox create [--name NAME] [--size 4cpu-16gb] [--sleep-after 10m|2h|0] [--lifetime 1h] [--network none|internet] [--no-wait]`
    (`--sleep-after 0` disables auto-sleep; `--lifetime` accepts `1m`..`30d` hard TTL)
  - `cvm sandbox list [--mine]` · `cvm sandbox get SANDBOX` · `cvm sandbox status` (public health canary)
  - `cvm sandbox sleep SANDBOX [--wait]` · `cvm sandbox resume SANDBOX [--no-wait]`
  - `cvm sandbox delete SANDBOX --yes`
- **Exec & files** (streamed over Relay WebSocket; exit code matches the command):
  - `cvm sandbox exec [-i] [-t] [-e KEY=VALUE]... [-w /abs/dir] [-u USER] SANDBOX -- CMD [ARGS...]`
  - `cvm sandbox cp [--root] SRC DST` (`SANDBOX:/path` on one side, local file or `-` on the other)
  - `cvm sandbox ls [--root] SANDBOX /path`
- **Ports**:
  - `cvm sandbox port-forward SANDBOX [LOCAL:]PORT` (loopback tunnel until Ctrl-C; `0` picks a free port)
  - `cvm sandbox url SANDBOX PORT [--public|--private] [--ttl 1m..24h]` (private by default; `--format json` includes the `Caveman-Port-Token` header)
- **Disk snapshots & instant forks**:
  - `cvm sandbox snapshot SANDBOX [--name clean-deps] [--no-wait]`
  - `cvm sandbox snapshots SANDBOX`
  - `cvm sandbox fork SANDBOX SNAPSHOT [--name worker-1] [--size 4cpu-16gb] [--sleep-after 10m] [--no-wait]`
  - `cvm sandbox restore SANDBOX SNAPSHOT [--no-wait]` (running sandbox only; ends current processes)
  - `cvm sandbox snapshot-delete SANDBOX SNAPSHOT --yes`

## 3. N:M Org Computer Pools (`cvm pools`)

Share pre-warmed sandboxes across agent swarms and inspect Cloud + local Macs:

```sh
cvm pools create ci-workers --size 2cpu-4gb --network internet --min-warm 2 --max-size 16
cvm pools list
cvm pools computers --scope all          # all | personal | org_pool | session | local
cvm pools archive ci-workers
```

## 4. Programmatic SDKs (TypeScript, Python, Go)

**TypeScript** (`@caveman-ai/sdk/sandboxes` & `@caveman-ai/sdk/pools`):
```ts
import { Sandboxes } from '@caveman-ai/sdk/sandboxes';
import { ComputerPools } from '@caveman-ai/sdk/pools';

const opts = { controlURL: process.env.CAVE_API_URL!, apiKey: process.env.CAVE_TOKEN! };
const sb = new Sandboxes(opts);
const box = await sb.create({ name: 'eval-runner', network: 'none' });
await sb.wait(box.id, 'running');
await sb.writeFile(box.id, '/tmp/in.json', JSON.stringify({ ok: true }), { atomic: true });
const res = await sb.run(box.id, ['python3', '-c', 'print(open("/tmp/in.json").read())']);
const snap = await sb.snapshot(box.id, { name: 'base' });
await sb.waitForSnapshot(box.id, snap.id);
const fork = await sb.fork(box.id, snap.id, { name: 'trial-1' });
await sb.delete(box.id);

// Lease from an N:M org pool for a session:
const pools = new ComputerPools(opts);
const lease = await pools.leaseForSession(sessionId, { pool: 'ci-workers', role: 'worker' });
await pools.releaseForSession(sessionId, lease.computer_id);
```

- **Python**: `from caveman_cloud import Sandboxes, ComputerPools` (`create`, `wait`, `run`, `exec`, `write_file`, `read_file`, `list_files`, `dial_port`, `url`, `snapshot`, `fork`, `restore`, `sleep`, `resume`, `delete`, `lease_for_session`).
- **Go**: `github.com/caveman-ai/sdk-go` (`NewSandboxes`, `NewComputerPools`).

## 5. Rules & failure handling

- **Zero credentials in VMs**: never copy provider API keys, org tokens, or GitHub logins into a sandbox; model and git traffic routes through the Relay outside compute.
- **Isolate untrusted code**: always pass `--network none` (and a `--lifetime` cap) when executing untrusted code or eval suites.
- **Host-local snapshots**: if `restore` fails with `snapshot_elsewhere` (the sandbox moved hosts), use `fork` from that snapshot instead.
- **Transient vs terminal states**: `wait` automatically rides through `waiting_for_capacity` / `host_unavailable` and fails on terminal states (`out_of_memory`, `stopped_by_host`).
- **Private ports by default**: keep `--private` unless a human explicitly requests `--public`.
