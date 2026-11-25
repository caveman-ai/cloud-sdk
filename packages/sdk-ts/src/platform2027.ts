// Shared zero-dependency HTTP transport + strongly typed clients for Caveman
// Cloud's Phase 0/1/2 primitives: Rooms, Apps (+ AppBridge), Listeners (+
// Predicate builder), Code-First Durable Workflows, and N:M Computer Pools.
import {CloudError} from './cloud.js';

export {CloudError} from './cloud.js';

export interface PlatformClientOptions {
  /** Caveman Cloud API origin, e.g. https://app.caveman.so. */
  controlURL: string;
  /** Verified code:run API key (cave_live_...) or session token. */
  apiKey: string;
  /** Per-request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** Retry attempts on 429/5xx responses (default 2). */
  retries?: number;
  /** Base retry delay in milliseconds (default 250). */
  retryDelayMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class PlatformError extends CloudError {
  constructor(
    code: string,
    message: string,
    status: number,
    readonly retryAfter?: number,
  ) {
    super(code, message, status);
    this.name = 'PlatformError';
  }
}

export class WorkflowUncertainEffectError extends PlatformError {
  constructor(readonly stepKey: string, message = `Step ${stepKey} crashed mid-external effect; operator review required.`) {
    super('cave_workflow_uncertain_effect', message, 409);
    this.name = 'WorkflowUncertainEffectError';
  }
}

export class WorkflowParkedError extends PlatformError {
  constructor(readonly wait: SessionWait) {
    super('cave_workflow_parked', `Workflow parked waiting on ${wait.kind} (${wait.id}).`, 202);
    this.name = 'WorkflowParkedError';
  }
}

const MAX_PLATFORM_BODY_BYTES = 16 * 1024 * 1024;
const MAX_RETRY_AFTER_SECONDS = 60;

export class PlatformTransport {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly retryDelayMs: number;
  readonly fetchFn: typeof globalThis.fetch;

