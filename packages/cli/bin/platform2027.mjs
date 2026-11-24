// `cvm apps`, `cvm listeners`, `cvm workflows`, `cvm pools`, `cvm key quick`,
// and `cvm skills add <primitive|all>` — unbundled 30-second CLI access to
// every Phase 0/1/2 Caveman platform primitive.
import {existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, cpSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {CloudError, inertJSON} from '../dist/cloud-client.mjs';

const usage = msg => Object.assign(new CloudError('cave_usage', msg, 2), {local: true});
const cavemanHome = process.env.CAVEMAN_HOME ?? join(homedir(), '.caveman');
export const personalKeyPath = join(cavemanHome, 'code-key');

async function apiReq(ctx, method, path, body) {
  const {baseURL, token} = await ctx();
  if (!token) throw new CloudError('cave_auth_required', 'Run `cvm login` (or set CAVE_TOKEN) first.', 3);
  const headers = {authorization: `Bearer ${token}`, 'x-cave-client': 'cvm'};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${baseURL.replace(/\/+$/, '')}${path}`, {
    method,
    headers,
    ...(body !== undefined ? {body: JSON.stringify(body)} : {}),
    signal: AbortSignal.timeout(30000),
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

function fail(error, pretty) {
  const code = error instanceof CloudError ? error.code : 'cave_failed';
  const exit = error instanceof CloudError ? error.exitCode : 1;
  process.stdout.write(inertJSON({ok: false, error: {code, message: error.message}}, pretty ? 2 : undefined) + '\n');
  return exit;
}

export function readCachedPersonalKey() {
  try {
    const raw = readFileSync(personalKeyPath, 'utf8').trim();
    return raw.startsWith('cave_') ? raw : '';
  } catch {
    return '';
  }
}

export async function bootstrapPersonalKey(ctx, {save = true, expiresInDays = 30} = {}) {
  const res = await apiReq(ctx, 'POST', '/api/v1/code/service-accounts/personal-key', {
    name: 'cvm-quick-key',
    expires_in_days: expiresInDays,
  });
  const fullKey = res?.key?.full_key || res?.key?.FullKey || '';
  if (save && fullKey) {
    mkdirSync(dirname(personalKeyPath), {recursive: true, mode: 0o700});
    writeFileSync(personalKeyPath, fullKey + '\n', {mode: 0o600});
    chmodSync(personalKeyPath, 0o600);
  }
  return {service_account: res.service_account, key_id: res?.key?.id, key_prefix: res?.key?.key_prefix, saved_to: save && fullKey ? personalKeyPath : null, full_key: fullKey};
}

export async function keyCmd(argv, {context}) {
  const pretty = Boolean(process.stdout.isTTY);
  const sub = argv[0];
  try {
    if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
      process.stdout.write('Usage: cvm key quick [--days 30] [--print]\n');
      return 0;
    }
    if (sub === 'quick') {
      const {values} = parseArgs({args: argv.slice(1), options: {days: {type: 'string'}, print: {type: 'boolean'}}});
      const res = await bootstrapPersonalKey(context, {save: true, expiresInDays: values.days ? Number(values.days) : 30});
      const shown = values.print ? res : {service_account: res.service_account, key_id: res.key_id, key_prefix: res.key_prefix, saved_to: res.saved_to};
      out(shown, pretty);
      return 0;
    }
    throw usage('Use: cvm key quick [--days 30] [--print]');
  } catch (err) {
    return fail(err, pretty);
  }
}

const STANDALONE_SKILLS = [
  'caveman-sandbox',
  'caveman-drive',
  'caveman-rooms',
  'caveman-deploy',
  'caveman-apps',
  'caveman-listeners',
  'caveman-workflows',
];

const SKILL_ALIASES = {
  sandbox: 'caveman-sandbox',
  sandboxes: 'caveman-sandbox',
  drive: 'caveman-drive',
  drives: 'caveman-drive',
  room: 'caveman-rooms',
  rooms: 'caveman-rooms',
  deploy: 'caveman-deploy',
  agents: 'caveman-deploy',
  app: 'caveman-apps',
  apps: 'caveman-apps',
  listener: 'caveman-listeners',
  listeners: 'caveman-listeners',
  workflow: 'caveman-workflows',
  workflows: 'caveman-workflows',
};

export async function skillsCmd(argv) {
  const pretty = Boolean(process.stdout.isTTY);
  const sub = argv[0];
  try {
    if (!sub || sub === 'list' || sub === '--help') {
      out({skills: STANDALONE_SKILLS, aliases: SKILL_ALIASES}, pretty);
      return 0;
    }
    if (sub === 'add') {
      const {values, positionals} = parseArgs({
        args: argv.slice(1),
        allowPositionals: true,
        options: {dir: {type: 'string'}},
      });
      const target = positionals[0];
      if (!target) throw usage('Use: cvm skills add <sandbox|drive|rooms|deploy|apps|listeners|workflows|all> [--dir PATH]');
      const wanted = target === 'all' ? STANDALONE_SKILLS : [SKILL_ALIASES[target] ?? target];
      const distSkills = fileURLToPath(new URL('../dist/skills', import.meta.url));
      const repoSkills = fileURLToPath(new URL('../../skills', import.meta.url));
      const targets = values.dir
        ? [values.dir]
        : [
            join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills'),
            join(homedir(), '.agents', 'skills'),
          ];
      const installed = [];
      for (const id of wanted) {
        const distSrc = join(distSkills, id);
        const repoSrc = join(repoSkills, id);
        const src = existsSync(distSrc) ? distSrc : repoSrc;
        if (!existsSync(src)) throw usage(`Unknown skill ${target}. Available: ${Object.keys(SKILL_ALIASES).join(', ')}, all`);
        for (const base of targets) {
          const dst = join(base, id);
          mkdirSync(dst, {recursive: true});
          cpSync(src, dst, {recursive: true});
        }
        installed.push(id);
      }
      out({ok: true, installed, targets}, pretty);
      return 0;
    }
    throw usage('Use: cvm skills list | cvm skills add <primitive|all>');
  } catch (err) {
    return fail(err, pretty);
  }
}

export async function appsCmd(argv, {context}) {
  const pretty = Boolean(process.stdout.isTTY);
  const sub = argv[0], rest = argv.slice(1);
  try {
    if (sub === '--help' || sub === '-h' || sub === 'help') {
      process.stdout.write('Usage: cvm apps list|create|fork|token|archive\n');
      return 0;
    }
    if (!sub || sub === 'list') {
      out(await apiReq(context, 'GET', '/api/v1/code/apps'), pretty);
      return 0;
    }
    if (sub === 'create') {
      const {values, positionals} = parseArgs({
        args: rest, allowPositionals: true,
        options: {name: {type: 'string'}, kind: {type: 'string'}, drive: {type: 'string'}, folder: {type: 'string'}, entry: {type: 'string'}, computer: {type: 'string'}, port: {type: 'string'}, scope: {type: 'string', multiple: true}},
      });
      if (!positionals[0]) throw usage('Use: cvm apps create SLUG --kind drive_static|sandbox_port|json_ui [--drive NAME] [--computer ID --port N]');
      out(await apiReq(context, 'POST', '/api/v1/code/apps', {
        slug: positionals[0], name: values.name || positionals[0], kind: values.kind || 'drive_static',
        drive: values.drive || '', drive_folder: values.folder || '', entry_file: values.entry || '',
        computer_id: values.computer || '', ...(values.port ? {port: Number(values.port)} : {}),
        manifest: {scopes: values.scope ?? ['drive:read']},
      }), pretty);
      return 0;
    }
    if (sub === 'fork') {
      const {values, positionals} = parseArgs({args: rest, allowPositionals: true, options: {name: {type: 'string'}, drive: {type: 'string'}}});
      if (positionals.length < 2) throw usage('Use: cvm apps fork SOURCE_APP NEW_SLUG [--drive NAME]');
      out(await apiReq(context, 'POST', `/api/v1/code/apps/${encodeURIComponent(positionals[0])}/fork`, {
        slug: positionals[1], name: values.name || '', drive_name: values.drive || '',
      }), pretty);
      return 0;
    }
    if (sub === 'token') {
      const {values, positionals} = parseArgs({args: rest, allowPositionals: true, options: {ttl: {type: 'string'}}});
      if (!positionals[0]) throw usage('Use: cvm apps token APP [--ttl 3600]');
      out(await apiReq(context, 'POST', `/api/v1/code/apps/${encodeURIComponent(positionals[0])}/token`, values.ttl ? {ttl_seconds: Number(values.ttl)} : {}), pretty);
      return 0;
    }
    if (sub === 'archive') {
      if (!rest[0]) throw usage('Use: cvm apps archive APP');
      out(await apiReq(context, 'POST', `/api/v1/code/apps/${encodeURIComponent(rest[0])}/archive`, {}), pretty);
      return 0;
    }
    throw usage('Use: cvm apps list|create|fork|token|archive');
  } catch (err) {
    return fail(err, pretty);
  }
}

export async function listenersCmd(argv, {context}) {
  const pretty = Boolean(process.stdout.isTTY);
  const sub = argv[0], rest = argv.slice(1);
  try {
    if (sub === '--help' || sub === '-h' || sub === 'help') {
      process.stdout.write('Usage: cvm listeners list|create|pause|resume|ingest|events|stats|delete\n');
      return 0;
    }
    if (!sub || sub === 'list') {
      out(await apiReq(context, 'GET', '/api/v1/code/listeners'), pretty);
      return 0;
    }
    if (sub === 'create') {
      const {values, positionals} = parseArgs({
        args: rest, allowPositionals: true,
        options: {source: {type: 'string'}, filter: {type: 'string'}, 'filter-kind': {type: 'string'}, target: {type: 'string'}, 'target-kind': {type: 'string'}, ttl: {type: 'string'}},
      });
      if (!positionals[0] || !values.target || !values['target-kind']) {
        throw usage('Use: cvm listeners create NAME --source webhook --target-kind room_post|session_wake|deployment|workflow --target ID [--filter JSON] [--ttl SECONDS]');
      }
      out(await apiReq(context, 'POST', '/api/v1/code/listeners', {
        name: positionals[0], source_kind: values.source || 'webhook', filter_kind: values['filter-kind'] || 'expression',
        filter_spec: values.filter ? JSON.parse(values.filter) : {},
        target_kind: values['target-kind'], target_id: values.target,
        ...(values.ttl ? {ttl_seconds: Number(values.ttl)} : {}),
      }), pretty);
      return 0;
    }
    if (sub === 'pause' || sub === 'resume') {
      if (!rest[0]) throw usage(`Use: cvm listeners ${sub} NAME`);
      out(await apiReq(context, 'POST', `/api/v1/code/listeners/${encodeURIComponent(rest[0])}/${sub}`, {}), pretty);
      return 0;
    }
    if (sub === 'stats' || sub === 'events') {
      if (!rest[0]) throw usage(`Use: cvm listeners ${sub} NAME`);
      out(await apiReq(context, 'GET', `/api/v1/code/listeners/${encodeURIComponent(rest[0])}/${sub}`), pretty);
      return 0;
    }
    if (sub === 'ingest') {
      if (rest.length < 2) throw usage('Use: cvm listeners ingest NAME JSON_PAYLOAD');
      out(await apiReq(context, 'POST', `/api/v1/code/listeners/${encodeURIComponent(rest[0])}/ingest`, JSON.parse(rest.slice(1).join(' '))), pretty);
      return 0;
    }
    if (sub === 'delete') {
      if (!rest[0]) throw usage('Use: cvm listeners delete NAME');
      out(await apiReq(context, 'DELETE', `/api/v1/code/listeners/${encodeURIComponent(rest[0])}`), pretty);
      return 0;
    }
    throw usage('Use: cvm listeners list|create|pause|resume|ingest|events|stats|delete');
  } catch (err) {
    return fail(err, pretty);
  }
}

export async function workflowsCmd(argv, {context}) {
  const pretty = Boolean(process.stdout.isTTY);
  const sub = argv[0], rest = argv.slice(1);
  try {
    if (sub === '--help' || sub === '-h' || sub === 'help') {
      process.stdout.write('Usage: cvm workflows list|create|run|get\n');
      return 0;
    }
    if (!sub || sub === 'list') {
      out(await apiReq(context, 'GET', '/api/v1/code/workflows'), pretty);
      return 0;
    }
    if (sub === 'create') {
      const {values, positionals} = parseArgs({
        args: rest, allowPositionals: true,
        options: {runtime: {type: 'string'}, drive: {type: 'string'}, path: {type: 'string'}, description: {type: 'string'}},
      });
      if (!positionals[0]) throw usage('Use: cvm workflows create NAME [--runtime typescript|python|go] [--drive NAME --path FILE]');
      out(await apiReq(context, 'POST', '/api/v1/code/workflows', {
        name: positionals[0], runtime: values.runtime || 'typescript', source_drive: values.drive || '', source_path: values.path || '', description: values.description || '',
      }), pretty);
      return 0;
    }
    if (sub === 'run') {
      const {values, positionals} = parseArgs({args: rest, allowPositionals: true, options: {input: {type: 'string'}, 'idempotency-key': {type: 'string'}}});
      if (!positionals[0]) throw usage('Use: cvm workflows run NAME [--input JSON]');
      out(await apiReq(context, 'POST', `/api/v1/code/workflows/${encodeURIComponent(positionals[0])}/runs`, {
        ...(values.input ? {input: JSON.parse(values.input)} : {}),
        ...(values['idempotency-key'] ? {idempotency_key: values['idempotency-key']} : {}),
      }), pretty);
      return 0;
    }
    if (sub === 'get') {
      if (!rest[0]) throw usage('Use: cvm workflows get RUN_ID');
      out(await apiReq(context, 'GET', `/api/v1/code/workflows/runs/${encodeURIComponent(rest[0])}`), pretty);
      return 0;
    }
    throw usage('Use: cvm workflows list|create|run|get');
  } catch (err) {
    return fail(err, pretty);
  }
}

export async function poolsCmd(argv, {context}) {
  const pretty = Boolean(process.stdout.isTTY);
  const sub = argv[0], rest = argv.slice(1);
  try {
    if (sub === '--help' || sub === '-h' || sub === 'help') {
      process.stdout.write('Usage: cvm pools list|create|computers|archive\n');
      return 0;
    }
    if (!sub || sub === 'list') {
      out(await apiReq(context, 'GET', '/api/v1/code/computer-pools'), pretty);
      return 0;
    }
    if (sub === 'create') {
      const {values, positionals} = parseArgs({
        args: rest, allowPositionals: true,
        options: {size: {type: 'string'}, network: {type: 'string'}, 'min-warm': {type: 'string'}, 'max-size': {type: 'string'}},
      });
      if (!positionals[0]) throw usage('Use: cvm pools create NAME [--size 2cpu-4gb] [--min-warm 2] [--max-size 16]');
      out(await apiReq(context, 'POST', '/api/v1/code/computer-pools', {
        name: positionals[0], size: values.size || '2cpu-4gb', network: values.network || 'internet',
        min_warm: values['min-warm'] ? Number(values['min-warm']) : 0,
        max_size: values['max-size'] ? Number(values['max-size']) : 16,
      }), pretty);
      return 0;
    }
    if (sub === 'computers') {
      const {values} = parseArgs({args: rest, options: {scope: {type: 'string'}}});
      const qs = values.scope ? `?scope=${encodeURIComponent(values.scope)}` : '';
      out(await apiReq(context, 'GET', `/api/v1/code/computers/unified${qs}`), pretty);
      return 0;
    }
    if (sub === 'archive') {
      if (!rest[0]) throw usage('Use: cvm pools archive POOL');
      out(await apiReq(context, 'POST', `/api/v1/code/computer-pools/${encodeURIComponent(rest[0])}/archive`, {}), pretty);
      return 0;
    }
    throw usage('Use: cvm pools list|create|computers|archive');
  } catch (err) {
    return fail(err, pretty);
  }
}
