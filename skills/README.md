# Caveman Cloud Agent Skills (`skills/`)

Official `SKILL.md` skills installed by `cvm setup` for coding agents (Claude
Code, Codex, Cursor, VS Code, Windsurf, Gemini CLI, OpenCode).

- `caveman-cloud*`: Cloud control-plane skills (onboarding, setup, traces, evals, criteria, compare, scenarios, dashboards, connect, console, project).
- `caveman-deploy`, `caveman-sandbox`, `caveman-drive`, `caveman-rooms`, `caveman-apps`, `caveman-listeners`, `caveman-workflows`, `caveman-sql`: Agent platform and sandbox skills.
- `compile.mjs`, `verbs-gate.mjs`, `budget.test.mjs`: Skill compiler and token-budget / verb-gate tests.

## Test

```bash
node --test skills/budget.test.mjs
```
