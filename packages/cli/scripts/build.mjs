#!/usr/bin/env node
// Standalone cvm build inside caveman-ai/cloud-sdk — reads sanitized contracts,
// @caveman-ai/sdk sandboxes, and skills/. Zero private Cloud imports.
import { build } from 'esbuild';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const cliRoot = resolve(import.meta.dirname, '..');
const platRoot = resolve(cliRoot, '../..');
const distDir = resolve(cliRoot, 'dist');
const manifestPath = resolve(distDir, '.build-manifest.json');
const inputPaths = [
  resolve(cliRoot, 'client'),
  resolve(cliRoot, 'scripts/build.mjs'),
  resolve(platRoot, 'packages/sdk-ts/src'),
  resolve(platRoot, 'contracts/criterion-registry.json'),
  resolve(platRoot, 'contracts/operations.public.json'),
  resolve(platRoot, 'skills'),
];

async function snapshotTree(paths, baseDir, ignoreName = '') {
  const entries = [];
  async function walk(p) {
    let st;
    try { st = await stat(p); } catch { return; }
    if (st.isDirectory()) {
      const children = await readdir(p, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        if (ignoreName && child.name === ignoreName) continue;
        await walk(join(p, child.name));
      }
    } else {
      entries.push([relative(baseDir, p), st.mtimeMs, st.size]);
    }
  }
  for (const p of paths) await walk(p);
  return entries;
}

if (process.argv.includes('--if-stale')) {
  try {
    const saved = JSON.parse(await readFile(manifestPath, 'utf8'));
    const [inputs, outputs] = await Promise.all([
      snapshotTree(inputPaths, platRoot),
      snapshotTree([distDir], distDir, '.build-manifest.json'),
    ]);
    if (
      Array.isArray(saved.inputs) &&
      Array.isArray(saved.outputs) &&
      outputs.length > 0 &&
      JSON.stringify(inputs) === JSON.stringify(saved.inputs) &&
      JSON.stringify(outputs) === JSON.stringify(saved.outputs)
    ) {
      process.exit(0);
    }
  } catch {
    // Missing or unreadable manifest: rebuild.
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
const [inputs, outputs] = await Promise.all([
  snapshotTree(inputPaths, platRoot),
  snapshotTree([distDir], distDir, '.build-manifest.json'),
]);
await writeFile(manifestPath, JSON.stringify({ inputs, outputs }));
console.log('Built @caveman-ai/cloud (cvm) cleanly from platform/contracts');
