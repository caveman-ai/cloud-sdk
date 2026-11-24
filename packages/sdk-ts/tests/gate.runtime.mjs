import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Cave,
  Gate,
  GateDeniedError,
  GateError,
  GateTimeoutError,
} from '../dist/index.js';
import {WorkflowContext, Workflows, WorkflowParkedError} from '../dist/workflows.js';

function makeMockFetch(routes) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({method, path: u.pathname, headers: init.headers, body});
    const handler = routes[`${method} ${u.pathname}`];
    if (!handler) {
      return new Response(JSON.stringify({error: {code: 'not_found', message: 'not found'}}), {
        status: 404,
        headers: {'content-type': 'application/json'},
      });
    }
    const out = await handler({method, path: u.pathname, body, headers: init.headers});
    return new Response(JSON.stringify(out.body), {
      status: out.status ?? 200,
      headers: {'content-type': 'application/json', ...(out.headers ?? {})},
    });
  };
  return {fetchFn, calls};
}

test('Gate.require files via POST /api/v1/code/gates with patch+data_untrusted and polls GET /api/v1/code/gates/{id}', async () => {
  let polls = 0;
  const {fetchFn, calls} = makeMockFetch({
    'POST /api/v1/code/gates': ({body}) => {
      assert.equal(body.ref_type, 'agent_gate');
      assert.equal(body.kind, 'needs_you');
      assert.equal(body.priority, 1);
      assert.equal(body.actions, undefined, 'SDK lets server stamp canonical actions');
      const diffArt = body.artifacts.find((a) => a.type === 'diff');
      assert.ok(diffArt, 'diff artifact present');
      assert.equal(diffArt.patch, '-old\n+new');
      assert.equal(diffArt.text, undefined, 'diff uses patch, never text');
      assert.equal(diffArt.data_untrusted, true);
      return {
        status: 201,
        body: {
          id: 'gate-1',
          status: 'open',
          ref_type: 'agent_gate',
          ref_id: 'stripe.refund',
          title: body.title,
          dedupe_key: body.dedupe_key || 'gate-1',
          created_at: '2026-11-23T00:00:00Z',
          data: {},
        },
      };
    },
    'GET /api/v1/code/gates/gate-1': () => {
      polls++;
      if (polls === 1) {
        return {
          status: 200,
          body: {
            id: 'gate-1',
            status: 'open',
            ref_type: 'agent_gate',
            ref_id: 'stripe.refund',
            title: 'Approve stripe.refund',
            dedupe_key: 'gate-1',
            created_at: '2026-11-23T00:00:00Z',
            data: {},
          },
        };
      }
      return {
        status: 200,
        body: {
          id: 'gate-1',
          status: 'resolved',
          ref_type: 'agent_gate',
          ref_id: 'stripe.refund',
          title: 'Approve stripe.refund',
          dedupe_key: 'gate-1',
          created_at: '2026-11-23T00:00:00Z',
          resolved_at: '2026-11-23T00:01:00Z',
          data: {gate_decision: 'approved', gate_decided_by: 'alice@acme.test'},
        },
      };
    },
  });

  const gate = new Gate({
    controlURL: 'https://app.caveman.so',
    apiKey: 'cave_live_test_key',
    fetch: fetchFn,
  });

  const decision = await gate.require({
    action: 'stripe.refund',
    summary: 'Refund $499 to customer',
    risk: 'high',
    costUsd: 499,
    diff: {patch: '-old\n+new'},
    pollIntervalMs: 250,
    timeoutMs: 5000,
  });

  assert.equal(decision.approved, true);
  assert.equal(decision.decision, 'approved');
  assert.equal(decision.decidedBy, 'alice@acme.test');
  assert.equal(polls, 2);
  assert.equal(calls[0].path, '/api/v1/code/gates');
  assert.equal(calls[1].path, '/api/v1/code/gates/gate-1');
});

