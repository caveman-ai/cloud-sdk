# Public API Contracts (`contracts/`)

Sanitized public wire contracts for Caveman Cloud consumed by the `cvm` CLI,
TypeScript/Python/Go SDKs, and `docs.caveman.so` API reference.

| File / Directory | Contents |
|---|---|
| `openapi.json` | Public OpenAPI specification for Caveman Cloud endpoints |
| `operations.public.json` | Generated CLI/MCP operation table bundled into `@caveman-ai/cloud` |
| `criterion-registry.json` | Public evaluation criterion definitions |
| `schemas/` | JSON Schemas (`agent-build`, `session-event`, `agent-run-receipt`, `canonical-span`, etc.) |

Do not hand-edit generated files in this directory; regenerate them from the
source contract export pipeline.
