#!/usr/bin/env node
// Standalone cvm build inside caveman-ai/cloud-sdk — reads sanitized contracts,
// @caveman-ai/sdk sandboxes, and skills/. Zero private Cloud imports.
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const cliRoot = resolve(import.meta.dirname, '..');
const platRoot = resolve(cliRoot, '../..');
const distDir = resolve(cliRoot, 'dist');
await mkdir(distDir, { recursive: true });

for (const [source, output] of [['index.mjs', 'cloud-client.mjs'], ['mcp.mjs', 'cloud-mcp.mjs']]) {
  await build({
    entryPoints: [resolve(cliRoot, 'client', source)],
    outfile: resolve(distDir, output),
    bundle: true,
    minify: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: { js: 'import { createRequire as __cloudRequire } from "node:module"; const require = __cloudRequire(import.meta.url);' },
  });
}

await build({
  entryPoints: [resolve(platRoot, 'packages/sdk-ts/src/sandboxes.ts')],
  outfile: resolve(distDir, 'sandboxes.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  legalComments: 'none',
  logLevel: 'warning',
});

await copyFile(resolve(platRoot, 'contracts/criterion-registry.json'), resolve(distDir, 'criterion-registry.json'));

const skillsDir = resolve(platRoot, 'skills');
const registry = JSON.parse(await readFile(resolve(skillsDir, 'registry.json'), 'utf8'));
const suite = registry.suites?.cvm ?? ['caveman-cloud'];
const bundleDir = resolve(distDir, 'skills/caveman-cloud');
await rm(resolve(distDir, 'skills'), { recursive: true, force: true });
await mkdir(resolve(bundleDir, 'references'), { recursive: true });
for (const [i, id] of suite.entries()) {
  const src = resolve(skillsDir, id, 'SKILL.md');
  if (existsSync(src)) {
    await copyFile(src, resolve(bundleDir, i ? `references/${id}.md` : 'SKILL.md'));
  }
}
for (const id of ['caveman-build', 'caveman-sandbox', 'caveman-drive', 'caveman-rooms', 'caveman-deploy', 'caveman-apps', 'caveman-listeners', 'caveman-workflows']) {
  const src = resolve(skillsDir, id, 'SKILL.md');
  if (existsSync(src)) {
    const dir = resolve(distDir, 'skills', id);
    await mkdir(dir, { recursive: true });
    await copyFile(src, resolve(dir, 'SKILL.md'));
  }
}
console.log('Built @caveman-ai/cloud (cvm) cleanly from platform/contracts');
