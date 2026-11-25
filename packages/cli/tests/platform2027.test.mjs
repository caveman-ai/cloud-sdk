import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const cvmBin = resolve(import.meta.dirname, '..', 'bin', 'cvm.mjs');

function runCvm(args, env = {}) {
  return spawnSync(process.execPath, [cvmBin, ...args], {
    encoding: 'utf8',
    env: {...process.env, ...env},
  });
}

test('cvm skills list shows all standalone 30-second primitive skills', () => {
  const res = runCvm(['skills', 'list']);
  assert.equal(res.status, 0, res.stderr);
  for (const id of [
    'caveman-build',
    'caveman-sandbox',
    'caveman-drive',
    'caveman-rooms',
    'caveman-deploy',
    'caveman-apps',
    'caveman-listeners',
    'caveman-workflows',
  ]) {
    assert.match(res.stdout, new RegExp(id));
  }
});

test('cvm skills add installs a standalone skill into an isolated target directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'cvm-skills-test-'));
  const buildRes = runCvm(['skills', 'add', 'build', '--dir', join(home, 'skills')]);
  assert.equal(buildRes.status, 0, buildRes.stderr);
  assert.ok(existsSync(join(home, 'skills', 'caveman-build', 'SKILL.md')));
  const res = runCvm(['skills', 'add', 'rooms', '--dir', join(home, 'skills')]);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(join(home, 'skills', 'caveman-rooms', 'SKILL.md')));
});

test('cvm room, apps, listeners, workflows, pools help menus succeed without auth', () => {
  for (const sub of ['room', 'apps', 'listeners', 'workflows', 'pools']) {
    const res = runCvm([sub, '--help']);
    assert.equal(res.status, 0, `${sub} --help failed: ${res.stderr}`);
    assert.ok(res.stdout.trim().length > 0);
  }
});
