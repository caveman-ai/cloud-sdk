/** Mirrored tool-event producer contract. See sdk-python tests/test_tool_events.py. */
import { after, test } from "node:test";
import assert from "node:assert/strict";

import { Cave } from "../dist/index.js";

const originalFetch = globalThis.fetch;
const TRACE_ID = "aaaabbbbccccddddeeeeffff00001111";
const SPAN_ID = "1122334455667788";
let captured = [];

function installFetch({ fail = false } = {}) {
  captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push({
      url: String(url),
      method: init?.method,
      headers: init?.headers ?? {},
      body: init?.body === undefined ? undefined : JSON.parse(init.body)
    });
    if (fail) throw new Error("telemetry-transport-secret");
    return { ok: true, text: async () => JSON.stringify({ ok: true }), json: async () => ({ ok: true }) };
  };
}

function cave() {
  return new Cave({ apiKey: "cave_live_test", baseURL: "http://localhost:8787", agent: "tool-event-agent", defaultWorkflow: "default-workflow" });
}

function assertEvent(request, expected) {
  assert.equal(request.url, "http://localhost:8787/sdk/v1/events");
  assert.equal(request.method, "POST");
  assert.equal(request.headers["x-cave-trace-id"], TRACE_ID);
  assert.equal(request.headers["x-cave-parent-span-id"], SPAN_ID);
  assert.equal(request.headers["x-cave-workflow"], expected.workflow ?? "default-workflow");
  assert.equal(request.body.span_type, "tool.call");
  assert.equal(request.body.name, expected.name);
  assert.equal(request.body.workflow, expected.workflow ?? "default-workflow");
  assert.equal(request.body.outcome, expected.outcome);
  assert.equal(request.body.sequence, expected.sequence);
  assert.equal(Number.isSafeInteger(request.body.sequence) && request.body.sequence > 0, true);
  assert.equal(Number.isSafeInteger(request.body.duration_ms) && request.body.duration_ms >= 0, true);
  assert.deepEqual(Object.keys(request.body).sort(), ["duration_ms", "name", "options", "outcome", "sequence", "span_type", "tags", "workflow"].sort());
}

after(() => {
  globalThis.fetch = originalFetch;
});

test("successful tool returns original value and emits joined ok event", async () => {
  installFetch();
  const original = { exact: "result" };
  const result = await cave().trace({ workflow: "event-workflow", traceId: TRACE_ID, spanId: SPAN_ID, tags: { env: "test" } }, (trace) =>
    trace.tool("lookup", { readOnly: true }, () => original)
  );
  assert.equal(result, original);
  assert.equal(captured.length, 1);
  assertEvent(captured[0], { name: "lookup", outcome: "ok", sequence: 1, workflow: "event-workflow" });
});

test("synchronous and asynchronous failures emit error without exception leakage", async () => {
  for (const mode of ["sync", "async"]) {
    installFetch();
    const original = new Error(`private-${mode}-exception-message`);
    let caught;
    try {
      await cave().trace({ traceId: TRACE_ID, spanId: SPAN_ID }, (trace) =>
        trace.tool("danger", {}, mode === "sync" ? () => { throw original; } : async () => { throw original; })
      );
    } catch (error) {
      caught = error;
    }
    assert.equal(caught, original);
    assert.equal(captured.length, 1);
    assertEvent(captured[0], { name: "danger", outcome: "error", sequence: 1 });
    const wire = JSON.stringify(captured[0].body);
    assert.equal(wire.includes(original.message), false);
    assert.equal(wire.includes("stack"), false);
    assert.equal(wire.includes("exception"), false);
  }
});

test("AbortError cancellation emits error and preserves the original rejection", async () => {
  installFetch();
  const original = new Error("private-cancellation-message");
  original.name = "AbortError";
  let caught;
  try {
    await cave().trace({ traceId: TRACE_ID, spanId: SPAN_ID }, (trace) =>
      trace.tool("cancelled", {}, async () => { throw original; })
    );
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, original);
  assert.equal(captured.length, 1);
  assertEvent(captured[0], { name: "cancelled", outcome: "error", sequence: 1 });
  assert.equal(JSON.stringify(captured[0].body).includes(original.message), false);
});

test("telemetry failure never changes successful return or original throw", async () => {
  installFetch({ fail: true });
  const value = { preserved: true };
  const result = await cave().trace({ traceId: TRACE_ID, spanId: SPAN_ID }, (trace) => trace.tool("ok", {}, () => value));
  assert.equal(result, value);

  installFetch({ fail: true });
  const original = new Error("original-tool-secret");
  let caught;
  try {
    await cave().trace({ traceId: TRACE_ID, spanId: SPAN_ID }, (trace) => trace.tool("bad", {}, () => { throw original; }));
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, original);
  assert.equal(captured.length, 1);
  assertEvent(captured[0], { name: "bad", outcome: "error", sequence: 1 });
  assert.equal(JSON.stringify(captured[0].body).includes(original.message), false);
});

