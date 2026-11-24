// Local eval harness and prompts.get(slug) against a fake control plane. Mirrors tests/test_eval_harness.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Cloud, CloudError, cloudOperationMetadata } from "../dist/cloud.js";
import { Eval, EvalUploadError, uploadEvalResult } from "../dist/evals.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const parity = JSON.parse(await readFile(new URL("../../parity/eval-harness.json", import.meta.url), "utf8"));

const projectId = "11111111-1111-4111-8111-111111111111";
const criterionId = "22222222-2222-4222-8222-222222222222";
const datasetId = "33333333-3333-4333-8333-333333333333";
const envelope = (id, data) => ({ schema_version: 1, operation: id, version: cloudOperationMetadata[id].version, contract_sha256: cloudOperationMetadata[id].contract, ok: true, status: "completed", data });

/** A Cloud whose fetch answers operations by name and records every call. */
function fakeCloud(handlers) {
  const calls = [];
  const cloud = new Cloud({ controlURL: "https://control.example", accessToken: "secret", projectId, fetch: async (url, init) => {
    const operation = String(url).split("/").pop();
    const body = JSON.parse(init.body);
    calls.push([operation, body]);
    const handler = handlers[operation];
    const data = typeof handler === "function" ? handler(body) : handler;
    return data instanceof Response ? data : Response.json(envelope(operation, data));
  } });
  return { cloud, calls, bodies: (operation) => calls.filter(([name]) => name === operation).map(([, body]) => body) };
}

/** Handlers for a run Caveman grades at once: every output sent gets one verdict from the criterion "grounded". */
function gradedRun(passed = true, { savedBaseline = false } = {}) {
  let outputs = [];
  return {
    "criteria.get": { id: criterionId, name: "Grounded", version: 3 },
    "datasets.create": { id: "dataset-1", project_id: projectId, revision: 1, status: "active" },
    "evals.create": { id: "workbench-1", project_id: projectId, revision: 1, status: "active" },
    "evals.run": (body) => { outputs = body.outputs; return { run: { id: "run-1", project_id: projectId, workbench_id: "workbench-1", status: "queued" }, outbox_id: "o", delivery_status: "pending" }; },
    "evals.ingest_evidence": (body) => ({ accepted: body.items.length, rejected: 0, duplicate: 0, conflict: 0, dry_run: false, errors: [] }),
    "evals.result": () => {
      const cells = outputs.map((output) => ({ dataset_row_key: output.row_key, trial: output.trial, target_key: "local_task", status: "completed", evaluator_results: [{ key: "grounded", name: "Grounded", status: "completed", passed, score: passed ? 1 : 0, calibrated: true }] }));
      return { run: { id: "run-1", status: "completed", progress_completed: cells.length, progress_total: cells.length }, cells,
        quality: { status: passed ? "passed" : "failed", passed: passed ? cells.length : 0, failed: passed ? 0 : cells.length, cells: cells.length, evidence_basis: "external_output_grading" } };
    },
    "evals.get_baseline": { experiment: savedBaseline ? { workbench_id: "workbench-1", run_id: "run-0", target_key: "", set_by: null, set_at: "2026-10-08T00:00:00Z" } : null, project: null },
    "evals.compare": parity.comparison,
  };
}

const refused = (status, code, message) => () => Response.json({ error: { code, message } }, { status });
const exact = ({ output, expected }) => output === expected;
const snake = (value) => Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), item]));

