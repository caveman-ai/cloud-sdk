import test from 'node:test';
import assert from 'node:assert/strict';
import {Rooms} from '../dist/rooms.js';
import {Apps, AppBridge} from '../dist/apps.js';
import {Listeners, Predicate} from '../dist/listeners.js';
import {Workflows, WorkflowUncertainEffectError} from '../dist/workflows.js';
import {ComputerPools} from '../dist/pools.js';

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({method: init.method || 'GET', path: u.pathname, query: u.search, body, headers: init.headers});
    const handler = routes[key];
    if (!handler) {
      return new Response(JSON.stringify({error: {code: 'not_found', message: `unhandled ${key}`}}), {status: 404});
    }
    const res = await handler({body, query: u.searchParams, headers: init.headers});
    const status = typeof res?.httpStatus === 'number' ? res.httpStatus : 200;
    const payload = typeof res?.httpStatus === 'number' ? res.body : res;
    return new Response(JSON.stringify(payload), {status});
  };
  return {fn, calls};
}

test('Rooms.withLease claims, completes on success, and releases on error', async () => {
  const {fn, calls} = fakeFetch({
    'POST /api/v1/code/rooms/eng/threads/t1/claim': () => ({id: 't1', status: 'claimed', lease_token: 'tok-1', tainted: false}),
    'POST /api/v1/code/rooms/eng/threads/t1/complete': () => ({id: 't1', status: 'done'}),
    'POST /api/v1/code/rooms/eng/threads/t1/release': () => ({id: 't1', status: 'ready'}),
  });
  const rooms = new Rooms({controlURL: 'https://app.caveman.so', apiKey: 'cave_live_test', fetch: fn});
  const val = await rooms.withLease('eng', 't1', async (t) => {
    assert.equal(t.lease_token, 'tok-1');
    return 42;
  }, {ttlSeconds: 60});
  assert.equal(val, 42);
  assert.equal(calls.at(-1).path, '/api/v1/code/rooms/eng/threads/t1/complete');

  await assert.rejects(() => rooms.withLease('eng', 't1', async () => {
    throw new Error('boom');
  }, {ttlSeconds: 60}), /boom/);
  assert.equal(calls.at(-1).path, '/api/v1/code/rooms/eng/threads/t1/release');
});

test('Listeners fluent Predicate builder + stats', async () => {
  const filter = Predicate.all(
    Predicate.eq('sender.domain', 'acmecorp.com'),
    Predicate.icontains('subject', 'redline'),
  );
  assert.deepEqual(filter, {
    all: [
      {rule: {path: 'sender.domain', op: 'eq', value: 'acmecorp.com'}},
      {rule: {path: 'subject', op: 'icontains', value: 'redline'}},
    ],
  });
  const {fn} = fakeFetch({
    'POST /api/v1/code/listeners': ({body}) => ({id: 'l1', name: body.name, enabled: true, events_seen: 0, events_matched: 0, events_dropped: 0}),
    'GET /api/v1/code/listeners/acme/stats': () => ({listener_id: 'l1', name: 'acme', events_seen: 100, events_matched: 2, events_dropped: 98, drop_rate: 0.98, spend_usd: 0, filter_basis: 'measured'}),
  });
  const listeners = new Listeners({controlURL: 'https://app.caveman.so', apiKey: 'cave_live_test', fetch: fn});
  const created = await listeners.create({name: 'acme', source_kind: 'webhook', filter_spec: filter, target_kind: 'room_post', target_id: 'eng', ttl_seconds: 86400});
  assert.equal(created.name, 'acme');
  const stats = await listeners.stats('acme');
  assert.equal(stats.drop_rate, 0.98);
});

