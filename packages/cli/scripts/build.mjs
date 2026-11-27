#!/usr/bin/env node
// Standalone cvm build inside caveman-ai/cloud-sdk — reads sanitized contracts,
// @caveman-ai/sdk sandboxes, and skills/. Zero private Cloud imports.
import { build } from 'esbuild';
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const cliRoot = resolve(import.meta.dirname, '..');
const platRoot = resolve(cliRoot, '../..');
const distDir = resolve(cliRoot, 'dist');

async function maxMtime(paths) {
  let newest = 0;
  for (const p of paths) {
    let st;
    try { st = await stat(p); } catch { continue; }
    if (st.isDirectory()) {
      const entries = await readdir(p, { withFileTypes: true });
      const nested = await maxMtime(entries.map((e) => join(p, e.name)));
      if (nested > newest) newest = nested;
    } else if (st.mtimeMs > newest) {
      newest = st.mtimeMs;
    }
  }
  return newest;
}

if (process.argv.includes('--if-stale')) {
  const outputs = [
    resolve(distDir, 'cloud-client.mjs'),
    resolve(distDir, 'cloud-mcp.mjs'),
    resolve(distDir, 'sandboxes.mjs'),
    resolve(distDir, 'criterion-registry.json'),
    resolve(distDir, 'skills/caveman-build/SKILL.md'),
  ];
  if (outputs.every((p) => existsSync(p))) {
    const [outStats, newestInput] = await Promise.all([
      Promise.all(outputs.map((p) => stat(p))),
      maxMtime([
        resolve(cliRoot, 'client'),
        resolve(cliRoot, 'scripts/build.mjs'),
        resolve(platRoot, 'packages/sdk-ts/src/sandboxes.ts'),
        resolve(platRoot, 'packages/sdk-ts/src/sandboxes.generated.ts'),
        resolve(platRoot, 'contracts/criterion-registry.json'),
        resolve(platRoot, 'contracts/operations.public.json'),
        resolve(platRoot, 'skills'),
      ]),
    ]);
    const oldestOutput = Math.min(...outStats.map((s) => s.mtimeMs));
    if (oldestOutput >= newestInput) {
      process.exit(0);
    }
  }
}

await mkdir(distDir, { recursive: true });

await Promise.all([
  ...[['index.mjs', 'cloud-client.mjs'], ['mcp.mjs', 'cloud-mcp.mjs']].map(([source, output]) =>
    build({
      entryPoints: [resolve(cliRoot, 'client', source)],
      outfile: resolve(distDir, output),
      bundle: true,
      minify: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      banner: { js: 'import { createRequire as __cloudRequire } from "node:module"; const require = __cloudRequire(import.meta.url);' },
    })
  ),
  build({
    entryPoints: [resolve(platRoot, 'packages/sdk-ts/src/sandboxes.ts')],
    outfile: resolve(distDir, 'sandboxes.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    legalComments: 'none',
    logLevel: 'warning',
  }),
  copyFile(resolve(platRoot, 'contracts/criterion-registry.json'), resolve(distDir, 'criterion-registry.json')),
]);

const skillsDir = resolve(platRoot, 'skills');
const registry = JSON.parse(await readFile(resolve(skillsDir, 'registry.json'), 'utf8'));
const suite = registry.suites?.cvm ?? ['caveman-cloud'];
const bundleDir = resolve(distDir, 'skills/caveman-cloud');
await rm(resolve(distDir, 'skills'), { recursive: true, force: true });
await mkdir(resolve(bundleDir, 'references'), { recursive: true });
await Promise.all([
  ...suite.map(async (id, i) => {
    const src = resolve(skillsDir, id, 'SKILL.md');
    if (existsSync(src)) {
      await copyFile(src, resolve(bundleDir, i ? `references/${id}.md` : 'SKILL.md'));
    }
  }),
  ...['caveman-build', 'caveman-sandbox', 'caveman-drive', 'caveman-rooms', 'caveman-deploy', 'caveman-apps', 'caveman-listeners', 'caveman-workflows'].map(async (id) => {
    const src = resolve(skillsDir, id, 'SKILL.md');
    if (existsSync(src)) {
      const dir = resolve(distDir, 'skills', id);
      await mkdir(dir, { recursive: true });
      await copyFile(src, resolve(dir, 'SKILL.md'));
    }
  }),
]);
console.log('Built @caveman-ai/cloud (cvm) cleanly from platform/contracts');