test("dry run runs trials and local criteria without network", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("dry run must not connect"); };
  const events = [];
  const contexts = [];
  try {
    const result = await Eval("adder", { data: [{ input: 1, expected: 2 }, { id: "two", input: 2, expected: 9 }], task: async (value, context) => { contexts.push(context); return value + 1; },
      criteria: [exact, criterionId, { type: "contains", fragments: ["3"] }], trials: 2, dryRun: true, quiet: true, concurrency: 1, onProgress: (event) => events.push(event) });
    // A trial is a trial of its row, not a row of its own.
    assert.deepEqual(result.rows.map((row) => [row.rowKey, row.trial]), [["row-1", 1], ["row-1", 2], ["two", 1], ["two", 2]]);
    assert.deepEqual(result.summary.local, { passed: 2, failed: 2, errors: 0, trusted: false });
    assert.equal(result.summary.server, null);
    assert.deepEqual(result.summary.notGraded, [criterionId, "contains"]);
    assert.equal(result.passed, false);
    assert.equal(result.upload, null);
    const [local, library, inline] = result.rows[0].verdicts;
    assert.deepEqual(local, { criterion: "exact", gradedBy: "local", status: "completed", passed: true });
    assert.deepEqual([library.gradedBy, library.status, library.passed], ["caveman", "skipped", null]);
    assert.deepEqual([inline.criterion, inline.gradedBy, inline.status], ["contains", "caveman", "skipped"]);
    // Every task call gets its own trace id, and the row carries it.
    assert.ok(result.rows.every((row) => /^[0-9a-f]{32}$/.test(row.traceId)));
    assert.deepEqual(contexts.map((context) => context.traceId), result.rows.map((row) => row.traceId));
    assert.equal(new Set(result.rows.map((row) => row.traceId)).size, 4);
    assert.deepEqual(events.map((event) => event.type), ["start", "row", "row", "row", "row", "done"]);
    assert.deepEqual([events[4].completed, events[4].total], [4, 4]);
    const ungraded = await Eval("adder", { data: [{ input: 1 }], task: (value) => value, criteria: ["Grounded"], dryRun: true, quiet: true });
    assert.equal(ungraded.passed, null);
  } finally { globalThis.fetch = originalFetch; }
});

test("named eval wire matches the parity fixture", async () => {
  // The requests of one named eval, byte for byte what the Python SDK sends (parity/eval-harness.json).
  const fake = fakeCloud(gradedRun(true, { savedBaseline: true }));
  const result = await Eval(parity.name, { cloud: fake.cloud, data: parity.data, task: (question) => question.replace("q", "a"),
    criteria: [...parity.inline, parity.criterion.id], trials: parity.trials, budgetUSD: parity.budget_usd, concurrency: 1, quiet: true });

  assert.deepEqual(fake.calls.map(([name]) => name), ["criteria.get", "datasets.create", "evals.create", "evals.run", "evals.result", "evals.get_baseline", "evals.compare"]);
  for (const [operation, expected] of Object.entries(parity.requests)) {
    const body = fake.bodies(operation)[0];
    if (operation === "evals.run") for (const output of body.outputs) {
      assert.match(output.trace_id, /^[0-9a-f]{32}$/);
      assert.ok(output.latency_ms >= 0);
      delete output.trace_id; delete output.latency_ms;
    }
    assert.deepEqual(body, expected, operation);
  }
  // The verdict against the experiment's saved baseline is the server's.
  assert.deepEqual(snake(result.baseline), parity.baseline);
  assert.equal(result.passed, true); // need_more_data is not a failure
});

