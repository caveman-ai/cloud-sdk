// A fake Caveman Cloud for the Sandboxes client and `cvm sandbox`: it answers what the branch's
// control-api, the fleet's stream endpoint and a relay answered a code:run key, as recorded in
// public/sdk/parity/sandboxes-wire.json (the Caveman sandbox test harness, SANDBOX_LAB_RECORD).
// REST calls by method, path and body; a command's stream by replaying the recording its client
// messages match (or the one named in state.replay); a refusal before the upgrade by state.refuse.
// state.hostDown streams answer as a computer whose host is restarting does (the lab cannot make one:
// the service's words, cloud/computers/streams): its error with retry_after state.retryAfter, then
// close 4503; with state.hostDownOutput, after some output (the command had started).
// A waiting read (GET's wait_for, timeout) is answered at once as the plain read is, with the Cave-Wait
// the API would say of that answer; with waits false, as a Caveman Cloud that does not wait: no Cave-Wait.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {isDeepStrictEqual} from 'node:util';

export const wire = JSON.parse(readFileSync(new URL('../../parity/sandboxes-wire.json', import.meta.url), 'utf8'));
// The order the lab made its REST recordings in: a route's recordings are answered in it.
const recorded = ['create', 'get', 'list', 'list_mine', 'get_unknown', 'create_bad_size', 'create_unknown_field',
  'snapshot', 'get_snapshot', 'list_snapshots', 'get_snapshot_unknown', 'snapshot_unknown_field', 'restore', 'get_snapshot_restored', 'fork',
  'delete_snapshot', 'delete_snapshot_again', 'fork_deleted', 'sleep', 'resume', 'delete', 'delete_again', 'get_deleted'];
const jsonEqual = (a, b) => {
  if (!a || !b) return !a === !b;
  try { return isDeepStrictEqual(typeof a === 'string' ? JSON.parse(a) : a, typeof b === 'string' ? JSON.parse(b) : b); } catch { return false; }
};

// How the API ends a wait for states on computer c (code/computers_wait.go outcome); the fake never holds one.
export function waitOutcome(states, c) {
  if (states.includes(c.observed_state)) return 'satisfied';
  const reachable = s => s === 'running' ? c.desired_state === 'running' : s === 'suspended' || s === 'stopped'
    ? c.desired_state === 'suspended' || c.desired_state === 'stopped' : s === 'deleted' ? c.desired_state === 'deleted' : true;
  return c.observed_state === 'failed' || !states.some(reachable) ? 'unreachable' : 'timeout';
}

