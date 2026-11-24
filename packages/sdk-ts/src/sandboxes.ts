// Sandboxes: computers made and used from outside them, the API's /code/computers, for an
// organization's code:run key (a sandbox is a computer as the console shows it). The plain calls
// (list, create, get, sleep, resume, delete; a sandbox's snapshots: snapshot, listSnapshots,
// getSnapshot, deleteSnapshot, restore, fork) and the wire types are generated from the contract
// (sandboxes.generated.ts, scripts/generate-cloud-sdk.mjs). This file is what a generator does not do
// well: the transport with its retries and typed errors, a command's stream into a sandbox (a
// WebSocket on the relay, subprotocol caveman.computer.v1), waiting for a state (the API holds a
// read until the state, GET's wait_for; a Caveman Cloud that does not is polled), and waiting for a
// snapshot to be taken or restored (polled: the API holds no snapshot read).
//
// A port at its own URL (url(): where the installation serves https://<port>-<sandbox>.<domain>) is a token and
// a link from the API; a port's dial (dialPort) is a stream at the relay that needs no URL.
//
// The key decides everything: the organization and the service account come from it, never from a
// request, and a key sees only the sandboxes its service account made. A command's stream needs
// Node (node:http and node:https); the plain calls need only fetch.
import {CloudError} from './cloud.js';
import {SandboxesAPI, sandboxErrorPrefixes, sandboxReasons, sandboxRoutes, sandboxStream, type CodeComputer, type CodeComputerSnapshot, type SandboxCallOptions,
  type SandboxErrorCode, type SandboxRoute, type SandboxState, type SandboxStreamErrorCode} from './sandboxes.generated.js';

export * from './sandboxes.generated.js';
export {CloudError} from './cloud.js';

export interface SandboxesOptions {
  /** The Cloud API origin, such as https://app.caveman.so. */
  controlURL: string;
  /** An organization's code:run key (cave_live_...): it acts as its service account. */
  apiKey: string;
  /** The origin that serves /relay (a command's stream); absent, controlURL. */
  relayURL?: string;
  /** Bounds each call; default 30000. A command's stream has no timeout of its own: its signal ends it. */
  timeoutMs?: number;
  /** How many more times a call is made when the API says it may be asked again; default 3. */
  retries?: number;
  /** The first wait before asking again, doubled each time; default 250. A Retry-After wins. */
  retryDelayMs?: number;
  fetch?: typeof globalThis.fetch;
}

/**
 * A refusal from the API: its error code (one the contract documents, or a later one), message and HTTP status, and
 * retryAfter, the seconds it asked to wait before asking again (its Retry-After), absent when it named none.
 */
export class SandboxError extends CloudError {
  constructor(code: SandboxErrorCode | (string & {}), message: string, status: number, readonly requestId?: string, readonly retryAfter?: number) {
    super(code, message, status);
    this.name = 'SandboxError';
  }
  /** A limit reached on making or waking a sandbox (the plan's or the installation's). */
  get limitReached(): boolean { return sandboxErrorPrefixes.some(prefix => this.code.startsWith(prefix)); }
}

/**
 * A command's stream that ended without the command's exit code: refused before it opened (status is the HTTP
 * status), or ended by the sandbox or the relay (code is one of sandboxStream.errors; closeCode the WebSocket close
 * code when the stream closed without saying why; retryAfter the seconds the far end asked to wait before opening
 * the stream again, as a Retry-After or an error's retry_after says).
 */
export class SandboxExecError extends CloudError {
  constructor(code: SandboxStreamErrorCode | (string & {}), message: string, status = 0, readonly closeCode?: number, readonly retryAfter?: number) {
    super(code, message, status);
    this.name = 'SandboxExecError';
  }
}

/**
 * A file operation's or a port's stream that ended without its answer: what the sandbox's file system refused
 * (cave_code_computer_file_not_found, _file_permission, _file_exists, _file_too_large, _file_refused, with the
 * system's own words), nothing listening on the port (cave_code_computer_port_refused), or any of a stream's codes.
 */
export class SandboxFileError extends SandboxExecError {
  constructor(code: SandboxStreamErrorCode | (string & {}), message: string, status = 0, closeCode?: number, retryAfter?: number) {
    super(code, message, status, closeCode, retryAfter);
    this.name = 'SandboxFileError';
  }
}

/** A file in a sandbox, as a file operation describes it: mode is its permission bits, mtime UTC (RFC 3339). */
export interface SandboxFileInfo {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  mode: number;
  mtime: string;
  /** Where a symbolic link points. */
  link?: string;
}

/** A file operation's options: root acts as the sandbox's root, not its tool-process user (a full sandbox's). */
export interface FileOptions {
  root?: boolean;
  signal?: AbortSignal;
}

export interface WriteFileOptions extends FileOptions {
  /** A new file's permission bits; 0o644 when absent. */
  mode?: number;
  /** Written beside the path and renamed over it, so a reader finds the old file or the new one. */
  atomic?: boolean;
}

/**
 * A TCP connection to a port on a sandbox's own loopback, through the relay. Iterate it for the bytes the sandbox
 * sends, until its side half-closes or the connection ends; a refusal (nothing listening: port_refused) is thrown
 * there and rejects closed.
 */
export interface SandboxConnection extends AsyncIterable<Uint8Array> {
  /** Sends bytes; resolves once they are written to the stream. */
  write(data: Uint8Array | string): Promise<void>;
  /** Says this side sends no more (a half close); the sandbox's side may go on sending. */
  closeWrite(): void;
  /** Ends the connection. */
  close(): void;
  /** Settles when the connection has ended: resolved on a normal end, rejected with its error otherwise. */
  readonly closed: Promise<void>;
}

/** url()'s options: how long the token opens the port, and whether to make the port public or private first. */
export interface SandboxURLOptions {
  /** 60 to 86400 seconds; an hour when absent. */
  ttlSeconds?: number;
  /** true: make the port public first (the sandbox's maker alone may); false: private; absent: leave it as it is. */
  public?: boolean;
  signal?: AbortSignal;
}

/** A sandbox's port at its own URL, as url() answers it. Times are RFC 3339, as the API says them. */
export interface SandboxPortURL {
  /** https://<port>-<sandbox>.<domain>. */
  url: string;
  /** Opens the port in a browser until linkExpiresAt; it is a credential while it lasts, so share it as one. */
  link: string;
  linkExpiresAt: string;
  /** cvp_...: send it as headers say, never in a URL. */
  token: string;
  /** What a program sends with each request to url: {'Caveman-Port-Token': token}. The relay takes it off. */
  headers: Record<string, string>;
  /** When the token, and the cookie a link leaves, stop opening the port. */
  expiresAt: string;
  /** The port's visibility now: private (a token opens it) or public (anyone with the address). */
  visibility: 'private' | 'public';
}

/**
 * A wait that cannot end in the state it waits for: the sandbox failed, its reason needs the caller (its
 * observed_reason_code is one whose wait ends: ended, out_of_memory, disk_lost, ...), or it is asked to be something else.
 */
