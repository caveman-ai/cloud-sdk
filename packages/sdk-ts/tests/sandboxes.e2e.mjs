// End to end against a real control-api and relay: the Caveman sandbox test harness runs this
// with CAVE_SANDBOX_E2E_API, _RELAY and _KEY (a code:run key); a file goes in CAVE_SANDBOX_E2E_DIR (/tmp when
// unset), and CAVE_SANDBOX_E2E_PORT, when set, is a port in the sandbox that answers what it reads upper-cased.
// The quickstart's TypeScript snippet is the first test's body, between the quickstart markers.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SandboxCommand, Sandboxes, SandboxError, SandboxExecError, SandboxFileError} from '../dist/sandboxes.js';

const api = process.env.CAVE_SANDBOX_E2E_API, relay = process.env.CAVE_SANDBOX_E2E_RELAY, key = process.env.CAVE_SANDBOX_E2E_KEY;
const skip = api && key ? false : 'set CAVE_SANDBOX_E2E_API and CAVE_SANDBOX_E2E_KEY (the Caveman sandbox test harness runs it)';

test('a sandbox made, a command run in it, and the sandbox deleted', {skip: skip}, async () => {
  // quickstart:typescript
  const sandboxes = new Sandboxes({controlURL: api, relayURL: relay, apiKey: key});
  const box = await sandboxes.create({name: 'quickstart-ts'});
  await sandboxes.waitFor(box.id, 'running');
  const result = await sandboxes.run(box.id, ['sh', '-c', 'echo hello from the sandbox; echo careful >&2; exit 3']);
  // result: {exitCode: 3, stdout: 'hello from the sandbox\n', stderr: 'careful\n'}
  await sandboxes.delete(box.id);
  // quickstart:end
  assert.deepEqual(result, {exitCode: 3, stdout: 'hello from the sandbox\n', stderr: 'careful\n'});
});

test('the lifecycle: stdin, streamed output, a file, a port, the list, sleep, a command refused asleep, resume, delete', {skip: skip}, async () => {
  const sandboxes = new Sandboxes({controlURL: api, relayURL: relay, apiKey: key});
  const box = await sandboxes.create({name: 'e2e-ts', sleep_after_seconds: 0});
  assert.equal(box.bare, true);
  assert.equal(box.sleep_after_seconds, 0);
  await sandboxes.waitFor(box.id, 'running');
  const chunks = [];
  const code = await sandboxes.exec(box.id, ['cat'], {stdin: (async function* () { yield 'stdin '; yield new TextEncoder().encode('reaches it'); })(), stdout: chunk => { chunks.push(Buffer.from(chunk)); }});
  assert.equal(code, 0);
  assert.equal(Buffer.concat(chunks).toString(), 'stdin reaches it');
  // Quiet for longer than the relay's ping interval (the lab pings every second): the pings are answered.
  assert.deepEqual(await sandboxes.run(box.id, ['sh', '-c', 'sleep 3; echo still here']), {exitCode: 0, stdout: 'still here\n', stderr: ''});
  // A file written is read back, listed and removed.
  const dir = process.env.CAVE_SANDBOX_E2E_DIR || '/tmp', path = `${dir}/e2e-ts-${box.id}.txt`;
  const written = await sandboxes.writeFile(box.id, path, 'a file through the relay\n', {mode: 0o600});
  assert.deepEqual([written.size, written.mode], [25, 0o600]);
  assert.equal(new TextDecoder().decode(await sandboxes.readFile(box.id, path)), 'a file through the relay\n');
  assert.ok((await sandboxes.listFiles(box.id, dir)).some(f => `${dir}/${f.name}` === path));
  // A command's options: its environment and folder (the file is there); a signal ends it.
  const listed = await sandboxes.run(box.id, ['sh', '-c', 'echo "$GREETING"; ls'], {env: {GREETING: 'hello env'}, cwd: dir});
  assert.ok(listed.exitCode === 0 && listed.stdout.startsWith('hello env\n') && listed.stdout.includes(path.split('/').pop()), JSON.stringify(listed));
  const command = new SandboxCommand();
  command.sendSignal('INT');
  assert.equal(await sandboxes.exec(box.id, ['sleep', '30'], {control: command}), 130);
  await sandboxes.removeFile(box.id, path);
  await assert.rejects(sandboxes.readFile(box.id, path), error => error instanceof SandboxFileError && error.code === 'cave_code_computer_file_not_found');
  if (process.env.CAVE_SANDBOX_E2E_PORT) {
    const conn = await sandboxes.dialPort(box.id, Number(process.env.CAVE_SANDBOX_E2E_PORT));
    await conn.write('hello port');
    conn.closeWrite();
    const back = [];
    for await (const chunk of conn) back.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(back).toString(), 'HELLO PORT');
    await conn.closed;
  }
  assert.ok((await sandboxes.list()).computers.some(c => c.id === box.id));
  await sandboxes.sleep(box.id);
  await sandboxes.waitFor(box.id, 'suspended');
  await assert.rejects(sandboxes.run(box.id, ['true']), error => error instanceof SandboxExecError && error.code === 'cave_code_computer_not_running' && error.status === 409);
  await sandboxes.resume(box.id);
  await sandboxes.waitFor(box.id, 'running');
  assert.equal((await sandboxes.run(box.id, ['echo', 'awake'])).stdout, 'awake\n');
  await sandboxes.delete(box.id);
  assert.equal(await sandboxes.waitFor(box.id, 'deleted'), null);
  await assert.rejects(sandboxes.get(box.id), error => error instanceof SandboxError && error.code === 'cave_not_found');
  await assert.rejects(sandboxes.run(box.id, ['true']), error => error instanceof SandboxExecError && error.status === 404);
});