test('Workflows deterministic replay, uncertain effect fail-closed, and durable park', async () => {
  const stepResults = new Map();
  let sideEffectExecs = 0;
  const {fn} = fakeFetch({
    'POST /api/v1/code/workflows/invoice/runs': () => ({id: 'run-1', workflow_id: 'wf-1', session_id: 'sess-1', status: 'running'}),
    'POST /api/v1/code/workflows/runs/run-1/steps/begin': ({body}) => {
      if (body.step_key === 'crashed-external') return {action: 'uncertain', step_key: body.step_key};
      if (stepResults.has(body.step_key)) return {action: 'cached', step_key: body.step_key, result: stepResults.get(body.step_key)};
      return {action: 'execute', step_key: body.step_key};
    },
    'POST /api/v1/code/workflows/runs/run-1/steps/complete': ({body}) => {
      stepResults.set(body.step_key, body.result);
      return {ok: true};
    },
    'POST /api/v1/code/workflows/runs/run-1/wait': ({body}) => ({id: 'w-1', session_id: 'sess-1', kind: body.kind, status: 'pending'}),
    'POST /api/v1/code/workflows/runs/run-1/finish': ({body}) => ({id: 'run-1', status: body.status, output: body.output}),
  });
  const wf = new Workflows({controlURL: 'https://app.caveman.so', apiKey: 'cave_live_test', fetch: fn});

  // First run executes step; second replay gets cached value without re-running fn.
  const run1 = await wf.execute('invoice', {id: 'inv_1'}, async (ctx, inp) => {
    const fetched = await ctx.step('fetch', {effect: 'read'}, async () => { sideEffectExecs++; return {total: 100, id: inp.id}; });
    return fetched;
  });
  assert.equal(sideEffectExecs, 1);
  assert.deepEqual(run1.output, {total: 100, id: 'inv_1'});

  const run2 = await wf.execute('invoice', {id: 'inv_1'}, async (ctx) => {
    return ctx.step('fetch', {effect: 'read'}, async () => { sideEffectExecs++; return {total: 999}; });
  });
  assert.equal(sideEffectExecs, 1, 'cached step must not re-execute on replay');
  assert.deepEqual(run2.output, {total: 100, id: 'inv_1'});

  // Uncertain external step fails closed.
  await assert.rejects(() => wf.execute('invoice', {}, async (ctx) => {
    return ctx.step('crashed-external', {effect: 'external'}, async () => 'never');
  }), WorkflowUncertainEffectError);

  // Durable approval wait parks cleanly.
  const parked = await wf.execute('invoice', {}, async (ctx) => {
    await ctx.waitForApproval('ask-1', 'Approve wire transfer');
  });
  assert.equal(parked.run.status, 'waiting');
  assert.equal(parked.parked.kind, 'approval');
});

test('Apps, AppBridge, and ComputerPools', async () => {
  const {fn} = fakeFetch({
    'POST /api/v1/code/apps/tax/fork': () => ({id: 'a2', slug: 'tax-v2', kind: 'drive_static', render_path: '/api/v1/code/apps/tax-v2/render/index.html'}),
    'POST /api/v1/code/apps/tax-v2/bridge': () => ({path: 'data.json', text: '{}', version: 1}),
    'POST /api/v1/code/sessions/s1/computers': () => ({id: 'l1', session_id: 's1', computer_id: 'c1', role: 'experiment'}),
  });
  const apps = new Apps({controlURL: 'https://app.caveman.so', apiKey: 'cave_live_test', fetch: fn});
  const forked = await apps.fork('tax', {slug: 'tax-v2'});
  assert.equal(forked.slug, 'tax-v2');

  const bridge = new AppBridge('tax-v2', {controlURL: 'https://app.caveman.so', apiKey: 'capp_org_tok', fetch: fn});
  const read = await bridge.driveRead('data.json');
  assert.equal(read.version, 1);

  const pools = new ComputerPools({controlURL: 'https://app.caveman.so', apiKey: 'cave_live_test', fetch: fn});
  const lease = await pools.leaseForSession('s1', {pool: 'build-pool', role: 'experiment'});
  assert.equal(lease.computer_id, 'c1');
});
