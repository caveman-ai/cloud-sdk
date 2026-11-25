/**
 * Caveman Gate — Agent-native human approval checkpoints backed by Caveman Cloud's
 * server-enforced Inbox decision queue (`POST /api/v1/code/gates`, `GET /api/v1/code/gates/{id}`).
 *
 * Security invariants:
 * - Agents (with a `code:run` API key or session token) may ONLY file a gate and poll its
 *   status. They can never reach the Inbox mutation routes, and the server refuses any
 *   non-browser / non-human actor from approving or denying (`cave_gate_human_only`).
 * - Gates are immutable once filed: retrying with the same `dedupeKey` returns the original
 *   item untouched (no mid-review bait-and-switch, no post-decision audit wipe).
 * - Diff artifacts are sent with `patch` and `data_untrusted: true`.
 * - Every wait fails closed: denial throws `GateDeniedError`, timeout throws `GateTimeoutError`,
 *   archived/closed without an explicit server decision throws `GateDeniedError`.
 */
import {PlatformError, PlatformTransport, type PlatformClientOptions} from './platform2027.js';

export type GateRisk = 'low' | 'medium' | 'high' | 'critical';

export interface GateFact {
  label: string;
  value: string;
}

export interface GateRequest {
  /** Machine-readable action identifier, e.g. "stripe.refund" or "db.drop_table". */
  action: string;
  /** Short human-readable title (defaults to `Approve ${action}`, truncated to 200 chars). */
  title?: string;
  /** Clear explanation of what will happen if approved. */
  summary: string;
  /** Risk classification; maps to Inbox priority (critical/high -> 1, medium -> 2, low -> 3). */
  risk?: GateRisk;
  /** Structured key/value evidence shown to the human reviewer. */
  facts?: GateFact[];
  /** Optional unified diff shown in the Inbox review card (always marked data_untrusted=true). */
  diff?: {title?: string; patch: string};
  /** Optional free-form text evidence shown in the review card. */
  note?: {title?: string; text: string};
  /** Optional estimated dollar impact shown as a fact (non-negative finite number). */
  costUsd?: number;
  /** Optional workflow slug (`^[a-z0-9_-]{1,200}$`) to attach to the Inbox item. */
  workflow?: string;
  /** Optional project UUID override. */
  projectId?: string;
  /** Stable idempotency key so retries never create duplicate approval cards. */
  dedupeKey?: string;
  /** Optional console path or https URL for context. */
  href?: string;
  /** Wait timeout in milliseconds when calling `require()` or `wait()` (default 10 minutes). */
  timeoutMs?: number;
  /** Poll interval in milliseconds (default 1500ms, minimum 250ms). */
  pollIntervalMs?: number;
  /** Optional AbortSignal to cancel waiting early. */
  signal?: AbortSignal;
}

export interface GatePending {
  itemId: string;
  action: string;
  title: string;
  dedupeKey: string;
  status: 'open' | 'resolved' | 'archived';
  createdAt: string;
}

export interface GateDecision {
  itemId: string;
  action: string;
  approved: boolean;
  decision: 'approved' | 'denied';
  decidedBy: string;
  decidedAt: string;
}

export interface GateOptions extends PlatformClientOptions {
  /** Default workflow slug attached to every gate filed by this client. */
  workflow?: string;
  /** Default project UUID attached to every gate filed by this client. */
  projectId?: string;
  /** Default wait timeout in milliseconds (default 600_000 = 10m). */
  defaultTimeoutMs?: number;
  /** Default poll interval in milliseconds (default 1_500ms, min 250ms). */
  defaultPollIntervalMs?: number;
}

export interface GatePolicy<Args extends unknown[]> {
  action: string;
  risk?: GateRisk;
  summary: (...args: Args) => string;
  title?: (...args: Args) => string;
  facts?: (...args: Args) => GateFact[];
  diff?: (...args: Args) => {title?: string; patch: string} | undefined;
  costUsd?: (...args: Args) => number | undefined;
  /** Optional predicate (sync or async): when it returns false, the call runs without gating. */
  when?: (...args: Args) => boolean | Promise<boolean>;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export class GateError extends PlatformError {
  constructor(code: string, message: string, status = 0, readonly itemId?: string) {
    super(code, message, status);
    this.name = 'GateError';
  }
}

export class GateDeniedError extends GateError {
  constructor(
    readonly decision: GateDecision,
    message = `Action "${decision.action}" was denied by ${decision.decidedBy || 'human reviewer'}.`,
  ) {
    super('cave_gate_denied', message, 403, decision.itemId);
    this.name = 'GateDeniedError';
  }
}

export class GateTimeoutError extends GateError {
  constructor(readonly pending: GatePending, timeoutMs: number) {
    super('cave_gate_timeout', `Timed out after ${timeoutMs}ms waiting for human decision on "${pending.action}" (${pending.itemId}).`, 408, pending.itemId);
    this.name = 'GateTimeoutError';
  }
}

interface WireGateItem {
  id: string;
  status: 'open' | 'resolved' | 'archived';
  ref_type: string;
  ref_id: string;
  title: string;
  dedupe_key: string;
  created_at: string;
  resolved_at?: string | null;
  data?: {
    workflow?: string;
    gate_decision?: string;
    gate_decided_by?: string;
  };
}

const MIN_POLL_INTERVAL_MS = 250;
const WORKFLOW_SLUG_RE = /^[a-z0-9_-]{1,200}$/;

function priorityForRisk(risk?: GateRisk): number {
  switch (risk) {
    case 'critical':
    case 'high':
      return 1;
    case 'low':
      return 3;
    default:
      return 2;
  }
}

function truncateRunes(s: string, maxRunes: number): string {
  const chars = Array.from(s);
  if (chars.length <= maxRunes) return s;
  return chars.slice(0, maxRunes).join('');
}

function validatePositiveFinite(name: string, v: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new GateError('cave_gate_invalid_option', `${name} must be a positive finite number.`);
  }
  return v;
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Gate wait aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Gate wait aborted'));
    };
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}

