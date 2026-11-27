import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Cave, CaveRequestError } from "../dist/index.js";
import { EvalProjectClient } from "../dist/evals.js";

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

test("stalled compression settles at client deadline with byte-exact pass-through", async () => {
  globalThis.fetch = async () => new Promise(() => {});
  const cave = new Cave({ apiKey: "cave-test", baseURL: "http://gateway.invalid", agent: "test", timeoutMs: 20 });
  const started = Date.now();
  const result = await cave.compress('{"keep":"exact"}');
  assert.equal(result.output, '{"keep":"exact"}');
  assert.equal(result.ratio, 0);
  assert.equal(result.recoveryHandle, undefined);
  assert.ok(Date.now() - started < 500, "compression deadline did not settle promptly");
});

test("stalled state reads reject with stable timeout and caller cancellation", async () => {
  globalThis.fetch = async () => new Promise(() => {});
  const timed = new Cave({ apiKey: "cave-test", baseURL: "http://gateway.invalid", agent: "test", timeoutMs: 20 });
  await assert.rejects(timed.cavePlan(), /cave_request_timeout/);

  const controller = new AbortController();
  const cancelled = new Cave({ apiKey: "cave-test", baseURL: "http://gateway.invalid", agent: "test", timeoutMs: 5_000, signal: controller.signal });
  const request = cancelled.toolSearch([], "query");
  controller.abort(new Error("caller_cancelled"));
  await assert.rejects(request, /caller_cancelled/);
});

test("the client deadline covers a stalled response body after headers arrive", async () => {
  let signal, controller;
  globalThis.fetch = async (_input, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ start(value) { controller = value; value.enqueue(new TextEncoder().encode("{")); } }), { headers: { "content-type": "application/json" } });
  };
  const cave = new Cave({ apiKey: "cave-test", baseURL: "http://gateway.invalid", agent: "test", timeoutMs: 20 });
  for (const call of [() => cave.cavePlan(), () => cave.openai().responses.create({}), () => cave.sharedContext.get("review"), () => cave.trace({}, trace => trace.artifacts.get("review"))]) {
    let watchdog;
    try {
      await assert.rejects(Promise.race([
        call(),
        new Promise((_resolve, reject) => { watchdog = setTimeout(() => reject(new Error("body deadline was lost")), 500); }),
      ]), /cave_request_timeout/);
      assert.equal(signal.aborted, true);
    } finally {
      clearTimeout(watchdog);
      controller.error(new Error("fixture cleanup"));
    }
  }
});

test("raw body cancellation and completed reads release their request deadlines", async () => {
  let signal, cancelled = false;
  globalThis.fetch = async (_input, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  };
  const cave = new Cave({ apiKey: "cave-test", baseURL: "http://gateway.invalid", agent: "test", timeoutMs: 20 });
  const raw = await cave.openai().raw("/openai/v1/custom");
  await raw.body.cancel();
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(cancelled, true);
  assert.equal(signal.aborted, false);
  globalThis.fetch = async (_input, init) => { signal = init.signal; return Response.json({ok:true}); };
  assert.deepEqual(await cave.cavePlan(), {ok:true});
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(signal.aborted, false);
});

test("raw responses and clones preserve BYOB reads through EOF and timeout", async () => {
  const cave = new Cave({ apiKey: "cave-test", baseURL: "http://gateway.invalid", agent: "test", timeoutMs: 200 });
  for (const stalls of [false, true]) {
    globalThis.fetch = async () => new Response(new ReadableStream({
      type: "bytes",
      start(controller) {
        controller.enqueue(new TextEncoder().encode("body"));
        if (!stalls) controller.close();
      },
    }));
    const response = await cave.openai().raw("/openai/v1/custom");
    const clone = response.clone();
    await Promise.all([response, clone].map(async (raw) => {
      const reader = raw.body.getReader({ mode: "byob" });
      const first = await reader.read(new Uint8Array(16));
      assert.equal(new TextDecoder().decode(first.value), "body");
      if (stalls) await assert.rejects(reader.read(new Uint8Array(16)), /cave_request_timeout/);
      else {
        let watchdog;
        try {
          const end = await Promise.race([reader.read(new Uint8Array(16)), new Promise((_resolve, reject) => { watchdog = setTimeout(() => reject(new Error("BYOB EOF did not settle")), 500); })]);
          assert.equal(end.done, true);
          assert.equal(end.value.byteLength, 0);
        } finally { clearTimeout(watchdog); }
      }
      reader.releaseLock();
    }));
  }
});

test("custom response streams can contain empty chunks between data", async () => {
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      for (const text of ["", "o", "", "k", ""]) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  }));
  const cave = new Cave({ apiKey: "cave-test", baseURL: "http://gateway.invalid", agent: "test", timeoutMs: 200 });
  async function readBYOB(response) {
    const reader = response.body.getReader({ mode: "byob" });
    let text = "";
    for (;;) {
      const part = await reader.read(new Uint8Array(16));
      if (part.done) { reader.releaseLock(); return text; }
      text += new TextDecoder().decode(part.value);
    }
  }
  assert.equal(await (await cave.openai().raw("/openai/v1/custom")).text(), "ok");
  assert.equal(await readBYOB(await cave.openai().raw("/openai/v1/custom")), "ok");
  const response = await cave.openai().raw("/openai/v1/custom");
  const clone = response.clone();
  assert.deepEqual(await Promise.all([response.text(), readBYOB(clone)]), ["ok", "ok"]);
});