export class SandboxStateError extends CloudError {
  constructor(readonly sandbox: CodeComputer, readonly want: SandboxState) {
    const reason = sandbox.observed_reason ? `: ${sandbox.observed_reason}` : '.';
    super('cave_sandbox_state', sandbox.observed_state === 'failed' ? `Sandbox ${sandbox.id} failed${reason}`
      : sandboxWaitEnds(sandbox) ? `Sandbox ${sandbox.id} is ${sandbox.observed_state}${reason}`
        : `Sandbox ${sandbox.id} is asked to be ${sandbox.desired_state}, so it will not be ${want}.`);
    this.name = 'SandboxStateError';
  }
}

/**
 * A wait for a snapshot that cannot end as waited for: its take failed (reason_code says why) or it is being deleted
 * or is deleted (waitForSnapshot); its restore failed, or none was asked (waitForRestore). snapshot is what it read.
 */
export class SnapshotStateError extends CloudError {
  constructor(readonly snapshot: CodeComputerSnapshot, readonly restore = false) {
    const said = (reason: string) => reason ? `: ${reason}` : '.';
    super('cave_snapshot_state', !restore ? `Snapshot ${snapshot.id} is ${snapshot.state}${said(snapshot.reason)}`
      : snapshot.restore.state === 'none' ? `Snapshot ${snapshot.id} has no restore asked of it.`
        : `The restore of snapshot ${snapshot.id} ${snapshot.restore.state === 'failed' ? 'failed' : `is ${snapshot.restore.state}`}${said(snapshot.restore.reason)}`);
    this.name = 'SnapshotStateError';
  }
}

/**
 * Whether a wait ends on what a sandbox reads now, it not being in the state waited for: by its reason's code
 * (sandboxReasons), one that passes by itself never (not even while it reads failed), one that needs the caller always;
 * with no code, or one this client does not know, once it has failed.
 */
function sandboxWaitEnds(sandbox: CodeComputer): boolean {
  const code = sandbox.observed_reason_code;
  const wait = code !== undefined && Object.hasOwn(sandboxReasons, code) ? sandboxReasons[code as keyof typeof sandboxReasons] : 'ends_if_failed';
  return wait === 'ends' || (wait === 'ends_if_failed' && sandbox.observed_state === 'failed');
}

export interface ExecOptions {
  /**
   * Sent to the command, then its stdin is closed; absent, it is closed at once. A stdin that fails to read ends the
   * command's input. An iterable is read until the stream ends, then its return() is called (a Node stream is destroyed).
   */
  stdin?: string | Uint8Array | AsyncIterable<Uint8Array | string>;
  /** Runs the command on a terminal: its stderr comes on stdout. cols and rows set its size. */
  tty?: boolean;
  /** The command's environment variables, beside the sandbox's (sandboxStream.options bounds them). */
  env?: Record<string, string>;
  /** The folder the command runs in: an absolute path. */
  cwd?: string;
  /** The user the command runs as. */
  user?: string;
  /** With tty, the terminal's columns and rows (each 1 to sandboxStream.options.max_term_size). */
  cols?: number;
  rows?: number;
  /** Each piece of stdout as it comes; a promise holds the stream until it settles. Absent, discarded. */
  stdout?: (chunk: Uint8Array) => void | Promise<void>;
  stderr?: (chunk: Uint8Array) => void | Promise<void>;
  /** Ends the stream, and with it the command. */
  signal?: AbortSignal;
  /** Resizes the running command's terminal and sends it signals (SandboxCommand). */
  control?: SandboxCommand;
  /** A resize or a signal the sandbox did not act on: why, as it said; the command goes on. */
  onRefused?: (refusal: SandboxRefusal) => void;
}

/**
 * A sandbox's answer to a resize or a signal it did not act on (a sandbox that takes no options, a resize of a
 * command with no terminal): of is resize or signal; code is the API's.
 */
export interface SandboxRefusal { of: string; code: string; message: string }

/** A signal a stream may send a command (sandboxStream.options.signals), with or without SIG. */
export type SandboxSignal = typeof sandboxStream.options.signals[number] | `SIG${typeof sandboxStream.options.signals[number]}`;

/**
 * Speaks to a running command (ExecOptions.control): resizes its terminal and sends its process group a signal. What
 * is asked before the command's stream opens is sent once it does; what the sandbox does not act on comes back to
 * ExecOptions.onRefused.
 */
export class SandboxCommand {
  private send: ((message: Record<string, unknown>) => void) | undefined;
  private pending: Record<string, unknown>[] = [];

  /** The terminal's new size, each 1 to sandboxStream.options.max_term_size. */
  resize(cols: number, rows: number): void {
    checkSize(cols, rows);
    this.post({type: sandboxStream.types.resize, cols, rows});
  }

  /** Sends the command's process group a signal by name: TERM unless said. */
  sendSignal(name: SandboxSignal = 'TERM'): void {
    const bare = String(name).replace(/^SIG/, '');
    if (!(sandboxStream.options.signals as readonly string[]).includes(bare))
      throw new SandboxExecError('cave_bad_request', `A command may be sent ${sandboxStream.options.signals.join(', ')}, not ${String(name)}.`);
    this.post({type: sandboxStream.types.signal, signal: bare});
  }

  private post(message: Record<string, unknown>): void {
    if (this.send) this.send(message);
    else this.pending.push(message);
  }

  /** Binds the command's open stream (exec's), sending what waited; undefined unbinds it. @internal */
  bind(send: ((message: Record<string, unknown>) => void) | undefined): void {
    this.send = send;
    if (!send) return;
    for (const message of this.pending.splice(0)) send(message);
  }
}

export interface ExecResult { exitCode: number; stdout: string; stderr: string }

export interface WaitOptions {
  /** How long to wait in all; default 600000 (10 minutes). */
  timeoutMs?: number;
  /** The longest pause between reads, where the API does not wait and the client polls; default 1000. */
  intervalMs?: number;
  signal?: AbortSignal;
}

/** How long the API holds one waiting read at most (GET /code/computers/{id}'s timeout), in seconds. */
const maxWaitSeconds = 60;
/** The header the API says how a waiting read ended in; a Caveman Cloud that does not wait sends none. */
const waitHeader = 'cave-wait';

const maxBytes = 16 * 1024 * 1024;
/**
 * The longest this client waits before asking again, in ms: a Retry-After past it (an organization's start ceiling
 * names up to a day) is the caller's to wait out, not a retry's.
 */
const maxRetryWaitMs = 30000;
const loopback = ['localhost', '127.0.0.1', '[::1]'];
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(signal?.reason); };
  signal?.addEventListener('abort', stop, {once: true});
});

function origin(raw: string, what: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new CloudError('cave_endpoint_invalid', `${what} is not a URL.`); }
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, '') !== '' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback.includes(url.hostname))))
    throw new CloudError('cave_endpoint_invalid', `${what}: use an HTTPS origin, or HTTP on this machine, with no path, credentials, query or fragment.`);
  return url.origin;
}

/** Makes, runs commands in, and puts away sandboxes. */
export class Sandboxes extends SandboxesAPI {
  private readonly endpoint: string;
  private readonly relay: string;
  private readonly key: string;
  private readonly timeout: number;
  private readonly retries: number;
  private readonly retryDelay: number;
  private readonly transport: typeof globalThis.fetch;

