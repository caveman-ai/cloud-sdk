import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {CloudError, SandboxCommand, Sandboxes, SandboxError, SandboxExecError, SandboxFileError, SandboxStateError, SnapshotStateError, sandboxErrorCodes, sandboxRoutes, sandboxStream} from '../dist/sandboxes.js';
import {startFake, wire} from './sandbox-fake.mjs';

const client = (url, options = {}) => new Sandboxes({controlURL: url, apiKey: 'cave_live_wire', retryDelayMs: 0, ...options});
const id = wire.rest.create.answer.id;

test('the plain calls send the key, the route and the body, and read the recorded answers', async t => {
  const fake = await startFake();
  t.after(fake.close);
  const sandboxes = client(fake.url);
  const made = await sandboxes.create({name: 'wire', sleep_after_seconds: 0});
  assert.equal(made.id, id);
  assert.equal(made.bare, true);
  assert.equal(made.sleep_after_seconds, 0);
  // A create answers its idle pause too: none asked, never (0).
  assert.deepEqual(made.idle, {pause_after_seconds: 0});
  const got = await sandboxes.get(id);
  assert.equal(got.observed_state, 'running');
  // Get answers the sandbox's idle pause as its create did; a create that asked no lifetime or network answers neither.
  assert.deepEqual(got.idle, {pause_after_seconds: 0});
  assert.ok(!('expires_at' in made) && !('network' in made));
  const list = await sandboxes.list();
  assert.equal(list.cloud_computers, true);
  assert.deepEqual(list.computers.map(c => c.id), [id]);
  assert.equal((await sandboxes.list({mine: true})).computers.length, 1);
  assert.equal((await sandboxes.sleep(id)).desired_state, 'suspended');
  assert.equal((await sandboxes.resume(id)).desired_state, 'running');
  assert.equal((await sandboxes.delete(id)).desired_state, 'deleted');
  // A delete asked again answers the deleted sandbox, as the first did.
  assert.equal((await sandboxes.delete(id)).desired_state, 'deleted');
  for (const [call, code, status] of [
    [() => sandboxes.get(wire.rest.get_unknown.path.split('/').at(-1)), 'cave_not_found', 404],
    [() => sandboxes.create({size: 'huge'}), 'cave_bad_request', 400],
    [() => sandboxes.create({image: 'ubuntu'}), 'cave_bad_request', 400],
  ]) {
    await assert.rejects(call(), error => error instanceof SandboxError && error instanceof CloudError && error.code === code && error.status === status && error.message && error.requestId && !error.limitReached);
  }
  // An unknown field's refusal names every field the body takes, idle among them.
  await assert.rejects(sandboxes.create({image: 'ubuntu'}), error => error.message === 'The body is size, name, sleep_after_seconds, idle, lifetime_seconds and network, and nothing else.');
  assert.ok(sandboxErrorCodes.includes('cave_not_found'));
  assert.deepEqual(fake.state.errors, []);
  assert.deepEqual(fake.state.seen.slice(0, 2).map(s => [s.method, s.path, s.auth]), [['POST', '/api/v1/code/computers', 'Bearer cave_live_wire'], ['GET', `/api/v1/code/computers/${id}`, 'Bearer cave_live_wire']]);
});

test('with the switch off, a key is refused and a create says sandboxes are not offered', async t => {
  const fake = await startFake({rest: (req, res) => {
    const c = req.method === 'POST' ? wire.rest.off_create : wire.rest.off_list;
    res.writeHead(c.status, {'content-type': 'application/json'}).end(JSON.stringify(c.answer));
  }});
  t.after(fake.close);
  const sandboxes = client(fake.url);
  await assert.rejects(sandboxes.list(), {code: 'cave_api_key_route_forbidden', status: 403});
  await assert.rejects(sandboxes.create(), error => error.status === 405 && /computers\.api\.enabled/.test(error.message));
});

const status = {
  state: 'degraded', checked_at: '2026-11-19T12:00:05Z', last_round_at: '2026-11-19T12:00:00Z', interval_seconds: 60, stale_after_seconds: 300, window_seconds: 3600,
  probes: [
    {name: 'create', state: 'ok', last_success_at: '2026-11-19T12:00:00Z', attempts: 60, failures: 0, p50_ms: 210, p95_ms: 480},
    {name: 'running', state: 'ok', last_success_at: '2026-11-19T12:00:00Z', attempts: 60, failures: 0, p50_ms: 800, p95_ms: 1200},
    {name: 'exec_open', state: 'degraded', last_success_at: '2026-11-19T12:00:00Z', attempts: 60, failures: 2, p50_ms: 50, p95_ms: 90},
    {name: 'command', state: 'ok', last_success_at: '2026-11-19T12:00:00Z', attempts: 58, failures: 0, p50_ms: 100, p95_ms: 140},
    {name: 'delete', state: 'unknown', last_success_at: null, attempts: 0, failures: 0, p50_ms: null, p95_ms: null},
  ],
  create_to_command: {state: 'ok', threshold_ms: 2000, p95_ms: 1400},
};