test("sequence follows start order when concurrent completions reverse", async () => {
  installFetch();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  await cave().trace({ traceId: TRACE_ID, spanId: SPAN_ID }, async (trace) => {
    const first = trace.tool("first", {}, async () => {
      await firstGate;
      return "first-result";
    });
    const second = trace.tool("second", {}, async () => "second-result");
    assert.equal(await second, "second-result");
    releaseFirst();
    assert.equal(await first, "first-result");
  });

  assert.equal(captured.length, 2);
  assertEvent(captured[0], { name: "second", outcome: "ok", sequence: 2 });
  assertEvent(captured[1], { name: "first", outcome: "ok", sequence: 1 });
});

test("each CaveTrace owns an independent sequence", async () => {
  installFetch();
  await cave().trace({ traceId: TRACE_ID, spanId: SPAN_ID }, (trace) => trace.tool("one", {}, () => 1));
  await cave().trace({ traceId: TRACE_ID, spanId: SPAN_ID }, (trace) => trace.tool("two", {}, () => 2));
  assert.deepEqual(captured.map((request) => request.body.sequence), [1, 1]);
});

test("tool returns before its telemetry POST settles; trace waits for it once at the end", async () => {
  captured = [];
  let releaseEvent;
  const eventGate = new Promise((resolve) => { releaseEvent = resolve; });
  let eventSettled = false;
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), method: init?.method, headers: init?.headers ?? {}, body: JSON.parse(init.body) });
    await eventGate;
    eventSettled = true;
    return { ok: true, text: async () => JSON.stringify({ ok: true }), json: async () => ({ ok: true }) };
  };
  let toolReturnedWhileEventPending = false;
  const traced = cave().trace({ traceId: TRACE_ID, spanId: SPAN_ID }, async (trace) => {
    const value = await Promise.race([
      trace.tool("slow-telemetry", {}, () => "result"),
      new Promise((resolve) => setTimeout(() => resolve("tool-blocked-on-telemetry"), 500))
    ]);
    toolReturnedWhileEventPending = value === "result" && !eventSettled && captured.length === 1;
    return value;
  });
  setTimeout(releaseEvent, 50);
  assert.equal(await traced, "result");
  assert.equal(toolReturnedWhileEventPending, true);
  assert.equal(eventSettled, true, "cave.trace returned before the tool event was sent");
  assertEvent(captured[0], { name: "slow-telemetry", outcome: "ok", sequence: 1 });
});

test("a burst of fast tools holds at most four tool-event POSTs at once", async () => {
  captured = [];
  let inFlight = 0;
  let peak = 0;
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), method: init?.method, headers: init?.headers ?? {}, body: JSON.parse(init.body) });
    peak = Math.max(peak, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight--;
    return { ok: true, text: async () => JSON.stringify({ ok: true }), json: async () => ({ ok: true }) };
  };
  await cave().trace({ traceId: TRACE_ID, spanId: SPAN_ID }, async (trace) => {
    for (let index = 0; index < 10; index++) await trace.tool(`tool-${index}`, {}, () => index);
  });
  assert.equal(captured.length, 10);
  assert.deepEqual(captured.map((request) => request.body.sequence).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(peak <= 4, `peak tool-event POSTs in flight = ${peak}`);
});

function installGateway(statuses, retryAfter = "0.01") {
  captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), method: init?.method, headers: init?.headers ?? {}, body: JSON.parse(init.body) });
    const status = statuses.shift() ?? 202;
    return new Response("{}", { status, headers: status === 202 ? {} : { "retry-after": retryAfter } });
  };
}

for (const status of [503, 429]) {
  test(`a tool event the gateway did not take (${status}) is sent again`, async () => {
    installGateway([status, status]);
    await cave().trace({ traceId: TRACE_ID, spanId: SPAN_ID }, (trace) => trace.tool("retried", {}, () => "result"));
    assert.deepEqual(captured.map((request) => request.body.name), ["retried", "retried", "retried"]);
  });
}

test("a tool event refused for good is not resent, nor one asked to wait past the flush window", async () => {
  installGateway([400]);
  await cave().trace({ traceId: TRACE_ID, spanId: SPAN_ID }, (trace) => trace.tool("invalid", {}, () => 1));
  assert.equal(captured.length, 1);
  installGateway([429], "60");
  await cave().trace({ traceId: TRACE_ID, spanId: SPAN_ID }, (trace) => trace.tool("rate-limited", {}, () => 1));
  assert.equal(captured.length, 1);
});

test("cave.trace waits at most 5 s for tool events a stalled gateway never takes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.fetch = async () => new Promise(() => {});
  let settled = false;
  const traced = cave().trace({ traceId: TRACE_ID, spanId: SPAN_ID }, async (trace) => {
    for (let index = 0; index < 40; index++) await trace.tool(`tool-${index}`, {}, () => index);
    return "result";
  }).then((value) => { settled = true; return value; });
  for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(4_999);
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.equal(await traced, "result", "40 tool events x 30 s / 4 lanes held the caller's result for 5 minutes");
});