  constructor(options: SandboxesOptions) {
    super();
    this.endpoint = origin(options.controlURL, 'controlURL') + '/api/v1';
    this.relay = options.relayURL ? origin(options.relayURL, 'relayURL') : origin(options.controlURL, 'controlURL');
    if (!options.apiKey?.trim()) throw new CloudError('cave_auth_required', 'A code:run key is required.');
    this.key = options.apiKey;
    this.timeout = options.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 100 || this.timeout > 600000) throw new CloudError('cave_timeout_invalid', 'timeoutMs must be 100–600000.');
    this.retries = Math.max(0, options.retries ?? 3);
    this.retryDelay = Math.max(0, options.retryDelayMs ?? 250);
    this.transport = options.fetch ?? globalThis.fetch;
  }

  /**
   * One call, made again while the API says it may be: a GET (safe) after a dropped connection or a 502, 503 or 504;
   * any call refused with 429 (the server did nothing); a call refused with one of the route's retryOn codes (a
   * delete's cave_code_computer_busy). A Retry-After is waited for, up to 30 s; one longer is thrown at once, its
   * seconds on the error (retryAfter), for the caller to decide. Nothing else is repeated: a create whose answer was
   * lost is not made twice.
   */
  protected async send<T>(route: SandboxRoute, path: string, query: Record<string, unknown> | undefined, body: unknown, options: SandboxCallOptions): Promise<T> {
    return (await this.request<T>(route, path, query, body, options)).body;
  }

  /** send, answering the response's headers too; timeoutMs bounds this call in place of the client's timeout. */
  private async request<T>(route: SandboxRoute, path: string, query: Record<string, unknown> | undefined, body: unknown,
    options: SandboxCallOptions & {timeoutMs?: number}): Promise<{body: T; headers: Headers}> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null) search.set(key, String(value));
    const url = this.endpoint + path + (search.size ? '?' + search : '');
    for (let attempt = 0; ; attempt++) {
      let status = 0, failure: unknown, wait = this.retryDelay * 2 ** Math.min(attempt, 4), after: number | undefined;
      try {
        const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeout);
        const response = await this.transport(url, {
          method: route.method, redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
          headers: {authorization: 'Bearer ' + this.key, accept: 'application/json', ...(body === undefined ? {} : {'content-type': 'application/json'})},
          ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        });
        status = response.status;
        const text = await response.text();
        if (text.length > maxBytes) throw new SandboxError('cave_response_too_large', 'The response is larger than this SDK reads.', status);
        let parsed: unknown;
        try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
        if (response.ok) {
          if (parsed === undefined && response.status !== 204) throw new SandboxError('cave_response_invalid', 'The response is not JSON.', status);
          return {body: parsed as T, headers: response.headers};
        }
        const error = (parsed as {error?: {code?: string; message?: string; request_id?: string}} | undefined)?.error;
        let message = error?.message ?? `Request failed (${status}).`;
        if (status === 405) message = `${message} This Caveman Cloud does not offer sandboxes through its API (computers.api.enabled is off).`;
        const named = Number(response.headers.get('retry-after'));
        if (response.headers.has('retry-after') && Number.isFinite(named) && named >= 0) wait = (after = named) * 1000;
        failure = new SandboxError(error?.code ?? 'cave_request_failed', message, status, error?.request_id ?? response.headers.get('x-cave-request-id') ?? undefined, after);
      } catch (error) {
        if (error instanceof SandboxError || options.signal?.aborted) throw error;
        status = 0; // no answer was read whole: as a dropped connection
        failure = error instanceof Error && error.name === 'TimeoutError'
          ? new SandboxError('cave_timeout', 'Caveman Cloud did not answer in time; the request may still have been applied.', 0)
          : new SandboxError('cave_network_error', 'Could not reach Caveman Cloud.', 0);
      }
      const again = status === 0 ? route.safe
        : status === 429 ? true
          : [502, 503, 504].includes(status) ? route.safe
            : route.retryOn.includes((failure as SandboxError).code);
      if (!again || attempt >= this.retries || (after !== undefined && after * 1000 > maxRetryWaitMs)) throw failure;
      await sleep(wait, options.signal);
    }
  }

  /**
   * Reads a sandbox until it is in state (an observed_state: running, suspended, stopped) and answers it then.
   * A sandbox that failed, whose reason needs the caller, or that is asked to be something else (put to sleep while
   * waited on to run, for one), ends the wait with a SandboxStateError. A reason that passes by itself (its
   * observed_reason_code: waiting_for_capacity, host_unavailable, ...; sandboxReasons) does not, even while the
   * sandbox reads failed. Waiting for deleted ends when the sandbox is gone (not found), answering null.
   *
   * The API holds each read until the state, up to a minute (GET's wait_for: one request, however long, to its rate
   * limits), and says how the wait ended (Cave-Wait): unreachable ends it, by the same reason codes. A Caveman Cloud
   * whose answer says nothing of the wait (no Cave-Wait) does not hold it: the client then reads again, intervalMs
   * apart at most, and judges by sandboxReasons itself. At the API's cap on one caller's waits at once, one read is a
   * plain one.
   */
  waitFor(sandboxId: string, state: Exclude<SandboxState, 'deleted'>, options?: WaitOptions): Promise<CodeComputer>;
  waitFor(sandboxId: string, state: 'deleted', options?: WaitOptions): Promise<null>;
  async waitFor(sandboxId: string, state: SandboxState, options: WaitOptions = {}): Promise<CodeComputer | null> {
    const deadline = Date.now() + (options.timeoutMs ?? 600000);
    let interval = Math.max(10, (options.intervalMs ?? 1000) / 2);
    const signal = options.signal ? {signal: options.signal} : {};
    let waits = true; // until an answer says the API does not
    for (;;) {
      let sandbox: CodeComputer, outcome: string | null = null;
      const asked = Date.now();
      const seconds = Math.min(maxWaitSeconds, Math.floor((deadline - Date.now()) / 1000));
      const held = waits && seconds >= 1;
      try {
        if (held) {
          try {
            const answer = await this.request<CodeComputer>(sandboxRoutes.get, `/code/computers/${encodeURIComponent(sandboxId)}`,
              {wait_for: state, timeout: seconds}, undefined, {...signal, timeoutMs: Math.max(this.timeout, (seconds + 15) * 1000)});
            sandbox = answer.body;
            outcome = answer.headers.get(waitHeader);
            if (outcome === null) waits = false;
          } catch (error) {
            if (!(error instanceof SandboxError && error.code === 'cave_code_computer_waits_limit')) throw error;
            sandbox = await this.get(sandboxId, signal);
          }
        } else sandbox = await this.get(sandboxId, signal);
      } catch (error) {
        if (state === 'deleted' && error instanceof SandboxError && error.status === 404) return null;
        throw error;
      }
      if (sandbox.observed_state === state) return sandbox;
      const heading = state === 'running' ? sandbox.desired_state === 'running'
        : state === 'suspended' || state === 'stopped' ? sandbox.desired_state === 'suspended' || sandbox.desired_state === 'stopped'
          : state === 'deleted' ? sandbox.desired_state === 'deleted' : true;
      if (outcome === 'unreachable' || (outcome === null && sandboxWaitEnds(sandbox)) || !heading) throw new SandboxStateError(sandbox, state);
      if (Date.now() >= deadline) throw new SandboxError('cave_timeout', `Sandbox ${sandboxId} is ${sandbox.observed_state}, not yet ${state}.`, 0);
      // The API held the read: ask again at once (an answer of timeout that came back early is waited for as a poll).
      if (outcome !== null && Date.now() - asked >= 1000) continue;
      interval = Math.min(interval * 2, options.intervalMs ?? 1000);
      await sleep(Math.min(interval, Math.max(0, deadline - Date.now())), options.signal);
    }
  }

  /**
   * Reads a snapshot until it is taken (state ready) and answers it then. A take that failed (its reason_code says
   * why: computer_not_placed, snapshots_unsupported, internal_error), and a snapshot being deleted or deleted, end the
   * wait with a SnapshotStateError. The API holds no snapshot read: the client reads again, from 250 ms apart doubling
   * to intervalMs; past timeoutMs it throws cave_timeout.
   */
  async waitForSnapshot(sandboxId: string, snapshotId: string, options: WaitOptions = {}): Promise<CodeComputerSnapshot> {
    return this.pollSnapshot(sandboxId, snapshotId, options, s => s.state === 'ready' ? true : s.state === 'taking' ? undefined : false, 'taken', false);
  }

  /**
   * Reads a snapshot until its restore into its sandbox ends restored, and answers it then. A restore that failed (its
   * restore.reason_code says why: snapshot_elsewhere, snapshot_gone, computer_not_placed, ...) ends the wait with a
   * SnapshotStateError, and so does a snapshot with no restore asked. Read again as waitForSnapshot reads.
   */
  async waitForRestore(sandboxId: string, snapshotId: string, options: WaitOptions = {}): Promise<CodeComputerSnapshot> {
    return this.pollSnapshot(sandboxId, snapshotId, options, s => s.restore.state === 'restored' ? true : s.restore.state === 'restoring' ? undefined : false, 'restored', true);
  }

  /** Reads a snapshot until done says true (answered) or false (a SnapshotStateError); undefined reads again. */
  private async pollSnapshot(sandboxId: string, snapshotId: string, options: WaitOptions, done: (s: CodeComputerSnapshot) => boolean | undefined,
    want: string, restore: boolean): Promise<CodeComputerSnapshot> {
    const deadline = Date.now() + (options.timeoutMs ?? 600000);
    const most = Math.max(10, options.intervalMs ?? 1000);
    let interval = Math.min(250, most);
    const signal = options.signal ? {signal: options.signal} : {};
    for (;;) {
      const snapshot = await this.getSnapshot(sandboxId, snapshotId, signal);
      const ended = done(snapshot);
      if (ended === true) return snapshot;
      if (ended === false) throw new SnapshotStateError(snapshot, restore);
      if (Date.now() >= deadline)
        throw new SandboxError('cave_timeout', `Snapshot ${snapshotId} is ${restore ? `restoring` : snapshot.state}, not yet ${want}.`, 0);
      await sleep(Math.min(interval, Math.max(0, deadline - Date.now())), options.signal);
      interval = Math.min(interval * 2, most);
    }
  }

  /** Runs argv in a sandbox and keeps its output, as UTF-8 text. */
  async run(sandboxId: string, argv: string[], options: Pick<ExecOptions, 'stdin' | 'signal' | 'env' | 'cwd' | 'user'> = {}): Promise<ExecResult> {
    const out: Uint8Array[] = [], err: Uint8Array[] = [];
    const exitCode = await this.exec(sandboxId, argv, {...options, stdout: chunk => { out.push(chunk); }, stderr: chunk => { err.push(chunk); }});
    const text = (parts: Uint8Array[]) => new TextDecoder().decode(concat(parts));
    return {exitCode, stdout: text(out), stderr: text(err)};
  }

  /**
   * Runs argv in a running sandbox, streaming its output, and answers the command's exit code. A stream the sandbox
   * says to open again (sandboxStream.retry: its host restarting, before the command started) is opened again after
   * the wait it asks, at most retry.tries times within retry.within_ms, while nothing of the command came back and
   * its stdin can be sent again (none, text or bytes; an iterable is read once): never a second run of a command.
   */
  async exec(sandboxId: string, argv: string[], options: ExecOptions = {}): Promise<number> {
    checkArgv(argv);
    checkOptions(options);
    const retry = sandboxStream.retry;
    const again = options.stdin === undefined || typeof options.stdin === 'string' || options.stdin instanceof Uint8Array;
    const first = Date.now();
    for (let attempt = 1; ; attempt++) {
      const heard = {output: false};
      try {
        return await this.execOnce(sandboxId, argv, options, heard);
      } catch (error) {
        const asked = error instanceof SandboxExecError && (retry.codes as readonly string[]).includes(error.code);
        const wait = asked ? Math.max(0, (error as SandboxExecError).retryAfter ?? retry.after_seconds) * 1000 : 0;
        if (!asked || !again || heard.output || attempt >= retry.tries || Date.now() - first + wait > retry.within_ms || options.signal?.aborted) throw error;
        await sleep(wait, options.signal);
      }
    }
  }

  /** One stream of exec: heard.output says whether any of the command's output came. */
  private async execOnce(sandboxId: string, argv: string[], options: ExecOptions, heard: {output: boolean}): Promise<number> {
    options.signal?.throwIfAborted();
    const {socket, head} = await this.open(this.streamURL(sandboxStream.path, sandboxId), options.signal);
    const abort = () => socket.destroy();
    options.signal?.addEventListener('abort', abort, {once: true});
    let finished!: () => void;
    const gone = new Promise<void>(resolve => { finished = resolve; });
    socket.once('close', () => finished());
    try {
      options.signal?.throwIfAborted();
      writeFrame(socket, opText, encode(JSON.stringify(startOf(argv, options))));
      // Controls go after the start, and may cross stdin's messages: each is a message of its own.
      options.control?.bind(message => { writeFrame(socket, opText, encode(JSON.stringify(message))); });
      void pump(socket, options.stdin, gone);
      const limit = 1 + sandboxStream.limits.max_output + sandboxStream.limits.max_control;
      for await (const message of readMessages(socket, head, limit)) {
        if ('close' in message) {
          // The close's reason is the API's code when the far end gave one; else its close code's.
          const code = message.reason.startsWith('cave_') ? message.reason
            : (sandboxStream.close_codes as Record<string, string>)[String(message.close)] ?? 'cave_code_computer_stream_ended';
          throw new SandboxExecError(code, (sandboxStream.errors as Record<string, string>)[code] || message.reason || 'The stream ended.', 0, message.close);
        }
        if (message.op === opBinary) {
          heard.output = true;
          const channel = message.data[0], data = message.data.subarray(1);
          const write = channel === sandboxStream.channels.stderr ? options.stderr : options.stdout;
          if (write && data.length) await write(data);
          continue;
        }
        let control: {type?: string; code?: unknown; message?: string; retry_after?: unknown};
        try { control = JSON.parse(new TextDecoder().decode(message.data)) as typeof control; }
        catch { throw new SandboxExecError('cave_bad_request', 'The sandbox sent a message this client cannot read.'); }
        if (control.type === sandboxStream.types.exit) {
          if (typeof control.code !== 'number') throw new SandboxExecError('cave_bad_request', 'The sandbox sent an exit with no code.');
          writeFrame(socket, opClose, closePayload(1000));
          socket.end();
          return control.code;
        }
        if (control.type === sandboxStream.types.error) {
          throw new SandboxExecError(String(control.code ?? 'cave_internal'), control.message ?? 'The command failed.', 0, undefined,
            typeof control.retry_after === 'number' ? control.retry_after : undefined);
        }
        if (control.type === sandboxStream.types.refused) {
          const r = control as {of?: unknown; code?: unknown; message?: unknown};
          options.onRefused?.({of: String(r.of ?? ''), code: String(r.code ?? ''), message: String(r.message ?? '')});
          continue;
        }
        // A message type this client does not know is a later version's: it is read past.
      }
      throw new SandboxExecError('cave_code_computer_stream_ended', (sandboxStream.errors as Record<string, string>).cave_code_computer_stream_ended ?? 'The stream ended.');
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (error instanceof CloudError) throw error;
      // The socket broke (a reset, a dropped connection): the command's end was not heard.
      throw new SandboxExecError('cave_code_computer_stream_ended', `The stream to the sandbox broke${error instanceof Error && error.message ? `: ${error.message}` : ''}.`);
    } finally {
      options.control?.bind(undefined);
      options.signal?.removeEventListener('abort', abort);
      finished();
      socket.destroy();
    }
  }

  /** The relay's URL of a stream: one of sandboxStream's paths, for a sandbox (and a dial's port). */
  private streamURL(template: string, sandboxId: string, port?: number): URL {
    return new URL(this.relay + template.replace('{computerId}', encodeURIComponent(sandboxId)).replace('{port}', String(port)));
  }

  /** Reads a file of a sandbox whole (as its tool-process user, or root). */
  async readFile(sandboxId: string, path: string, options: FileOptions = {}): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    await this.files(sandboxId, {op: 'read', path, ...(options.root ? {root: true} : {})}, options, {
      onData: chunk => { parts.push(chunk); },
      again: () => { parts.length = 0; },
    });
    return concat(parts);
  }

  /** Reads a file of a sandbox to sink a piece at a time (a promise holds the stream until it settles), and describes it. */
  async streamFile(sandboxId: string, path: string, sink: (chunk: Uint8Array) => void | Promise<void>, options: FileOptions = {}): Promise<SandboxFileInfo> {
    return (await this.files(sandboxId, {op: 'read', path, ...(options.root ? {root: true} : {})}, options, {onData: sink})).file!;
  }

  /**
   * Makes or replaces a file of a sandbox with data (its folder must be there), and describes it once written. An
   * iterable is read once: a stream the sandbox asks to open again is opened again only for text or bytes.
   */
  async writeFile(sandboxId: string, path: string, data: string | Uint8Array | AsyncIterable<Uint8Array | string>, options: WriteFileOptions = {}): Promise<SandboxFileInfo> {
    const first = {op: 'write', path, ...(options.root ? {root: true} : {}), ...(options.mode ? {mode: options.mode} : {}), ...(options.atomic ? {atomic: true} : {})};
    return (await this.files(sandboxId, first, options, {input: data})).file!;
  }

  /** Lists a folder of a sandbox, in no order. */
  async listFiles(sandboxId: string, path: string, options: FileOptions = {}): Promise<SandboxFileInfo[]> {
    return (await this.files(sandboxId, {op: 'list', path, ...(options.root ? {root: true} : {})}, options, {})).entries;
  }

  /** Describes a file of a sandbox, a symbolic link as itself. */
  async statFile(sandboxId: string, path: string, options: FileOptions = {}): Promise<SandboxFileInfo> {
    return (await this.files(sandboxId, {op: 'stat', path, ...(options.root ? {root: true} : {})}, options, {})).file!;
  }

  /** Makes a folder of a sandbox; with parents, the folders above it that are not there (one there is no error). */
  async makeDir(sandboxId: string, path: string, options: FileOptions & {parents?: boolean} = {}): Promise<void> {
    await this.files(sandboxId, {op: 'mkdir', path, ...(options.root ? {root: true} : {}), ...(options.parents ? {parents: true} : {})}, options, {});
  }

  /** Removes a file or empty folder of a sandbox; with all, a folder and all it holds. */
  async removeFile(sandboxId: string, path: string, options: FileOptions & {all?: boolean} = {}): Promise<void> {
    await this.files(sandboxId, {op: 'remove', path, ...(options.root ? {root: true} : {}), ...(options.all ? {all: true} : {})}, options, {});
  }

  /** Renames a file or folder of a sandbox, replacing a file at to as rename(2) does. */
  async renameFile(sandboxId: string, path: string, to: string, options: FileOptions = {}): Promise<void> {
    await this.files(sandboxId, {op: 'rename', path, to, ...(options.root ? {root: true} : {})}, options, {});
  }

  /**
   * One file operation on its own stream (sandboxStream.files): the first message, the input's bytes then
   * close_stdin, and the answer: bytes to onData, a file, entries, or done. A stream the sandbox says to open again
   * (sandboxStream.retry) is, as exec's is, while nothing came back and the input can be sent again.
   */
  private async files(sandboxId: string, first: Record<string, unknown>, options: FileOptions,
    io: {onData?: (chunk: Uint8Array) => void | Promise<void>; input?: string | Uint8Array | AsyncIterable<Uint8Array | string>; again?: () => void}):
    Promise<{file?: SandboxFileInfo; entries: SandboxFileInfo[]}> {
    checkPath(first.path);
    if (first.op === 'rename') checkPath(first.to);
    const retry = sandboxStream.retry;
    const replayable = io.input === undefined || typeof io.input === 'string' || io.input instanceof Uint8Array;
    const began = Date.now();
    for (let attempt = 1; ; attempt++) {
      const heard = {any: false};
      try {
        return await this.filesOnce(sandboxId, {type: sandboxStream.types.files, ...first}, options, io, heard);
      } catch (error) {
        const asked = error instanceof SandboxExecError && (retry.codes as readonly string[]).includes(error.code);
        const wait = asked ? Math.max(0, (error as SandboxExecError).retryAfter ?? retry.after_seconds) * 1000 : 0;
        if (!asked || !replayable || heard.any || attempt >= retry.tries || Date.now() - began + wait > retry.within_ms || options.signal?.aborted) throw error;
        io.again?.();
        await sleep(wait, options.signal);
      }
    }
  }

  private async filesOnce(sandboxId: string, first: Record<string, unknown>, options: FileOptions,
    io: {onData?: (chunk: Uint8Array) => void | Promise<void>; input?: string | Uint8Array | AsyncIterable<Uint8Array | string>},
    heard: {any: boolean}): Promise<{file?: SandboxFileInfo; entries: SandboxFileInfo[]}> {
    options.signal?.throwIfAborted();
    const {socket, head} = await this.open(this.streamURL(sandboxStream.files.path, sandboxId), options.signal);
    const abort = () => socket.destroy();
    options.signal?.addEventListener('abort', abort, {once: true});
    let finished!: () => void;
    const gone = new Promise<void>(resolve => { finished = resolve; });
    socket.once('close', () => finished());
    const entries: SandboxFileInfo[] = [];
    try {
      writeFrame(socket, opText, encode(JSON.stringify(first)));
      if (io.input !== undefined) void pump(socket, io.input, gone);
      for await (const message of readMessages(socket, head, sandboxStream.limits.max_output + sandboxStream.limits.max_control)) {
        if ('close' in message) throw streamEnded(message.close, message.reason);
        if (message.op === opBinary) {
          heard.any = true;
          if (io.onData && message.data.length) await io.onData(message.data);
          continue;
        }
        const control = parseControl(message.data);
        if (control.type === sandboxStream.types.file || control.type === sandboxStream.types.done) {
          writeFrame(socket, opClose, closePayload(1000));
          socket.end();
          return {...(control.type === sandboxStream.types.file ? {file: control.file as SandboxFileInfo} : {}), entries};
        }
        if (control.type === sandboxStream.types.entries) {
          heard.any = true;
          entries.push(...(Array.isArray(control.entries) ? control.entries as SandboxFileInfo[] : []));
          continue;
        }
        if (control.type === sandboxStream.types.error) throw errorOf(control);
        // A message type this client does not know is a later version's: it is read past.
      }
      throw streamEnded(1006, '');
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (error instanceof CloudError) throw error;
      throw new SandboxFileError('cave_code_computer_stream_ended', `The stream to the sandbox broke${error instanceof Error && error.message ? `: ${error.message}` : ''}.`);
    } finally {
      options.signal?.removeEventListener('abort', abort);
      finished();
      socket.destroy();
    }
  }

  /**
   * A sandbox's port at its own URL (https://<port>-<sandbox>.<domain>), where the Caveman Cloud serves ports so
   * (computers.portUrls; elsewhere the call is refused, 404 or 405): its token and a link (POST
   * /code/computers/{computerId}/ports/{port}/token). A program sends headers with each request to url; a person
   * opens link in a browser before linkExpiresAt (a few minutes) and the browser then holds a cookie for that host
   * until expiresAt. ttlSeconds (60 to 86400; an hour when absent) is how long the token and that cookie open the
   * port. public: true first makes the port public (anyone with the address reaches it, no token needed; the
   * sandbox's maker alone may), false makes it private again; absent leaves it as it is. The token is the key's own
   * capability: it stops working once the key is revoked or the sandbox deleted.
   */
  async url(sandboxId: string, port: number, options: SandboxURLOptions = {}): Promise<SandboxPortURL> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SandboxError('cave_bad_request', 'The port is a number from 1 to 65535.', 0);
    const ttl = options.ttlSeconds;
    if (ttl !== undefined && (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400)) throw new SandboxError('cave_bad_request', 'ttlSeconds is from 60 to 86400.', 0);
    const call: SandboxCallOptions = options.signal ? {signal: options.signal} : {};
    if (options.public !== undefined) await this.setPort(sandboxId, port, {visibility: options.public ? 'public' : 'private'}, call);
    const t = await this.portToken(sandboxId, port, ttl === undefined ? {} : {ttl_seconds: ttl}, call);
    return {
      url: t.url, link: t.link, linkExpiresAt: t.link_expires_at, token: t.token, headers: {[t.header]: t.token},
      expiresAt: t.expires_at, visibility: t.visibility,
    };
  }

  /** Opens a TCP connection to port on a sandbox's own loopback (sandboxStream.dial), through the relay. */
  async dialPort(sandboxId: string, port: number, options: {signal?: AbortSignal} = {}): Promise<SandboxConnection> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SandboxFileError('cave_bad_request', 'The port is a number from 1 to 65535.');
    const {socket, head} = await this.open(this.streamURL(sandboxStream.dial.path, sandboxId, port), options.signal);
    const abort = () => socket.destroy();
    options.signal?.addEventListener('abort', abort, {once: true});
    let finished!: () => void;
    const gone = new Promise<void>(resolve => { finished = resolve; });
    socket.once('close', () => finished());
    const max = sandboxStream.limits.max_input;
    // One reader, from the open to the close: what the sandbox sends waits in queue (at most about a MiB, then the
    // reader waits for the caller), its half close ends the bytes, and its close is answered (readMessages).
    const queue: Uint8Array[] = [];
    let queued = 0, ended = false, failure: unknown, wake: (() => void) | undefined, space: (() => void) | undefined;
    const notify = () => { const w = wake; wake = undefined; w?.(); };
    let settle!: {resolve: () => void; reject: (error: unknown) => void};
    const closed = new Promise<void>((resolve, reject) => { settle = {resolve, reject}; });
    closed.catch(() => undefined);
    void (async () => {
      try {
        for await (const message of readMessages(socket, head, sandboxStream.limits.max_output + sandboxStream.limits.max_control)) {
          if ('close' in message) {
            if (message.close !== 1000) throw streamEnded(message.close, message.reason);
            break;
          }
          if (message.op === opBinary) {
            queue.push(message.data);
            queued += message.data.length;
            notify();
            while (queued > 1 << 20 && !ended) await new Promise<void>(resolve => { space = resolve; });
            continue;
          }
          const control = parseControl(message.data);
          if (control.type === sandboxStream.types.close_write) { ended = true; notify(); continue; }
          if (control.type === sandboxStream.types.error) throw errorOf(control);
        }
        ended = true;
        notify();
        settle.resolve();
      } catch (error) {
        failure = options.signal?.aborted ? options.signal.reason : error instanceof CloudError ? error
          : new SandboxFileError('cave_code_computer_stream_ended', `The connection to the sandbox broke${error instanceof Error && error.message ? `: ${error.message}` : ''}.`);
        ended = true;
        notify();
        settle.reject(failure);
      } finally {
        options.signal?.removeEventListener('abort', abort);
        socket.destroy();
        finished();
      }
    })();
    let reading = false;
    return {
      async *[Symbol.asyncIterator]() {
        if (reading) throw new SandboxFileError('cave_bad_request', 'A connection is read once.');
        reading = true;
        for (;;) {
          const next = queue.shift();
          if (next) {
            queued -= next.length;
            const s = space;
            space = undefined;
            s?.();
            yield next;
            continue;
          }
          if (failure) throw failure;
          if (ended) return;
          await new Promise<void>(resolve => { wake = resolve; });
        }
      },
      async write(data: Uint8Array | string) {
        const bytes = typeof data === 'string' ? encode(data) : data;
        for (let at = 0; at < bytes.length; at += max) {
          if (!writeFrame(socket, opBinary, bytes.subarray(at, at + max))) await Promise.race([new Promise<void>(resolve => socket.once('drain', resolve)), gone]);
        }
      },
      closeWrite() { writeFrame(socket, opText, encode(JSON.stringify({type: sandboxStream.types.close_write}))); },
      close() { writeFrame(socket, opClose, closePayload(1000)); socket.destroy(); },
      closed,
    };
  }

  /**
   * Upgrades GET url (a stream's path at the relay) to a WebSocket on the stream's subprotocol, the key as the
   * bearer. A refusal before the upgrade is a SandboxExecError with the HTTP status: the sandbox service's own code
   * when it said one, else the status's.
   */
  private async open(url: URL, signal?: AbortSignal): Promise<{socket: NodeSocket; head: Uint8Array}> {
    const http = await import(url.protocol === 'https:' ? 'node:https' as string : 'node:http' as string) as NodeHTTP;
    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);
    const key = btoa(String.fromCharCode(...nonce));
    const accept = await acceptFor(key);
    signal?.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const req = http.request(url, {method: 'GET', headers: {
        authorization: 'Bearer ' + this.key, connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-version': '13', 'sec-websocket-key': key, 'sec-websocket-protocol': sandboxStream.subprotocol,
      }});
      const timer = setTimeout(() => req.destroy(new SandboxExecError('cave_timeout', 'The sandbox did not answer in time.')), 30000);
      const stop = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
      signal?.addEventListener('abort', stop, {once: true});
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
      req.on('upgrade', (res, socket, head) => {
        done();
        const header = (name: string) => [res.headers[name]].flat()[0];
        if (res.statusCode !== 101 || header('sec-websocket-accept') !== accept || header('sec-websocket-protocol') !== sandboxStream.subprotocol) {
          socket.destroy();
          reject(new SandboxExecError('cave_bad_request', `The relay did not open the stream as ${sandboxStream.subprotocol}.`, res.statusCode ?? 0));
          return;
        }
        resolve({socket, head});
      });
      req.on('response', res => {
        done();
        const parts: Uint8Array[] = [];
        let size = 0;
        res.on('data', chunk => { if ((size += chunk.length) <= sandboxStream.limits.max_control) parts.push(chunk); });
        res.on('end', () => reject(refusal(res.statusCode ?? 0, new TextDecoder().decode(concat(parts)), [res.headers['retry-after']].flat()[0])));
        res.on('error', reject);
      });
      req.on('error', error => {
        done();
        reject(signal?.aborted ? signal.reason : error instanceof SandboxExecError ? error : new SandboxExecError('cave_network_error', 'Could not reach the relay.'));
      });
      req.end();
    });
  }
}

