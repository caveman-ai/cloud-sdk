# Contributing to Caveman Cloud SDK & CLI

Thank you for contributing to `caveman-ai/cloud-sdk`. Read [`AGENTS.md`](AGENTS.md)
for repository architecture and invariants before opening a pull request.

## Prerequisites

- **Node.js 24+** and **pnpm 10.14+** (TypeScript packages & skills)
- **Go 1.23+** (Go SDK in `go/`)
- **Python 3.13+** with `pytest` (Python SDK in `python/caveman-sdk/`)

## Development workflow

```bash
pnpm install
pnpm -r build
pnpm -r test
(cd go && go test ./...)
PYTHONPATH=python/caveman-sdk pytest python/caveman-sdk/tests
node --test skills/budget.test.mjs
```

## Guidelines

- Keep `@caveman-ai/sdk`, `@caveman-ai/cloud`, and `caveman-sdk` free of runtime dependencies.
- Preserve cross-language wire parity across `packages/sdk-ts/`, `python/caveman-sdk/`, and `go/`.
- Include unit or parity tests for behavior changes and update `docs/` when changing public commands or APIs.
- Use scoped conventional commits (for example, `fix(sdk-ts): ...`, `feat(cli): ...`, `docs(go): ...`).
- Report security issues privately per [`SECURITY.md`](SECURITY.md).
