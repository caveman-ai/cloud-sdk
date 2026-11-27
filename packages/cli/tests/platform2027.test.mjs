import test, {describe} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {TEST_CONCURRENCY, limitSpawn} from './pool.mjs';

const cvmBin = resolve(import.meta.dirname, '..', 'bin', 'cvm.mjs');

function runCvm(args, env = {}) {
  return limitSpawn(() => new Promise((done, reject) => {
    const child = spawn(process.execPath, [cvmBin, ...args], {
      env: {...process.env, ...env},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', status => done({status, stdout, stderr}));
  }));
}

describe('platform2027', {concurrency: TEST_CONCURRENCY}, () => {

test('cvm skills list shows all standalone 30-second primitive skills', async () => {
  const res = await runCvm(['skills', 'list']);
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

test('cvm skills add installs a standalone skill into an isolated target directory', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cvm-skills-test-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const [buildRes, res] = await Promise.all([
    runCvm(['skills', 'add', 'build', '--dir', join(home, 'skills')]),
    runCvm(['skills', 'add', 'rooms', '--dir', join(home, 'skills')]),
  ]);
  assert.equal(buildRes.status, 0, buildRes.stderr);
  assert.ok(existsSync(join(home, 'skills', 'caveman-build', 'SKILL.md')));
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(join(home, 'skills', 'caveman-rooms', 'SKILL.md')));
});

test('cvm room, apps, listeners, workflows, pools help menus succeed without auth', async () => {
  await Promise.all(['room', 'apps', 'listeners', 'workflows', 'pools'].map(async (sub) => {
    const res = await runCvm([sub, '--help']);
    assert.equal(res.status, 0, `${sub} --help failed: ${res.stderr}`);
    assert.ok(res.stdout.trim().length > 0);
  }));
});

});
