/**
 * Type-level tests for per-request optimization control and the response
 * receipt. Compiled by `tsc --noEmit`; the runtime behaviour lives in
 * optimize.runtime.mjs. Locks the field names against sdk-python
 * (`OptimizeOption` / `Receipt` in caveman_cloud/core.py).
 */
import type { CacheOption, CaveReceipt, GatewayOptions, OptimizeOption } from "../src/index.js";

const _off: OptimizeOption = "off";
const _all: OptimizeOption = { compress: false, cacheHints: false, routing: false };
const _one: OptimizeOption = { routing: false };
// Gateway v1: asking for an optimization, and picking an output style.
const _up: OptimizeOption = { compress: true, routing: true, style: "caveman" };
const _mixed: OptimizeOption = { compress: true, cacheHints: false, style: "concise" };
// Narrowing nothing is legal at the type level; it simply omits the header.
const _none: OptimizeOption = {};
// The idiomatic conditional must compile (the repo sets exactOptionalPropertyTypes)
// and read as absent at runtime, matching sdk-python's `{"compress": None}`.
declare const flag: boolean;
const _conditional: OptimizeOption = { compress: flag ? false : undefined };

// @ts-expect-error — "on" is not an optimize value; "off" is the only string.
const _bad: OptimizeOption = "on";
// @ts-expect-error — unknown field, caught at compile time (and again at runtime).
const _typo: OptimizeOption = { compres: false };
// @ts-expect-error — the style set is closed; the gateway would 400 on this token.
const _badStyle: OptimizeOption = { style: "terse" };

const _cacheForce: CacheOption = "force";
const _cacheDisable: CacheOption = "disable";
const _cacheTtl: CacheOption = { ttlSeconds: 900 };
const _cacheSemantic: CacheOption = "semantic";
const _cacheSemanticTtl: CacheOption = { ttlSeconds: 900, semantic: true };
// @ts-expect-error — "respect" is the absent-header default, not a value to send.
const _badCache: CacheOption = "respect";

const _gateway: GatewayOptions = {
  apiKey: "cave_live_x",
  baseURL: "https://gateway.caveman.so",
  agent: "support-bot",
  workflow: "refunds",
  optimize: { compress: true, style: "caveman" },
  cache: { ttlSeconds: 900 },
  cacheKey: "tenant-42"
};

// Every receipt field is optional: an unoptimized response discloses nothing.
const _empty: CaveReceipt = {};
const _full: CaveReceipt = {
  mode: "optimize",
  optimizations: ["caveman-compression"],
  cacheStatus: "hit",
  optimizeApplied: ["compress"],
  optimizeDenied: { route: "capability_off" },
  cacheMode: "force",
  responseCache: "hit_semantic",
  semanticSimilarity: 0.94,
  requestId: "req_1",
  compressionRatio: 0.6,
  tokensBefore: 1200,
  tokensAfter: 720,
  recoveryHandle: "ccr_abc"
};

export {};