test('status reads whether sandboxes work right now; an install that does not serve it answers 404', async t => {
  let served = true;
  const seen = [];
  const fake = await startFake({rest: (req, res) => {
    seen.push([req.method, req.url]);
    if (served) res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(status));
    else res.writeHead(404, {'content-type': 'application/json'}).end(JSON.stringify({error: {type: 'cave_gateway_error', code: 'cave_not_found', message: 'Not found.', request_id: 'req_1'}}));
  }});
  t.after(fake.close);
  const sandboxes = client(fake.url);
  assert.deepEqual(await sandboxes.status(), status);
  assert.deepEqual(seen, [['GET', '/api/v1/status/sandboxes']]);
  served = false;
  await assert.rejects(sandboxes.status(), {code: 'cave_not_found', status: 404});
});

test('a command streams its output on its channels and answers its exit code; stdin reaches it; large output arrives whole', async t => {
  const fake = await startFake();
  t.after(fake.close);
  const sandboxes = client(fake.url);
  const out = await sandboxes.run(id, ['sh', '-c', 'echo hello from the sandbox; echo careful >&2; exit 7']);
  assert.deepEqual(out, {exitCode: 7, stdout: 'hello from the sandbox\n', stderr: 'careful\n'});
  assert.deepEqual(await sandboxes.run(id, ['cat'], {stdin: 'stdin reaches it'}), {exitCode: 0, stdout: 'stdin reaches it', stderr: ''});
  const pieces = [];
  const code = await sandboxes.exec(id, ['sh', '-c', "head -c 40000 /dev/zero | tr '\\0' a"], {stdout: async chunk => { pieces.push(chunk.length); await new Promise(r => setTimeout(r, 5)); }});
  assert.equal(code, 0);
  // Each piece as the sandbox sent it (the recording's frames), none past max_output, 40000 bytes in all.
  const sent = wire.exec.large.server.filter(m => m.text === undefined).map(m => (m.base64 ? Buffer.from(m.base64, 'base64') : Buffer.from(m.data ?? '')).length);
  assert.deepEqual(pieces, sent);
  assert.ok(pieces.every(n => n <= 32768) && pieces.reduce((a, b) => a + b, 0) === 40000);
  assert.deepEqual(fake.state.errors, []);
});

test('what ends a stream without an exit is a SandboxExecError with the stream\'s code', async t => {
  const fake = await startFake();
  t.after(fake.close);
  const sandboxes = client(fake.url);
  const refusedWith = async (setup, check) => {
    Object.assign(fake.state, {replay: '', refuse: '', closeRaw: null}, setup);
    await assert.rejects(sandboxes.run(id, ['true']), error => error instanceof SandboxExecError && check(error));
  };
  // A sandbox that takes no options closes a start that asks for one with unsupported.
  await refusedWith({replay: 'stdin', closeRaw: 4405}, e => e.code === 'cave_code_computer_unsupported' && e.closeCode === 4405);
  await refusedWith({refuse: 'asleep'}, e => e.code === 'cave_code_computer_not_running' && e.status === 409);
  await refusedWith({refuse: 'unknown'}, e => e.code === 'cave_not_found' && e.status === 404);
  await refusedWith({refuse: 'switched_off'}, e => e.code === 'cave_not_found' && /computers\.api\.enabled/.test(e.message));
  for (const [close, code] of [[4401, 'cave_unauthorized'], [4404, 'cave_code_computer_stream_ended'], [4410, 'cave_code_computer_stopped'], [1001, 'cave_code_computer_stream_ended']]) {
    await refusedWith({replay: 'stdin', closeRaw: close}, e => e.code === code && e.closeCode === close);
  }
  await assert.rejects(sandboxes.exec(id, []), {code: 'cave_bad_request'});
  assert.deepEqual(fake.state.errors, []);
});

test('a command\'s options reach it, a signal ends it, and what the sandbox did not act on comes back', async t => {
  const fake = await startFake();
  t.after(fake.close);
  const sandboxes = client(fake.url);
  // The recordings' answers, as the lab's sandbox gave them.
  const said = name => wire.exec[name].server.filter(m => m.channel === 1).map(m => m.data).join('');
  assert.deepEqual(await sandboxes.run(id, ['pwd'], {cwd: '/tmp'}), {exitCode: 0, stdout: said('start_with_cwd'), stderr: ''});
  assert.deepEqual(await sandboxes.run(id, ['sh', '-c', 'echo "$GREETING"'], {env: {GREETING: 'hello env'}}), {exitCode: 0, stdout: 'hello env\n', stderr: ''});
  // A signal asked before the stream opens goes once it does: the command ends on it (128 + SIGINT).
  const command = new SandboxCommand();
  command.sendSignal('SIGINT');
  assert.equal(await sandboxes.exec(id, ['sleep', '5'], {control: command}), 130);
  // A resize of a command with no terminal is refused on its own; the command runs to its exit.
  const refusals = [];
  const resized = new SandboxCommand();
  resized.resize(80, 24);
  assert.equal(await sandboxes.exec(id, ['sh', '-c', 'sleep 1'], {control: resized, onRefused: r => { refusals.push(r); }}), 0);
  assert.deepEqual(refusals, [{of: 'resize', code: 'cave_code_computer_unsupported', message: 'the command has no terminal to resize'}]);
  // What the sandbox would refuse is refused here, before a stream opens.
  const opened = fake.state.seen.length;
  assert.throws(() => command.sendSignal('BOGUS'), {code: 'cave_bad_request'});
  assert.throws(() => command.resize(0, 24), {code: 'cave_bad_request'});
  assert.throws(() => command.resize(80, sandboxStream.options.max_term_size + 1), {code: 'cave_bad_request'});
  for (const options of [{cols: 80, rows: 24}, {tty: true, cols: 80}, {cwd: 'relative'}, {env: {'A=B': 'x'}}, {env: {'': 'x'}}, {env: {A: 'a\0b'}},
    {env: Object.fromEntries(Array.from({length: sandboxStream.options.max_env + 1}, (_, i) => [`V${i}`, 'x']))}]) {
    await assert.rejects(sandboxes.exec(id, ['true'], options), {code: 'cave_bad_request'}, JSON.stringify(options).slice(0, 60));
  }
  assert.equal(fake.state.seen.length, opened);
  assert.deepEqual(fake.state.errors, []);
});