test("body cancellation preserves a caller SyntaxError reason", async () => {
  for (const artifact of [false, true]) {
    let began;
    const reading = new Promise(resolve => { began = resolve; });
    globalThis.fetch = async () => new Response(new ReadableStream({ pull() { began(); } }));
    const controller = new AbortController();
    const cave = new Cave({ apiKey: "cave-test", baseURL: "http://gateway.invalid", agent: "test", timeoutMs: 500, signal: controller.signal });
    const request = artifact ? cave.trace({}, trace => trace.artifacts.get("review")) : cave.sharedContext.get("review");
    const reason = new SyntaxError("caller_cancelled");
    const rejected = assert.rejects(request, error => error === reason);
    await reading;
    controller.abort(reason);
    await rejected;
  }
});

test("invalid client deadlines fail before any request", () => {
  // Above 2^31-1 ms setTimeout overflows to ~1 ms and every request would abort.
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, 2_147_483_648, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => new Cave({ apiKey: "cave-test", baseURL: "http://gateway.invalid", agent: "test", timeoutMs }),
      /timeoutMs must be a positive integer/,
    );
  }
});

test("service URLs normalize trailing slashes and reject query or fragment state", async () => {
  let requested;
  globalThis.fetch = async (input) => {
    requested = String(input);
    return new Response(JSON.stringify({
      output: "small",
      content_type: "text/plain",
      tokens_before: 2,
      tokens_after: 1,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const cave = new Cave({
    apiKey: "cave-test",
    baseURL: "https://gateway.example///",
    controlURL: "https://control.example/",
    agent: "test",
  });
  assert.equal(cave.options.baseURL, "https://gateway.example");
  assert.equal(cave.options.controlURL, "https://control.example");
  await cave.compress("large input");
  assert.equal(requested, "https://gateway.example/sdk/v1/compress");

  for (const baseURL of ["https://gateway.example/?tenant=x", "https://gateway.example/#unsafe", "relative/path"]) {
    assert.throws(
      () => new Cave({ apiKey: "cave-test", baseURL, agent: "test" }),
      /baseURL must/,
    );
  }
});

test("provider.raw preserves Request method, body, headers, and caller cancellation", async () => {
  let captured;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    captured = {
      method: request.method,
      body: await request.text(),
      contentType: request.headers.get("content-type"),
      custom: request.headers.get("x-custom"),
      authorization: request.headers.get("authorization"),
      signal: request.signal,
    };
    return new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    });
  };
  const controller = new AbortController();
  const cave = new Cave({ apiKey: "cave-test", baseURL: "http://gateway.invalid", agent: "test", timeoutMs: 5_000 });
  const request = new Request("http://gateway.invalid/openai/v1/custom", {
    method: "POST",
    body: "raw-payload",
    headers: { "content-type": "text/plain", "x-custom": "kept", authorization: "Bearer attacker" },
    signal: controller.signal,
  });
  const pending = cave.openai().raw(request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(captured.method, "POST");
  assert.equal(captured.body, "raw-payload");
  assert.equal(captured.contentType, "text/plain");
  assert.equal(captured.custom, "kept");
  assert.equal(captured.authorization, "Bearer cave-test");
  assert.equal(captured.signal.aborted, false);
  controller.abort(new Error("raw_request_cancelled"));
  await assert.rejects(pending, /raw_request_cancelled/);
  assert.equal(captured.signal.aborted, true);
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("provider calls wait five minutes by default, like Python, not the 30 s service deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.fetch = async () => new Promise(() => {});
  const cave = new Cave({ apiKey: "cave-test", baseURL: "http://gateway.invalid", agent: "test" });
  let outcome;
  const pending = cave.openai().responses.create({ model: "o3" }).catch((error) => { outcome = error.message; });
  await flush();
  t.mock.timers.tick(299_999);
  await flush();
  assert.equal(outcome, undefined, "a billed provider call was cut off before 300 s");
  t.mock.timers.tick(1);
  await pending;
  assert.equal(outcome, "cave_request_timeout");
});

test("a provider call takes its own deadline without touching the client default", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.fetch = async () => new Promise(() => {});
  const cave = new Cave({ apiKey: "cave-test", baseURL: "http://gateway.invalid", agent: "test" });
  let outcome;
  cave.openai().chat.completions.create({}, { cave: { timeoutMs: 600_000 } }).catch((error) => { outcome = error.message; });
  await flush();
  t.mock.timers.tick(599_999);
  await flush();
  assert.equal(outcome, undefined, "per-call timeoutMs was ignored");
  t.mock.timers.tick(1);
  await flush();
  assert.equal(outcome, "cave_request_timeout");
  await assert.rejects(cave.openai().responses.create({}, { cave: { timeoutMs: 2 ** 31 } }), /timeoutMs must be a positive integer/);
});

test("gateway failures are CaveRequestError with status, code and request id", async () => {
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { type: "cave_gateway_error", code: "cave_rate_limited", message: "Slow down.", request_id: "req-1" } }),
    { status: 429, headers: { "content-type": "application/json", "x-cave-request-id": "req-1" } },
  );
  const cave = new Cave({ apiKey: "cave-test", baseURL: "http://gateway.invalid", agent: "test" });
  const exporter = cave.exporter();
  exporter.recordSpan("chat", { provider: "openai", model: "m" });
  for (const [path, call] of [
    ["/openai/v1/responses", () => cave.openai().responses.create({})],
    ["/sdk/v1/tool-search", () => cave.toolSearch([], "query")],
    ["/sdk/v1/cave-plan", () => cave.cavePlan()],
    ["/v1/traces", () => exporter.export()],
    ["/v1/route", () => cave.route({ text: "query" })],
    ["/v1/trim", () => cave.trim("payload", "query")],
    ["/v1/compact", () => cave.compact([{ role: "user", content: "hi" }], { budgetTokens: 10 })],
  ]) {
    await assert.rejects(call(), (error) => {
      assert.ok(error instanceof CaveRequestError, `${path} threw ${error?.constructor?.name}`);
      assert.deepEqual([error.status, error.code, error.requestId, error.path], [429, "cave_rate_limited", "req-1", path]);
      return true;
    });
  }
});

