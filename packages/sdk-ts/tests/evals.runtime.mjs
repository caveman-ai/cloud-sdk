import { after, test } from "node:test";
import assert from "node:assert/strict";
import { EvalProjectClient, EvalWorkbenchClient } from "../dist/evals.js";

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

test("eval client runs and waits on same persisted control-plane run", async () => {
  const captured = [];
  const responses = [
    { status: 202, body: { run: { id: "run-1", status: "queued" }, cells: [] } },
    { status: 200, body: { run: { id: "run-1", status: "completed", summary: { failed_evaluations: 0 } }, cells: [{ id: "cell-1" }] } },
  ];
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), method: init?.method, headers: new Headers(init?.headers), body: init?.body });
    const next = responses.shift();
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  };
  const client = new EvalWorkbenchClient({
    accessToken: "access-token",
    controlURL: "https://control.example/",
    projectId: "project-1",
  }, "workbench-1");
  const result = await client.runAndWait({ scope: { kind: "target", target_key: "candidate" }, concurrency: 2 }, { pollMs: 1 });
  assert.equal(result.run.status, "completed");
  assert.equal(result.cells.length, 1);
  assert.equal(captured.length, 2);
  assert.equal(captured[0].url, "https://control.example/api/v1/projects/project-1/eval-workbenches/workbench-1/runs");
  assert.equal(captured[0].method, "POST");
  assert.equal(captured[0].headers.get("authorization"), "Bearer access-token");
  assert.equal(captured[0].headers.get("x-cave-csrf"), "sdk");
  assert.deepEqual(JSON.parse(captured[0].body), { scope: { kind: "target", target_key: "candidate" }, concurrency: 2 });
  assert.equal(captured[1].url, "https://control.example/api/v1/projects/project-1/eval-workbenches/workbench-1/runs/run-1");
  assert.equal(captured[1].method, "GET");
});

test("eval client preserves structured control errors", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "cave_scope_forbidden", message: "Connection scope lacks required permission." } }), { status: 403 });
  const client = new EvalWorkbenchClient({ accessToken: "access-token", controlURL: "https://control.example", projectId: "project-1" }, "workbench-1");
  await assert.rejects(client.run(), (error) => error.status === 403 && error.code === "cave_scope_forbidden" && error.message === "Connection scope lacks required permission.");
});

test("eval client rejects invalid concurrency before network", async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return new Response("{}"); };
  const client = new EvalWorkbenchClient({ accessToken: "access-token", controlURL: "https://control.example", projectId: "project-1" }, "workbench-1");
  await assert.rejects(client.run({ concurrency: 25 }), /concurrency must be an integer from 1 to 24/);
  assert.equal(requests, 0);
});

test("project client authors same versioned experiment shape used by UI and returns run client", async () => {
  const captured = [];
  const responses = [
    { id: "dataset-1", name: "Cases", columns: [{ key: "input", name: "Input", type: "string", role: "input" }] },
    { id: "workbench-1", name: "Quality", document: { active_dataset_key: "regression" } },
  ];
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), method: init?.method, headers: new Headers(init?.headers), body: JSON.parse(init?.body) });
    return new Response(JSON.stringify(responses.shift()), { status: 201, headers: { "content-type": "application/json" } });
  };
  const project = new EvalProjectClient({ accessToken: "access-token", controlURL: "https://control.example", projectId: "project-1" });
  const experiment = await project.createExperiment({
    name: "Quality",
    datasetKey: "regression",
    dataset: {
      name: "Cases",
      document: { schema_version: 1, columns: [{ key: "input", name: "Input", type: "string", role: "input" }], rows: [{ row_key: "one", values: { input: "hello" } }] },
    },
    document: {
      schema_version: 1,
      targets: [{ key: "candidate", name: "Candidate", kind: "http", input_mapping: { input: "input" }, config: { endpoint: "https://agent.example/run", method: "POST", authentication: { type: "none" } } }],
      evaluators: [{ key: "safe", name: "No PII", source: "inline", grader_type: "no_pii", options: {}, input_mapping: { candidate: { source: "target", key: "$target" } } }],
      settings: { concurrency: 4, row_height: "compact", judge_order: "randomized" },
    },
  });
  assert.equal(experiment.dataset.id, "dataset-1");
  assert.equal(experiment.workbench.id, "workbench-1");
  assert.equal(experiment.runs.workbenchId, "workbench-1");
  assert.equal(captured[0].url, "https://control.example/api/v1/projects/project-1/eval-datasets");
  assert.equal(captured[1].url, "https://control.example/api/v1/projects/project-1/eval-workbenches");
  assert.equal(captured[1].body.document.active_dataset_key, "regression");
  assert.deepEqual(captured[1].body.document.datasets, [{ key: "regression", dataset_id: "dataset-1" }]);
  assert.equal(captured[1].headers.get("x-cave-csrf"), "sdk");
});

test('eval wait returns terminal error and rejects unknown states without repolling', async () => {
  const client = new EvalWorkbenchClient({accessToken:'token',controlURL:'https://control.example',projectId:'project'},'bench');
  for (const status of ['error','unknown']) {
    let calls=0;
    globalThis.fetch=async()=>{calls++;return Response.json({run:{id:'run',status},cells:[]});};
    if(status==='error')assert.equal((await client.wait('run')).run.status,'error');
    else await assert.rejects(client.wait('run'),/eval_unknown_status/);
    assert.equal(calls,1);
  }
});
