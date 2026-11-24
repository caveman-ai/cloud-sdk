---
name: caveman-drive
description: Share versioned, KMS-sealed, RBAC-scoped filesystems across agents and humans with `cvm drive` (diffs, forks, merges, review changesets, and share tokens).
---

# Caveman Drives

Versioned, hash-chained cloud filesystems whose access controls live outside compute, with taint tracking and human-reviewed changeset forks.

## 30-second start

```sh
cvm login
cvm drive create team-kb
cvm drive put ./README.md team-kb/README.md
cvm drive ls team-kb
cvm drive grep "policy" team-kb
```

## Core commands

- Files: `cvm drive ls`, `cvm drive cat`, `cvm drive get`, `cvm drive put`, `cvm drive mv`, `cvm drive rm`, `cvm drive grep`
- History & integrity: `cvm drive log`, `cvm drive changes`, `cvm drive diff`, `cvm drive restore`, `cvm drive verify`
- Branching & human review: `cvm drive fork`, `cvm drive merge`, `cvm drive review`, `cvm drive approve`, `cvm drive reject`, `cvm drive undo`
- Access control: `cvm drive share`, `cvm drive grants`, `cvm drive grant`, `cvm drive revoke`

## Rules

- Mount untrusted-agent write folders with `review: true` so changes land in a changeset fork for human approval.
- Use `as: "intersection"` in `agent.json` mounts when both deployer and turn-initiator permissions must hold.
