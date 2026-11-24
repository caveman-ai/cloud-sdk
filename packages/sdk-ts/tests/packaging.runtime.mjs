import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJSON = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("package publishes only built runtime, types, license, and README", () => {
  assert.equal(packageJSON.name, "@caveman-ai/sdk");
  assert.equal(packageJSON.version, "2.0.0");
  assert.deepEqual(packageJSON.files, ["dist", "README.md", "LICENSE"]);
  assert.deepEqual(packageJSON.exports, {
    ".": {
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    },
    "./evals": {
      types: "./dist/evals.d.ts",
      default: "./dist/evals.js",
    },
    "./cloud": {
      types: "./dist/cloud.d.ts",
      default: "./dist/cloud.js",
    },
    "./agents": {
      types: "./dist/agents.d.ts",
      default: "./dist/agents.js",
    },
    "./sandboxes": {
      types: "./dist/sandboxes.d.ts",
      default: "./dist/sandboxes.js",
    },
    "./rooms": {
      types: "./dist/rooms.d.ts",
      default: "./dist/rooms.js",
    },
    "./apps": {
      types: "./dist/apps.d.ts",
      default: "./dist/apps.js",
    },
    "./listeners": {
      types: "./dist/listeners.d.ts",
      default: "./dist/listeners.js",
    },
    "./workflows": {
      types: "./dist/workflows.d.ts",
      default: "./dist/workflows.js",
    },
    "./pools": {
      types: "./dist/pools.d.ts",
      default: "./dist/pools.js",
    },
    "./router": {
      types: "./dist/router.d.ts",
      default: "./dist/router.js",
    },
  });
  assert.equal(packageJSON.sideEffects, false);
  assert.equal(packageJSON.publishConfig.access, "public");
  assert.equal(packageJSON.dependencies, undefined);
  assert.equal(packageJSON.scripts.prepack, "npm run build");
  assert.equal(packageJSON.scripts.test, "npm run build && npm run test:types && npm run test:node");
});

// A CommonJS app (NestJS, Jest, ts-node) loads the SDK with require(); an
// "import"-only export map refuses that with ERR_PACKAGE_PATH_NOT_EXPORTED.
test("every entry point loads from CommonJS require() as well as import", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  assert.equal(typeof require("@caveman-ai/sdk").Cave, "function");
  assert.equal(typeof require("@caveman-ai/sdk/cloud").Cloud, "function");
  assert.equal(typeof require("@caveman-ai/sdk/agents").Agents, "function");
  assert.equal(typeof require("@caveman-ai/sdk/sandboxes").Sandboxes, "function");
  assert.equal(typeof require("@caveman-ai/sdk/rooms").Rooms, "function");
  assert.equal(typeof require("@caveman-ai/sdk/apps").Apps, "function");
  assert.equal(typeof require("@caveman-ai/sdk/listeners").Listeners, "function");
  assert.equal(typeof require("@caveman-ai/sdk/workflows").Workflows, "function");
  assert.equal(typeof require("@caveman-ai/sdk/pools").ComputerPools, "function");
  assert.equal(typeof require("@caveman-ai/sdk/evals"), "object");
  assert.equal(typeof (await import("@caveman-ai/sdk")).Cave, "function");
});
