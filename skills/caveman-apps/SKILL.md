---
name: caveman-apps
description: Build, fork, and embed Drive-backed or sandbox-backed tenant Apps and Inbox Review Apps with `cvm apps` and the scoped capability bridge.
---

# Caveman Apps

Tenant-owned interfaces living in Drives or served from sandbox ports, rendered in isolated iframes with short-lived capability-bridge tokens (`capp_...`).

## 30-second start

```sh
cvm drive create review-ui
cvm drive put ./index.html review-ui/index.html
cvm apps create tax-review --kind drive_static --drive review-ui --scope drive:read --scope room:post
cvm apps token tax-review --ttl 3600
```

## Core commands

- Manage apps: `cvm apps list`, `cvm apps create`, `cvm apps archive`
- Clone & customize: `cvm apps fork SOURCE_APP NEW_SLUG` (forks the backing Drive automatically)
- Mint isolated iframe tokens: `cvm apps token APP`

## Rules

- Request only the narrowest manifest scopes (`drive:read`, `drive:write`, `room:post`, `inbox:action`).
- Never embed static API keys in App HTML/JS; call the bridge endpoint with the minted `capp_...` token.