test("upload sends outputs for server grading and local criteria as untrusted evidence", async () => {
  const fake = fakeCloud(gradedRun());
  const lines = [];
  const originalError = console.error;
  console.error = (line) => lines.push(line);
  let result;
  try {
    result = await Eval("support", { cloud: fake.cloud, data: [{ input: "q1", expected: "a1" }, { input: "q2", expected: "a2" }], task: (question) => question.replace("q", "a"),
      criteria: [criterionId, exact], consoleURL: "https://console.example/", concurrency: 1 });
  } finally { console.error = originalError; }

  // The dataset and the experiment are found or made before the task runs, the outputs travel with the run.
  assert.deepEqual(fake.calls.map(([name]) => name), ["criteria.get", "datasets.create", "evals.create", "evals.run", "evals.ingest_evidence", "evals.result", "evals.get_baseline"]);
  const dataset = fake.bodies("datasets.create")[0];
  assert.deepEqual([dataset.name, dataset.upsert], ["support", true]);
  // The dataset is the cases: no output is stored in it.
  assert.deepEqual(dataset.document.rows, [{ row_key: "row-1", values: { input: "q1", expected: "a1" } }, { row_key: "row-2", values: { input: "q2", expected: "a2" } }]);
  const experiment = fake.bodies("evals.create")[0];
  assert.deepEqual([experiment.name, experiment.upsert], ["support", true]);
  assert.deepEqual(experiment.document.targets, [{ key: "local_task", name: "Local task (run by the SDK)", kind: "external", input_mapping: {}, config: {} }]);
  // The library criterion is named, not graded here: Caveman grades it in the run.
  assert.deepEqual(experiment.document.evaluators, [{ key: "grounded", name: "Grounded", source: "criterion", criterion_id: criterionId, criterion_version: 3 }]);
  const run = fake.bodies("evals.run")[0];
  assert.deepEqual(run.scope, { kind: "all" });
  assert.deepEqual(run.outputs.map((output) => [output.row_key, output.trial, output.output, output.attempts, output.trace_id]), [["row-1", 1, "a1", 1, result.rows[0].traceId], ["row-2", 1, "a2", 1, result.rows[1].traceId]]);
  const evidence = fake.bodies("evals.ingest_evidence")[0].items;
  assert.equal(evidence.length, 2);
  const { source_system, evaluator_name, evaluator_type, status, passed, source_run_id, source_case_id, trace_id, idempotency_key } = evidence[0];
  assert.deepEqual({ source_system, evaluator_name, evaluator_type, status, passed, source_run_id, source_case_id, trace_id, idempotency_key },
    { source_system: "caveman-sdk-local-eval", evaluator_name: "exact", evaluator_type: "local_function", status: "processed", passed: true, source_run_id: "run-1", source_case_id: "row-1", trace_id: result.rows[0].traceId, idempotency_key: "run-1/row-1/1/exact" });
  assert.equal("authority" in evidence[0], false); // the server stamps external_observed; the client cannot claim more.
  assert.match(evidence[0].evaluator_config_digest, /^[a-f0-9]{64}$/);

  assert.equal(result.passed, true);
  assert.equal(result.summary.server.status, "passed");
  assert.equal(result.summary.local.trusted, false);
  assert.deepEqual(result.rows[0].verdicts.map((verdict) => [verdict.criterion, verdict.gradedBy, verdict.passed]), [["exact", "local", true], ["Grounded", "caveman", true]]);
  assert.equal(result.rows[0].verdicts[1].detail.calibrated, true);
  assert.deepEqual(result.upload, { datasetId: "dataset-1", workbenchId: "workbench-1", runId: "run-1", runStatus: "completed", url: "https://console.example/experiments/workbenches/workbench-1", localEvidence: { accepted: 2, rejected: 0, duplicate: 0, conflict: 0 } });
  // No baseline named and none saved: nothing was compared, and nothing is claimed.
  assert.equal(result.baseline, null);
  assert.equal(fake.calls.some(([name]) => name === "evals.compare"), false);
  assert.ok(lines.at(-1).includes("https://console.example/experiments/workbenches/workbench-1"));
});

test("dataset reference by name, version and split, with the server's baseline verdict", async () => {
  const handlers = gradedRun(false);
  const column = { key: "question", name: "Question", type: "string", role: "input" };
  handlers["datasets.list"] = { data: [{ id: datasetId, name: "Support Cases" }], next_cursor: null };
  handlers["datasets.get"] = { dataset: { id: datasetId, columns: [column] }, rows: [], versions: [{ version: 2, document_sha256: "a".repeat(64), document: { schema_version: 1, columns: [column], rows: [
    { row_key: "kept", values: { question: "hi" }, tags: ["split:test"] }, { row_key: "dropped", values: { question: "no" }, tags: ["split:train"] }] } }] };
  handlers["criteria.list"] = { data: [{ id: criterionId, name: "Grounded", version: 3 }, { id: "other", name: "Grounded answers", version: 1 }], next_cursor: null };
  handlers["evals.compare"] = { ...parity.comparison, baseline_run_id: "old", baseline_source: "query", quality: "failed", regressions: 1, changed_cases: [{ row_key: "kept", target_key: "local_task", change: "regressed" }] };
  const fake = fakeCloud(handlers);

  const seen = [];
  const result = await Eval("support", { cloud: fake.cloud, data: { dataset: "support cases", version: 2, split: "test" }, task: (question) => { seen.push(question); return "answer"; },
    criteria: ["grounded"], baseline: { workbenchId: "workbench-1", runId: "old" }, quiet: true });

  assert.deepEqual(seen, ["hi"]);
  assert.deepEqual(fake.bodies("datasets.get"), [{ dataset_id: datasetId }]);
  assert.deepEqual(fake.bodies("criteria.list"), [{ q: "grounded", limit: 100 }]);
  // A stored dataset is used as it is, pinned to the version asked for: nothing is copied.
  assert.deepEqual(fake.bodies("datasets.create"), []);
  assert.deepEqual(fake.bodies("evals.create")[0].document.datasets, [{ key: "cases", dataset_id: datasetId, version: 2, document_sha256: "a".repeat(64) }]);
  assert.deepEqual(fake.bodies("evals.run")[0].outputs.map((output) => output.row_key), ["kept"]);
  assert.deepEqual(fake.bodies("evals.compare"), [{ workbench_id: "workbench-1", candidate_run_id: "run-1", baseline_run_id: "old" }]);
  assert.deepEqual(fake.bodies("evals.get_baseline"), []);
  assert.equal(result.summary.server.status, "failed");
  const { runId, source, verdict, regressions, computedBy, changedCases } = result.baseline;
  assert.deepEqual([runId, source, verdict, regressions, computedBy], ["old", "query", "failed", 1, "caveman"]);
  assert.deepEqual(changedCases, [{ row_key: "kept", target_key: "local_task", change: "regressed" }]);
  assert.equal(result.passed, false);
});

