/**
 * Runtime tests for per-request optimization control (`x-cave-optimize`) and
 * the response-receipt parser.
 * Run with: node --test tests/optimize.runtime.mjs (after `pnpm build`).
 * Mirrors the Python tests/test_optimize.py.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";

import { Cave, gatewayConfig, gatewayHeaders, parseReceipt } from "../dist/index.js";

let captured = [];
const originalFetch = globalThis.fetch;

function mockFetch() {
  captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), headers: init?.headers ?? {} });
    return { ok: true, json: async () => ({ id: "resp_1" }), text: async () => "{}" };
  };
}

after(() => { globalThis.fetch = originalFetch; });

const cave = new Cave({ apiKey: "cave_live_test", baseURL: "http://localhost:8787", agent: "a" });

// ─── Option → header serialization ────────────────────────────────────────────

test("no optimize option sends no x-cave-optimize header", async () => {
  mockFetch();
  await cave.openai().responses.create({ model: "gpt-4o", input: "hi" });
  assert.equal(captured[0].headers["x-cave-optimize"], undefined);
});

test('optimize:"off" sends the pass-through token', async () => {
  mockFetch();
  await cave.openai().responses.create({ model: "gpt-4o", input: "hi" }, { cave: { optimize: "off" } });
  assert.equal(captured[0].headers["x-cave-optimize"], "off");
});

test("false fields serialize to opt-down tokens in a stable order", async () => {
  mockFetch();
  // Declared out of order on purpose: the header order must not follow the object's.
  await cave.openai().chat.completions.create({ model: "gpt-4o", messages: [] }, {
    cave: { optimize: { routing: false, cacheHints: false, compress: false } }
  });
  assert.equal(captured[0].headers["x-cave-optimize"], "no-compress,no-cache,no-route");
});

test("a single false field sends only that token", async () => {
  mockFetch();
  await cave.openai().responses.create({ model: "gpt-4o", input: "hi" }, { cave: { optimize: { compress: false } } });
  assert.equal(captured[0].headers["x-cave-optimize"], "no-compress");
});

test("an empty optimize object narrows nothing, so the header is omitted", async () => {
  mockFetch();
  await cave.openai().responses.create({ model: "gpt-4o", input: "hi" }, { cave: { optimize: {} } });
  assert.equal(captured[0].headers["x-cave-optimize"], undefined);
});

test("an absent field value reads as absent, so the idiomatic conditional works", async () => {
  mockFetch();
  // `{ compress: flag ? false : undefined }` is how callers write this; the
  // undefined/null arm must be a no-op, matching sdk-python's `None`.
  await cave.openai().responses.create({ model: "gpt-4o", input: "hi" }, {
    cave: { optimize: { compress: undefined, cacheHints: null, routing: false } }
  });
  assert.equal(captured[0].headers["x-cave-optimize"], "no-route");
});

test("optimize flows through a trace-scoped provider call too", async () => {
  mockFetch();
  await cave.trace({}, async (t) => {
    await t.model.openai.responses.create({ model: "gpt-4o", input: "hi" }, { cave: { optimize: { routing: false } } });
  });
  assert.equal(captured[0].headers["x-cave-optimize"], "no-route");
});

// ─── Asking for an optimization (gateway v1 opt-up) ───────────────────────────

test("true fields serialize to opt-up tokens", async () => {
  mockFetch();
  await cave.openai().responses.create({ model: "gpt-4o", input: "hi" }, { cave: { optimize: { routing: true, compress: true } } });
  assert.equal(captured[0].headers["x-cave-optimize"], "compress,route");
});

test("opt-up and opt-down mix in one header", async () => {
  mockFetch();
  await cave.openai().responses.create({ model: "gpt-4o", input: "hi" }, { cave: { optimize: { compress: true, cacheHints: false } } });
  assert.equal(captured[0].headers["x-cave-optimize"], "compress,no-cache");
});

test("style is serialized last", async () => {
  mockFetch();
  await cave.openai().responses.create({ model: "gpt-4o", input: "hi" }, { cave: { optimize: { style: "caveman", compress: true } } });
  assert.equal(captured[0].headers["x-cave-optimize"], "compress,style=caveman");
});

test("compress: \"lossless\" asks for the lossless tier only", async () => {
  mockFetch();
  await cave.openai().responses.create({ model: "gpt-4o", input: "hi" }, { cave: { optimize: { compress: "lossless", cacheHints: false } } });
  assert.equal(captured[0].headers["x-cave-optimize"], "compress=lossless,no-cache");
  await assert.rejects(
    () => cave.openai().responses.create({ model: "gpt-4o", input: "hi" }, { cave: { optimize: { routing: "lossless" } } }),
    /must be true/
  );
});

test("an unknown optimize value, field, style, or non-boolean throws", async () => {
  mockFetch();
  await assert.rejects(
    () => cave.openai().responses.create({ model: "gpt-4o", input: "hi" }, { cave: { optimize: "on" } }),
    /unknown optimize value/
  );
  await assert.rejects(
    () => cave.openai().responses.create({ model: "gpt-4o", input: "hi" }, { cave: { optimize: { compres: false } } }),
    /unknown optimize field/
  );
  await assert.rejects(
    () => cave.openai().responses.create({ model: "gpt-4o", input: "hi" }, { cave: { optimize: { style: "terse" } } }),
    /unknown optimize style/
  );
  await assert.rejects(
    () => cave.openai().responses.create({ model: "gpt-4o", input: "hi" }, { cave: { optimize: { compress: "yes" } } }),
    /must be true/
  );
  assert.equal(captured.length, 0, "nothing may reach the wire");
});

// ─── Response cache (x-cave-cache / x-cave-cache-key) ─────────────────────────

test("no cache option sends no cache headers", async () => {
  mockFetch();
  await cave.openai().responses.create({ model: "gpt-4o", input: "hi" });
  assert.equal(captured[0].headers["x-cave-cache"], undefined);
  assert.equal(captured[0].headers["x-cave-cache-key"], undefined);
});

test("cache modes and the ttl form serialize", async () => {
  for (const [option, expected] of [
    ["force", "force"],
    ["disable", "disable"],
    [{ ttlSeconds: 900 }, "ttl=900"],
    ["semantic", "semantic"],
    [{ ttlSeconds: 900, semantic: true }, "semantic,ttl=900"],
    // semantic:false is the exact-match form, not a second spelling of it.
    [{ ttlSeconds: 900, semantic: false }, "ttl=900"]
  ]) {
    mockFetch();
    await cave.openai().responses.create({ model: "gpt-4o", input: "hi" }, { cave: { cache: option } });
    assert.equal(captured[0].headers["x-cave-cache"], expected);
  }
});

test("the cache key is sent and validated", async () => {
  mockFetch();
  await cave.openai().responses.create({ model: "gpt-4o", input: "hi" }, { cave: { cache: "force", cacheKey: "tenant-42:eu" } });
  assert.equal(captured[0].headers["x-cave-cache-key"], "tenant-42:eu");
  mockFetch();
  await assert.rejects(
    () => cave.openai().responses.create({ model: "gpt-4o", input: "hi" }, { cave: { cacheKey: "a".repeat(129) } }),
    /cacheKey must be/
  );
  await assert.rejects(
    () => cave.openai().responses.create({ model: "gpt-4o", input: "hi" }, { cave: { cacheKey: "bad key" } }),
    /cacheKey must be/
  );
  assert.equal(captured.length, 0);
});

test("a bad cache option throws before the wire", async () => {
  mockFetch();
  await assert.rejects(
    () => cave.openai().responses.create({ model: "gpt-4o", input: "hi" }, { cave: { cache: "respect" } }),
    /unknown cache value/
  );
  for (const bad of [{ ttlSeconds: 0 }, { ttlSeconds: -1 }, { ttlSeconds: 1.5 }, {}]) {
    await assert.rejects(
      () => cave.openai().responses.create({ model: "gpt-4o", input: "hi" }, { cave: { cache: bad } }),
      /ttlSeconds/
    );
  }
  await assert.rejects(
    () => cave.openai().responses.create({ model: "gpt-4o", input: "hi" }, { cave: { cache: { ttlSeconds: 900, semantic: "yes" } } }),
    /cache.semantic must be/
  );
  assert.equal(captured.length, 0);
});

// ─── Standalone header helpers ────────────────────────────────────────────────

test("gatewayHeaders matches what the client puts on the wire", async () => {
  mockFetch();
  const client = new Cave({ apiKey: "cave_live_test", baseURL: "http://localhost:8787", agent: "a", defaultWorkflow: "w" });
  await client.openai().responses.create({ model: "gpt-4o", input: "hi" }, {
    cave: { optimize: { compress: true, style: "caveman" }, cache: { ttlSeconds: 900 }, cacheKey: "tenant-42" }
  });
  const helper = gatewayHeaders({
    apiKey: "cave_live_test",
    baseURL: "http://localhost:8787",
    agent: "a",
    workflow: "w",
    optimize: { compress: true, style: "caveman" },
    cache: { ttlSeconds: 900 },
    cacheKey: "tenant-42"
  });
  assert.deepStrictEqual(helper, captured[0].headers);
});

test("gatewayConfig leaves content-type to the vendor SDK", () => {
  const config = gatewayConfig({ apiKey: "cave_live_test", baseURL: "http://localhost:8787/", agent: "a" });
  assert.equal(config.baseURL, "http://localhost:8787");
  // A vendor SDK sets its own content-type per request; pinning it would break
  // multipart uploads.
  assert.equal(config.defaultHeaders["content-type"], undefined);
  assert.equal(config.defaultHeaders["authorization"], "Bearer cave_live_test");
});

// ─── Response receipt ─────────────────────────────────────────────────────────

test("parseReceipt reads every disclosure header the gateway sent", () => {
  const receipt = parseReceipt(new Headers({
    "x-cave-mode": "optimize",
    "x-cave-optimization": "caveman-compression, anthropic-cache-breakpoints",
    "x-cave-cache-status": "hit",
    "x-cave-request-id": "req_123",
    "x-caveman-compression-ratio": "0.6000",
    "x-caveman-tokens-before": "1200",
    "x-caveman-tokens-after": "720",
    "x-caveman-recovery-handle": "ccr_abc"
  }));
  assert.deepEqual(receipt, {
    mode: "optimize",
    optimizations: ["caveman-compression", "anthropic-cache-breakpoints"],
    cacheStatus: "hit",
    requestId: "req_123",
    compressionRatio: 0.6,
    tokensBefore: 1200,
    tokensAfter: 720,
    recoveryHandle: "ccr_abc"
  });
});

test("parseReceipt reads the v1 gateway disclosures", () => {
  const receipt = parseReceipt(new Headers({
    "x-cave-optimize-applied": "compress, route",
    "x-cave-optimize-denied": "cache-hints=eval_gate,style=pass_through",
    "x-cave-cache-mode": "force",
    "x-cave-response-cache": "hit"
  }));
  assert.deepEqual(receipt, {
    optimizeApplied: ["compress", "route"],
    optimizeDenied: { "cache-hints": "eval_gate", style: "pass_through" },
    cacheMode: "force",
    // A hit is an avoided provider call — the receipt states the outcome and
    // nothing else; no savings figure is derived from it.
    responseCache: "hit"
  });
});

test("a semantic outcome is disclosed with its score and mints nothing", () => {
  const hit = parseReceipt(new Headers({
    "x-cave-cache-mode": "semantic",
    "x-cave-response-cache": "hit_semantic",
    "x-cave-semantic-similarity": "0.94"
  }));
  // The receipt states the outcome and the score. No savings figure follows
  // from either: a semantic hit is an avoided call worth zero verified savings.
  assert.deepEqual(hit, { cacheMode: "semantic", responseCache: "hit_semantic", semanticSimilarity: 0.94 });
  // Shadow mode scores the match but the provider still answered.
  const shadow = parseReceipt({ "x-cave-response-cache": "shadow_miss", "x-cave-semantic-similarity": "0.5" });
  assert.deepEqual(shadow, { responseCache: "shadow_miss", semanticSimilarity: 0.5 });
  // Same number grammar as every other receipt float — no exponents.
  assert.equal("semanticSimilarity" in parseReceipt({ "x-cave-semantic-similarity": "9.4e-1" }), false);
});

test("parseReceipt accepts a plain header record, case-insensitively", () => {
  const receipt = parseReceipt({ "X-Cave-Mode": "record", "X-Cave-Optimization": "none" });
  assert.equal(receipt.mode, "record");
  assert.deepEqual(receipt.optimizations, []);
});

test("absent headers leave absent fields — nothing is fabricated", () => {
  const receipt = parseReceipt(new Headers({ "x-cave-mode": "record" }));
  assert.deepEqual(receipt, { mode: "record" });
  assert.equal("optimizations" in receipt, false);
  assert.equal("compressionRatio" in receipt, false);
  assert.deepEqual(parseReceipt(new Headers()), {});
});

test("unparseable numeric disclosure is dropped, not guessed", () => {
  const receipt = parseReceipt({
    "x-caveman-compression-ratio": "not-a-number",
    "x-caveman-tokens-before": "-3",
    "x-caveman-tokens-after": "12.5"
  });
  assert.deepEqual(receipt, {});
});

test("only plain decimals parse — the same strings sdk-python accepts", () => {
  // Empty, hex, exponent, infinity, and stray signs are all dropped on both sides.
  for (const raw of ["", " ", "0x10", "1e3", "Infinity", "+5", "5."]) {
    assert.deepEqual(parseReceipt({ "x-caveman-tokens-before": raw }), {}, `int ${JSON.stringify(raw)}`);
    assert.deepEqual(parseReceipt({ "x-caveman-compression-ratio": raw }), {}, `ratio ${JSON.stringify(raw)}`);
  }
  // Surrounding whitespace is tolerated; the value is not.
  assert.equal(parseReceipt({ "x-caveman-tokens-before": " 42 " }).tokensBefore, 42);
  // Beyond the safe-integer ceiling both SDKs drop rather than round.
  assert.equal(parseReceipt({ "x-caveman-tokens-before": "9007199254740993" }).tokensBefore, undefined);
});