  constructor(opts: PlatformClientOptions) {
    const rawURL = opts.controlURL;
    if (typeof rawURL !== 'string' || !rawURL || rawURL !== rawURL.trim()) {
      throw new PlatformError('cave_endpoint_invalid', 'controlURL must be a valid URL without surrounding whitespace.', 0);
    }
    let u: URL;
    try {
      u = new URL(rawURL);
    } catch {
      throw new PlatformError('cave_endpoint_invalid', 'controlURL must be a valid URL.', 0);
    }
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
    ) {
      throw new PlatformError('cave_endpoint_invalid', 'controlURL must be HTTPS or loopback HTTP without credentials, query, or fragment.', 0);
    }
    if (!opts.apiKey?.trim()) {
      throw new PlatformError('cave_auth_required', 'apiKey is required.', 0);
    }
    const timeoutMs = opts.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new PlatformError('cave_timeout_invalid', 'timeoutMs must be a finite number between 100 and 120000.', 0);
    }
    this.baseURL = rawURL.replace(/\/+$/, '');
    this.apiKey = opts.apiKey.trim();
    this.timeoutMs = timeoutMs;
    this.retries = Math.max(0, Math.floor(opts.retries ?? 2));
    this.retryDelayMs = Math.max(0, opts.retryDelayMs ?? 250);
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: {signal?: AbortSignal; idempotencyKey?: string; rawBody?: string; timeoutMs?: number; deadlineMs?: number},
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.apiKey}`,
        'x-cave-client': 'caveman-sdk-ts',
      };
      if (opts?.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
      let payload: string | undefined;
      if (opts?.rawBody !== undefined) {
        headers['content-type'] = 'application/json';
        payload = opts.rawBody;
      } else if (body !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      let effectiveTimeout = this.timeoutMs;
      if (opts?.timeoutMs !== undefined && Number.isFinite(opts.timeoutMs)) {
        effectiveTimeout = Math.max(50, Math.min(effectiveTimeout, opts.timeoutMs));
      }
      if (opts?.deadlineMs !== undefined && Number.isFinite(opts.deadlineMs)) {
        const remaining = opts.deadlineMs - performance.now();
        if (remaining <= 0) {
          throw new PlatformError('cave_timeout', 'Request deadline exceeded.', 408);
        }
        effectiveTimeout = Math.max(1, Math.min(effectiveTimeout, remaining));
      }
      effectiveTimeout = Math.ceil(effectiveTimeout);
      const timeoutSignal = AbortSignal.timeout(effectiveTimeout);
      const signal = opts?.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
      const reqInit: RequestInit = {method, headers, signal, redirect: 'error'};
      if (payload !== undefined) reqInit.body = payload;
      let res: Response;
      try {
        res = await this.fetchFn(`${this.baseURL}${path}`, reqInit);
      } catch (err) {
        if (opts?.deadlineMs !== undefined && !opts?.signal?.aborted && performance.now() >= opts.deadlineMs) {
          throw new PlatformError('cave_timeout', 'Request deadline exceeded.', 408);
        }
        throw err;
      }
      const text = await res.text();
      if (new TextEncoder().encode(text).byteLength > MAX_PLATFORM_BODY_BYTES) {
        throw new PlatformError('cave_result_too_large', 'Response exceeds 16 MiB.', res.status);
      }
      let parsed: Record<string, unknown> = {};
      if (text) {
        try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = {}; }
      }
      if (res.ok) return parsed as T;
      const retryAfterRaw = res.headers.get('retry-after');
      const retryAfterNum = retryAfterRaw ? Number(retryAfterRaw) : undefined;
      const retryAfter = retryAfterNum !== undefined && Number.isFinite(retryAfterNum) && retryAfterNum >= 0
        ? Math.min(retryAfterNum, MAX_RETRY_AFTER_SECONDS)
        : undefined;
      if ((res.status === 429 || res.status >= 500) && attempt < this.retries) {
        attempt++;
        const waitMs = retryAfter !== undefined ? retryAfter * 1000 : this.retryDelayMs * 2 ** (attempt - 1);
        if (opts?.deadlineMs !== undefined && Number.isFinite(opts.deadlineMs)) {
          const remaining = opts.deadlineMs - performance.now();
          if (remaining <= 0 || waitMs >= remaining) {
            throw new PlatformError('cave_timeout', 'Request deadline exceeded during retry backoff.', 408);
          }
        }
        await sleepAbortable(waitMs, opts?.signal);
        continue;
      }
      const errObj = (parsed.error ?? {}) as {code?: string; message?: string};
      throw new PlatformError(errObj.code || `http_${res.status}`, errObj.message || `HTTP ${res.status}`, res.status, retryAfter);
    }
  }
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}

/* ================================ ROOMS ================================= */

export type RoomVisibility = 'org' | 'private';
export type RoomTaintPolicy = 'propagate' | 'strict' | 'trusted_only';
export type RoomThreadStatus = 'open' | 'ready' | 'claimed' | 'blocked' | 'waiting_human' | 'done' | 'closed';
export type RoomMessageKind = 'message' | 'task' | 'note' | 'ask' | 'app' | 'changeset' | 'status';

export interface Room {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  description: string;
  visibility: RoomVisibility;
  taint_policy: RoomTaintPolicy;
  created_at: string;
  updated_at: string;
}

export interface RoomThread {
  id: string;
  room_id: string;
  title: string;
  status: RoomThreadStatus;
  labels: string[];
  depends_on: string[];
  leased_by_kind?: string;
  leased_by_id?: string;
  lease_token?: string;
  lease_expires_at?: string;
  tainted: boolean;
  taint_sources: string[];
  message_seq: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface RoomMessage {
  id: string;
  room_id: string;
  thread_id: string;
  seq: number;
  sender_kind: string;
  sender_id: string;
  sender_name?: string;
  session_id?: string;
  kind: RoomMessageKind;
  body: string;
  structured_data?: unknown;
  app_ref?: unknown;
  tainted: boolean;
  taint_source?: string;
  created_at: string;
}

export interface RoomWatcher {
  id: string;
  room_id: string;
  thread_id?: string;
  watcher_kind: 'deployment' | 'session' | 'webhook';
  target_id: string;
  on_events: string[];
  enabled: boolean;
}

export interface RoomThreadRollup {
  thread_id: string;
  room_id: string;
  status: RoomThreadStatus;
  tainted: boolean;
  messages: number;
  session_count: number;
  session_ids: string[];
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  cost_basis: string;
  pull_requests: number;
}

export class Rooms {
  private readonly tx: PlatformTransport;
  constructor(opts: PlatformClientOptions) { this.tx = new PlatformTransport(opts); }

  create(input: {slug: string; name?: string; description?: string; visibility?: RoomVisibility; taint_policy?: RoomTaintPolicy}): Promise<Room> {
    return this.tx.request<Room>('POST', '/api/v1/code/rooms', input);
  }
  async list(): Promise<Room[]> {
    const res = await this.tx.request<{rooms: Room[]}>('GET', '/api/v1/code/rooms');
    return res.rooms ?? [];
  }
  get(room: string): Promise<Room> {
    return this.tx.request<Room>('GET', `/api/v1/code/rooms/${encodeURIComponent(room)}`);
  }
  archive(room: string): Promise<Room> {
    return this.tx.request<Room>('POST', `/api/v1/code/rooms/${encodeURIComponent(room)}/archive`, {});
  }
  createThread(room: string, input: {title: string; body?: string; status?: RoomThreadStatus; labels?: string[]; depends_on?: string[]; session_id?: string; structured_data?: unknown; app_ref?: unknown; untrusted?: boolean; taint_source?: string}): Promise<{thread: RoomThread; message?: RoomMessage}> {
    return this.tx.request('POST', `/api/v1/code/rooms/${encodeURIComponent(room)}/threads`, input);
  }
  async listThreads(room: string, opts?: {status?: RoomThreadStatus; label?: string; limit?: number}): Promise<RoomThread[]> {
    const q = new URLSearchParams();
    if (opts?.status) q.set('status', opts.status);
    if (opts?.label) q.set('label', opts.label);
    if (opts?.limit) q.set('limit', String(opts.limit));
    const qs = q.size ? `?${q}` : '';
    const res = await this.tx.request<{threads: RoomThread[]}>('GET', `/api/v1/code/rooms/${encodeURIComponent(room)}/threads${qs}`);
    return res.threads ?? [];
  }
  getThread(room: string, threadId: string): Promise<RoomThread> {
    return this.tx.request('GET', `/api/v1/code/rooms/${encodeURIComponent(room)}/threads/${encodeURIComponent(threadId)}`);
  }
  claim(room: string, threadId: string, opts?: {ttl_seconds?: number; session_id?: string}): Promise<RoomThread> {
    return this.tx.request('POST', `/api/v1/code/rooms/${encodeURIComponent(room)}/threads/${encodeURIComponent(threadId)}/claim`, opts ?? {});
  }
  renew(room: string, threadId: string, input: {lease_token: string; ttl_seconds?: number}): Promise<RoomThread> {
    return this.tx.request('POST', `/api/v1/code/rooms/${encodeURIComponent(room)}/threads/${encodeURIComponent(threadId)}/renew`, input);
  }
  release(room: string, threadId: string, input?: {lease_token?: string; note?: string; session_id?: string}): Promise<RoomThread> {
    return this.tx.request('POST', `/api/v1/code/rooms/${encodeURIComponent(room)}/threads/${encodeURIComponent(threadId)}/release`, input ?? {});
  }
  complete(room: string, threadId: string, input?: {lease_token?: string; note?: string; session_id?: string}): Promise<RoomThread> {
    return this.tx.request('POST', `/api/v1/code/rooms/${encodeURIComponent(room)}/threads/${encodeURIComponent(threadId)}/complete`, input ?? {});
  }
  post(room: string, threadId: string, input: {body: string; kind?: RoomMessageKind; sender_name?: string; session_id?: string; structured_data?: unknown; app_ref?: unknown; untrusted?: boolean; taint_source?: string; idempotency_key?: string}): Promise<RoomMessage> {
    const reqOpts = input.idempotency_key ? {idempotencyKey: input.idempotency_key} : undefined;
    return this.tx.request('POST', `/api/v1/code/rooms/${encodeURIComponent(room)}/threads/${encodeURIComponent(threadId)}/messages`, input, reqOpts);
  }
  listMessages(room: string, threadId: string, opts?: {after_seq?: number; limit?: number; session_id?: string}): Promise<{messages: RoomMessage[]; tainted: boolean}> {
    const q = new URLSearchParams();
    if (opts?.after_seq !== undefined) q.set('after_seq', String(opts.after_seq));
    if (opts?.limit !== undefined) q.set('limit', String(opts.limit));
    if (opts?.session_id) q.set('session_id', opts.session_id);
    const qs = q.size ? `?${q}` : '';
    return this.tx.request('GET', `/api/v1/code/rooms/${encodeURIComponent(room)}/threads/${encodeURIComponent(threadId)}/messages${qs}`);
  }
  wait(room: string, threadId: string, opts?: {after_seq?: number; timeout?: number; session_id?: string; signal?: AbortSignal}): Promise<{messages: RoomMessage[]; tainted: boolean; timed_out: boolean}> {
    const q = new URLSearchParams();
    if (opts?.after_seq !== undefined) q.set('after_seq', String(opts.after_seq));
    if (opts?.timeout !== undefined) q.set('timeout', String(opts.timeout));
    if (opts?.session_id) q.set('session_id', opts.session_id);
    const qs = q.size ? `?${q}` : '';
    const reqOpts = opts?.signal ? {signal: opts.signal} : undefined;
    return this.tx.request('GET', `/api/v1/code/rooms/${encodeURIComponent(room)}/threads/${encodeURIComponent(threadId)}/wait${qs}`, undefined, reqOpts);
  }
  watch(room: string, input: {watcher_kind: 'deployment' | 'session' | 'webhook'; target_id: string; thread_id?: string; filter_labels?: string[]; on_events?: string[]}): Promise<RoomWatcher> {
    return this.tx.request('POST', `/api/v1/code/rooms/${encodeURIComponent(room)}/watchers`, input);
  }
  rollup(room: string, threadId: string): Promise<RoomThreadRollup> {
    return this.tx.request('GET', `/api/v1/code/rooms/${encodeURIComponent(room)}/threads/${encodeURIComponent(threadId)}/rollup`);
  }

  /**
   * Atomically claims a task thread, automatically renews the lease on a
   * heartbeat while `fn` runs, completes the thread on success, or releases it
   * back to `ready` if `fn` throws.
   */
  async withLease<T>(
    room: string,
    threadId: string,
    fn: (thread: RoomThread) => Promise<T>,
    opts?: {ttlSeconds?: number; sessionId?: string; renewEveryMs?: number},
  ): Promise<T> {
    const ttlSeconds = opts?.ttlSeconds ?? 300;
    const claimReq: {ttl_seconds?: number; session_id?: string} = {ttl_seconds: ttlSeconds};
    if (opts?.sessionId) claimReq.session_id = opts.sessionId;
    const claimed = await this.claim(room, threadId, claimReq);
    const leaseToken = claimed.lease_token!;
    const renewMs = opts?.renewEveryMs ?? Math.max(5_000, Math.floor((ttlSeconds * 1000) / 2));
    const timer = setInterval(() => {
      void this.renew(room, threadId, {lease_token: leaseToken, ttl_seconds: ttlSeconds}).catch(() => {});
    }, renewMs) as unknown as {unref?: () => void};
    timer.unref?.();
    try {
      const result = await fn(claimed);
      clearInterval(timer as unknown as ReturnType<typeof setInterval>);
      const completeReq: {lease_token?: string; note?: string; session_id?: string} = {lease_token: leaseToken};
      if (opts?.sessionId) completeReq.session_id = opts.sessionId;
      await this.complete(room, threadId, completeReq);
      return result;
    } catch (err) {
      clearInterval(timer as unknown as ReturnType<typeof setInterval>);
      const releaseReq: {lease_token?: string; note?: string; session_id?: string} = {
        lease_token: leaseToken,
        note: err instanceof Error ? err.message : 'worker failed',
      };
      if (opts?.sessionId) releaseReq.session_id = opts.sessionId;
      await this.release(room, threadId, releaseReq).catch(() => {});
      throw err;
    }
  }
}

/* ================================= APPS ================================= */

export type AppKind = 'drive_static' | 'sandbox_port' | 'json_ui';
export type AppScope = 'drive:read' | 'drive:write' | 'room:read' | 'room:post' | 'deployment:run' | 'inbox:action';

export interface AppManifest {
  scopes?: AppScope[];
  drive_paths?: string[];
  deployments?: string[];
  rooms?: string[];
  default_title?: string;
  height?: number;
}

export interface TenantApp {
  id: string;
  slug: string;
  name: string;
  description: string;
  kind: AppKind;
  drive_id?: string;
  drive_folder?: string;
  entry_file: string;
  visibility: 'org' | 'private' | 'public';
  manifest: AppManifest;
  render_path: string;
}

export interface AppTokenIssued {
  token_id: string;
  app_id: string;
  token: string;
  scopes: AppScope[];
  render_url: string;
  expires_at: string;
}

export class Apps {
  private readonly tx: PlatformTransport;
  constructor(opts: PlatformClientOptions) { this.tx = new PlatformTransport(opts); }

  create(input: {slug: string; name?: string; description?: string; kind: AppKind; drive?: string; drive_folder?: string; entry_file?: string; computer_id?: string; port?: number; visibility?: 'org' | 'private' | 'public'; manifest?: AppManifest}): Promise<TenantApp> {
    return this.tx.request('POST', '/api/v1/code/apps', input);
  }
  async list(): Promise<TenantApp[]> {
    const res = await this.tx.request<{apps: TenantApp[]}>('GET', '/api/v1/code/apps');
    return res.apps ?? [];
  }
  get(app: string): Promise<TenantApp> {
    return this.tx.request('GET', `/api/v1/code/apps/${encodeURIComponent(app)}`);
  }
  fork(app: string, input: {slug: string; name?: string; drive_name?: string; description?: string}): Promise<TenantApp> {
    return this.tx.request('POST', `/api/v1/code/apps/${encodeURIComponent(app)}/fork`, input);
  }
  issueToken(app: string, input?: {ttl_seconds?: number; scopes?: AppScope[]; inbox_item_id?: string; room_thread_id?: string}): Promise<AppTokenIssued> {
    return this.tx.request('POST', `/api/v1/code/apps/${encodeURIComponent(app)}/token`, input ?? {});
  }
  archive(app: string): Promise<TenantApp> {
    return this.tx.request('POST', `/api/v1/code/apps/${encodeURIComponent(app)}/archive`, {});
  }
}

/** Lightweight client used inside isolated tenant App iframes. */
export class AppBridge {
  private readonly tx: PlatformTransport;
  constructor(readonly appId: string, opts: PlatformClientOptions) {
    this.tx = new PlatformTransport(opts);
  }
  driveRead(path: string): Promise<{path: string; text: string; version: number}> {
    return this.tx.request('POST', `/api/v1/code/apps/${encodeURIComponent(this.appId)}/bridge`, {action: 'drive.read', payload: {path}});
  }
  driveWrite(path: string, content: string): Promise<{path: string; version: number}> {
    return this.tx.request('POST', `/api/v1/code/apps/${encodeURIComponent(this.appId)}/bridge`, {action: 'drive.write', payload: {path, content}});
  }
  roomPost(room: string, threadId: string, body: string, structuredData?: unknown): Promise<{message: RoomMessage}> {
    return this.tx.request('POST', `/api/v1/code/apps/${encodeURIComponent(this.appId)}/bridge`, {action: 'room.post', payload: {room, thread_id: threadId, body, structured_data: structuredData}});
  }
}

/* ============================== LISTENERS =============================== */

export interface PredicateRule {
  path: string;
  op: 'eq' | 'neq' | 'contains' | 'icontains' | 'prefix' | 'suffix' | 'regex' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists';
  value?: unknown;
}

export interface PredicateFilter {
  all?: PredicateFilter[];
  any?: PredicateFilter[];
  not?: PredicateFilter;
  rule?: PredicateRule;
}

export const Predicate = {
  all: (...items: PredicateFilter[]): PredicateFilter => ({all: items}),
  any: (...items: PredicateFilter[]): PredicateFilter => ({any: items}),
  not: (item: PredicateFilter): PredicateFilter => ({not: item}),
  eq: (path: string, value: unknown): PredicateFilter => ({rule: {path, op: 'eq', value}}),
  neq: (path: string, value: unknown): PredicateFilter => ({rule: {path, op: 'neq', value}}),
  contains: (path: string, value: string): PredicateFilter => ({rule: {path, op: 'contains', value}}),
  icontains: (path: string, value: string): PredicateFilter => ({rule: {path, op: 'icontains', value}}),
  regex: (path: string, pattern: string): PredicateFilter => ({rule: {path, op: 'regex', value: pattern}}),
  inList: (path: string, values: unknown[]): PredicateFilter => ({rule: {path, op: 'in', value: values}}),
  gt: (path: string, value: number): PredicateFilter => ({rule: {path, op: 'gt', value}}),
  gte: (path: string, value: number): PredicateFilter => ({rule: {path, op: 'gte', value}}),
  exists: (path: string, value = true): PredicateFilter => ({rule: {path, op: 'exists', value}}),
};

export interface Listener {
  id: string;
  name: string;
  source_kind: 'webhook' | 'connector_poll' | 'room' | 'drive_changes' | 'sse' | 'kafka_bridge';
  filter_kind: 'none' | 'expression' | 'code_js' | 'model_fast';
  target_kind: 'deployment' | 'session_wake' | 'room_post' | 'workflow';
  target_id: string;
  hook_id?: string;
  hook_secret?: string;
  events_seen: number;
  events_matched: number;
  events_dropped: number;
  enabled: boolean;
  expires_at?: string;
}

export interface ListenerStats {
  listener_id: string;
  name: string;
  events_seen: number;
  events_matched: number;
  events_dropped: number;
  drop_rate: number;
  spend_usd: number;
  filter_basis: string;
}

export class Listeners {
  private readonly tx: PlatformTransport;
  constructor(opts: PlatformClientOptions) { this.tx = new PlatformTransport(opts); }

  create(input: {name: string; description?: string; source_kind: Listener['source_kind']; source_config?: Record<string, unknown>; filter_kind?: Listener['filter_kind']; filter_spec?: PredicateFilter | Record<string, unknown>; target_kind: Listener['target_kind']; target_id: string; target_config?: Record<string, unknown>; ttl_seconds?: number; budget_usd?: number}): Promise<Listener> {
    return this.tx.request('POST', '/api/v1/code/listeners', input);
  }
  async list(): Promise<Listener[]> {
    const res = await this.tx.request<{listeners: Listener[]}>('GET', '/api/v1/code/listeners');
    return res.listeners ?? [];
  }
  get(ref: string): Promise<Listener> {
    return this.tx.request('GET', `/api/v1/code/listeners/${encodeURIComponent(ref)}`);
  }
  pause(ref: string): Promise<Listener> {
    return this.tx.request('POST', `/api/v1/code/listeners/${encodeURIComponent(ref)}/pause`, {});
  }
  resume(ref: string): Promise<Listener> {
    return this.tx.request('POST', `/api/v1/code/listeners/${encodeURIComponent(ref)}/resume`, {});
  }
  delete(ref: string): Promise<{ok: boolean}> {
    return this.tx.request('DELETE', `/api/v1/code/listeners/${encodeURIComponent(ref)}`);
  }
  ingest(ref: string, payload: unknown, opts?: {trusted?: boolean}): Promise<{matched: boolean; dispatched_target_id?: string}> {
    const qs = opts?.trusted ? '?trusted=true' : '';
    return this.tx.request('POST', `/api/v1/code/listeners/${encodeURIComponent(ref)}/ingest${qs}`, payload);
  }
  stats(ref: string): Promise<ListenerStats> {
    return this.tx.request('GET', `/api/v1/code/listeners/${encodeURIComponent(ref)}/stats`);
  }
}

/* ============================== WORKFLOWS =============================== */

export interface SessionWait {
  id: string;
  session_id: string;
  kind: string;
  ask_id?: string;
  target_id?: string;
  status: string;
  expires_at?: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  version: number;
  runtime: 'typescript' | 'python' | 'go' | 'declarative';
  digest: string;
}

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  session_id: string;
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  input?: unknown;
  output?: unknown;
  error_code?: string;
  error_message?: string;
}

export type StepEffect = 'read' | 'write' | 'idempotent' | 'external';

export class WorkflowContext {
  constructor(private readonly wf: Workflows, readonly runId: string, readonly sessionId: string) {}

  /** Executes a deterministic/replayable step backed by code_session_steps. */
  async step<T>(
    stepKey: string,
    opts: {toolName?: string; effect?: StepEffect; kind?: 'code_tool' | 'subagent' | 'connector' | 'drive' | 'sandbox' | 'model'; input?: unknown},
    fn: () => Promise<T>,
  ): Promise<T> {
    const begun = await this.wf.beginStep(this.runId, {
      step_key: stepKey,
      tool_name: opts.toolName ?? stepKey,
      effect: opts.effect ?? 'idempotent',
      kind: opts.kind ?? 'code_tool',
      input: opts.input,
    });
    if (begun.action === 'cached') {
      if (begun.error_code) throw new PlatformError(begun.error_code, begun.error_message || 'Cached step failed.', 500);
      return begun.result as T;
    }
    if (begun.action === 'uncertain') {
      throw new WorkflowUncertainEffectError(stepKey);
    }
    try {
      const value = await fn();
      await this.wf.completeStep(this.runId, {step_key: stepKey, state: 'completed', result: value});
      return value;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.wf.completeStep(this.runId, {step_key: stepKey, state: 'failed', error_code: 'step_error', error_message: msg}).catch(() => {});
      throw err;
    }
  }

  /**
   * Parks the workflow run on a durable awakeable and throws WorkflowParkedError while pending.
   * On replay, if the wait already reached a terminal state (resolved, denied, timed_out, cancelled),
   * returns the terminal wait row so the workflow continues without parking forever.
   */
  async wait(input: {kind: string; ask_id?: string; target_id?: string; reason?: string; expires_at?: string}): Promise<SessionWait> {
    const w = await this.wf.parkWait(this.runId, input);
    const st = (w?.status ?? 'pending').toLowerCase();
    if (st === 'pending' || st === 'waiting' || st === '') {
      throw new WorkflowParkedError(w);
    }
    return w;
  }

  /** Parks on a durable zero-compute timer; returns the resolved wait row on replay. */
  sleep(seconds: number, reason = 'durable sleep'): Promise<SessionWait> {
    const expires_at = new Date(Date.now() + seconds * 1000).toISOString();
    return this.wait({kind: 'timer', expires_at, reason});
  }

  /** Parks and files a human Inbox decision item automatically; fails closed on replay unless approved/resolved. */
  async waitForApproval(askId: string, reason: string): Promise<SessionWait> {
    const w = await this.wait({kind: 'approval', ask_id: askId, reason});
    const st = (w?.status ?? '').toLowerCase();
    if (st !== 'resolved' && st !== 'approved') {
      throw new PlatformError(
        'workflow_approval_denied',
        `Workflow approval "${askId}" was not approved (status=${st || 'unknown'}).`,
        403,
      );
    }
    return w;
  }

  /** Caveman Gate alias inside durable workflows: parks at zero compute until a verified human approves; fails closed unless approved/resolved. */
  async approve(opts: {askId: string; reason: string; expiresAt?: string}): Promise<SessionWait> {
    const req: {kind: string; ask_id?: string; reason?: string; expires_at?: string} = {
      kind: 'approval',
      ask_id: opts.askId,
      reason: opts.reason,
    };
    if (opts.expiresAt) req.expires_at = opts.expiresAt;
    const w = await this.wait(req);
    const st = (w?.status ?? '').toLowerCase();
    if (st !== 'resolved' && st !== 'approved') {
      throw new PlatformError(
        'workflow_approval_denied',
        `Workflow approval "${opts.askId}" was not approved (status=${st || 'unknown'}).`,
        403,
      );
    }
    return w;
  }

  /** Parks at zero compute until a Caveman Sensor (`listener_event`) matches and wakes this workflow; returns the terminal wait on replay. */
  waitForSensor(sensorId: string, opts?: {askId?: string; reason?: string; expiresAt?: string}): Promise<SessionWait> {
    const req: {kind: string; ask_id?: string; target_id?: string; reason?: string; expires_at?: string} = {
      kind: 'listener_event',
      target_id: sensorId,
      ask_id: opts?.askId ?? `sensor:${sensorId}`,
    };
    if (opts?.reason) req.reason = opts.reason;
    if (opts?.expiresAt) req.expires_at = opts.expiresAt;
    return this.wait(req);
  }
}

export class Workflows {
  private readonly tx: PlatformTransport;
  constructor(opts: PlatformClientOptions) { this.tx = new PlatformTransport(opts); }

  create(input: {name: string; runtime: WorkflowDefinition['runtime']; description?: string; source_drive?: string; source_path?: string; entry_code?: string}): Promise<WorkflowDefinition> {
    return this.tx.request('POST', '/api/v1/code/workflows', input);
  }
  async list(): Promise<WorkflowDefinition[]> {
    const res = await this.tx.request<{workflows: WorkflowDefinition[]}>('GET', '/api/v1/code/workflows');
    return res.workflows ?? [];
  }
  startRun(workflow: string, input?: {input?: unknown; idempotency_key?: string}): Promise<WorkflowRun> {
    const reqOpts = input?.idempotency_key ? {idempotencyKey: input.idempotency_key} : undefined;
    return this.tx.request('POST', `/api/v1/code/workflows/${encodeURIComponent(workflow)}/runs`, input ?? {}, reqOpts);
  }
  getRun(runId: string): Promise<WorkflowRun> {
    return this.tx.request('GET', `/api/v1/code/workflows/runs/${encodeURIComponent(runId)}`);
  }
  beginStep(runId: string, input: {step_key: string; tool_name: string; effect?: StepEffect; kind?: string; input?: unknown}): Promise<{action: 'execute' | 'cached' | 'uncertain'; step_key: string; result?: unknown; error_code?: string; error_message?: string}> {
    return this.tx.request('POST', `/api/v1/code/workflows/runs/${encodeURIComponent(runId)}/steps/begin`, input);
  }
  completeStep(runId: string, input: {step_key: string; state?: 'completed' | 'failed'; result?: unknown; error_code?: string; error_message?: string}): Promise<{ok: boolean}> {
    return this.tx.request('POST', `/api/v1/code/workflows/runs/${encodeURIComponent(runId)}/steps/complete`, input);
  }
  parkWait(runId: string, input: {kind: string; ask_id?: string; target_id?: string; barrier_id?: string; expires_at?: string; reason?: string}): Promise<SessionWait> {
    return this.tx.request('POST', `/api/v1/code/workflows/runs/${encodeURIComponent(runId)}/wait`, input);
  }
  finishRun(runId: string, input: {status: 'completed' | 'failed' | 'cancelled'; output?: unknown; error_code?: string; error_message?: string}): Promise<WorkflowRun> {
    return this.tx.request('POST', `/api/v1/code/workflows/runs/${encodeURIComponent(runId)}/finish`, input);
  }

  /** High-level durable execution wrapper: starts/resumes a run, executes handler with WorkflowContext, and commits final output. */
  async execute<I, O>(workflow: string, input: I, handler: (ctx: WorkflowContext, input: I) => Promise<O>, opts?: {idempotencyKey?: string}): Promise<{run: WorkflowRun; output?: O; parked?: SessionWait}> {
    const startReq: {input?: unknown; idempotency_key?: string} = {input};
    if (opts?.idempotencyKey) startReq.idempotency_key = opts.idempotencyKey;
    const run = await this.startRun(workflow, startReq);
    const ctx = new WorkflowContext(this, run.id, run.session_id);
    try {
      const output = await handler(ctx, input);
      const finished = await this.finishRun(run.id, {status: 'completed', output});
      return {run: finished, output};
    } catch (err) {
      if (err instanceof WorkflowParkedError) {
        return {run: {...run, status: 'waiting'}, parked: err.wait};
      }
      const msg = err instanceof Error ? err.message : String(err);
      await this.finishRun(run.id, {status: 'failed', error_code: 'workflow_error', error_message: msg}).catch(() => {});
      throw err;
    }
  }
}

/* =========================== COMPUTER POOLS ============================= */

export interface ComputerPool {
  id: string;
  name: string;
  size: string;
  network: 'none' | 'internet';
  min_warm: number;
  max_size: number;
  active_leases: number;
}

export interface SessionComputerLease {
  id: string;
  session_id: string;
  computer_id: string;
  pool_id?: string;
  role: 'primary' | 'worker' | 'experiment';
  label?: string;
  leased_at: string;
}

export class ComputerPools {
  private readonly tx: PlatformTransport;
  constructor(opts: PlatformClientOptions) { this.tx = new PlatformTransport(opts); }

  create(input: {name: string; size?: string; network?: 'none' | 'internet'; min_warm?: number; max_size?: number; description?: string}): Promise<ComputerPool> {
    return this.tx.request('POST', '/api/v1/code/computer-pools', input);
  }
  async list(): Promise<ComputerPool[]> {
    const res = await this.tx.request<{pools: ComputerPool[]}>('GET', '/api/v1/code/computer-pools');
    return res.pools ?? [];
  }
  leaseForSession(sessionId: string, input: {pool?: string; computer_id?: string; role?: 'primary' | 'worker' | 'experiment'; label?: string}): Promise<SessionComputerLease> {
    return this.tx.request('POST', `/api/v1/code/sessions/${encodeURIComponent(sessionId)}/computers`, input);
  }
  async listForSession(sessionId: string): Promise<SessionComputerLease[]> {
    const res = await this.tx.request<{computers: SessionComputerLease[]}>('GET', `/api/v1/code/sessions/${encodeURIComponent(sessionId)}/computers`);
    return res.computers ?? [];
  }
  releaseForSession(sessionId: string, computerId: string): Promise<{ok: boolean}> {
    return this.tx.request('DELETE', `/api/v1/code/sessions/${encodeURIComponent(sessionId)}/computers/${encodeURIComponent(computerId)}`);
  }
  async listUnified(scope: 'all' | 'personal' | 'org_pool' | 'session' | 'local' = 'all'): Promise<unknown[]> {
    const res = await this.tx.request<{computers: unknown[]}>('GET', `/api/v1/code/computers/unified?scope=${encodeURIComponent(scope)}`);
    return res.computers ?? [];
  }
}
