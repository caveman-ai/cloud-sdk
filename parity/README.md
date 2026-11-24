# Cross-Language Parity Fixtures (`parity/`)

Shared wire-level test vectors ensuring `@caveman-ai/sdk` (TypeScript),
`caveman-sdk` (Python), and `github.com/caveman-ai/sdk-go` (Go) emit identical
requests, headers, error codes, and stream parsing behavior.

| File | Coverage |
|---|---|
| `fixtures.json` | Core Cloud & gateway SDK wire requests and error handling |
| `eval-harness.json` | Evaluation harness wire contract |
| `runtime-policy.fixtures.json` | Runtime policy bundle verification and deterministic assignment |
| `sandboxes-wire.json`, `sandbox-stream.json`, `sandbox-reasons.json` | Sandbox API wire shapes, SSE streams, and stop/reason codes |