/** A refusal before the upgrade: the API's error envelope the relay answers with, else (a proxy's page) a code for the status. */
function refusal(status: number, body: string, retryAfter?: string): SandboxExecError {
  const after = retryAfter !== undefined && /^\d{1,4}$/.test(retryAfter) ? Number(retryAfter) : undefined;
  try {
    const e = (JSON.parse(body) as {error?: {code?: string; message?: string; request_id?: string}}).error;
    if (e?.code) return new SandboxExecError(e.code, e.message ?? '', status, undefined, after);
  } catch { /* not the relay's answer: a proxy's page */ }
  const code = ({401: 'cave_unauthorized', 403: 'cave_forbidden', 404: 'cave_not_found', 429: 'cave_rate_limit_exceeded'} as Record<number, string>)[status] ?? 'cave_request_failed';
  const message = status === 404 ? 'No such sandbox for this key, or this Caveman Cloud does not offer sandbox commands (computers.api.enabled is off).'
    : body.trim() || `The stream was refused (${status}).`;
  return new SandboxExecError(code, message, status);
}

/** A path a file operation takes: absolute, no NUL byte, at most sandboxStream.files.max_path bytes. */
function checkPath(path: unknown): void {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0') || encode(path).length > sandboxStream.files.max_path)
    throw new SandboxFileError('cave_bad_request', `A sandbox's path is absolute, with no NUL byte, at most ${sandboxStream.files.max_path} bytes.`);
}