export async function startFake({key = 'cave_live_wire', rest, waits = true} = {}) {
  const state = {replay: '', refuse: '', closeRaw: null, hostDown: 0, retryAfter: 0, hostDownOutput: false, used: new Set(), seen: [], errors: []};
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    state.seen.push({method: req.method, path: req.url, auth: req.headers.authorization, body});
    if (req.headers.authorization !== 'Bearer ' + key) state.errors.push(`${req.method} ${req.url} without the key`);
    if (rest) return rest(req, res, body);
    const url = new URL(req.url, 'http://fake');
    const asked = url.searchParams.get('wait_for');
    url.searchParams.delete('wait_for');
    url.searchParams.delete('timeout');
    const path = url.pathname + url.search;
    const match = recorded.filter(name => {
      const c = wire.rest[name];
      return c.method === req.method && c.path === path && jsonEqual(c.body, body);
    });
    if (!match.length) {
      state.errors.push(`no recording for ${req.method} ${req.url} ${body}`);
      res.writeHead(418).end();
      return;
    }
    const name = match.find(m => !state.used.has(m)) ?? match.at(-1);
    state.used.add(name);
    const c = wire.rest[name];
    const headers = {'content-type': 'application/json'};
    if (asked !== null && waits && c.status === 200) headers['cave-wait'] = waitOutcome(asked.split(','), c.answer);
    res.writeHead(c.status, headers).end(JSON.stringify(c.answer));
  });
  server.on('upgrade', (req, socket, head) => {
    state.seen.push({method: 'GET', path: req.url, auth: req.headers.authorization, upgrade: true});
    if (req.headers.authorization !== 'Bearer ' + key) state.errors.push(`stream ${req.url} without the key`);
    if (state.refuse) {
      const r = wire.refusals[state.refuse];
      socket.end(`HTTP/1.1 ${r.status} Refused\r\nContent-Type: ${r.content_type}\r\nContent-Length: ${Buffer.byteLength(r.body)}\r\nConnection: close\r\n\r\n${r.body}`);
      return;
    }
    if (req.headers['sec-websocket-protocol'] !== 'caveman.computer.v1' || req.headers['sec-websocket-version'] !== '13') state.errors.push(`upgrade headers ${JSON.stringify(req.headers)}`);
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: caveman.computer.v1\r\n\r\n`);
    const serve = req.url.includes('/files') ? filesFake : req.url.includes('/dial/') ? dialFake : replay;
    serve(socket, head, state, req.url).catch(error => state.errors.push(String(error))).finally(() => socket.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })};
}

// Frames from a client: masked, as RFC 6455 says a client's are.
async function* clientFrames(socket, head) {
  const chunks = socket[Symbol.asyncIterator]();
  let buffer = Buffer.from(head);
  const need = async n => {
    while (buffer.length < n) { const next = await chunks.next(); if (next.done) return false; buffer = Buffer.concat([buffer, next.value]); }
    return true;
  };
  for (;;) {
    if (!await need(2)) return;
    let n = buffer[1] & 0x7f, at = 2;
    if (n === 126) { if (!await need(4)) return; n = buffer.readUInt16BE(2); at = 4; }
    else if (n === 127) { if (!await need(10)) return; n = Number(buffer.readBigUInt64BE(2)); at = 10; }
    if (!(buffer[1] & 0x80)) throw new Error('an unmasked client frame');
    if (!await need(at + 4 + n)) return;
    const mask = buffer.subarray(at, at + 4), payload = Buffer.from(buffer.subarray(at + 4, at + 4 + n));
    for (let i = 0; i < n; i++) payload[i] ^= mask[i % 4];
    const op = buffer[0] & 0x0f;
    buffer = buffer.subarray(at + 4 + n);
    yield {op, payload};
  }
}

export function serverFrame(op, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | op, n]) : n <= 0xffff ? Buffer.from([0x80 | op, 126, n >> 8, n & 0xff]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
  return Buffer.concat([head, payload]);
}

async function replay(socket, head, state) {
  const frames = clientFrames(socket, head);
  const first = (await frames.next()).value;
  if (!first || first.op !== 1) throw new Error('the first message is not a start');
  const start = first.payload.toString();
  if (state.hostDown > 0) {
    state.hostDown--;
    const code = 'cave_code_computer_host_unreachable';
    if (state.hostDownOutput) socket.write(serverFrame(2, Buffer.from('\x01started\n')));
    socket.write(serverFrame(1, Buffer.from(JSON.stringify({type: 'error', code, message: "the computer's host is not answering just now (it may be restarting); the command was not started: open the stream again in a moment", retry_after: state.retryAfter}))));
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(4503);
    socket.write(serverFrame(8, Buffer.concat([payload, Buffer.from(code)])));
    const timer = setTimeout(() => socket.destroy(), 2000);
    try { for await (const f of frames) if (f.op === 8) break; } catch { /* the client left on the error: its answer to the close is not needed */ }
    clearTimeout(timer);
    return;
  }
  let name = state.replay;
  if (!name) name = Object.keys(wire.exec).find(n => jsonEqual(wire.exec[n].client[0].text, start));
  const rec = wire.exec[name];
  if (!rec) throw new Error(`no recording starts ${start}`);
  if (!state.replay) {
    // The client's every later message, as recorded: its stdin in order, and its control messages (a resize, a
    // signal, close_stdin) in any order among themselves, as the wire leaves them (a signal asked before the stream
    // opened goes before close_stdin, one asked later after it).
    const wants = rec.client.slice(1), got = [];
    for (let i = 0; i < wants.length; i++) got.push((await frames.next()).value);
    const stdin = list => list.filter(m => (m?.stdin ?? (m?.op === 2 ? m.payload.toString() : undefined)) !== undefined).map(m => m.stdin ?? m.payload.toString());
    const texts = list => list.filter(m => m?.text !== undefined || m?.op === 1).map(m => JSON.stringify(JSON.parse(m.text ?? m.payload.toString()), Object.keys(JSON.parse(m.text ?? m.payload.toString())).sort())).sort();
    if (JSON.stringify(stdin(got)) !== JSON.stringify(stdin(wants)) || JSON.stringify(texts(got)) !== JSON.stringify(texts(wants)))
      state.errors.push(`${name}: client sent ${got.map(g => `${g?.op} ${g?.payload}`).join(', ')}; recorded ${JSON.stringify(wants)}`);
  }
  for (const m of state.closeRaw === null ? rec.server : []) {
    if (m.text !== undefined) socket.write(serverFrame(1, Buffer.from(m.text)));
    else socket.write(serverFrame(2, Buffer.concat([Buffer.from([m.channel]), m.base64 ? Buffer.from(m.base64, 'base64') : Buffer.from(m.data ?? '')])));
  }
  const code = state.closeRaw ?? rec.close.code, reason = state.closeRaw === null ? rec.close.reason : '';
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code);
  socket.write(serverFrame(8, Buffer.concat([payload, Buffer.from(reason)])));
  // The client's answer to the close, or its own close after an exit; then the end.
  const timer = setTimeout(() => socket.destroy(), 2000);
  for await (const f of frames) if (f.op === 8) break;
  clearTimeout(timer);
}

// A sandbox's files, as the files wire answers them (the sandbox files wire protocol):
// state.files maps an absolute path to {data, mode} for a file or {dir: true} for a folder.
const fileInfo = (path, f) => ({name: path.split('/').pop() || '/', type: f.dir ? 'dir' : 'file', size: f.dir ? 0 : f.data.length,
  mode: f.mode ?? (f.dir ? 0o755 : 0o644), mtime: '2026-11-20T05:00:00Z'});
const closes = {cave_code_computer_file_not_found: 4601, cave_code_computer_file_exists: 4603, cave_code_computer_file_refused: 4604, cave_code_computer_port_refused: 4606};

function closeWith(socket, code, reason = '') {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code);
  socket.write(serverFrame(8, Buffer.concat([payload, Buffer.from(reason)])));
}

async function filesFake(socket, head, state) {
  state.files ??= new Map([['/', {dir: true}]]);
  const frames = clientFrames(socket, head);
  const first = (await frames.next()).value;
  const op = JSON.parse(first.payload.toString());
  state.fileOps = [...(state.fileOps ?? []), op];
  if (state.hostDown > 0) {
    // As exec's stream answers a host restarting: the error with retry_after, close 4503, the handshake.
    state.hostDown--;
    socket.write(serverFrame(1, Buffer.from(JSON.stringify({type: 'error', code: 'cave_code_computer_host_unreachable', message: "the computer's host is not answering just now", retry_after: state.retryAfter}))));
    closeWith(socket, 4503, 'cave_code_computer_host_unreachable');
    const timer = setTimeout(() => socket.destroy(), 2000);
    try { for await (const f of frames) if (f.op === 8) break; } catch { /* gone */ }
    clearTimeout(timer);
    return;
  }
  const send = v => socket.write(serverFrame(1, Buffer.from(JSON.stringify(v))));
  const fail = (code, message) => { send({type: 'error', code, message}); closeWith(socket, closes[code] ?? 4500, code); };
  const files = state.files, at = files.get(op.path), parent = op.path.replace(/\/[^/]*$/, '') || '/';
  switch (op.op) {
    case 'read':
      if (!at || at.dir) return fail(at ? 'cave_code_computer_file_refused' : 'cave_code_computer_file_not_found', `open ${op.path}: ${at ? 'is a directory' : 'no such file or directory'}`);
      for (let i = 0; i < at.data.length; i += 5) socket.write(serverFrame(2, at.data.subarray(i, i + 5)));
      send({type: 'file', file: fileInfo(op.path, at)});
      break;
    case 'write': {
      const parts = [];
      for await (const f of frames) {
        if (f.op === 2) { parts.push(f.payload); continue; }
        if (f.op === 1 && JSON.parse(f.payload.toString()).type === 'close_stdin') break;
      }
      if (!files.get(parent)?.dir) return fail('cave_code_computer_file_not_found', `open ${op.path}: no such file or directory`);
      files.set(op.path, {data: Buffer.concat(parts), mode: op.mode});
      send({type: 'file', file: fileInfo(op.path, files.get(op.path))});
      break;
    }
    case 'list': {
      if (!at?.dir) return fail('cave_code_computer_file_not_found', `open ${op.path}: no such file or directory`);
      const prefix = op.path === '/' ? '/' : op.path + '/';
      const inside = [...files].filter(([p]) => p !== op.path && p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
      for (let i = 0; i < inside.length; i += 2) send({type: 'entries', entries: inside.slice(i, i + 2).map(([p, f]) => fileInfo(p, f))});
      send({type: 'done'});
      break;
    }
    case 'stat':
      if (!at) return fail('cave_code_computer_file_not_found', `lstat ${op.path}: no such file or directory`);
      send({type: 'file', file: fileInfo(op.path, at)});
      break;
    case 'mkdir':
      if (at) return fail('cave_code_computer_file_exists', `mkdir ${op.path}: file exists`);
      files.set(op.path, {dir: true});
      send({type: 'done'});
      break;
    case 'remove':
      if (!at) return fail('cave_code_computer_file_not_found', `remove ${op.path}: no such file or directory`);
      for (const p of [...files.keys()]) if (p === op.path || (op.all && p.startsWith(op.path + '/'))) files.delete(p);
      send({type: 'done'});
      break;
    case 'rename':
      if (!at) return fail('cave_code_computer_file_not_found', `rename ${op.path}: no such file or directory`);
      files.delete(op.path);
      files.set(op.to, at);
      send({type: 'done'});
      break;
  }
  closeWith(socket, 1000);
  const timer = setTimeout(() => socket.destroy(), 2000);
  try { for await (const f of frames) if (f.op === 8) break; } catch { /* gone */ }
  clearTimeout(timer);
}

// A port that echoes what it is sent, upper-cased, and half-closes when the client does;
// state.portRefused: nothing listens.
async function dialFake(socket, head, state, url) {
  state.dialed = [...(state.dialed ?? []), url.split('/').pop()];
  if (state.portRefused) {
    socket.write(serverFrame(1, Buffer.from(JSON.stringify({type: 'error', code: 'cave_code_computer_port_refused', message: 'nothing listens on port ' + url.split('/').pop()}))));
    closeWith(socket, 4606, 'cave_code_computer_port_refused');
    // The close handshake, as a server completes it: what the client sent meanwhile is read past.
    const timer = setTimeout(() => socket.destroy(), 2000);
    try { for await (const f of clientFrames(socket, head)) if (f.op === 8) break; } catch { /* gone */ }
    clearTimeout(timer);
    return;
  }
  for await (const f of clientFrames(socket, head)) {
    if (f.op === 2) socket.write(serverFrame(2, Buffer.from(f.payload.toString().toUpperCase())));
    else if (f.op === 1 && JSON.parse(f.payload.toString()).type === 'close_write') {
      socket.write(serverFrame(1, Buffer.from(JSON.stringify({type: 'close_write'}))));
      closeWith(socket, 1000);
    } else if (f.op === 8) break;
  }
}