test("model calls surface the envelope message and refuse caller mistakes before the network", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code: "cave_compact_failed", message: "History could not fit the budget.", request_id: "req-2" } }), { status: 422 });
  };
  const cave = new Cave({ apiKey: "cave-test", baseURL: "http://gateway.invalid", agent: "test" });
  await assert.rejects(cave.compact([{ role: "user", content: "hi" }], { budgetTokens: 5 }), (error) =>
    error instanceof CaveRequestError && error.message === "History could not fit the budget." && error.code === "cave_compact_failed" && error.status === 422);
  await assert.rejects(cave.trim("payload", "  "), /query must be a non-blank string/);
  for (const budgetTokens of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(cave.compact([], { budgetTokens }), /budgetTokens must be a positive integer/);
  }
  assert.equal(calls, 1);
});

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test("native fetch raw responses and clones retain metadata and bound body reads", async (t) => {
  globalThis.fetch = originalFetch;
  const gateway = await listen((_req, res) => { res.writeHead(201, {"content-type":"application/json"}); res.write("{"); });
  t.after(() => { gateway.server.closeAllConnections(); gateway.server.close(); });
  const cave = new Cave({ apiKey: "cave-test", baseURL: gateway.url, agent: "test", timeoutMs: 500 });
  const response = await cave.openai().raw("/openai/v1/custom");
  const clone = response.clone();
  assert.equal(response.status, 201);
  assert.equal(response.url, `${gateway.url}/openai/v1/custom`);
  assert.equal(clone.url, response.url);
  assert.equal(clone.type, response.type);
  assert.equal(response.headers.get("content-type"), "application/json");
  await Promise.all([response, clone].map(value => assert.rejects(value.json(), /cave_request_timeout/)));
});

test("gateway and eval clients never follow a redirect with credentials or the prompt", async (t) => {
  globalThis.fetch = originalFetch;
  const leaked = [];
  const elsewhere = await listen((req, res) => { leaked.push(req.headers); res.end("{}"); });
  const gateway = await listen((req, res) => { res.writeHead(307, { location: `${elsewhere.url}${req.url}` }).end(); });
  t.after(() => { elsewhere.server.closeAllConnections(); elsewhere.server.close(); gateway.server.closeAllConnections(); gateway.server.close(); });
  const cave = new Cave({ apiKey: "cave-secret", baseURL: gateway.url, agent: "test" });
  await assert.rejects(cave.openai({ upstreamKey: "sk-upstream" }).responses.create({ input: "prompt" }));
  await assert.rejects(cave.cavePlan());
  await assert.rejects(new EvalProjectClient({ accessToken: "control-secret", controlURL: gateway.url, projectId: "project-1" }).listDatasets());
  assert.deepEqual(leaked, []);
});

test("raw() keeps a base URL's own path and refuses a path outside it", async () => {
  const seen = [];
  globalThis.fetch = async (input) => { seen.push(new URL(input.url ?? input).pathname); return new Response("ok"); };
  const cave = new Cave({ apiKey: "cave-test", baseURL: "http://gateway.invalid/gw", agent: "test" });
  // Reading the body releases the request deadline.
  await (await cave.openai().raw("/openai/v1/custom")).text();
  await (await cave.openai().raw("http://gateway.invalid/gw/openai/v1/custom")).text();
  assert.deepEqual(seen, ["/gw/openai/v1/custom", "/gw/openai/v1/custom"]);
  assert.throws(() => cave.openai().raw("http://gateway.invalid/openai/v1/custom"), /cave_provider_raw_path_not_allowed/);
});