test("gate policy is stored on the experiment and the comparison names none", async () => {
  // One source of truth: the policy is the experiment's, and the comparison reports the one that decided.
  const handlers = gradedRun(true, { savedBaseline: true });
  handlers["evals.set_baseline"] = { experiment: null, project: null, gate_policy: "strict" };
  handlers["evals.compare"] = { ...parity.comparison, policy: "strict", quality: "passed" };
  const fake = fakeCloud(handlers);
  const result = await Eval("support", { cloud: fake.cloud, data: [{ id: "one", input: "q" }], task: () => "a", criteria: [criterionId], gatePolicy: "strict", quiet: true });
  assert.deepEqual(fake.bodies("evals.set_baseline"), [{ workbench_id: "workbench-1", gate_policy: "strict" }]);
  assert.deepEqual(fake.bodies("evals.compare"), [{ workbench_id: "workbench-1", candidate_run_id: "run-1" }]);
  assert.deepEqual([result.baseline.policy, result.baseline.policySource, result.baseline.verdict], ["strict", "experiment", "passed"]);
});

test("a run the server cannot compare says so and keeps its own verdict", async () => {
  const handlers = gradedRun(true, { savedBaseline: true });
  handlers["evals.compare"] = refused(409, "cave_eval_comparison_incompatible", "Evaluation runs are not compatible for comparison.");
  const result = await Eval("support", { cloud: fakeCloud(handlers).cloud, data: [{ input: "q" }], task: () => "a", criteria: [criterionId], quiet: true });
  assert.deepEqual(result.baseline, { runId: null, comparable: false, reason: "Evaluation runs are not compatible for comparison.", computedBy: "caveman" });
  assert.equal(result.passed, true);
});

test("a project default that is another experiment's run is no baseline", async () => {
  const handlers = gradedRun(true, { savedBaseline: true });
  handlers["evals.compare"] = refused(409, "cave_eval_no_baseline", "No baseline is saved for this experiment. Name a baseline run, or save one.");
  const result = await Eval("support", { cloud: fakeCloud(handlers).cloud, data: [{ input: "q" }], task: () => "a", criteria: [criterionId], quiet: true });
  assert.equal(result.baseline, null);
  assert.equal(result.passed, true);
});

test("a task that throws is retried and the attempts are uploaded", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeCloud(gradedRun());
  const calls = [];
  const flaky = (question) => {
    calls.push(question);
    if (question === "q1" && calls.filter((call) => call === "q1").length < 3) throw new Error("rate limited");
    if (question === "q3") throw new Error("model unavailable");
    return "a";
  };
  // The backoff between attempts waits on the mocked timer: keep it moving.
  let finished = false;
  const pump = async () => { while (!finished) { t.mock.timers.tick(8000); await new Promise((resolve) => setImmediate(resolve)); } };
  const [result] = await Promise.all([Eval("support", { cloud: fake.cloud, data: [{ input: "q1" }, { input: "q2" }, { input: "q3" }], task: flaky, criteria: [criterionId], concurrency: 1, quiet: true }).finally(() => { finished = true; }), pump()]);
  assert.deepEqual(result.rows.map((row) => row.attempts), [3, 1, 3]);
  assert.deepEqual([result.rows[0].error, result.rows[0].output], [undefined, "a"]);
  assert.equal(result.rows[2].error, "model unavailable");
  assert.deepEqual([result.summary.retried, result.summary.taskErrors, result.passed], [2, 1, false]);
  assert.deepEqual(fake.bodies("evals.run")[0].outputs.map((output) => [output.attempts, output.output ?? null, output.error ?? null]), [[3, "a", null], [1, "a", null], [3, null, "model unavailable"]]);
});