test('a stream whose host is restarting is opened again, within its bound, only when nothing came back and stdin can be sent again', async t => {
  const fake = await startFake();
  t.after(fake.close);
  const sandboxes = client(fake.url);
  const opens = () => fake.state.seen.filter(s => s.upgrade).length;
  // Twice, then the command runs: three opens, the answer of the third.
  Object.assign(fake.state, {hostDown: 2, retryAfter: 0});
  assert.deepEqual(await sandboxes.run(id, ['cat'], {stdin: 'stdin reaches it'}), {exitCode: 0, stdout: 'stdin reaches it', stderr: ''});
  assert.equal(opens(), 3);
  // Five opens at most, then the code to the caller.
  let before = opens();
  Object.assign(fake.state, {hostDown: 9});
  await assert.rejects(sandboxes.run(id, ['true']), e => e instanceof SandboxExecError && e.code === 'cave_code_computer_host_unreachable' && e.retryAfter === 0 && e.closeCode === undefined);
  assert.equal(opens() - before, 5);
  // An iterable stdin is read once: never opened again.
  before = opens();
  Object.assign(fake.state, {hostDown: 1});
  await assert.rejects(sandboxes.run(id, ['cat'], {stdin: (async function* () { yield 'once'; })()}), {code: 'cave_code_computer_host_unreachable'});
  assert.equal(opens() - before, 1);
  // Output came first: the command had started, never a second run.
  before = opens();
  Object.assign(fake.state, {hostDown: 1, hostDownOutput: true});
  await assert.rejects(sandboxes.run(id, ['true']), {code: 'cave_code_computer_host_unreachable'});
  assert.equal(opens() - before, 1);
  // A wait past the bound (the far end's retry_after, 30 s here): not opened again.
  before = opens();
  Object.assign(fake.state, {hostDown: 1, hostDownOutput: false, retryAfter: 30});
  await assert.rejects(sandboxes.run(id, ['true']), {code: 'cave_code_computer_host_unreachable'});
  assert.equal(opens() - before, 1);
  Object.assign(fake.state, {hostDown: 0, retryAfter: 0});
  assert.deepEqual(fake.state.errors, []);
});