/** A text message of a files or dial stream, read as JSON. */
function parseControl(data: Uint8Array): Record<string, unknown> & {type?: string} {
  try { return JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown> & {type?: string}; }
  catch { throw new SandboxFileError('cave_bad_request', 'The sandbox sent a message this client cannot read.'); }
}

/** An error message of a files or dial stream. */
function errorOf(control: Record<string, unknown>): SandboxFileError {
  const code = String(control.code ?? 'cave_internal');
  return new SandboxFileError(code, typeof control.message === 'string' && control.message ? control.message : (sandboxStream.errors as Record<string, string>)[code] ?? 'The operation failed.',
    0, undefined, typeof control.retry_after === 'number' ? control.retry_after : undefined);
}

/** A files or dial stream closed before its answer: the API's code its reason gave, else its close code's. */
function streamEnded(close: number, reason: string): SandboxFileError {
  const code = reason.startsWith('cave_') ? reason : (sandboxStream.close_codes as Record<string, string>)[String(close)] ?? 'cave_code_computer_stream_ended';
  return new SandboxFileError(code, (sandboxStream.errors as Record<string, string>)[code] || reason || 'The stream ended.', 0, close);
}

/** A command's start message: its argv and the options it asks. */
function startOf(argv: string[], options: ExecOptions): Record<string, unknown> {
  return {type: sandboxStream.types.start, argv, ...(options.tty ? {tty: true} : {}),
    ...(options.env && Object.keys(options.env).length ? {env: options.env} : {}), ...(options.cwd ? {cwd: options.cwd} : {}),
    ...(options.user ? {user: options.user} : {}), ...(options.cols !== undefined || options.rows !== undefined ? {cols: options.cols, rows: options.rows} : {})};
}