test("task timeout fails the call, and retries none when told not to", async () => {
  const result = await Eval("adder", { data: [{ input: 1 }], task: (value) => new Promise((resolve) => setTimeout(() => resolve(value), 500).unref()), criteria: [exact], taskTimeoutMs: 50, retries: 0, dryRun: true, quiet: true });
  assert.deepEqual([result.rows[0].error, result.rows[0].attempts], ["the task took longer than 0.05 s", 1]);
  assert.equal(result.rows[0].verdicts[0].status, "skipped");
  assert.equal(result.passed, false);
});

test("a call past taskTimeoutMs has its signal aborted before it is tried again", async () => {
  const signals = [];
  const task = (value, context) => {
    signals.push(context.signal);
    // The first call hangs until it is aborted, as a fetch handed the signal does.
    if (signals.length === 1) return new Promise((_, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
    assert.equal(signals[0].aborted, true, "the timed-out call was told to stop before its retry started");
    return value;
  };
  const result = await Eval("adder", { data: [{ input: 1, expected: 1 }], task, criteria: [exact], taskTimeoutMs: 50, retries: 1, dryRun: true, quiet: true });
  assert.deepEqual([result.rows[0].attempts, result.rows[0].output, result.rows[0].error], [2, 1, undefined]);
  assert.equal(signals[0].reason.message, "the task took longer than 0.05 s");
  assert.equal(signals[1].aborted, false, "each call has its own signal");
});

test("the eval's signal stops new cases, aborts the call in flight, and writes no run", async () => {
  const fake = fakeCloud(gradedRun());
  const stop = new AbortController();
  const started = [];
  let inFlight;
  const task = (question, context) => {
    started.push(question);
    if (question === "q1") return "a";
    inFlight = context.signal;
    queueMicrotask(() => stop.abort(new Error("deploy cancelled")));
    return new Promise(() => {});
  };
  await assert.rejects(Eval("support", { cloud: fake.cloud, data: [{ input: "q1" }, { input: "q2" }, { input: "q3" }], task, criteria: [criterionId], concurrency: 1, signal: stop.signal, quiet: true }), /deploy cancelled/);
  assert.deepEqual(started, ["q1", "q2"], "q3 never started");
  assert.equal(inFlight.aborted, true, "the call in flight was told to stop");
  assert.equal(fake.bodies("evals.run").length, 0, "a stopped eval adds no run");
});

test("an eval whose signal already aborted makes no request and runs no task", async () => {
  const fake = fakeCloud(gradedRun());
  let ran = false;
  await assert.rejects(Eval("support", { cloud: fake.cloud, data: [{ input: "q1" }], task: () => { ran = true; return "a"; }, criteria: [criterionId], signal: AbortSignal.abort(new Error("stopped")), quiet: true }), /stopped/);
  assert.deepEqual([ran, fake.calls.length], [false, 0]);
});

test("task error fails the run and skips local criteria; cave.trace wraps the task with the row's trace id", async () => {
  const traced = [];
  const cave = { trace: async (options, fn) => { traced.push(options); return fn({ traceId: options.traceId }); } };
  const result = await Eval("adder", { cave, data: [{ input: 1 }], task: (_, context) => { assert.equal(context.trace.traceId, context.traceId); throw new Error("model unavailable"); }, criteria: [exact], retries: 0, dryRun: true, quiet: true });
  assert.equal(result.passed, false);
  assert.equal(result.summary.taskErrors, 1);
  assert.equal(result.rows[0].error, "model unavailable");
  assert.equal(result.rows[0].verdicts[0].status, "skipped");
  assert.deepEqual(traced, [{ workflow: "adder", traceId: result.rows[0].traceId, tags: { eval: "adder", eval_row: "row-1", eval_trial: "1" } }]);
});

test("a refused experiment stops before the task runs", async () => {
  const handlers = gradedRun();
  handlers["evals.create"] = refused(403, "cave_scope_forbidden", "Scope denied.");
  const ran = [];
  await assert.rejects(Eval("support", { cloud: fakeCloud(handlers).cloud, data: [{ input: "q" }], task: (question) => ran.push(question), criteria: [criterionId, { type: "contains", fragments: ["a"] }], quiet: true }),
    (error) => error instanceof CloudError && error.code === "cave_scope_forbidden" && /Scope denied/.test(error.message));
  assert.deepEqual(ran, []);
  await assert.rejects(Eval("support", { data: [{ input: "q" }], task: () => "a", criteria: [] }), /dryRun: true/);
});

test("upload failure saves what ran and a later upload does not run the task again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caveman-eval-"));
  const handlers = gradedRun();
  handlers["evals.run"] = refused(503, "cave_unavailable", "Try again.");
  const ran = [];
  let failure;
  await assert.rejects(Eval("support", { cloud: fakeCloud(handlers).cloud, data: [{ input: "q", expected: "a" }], task: (question) => { ran.push(question); return "a"; }, criteria: [criterionId, exact], quiet: true, resultsDir: dir }), (error) => {
    failure = error;
    assert.ok(error instanceof EvalUploadError);
    assert.match(error.message, /Try again/);
    assert.equal(error.cause.code, "cave_unavailable");
    assert.deepEqual([error.result.rows[0].output, error.result.passed], ["a", null]);
    assert.ok(error.savedPath.startsWith(dir) && error.message.includes(error.savedPath));
    return true;
  });

  const fake = fakeCloud(gradedRun());
  const result = await uploadEvalResult(failure.savedPath, { cloud: fake.cloud, quiet: true });
  assert.deepEqual(ran, ["q"]); // the task ran once, in the first process
  assert.deepEqual(fake.calls.map(([name]) => name), ["evals.run", "evals.ingest_evidence", "evals.result", "evals.get_baseline"]);
  const run = fake.bodies("evals.run")[0];
  assert.deepEqual([run.workbench_id, run.outputs[0].output, run.outputs[0].trace_id], ["workbench-1", "a", failure.result.rows[0].traceId]);
  assert.deepEqual([result.passed, result.upload.runId], [true, "run-1"]);
  assert.deepEqual(result.rows[0].verdicts.map((verdict) => [verdict.criterion, verdict.gradedBy]), [["exact", "local"], ["Grounded", "caveman"]]);
  await rm(dir, { recursive: true });
});

