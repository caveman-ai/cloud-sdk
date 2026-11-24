---
name: researcher-drive
description: Scheduled research digest agent writing review-gated reports into a shared Drive.
computer: none
model: claude-sonnet-5-5
drives:
  /reports: { drive: research-reports, write: true, review: true }
schedules:
  daily-digest:
    cron: "0 9 * * 1-5"
    timezone: "UTC"
    task: "Compile today's digest into /reports/daily.md and summarize key changes."
    concurrency: skip
    budget_usd: 2
---

# Scheduled Researcher

Produce concise, citation-backed reports under `/reports/`. Writes are held as changesets for human review before merging to the shared Drive.