test('Gate fails closed on denial, archival without decision, timeout, and mismatched item', async () => {
  // 1. Denied
  const deniedMock = makeMockFetch({
    'POST /api/v1/code/gates': () => ({
      status: 201,
      body: {id: 'g-deny', status: 'open', ref_type: 'agent_gate', ref_id: 'db.drop', title: 'Drop', dedupe_key: 'k', created_at: '2026-11-23T00:00:00Z'},
    }),
    'GET /api/v1/code/gates/g-deny': () => ({
      status: 200,
      body: {id: 'g-deny', status: 'resolved', ref_type: 'agent_gate', ref_id: 'db.drop', title: 'Drop', dedupe_key: 'k', created_at: '2026-11-23T00:00:00Z', data: {gate_decision: 'denied', gate_decided_by: 'bob@acme.test'}},
    }),
  });
  const gDeny = new Gate({controlURL: 'https://app.caveman.so', apiKey: 'cave_live_k', fetch: deniedMock.fetchFn});
  await assert.rejects(
    () => gDeny.require({action: 'db.drop', summary: 'Drop prod table', pollIntervalMs: 250, timeoutMs: 2000}),
    (err) => err instanceof GateDeniedError && err.decision.decidedBy === 'bob@acme.test',
  );

  // 2. Archived without explicit decision -> fails closed as GateDeniedError
  const archMock = makeMockFetch({
    'POST /api/v1/code/gates': () => ({
      status: 201,
      body: {id: 'g-arch', status: 'open', ref_type: 'agent_gate', ref_id: 'db.drop', title: 'Drop', dedupe_key: 'k', created_at: '2026-11-23T00:00:00Z'},
    }),
    'GET /api/v1/code/gates/g-arch': () => ({
      status: 200,
      body: {id: 'g-arch', status: 'archived', ref_type: 'agent_gate', ref_id: 'db.drop', title: 'Drop', dedupe_key: 'k', created_at: '2026-11-23T00:00:00Z', data: {}},
    }),
  });
  const gArch = new Gate({controlURL: 'https://app.caveman.so', apiKey: 'cave_live_k', fetch: archMock.fetchFn});
  await assert.rejects(
    () => gArch.require({action: 'db.drop', summary: 'Drop', pollIntervalMs: 250, timeoutMs: 2000}),
    (err) => err instanceof GateDeniedError,
  );

  // 3. Timeout -> fails closed as GateTimeoutError
  const timeoutMock = makeMockFetch({
    'POST /api/v1/code/gates': () => ({
      status: 201,
      body: {id: 'g-to', status: 'open', ref_type: 'agent_gate', ref_id: 'db.drop', title: 'Drop', dedupe_key: 'k', created_at: '2026-11-23T00:00:00Z'},
    }),
    'GET /api/v1/code/gates/g-to': () => ({
      status: 200,
      body: {id: 'g-to', status: 'open', ref_type: 'agent_gate', ref_id: 'db.drop', title: 'Drop', dedupe_key: 'k', created_at: '2026-11-23T00:00:00Z', data: {}},
    }),
  });
  const gTimeout = new Gate({controlURL: 'https://app.caveman.so', apiKey: 'cave_live_k', fetch: timeoutMock.fetchFn});
  await assert.rejects(
    () => gTimeout.require({action: 'db.drop', summary: 'Drop', pollIntervalMs: 250, timeoutMs: 120}),
    (err) => err instanceof GateTimeoutError,
  );

  // 4. Mismatched item ID / ref_type -> GateError protocol error
  const badMock = makeMockFetch({
    'POST /api/v1/code/gates': () => ({
      status: 201,
      body: {id: 'g-ok', status: 'open', ref_type: 'agent_gate', ref_id: 'a', title: 'A', dedupe_key: 'k', created_at: '2026-11-23T00:00:00Z'},
    }),
    'GET /api/v1/code/gates/g-ok': () => ({
      status: 200,
      body: {id: 'different-id', status: 'resolved', ref_type: 'demo', data: {gate_decision: 'approved'}},
    }),
  });
  const gBad = new Gate({controlURL: 'https://app.caveman.so', apiKey: 'cave_live_k', fetch: badMock.fetchFn});
  await assert.rejects(
    () => gBad.require({action: 'a', summary: 's', pollIntervalMs: 250, timeoutMs: 2000}),
    (err) => err instanceof GateError && err.code === 'cave_gate_protocol_error',
  );
});

test('Gate validates NaN/Infinity/negative options and guard() supports async when + defaults risk=high', async () => {
  assert.throws(() => new Gate({controlURL: 'https://app.caveman.so', apiKey: 'k', defaultTimeoutMs: Number.NaN}));
  assert.throws(() => new Gate({controlURL: 'https://user:pass@app.caveman.so', apiKey: 'k'}));
  assert.throws(() => new Gate({controlURL: 'https://app.caveman.so?q=1', apiKey: 'k'}));

  let gatedRisk;
  const {fetchFn} = makeMockFetch({
    'POST /api/v1/code/gates': ({body}) => {
      gatedRisk = body.priority;
      return {status: 201, body: {id: 'g1', status: 'open', ref_type: 'agent_gate', ref_id: body.ref_id, title: body.title, dedupe_key: 'k', created_at: '2026-11-23T00:00:00Z'}};
    },
    'GET /api/v1/code/gates/g1': () => ({
      status: 200,
      body: {id: 'g1', status: 'resolved', ref_type: 'agent_gate', ref_id: 'wire.send', title: 'Send', dedupe_key: 'k', created_at: '2026-11-23T00:00:00Z', data: {gate_decision: 'approved', gate_decided_by: 'cfo@acme.test'}},
    }),
  });

  const cave = new Cave({
    apiKey: 'cave_live_test',
    baseURL: 'https://gw.caveman.so',
    controlURL: 'https://app.caveman.so',
    agent: 'billing-bot',
    defaultWorkflow: 'billing_ops',
  });
  const gate = cave.gate({fetch: fetchFn});

  let executed = 0;
  const sendWire = gate.guard(
    {
      action: 'wire.send',
      summary: (amt) => `Send $${amt}`,
      when: async (amt) => amt >= 100,
    },
    async (amt) => {
      executed += amt;
      return `sent:${amt}`;
    },
  );

  // Under threshold: async when returns false -> runs without gating.
  assert.equal(await sendWire(50), 'sent:50');
  assert.equal(gatedRisk, undefined);

  // Over threshold: gates with default risk='high' (priority=1).
  assert.equal(await sendWire(500), 'sent:500');
  assert.equal(gatedRisk, 1);
  assert.equal(executed, 550);

  // WorkflowContext.approve & waitForSensor park cleanly.
  const wfMock = makeMockFetch({
    'POST /api/v1/code/workflows/runs/run-1/wait': ({body}) => ({
      status: 201,
      body: {id: 'wait-1', session_id: 's1', kind: body.kind, ask_id: body.ask_id, target_id: body.target_id, status: 'pending', created_at: '2026-11-23T00:00:00Z'},
    }),
  });
  const wf = new Workflows({controlURL: 'https://app.caveman.so', apiKey: 'cave_live_k', fetch: wfMock.fetchFn});
  const wctx = new WorkflowContext(wf, 'run-1', 's1');
  await assert.rejects(() => wctx.approve({askId: 'deploy-1', reason: 'Deploy prod'}), (e) => e instanceof WorkflowParkedError && e.wait.kind === 'approval');
  await assert.rejects(() => wctx.waitForSensor('sensor-99', {reason: 'Wait CI'}), (e) => e instanceof WorkflowParkedError && e.wait.kind === 'listener_event' && e.wait.target_id === 'sensor-99');
});

