import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Caveman, PlatformError} from '../dist/index.js';
import {AppBridge} from '../dist/app-bridge.js';

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      const out = await handler({method: req.method, url: req.url, headers: req.headers, body});
      res.writeHead(out.status ?? 200, {'content-type': 'application/json'});
      res.end(JSON.stringify(out.body ?? {}));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('Caveman unified client requires apiKey when env is absent', () => {
  const prevKey = process.env.CAVEMAN_API_KEY;
  const prevTok = process.env.CAVE_TOKEN;
  delete process.env.CAVEMAN_API_KEY;
  delete process.env.CAVE_TOKEN;
  try {
    assert.throws(() => new Caveman(), (err) => err instanceof PlatformError && err.code === 'cave_auth_required');
  } finally {
    if (prevKey !== undefined) process.env.CAVEMAN_API_KEY = prevKey;
    if (prevTok !== undefined) process.env.CAVE_TOKEN = prevTok;
  }
});

test('Caveman unified client wires inference, agents, sessions, drives, connectors, secrets, rooms, apps, credits, and app-bridge', async () => {
  const seen = [];
  const srv = await startMockServer(({method, url, headers, body}) => {
    seen.push({method, url, auth: headers.authorization, body});
    if (url === '/v1/models') return {body: {data: [{id: 'anthropic/claude-sonnet-4-6'}]}};
    if (url === '/api/v1/credits') return {body: {balance_usd: 42.5}};
    if (url === '/api/v1/code/drives') return {body: {drives: [{id: 'drv_1', name: 'knowledge'}]}};
    if (url === '/api/v1/code/drives/knowledge/grep') return {body: {matches: [{path: '/policy.md', line: 3, text: 'refund', cut: false, version: 1}], coverage: {files_searched: 1, skipped_binary: 0, skipped_large: 0, skipped_by_glob: 0, bytes_scanned: 40, long_lines: 0, stopped: ''}}};
    if (url === '/api/v1/code/connectors') return {body: {connectors: [{name: 'github', state: 'connected'}]}};
    if (url === '/api/v1/code/secrets' && method === 'PUT') return {body: {name: 'STRIPE_KEY', scope: 'org'}};
    if (url === '/api/v1/code/secrets' && method === 'GET') return {body: {secrets: [{name: 'STRIPE_KEY', scope: 'org'}]}};
    if (url === '/api/v1/code/deployments/triage/sessions') return {body: {id: 'sess_1', status: 'running'}};
    if (url === '/api/v1/code/sessions/sess_1/events') return {body: {id: 'mail_1', verb: 'answer'}};
    if (url === '/api/v1/code/rooms') return {body: {rooms: [{id: 'rm_1', slug: 'ops'}]}};
    if (url === '/api/v1/code/apps') return {body: {apps: [{id: 'app_1', slug: 'dashboard'}]}};
    if (url === '/api/v1/code/apps/app_1/bridge') return {body: {path: '/notes.md', text: 'hello', version: 2}};
    return {status: 404, body: {error: {code: 'not_found', message: 'no route'}}};
  });

  try {
    const cv = new Caveman({apiKey: 'cave_live_test123', baseURL: srv.url, controlURL: srv.url});

    const models = await cv.inference.models();
    assert.equal(models[0].id, 'anthropic/claude-sonnet-4-6');

    const credits = await cv.credits.get();
    assert.equal(credits.balance_usd, 42.5);

    const drives = await cv.drives.list();
    assert.equal(drives[0].name, 'knowledge');
    const hits = await cv.drives.drive('knowledge').grep({pattern: 'refund'});
    assert.equal(hits.matches[0].path, '/policy.md');

    const connectors = await cv.connectors.list();
    assert.equal(connectors[0].name, 'github');

    const createdSecret = await cv.secrets.set({name: 'STRIPE_KEY', value: 'sk_test_123'});
    assert.equal(createdSecret.name, 'STRIPE_KEY');
    const secrets = await cv.secrets.list();
    assert.equal(secrets[0].name, 'STRIPE_KEY');

    const sess = await cv.agents.run('triage', {request_id: 'req_1', task: 'Check alerts'});
    assert.equal(sess.id, 'sess_1');
    const approved = await cv.sessions.approve('sess_1', 'ask_1', 'req_2', 'ok');
    assert.equal(approved.id, 'mail_1');

    const rooms = await cv.rooms.list();
    assert.equal(rooms[0].slug, 'ops');

    const apps = await cv.apps.list();
    assert.equal(apps[0].slug, 'dashboard');

    const bridge = new AppBridge('app_1', {controlURL: srv.url, apiKey: 'capp_token_123'});
    const read = await bridge.driveRead('/notes.md');
    assert.equal(read.text, 'hello');

    assert.ok(seen.every((r) => r.auth?.startsWith('Bearer ')));
  } finally {
    await srv.close();
  }
});