test('aborting ends the stream, and with it the command', async t => {
  let closed;
  const ended = new Promise(resolve => { closed = resolve; });
  const server = createServer();
  server.on('upgrade', async (req, socket) => {
    const {createHash} = await import('node:crypto');
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${sandboxStream.subprotocol}\r\n\r\n`);
    socket.on('end', () => { closed(); socket.destroy(); });
    socket.resume();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const sandboxes = client(`http://127.0.0.1:${server.address().port}`);
  await assert.rejects(sandboxes.exec(id, ['sleep', '60'], {signal: AbortSignal.timeout(200)}), {name: 'TimeoutError'});
  await ended;
});

test('an abort that already happened opens no stream; a stdin that fails or never ends does not hold the command', async t => {
  const fake = await startFake();
  t.after(fake.close);
  const sandboxes = client(fake.url);
  await assert.rejects(sandboxes.exec(id, ['true'], {signal: AbortSignal.abort()}), {name: 'AbortError'});
  assert.equal(fake.state.seen.filter(s => s.upgrade).length, 0);
  // A stdin that fails after its first piece: the command's input ends there.
  const failing = (async function* () { yield 'stdin reaches it'; throw new Error('the pipe broke'); })();
  assert.deepEqual(await sandboxes.run(id, ['cat'], {stdin: failing}), {exitCode: 0, stdout: 'stdin reaches it', stderr: ''});
  // A stdin that never yields: the command's exit ends the stream, and the stdin is let go.
  let released = false;
  const endless = {[Symbol.asyncIterator]: () => ({next: () => new Promise(() => {}), return: async () => { released = true; return {done: true, value: undefined}; }})};
  fake.state.replay = 'output';
  assert.equal((await sandboxes.run(id, ['sh', '-c', 'echo hello from the sandbox; echo careful >&2; exit 7'], {stdin: endless})).exitCode, 7);
  assert.equal(released, true);
  assert.deepEqual(fake.state.errors, []);
});

test('a socket that breaks is a SandboxExecError cave_code_computer_stream_ended', async t => {
  const server = createServer();
  server.on('upgrade', async (req, socket) => {
    const {createHash} = await import('node:crypto');
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${sandboxStream.subprotocol}\r\n\r\n`);
    socket.once('data', () => socket.resetAndDestroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await assert.rejects(client(`http://127.0.0.1:${server.address().port}`).run(id, ['true']), error => error instanceof SandboxExecError && error.code === 'cave_code_computer_stream_ended');
});

test('a GET is asked again after a 503, any call after a 429, a delete after busy; a create after a 503 is not', async t => {
  const counts = {GET: 0, POST: 0, DELETE: 0, busy: 0};
  const envelope = code => JSON.stringify({error: {type: 'cave_gateway_error', code, message: 'Ask again.', request_id: 'r'}});
  const fake = await startFake({rest: (req, res, body) => {
    const n = ++counts[req.method];
    if (req.method === 'GET') return n <= 2 ? res.writeHead(503).end(envelope('cave_unavailable')) : res.end(JSON.stringify(wire.rest.get.answer));
    if (req.method === 'DELETE') return n === 1 ? res.writeHead(409).end(envelope('cave_code_computer_busy')) : res.end(JSON.stringify(wire.rest.delete.answer));
    if (body.includes('busy')) { counts.busy++; return res.writeHead(429, {'retry-after': '0'}).end(envelope('cave_rate_limited')); }
    return res.writeHead(503).end(envelope('cave_unavailable'));
  }});
  t.after(fake.close);
  const sandboxes = client(fake.url);
  assert.equal((await sandboxes.get(id)).id, id);
  assert.equal(counts.GET, 3);
  await assert.rejects(sandboxes.create(), {status: 503});
  assert.equal(counts.POST, 1);
  assert.equal((await sandboxes.delete(id)).desired_state, 'deleted');
  assert.equal(counts.DELETE, 2);
  await assert.rejects(sandboxes.create({name: 'busy'}), {status: 429});
  assert.equal(counts.busy, 4);
});

test('a Retry-After past the client\'s longest wait is thrown at once with its seconds; one within it is waited for', async t => {
  // An organization's start ceiling names up to a day: past 30 s the caller decides, with the seconds on the error.
  let asks = 0, after = '3600';
  const fake = await startFake({rest: (req, res) => {
    asks++;
    if (after === '2' && asks > 1) return res.writeHead(201).end(JSON.stringify(wire.rest.create.answer));
    res.writeHead(429, {'retry-after': after}).end(JSON.stringify({error: {type: 'cave_gateway_error', code: 'cave_code_computer_start_ceiling', message: 'Try again in about 60 minutes.', request_id: 'r'}}));
  }});
  t.after(fake.close);
  const sandboxes = new Sandboxes({controlURL: fake.url, apiKey: 'cave_live_wire'});
  const began = Date.now();
  await assert.rejects(sandboxes.create(), error => error instanceof SandboxError && error.status === 429
    && error.code === 'cave_code_computer_start_ceiling' && error.retryAfter === 3600);
  assert.ok(Date.now() - began < 1000, `answered after ${Date.now() - began} ms`);
  assert.equal(asks, 1);
  asks = 0; after = '2';
  const asked = Date.now();
  assert.equal((await sandboxes.create()).id, id);
  assert.equal(asks, 2);
  assert.ok(Date.now() - asked >= 1900, `asked again after ${Date.now() - asked} ms; want the 2 s it named`);
});

test('waiting reads until the state, and stops on a failure or a sandbox asked to be something else', async t => {
  let states = ['pending', 'starting', 'running'], desired = 'running', reason, code;
  const fake = await startFake({rest: (req, res) => {
    const c = {...wire.rest.get.answer, observed_state: states[0], desired_state: desired, ...(reason ? {observed_reason: reason} : {}),
      ...(code ? {observed_reason_code: code} : {})};
    if (states.length > 1) states = states.slice(1);
    res.end(JSON.stringify(c));
  }});
  t.after(fake.close);
  const sandboxes = client(fake.url);
  assert.equal((await sandboxes.waitFor(id, 'running', {intervalMs: 10})).observed_state, 'running');
  states = ['starting', 'failed']; reason = 'image missing';
  await assert.rejects(sandboxes.waitFor(id, 'running', {intervalMs: 10}), error => error instanceof SandboxStateError && /image missing/.test(error.message));
  states = ['starting']; desired = 'suspended'; reason = undefined;
  await assert.rejects(sandboxes.waitFor(id, 'running', {intervalMs: 10}), error => error instanceof SandboxStateError && error.sandbox.desired_state === 'suspended');
  // A reason that passes by itself: the wait goes on, even while the sandbox reads failed (its host restarting).
  desired = 'running'; states = ['failed', 'failed', 'running']; code = 'host_unavailable'; reason = 'Its host is restarting or not answering just now; Cloud tries again in a moment.';
  assert.equal((await sandboxes.waitFor(id, 'running', {intervalMs: 10})).observed_state, 'running');
  // One that needs the caller ends it, whatever the state.
  states = ['stopped']; code = 'stopped_by_host'; reason = 'Its host restarted or ran short of memory, so it was stopped; its disk is kept. Start it again.';
  await assert.rejects(sandboxes.waitFor(id, 'running', {intervalMs: 10}), error => error instanceof SandboxStateError && /is stopped: Its host restarted/.test(error.message));
  // Cloud's own ends it once the sandbox has failed, and a code this client does not know reads as none.
  for (const unknown of ['internal_error', 'a_later_code']) {
    states = ['starting', 'starting', 'failed']; code = unknown; reason = 'went wrong';
    await assert.rejects(sandboxes.waitFor(id, 'running', {intervalMs: 10}), error => error instanceof SandboxStateError && /failed: went wrong/.test(error.message));
    assert.deepEqual(states, ['failed']);
  }
});

test('the API holds the read until the state: one request with wait_for and timeout, then its Cave-Wait decides', async t => {
  const asked = [];
  let answers = [];
  const fake = await startFake({rest: (req, res) => {
    const url = new URL(req.url, 'http://fake');
    asked.push(url.search);
    const [observed, wait, after = 0, code] = answers.length > 1 ? answers.shift() : answers[0];
    const c = {...wire.rest.get.answer, observed_state: observed, ...(code ? {observed_reason_code: code} : {})};
    setTimeout(() => res.writeHead(200, {'content-type': 'application/json', ...(wait ? {'cave-wait': wait} : {})}).end(JSON.stringify(c)), after);
  }});
  t.after(fake.close);
  const sandboxes = client(fake.url);
  // Held until it runs: one request, as long as the wait (at most the API's minute).
  answers = [['running', 'satisfied', 300]];
  assert.equal((await sandboxes.waitFor(id, 'running')).observed_state, 'running');
  assert.deepEqual(asked.splice(0), ['?wait_for=running&timeout=60']);
  answers = [['running', 'satisfied']];
  await sandboxes.waitFor(id, 'running', {timeoutMs: 3500});
  assert.deepEqual(asked.splice(0), ['?wait_for=running&timeout=3']);
  // A held read that timed out is asked again at once; one the API says cannot end there ends the wait.
  answers = [['starting', 'timeout', 1100], ['running', 'satisfied']];
  assert.equal((await sandboxes.waitFor(id, 'running', {intervalMs: 60000})).observed_state, 'running');
  assert.equal(asked.splice(0).length, 2);
  answers = [['starting', 'unreachable']];
  await assert.rejects(sandboxes.waitFor(id, 'running'), error => error instanceof SandboxStateError);
  assert.equal(asked.splice(0).length, 1);
  // The API's verdict decides, by the same reason codes: a failed sandbox whose host is restarting, which it held
  // and answered timeout, is waited on; so is one it answered timeout with a code that would end a client's own wait.
  answers = [['failed', 'timeout', 1100, 'host_unavailable'], ['running', 'satisfied']];
  assert.equal((await sandboxes.waitFor(id, 'running', {intervalMs: 60000})).observed_state, 'running');
  assert.equal(asked.splice(0).length, 2);
  answers = [['failed', 'unreachable', 0, 'out_of_memory']];
  await assert.rejects(sandboxes.waitFor(id, 'running'), error => error instanceof SandboxStateError && error.sandbox.observed_reason_code === 'out_of_memory');
  asked.splice(0);
  // A Caveman Cloud that answers no Cave-Wait does not wait: polled from then on, never asked to wait again.
  answers = [['pending'], ['starting'], ['running']];
  assert.equal((await sandboxes.waitFor(id, 'running', {intervalMs: 10})).observed_state, 'running');
  assert.deepEqual(asked.splice(0), ['?wait_for=running&timeout=60', '', '']);
});

test('at the API\'s cap on one caller\'s waits, the read is a plain one', async t => {
  const asked = [];
  const fake = await startFake({rest: (req, res) => {
    asked.push(new URL(req.url, 'http://fake').search);
    if (req.url.includes('wait_for')) return res.writeHead(429, {'retry-after': '0', 'content-type': 'application/json'})
      .end(JSON.stringify({error: {type: 'cave_gateway_error', code: 'cave_code_computer_waits_limit', message: 'As many waits as it may.', request_id: 'r'}}));
    res.end(JSON.stringify(wire.rest.get.answer));
  }});
  t.after(fake.close);
  assert.equal((await client(fake.url).waitFor(id, 'running')).observed_state, 'running');
  assert.deepEqual(asked, ['?wait_for=running&timeout=60', '?wait_for=running&timeout=60', '?wait_for=running&timeout=60', '?wait_for=running&timeout=60', '']);
});

test('the client refuses what it cannot use', () => {
  for (const options of [{controlURL: 'http://cloud.example', apiKey: 'k'}, {controlURL: 'https://cloud.example/api', apiKey: 'k'}, {controlURL: 'https://u:p@cloud.example', apiKey: 'k'},
    {controlURL: 'https://cloud.example', apiKey: ' '}, {controlURL: 'https://cloud.example', relayURL: 'http://relay.example', apiKey: 'k'}]) {
    assert.throws(() => new Sandboxes(options), CloudError);
  }
});

test('a sandbox\'s files: read, written, listed, described, made, removed and renamed, each on its own stream', async t => {
  const fake = await startFake();
  t.after(fake.close);
  const sandboxes = client(fake.url);
  fake.state.files = new Map([['/', {dir: true}], ['/w', {dir: true}], ['/w/hello.txt', {data: Buffer.from('hello, sandbox\n')}]]);
  assert.equal(new TextDecoder().decode(await sandboxes.readFile(id, '/w/hello.txt')), 'hello, sandbox\n');
  const pieces = [];
  const described = await sandboxes.streamFile(id, '/w/hello.txt', chunk => { pieces.push(Buffer.from(chunk)); });
  assert.deepEqual([pieces.length > 1, Buffer.concat(pieces).toString(), described.size, described.type], [true, 'hello, sandbox\n', 15, 'file']);
  const written = await sandboxes.writeFile(id, '/w/new.bin', (async function* () { yield 'ab'; yield new Uint8Array([99]); })(), {mode: 0o600, atomic: true});
  assert.deepEqual([written.name, written.size, written.mode], ['new.bin', 3, 0o600]);
  assert.deepEqual(fake.state.files.get('/w/new.bin').data, Buffer.from('abc'));
  assert.deepEqual((await sandboxes.listFiles(id, '/w')).map(f => f.name).sort(), ['hello.txt', 'new.bin']);
  assert.equal((await sandboxes.statFile(id, '/w')).type, 'dir');
  await sandboxes.makeDir(id, '/w/sub', {parents: true});
  await sandboxes.renameFile(id, '/w/new.bin', '/w/sub/new.bin');
  await sandboxes.removeFile(id, '/w/sub', {all: true});
  assert.deepEqual([...fake.state.files.keys()].sort(), ['/', '/w', '/w/hello.txt']);
  assert.deepEqual(fake.state.fileOps.map(o => o.op), ['read', 'read', 'write', 'list', 'stat', 'mkdir', 'rename', 'remove']);
  assert.deepEqual(fake.state.fileOps[2], {type: 'files', op: 'write', path: '/w/new.bin', mode: 0o600, atomic: true});
  assert.deepEqual(fake.state.fileOps[5], {type: 'files', op: 'mkdir', path: '/w/sub', parents: true});
  // What the file system refused is a SandboxFileError with its code and the system's words.
  await assert.rejects(sandboxes.readFile(id, '/w/missing'), error => error instanceof SandboxFileError && error instanceof SandboxExecError
    && error.code === 'cave_code_computer_file_not_found' && /missing: no such file/.test(error.message));
  await assert.rejects(sandboxes.makeDir(id, '/w'), error => error instanceof SandboxFileError && error.code === 'cave_code_computer_file_exists');
  // A path the wire refuses never opens a stream.
  const opened = fake.state.seen.length;
  for (const bad of ['w/x', '', '/w/\0']) await assert.rejects(sandboxes.statFile(id, bad), error => error instanceof SandboxFileError && error.code === 'cave_bad_request');
  assert.equal(fake.state.seen.length, opened);
  assert.ok(fake.state.seen.every(s => !s.upgrade || s.path === `/relay/v1/computers/${id}/files`));
  assert.deepEqual(fake.state.errors, []);
});

test('a file stream whose host is restarting is opened again while its data can be sent again, never after an answer came', async t => {
  const fake = await startFake();
  t.after(fake.close);
  const sandboxes = client(fake.url);
  const opens = () => fake.state.seen.filter(s => s.upgrade).length;
  fake.state.hostDown = 2;
  await sandboxes.writeFile(id, '/again.txt', 'text is sent again');
  assert.equal(opens(), 3);
  assert.equal(new TextDecoder().decode(await sandboxes.readFile(id, '/again.txt')), 'text is sent again');
  // An iterable is read once: not opened again.
  fake.state.hostDown = 1;
  await assert.rejects(sandboxes.writeFile(id, '/once.txt', (async function* () { yield 'once'; })()), error => error.code === 'cave_code_computer_host_unreachable');
  assert.equal(opens(), 5);
  assert.deepEqual(fake.state.errors, []);
});

test('a port of a sandbox: bytes both ways, a half close from each side, and nothing listening refused', async t => {
  const fake = await startFake();
  t.after(fake.close);
  const sandboxes = client(fake.url);
  const conn = await sandboxes.dialPort(id, 8080);
  await conn.write('ping ');
  await conn.write(new TextEncoder().encode('pong'));
  conn.closeWrite();
  const got = [];
  for await (const chunk of conn) got.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(got).toString(), 'PING PONG');
  await conn.closed;
  assert.deepEqual(fake.state.dialed, ['8080']);
  fake.state.portRefused = true;
  const refused = await sandboxes.dialPort(id, 5432);
  await assert.rejects((async () => { for await (const _ of refused) { /* nothing comes */ } })(), error => error instanceof SandboxFileError && error.code === 'cave_code_computer_port_refused');
  await assert.rejects(refused.closed, error => error.code === 'cave_code_computer_port_refused');
  for (const bad of [0, 65536, 1.5]) await assert.rejects(sandboxes.dialPort(id, bad), error => error.code === 'cave_bad_request');
  assert.deepEqual(fake.state.errors, []);
});

// The recorded snapshot of the recorded sandbox, and its sandbox (the lab's: wire.rest.snapshot).
const snap = wire.rest.snapshot.answer;
const snapBox = snap.computer_id;

test('a sandbox\'s snapshots: taken, read, listed, restored, forked and deleted, as recorded', async t => {
  const fake = await startFake();
  t.after(fake.close);
  const sandboxes = client(fake.url);
  const taken = await sandboxes.snapshot(snapBox, {name: 'wire'});
  assert.deepEqual(taken, snap);
  assert.equal(taken.state, 'taking');
  const ready = await sandboxes.getSnapshot(snapBox, snap.id);
  assert.deepEqual([ready.state, ready.reason_code, ready.restore.state], ['ready', null, 'none']);
  assert.deepEqual((await sandboxes.listSnapshots(snapBox)).snapshots.map(s => [s.id, s.state]), [[snap.id, 'ready']]);
  assert.equal((await sandboxes.restore(snapBox, snap.id)).restore.state, 'restoring');
  assert.equal((await sandboxes.getSnapshot(snapBox, snap.id)).restore.state, 'restored');
  const child = await sandboxes.fork(snapBox, snap.id, {name: 'wire-fork', sleep_after_seconds: 0});
  assert.deepEqual([child.id, child.bare, child.name, child.desired_state], [wire.rest.fork.answer.id, true, 'wire-fork', 'running']);
  assert.notEqual(child.id, snapBox);
  assert.equal((await sandboxes.deleteSnapshot(snapBox, snap.id)).state, 'deleting');
  // A delete asked again answers the snapshot as it is.
  assert.equal((await sandboxes.deleteSnapshot(snapBox, snap.id)).state, 'deleted');
  for (const [call, code, status] of [
    [() => sandboxes.getSnapshot(snapBox, wire.rest.get_snapshot_unknown.path.split('/').at(-1)), 'cave_not_found', 404],
    [() => sandboxes.snapshot(snapBox, {computer_id: snapBox}), 'cave_bad_request', 400],
    [() => sandboxes.fork(snapBox, snap.id), 'cave_code_computer_snapshot_not_ready', 409],
  ]) {
    await assert.rejects(call(), error => error instanceof SandboxError && error.code === code && error.status === status && Boolean(error.message && error.requestId));
  }
  assert.ok(sandboxErrorCodes.includes('cave_code_computer_snapshot_not_ready'));
  assert.deepEqual(fake.state.errors, []);
  const base = `/api/v1/code/computers/${snapBox}/snapshots`;
  assert.deepEqual(fake.state.seen.slice(0, 8).map(s => [s.method, s.path]), [
    ['POST', base], ['GET', `${base}/${snap.id}`], ['GET', base], ['POST', `${base}/${snap.id}/restore`], ['GET', `${base}/${snap.id}`],
    ['POST', `${base}/${snap.id}/fork`], ['DELETE', `${base}/${snap.id}`], ['DELETE', `${base}/${snap.id}`]]);
  assert.ok(fake.state.seen.every(s => s.auth === 'Bearer cave_live_wire'));
});

test('a snapshot\'s delete is asked again after a 503 (x-idempotent); its take, restore and fork are not', async t => {
  const counts = {};
  const envelope = code => JSON.stringify({error: {type: 'cave_gateway_error', code, message: 'Ask again.', request_id: 'r'}});
  const fake = await startFake({rest: (req, res) => {
    const key = req.method + ' ' + req.url.split('/').at(-1);
    const n = counts[key] = (counts[key] ?? 0) + 1;
    if (req.method === 'DELETE' && n > 1) return res.end(JSON.stringify(wire.rest.delete_snapshot.answer));
    res.writeHead(503).end(envelope('cave_unavailable'));
  }});
  t.after(fake.close);
  const sandboxes = client(fake.url);
  assert.equal((await sandboxes.deleteSnapshot(snapBox, snap.id)).state, 'deleting');
  assert.equal(counts[`DELETE ${snap.id}`], 2);
  assert.deepEqual([sandboxRoutes.deleteSnapshot.safe, sandboxRoutes.snapshot.safe, sandboxRoutes.restore.safe, sandboxRoutes.fork.safe], [true, false, false, false]);
  await assert.rejects(sandboxes.snapshot(snapBox), {status: 503});
  await assert.rejects(sandboxes.restore(snapBox, snap.id), {status: 503});
  await assert.rejects(sandboxes.fork(snapBox, snap.id), {status: 503});
  assert.deepEqual([counts['POST snapshots'], counts['POST restore'], counts['POST fork']], [1, 1, 1]);
});

test('waiting for a snapshot reads it until it is taken; a failed take, a delete and the timeout end the wait', async t => {
  let states = [], restore = 'none', reason = '', code = null, restoreReason = '', restoreCode = null;
  const fake = await startFake({rest: (req, res) => {
    const s = {...wire.rest.get_snapshot.answer, state: states[0], reason, reason_code: code,
      restore: {...wire.rest.get_snapshot.answer.restore, state: restore, reason: restoreReason, reason_code: restoreCode}};
    if (states.length > 1) states = states.slice(1);
    res.end(JSON.stringify(s));
  }});
  t.after(fake.close);
  const sandboxes = client(fake.url);
  states = ['taking', 'taking', 'ready'];
  assert.equal((await sandboxes.waitForSnapshot(snapBox, snap.id, {intervalMs: 10})).state, 'ready');
  assert.equal(fake.state.seen.length, 3);
  states = ['taking', 'failed']; code = 'computer_not_placed'; reason = 'The sandbox has no disk on any host right now.';
  await assert.rejects(sandboxes.waitForSnapshot(snapBox, snap.id, {intervalMs: 10}), error => error instanceof SnapshotStateError && error instanceof CloudError
    && error.code === 'cave_snapshot_state' && error.snapshot.reason_code === 'computer_not_placed' && /is failed: The sandbox has no disk/.test(error.message));
  for (const gone of ['deleting', 'deleted']) {
    states = [gone]; code = null; reason = '';
    await assert.rejects(sandboxes.waitForSnapshot(snapBox, snap.id, {intervalMs: 10}), error => error instanceof SnapshotStateError && error.snapshot.state === gone);
  }
  states = ['taking'];
  await assert.rejects(sandboxes.waitForSnapshot(snapBox, snap.id, {intervalMs: 10, timeoutMs: 60}), error => error instanceof SandboxError && error.code === 'cave_timeout');
  await assert.rejects(sandboxes.waitForSnapshot(snapBox, snap.id, {signal: AbortSignal.timeout(50)}), {name: 'TimeoutError'});

  // A restore: restoring until restored; failed, or none asked, ends it.
  states = ['ready'];
  let restores = ['restoring', 'restoring', 'restored'];
  const step = () => { restore = restores[0]; if (restores.length > 1) restores = restores.slice(1); };
  const stepping = await startFake({rest: (req, res) => {
    step();
    res.end(JSON.stringify({...wire.rest.get_snapshot.answer, restore: {...wire.rest.get_snapshot.answer.restore, state: restore, reason: restoreReason, reason_code: restoreCode}}));
  }});
  t.after(stepping.close);
  const restoring = client(stepping.url);
  assert.equal((await restoring.waitForRestore(snapBox, snap.id, {intervalMs: 10})).restore.state, 'restored');
  restores = ['restoring', 'failed']; restoreCode = 'snapshot_elsewhere'; restoreReason = 'This snapshot is kept on another host than the sandbox runs on now.';
  await assert.rejects(restoring.waitForRestore(snapBox, snap.id, {intervalMs: 10}), error => error instanceof SnapshotStateError
    && error.snapshot.restore.reason_code === 'snapshot_elsewhere' && /restore of snapshot .* failed: This snapshot is kept/.test(error.message));
  restores = ['none']; restoreCode = null; restoreReason = '';
  await assert.rejects(restoring.waitForRestore(snapBox, snap.id, {intervalMs: 10}), error => error instanceof SnapshotStateError && /no restore asked/.test(error.message));
});

// A token and a link for port 3000, as the API answers POST .../ports/3000/token (CodeComputerPortToken).
const portURL = `https://3000-${id}.sandbox.example.dev`;
const portToken = {
  computer_id: id, port: 3000, visibility: 'private', url: portURL, link: `${portURL}/_caveman/open?token=cvp_link`,
  link_expires_at: '2026-11-20T12:05:00Z', token: 'cvp_access', header: 'Caveman-Port-Token', expires_at: '2026-11-20T13:00:00Z',
};

test('url answers a port at its own URL: its link, its token and the header a program sends', async t => {
  const fake = await startFake({rest: (req, res, body) => {
    const json = (status, answer) => res.writeHead(status, {'content-type': 'application/json'}).end(JSON.stringify(answer));
    if (req.method === 'PUT' && req.url === `/api/v1/code/computers/${id}/ports/3000`) return json(200, {port: 3000, visibility: JSON.parse(body).visibility, url: portURL});
    if (req.method === 'POST' && req.url === `/api/v1/code/computers/${id}/ports/3000/token`) {
      const visibility = fake.state.seen.some(s => s.method === 'PUT') ? 'public' : 'private';
      return json(200, {...portToken, visibility, expires_at: JSON.parse(body).ttl_seconds === 600 ? '2026-11-20T12:10:00Z' : portToken.expires_at});
    }
    json(404, {error: {type: 'cave_gateway_error', code: 'cave_not_found', message: 'Not found.', request_id: 'req_port'}});
  }});
  t.after(fake.close);
  const sandboxes = client(fake.url);
  const got = await sandboxes.url(id, 3000);
  assert.deepEqual(got, {url: portURL, link: portToken.link, linkExpiresAt: portToken.link_expires_at, token: 'cvp_access',
    headers: {'Caveman-Port-Token': 'cvp_access'}, expiresAt: portToken.expires_at, visibility: 'private'});
  assert.deepEqual(fake.state.seen.map(s => [s.method, s.path, s.auth, s.body]), [['POST', `/api/v1/code/computers/${id}/ports/3000/token`, 'Bearer cave_live_wire', '{}']]);
  // public: true makes the port public before the token is asked; ttlSeconds is sent as ttl_seconds.
  fake.state.seen.length = 0;
  const open = await sandboxes.url(id, 3000, {public: true, ttlSeconds: 600});
  assert.equal(open.visibility, 'public');
  assert.equal(open.expiresAt, '2026-11-20T12:10:00Z');
  assert.deepEqual(fake.state.seen.map(s => [s.method, s.path, s.body]), [
    ['PUT', `/api/v1/code/computers/${id}/ports/3000`, '{"visibility":"public"}'],
    ['POST', `/api/v1/code/computers/${id}/ports/3000/token`, '{"ttl_seconds":600}'],
  ]);
  // A port or a ttl out of range is refused before anything is sent.
  fake.state.seen.length = 0;
  for (const bad of [0, 65536, 1.5]) await assert.rejects(sandboxes.url(id, bad), error => error instanceof SandboxError && error.code === 'cave_bad_request' && error.status === 0);
  for (const ttl of [59, 86401, 1.5]) await assert.rejects(sandboxes.url(id, 3000, {ttlSeconds: ttl}), error => error instanceof SandboxError && error.code === 'cave_bad_request');
  assert.deepEqual(fake.state.seen, []);
  // A Caveman Cloud that does not serve ports at their own URLs answers the route as an unknown one: a typed refusal.
  await assert.rejects(sandboxes.url(id, 8080), error => error instanceof SandboxError && error.code === 'cave_not_found' && error.status === 404 && error.requestId === 'req_port');
  // The plain calls are there too: the choices stored and a port made private again.
  assert.equal((await sandboxes.setPort(id, 3000, {visibility: 'private'})).visibility, 'private');
  assert.deepEqual(fake.state.errors, []);
});