test('Gate rejects action mismatch on dedupe reuse, enforces deadline across 429 Retry-After, and WorkflowContext replays resolved waits', async () => {
  // 1. Server returns gate item whose ref_id does not match requested action (dedupe collision) -> fail closed!
  const reuseMock = makeMockFetch({
    'POST /api/v1/code/gates': () => ({
      status: 200,
      body: {id: 'g-old', status: 'resolved', ref_type: 'agent_gate', ref_id: 'read.balance', title: 'Read', dedupe_key: 'shared-k', created_at: '2026-11-23T00:00:00Z', data: {gate_decision: 'approved'}},
    }),
  });
  const gReuse = new Gate({controlURL: 'https://app.caveman.so', apiKey: 'cave_live_k', fetch: reuseMock.fetchFn});
  await assert.rejects(
    () => gReuse.request({action: 'db.drop_table', summary: 'Drop prod', dedupeKey: 'shared-k'}),
    (err) => err instanceof GateError && err.code === 'cave_gate_protocol_error',
  );

  // 2. 429 with Retry-After exceeding wait deadline -> GateTimeoutError, never accepts late approval!
  let pollCalls = 0;
  const retryMock = makeMockFetch({
    'POST /api/v1/code/gates': ({body}) => ({
      status: 201,
      body: {id: 'g-rl', status: 'open', ref_type: 'agent_gate', ref_id: body.ref_id, title: body.title, dedupe_key: 'k', created_at: '2026-11-23T00:00:00Z'},
    }),
    'GET /api/v1/code/gates/g-rl': () => {
      pollCalls++;
      if (pollCalls === 1) {
        return {status: 429, headers: {'retry-after': '2'}, body: {error: {code: 'rate_limited', message: 'slow down'}}};
      }
      return {
        status: 200,
        body: {id: 'g-rl', status: 'resolved', ref_type: 'agent_gate', ref_id: 'deploy.prod', title: 'Deploy', dedupe_key: 'k', created_at: '2026-11-23T00:00:00Z', data: {gate_decision: 'approved', gate_decided_by: 'alice@acme.test'}},
      };
    },
  });
  const gRetry = new Gate({controlURL: 'https://app.caveman.so', apiKey: 'cave_live_k', fetch: retryMock.fetchFn, retries: 2});
  await assert.rejects(
    () => gRetry.require({action: 'deploy.prod', summary: 'Deploy', timeoutMs: 120, pollIntervalMs: 250}),
    (err) => err instanceof GateTimeoutError,
  );
  assert.equal(pollCalls, 1, 'must not retry past overall gate deadline');

  // 3. WorkflowContext.approve / waitForSensor return terminal wait row on replay instead of parking forever.
  const replayMock = makeMockFetch({
    'POST /api/v1/code/workflows/runs/run-1/wait': ({body}) => ({
      status: 200,
      body: {id: 'wait-resolved', session_id: 's1', kind: body.kind, ask_id: body.ask_id, target_id: body.target_id, status: 'resolved', resolved_by: 'alice@acme.test', created_at: '2026-11-23T00:00:00Z'},
    }),
  });
  const wf = new Workflows({controlURL: 'https://app.caveman.so', apiKey: 'cave_live_k', fetch: replayMock.fetchFn});
  const wctx = new WorkflowContext(wf, 'run-1', 's1');
  const resolvedApproval = await wctx.approve({askId: 'deploy-1', reason: 'Deploy prod'});
  assert.equal(resolvedApproval.status, 'resolved');
  assert.equal(resolvedApproval.resolved_by, 'alice@acme.test');
  const resolvedSensor = await wctx.waitForSensor('sensor-99', {reason: 'Wait CI'});
  assert.equal(resolvedSensor.status, 'resolved');
});