test("a saved result whose run started waits for that run", async () => {
  const handlers = gradedRun();
  handlers["evals.result"] = refused(502, "cave_unavailable", "Bad gateway.");
  let failure;
  await assert.rejects(Eval("support", { cloud: fakeCloud(handlers).cloud, data: [{ input: "q" }], task: () => "a", criteria: [criterionId], quiet: true, resultsDir: null }), (error) => { failure = error; return error instanceof EvalUploadError; });
  assert.deepEqual([failure.savedPath, failure.result.upload.runId], [null, "run-1"]);

  const saved = { schema_version: 1, name: "support", trials: 1, request_id: "r", server_criteria: true, baseline_run_id: null, budget_usd: null, dataset_id: "dataset-1", workbench_id: "workbench-1", result: failure.result };
  const working = gradedRun();
  working["evals.run"] = refused(500, "cave_internal", "a second run must not start");
  // The fake grades the outputs its evals.run saw; this run started elsewhere.
  working["evals.result"] = { run: { id: "run-1", status: "completed", progress_completed: 1, progress_total: 1 }, quality: { status: "passed", passed: 1, failed: 0, cells: 1, evidence_basis: "external_output_grading" },
    cells: [{ dataset_row_key: "row-1", trial: 1, evaluator_results: [{ key: "grounded", name: "Grounded", status: "completed", passed: true }] }] };
  const fake = fakeCloud(working);
  const result = await uploadEvalResult(saved, { cloud: fake.cloud, quiet: true });
  assert.deepEqual(fake.calls.map(([name]) => name), ["evals.result", "evals.get_baseline"]);
  assert.equal(result.passed, true);
});

// --- prompts.get(slug) --------------------------------------------------------

const prompt = { prompt_id: "44444444-4444-4444-8444-444444444444", slug: "support-reply", name: "Support-Reply", version: 3, version_id: "v", environment: "production",
  system_text: "Be brief.", user_text: "Answer {{ question }} for {{name}}.", variables: [], model_parameters: { model: "m" }, tools: [], resolved_at: "2026-10-08T00:00:00Z" };

