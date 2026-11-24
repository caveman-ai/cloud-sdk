// verbs-gate.mjs — the skills-verbs drift gate (fail-closed, deterministic).
//
// Invariant: a skill can never document a command, MCP tool, or SDK call the
// shipped surfaces do not expose. This module derives the real surfaces from
// source — the public Cloud command inventory (contracts/operations.public.json
// or a local surface.json) for `cvm` commands and
// Cloud MCP tools, the reserved-verbs registry for the local `caveman` CLI, the
// engine MCP manifest, and the two SDKs' method definitions — then scans each
// canonical SKILL.md for references and reports anything that does not resolve.
// It is pure (returns a list of violations; it never exits), so the compiler and
// the tests share one implementation.
//
// Recognition rule: commands/tools/API calls are recognized inside code
// contexts (fenced blocks and inline `code` spans). An unknown token inside a
// code context fails closed. An unknown word after `caveman` or `cvm` in prose is
// treated as ordinary prose (the `caveman` persona skill legitimately says "like
// caveman while ...") and ignored — but `caveman cloud` (Cloud commands moved to
// `cvm`), a wrong verb after a real `cvm` family, MCP `caveman_*` tokens, and the
// required `source` argument on `artifacts.page` are enforced wherever they appear.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function readOptional(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

// `cvm` spellings the client resolves to another operation id.
const VERB_ALIASES = { show: "get" };
const FAMILY_ALIASES = { "evals drafts": "eval_drafts" };
// Commands the `cvm` binary answers itself, before the operation client
// (public/cloud-cli/bin/cvm.mjs): sign-in, the stdio MCP server, the
// eval-file and CI entry points, and an agent folder from a template. `cvm
// setup` with flags or nothing needs no entry: `setup` is already an operation
// family, so its verbs (show, assert, hold) stay checked.
const CVM_OWN_COMMANDS = [
  "login", "logout", "mcp", "evals.init", "evals.ci", "evals.watch",
  "agent.init", "agent.build", "agent.dev", "deploy", "run", "deployments", "sessions", "connect",
  "key.quick", "skills.list", "skills.add",
  "sandbox.create", "sandbox.list", "sandbox.get", "sandbox.exec", "sandbox.cp", "sandbox.ls",
  "sandbox.port-forward", "sandbox.url", "sandbox.sleep", "sandbox.resume", "sandbox.delete",
  "sandbox.snapshot", "sandbox.snapshots", "sandbox.restore", "sandbox.fork", "sandbox.snapshot-delete", "sandbox.status",
  "drive.list", "drive.create", "drive.ls", "drive.cat", "drive.get", "drive.put", "drive.grep",
  "drive.mv", "drive.rm", "drive.log", "drive.changes", "drive.restore", "drive.share", "drive.grants",
  "drive.grant", "drive.revoke", "drive.verify", "drive.archive", "drive.unarchive", "drive.set",
  "drive.usage", "drive.fork", "drive.merge", "drive.diff", "drive.review", "drive.approve", "drive.reject", "drive.undo",
  "room.list", "room.create", "room.threads", "room.open", "room.post", "room.read", "room.wait",
  "room.claim", "room.renew", "room.release", "room.complete", "room.watch", "room.rollup",
  "apps.list", "apps.create", "apps.fork", "apps.token", "apps.archive",
  "listeners.list", "listeners.create", "listeners.pause", "listeners.resume", "listeners.ingest", "listeners.events", "listeners.stats", "listeners.delete",
  "workflows.list", "workflows.create", "workflows.run", "workflows.get",
  "pools.list", "pools.create", "pools.computers", "pools.archive",
];

