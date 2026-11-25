---
name: caveman-drive
description: >
  Manage versioned, KMS-sealed, RBAC-scoped cloud Drives across agents and
  humans with `cvm drive` (files, search, diffs, forks, review changesets,
  share tokens, zero-kext desktop mounts, and `AGENT.md` mounts).
---

# Caveman Drives

Versioned, hash-chained cloud filesystems whose access controls live outside
compute, with untrusted-content taint tracking, per-session undo, and
human-reviewed changeset forks.

## 1. 30-second start

```sh
cvm login
cvm drive create team-kb --description "Support policies and runbooks"
cvm drive put ./docs team-kb/docs
cvm drive ls team-kb/docs --recursive
cvm drive grep "refund" team-kb --glob "*.md" -i -C 2
cvm drive cat team-kb/docs/refunds.md --lines 1:80
```

## 2. Full `cvm drive` CLI reference

- **Files & search** (address format is `DRIVE[/PATH]`):
  - `cvm drive list` · `cvm drive create NAME [--description TEXT]`
  - `cvm drive ls DRIVE[/PATH] [--recursive]` (shows size, estimated tokens, author, version)
  - `cvm drive cat DRIVE/PATH [--version N] [--lines FROM:TO]`
  - `cvm drive get DRIVE/PATH [LOCAL] [--recursive] [--overwrite] [--version N] [--include-protected] [--force]`
    (`-` writes bytes to stdout; files > 64 MiB download in ranges; protected paths like `.git` or `CLAUDE.md` are skipped unless `--include-protected`)
  - `cvm drive put LOCAL DRIVE/PATH [--overwrite] [--dry-run] [--resume UPLOAD_ID]`
    (`-` reads stdin; files > 8 MiB upload in resumable parts)
  - `cvm drive grep PATTERN DRIVE[/PATH] [--glob G] [-i] [-F] [-C N] [--limit N]`
  - `cvm drive mv DRIVE/FROM TO_PATH` · `cvm drive rm DRIVE/PATH [--recursive] --yes`
- **Zero-kext desktop mount** (macOS, Windows, Linux loopback WebDAV):
  - `cvm drive mount DRIVE[/PATH] [MOUNTPOINT] [--read-write] [--include-protected] [--webdav-only] [--volume-name NAME]`
  - Read-only and protected-paths-hidden by default.
- **History, integrity & lifecycle**:
  - `cvm drive log DRIVE/PATH` · `cvm drive changes DRIVE [--after SEQ] [--limit N]`
  - `cvm drive diff DRIVE[/PATH] [--from SEQ] [--to SEQ]`
  - `cvm drive restore DRIVE/PATH --version N` (or folder restore with `--to SEQ_OR_TIME`)
  - `cvm drive verify DRIVE` (verifies hash-chain integrity)
  - `cvm drive set DRIVE [--keep 90d] [--description TEXT]` · `cvm drive usage`
  - `cvm drive archive DRIVE --yes` · `cvm drive unarchive DRIVE_ID`
- **Branching & human-reviewed changesets**:
  - `cvm drive fork DRIVE FORK_NAME [--at SEQ]` · `cvm drive merge FORK_NAME [--dry-run]`
  - `cvm drive review DRIVE [CHANGESET] [--status pending|approved|rejected]`
  - `cvm drive approve DRIVE CHANGESET --at SEQ [--dry-run]`
  - `cvm drive reject DRIVE CHANGESET --yes`
  - `cvm drive undo DRIVE --session SESSION_ID` (reverts everything one session wrote)
- **Access control & external share tokens**:
  - `cvm drive grants DRIVE`
  - `cvm drive grant DRIVE[/PATH] --to SERVICE_ACCOUNT_ID --read [--write] [--until TIME]`
  - `cvm drive share DRIVE[/PATH] --read [--write] [--for 15m] [--label TEXT]` -> mints `cdrv_...`
  - `cvm drive revoke DRIVE GRANT_ID`

## 3. Share-token mode (external agents, no login)

Pass `--token cdrv_...` (or set `CAVEMAN_DRIVE_TOKEN`) plus `--instance URL`
for self-hosted Clouds. Paths are relative to the shared folder (omit `DRIVE`):

```sh
CAVEMAN_DRIVE_TOKEN="cdrv_..." cvm drive               # show what the token opens
CAVEMAN_DRIVE_TOKEN="cdrv_..." cvm drive ls /
CAVEMAN_DRIVE_TOKEN="cdrv_..." cvm drive grep "SLA" /
```

Works with `ls`, `cat`, `get`, `put`, `grep`, `mv`, `rm`, `log`, and `diff`.

## 4. Mounting Drives in `AGENT.md`

Mount up to 8 paths (`/slug`) in an agent's frontmatter. Supported mount keys:
`drive`, `folder`, `write`, `review`, `trusted`, `description`.

```yaml
drives:
  /kb: team-kb
  /reports: { drive: research, folder: "digests", write: true, review: true, description: "Held for human review" }
  /customer: { drive: accounts, folder: "orgs/{customer}", write: true }
```

Fill `{customer}` placeholders at runtime with `cvm run my-agent "..." --subject customer=acme-42`.
During `cvm agent dev`, declared Drives mount locally under `.caveman/drives/<drive>/`.

## 5. Rules

- Set `review: true` on agent-writable folders where humans should audit changes before they land on the main tree; approve with `--at SEQ` so concurrent edits fail closed.
- Use `trusted: true` only on human-curated folders; non-trusted Drive content taints reading sessions and triggers connector `after_untrusted` gates.
- Never print `cdrv_...` share tokens into logs, commits, or Drive files, and never store provider API keys in a Drive.