function promptCloud(responses, options = {}) {
  const urls = [];
  const cloud = new Cloud({ controlURL: "https://control.example", accessToken: "secret", projectId, ...options, fetch: async (url, init) => {
    urls.push(String(url));
    assert.equal(init.method, "GET");
    assert.equal(init.headers.authorization, "Bearer secret");
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  } });
  return { cloud, urls };
}

test("prompt cache hit, TTL expiry and stale on error", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const { cloud, urls } = promptCloud([Response.json(prompt), Response.json({ ...prompt, version: 4 }), new Error("down")]);
  const first = await cloud.prompts.get("Support-Reply");
  assert.deepEqual([first.source, first.version], ["server", 3]);
  assert.deepEqual(urls, [`https://control.example/api/v1/projects/${projectId}/prompts/resolve?slug=Support-Reply&environment=production`]);
  assert.equal((await cloud.prompts.get("support-reply", { environment: "production" })).source, "cache");
  assert.equal(urls.length, 1);
  t.mock.timers.tick(61_000);
  const refreshed = await cloud.prompts.get("support-reply");
  assert.deepEqual([refreshed.source, refreshed.version], ["server", 4]);
  t.mock.timers.tick(61_000);
  const stale = await cloud.prompts.get("support-reply");
  assert.deepEqual([stale.source, stale.version], ["stale", 4]);
  assert.equal(urls.length, 3);
});

test("prompt version is its own cache entry and the TTL is configurable", async () => {
  const { cloud, urls } = promptCloud([Response.json({ ...prompt, environment: null }), Response.json({ ...prompt, environment: null })], { promptCacheTtlMs: 0 });
  const byVersion = await cloud.prompts.get("support-reply", { version: 3 });
  assert.ok(urls[0].endsWith("/prompts/resolve?slug=support-reply&version=3"));
  assert.deepEqual(byVersion.headers(), { "x-cave-tags": `cave.prompt.id=${prompt.prompt_id},cave.prompt.version=3` });
  assert.equal((await cloud.prompts.get("support-reply", { version: 3 })).source, "server");
  await assert.rejects(cloud.prompts.get("support-reply", { version: 3, environment: "staging" }), { code: "cave_input_invalid" });
});

test("prompt fallback, then throw when nothing is cached", async () => {
  const missing = () => Response.json({ error: { code: "cave_prompt_environment_unset", message: "Nothing is promoted to staging." } }, { status: 404 });
  const { cloud } = promptCloud([missing(), missing()]);
  const fallback = await cloud.prompts.get("support-reply", { environment: "staging", fallback: { user_text: "Answer {{question}}." } });
  assert.deepEqual([fallback.source, fallback.render({ question: "why" }).user_text, fallback.headers()], ["fallback", "Answer why.", {}]);
  await assert.rejects(cloud.prompts.get("support-reply", { environment: "staging" }), (error) => error instanceof CloudError && error.code === "cave_prompt_environment_unset" && error.status === 404);
});

test("prompt render and header helper; get by id still calls the generated operation", async () => {
  const { cloud } = promptCloud([Response.json(prompt)]);
  const resolved = await cloud.prompts.get("support-reply");
  assert.deepEqual(resolved.render({ question: "why", name: "Ada" }), { system_text: "Be brief.", user_text: "Answer why for Ada." });
  assert.throws(() => resolved.render({ question: "why" }), { code: "cave_prompt_variable_unmapped" });
  assert.deepEqual(resolved.headers(), { "x-cave-tags": `cave.prompt.id=${prompt.prompt_id},cave.prompt.version=3,cave.prompt.environment=production` });
  const fake = fakeCloud({ "prompts.get": { prompt: { id: prompt.prompt_id }, versions: [] } });
  assert.equal((await fake.cloud.prompts.get({ prompt_id: prompt.prompt_id })).data.prompt.id, prompt.prompt_id);
  assert.deepEqual(fake.calls, [["prompts.get", { prompt_id: prompt.prompt_id }]]);
});

test("Eval refuses a bad timeoutMs, pollMs or budgetUSD before the task runs", async () => {
  let ran = 0;
  const base = { data: [{ input: 1 }], task: async () => { ran++; return 1; }, dryRun: true };
  await assert.rejects(Eval("early", { ...base, timeoutMs: 0 }), /timeoutMs/);
  await assert.rejects(Eval("early", { ...base, pollMs: 120_000 }), /pollMs/);
  await assert.rejects(Eval("early", { ...base, budgetUSD: -1 }), /budgetUSD/);
  assert.equal(ran, 0);
});