/**
 * First-class Caveman Gate client built directly into `@caveman-ai/sdk`.
 */
export class Gate {
  private readonly tx: PlatformTransport;
  private readonly workflow?: string;
  private readonly projectId?: string;
  private readonly defaultTimeoutMs: number;
  private readonly defaultPollIntervalMs: number;

  constructor(opts: GateOptions) {
    this.tx = new PlatformTransport(opts);
    if (opts.workflow !== undefined) {
      if (!WORKFLOW_SLUG_RE.test(opts.workflow)) {
        throw new GateError('cave_gate_invalid_option', 'workflow must match ^[a-z0-9_-]{1,200}$.');
      }
      this.workflow = opts.workflow;
    }
    if (opts.projectId !== undefined) this.projectId = opts.projectId;
    this.defaultTimeoutMs = validatePositiveFinite('defaultTimeoutMs', opts.defaultTimeoutMs ?? 600_000);
    const poll = validatePositiveFinite('defaultPollIntervalMs', opts.defaultPollIntervalMs ?? 1_500);
    this.defaultPollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, poll);
  }

  /**
   * Files a human-only approval checkpoint via `POST /api/v1/code/gates` and returns immediately.
   * Use `wait()` to poll for the decision, or `require()` to request + wait in one call.
   */
  async request(req: GateRequest): Promise<GatePending> {
    const action = req.action?.trim();
    if (!action) throw new GateError('cave_gate_invalid', 'action is required.');
    const summary = req.summary?.trim();
    if (!summary) throw new GateError('cave_gate_invalid', 'summary is required.');
    if (req.costUsd !== undefined && (typeof req.costUsd !== 'number' || !Number.isFinite(req.costUsd) || req.costUsd < 0)) {
      throw new GateError('cave_gate_invalid', 'costUsd must be a non-negative finite number.');
    }
    const wf = req.workflow ?? this.workflow;
    if (wf !== undefined && !WORKFLOW_SLUG_RE.test(wf)) {
      throw new GateError('cave_gate_invalid', 'workflow must match ^[a-z0-9_-]{1,200}$.');
    }

    const title = truncateRunes((req.title?.trim() || `Approve ${action}`), 200);
    const facts: GateFact[] = [
      {label: 'Action', value: action},
      {label: 'Risk', value: req.risk ?? 'medium'},
    ];
    if (req.costUsd !== undefined) {
      facts.push({label: 'Estimated impact', value: `$${req.costUsd.toFixed(2)}`});
    }
    if (req.facts) {
      for (const f of req.facts) {
        if (f.label?.trim() && f.value !== undefined) {
          facts.push({label: f.label.trim(), value: String(f.value)});
        }
      }
    }

    const artifacts: Array<Record<string, unknown>> = [
      {type: 'facts', title: 'Action details', facts},
    ];
    if (req.diff?.patch) {
      artifacts.push({
        type: 'diff',
        title: req.diff.title?.trim() || 'Proposed diff',
        patch: req.diff.patch,
        data_untrusted: true,
      });
    }
    if (req.note?.text) {
      artifacts.push({
        type: 'text',
        title: req.note.title?.trim() || 'Details',
        text: req.note.text,
      });
    }

    const body: Record<string, unknown> = {
      kind: 'needs_you',
      priority: priorityForRisk(req.risk),
      source: 'agents',
      scope: `gate:${action}`,
      title,
      summary,
      ref_type: 'agent_gate',
      ref_id: action,
      href: req.href ?? '',
      dedupe_key: req.dedupeKey ?? '',
      artifacts,
    };
    const projectId = req.projectId ?? this.projectId;
    if (projectId) body.project_id = projectId;
    if (wf) body.data = {workflow: wf};

    const item = await this.tx.request<WireGateItem>(
      'POST',
      '/api/v1/code/gates',
      body,
      req.signal ? {signal: req.signal} : undefined,
    );
    if (!item?.id || item.ref_type !== 'agent_gate' || item.ref_id !== action) {
      throw new GateError(
        'cave_gate_protocol_error',
        `Server returned an unexpected or mismatched gate response (expected action "${action}", got "${item?.ref_id ?? ''}").`,
      );
    }
    return {
      itemId: item.id,
      action,
      title: item.title,
      dedupeKey: item.dedupe_key,
      status: item.status,
      createdAt: item.created_at,
    };
  }

  /**
   * Polls `GET /api/v1/code/gates/{id}` until a verified human approves or denies the gate.
   * Uses a monotonic clock and clamps each HTTP poll to the remaining deadline.
   * Fails closed on denial, archival without decision, or timeout.
   */
  async wait(
    pending: GatePending,
    opts?: {timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal},
  ): Promise<GateDecision> {
    const timeoutMs = validatePositiveFinite('timeoutMs', opts?.timeoutMs ?? this.defaultTimeoutMs);
    const pollMs = Math.max(
      MIN_POLL_INTERVAL_MS,
      validatePositiveFinite('pollIntervalMs', opts?.pollIntervalMs ?? this.defaultPollIntervalMs),
    );
    const deadline = performance.now() + timeoutMs;

    for (;;) {
      if (opts?.signal?.aborted) {
        throw opts.signal.reason ?? new Error('Gate wait aborted');
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new GateTimeoutError(pending, timeoutMs);
      }
      const reqOpts: {signal?: AbortSignal; timeoutMs: number; deadlineMs: number} = {
        timeoutMs: Math.max(50, remaining),
        deadlineMs: deadline,
      };
      if (opts?.signal) reqOpts.signal = opts.signal;

      let item: WireGateItem;
      try {
        item = await this.tx.request<WireGateItem>(
          'GET',
          `/api/v1/code/gates/${encodeURIComponent(pending.itemId)}`,
          undefined,
          reqOpts,
        );
      } catch (err) {
        if (opts?.signal?.aborted) {
          throw opts.signal.reason ?? new Error('Gate wait aborted');
        }
        if ((err instanceof PlatformError && err.code === 'cave_timeout') || performance.now() >= deadline) {
          throw new GateTimeoutError(pending, timeoutMs);
        }
        throw err;
      }
      if (!item || item.id !== pending.itemId || item.ref_type !== 'agent_gate' || item.ref_id !== pending.action) {
        throw new GateError('cave_gate_protocol_error', 'Server returned mismatched gate item.', 0, pending.itemId);
      }

      if (performance.now() > deadline) {
        throw new GateTimeoutError(pending, timeoutMs);
      }

      const gateDecision = item.data?.gate_decision;
      if (gateDecision === 'approved') {
        return {
          itemId: item.id,
          action: pending.action,
          approved: true,
          decision: 'approved',
          decidedBy: item.data?.gate_decided_by || '',
          decidedAt: item.resolved_at || new Date().toISOString(),
        };
      }
      if (gateDecision === 'denied' || item.status === 'resolved' || item.status === 'archived') {
        const decision: GateDecision = {
          itemId: item.id,
          action: pending.action,
          approved: false,
          decision: 'denied',
          decidedBy: item.data?.gate_decided_by || '',
          decidedAt: item.resolved_at || new Date().toISOString(),
        };
        throw new GateDeniedError(decision);
      }

      const afterPollRemaining = deadline - performance.now();
      if (afterPollRemaining <= 0) {
        throw new GateTimeoutError(pending, timeoutMs);
      }
      await sleepAbortable(Math.min(pollMs, afterPollRemaining), opts?.signal);
    }
  }

  /** Files a human approval checkpoint and blocks until approved (throws GateDeniedError / GateTimeoutError). */
  async require(req: GateRequest): Promise<GateDecision> {
    const pending = await this.request(req);
    const waitOpts: {timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal} = {};
    if (req.timeoutMs !== undefined) waitOpts.timeoutMs = req.timeoutMs;
    if (req.pollIntervalMs !== undefined) waitOpts.pollIntervalMs = req.pollIntervalMs;
    if (req.signal !== undefined) waitOpts.signal = req.signal;
    return this.wait(pending, waitOpts);
  }

  /**
   * Wraps any sensitive tool or function behind a Caveman Gate policy.
   * Defaults `risk` to `'high'`; supports sync or async `policy.when(...)`.
   */
  guard<Args extends unknown[], R>(
    policy: GatePolicy<Args>,
    fn: (...args: Args) => R | Promise<R>,
  ): (...args: Args) => Promise<R> {
    return async (...args: Args): Promise<R> => {
      if (policy.when && !(await policy.when(...args))) {
        return fn(...args);
      }
      const req: GateRequest = {
        action: policy.action,
        risk: policy.risk ?? 'high',
        summary: policy.summary(...args),
      };
      if (policy.title) req.title = policy.title(...args);
      if (policy.facts) req.facts = policy.facts(...args);
      const diff = policy.diff?.(...args);
      if (diff) req.diff = diff;
      const costUsd = policy.costUsd?.(...args);
      if (costUsd !== undefined) req.costUsd = costUsd;
      if (policy.timeoutMs !== undefined) req.timeoutMs = policy.timeoutMs;
      if (policy.pollIntervalMs !== undefined) req.pollIntervalMs = policy.pollIntervalMs;
      await this.require(req);
      return fn(...args);
    };
  }
}
