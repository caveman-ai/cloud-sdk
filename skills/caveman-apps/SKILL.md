---
name: caveman-apps
description: >
  Build, fork, and embed Drive-backed (`drive_static`), `sandbox_port`, or
  `json_ui` tenant Apps and Inbox Review Apps with `cvm apps`, `capp_...`
  capability-bridge tokens, and the TS/Python/Go `Apps` and `AppBridge` SDKs.
---

# Caveman Apps & Capability Bridge

Tenant-owned interfaces living in Drives or served from sandbox ports, rendered
on an isolated origin inside Rooms or Inbox decision cards with short-lived,
least-privilege capability-bridge tokens (`capp_...`).

## 1. 30-second start

```sh
cvm login
cvm drive create review-ui
cvm drive put ./index.html review-ui/index.html
cvm apps create tax-review \
  --name "Tax Review" \
  --kind drive_static \
  --drive review-ui \
  --entry index.html \
  --scope drive:read \
  --scope room:post
cvm apps token tax-review --ttl 3600
```

## 2. App kinds & manifest

- **`drive_static`**: static HTML/JS/CSS served from a Drive (`--drive`, optional `--folder`, `--entry index.html`). Forking the app forks its backing Drive automatically.
- **`sandbox_port`**: live web app running inside a sandbox (`--computer SANDBOX_ID --port 3000`).
- **`json_ui`**: declarative structured UI payload.

Allowed capability scopes (`--scope`, repeatable):
`drive:read`, `drive:write`, `room:read`, `room:post`, `deployment:run`, `inbox:action`.

Manifest fields (`AppManifest` in SDK): `scopes`, `drive_paths`, `deployments`, `rooms`, `default_title`, `height`.

## 3. Full `cvm apps` CLI reference

- `cvm apps list`
- `cvm apps create SLUG [--name NAME] --kind drive_static|sandbox_port|json_ui [--drive NAME] [--folder PATH] [--entry FILE] [--computer ID --port N] [--scope SCOPE]...`
- `cvm apps fork SOURCE_APP NEW_SLUG [--name NAME] [--drive NEW_DRIVE]`
- `cvm apps token APP [--ttl 3600]` -> returns `token` (`capp_...`), `scopes`, `render_url`, `expires_at`
- `cvm apps archive APP`

## 4. Calling the Capability Bridge from inside an App

An App runs in an isolated iframe with zero static API keys. Mint a short-lived
`capp_...` token (optionally bound to an `inbox_item_id` or `room_thread_id`)
and call the bridge endpoint (`POST /api/v1/code/apps/{appId}/bridge`) or use
`AppBridge`:

**TypeScript** (`@caveman-ai/sdk/apps`):
```ts
import { Apps, AppBridge } from '@caveman-ai/sdk/apps';

// Server / agent side: create, fork, or mint a scoped token
const apps = new Apps({ controlURL: process.env.CAVE_API_URL!, apiKey: process.env.CAVE_TOKEN! });
const issued = await apps.issueToken('tax-review', {
  ttl_seconds: 1800,
  scopes: ['drive:read', 'room:post'],
  room_thread_id: threadId,
});

// Inside the App iframe (using the minted capp_... token):
const bridge = new AppBridge(issued.app_id, { controlURL: origin, apiKey: issued.token });
const doc = await bridge.driveRead('drafts/q4.md');
await bridge.roomPost('finance-swarm', threadId, 'Approved line items', { approved: true });
```

- **Python**: `from caveman_cloud import Apps, AppBridge` (`create`, `list`, `get`, `fork`, `issue_token`, `archive`; `drive_read`, `drive_write`, `room_post`).
- **Go**: `github.com/caveman-ai/sdk-go` (`NewApps`, `NewAppBridge`).

Embed an App directly in a Room thread:
```sh
cvm room post eng-swarm THREAD_ID "Review diff UI" --kind app --data '{"app_slug":"tax-review"}'
```

## 5. Rules

- Request only the narrowest manifest scopes (`drive:read` before `drive:write`; omit `inbox:action` unless it is an Inbox Review App).
- Never embed static API keys, org tokens, or user credentials in App HTML/JS; authenticate every bridge call with the short-lived `capp_...` token.
- Keep `ttl_seconds` short (e.g. `1800`–`3600`) and bind tokens to `inbox_item_id` or `room_thread_id` whenever applicable.
