# Caveman Cloud Agent Skills (`skills/`)

Official public `SKILL.md` skills for coding agents (Claude Code, Codex,
Cursor, VS Code, Windsurf, Gemini CLI, OpenCode), installed via `cvm setup`,
`cvm skills add <skill|all>`, or directly from this repository (`npx skills add caveman-ai/cloud-sdk`).

- **`caveman-build`**: Master guide for building anything on Caveman Cloud (architecture, primitive matrix, patterns, and TypeScript/Python/Go SDKs).
- **`caveman-deploy`**, **`caveman-sandbox`**, **`caveman-drive`**, **`caveman-rooms`**, **`caveman-apps`**, **`caveman-listeners`**, **`caveman-workflows`**, **`caveman-sql`**: Deep-dive builder skills for each platform primitive.
- **`caveman-cloud*`**: Cloud control-plane skills (onboarding, setup, traces, evals, criteria, compare, scenarios, dashboards, connect, console, project).
- **`compile.mjs`**, **`verbs-gate.mjs`**, **`budget.test.mjs`**: Skill compiler and token-budget / verb-gate checks.

## Test

```bash
node --test skills/budget.test.mjs
```