function checkSize(cols: unknown, rows: unknown): void {
  const max = sandboxStream.options.max_term_size;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || (cols as number) < 1 || (rows as number) < 1 || (cols as number) > max || (rows as number) > max)
    throw new SandboxExecError('cave_bad_request', `A terminal's cols and rows are each from 1 to ${max}.`);
}

/** A command's options, refused here as the sandbox would refuse them. */
function checkOptions(options: ExecOptions): void {
  const {max_env, max_env_bytes} = sandboxStream.options;
  const env = Object.entries(options.env ?? {});
  if (env.some(([k, v]) => !k || /[=\0]/.test(k) || typeof v !== 'string' || v.includes('\0')))
    throw new SandboxExecError('cave_bad_request', 'An environment variable\'s name is not empty and holds no = or NUL, and its value is text with no NUL.');
  if (env.length > max_env || env.reduce((n, [k, v]) => n + encode(k).length + 1 + encode(v).length, 0) > max_env_bytes)
    throw new SandboxExecError('cave_bad_request', `A command's environment is at most ${max_env} variables and ${max_env_bytes} bytes.`);
  if (options.cwd !== undefined && (typeof options.cwd !== 'string' || !options.cwd.startsWith('/') || options.cwd.includes('\0')))
    throw new SandboxExecError('cave_bad_request', 'cwd is an absolute path in the sandbox.');
  if (options.cols !== undefined || options.rows !== undefined) {
    if (!options.tty) throw new SandboxExecError('cave_bad_request', 'cols and rows are a terminal\'s: ask for tty.');
    checkSize(options.cols, options.rows);
  }
}

