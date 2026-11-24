---
name: caveman-sandbox
description: Create, run commands in, snapshot, fork, and expose ports on zero-credential Firecracker sandboxes with `cvm sandbox` and org computer pools with `cvm pools`.
---

# Caveman Sandboxes

Zero-credential Firecracker microVMs driven from outside through the Caveman relay.

## 30-second start

```sh
cvm login
cvm key quick
cvm sandbox create --name dev-box
cvm sandbox exec SANDBOX_ID -- sh -c 'uname -a'
cvm sandbox url SANDBOX_ID 3000
```

## Core commands

- Create / list / inspect: `cvm sandbox create`, `cvm sandbox list`, `cvm sandbox get SANDBOX_ID`
- Run commands & files: `cvm sandbox exec`, `cvm sandbox cp`, `cvm sandbox ls`, `cvm sandbox port-forward`
- Snapshots & instant forks: `cvm sandbox snapshot`, `cvm sandbox snapshots`, `cvm sandbox fork`, `cvm sandbox restore`
- Lifecycle: `cvm sandbox sleep`, `cvm sandbox resume`, `cvm sandbox delete`
- N:M pools & local Macs: `cvm pools list`, `cvm pools create`, `cvm pools computers`

## Rules

- Never place long-lived provider credentials inside a sandbox; the relay attaches credentials outside the VM.
- Set `--network none` for untrusted code evaluation.
