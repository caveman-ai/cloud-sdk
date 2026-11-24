// verbs-gate.test.mjs — proves the skills-verbs drift gate catches skills that
// reference a command, MCP tool, or SDK call the shipped surfaces do not
// expose, and passes clean skills. The gate lives in verbs-gate.mjs and is wired
// into compile.mjs's fail-closed path (make check-drift). It reads the Cloud
// command inventory from contracts/operations.public.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const skillsDir = dirname(fileURLToPath(import.meta.url));
const publicDir = join(skillsDir, "..");
const root = join(publicDir, "..");
const { loadSurfaces, scanSkillBody } = await import(pathToFileURL(join(skillsDir, "verbs-gate.mjs")));

const surfaces = loadSurfaces({ skillsDir });

test("the command surface is derivable from source (no fail-open)", () => {
  assert.deepEqual(surfaces.errors, [], "surfaces must parse cleanly, else the gate would pass open");
  assert.ok(surfaces.topLevel.has("login") && !surfaces.topLevel.has("cloud"));
  assert.ok(surfaces.cloudFamilies.has("traces") && surfaces.cloudCommands.has("traces.search"));
  assert.ok(surfaces.mcpTools.has("caveman_plan") && surfaces.mcpTools.has("caveman_retrieve"));
  assert.ok(surfaces.sdkMembers.has("compress") && surfaces.sdkMembers.has("page"));
  assert.equal(surfaces.pageRequiresSource, true);
});

test("every registered skill resolves against the real surfaces", () => {
  const registry = JSON.parse(readFileSync(join(skillsDir, "registry.json"), "utf8"));
  for (const meta of registry.skills) {
    const body = readFileSync(join(skillsDir, meta.id, "SKILL.md"), "utf8");
    assert.deepEqual(scanSkillBody(meta.id, body, surfaces), [], `${meta.id} must not reference an unknown surface`);
  }
});

// --- regression fixtures: each broken pattern must be caught ---

test("gate catches artifacts.page without the required source argument (breakage #1)", () => {
  const before = "x\n\n`trace.artifacts.page(value, { strategy: \"json-index\", maxInlineTokens })`\n";
  const after = "x\n\n`trace.artifacts.page(value, { source: \"tool-output\", strategy: \"json-index\" })`\n";
  assert.match(scanSkillBody("fx", before, surfaces).join("\n"), /artifacts\.page.*source/);
  assert.deepEqual(scanSkillBody("fx", after, surfaces), []);
});

test("gate catches a bogus top-level command in a code fence", () => {
  const body = "do this:\n\n```bash\ncaveman frobnicate42 --now\n```\n";
  assert.match(scanSkillBody("fx", body, surfaces).join("\n"), /frobnicate42/);
});

test("gate sends `caveman cloud` to cvm, even in prose", () => {
  assert.match(scanSkillBody("fx", "run caveman cloud traces search today", surfaces).join("\n"), /moved to `cvm`/);
});

test("gate checks cvm families in code and verbs wherever the family is real", () => {
  assert.match(scanSkillBody("fx", "`cvm frobnicate list`", surfaces).join("\n"), /cvm frobnicate/);
  assert.match(scanSkillBody("fx", "then run cvm traces frobnicate", surfaces).join("\n"), /cvm traces frobnicate/);
  const clean = [
    "`cvm traces search --from 2026-09-01T00:00:00Z`",
    "`cvm traces show <trace-id>`", // show reads as get
    "`cvm evals drafts list`", // the eval_drafts family
    "`cvm sql \"SELECT 1\"`",
    "`cvm doctor`",
    "install cvm with npm", // unknown word after cvm in prose is prose
  ].join("\n\n");
  assert.deepEqual(scanSkillBody("fx", clean, surfaces), []);
});

test("gate catches an unknown MCP tool token", () => {
  assert.match(scanSkillBody("fx", "```text\ncaveman_bogus {}\n```", surfaces).join("\n"), /caveman_bogus/);
});

test("gate catches an unknown SDK member call inside code", () => {
  assert.match(scanSkillBody("fx", "`cave.frobnicate(payload)`", surfaces).join("\n"), /cave\.frobnicate/);
});

// --- no false positives on legitimate prose / package names / real commands ---

test("gate does not flag the caveman persona prose or issuer-bound recovery surfaces", () => {
  const clean = [
    "terse like smart caveman. still active. caveman think fast.", // persona prose
    "if the repo uses `caveman_cloud`, call `cave.cave_plan()`", // Python package + SDK call
    "recover a gateway handle via `GET $GATEWAY/sdk/v1/ccr/<handle>`", // gateway-owned CCR
    "recover a local handle via `caveman retrieve <handle>` or the `caveman_retrieve` MCP tool", // local CCR
    "`caveman mem remember -- \"<block>\"`", // breakage #3 fix
    "invoke `/caveman lite|full|ultra`", // slash command, not the binary
  ].join("\n\n");
  assert.deepEqual(scanSkillBody("fx", clean, surfaces), []);
});

test("caveman-optimize keeps report-only profiles off SDK and raw-gateway recovery paths", () => {
  const body = readFileSync(join(skillsDir, "caveman-optimize", "SKILL.md"), "utf8");
  assert.match(body, /report_only_observations/);
  assert.match(body, /Do not fall back to the gateway's raw `\/sdk\/v1\/cave-plan` read or a project API key/);
  assert.doesNotMatch(body, /GET \$GATEWAY\/sdk\/v1\/ccr\/<handle>/);
  assert.doesNotMatch(body, /recoveryHandle|cave\.compress/);
});

// --- process-level proof: compile.mjs itself fails closed on a bogus skill ---

test("compile.mjs rejects a registered skill with a nonexistent command", () => {
  // Run against a throwaway COPY of public/skills so the real registry is never
  // mutated. The copy is a sibling of skills/ under public/, so compile.mjs's
  // ../mcp, ../sdk, ../agents and ../../cloud lookups still resolve to the real sources.
  const tmpSkillsDir = join(publicDir, ".gate-fixture-tmp");
  rmSync(tmpSkillsDir, { recursive: true, force: true });
  try {
    cpSync(skillsDir, tmpSkillsDir, {
      recursive: true,
      filter: (src) => !src.includes(`${sep}node_modules`),
    });
    const registryPath = join(tmpSkillsDir, "registry.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    const fixtureDir = join(tmpSkillsDir, "gate-fixture");
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      join(fixtureDir, "SKILL.md"),
      "---\nname: gate-fixture\n---\n\nRegression fixture.\n\n```bash\ncaveman frobnicate42 --now\n```\n",
    );
    registry.skills.push({ id: "gate-fixture", summary: "gate fixture", delivery: ["cli"], suites: ["output"] });
    registry.suites.output.push("gate-fixture");
    writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");

    const result = spawnSync(process.execPath, [join(tmpSkillsDir, "compile.mjs")], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, "compile.mjs must fail closed on a bogus command");
    assert.match(result.stderr, /frobnicate42/, "the failure must name the offending command");
  } finally {
    rmSync(tmpSkillsDir, { recursive: true, force: true });
  }
});