function checkArgv(argv: string[]): void {
  if (!Array.isArray(argv) || !argv.length || !argv[0]) throw new SandboxExecError('cave_bad_request', 'Name a command to run.');
  if (argv.some(a => typeof a !== 'string' || a.includes('\0'))) throw new SandboxExecError('cave_bad_request', 'A command\'s arguments are strings with no NUL byte.');
  const bytes = argv.reduce((n, a) => n + encode(a).length, 0);
  if (argv.length > sandboxStream.limits.max_args || bytes > sandboxStream.limits.max_argv_bytes)
    throw new SandboxExecError('cave_bad_request', `A command is at most ${sandboxStream.limits.max_args} arguments and ${sandboxStream.limits.max_argv_bytes} bytes.`);
}

// What this file uses of node:http and node:https, typed here so the SDK needs no type package.
interface NodeSocket extends AsyncIterable<Uint8Array> {
  write(data: Uint8Array): boolean;
  end(): void;
  destroy(error?: Error): void;
  once(event: 'drain' | 'close', listener: () => void): unknown;
}
interface NodeResponse {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}
interface NodeRequest {
  on(event: 'upgrade', listener: (res: NodeResponse, socket: NodeSocket, head: Uint8Array) => void): unknown;
  on(event: 'response', listener: (res: NodeResponse) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  destroy(error?: Error): void;
  end(): void;
}
interface NodeHTTP { request(url: URL, options: {method: string; headers: Record<string, string>}): NodeRequest }

// The WebSocket of a command's stream (RFC 6455, a client's part): frames masked out, unmasked in, no extensions,
// a message whole once its last fragment came, a ping answered, a close returned.
const opContinuation = 0x0, opText = 0x1, opBinary = 0x2, opClose = 0x8, opPing = 0x9, opPong = 0xa;
const encode = (text: string) => new TextEncoder().encode(text);
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
async function acceptFor(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', encode(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')));
  return btoa(String.fromCharCode(...digest));
}
const closePayload = (code: number) => new Uint8Array([code >> 8, code & 0xff]);