test('a snapshot: taken, listed, restored into its sandbox, made into a new sandbox, deleted', {skip: skip}, async () => {
  const sandboxes = new Sandboxes({controlURL: api, relayURL: relay, apiKey: key});
  const box = await sandboxes.create({name: 'e2e-ts-snapshots', sleep_after_seconds: 0});
  await sandboxes.waitFor(box.id, 'running');
  const taken = await sandboxes.snapshot(box.id, {name: 'e2e-ts'});
  assert.deepEqual([taken.state, taken.computer_id, taken.name], ['taking', box.id, 'e2e-ts']);
  const ready = await sandboxes.waitForSnapshot(box.id, taken.id, {intervalMs: 200, timeoutMs: 60000});
  assert.ok(ready.ready_at && ready.reason_code === null, JSON.stringify(ready));
  assert.ok((await sandboxes.listSnapshots(box.id)).snapshots.some(s => s.id === taken.id && s.state === 'ready'));
  assert.equal((await sandboxes.restore(box.id, taken.id)).restore.state, 'restoring');
  assert.equal((await sandboxes.waitForRestore(box.id, taken.id, {intervalMs: 200, timeoutMs: 60000})).restore.state, 'restored');
  const child = await sandboxes.fork(box.id, taken.id, {name: 'e2e-ts-fork', sleep_after_seconds: 0});
  assert.equal(child.bare, true);
  await sandboxes.waitFor(child.id, 'running');
  await sandboxes.delete(child.id);
  assert.equal((await sandboxes.deleteSnapshot(box.id, taken.id)).state, 'deleting');
  assert.ok(['deleting', 'deleted'].includes((await sandboxes.getSnapshot(box.id, taken.id)).state));
  // A deleted snapshot is made into no sandbox.
  await assert.rejects(sandboxes.waitForSnapshot(box.id, taken.id, {intervalMs: 200}), error => error.code === 'cave_snapshot_state');
  await assert.rejects(sandboxes.fork(box.id, taken.id), error => error instanceof SandboxError && error.code === 'cave_code_computer_snapshot_not_ready');
  await sandboxes.delete(box.id);
});

// The sandbox the lab made larger than its one host (CAVE_SANDBOX_E2E_ROOM): it says why it is not running in the
// vocabulary's sentence (public/sdk/parity/sandbox-reasons.json), never failed, and a wait for it goes on to its end.
const room = process.env.CAVE_SANDBOX_E2E_ROOM;
const roomSkip = api && key && room ? false : 'set CAVE_SANDBOX_E2E_API, CAVE_SANDBOX_E2E_KEY and CAVE_SANDBOX_E2E_ROOM (the Caveman sandbox test harness runs it)';

test('a sandbox the fleet has no room for says so, and a wait for it goes on', {skip: roomSkip}, async () => {
  const {readFile} = await import('node:fs/promises');
  const reasons = JSON.parse(await readFile(new URL('../../parity/sandbox-reasons.json', import.meta.url), 'utf8')).codes;
  const sandboxes = new Sandboxes({controlURL: api, relayURL: relay, apiKey: key});
  const box = await sandboxes.get(room);
  assert.equal(box.observed_reason, reasons.waiting_for_capacity.sentence);
  assert.notEqual(box.observed_state, 'failed');
  assert.equal(box.observed_reason_code, 'waiting_for_capacity');
  await assert.rejects(sandboxes.waitFor(room, 'running', {timeoutMs: 2000, intervalMs: 200}), error => error instanceof SandboxError && error.code === 'cave_timeout');
});
