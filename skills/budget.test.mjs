// budget.test.mjs: the token budget of the skill `cvm setup` installs.
// Level 0 is the
// entry's description, loaded every session; level 1 the entry's body, loaded
// when the skill triggers; level 2 one reference, loaded when the task needs
// it. A layer that grows past its line fails here: split it, do not raise it.
// The MCP half (server instructions, tool descriptions) is
// cloud/agent-surface/tests/mcp.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const suite = JSON.parse(readFileSync(join(here, "registry.json"), "utf8")).suites.cvm;
const read = (id) => readFileSync(join(here, id, "SKILL.md"), "utf8");

const BUDGETS = { description_chars: 400, entry_body_bytes: 4096, reference_bytes: 6144 };

// The frontmatter's description as an agent host reads it: inline, or a
// folded `>` block joined with single spaces.
function description(body) {
  const lines = body.slice(4, body.indexOf("\n---\n", 4)).split("\n");
  const at = lines.findIndex((line) => line.startsWith("description:"));
  assert.notEqual(at, -1, "frontmatter has no description");
  const inline = lines[at].slice("description:".length).trim();
  if (!/^[>|]-?$/.test(inline)) return inline.replace(/^(["'])(.*)\1$/, "$2");
  const block = [];
  for (const line of lines.slice(at + 1)) {
    if (!/^\s/.test(line)) break;
    block.push(line.trim());
  }
  return block.join(" ").trim();
}

test("level 0: the entry's description fits its budget", () => {
  const text = description(read(suite[0]));
  assert.ok(text.length > 0);
  assert.ok(text.length <= BUDGETS.description_chars, `${suite[0]} description is ${text.length} chars; budget ${BUDGETS.description_chars}`);
});

test("level 1: the entry's body fits its budget", () => {
  const body = read(suite[0]);
  const bytes = Buffer.byteLength(body.slice(body.indexOf("\n---\n", 4) + 5));
  assert.ok(bytes <= BUDGETS.entry_body_bytes, `${suite[0]} body is ${bytes} bytes; budget ${BUDGETS.entry_body_bytes}`);
});

test("level 2: every reference fits its budget", () => {
  const over = suite.slice(1)
    .map((id) => [id, Buffer.byteLength(read(id))])
    .filter(([, bytes]) => bytes > BUDGETS.reference_bytes);
  assert.deepEqual(over, [], `references over ${BUDGETS.reference_bytes} bytes; split each into suite skills`);
});

test("the entry names every reference it routes to, and each exists in the suite", () => {
  const entry = read(suite[0]);
  const named = [...entry.matchAll(/\|\s*(caveman-[a-z0-9-]+)\s*\|\s*$/gm)].map((m) => m[1]);
  assert.ok(named.length > 0, "the router table names no reference");
  for (const id of named) assert.ok(suite.includes(id), `router names ${id}, which is not in the cvm suite`);
});