function writeFrame(socket: NodeSocket, op: number, payload: Uint8Array): boolean {
  const n = payload.length;
  const head = n < 126 ? [0x80 | op, 0x80 | n] : n <= 0xffff ? [0x80 | op, 0x80 | 126, n >> 8, n & 0xff]
    : [0x80 | op, 0x80 | 127, 0, 0, 0, 0, (n / 2 ** 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const mask = new Uint8Array(4);
  crypto.getRandomValues(mask);
  const frame = new Uint8Array(head.length + 4 + n);
  frame.set(head);
  frame.set(mask, head.length);
  for (let i = 0; i < n; i++) frame[head.length + 4 + i] = payload[i]! ^ mask[i % 4]!;
  try { return socket.write(frame); } catch { return false; }
}

/**
 * Copies stdin to the stream in messages of at most max_input bytes, then says stdin ended: also when reading stdin
 * fails, as a pipe that broke ends a command's input. It stops reading stdin (an iterable's return() is called) once
 * the stream is gone.
 */
async function pump(socket: NodeSocket, stdin: ExecOptions['stdin'], gone: Promise<void>): Promise<void> {
  const max = sandboxStream.limits.max_input;
  let ended = false;
  void gone.then(() => { ended = true; });
  const send = async (chunk: Uint8Array) => {
    for (let at = 0; at < chunk.length && !ended; at += max) {
      if (!writeFrame(socket, opBinary, chunk.subarray(at, at + max))) await Promise.race([new Promise<void>(resolve => socket.once('drain', resolve)), gone]);
    }
  };
  try {
    if (typeof stdin === 'string') await send(encode(stdin));
    else if (stdin instanceof Uint8Array) await send(stdin);
    else if (stdin) {
      // Read by hand so the end of the stream can end a read that waits (return() on a Node stream destroys it).
      const chunks = stdin[Symbol.asyncIterator]();
      void gone.then(() => chunks.return?.()).catch(() => undefined);
      for (;;) {
        const next = await Promise.race([chunks.next(), gone.then(() => ({done: true as const, value: undefined}))]);
        if (next.done || ended) break;
        await send(typeof next.value === 'string' ? encode(next.value) : next.value);
      }
    }
  } catch { /* stdin failed to read: its end is said below, as for a stdin that ended */ }
  if (!ended) writeFrame(socket, opText, encode(JSON.stringify({type: sandboxStream.types.close_stdin})));
}

type Message = {op: number; data: Uint8Array} | {close: number; reason: string};

/** Each whole message from the socket, pings answered on the way; a close from the far end ends it, once answered. */
async function* readMessages(socket: NodeSocket, head: Uint8Array, limit: number): AsyncGenerator<Message> {
  const chunks = socket[Symbol.asyncIterator]();
  let buffer = head;
  const need = async (n: number) => {
    while (buffer.length < n) {
      const next = await chunks.next();
      if (next.done) return false;
      buffer = buffer.length ? concat([buffer, next.value]) : next.value;
    }
    return true;
  };
  let op = 0;
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    if (!await need(2)) return;
    const fin = (buffer[0]! & 0x80) !== 0, frameOp = buffer[0]! & 0x0f;
    if (buffer[0]! & 0x70) throw new SandboxExecError('cave_bad_request', 'The stream sent a frame with reserved bits.');
    if (buffer[1]! & 0x80) throw new SandboxExecError('cave_bad_request', 'The stream sent a masked frame.');
    let n = buffer[1]! & 0x7f, at = 2;
    if (n === 126) { if (!await need(4)) return; n = (buffer[2]! << 8) | buffer[3]!; at = 4; }
    else if (n === 127) {
      if (!await need(10)) return;
      n = 0;
      for (let i = 2; i < 10; i++) n = n * 256 + buffer[i]!;
      at = 10;
    }
    if (n > limit) throw new SandboxExecError('cave_bad_request', 'The stream sent a message over its bound.');
    if (!await need(at + n)) return;
    const payload = buffer.slice(at, at + n);
    buffer = buffer.subarray(at + n);
    if (frameOp === opPing) { writeFrame(socket, opPong, payload); continue; }
    if (frameOp === opPong) continue;
    if (frameOp === opClose) {
      const code = payload.length >= 2 ? (payload[0]! << 8) | payload[1]! : 1005;
      writeFrame(socket, opClose, closePayload(1000));
      yield {close: code, reason: new TextDecoder().decode(payload.subarray(2))};
      return;
    }
    if (frameOp === opContinuation ? op === 0 : op !== 0) throw new SandboxExecError('cave_bad_request', 'The stream sent a fragment out of order.');
    if (frameOp !== opContinuation) {
      if (frameOp !== opText && frameOp !== opBinary) throw new SandboxExecError('cave_bad_request', 'The stream sent an unknown frame.');
      op = frameOp;
    }
    if ((size += payload.length) > limit) throw new SandboxExecError('cave_bad_request', 'The stream sent a message over its bound.');
    parts.push(payload);
    if (fin) {
      yield {op, data: parts.length === 1 ? parts[0]! : concat(parts)};
      op = 0; size = 0; parts.length = 0;
    }
  }
}