// Derive every surface a skill may reference. `errors` is non-empty when a
// source could not be parsed — the caller must fail closed rather than scan
// against an empty surface (which would pass everything).
export function loadSurfaces({ skillsDir, surfaceFile = join(skillsDir, "..", "contracts", "operations.public.json") }) {
  const errors = [];
  const publicRoot = join(skillsDir, "..");
  const packageRoot = existsSync(join(publicRoot, "sdk"))
    ? publicRoot
    : join(publicRoot, "packages");

  // Top-level `caveman` verbs: the reserved-verbs registry is the canonical
  // source. Cloud commands left `caveman cloud` for `cvm`.
  let topLevel = new Set();
  try {
    const doc = JSON.parse(readFileSync(join(skillsDir, "..", "agents", "reserved-verbs.json"), "utf8"));
    if (!Array.isArray(doc.verbs)) throw new Error("verbs is not an array");
    topLevel = new Set(doc.verbs.filter((verb) => verb !== "cloud"));
  } catch (error) {
    errors.push(`reserved-verbs.json: ${error.message}`);
  }

  // `cvm <family> <verb>` and Cloud MCP tools: the shipped client's inventory.
  const cloudCommands = new Set();
  const cloudFamilies = new Set();
  const mcpTools = new Set();
  try {
    const surface = JSON.parse(readFileSync(surfaceFile, "utf8"));
    if (surface.schema_version !== 1 || !Array.isArray(surface.commands) || !Array.isArray(surface.mcp_tools)) throw new Error("invalid inventory");
    for (const command of surface.commands) {
      cloudCommands.add(command);
      cloudFamilies.add(command.split(".")[0]);
    }
    for (const command of CVM_OWN_COMMANDS) {
      cloudCommands.add(command);
      cloudFamilies.add(command.split(".")[0]);
    }
    for (const tool of surface.mcp_tools) mcpTools.add(tool);
    if (cloudCommands.size === 0) throw new Error("no commands");
  } catch (error) {
    errors.push(`Cloud surface ${surfaceFile}: ${error.message}`);
  }

  // Engine MCP server tool names (Go), pinned by engine-mcp-tools.json.
  let declaredEngineTools = [];
  try {
    const manifest = JSON.parse(readFileSync(join(skillsDir, "engine-mcp-tools.json"), "utf8"));
    if (manifest.schema_version !== "1" || !Array.isArray(manifest.tools)) {
      throw new Error('schema_version must be "1" and tools must be an array');
    }
    declaredEngineTools = [...manifest.tools];
    if (
      declaredEngineTools.length === 0
      || new Set(declaredEngineTools).size !== declaredEngineTools.length
      || declaredEngineTools.some((name) => typeof name !== "string" || !/^caveman_[a-z_]+$/.test(name))
    ) {
      throw new Error("tools must be unique caveman_* names");
    }
    for (const name of declaredEngineTools) mcpTools.add(name);
  } catch (error) {
    errors.push(`engine-mcp-tools.json: ${error.message}`);
  }
  const engineSrc = readOptional(join(skillsDir, "..", "mcp", "engine_tools.go"));
  const sourceEngineTools = [...engineSrc.matchAll(/Tool\w+\s*=\s*"(caveman_[a-z_]+)"/g)].map((match) => match[1]);
  if (sourceEngineTools.length > 0) {
    const declared = [...declaredEngineTools].sort();
    const source = [...new Set(sourceEngineTools)].sort();
    if (JSON.stringify(declared) !== JSON.stringify(source)) {
      errors.push("engine-mcp-tools.json drifted from public/mcp/engine_tools.go");
    }
  }
  if (mcpTools.size === 0) errors.push("could not parse MCP tool names");

  // SDK method/property surface: TS + Python definitions.
  const sdkMembers = new Set();
  const tsSrc = readOptional(join(packageRoot, "sdk", "typescript", "src", "index.ts"));
  for (const re of [
    /^\s+(?:public\s+|private\s+|readonly\s+|static\s+)*(?:async\s+)?([a-zA-Z_$][\w$]*)\s*\(/gm, // method defs
    /^\s+([a-zA-Z_$][\w$]*)\s*=\s*/gm, // class fields (e.g. artifacts = { ... })
    /^\s+([a-zA-Z_$][\w$]*)\s*:\s*(?:async\s*)?\(/gm, // object-literal methods (page: async ( ... ))
  ]) {
    for (const m of tsSrc.matchAll(re)) sdkMembers.add(m[1]);
  }
  const pySrc = readOptional(join(packageRoot, "sdk", "python", "caveman_cloud", "core.py"));
  for (const m of pySrc.matchAll(/^\s+def\s+([a-zA-Z_]\w*)\s*\(/gm)) sdkMembers.add(m[1]);
  if (!sdkMembers.has("compress") || !sdkMembers.has("page") || !sdkMembers.has("tools")) {
    errors.push("could not parse the SDK member surface");
  }

  // Assert the required-`source` contract against the live TS signature so the
  // gate can never enforce a stale requirement.
  const pageRequiresSource = /page:\s*async\s*\([^)]*options:\s*\{[^}]*\bsource:\s*string\b/.test(tsSrc);
  if (!pageRequiresSource) {
    errors.push("artifacts.page no longer declares a required `source` — refresh the gate");
  }

  // caveman_-prefixed identifiers that are NOT MCP tools: the Python SDK package.
  const sdkPackages = new Set();
  if (existsSync(join(packageRoot, "sdk", "python", "caveman_cloud"))) sdkPackages.add("caveman_cloud");

  return { topLevel, cloudCommands, cloudFamilies, mcpTools, sdkMembers, sdkPackages, pageRequiresSource, errors };
}

// Character ranges covered by a fenced code block or an inline `code` span.
// Fenced regions are masked before inline matching so an inline span can never
// straddle a fence; inline spans may cross a single line break (Markdown renders
// an inline `code` span containing a newline as a space).
function codeIntervals(body) {
  const intervals = [];
  const fence = /^```[^\n]*\n([\s\S]*?)^```/gm;
  let m;
  while ((m = fence.exec(body))) intervals.push([m.index, fence.lastIndex]);
  const masked = body.split("");
  for (const [start, end] of intervals) {
    for (let i = start; i < end; i++) masked[i] = " ";
  }
  const inline = /`[^`]+`/g;
  const maskedText = masked.join("");
  while ((m = inline.exec(maskedText))) intervals.push([m.index, inline.lastIndex]);
  return intervals;
}

function inCode(intervals, idx) {
  return intervals.some(([start, end]) => idx >= start && idx < end);
}

// Smallest code context containing idx (the inline span for an inline call).
function enclosingCode(intervals, body, idx) {
  let best = null;
  for (const [start, end] of intervals) {
    if (idx >= start && idx < end && (!best || end - start < best[1] - best[0])) best = [start, end];
  }
  return best ? body.slice(best[0], best[1]) : "";
}

// Scan one SKILL.md body against the derived surfaces. Returns violation
// strings (empty = clean). Never throws, never exits.
export function scanSkillBody(id, body, surfaces) {
  const violations = [];
  const intervals = codeIntervals(body);
  const V = (message) => violations.push(`${id}: ${message}`);

  // Local CLI commands: `caveman <verb>` / `cave <verb>`. The lookbehind rejects
  // `/caveman` (slash command), `@caveman-ai/sdk`, `caveman-learn`, and `foo.cave`.
  const cliRe = /(?<![\w/@.\-])(caveman|cave)[ \t]+([a-z][\w-]*)/g;
  for (const m of body.matchAll(cliRe)) {
    const [, bin, verb] = m;
    if (verb === "cloud") V(`\`${bin} cloud\` moved to \`cvm\`; write \`cvm <family> <verb>\``);
    else if (!surfaces.topLevel.has(verb) && inCode(intervals, m.index)) {
      V(`unknown command \`${bin} ${verb}\` — not a reserved top-level verb`);
    }
    // unknown verb in prose = ordinary word (the caveman persona) → ignore
  }

  // Cloud commands: `cvm <family> [<verb>]`, checked against the client inventory.
  const cvmRe = /(?<![\w/@.\-])cvm[ \t]+([a-z][\w-]*)(?:[ \t]+([a-z][\w-]*))?(?:[ \t]+([a-z][\w-]*))?/g;
  for (const m of body.matchAll(cvmRe)) {
    let [, family, verb, next] = m;
    const aliased = FAMILY_ALIASES[`${family} ${verb}`];
    if (aliased) [family, verb] = [aliased, next];
    if (!surfaces.cloudFamilies.has(family)) {
      if (inCode(intervals, m.index)) V(`unknown \`cvm ${family}\` — not a Cloud command family`);
      continue;
    }
    if (!verb || surfaces.cloudCommands.has(family) || surfaces.cloudCommands.has(`${family}.${verb}`)) continue;
    if (surfaces.cloudCommands.has(`${family}.${VERB_ALIASES[verb]}`)) continue;
    V(`unknown \`cvm ${family} ${verb}\` — not a Cloud command`);
  }

  // MCP tool tokens: caveman_<name>. Snake-case is never English prose, so an
  // unknown one fails wherever it appears (except the Python SDK package name).
  const mcpRe = /(?<![\w/@.\-])(caveman_[a-z_]+)/g;
  for (const m of body.matchAll(mcpRe)) {
    const name = m[1];
    if (surfaces.sdkPackages.has(name) || surfaces.mcpTools.has(name)) continue;
    V(`unknown MCP tool / caveman_ identifier \`${name}\``);
  }

  // SDK calls: cave./trace./handle.<member>[.<member>]( — only inside code.
  const sdkRe = /(?<![\w$.])(cave|trace|handle)\.([a-zA-Z_$][\w$]*)(?:\.([a-zA-Z_$][\w$]*))?[ \t\n]*\(/g;
  for (const m of body.matchAll(sdkRe)) {
    if (!inCode(intervals, m.index)) continue;
    const [, recv, first, second] = m;
    if (!surfaces.sdkMembers.has(first)) { V(`unknown SDK member \`${recv}.${first}\``); continue; }
    if (second && !surfaces.sdkMembers.has(second)) { V(`unknown SDK member \`${recv}.${first}.${second}\``); continue; }
    if (first === "artifacts" && second === "page") {
      const ctx = enclosingCode(intervals, body, m.index);
      if (!/\bsource\b/.test(ctx)) V("`artifacts.page` call omits the required `source` argument");
    }
  }

  return violations;
}
