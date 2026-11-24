// `cvm room`: harness-agnostic shared Rooms & Threads with task leasing,
// event-driven watchers, cross-thread taint tracking, and per-thread cost rollup.
// Any agent (Claude Code, Codex, OpenCode, Caveman, SDK) adopts this in 30s.
import {parseArgs} from 'node:util';
import {CloudError, inertJSON} from '../dist/cloud-client.mjs';

const usage = msg => Object.assign(new CloudError('cave_usage', msg, 2), {local: true});

async function apiReq(ctx, method, path, body) {
  const {baseURL, token} = await ctx();
  if (!token) throw new CloudError('cave_auth_required', 'Run `cvm login` (or set CAVE_TOKEN) first.', 3);
  const headers = {authorization: `Bearer ${token}`, 'x-cave-client': 'cvm'};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${baseURL.replace(/\/+$/, '')}${path}`, {
    method,
    headers,
    ...(body !== undefined ? {body: JSON.stringify(body)} : {}),
    signal: AbortSignal.timeout(35000),
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {raw: text}; }
  if (!res.ok) {
    const err = parsed?.error ?? {};
    const exit = res.status === 401 || res.status === 403 ? 3 : res.status === 409 ? 4 : res.status === 429 ? 7 : res.status === 400 ? 2 : 1;
    throw new CloudError(err.code || `http_${res.status}`, err.message || `HTTP ${res.status}`, exit);
  }
  return parsed;
}

function out(data, pretty) {
  process.stdout.write(inertJSON(data, pretty ? 2 : undefined) + '\n');
}

export const roomVerbs = [
  {id: 'room.list', usage: 'cvm room list', summary: 'List coordination rooms visible to you.'},
  {id: 'room.create', usage: 'cvm room create SLUG [--name NAME] [--description TEXT] [--visibility org|private] [--taint propagate|strict|trusted_only]', summary: 'Create a shared coordination room.'},
  {id: 'room.threads', usage: 'cvm room threads ROOM [--status STATUS] [--label LABEL] [--limit N]', summary: 'List conversation/task threads in a room.'},
  {id: 'room.open', usage: 'cvm room open ROOM TITLE [--body TEXT] [--status open|ready] [--label L]... [--depends-on ID]... [--untrusted]', summary: 'Open a new thread in a room.'},
  {id: 'room.post', usage: 'cvm room post ROOM THREAD BODY [--kind message|task|note|ask|app|status] [--session ID] [--data JSON] [--untrusted]', summary: 'Post a message to a thread (propagates taint automatically).'},
  {id: 'room.read', usage: 'cvm room read ROOM THREAD [--after SEQ] [--limit N] [--session ID]', summary: 'Read messages in a thread.'},
  {id: 'room.wait', usage: 'cvm room wait ROOM THREAD [--after SEQ] [--timeout 25] [--session ID]', summary: 'Long-poll until a new reply arrives in a thread.'},
  {id: 'room.claim', usage: 'cvm room claim ROOM THREAD [--ttl 300] [--session ID]', summary: 'Atomically claim a task thread once dependencies are done.'},
  {id: 'room.renew', usage: 'cvm room renew ROOM THREAD --lease TOKEN [--ttl 300]', summary: 'Extend an active lease on a thread.'},
  {id: 'room.release', usage: 'cvm room release ROOM THREAD [--lease TOKEN] [--note TEXT]', summary: 'Release a claimed thread back to ready.'},
  {id: 'room.complete', usage: 'cvm room complete ROOM THREAD [--lease TOKEN] [--note TEXT]', summary: 'Mark a claimed thread done and wake watchers.'},
  {id: 'room.watch', usage: 'cvm room watch ROOM --kind deployment|session|webhook --target ID [--thread ID] [--event message]...', summary: 'Register an event-driven watcher on a room or thread.'},
  {id: 'room.rollup', usage: 'cvm room rollup ROOM THREAD', summary: 'Show measured multi-session token spend and outcomes for a thread.'},
];

export async function room(argv, {context}) {
  const pretty = Boolean(process.stdout.isTTY);
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub === '--help' || sub === '-h') {
    for (const v of roomVerbs) process.stdout.write(`${v.usage}\n  ${v.summary}\n`);
    return 0;
  }
  try {
    switch (sub) {
      case 'list': {
        out(await apiReq(context, 'GET', '/api/v1/code/rooms'), pretty);
        return 0;
      }
      case 'create': {
        const {values, positionals} = parseArgs({
          args: rest, allowPositionals: true,
          options: {name: {type: 'string'}, description: {type: 'string'}, visibility: {type: 'string'}, taint: {type: 'string'}},
        });
        if (!positionals[0]) throw usage('Use: cvm room create SLUG [--name NAME]');
        out(await apiReq(context, 'POST', '/api/v1/code/rooms', {
          slug: positionals[0], name: values.name || positionals[0], description: values.description || '',
          visibility: values.visibility || 'org', taint_policy: values.taint || 'propagate',
        }), pretty);
        return 0;
      }
      case 'threads': {
        const {values, positionals} = parseArgs({
          args: rest, allowPositionals: true,
          options: {status: {type: 'string'}, label: {type: 'string'}, limit: {type: 'string'}},
        });
        if (!positionals[0]) throw usage('Use: cvm room threads ROOM [--status STATUS] [--label LABEL]');
        const q = new URLSearchParams();
        if (values.status) q.set('status', values.status);
        if (values.label) q.set('label', values.label);
        if (values.limit) q.set('limit', values.limit);
        const qs = q.size ? `?${q}` : '';
        out(await apiReq(context, 'GET', `/api/v1/code/rooms/${encodeURIComponent(positionals[0])}/threads${qs}`), pretty);
        return 0;
      }
      case 'open': {
        const {values, positionals} = parseArgs({
          args: rest, allowPositionals: true,
          options: {
            body: {type: 'string'}, status: {type: 'string'}, label: {type: 'string', multiple: true},
            'depends-on': {type: 'string', multiple: true}, session: {type: 'string'}, untrusted: {type: 'boolean'},
          },
        });
        if (positionals.length < 2) throw usage('Use: cvm room open ROOM TITLE [--body TEXT]');
        out(await apiReq(context, 'POST', `/api/v1/code/rooms/${encodeURIComponent(positionals[0])}/threads`, {
          title: positionals.slice(1).join(' '), body: values.body || '', status: values.status || 'ready',
          labels: values.label ?? [], depends_on: values['depends-on'] ?? [], session_id: values.session || '', untrusted: Boolean(values.untrusted),
        }), pretty);
        return 0;
      }
      case 'post': {
        const {values, positionals} = parseArgs({
          args: rest, allowPositionals: true,
          options: {kind: {type: 'string'}, session: {type: 'string'}, data: {type: 'string'}, untrusted: {type: 'boolean'}, 'idempotency-key': {type: 'string'}},
        });
        if (positionals.length < 3) throw usage('Use: cvm room post ROOM THREAD BODY');
        const body = {
          body: positionals.slice(2).join(' '), kind: values.kind || 'message', session_id: values.session || '',
          untrusted: Boolean(values.untrusted), idempotency_key: values['idempotency-key'] || '',
        };
        if (values.data) body.structured_data = JSON.parse(values.data);
        out(await apiReq(context, 'POST', `/api/v1/code/rooms/${encodeURIComponent(positionals[0])}/threads/${encodeURIComponent(positionals[1])}/messages`, body), pretty);
        return 0;
      }
      case 'read':
      case 'wait': {
        const {values, positionals} = parseArgs({
          args: rest, allowPositionals: true,
          options: {after: {type: 'string'}, limit: {type: 'string'}, timeout: {type: 'string'}, session: {type: 'string'}},
        });
        if (positionals.length < 2) throw usage(`Use: cvm room ${sub} ROOM THREAD [--after SEQ]`);
        const q = new URLSearchParams();
        if (values.after) q.set('after_seq', values.after);
        if (values.limit) q.set('limit', values.limit);
        if (values.timeout) q.set('timeout', values.timeout);
        if (values.session) q.set('session_id', values.session);
        const qs = q.size ? `?${q}` : '';
        const tail = sub === 'wait' ? 'wait' : 'messages';
        out(await apiReq(context, 'GET', `/api/v1/code/rooms/${encodeURIComponent(positionals[0])}/threads/${encodeURIComponent(positionals[1])}/${tail}${qs}`), pretty);
        return 0;
      }
      case 'claim':
      case 'renew':
      case 'release':
      case 'complete': {
        const {values, positionals} = parseArgs({
          args: rest, allowPositionals: true,
          options: {ttl: {type: 'string'}, lease: {type: 'string'}, session: {type: 'string'}, note: {type: 'string'}},
        });
        if (positionals.length < 2) throw usage(`Use: cvm room ${sub} ROOM THREAD`);
        const body = {
          ...(values.ttl ? {ttl_seconds: Number(values.ttl)} : {}),
          ...(values.lease ? {lease_token: values.lease} : {}),
          ...(values.session ? {session_id: values.session} : {}),
          ...(values.note ? {note: values.note} : {}),
        };
        out(await apiReq(context, 'POST', `/api/v1/code/rooms/${encodeURIComponent(positionals[0])}/threads/${encodeURIComponent(positionals[1])}/${sub}`, body), pretty);
        return 0;
      }
      case 'watch': {
        const {values, positionals} = parseArgs({
          args: rest, allowPositionals: true,
          options: {kind: {type: 'string'}, target: {type: 'string'}, thread: {type: 'string'}, event: {type: 'string', multiple: true}},
        });
        if (!positionals[0] || !values.kind || !values.target) throw usage('Use: cvm room watch ROOM --kind deployment|session|webhook --target ID');
        out(await apiReq(context, 'POST', `/api/v1/code/rooms/${encodeURIComponent(positionals[0])}/watchers`, {
          watcher_kind: values.kind, target_id: values.target, thread_id: values.thread || '', on_events: values.event ?? ['message'],
        }), pretty);
        return 0;
      }
      case 'rollup': {
        if (rest.length < 2) throw usage('Use: cvm room rollup ROOM THREAD');
        out(await apiReq(context, 'GET', `/api/v1/code/rooms/${encodeURIComponent(rest[0])}/threads/${encodeURIComponent(rest[1])}/rollup`), pretty);
        return 0;
      }
      default:
        throw usage(`Unknown room subcommand ${sub}. Run \`cvm room --help\`.`);
    }
  } catch (error) {
    const code = error instanceof CloudError ? error.code : 'cave_failed';
    const exit = error instanceof CloudError ? error.exitCode : 1;
    process.stdout.write(inertJSON({ok: false, error: {code, message: error.message}}, pretty ? 2 : undefined) + '\n');
    return exit;
  }
}
