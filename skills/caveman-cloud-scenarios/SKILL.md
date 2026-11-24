---
name: caveman-cloud-scenarios
description: Author versioned Caveman Cloud scenarios that test task output, ordered tools, and state transitions, and read how they fared across repository revisions.
---

Discover `scenarios.create` and `scenarios.compare` with `cvm tools describe`. Use the schema's supported adapter and a real task entrypoint. A scenario declares synthetic input/state, ordered tool behavior, and independent assertions. Do not infer an entrypoint or a correct answer solely from a failed trace.

```sh
cvm scenarios from-trace --file selection.json --out draft.json
cvm scenarios validate --file scenario.json
cvm scenarios push --file scenario.json
cvm scenarios compare DATASET_UUID VERSION BASELINE_RUN_UUID CANDIDATE_RUN_UUID
```

Tool fixtures are called in order. List a tool in `read_only_tools` only when its calls change nothing; then an agent version that makes those calls in another order between two other calls, or skips one, still passes, unless the skipped call's recorded answer differs from the same call's latest earlier answer; the assessment's `skipped_repeats` names each skipped fixture. Leave it out for any tool with side effects.

Trace drafting returns `manifest`, source hashes, and missing-expectation warnings. Extract `manifest` into scenario.json, then supply a real entrypoint, synthetic input/tool fixtures, and independent assertions; an unfinished draft must fail validation.

Manifest shape: `{"schema_version":1,"kind":"scenarios","spec":{...}}`; `spec` follows scenarios.create. `pull DATASET_UUID --version N` retrieves a frozen version. Editing and pushing requires its revision; updates create another immutable version.

A scenario does not run on its own, and Cloud has no hosted run for agent-task scenarios today: pushing one stores a versioned test case. `scenarios compare` reads runs that were already recorded against a version; if it finds none, say so. Never claim a scenario ran because it was authored or pushed.

Authoring/export is not execution. Report the backend's passed, failed, or incomplete assessment and actual run/resource references. Compare the same scenario version and recipe across distinct revisions. Synthetic task execution, local fixture proof, and certified hosted execution are different evidence. A cancelled, missing, or incomplete result cannot pass.


## HTTP simulation suites

HTTP simulation suites (conversation tests against a sandbox endpoint) have no
`cvm` operation yet: `cvm tools list` won't show them. Tell the user they run
from the console's Scenarios page, and do not send an agent-task manifest there.

Use an existing sandbox connection with reset support. Connection creation,
egress credentials and rollout-gate changes are human-only. Suites freeze cases,
criteria, variants, fixture versions, simulator/judge versions, mode, seed,
repeat count, turn/time limits and budgets. Frozen scripts support paired
comparisons; adaptive simulation explores behavior with additional variance.
Do not reuse cases you tuned a change on as independently qualified holdout
evidence.

Inspect every trial and criterion plus target, simulator and judge costs.
CLI exit 5 means failed criteria; 6 means incomplete/invalid/cancelled evidence
or timeout. A terminal run with missing planned trials cannot pass CI. Ordinary
simulation quality is not the server's stricter rollout gate. Regression export
preserves source trial evidence but does not approve a candidate.
