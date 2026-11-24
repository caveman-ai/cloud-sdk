import type { Cloud, CloudOperation, CloudOperations } from "./cloud.js";

export type EvalRunStatus = "queued" | "running" | "cancelling" | "completed" | "failed" | "error" | "cancelled";

export type EvalRunScope =
  | { kind: "all" }
  | { kind: "target"; target_key: string }
  | { kind: "row"; row_key: string }
  | { kind: "cell"; target_key: string; row_key: string }
  | { kind: "evaluator"; evaluator_key: string; source_run_id: string };

export type EvalRunSummary = {
  total_cells?: number;
  completed_cells?: number;
  error_cells?: number;
  evaluation_errors?: number;
  passed_evaluations?: number;
  failed_evaluations?: number;
  cost_usd?: number;
  cost_available?: boolean;
  average_latency_ms?: number;
  targets?: Record<string, Record<string, unknown>>;
  evaluators?: Record<string, { completed: number; errors: number; passed: number; failed: number; mean_score: number }>;
};

export type EvalRun = {
  id: string;
  project_id: string;
  workbench_id: string;
  workbench_version_id: string;
  status: EvalRunStatus;
  scope: EvalRunScope;
  concurrency: number;
  progress_completed: number;
  progress_total: number;
  summary: EvalRunSummary;
  error_code?: string;
  error_message?: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
};

export type EvalCell = {
  id: string;
  run_id: string;
  dataset_row_key: string;
  target_key: string;
  status: "queued" | "running" | "completed" | "error" | "cancelled";
  input: Record<string, unknown>;
  output: unknown;
  evaluator_results: Array<Record<string, unknown>>;
  metrics: Record<string, unknown>;
  error_code?: string;
  error_message?: string;
  trace_id?: string;
  started_at?: string;
  completed_at?: string;
};

export type EvalRunDetail = { run: EvalRun; cells: EvalCell[] };

export type EvalWorkbenchClientOptions = {
  accessToken: string;
  controlURL: string;
  projectId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type EvalRunCreateOptions = {
  scope?: EvalRunScope;
  concurrency?: number;
};

export type EvalRunWaitOptions = {
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
};

export type EvalColumn = {
  key: string;
  name: string;
  type: "string" | "number" | "boolean" | "json" | "image_url" | "messages";
  role: "input" | "expected" | "metadata" | "output";
};

export type EvalDatasetDocument = {
  schema_version: 1;
  columns: EvalColumn[];
  rows: Array<{ row_key: string; values: Record<string, unknown>; tags?: string[] }>;
};

export type EvalDataset = {
  id: string;
  project_id: string;
  name: string;
  description: string;
  status: string;
  columns: EvalColumn[];
  revision: number;
  current_version: number;
  row_count: number;
  created_at: string;
  updated_at: string;
};

export type EvalInputMapping = {
  candidate: { source: "dataset" | "target"; key: string };
  reference?: { source: "dataset" | "target"; key: string };
  baseline?: { source: "dataset" | "target"; key: string };
};

export type EvalSavedEvaluator = {
  id: string;
  project_id: string;
  name: string;
  description: string;
  grader_type: string;
  options: Record<string, unknown>;
  input_mapping: EvalInputMapping;
  status: string;
  revision: number;
  current_version: number;
  config_sha256: string;
  created_at: string;
  updated_at: string;
};

export type EvalTarget = {
  key: string;
  name: string;
  kind: "prompt" | "agent" | "workflow" | "recorded" | "http";
  input_mapping: Record<string, string>;
  dataset_input_mappings?: Record<string, Record<string, string>>;
  config: Record<string, unknown>;
};

export type EvalEvaluator = {
  key: string;
  name: string;
  source: "inline" | "saved";
  target_keys?: string[];
  evaluator_id?: string;
  evaluator_version?: number;
  config_sha256?: string;
  grader_type?: string;
  options?: Record<string, unknown>;
  input_mapping?: EvalInputMapping;
  dataset_input_mappings?: Record<string, EvalInputMapping>;
};

export type EvalWorkbenchDocument = {
  schema_version: 1;
  datasets: Array<{ key: string; dataset_id: string; version?: number; document_sha256?: string }>;
  active_dataset_key: string;
  targets: EvalTarget[];
  evaluators: EvalEvaluator[];
  settings: { concurrency: number; row_height: "compact" | "comfortable"; judge_order: "randomized" | "fixed"; judge_seed?: number };
  comparison?: { primary_evaluator_key?: string; confidence_level?: 0.9 | 0.95 | 0.99; minimum_samples?: number };
};

export type EvalWorkbench = {
  id: string;
  project_id: string;
  name: string;
  description: string;
  status: string;
  document: EvalWorkbenchDocument;
  document_sha256: string;
  revision: number;
  current_version: number;
  created_at: string;
  updated_at: string;
};

export type EvalExperimentCreateOptions = {
  name: string;
  description?: string;
  dataset: { name: string; description?: string; document: EvalDatasetDocument };
  datasetKey?: string;
  document: Omit<EvalWorkbenchDocument, "datasets" | "active_dataset_key">;
};

export type EvalExperiment = { dataset: EvalDataset; workbench: EvalWorkbench; runs: EvalWorkbenchClient };

export class EvalControlError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "EvalControlError";
  }
}

const terminalStatuses = new Set<EvalRunStatus>(["completed", "failed", "error", "cancelled"]);

function serviceURL(value: string): string {
  if (value.trim() !== value) throw new Error("controlURL must not contain surrounding whitespace");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("controlURL must be an absolute http(s) URL"); }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("controlURL must be an absolute http(s) URL without credentials, query, or fragment");
  }
  return value.replace(/\/+$/, "");
}

function required(value: string, name: string): string {
  if (!value || value.trim() !== value) throw new Error(`${name} is required without surrounding whitespace`);
  return value;
}

function positiveInteger(value: number | undefined, fallback: number, name: string, maximum: number): number {
  const parsed = value ?? fallback;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  return parsed;
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function detail(value: unknown): EvalRunDetail {
  const envelope = object(value, "eval response must be a JSON object");
  const run = object(envelope["run"], "eval response omitted run");
  const cells = envelope["cells"];
  if (typeof run["id"] !== "string" || typeof run["status"] !== "string" || !Array.isArray(cells)) throw new Error("eval response has invalid run detail");
  return { run: run as EvalRun, cells: cells as EvalCell[] };
}

function list<T>(value: unknown, message: string): T[] {
  const envelope = object(value, message);
  if (!Array.isArray(envelope["data"])) throw new Error(`${message} omitted data`);
  return envelope["data"] as T[];
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener("abort", aborted); resolve(); }
    function aborted() { clearTimeout(timer); reject(signal?.reason instanceof Error ? signal.reason : new Error("eval_wait_aborted")); }
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
  });
}

export class EvalWorkbenchClient {
  readonly options: EvalWorkbenchClientOptions;
  readonly workbenchId: string;

  constructor(options: EvalWorkbenchClientOptions, workbenchId: string) {
    this.options = {
      ...options,
      accessToken: required(options.accessToken, "accessToken"),
      controlURL: serviceURL(options.controlURL),
      projectId: required(options.projectId, "projectId"),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: positiveInteger(options.timeoutMs, 30_000, "timeoutMs", 86_400_000) }),
    };
    this.workbenchId = required(workbenchId, "workbenchId");
  }

  async list(): Promise<EvalRun[]> {
    const response = object(await this.request(""), "eval runs response must be a JSON object");
    if (!Array.isArray(response["data"])) throw new Error("eval runs response omitted data");
    return response["data"] as EvalRun[];
  }

  async run(options: EvalRunCreateOptions = {}): Promise<EvalRunDetail> {
    const concurrency = positiveInteger(options.concurrency, 4, "concurrency", 24);
    return detail(await this.request("", "POST", { scope: options.scope ?? { kind: "all" }, concurrency }));
  }

  async get(runId: string): Promise<EvalRunDetail> {
    return detail(await this.request(`/${encodeURIComponent(required(runId, "runId"))}`));
  }

  async cancel(runId: string): Promise<EvalRun> {
    const value = object(await this.request(`/${encodeURIComponent(required(runId, "runId"))}/cancel`, "POST", {}), "eval cancel response must be a JSON object");
    if (typeof value["id"] !== "string" || typeof value["status"] !== "string") throw new Error("eval cancel response has invalid run");
    return value as EvalRun;
  }

  async wait(runId: string, options: EvalRunWaitOptions = {}): Promise<EvalRunDetail> {
    const timeoutMs = positiveInteger(options.timeoutMs, 1_800_000, "timeoutMs", 86_400_000);
    const pollMs = positiveInteger(options.pollMs, 1000, "pollMs", 60_000);
    const signal = options.signal ?? this.options.signal;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const current = await this.get(runId);
      if (terminalStatuses.has(current.run.status)) return current;
      if (!["queued", "running", "cancelling"].includes(current.run.status)) throw new Error("eval_unknown_status");
      if (Date.now() >= deadline) throw new Error("eval_wait_timeout");
      await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())), signal);
    }
  }

  async runAndWait(runOptions: EvalRunCreateOptions = {}, waitOptions: EvalRunWaitOptions = {}): Promise<EvalRunDetail> {
    const created = await this.run(runOptions);
    if (terminalStatuses.has(created.run.status)) return created;
    return this.wait(created.run.id, waitOptions);
  }

  private async request(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<unknown> {
    return controlRequest(this.options, `/eval-workbenches/${encodeURIComponent(this.workbenchId)}/runs${path}`, method, body);
  }
}

export class EvalProjectClient {
  readonly options: EvalWorkbenchClientOptions;

  constructor(options: EvalWorkbenchClientOptions) {
    this.options = {
      ...options,
      accessToken: required(options.accessToken, "accessToken"),
      controlURL: serviceURL(options.controlURL),
      projectId: required(options.projectId, "projectId"),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: positiveInteger(options.timeoutMs, 30_000, "timeoutMs", 86_400_000) }),
    };
  }

  workbench(workbenchId: string): EvalWorkbenchClient {
    return new EvalWorkbenchClient(this.options, workbenchId);
  }

  async listDatasets(): Promise<EvalDataset[]> {
    return list<EvalDataset>(await controlRequest(this.options, "/eval-datasets"), "eval datasets response");
  }

  async createDataset(input: { name: string; description?: string; document: EvalDatasetDocument }): Promise<EvalDataset> {
    return object(await controlRequest(this.options, "/eval-datasets", "POST", {
      name: required(input.name, "dataset.name"), description: input.description ?? "", document: input.document,
    }), "eval dataset response must be a JSON object") as EvalDataset;
  }

  async listEvaluators(): Promise<EvalSavedEvaluator[]> {
    return list<EvalSavedEvaluator>(await controlRequest(this.options, "/eval-evaluators"), "eval evaluators response");
  }

  async createEvaluator(input: { name: string; description?: string; config: { schema_version: 1; grader_type: string; options: Record<string, unknown>; input_mapping: EvalInputMapping } }): Promise<EvalSavedEvaluator> {
    return object(await controlRequest(this.options, "/eval-evaluators", "POST", {
      name: required(input.name, "evaluator.name"), description: input.description ?? "", config: input.config,
    }), "eval evaluator response must be a JSON object") as EvalSavedEvaluator;
  }

  async listWorkbenches(): Promise<EvalWorkbench[]> {
    return list<EvalWorkbench>(await controlRequest(this.options, "/eval-workbenches"), "eval workbenches response");
  }

  async createWorkbench(input: { name: string; description?: string; document: EvalWorkbenchDocument }): Promise<EvalWorkbench> {
    return object(await controlRequest(this.options, "/eval-workbenches", "POST", {
      name: required(input.name, "workbench.name"), description: input.description ?? "", document: input.document,
    }), "eval workbench response must be a JSON object") as EvalWorkbench;
  }

  async createExperiment(input: EvalExperimentCreateOptions): Promise<EvalExperiment> {
    const dataset = await this.createDataset(input.dataset);
    const datasetKey = required(input.datasetKey ?? "cases", "datasetKey");
    const workbench = await this.createWorkbench({
      name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      document: { ...input.document, datasets: [{ key: datasetKey, dataset_id: dataset.id }], active_dataset_key: datasetKey },
    });
    return { dataset, workbench, runs: this.workbench(workbench.id) };
  }
}

type ControlMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function controlRequest(options: EvalWorkbenchClientOptions, path: string, method: ControlMethod = "GET", body?: unknown): Promise<unknown> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("eval_request_timeout")), options.timeoutMs ?? 30_000);
    const signals = [timeout.signal, options.signal].filter((signal): signal is AbortSignal => signal !== undefined);
    const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
    try {
      const response = await fetch(`${options.controlURL}/api/v1/projects/${encodeURIComponent(options.projectId)}${path}`, {
        method,
        signal,
        redirect: "error",
        headers: {
          authorization: `Bearer ${options.accessToken}`,
          ...(method !== "GET" ? { "content-type": "application/json", "x-cave-csrf": "sdk" } : {}),
        },
        ...(method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {}),
      });
      const decoded = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        const error = decoded["error"];
        const envelope = error && typeof error === "object" && !Array.isArray(error) ? error as Record<string, unknown> : {};
        throw new EvalControlError(response.status, typeof envelope["code"] === "string" ? envelope["code"] : "cave_eval_request_failed", typeof envelope["message"] === "string" ? envelope["message"] : `eval request failed (${response.status})`);
      }
      return decoded;
    } finally {
      clearTimeout(timer);
    }
}

// --- Local eval harness ------------------------------------------------------
//
// Eval() keeps one experiment and one dataset per name. It runs the caller's
// task in this process, then starts a run of that experiment that carries the
// outputs: the experiment's one target is "external", so Caveman grades the
// outputs and never reads them as its own execution. Library criteria and
// inline graders ({ type: ... }) are graded by Caveman in that run and decide
// it; the verdict against a baseline is the server's too. Local criterion
// functions run here and are sent as external evidence, which the server
// stamps `external_observed`: shown, never trusted, never gating.

export type EvalRow = { id?: string; input: unknown; expected?: unknown; metadata?: unknown; tags?: string[] };
/** A stored dataset by id or name; `version` reads that snapshot, `split` keeps rows tagged `split:<name>`. */
export type EvalDatasetRef = { dataset: string; version?: number; split?: string };
/** Passed to the task as its second argument. `trace` is the open `cave.trace` when `cave` was given. */
export type EvalTaskContext = {
  name: string; rowKey: string; trial: number; traceId: string; expected: unknown; trace?: unknown;
  /** Aborts when this call runs past `taskTimeoutMs` or the eval's `signal` aborts. Hand it to `fetch` or the model SDK so a call that timed out stops before it is tried again. */
  signal: AbortSignal;
};
export type EvalLocalVerdict = boolean | { passed: boolean; score?: number; reason?: string };
export type EvalLocalCriterion = (args: { input: unknown; output: unknown; expected: unknown; rowKey: string; trial: number }) => EvalLocalVerdict | Promise<EvalLocalVerdict>;
/** A grader Caveman runs on each output: its `type`, an optional `name`, and every other key one of its options. */
export type EvalInlineGrader = { type: string; name?: string; [option: string]: unknown };
/**
 * A string names a library criterion (id or name) and an object with `type` is
 * an inline grader: Caveman grades both in the run and both decide `passed`.
 * A function, or `{ name, grade }`, is a local criterion, never trusted.
 */
export type EvalCriterion = string | EvalInlineGrader | EvalLocalCriterion | { name: string; grade: EvalLocalCriterion };

export type EvalVerdict = {
  criterion: string;
  /** "caveman": graded server-side in the experiment run. "local": graded by the caller's function, never trusted. */
  gradedBy: "caveman" | "local";
  status: "completed" | "error" | "skipped";
  passed: boolean | null;
  score?: number;
  reason?: string;
  /** The server's own result for a Caveman-graded verdict, as returned. */
  detail?: Record<string, unknown>;
};

export type EvalRowOutcome = {
  rowKey: string;
  /** The same as `rowKey`: a trial is a trial of its row, not a row of its own. */
  sourceRowKey: string;
  trial: number;
  input: unknown;
  expected: unknown;
  output: unknown;
  error?: string;
  /** Of the task call that gave the output, or of the last one that failed. */
  durationMs: number;
  traceId: string;
  /** Task calls made for this trial: over 1 when a call threw or timed out and was tried again. */
  attempts: number;
  finishedAt: string;
  verdicts: EvalVerdict[];
};

export type EvalProgress =
  | { type: "start"; name: string; rows: number; trials: number }
  | { type: "row"; rowKey: string; trial: number; completed: number; total: number; status: "completed" | "error"; traceId: string; attempts: number }
  | { type: "upload"; step: "dataset" | "experiment" | "run" | "local_criteria" }
  | { type: "grading"; completed: number; total: number; status: string }
  | { type: "done"; passed: boolean | null; url: string | null };

export type EvalOptions = {
  /** Inline rows, kept as the dataset named like the eval, or a stored dataset. */
  data: EvalRow[] | EvalDatasetRef;
  task: (input: unknown, context: EvalTaskContext) => unknown | Promise<unknown>;
  criteria: EvalCriterion[];
  /** Times the task runs per row, 1 to 10: trials of one case. */
  trials?: number;
  /** A finished run of this experiment to read this one against; without it the experiment's saved baseline is used, when it has one. */
  baseline?: { runId: string; workbenchId?: string };
  /** Stored on the experiment as the rule its comparisons are read by, here, in `cvm` and in the console; without it the experiment's stored policy decides. */
  gatePolicy?: "kernel" | "strict";
  /** Required unless `dryRun`, and to read a dataset reference. */
  cloud?: Pick<Cloud, "execute">;
  /** A `Cave` client: each task call then runs inside `cave.trace` with the row's trace id. */
  cave?: { trace<T>(options: { workflow?: string; tags?: Record<string, string>; traceId?: string }, fn: (trace: unknown) => Promise<T>): Promise<T> };
  /** Run the task and local criteria only: nothing is written, server criteria are not graded. */
  dryRun?: boolean;
  /** Task calls in flight at once, default 4. */
  concurrency?: number;
  /** Times a task call that threw or timed out is tried again, 0 to 10, default 2. A failed verdict is never retried. */
  retries?: number;
  /** The longest one task call may take. A call past it fails and its `context.signal` aborts; a task that ignores the signal runs on. */
  taskTimeoutMs?: number;
  /** Stops the eval: no task call starts after it aborts, the calls in flight see their `context.signal` abort, and `Eval` rejects with its reason. Nothing more is written. */
  signal?: AbortSignal;
  /** The most grading the run may spend, at list prices. An agent connection must name one. */
  budgetUSD?: number;
  /** Where what ran is written when the upload fails, default the working directory; null writes nothing. */
  resultsDir?: string | null;
  onProgress?: (event: EvalProgress) => void;
  /** No progress lines on stderr. */
  quiet?: boolean;
  /** Console origin for the printed link, e.g. the installation's public URL. */
  consoleURL?: string;
  pollMs?: number;
  timeoutMs?: number;
};

/** The server's reading of the run against a baseline run of the same experiment (evals.compare). */
export type EvalBaseline =
  | { runId: string | null; comparable: false; reason: string; computedBy: "caveman" }
  | {
    runId: string;
    /** "query" for the run named, "experiment" for the experiment's saved baseline, "project" for the project's default. */
    source: string | null;
    comparable: true;
    computedBy: "caveman";
    /** passed, failed, need_more_data or incomplete. */
    verdict: string;
    /** kernel or strict: the rule the verdict was read by. */
    policy: string | null;
    /** "experiment" for the experiment's stored gate policy, "query" when the request named one. */
    policySource: string | null;
    summary: string | null;
    pairedCases: number;
    regressions: number;
    improvements: number;
    unchanged: number | null;
    unpaired: number | null;
    /** The cases a criterion moved on, as the server returned them. */
    changedCases: unknown[];
    statistics: unknown;
  };

export type EvalResult = {
  name: string;
  /** null when no server criterion was graded (dry run), so nothing is claimed. */
  passed: boolean | null;
  dryRun: boolean;
  rows: EvalRowOutcome[];
  summary: {
    rows: number;
    taskErrors: number;
    /** Trials whose task was called more than once. */
    retried: number;
    /** Local criterion functions: counted here, never trusted. */
    local: { passed: number; failed: number; errors: number; trusted: false };
    /** The server's quality for the run; null when nothing was graded server-side. */
    server: { status: string; reason?: string; passed: number; failed: number; cells: number; evidence_basis: string } | null;
    /** Server criteria named but not graded. */
    notGraded: string[];
  };
  upload: {
    datasetId: string;
    workbenchId: string;
    runId: string;
    runStatus: string;
    url: string | null;
    localEvidence: { accepted: number; rejected: number; duplicate: number; conflict: number } | null;
  } | null;
  /** null when no baseline was named and the experiment has none saved. */
  baseline: EvalBaseline | null;
};

/** What `Eval` writes when its upload fails, and `uploadEvalResult` sends later. */
export type SavedEvalResult = {
  schema_version: 1;
  name: string;
  trials: number;
  request_id: string;
  server_criteria: boolean;
  baseline_run_id: string | null;
  budget_usd: number | null;
  dataset_id: string;
  workbench_id: string;
  result: EvalResult;
};

/**
 * The task and local criteria finished, the upload did not. `result` holds
 * what ran; `savedPath` is the file `uploadEvalResult` sends later without
 * running the task again, null when it could not be written.
 */
export class EvalUploadError extends Error {
  constructor(message: string, readonly result: EvalResult, readonly savedPath: string | null = null, options?: ErrorOptions) {
    super(message, options);
    this.name = "EvalUploadError";
  }
}

const rowKeyPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

type DatasetReference = { key: "cases"; dataset_id: string; version?: number; document_sha256?: string };
type LoadedData = { columns: EvalColumn[]; rows: Array<{ key: string; values: Record<string, unknown>; tags: string[] }>; source: string; reference: DatasetReference | null };
type Emit = (event: EvalProgress, line: string) => void;
type UploadOptions = Pick<EvalOptions, "onProgress" | "quiet" | "consoleURL" | "pollMs" | "timeoutMs">;

async function call<K extends CloudOperation>(cloud: Pick<Cloud, "execute">, operation: K, input: unknown, idempotencyKey?: string): Promise<CloudOperations[K]["output"]> {
  return (await cloud.execute(operation, input as never, idempotencyKey ? { idempotencyKey } : {})).data;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function progress(options: UploadOptions): Emit {
  return (event, line) => {
    options.onProgress?.(event);
    if (!options.quiet) console.error(`[caveman eval] ${line}`);
  };
}

async function loadEvalData(data: EvalRow[] | EvalDatasetRef, cloud: Pick<Cloud, "execute"> | undefined): Promise<LoadedData> {
  if (Array.isArray(data)) {
    const has = (key: "expected" | "metadata") => data.some((row) => row[key] !== undefined);
    return {
      source: "inline rows",
      reference: null,
      columns: [
        { key: "input", name: "Input", type: "json", role: "input" },
        ...(has("expected") ? [{ key: "expected", name: "Expected", type: "json", role: "expected" } as const] : []),
        ...(has("metadata") ? [{ key: "metadata", name: "Metadata", type: "json", role: "metadata" } as const] : []),
      ],
      rows: data.map((row, index) => ({
        key: row.id ?? `row-${index + 1}`,
        values: { input: row.input, ...(row.expected !== undefined ? { expected: row.expected } : {}), ...(row.metadata !== undefined ? { metadata: row.metadata } : {}) },
        tags: row.tags ?? [],
      })),
    };
  }
  if (!cloud) throw new Error("a dataset reference needs `cloud`; pass inline rows to run offline");
  let id = required(data.dataset, "data.dataset");
  if (!uuidPattern.test(id)) {
    const found = ((await call(cloud, "datasets.list", {})).data ?? []).find((dataset) => dataset.name.toLowerCase() === id.toLowerCase());
    if (!found) throw new Error(`dataset "${id}" was not found in this project`);
    id = found.id;
  }
  const detail = await call(cloud, "datasets.get", { dataset_id: id });
  const reference: DatasetReference = { key: "cases", dataset_id: id };
  let columns = detail.dataset.columns as EvalColumn[];
  let rows: LoadedData["rows"];
  if (data.version === undefined) {
    rows = [...(detail.rows ?? [])].sort((a, b) => a.position - b.position).map((row) => ({ key: row.row_key, values: object(row.values, "dataset row values must be an object"), tags: row.tags ?? [] }));
  } else {
    const version = (detail.versions ?? []).find((candidate) => candidate.version === data.version);
    if (!version) throw new Error(`dataset ${id} has no version ${data.version}`);
    columns = version.document.columns as EvalColumn[];
    rows = version.document.rows.map((row) => ({ key: row.row_key, values: row.values, tags: row.tags ?? [] }));
    reference.version = data.version;
    reference.document_sha256 = version.document_sha256;
  }
  if (data.split) rows = rows.filter((row) => row.tags.includes(`split:${data.split}`));
  return { source: `dataset ${id}${data.version === undefined ? "" : ` version ${data.version}`}${data.split ? ` split ${data.split}` : ""}`, columns, rows, reference };
}

/** One column of a role is its value; several are an object by column key. */
function roleValue(columns: EvalColumn[], values: Record<string, unknown>, role: EvalColumn["role"]): unknown {
  const keys = columns.filter((column) => column.role === role).map((column) => column.key);
  if (keys.length <= 1) return keys[0] === undefined ? undefined : values[keys[0]];
  return Object.fromEntries(keys.map((key) => [key, values[key]]));
}

async function resolveLibraryCriteria(cloud: Pick<Cloud, "execute">, names: string[]): Promise<Array<{ id: string; name: string; version: number }>> {
  return Promise.all(names.map(async (name) => {
    if (uuidPattern.test(name)) {
      const criterion = await call(cloud, "criteria.get", { criterion_id: name });
      return { id: criterion.id, name: criterion.name, version: criterion.version };
    }
    const found = ((await call(cloud, "criteria.list", { q: name, limit: 100 })).data ?? []).filter((criterion) => criterion.name.toLowerCase() === name.toLowerCase());
    if (found.length !== 1) throw new Error(found.length === 0 ? `criterion "${name}" was not found in this project's library` : `criterion name "${name}" is ambiguous; pass its id`);
    return { id: found[0]!.id, name: found[0]!.name, version: found[0]!.version };
  }));
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "criterion";
}

/** The experiment's server-graded criteria: library criteria at their version, and inline graders on the task's output. */
function evaluators(resolved: Array<{ id: string; name: string; version: number }>, inline: EvalInlineGrader[], columns: EvalColumn[]): Array<Record<string, unknown> & { key: string }> {
  const expected = columns.find((column) => column.role === "expected")?.key;
  const mapping = { candidate: { source: "target", key: "$target" }, ...(expected ? { reference: { source: "dataset", key: expected } } : {}) };
  const drafts: Array<Record<string, unknown> & { name: string }> = [
    ...resolved.map((criterion) => ({ name: criterion.name, source: "criterion", criterion_id: criterion.id, criterion_version: criterion.version })),
    ...inline.map(({ type, name, ...options }) => ({ name: String(name || type), source: "inline", grader_type: type, options, input_mapping: mapping })),
  ];
  const taken = new Set<string>();
  const out = drafts.map((draft) => {
    let key = slug(draft.name);
    for (let count = 2; taken.has(key); count += 1) key = `${slug(draft.name)}_${count}`;
    taken.add(key);
    return { key, ...draft };
  });
  // Keyed by name and sorted: two runs compare when their criteria are the
  // same, whatever order the caller listed them in.
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Why `stop` aborted, as an Error. */
function stopReason(stop: AbortSignal): Error {
  return stop.reason instanceof Error ? stop.reason : new Error("eval_aborted");
}

/**
 * `call(signal)`, rejecting once `timeoutMs` pass or `stop` aborts; `signal`
 * aborts then too. JavaScript cannot stop a call: one that ignores its signal
 * runs on, and its answer is dropped.
 */
async function within<T>(call: (signal: AbortSignal) => Promise<T>, timeoutMs: number | undefined, stop: AbortSignal | undefined): Promise<T> {
  const attempt = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped: (() => void) | undefined;
  const ended = new Promise<never>((_, reject) => {
    const end = (reason: Error) => { attempt.abort(reason); reject(reason); };
    if (timeoutMs !== undefined) timer = setTimeout(() => end(new Error(`the task took longer than ${timeoutMs / 1000} s`)), timeoutMs);
    if (stop) {
      stopped = () => end(stopReason(stop));
      if (stop.aborted) stopped();
      else stop.addEventListener("abort", stopped, { once: true });
    }
  });
  try {
    return await Promise.race([call(attempt.signal), ended]);
  } finally {
    clearTimeout(timer);
    if (stopped) stop?.removeEventListener("abort", stopped);
  }
}

function locallyPassed(summary: EvalResult["summary"]): boolean {
  return summary.taskErrors === 0 && summary.local.failed === 0 && summary.local.errors === 0;
}

/**
 * Run `task` over `data` here, grade with `criteria`, and add a run to the
 * experiment named `name`. The same name is the same experiment and the same
 * dataset every time, so its runs line up: unchanged rows reuse the dataset's
 * version, and the run is read against the experiment's saved baseline on the
 * server. Resolves with every row's outcome and a pass or fail summary; it
 * never exits the process, so a test asserts on `result.passed`. A run whose
 * upload fails after the task ran rejects with `EvalUploadError`; what ran is
 * written under `resultsDir` for `uploadEvalResult`.
 */
export async function Eval(name: string, options: EvalOptions): Promise<EvalResult> {
  required(name, "name");
  const trials = positiveInteger(options.trials, 1, "trials", 10);
  const concurrency = positiveInteger(options.concurrency, 4, "concurrency", 64);
  const retries = options.retries ?? 2;
  if (!Number.isInteger(retries) || retries < 0 || retries > 10) throw new Error("retries must be an integer from 0 to 10");
  if (options.taskTimeoutMs !== undefined && !(options.taskTimeoutMs > 0)) throw new Error("taskTimeoutMs must be a number greater than 0");
  const stop = options.signal;
  if (stop?.aborted) throw stopReason(stop);
  // The upload's own arguments are checked before the task runs, not after it and the server's grading.
  positiveInteger(options.timeoutMs, 1_800_000, "timeoutMs", 86_400_000);
  positiveInteger(options.pollMs, 1000, "pollMs", 60_000);
  if (options.budgetUSD !== undefined && !(Number.isFinite(options.budgetUSD) && options.budgetUSD >= 0)) throw new Error("budgetUSD must be a number of zero or more");
  const dryRun = options.dryRun === true;
  if (!dryRun && !options.cloud) throw new Error("Eval needs `cloud` to upload; pass dryRun: true to run without uploading");
  const emit = progress(options);

  const isInline = (criterion: EvalCriterion): criterion is EvalInlineGrader => typeof criterion === "object" && "type" in criterion;
  const library = options.criteria.filter((criterion): criterion is string => typeof criterion === "string");
  const inline = options.criteria.filter(isInline);
  const local = options.criteria.filter((criterion) => typeof criterion !== "string" && !isInline(criterion)).map((criterion, index) => typeof criterion === "function"
    ? { name: criterion.name || `local_${index + 1}`, grade: criterion }
    : criterion as { name: string; grade: EvalLocalCriterion });
  if (new Set(local.map((criterion) => criterion.name)).size !== local.length) throw new Error("local criteria need distinct names");
  if (inline.some((grader) => typeof grader.type !== "string" || !grader.type)) throw new Error('an inline grader names its type: { type: "contains", ... }');
  const serverNames = [...library, ...inline.map((grader) => String(grader.name || grader.type))];

  const data = await loadEvalData(options.data, options.cloud);
  const units = data.rows.flatMap((row) => Array.from({ length: trials }, (_, index) => ({ row, trial: index + 1 })));
  if (units.length === 0) throw new Error(`${data.source} has no rows to run`);
  if (data.rows.length > 10_000) throw new Error("a dataset holds at most 10000 rows");
  if (new Set(data.rows.map((row) => row.key)).size !== data.rows.length || data.rows.some((row) => !rowKeyPattern.test(row.key))) throw new Error("row ids must be unique and match [A-Za-z0-9][A-Za-z0-9_-]{0,95}");

  // Before the task runs: a misspelled criterion, an unknown grader type or a
  // missing permission should not cost a full run.
  const requestId = hex(crypto.getRandomValues(new Uint8Array(16)));
  let datasetId = "";
  let workbenchId = "";
  if (!dryRun) {
    const cloud = options.cloud!;
    const resolved = library.length === 0 ? [] : await resolveLibraryCriteria(cloud, library);
    const provenance = `Local eval "${name}" run by the Caveman SDK. Outputs are produced by the caller's task, not by Caveman.`;
    let reference = data.reference;
    if (!reference) {
      emit({ type: "upload", step: "dataset" }, "saving the cases as a dataset");
      const dataset = await call(cloud, "datasets.create", {
        name, description: provenance, upsert: true,
        document: { schema_version: 1, columns: data.columns, rows: data.rows.map((row) => ({ row_key: row.key, values: row.values, ...(row.tags.length ? { tags: row.tags } : {}) })) },
      }, `${requestId}:dataset`);
      reference = { key: "cases", dataset_id: dataset.id };
    }
    emit({ type: "upload", step: "experiment" }, "finding or creating the experiment");
    const workbench = await call(cloud, "evals.create", {
      name, description: provenance, upsert: true,
      document: {
        schema_version: 1, datasets: [reference],
        targets: [{ key: "local_task", name: "Local task (run by the SDK)", kind: "external", input_mapping: {}, config: {} }],
        evaluators: evaluators(resolved, inline, data.columns),
      },
    }, `${requestId}:experiment`);
    if (options.gatePolicy) await call(cloud, "evals.set_baseline", { workbench_id: workbench.id, gate_policy: options.gatePolicy });
    datasetId = reference.dataset_id;
    workbenchId = workbench.id;
  }

  emit({ type: "start", name, rows: data.rows.length, trials }, `${name}: ${data.rows.length} rows x ${trials} trial(s) from ${data.source}`);
  const outcomes = new Array<EvalRowOutcome>(units.length);
  let next = 0;
  let completed = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, units.length) }, async () => {
    for (let index = next++; index < units.length && !stop?.aborted; index = next++) {
      const { row, trial } = units[index]!;
      const key = row.key;
      const input = roleValue(data.columns, row.values, "input");
      const expected = roleValue(data.columns, row.values, "expected");
      const traceId = hex(crypto.getRandomValues(new Uint8Array(16)));
      const context = { name, rowKey: key, trial, traceId, expected };
      const outcome: EvalRowOutcome = { rowKey: key, sourceRowKey: key, trial, input, expected, output: null, durationMs: 0, traceId, attempts: 0, finishedAt: "", verdicts: [] };
      for (;;) {
        outcome.attempts += 1;
        const started = Date.now();
        try {
          const output = await within(async (signal) => options.cave
            ? options.cave.trace({ workflow: name, traceId, tags: { eval: name, eval_row: key, eval_trial: String(trial) } }, async (trace) => options.task(input, { ...context, trace, signal }))
            : options.task(input, { ...context, signal }), options.taskTimeoutMs, stop);
          outcome.output = output === undefined ? null : output;
          delete outcome.error;
        } catch (error) {
          outcome.error = error instanceof Error ? error.message : String(error);
        }
        outcome.durationMs = Date.now() - started;
        // Stopped: this row is not finished, and nothing more starts.
        if (stop?.aborted) return;
        if (outcome.error === undefined || outcome.attempts > retries) break;
        await delay(Math.min(500 * 2 ** (outcome.attempts - 1), 8000), stop).catch(() => undefined);
        if (stop?.aborted) return;
      }
      for (const criterion of local) {
        if (outcome.error !== undefined) {
          outcome.verdicts.push({ criterion: criterion.name, gradedBy: "local", status: "skipped", passed: null, reason: "the task failed" });
          continue;
        }
        try {
          const verdict = await criterion.grade({ input, output: outcome.output, expected, rowKey: key, trial });
          const normalized = typeof verdict === "boolean" ? { passed: verdict } : verdict;
          if (typeof normalized?.passed !== "boolean") throw new Error("a local criterion returns a boolean or { passed, score?, reason? }");
          outcome.verdicts.push({ criterion: criterion.name, gradedBy: "local", status: "completed", passed: normalized.passed, ...(normalized.score === undefined ? {} : { score: normalized.score }), ...(normalized.reason === undefined ? {} : { reason: normalized.reason }) });
        } catch (error) {
          outcome.verdicts.push({ criterion: criterion.name, gradedBy: "local", status: "error", passed: null, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      outcome.finishedAt = new Date().toISOString();
      outcomes[index] = outcome;
      completed += 1;
      emit({ type: "row", rowKey: key, trial, completed, total: units.length, status: outcome.error === undefined ? "completed" : "error", traceId, attempts: outcome.attempts },
        `${completed}/${units.length} ${key}${trials > 1 ? ` trial ${trial}` : ""}${outcome.error === undefined ? " ok" : ` error: ${outcome.error}`}${outcome.attempts > 1 ? ` (attempt ${outcome.attempts})` : ""}`);
    }
  }));
  if (stop?.aborted) throw stopReason(stop);

  const localVerdicts = outcomes.flatMap((outcome) => outcome.verdicts);
  const result: EvalResult = {
    name, passed: null, dryRun, rows: outcomes, upload: null, baseline: null,
    summary: {
      rows: outcomes.length,
      taskErrors: outcomes.filter((outcome) => outcome.error !== undefined).length,
      retried: outcomes.filter((outcome) => outcome.attempts > 1).length,
      local: { passed: localVerdicts.filter((verdict) => verdict.passed === true).length, failed: localVerdicts.filter((verdict) => verdict.passed === false).length, errors: localVerdicts.filter((verdict) => verdict.status === "error").length, trusted: false },
      server: null,
      notGraded: dryRun ? serverNames : [],
    },
  };
  if (dryRun) {
    for (const outcome of outcomes) for (const criterion of serverNames) outcome.verdicts.push({ criterion, gradedBy: "caveman", status: "skipped", passed: null, reason: "dry run: Caveman grades this criterion on upload" });
    const localPassed = locallyPassed(result.summary);
    result.passed = serverNames.length === 0 ? localPassed : localPassed ? null : false;
    emit({ type: "done", passed: result.passed, url: null }, `${name}: dry run, nothing uploaded${serverNames.length ? `; not graded: ${serverNames.join(", ")}` : ""}`);
    return result;
  }

  const pending: SavedEvalResult = { schema_version: 1, name, trials, request_id: requestId, server_criteria: serverNames.length > 0, baseline_run_id: options.baseline?.runId ?? null,
    budget_usd: options.budgetUSD ?? null, dataset_id: datasetId, workbench_id: workbenchId, result };
  try {
    return await upload(pending, options.cloud!, emit, options);
  } catch (error) {
    const savedPath = await save(pending, options.resultsDir === undefined ? "." : options.resultsDir);
    throw new EvalUploadError(`eval "${name}" ran but its upload failed: ${error instanceof Error ? error.message : String(error)}${savedPath ? `; what ran is in ${savedPath}, send it with uploadEvalResult` : ""}`, result, savedPath, { cause: error });
  }
}

type NodeFiles = { writeFile(path: string, data: string): Promise<void>; readFile(path: string, encoding: "utf8"): Promise<string> };

// Not a static import: the SDK also runs where there is no file system, and
// there nothing is saved.
async function nodeFiles(): Promise<NodeFiles> {
  const specifier = "node:fs/promises";
  return await import(specifier) as NodeFiles;
}

async function save(pending: SavedEvalResult, resultsDir: string | null): Promise<string | null> {
  if (resultsDir === null) return null;
  const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, "");
  const path = `${resultsDir.replace(/\/+$/, "")}/caveman-eval-${slug(pending.name)}-${stamp}-${hex(crypto.getRandomValues(new Uint8Array(3)))}.json`;
  try {
    await (await nodeFiles()).writeFile(path, JSON.stringify(pending));
    return path;
  } catch {
    return null;
  }
}

/**
 * Send a finished eval whose upload failed, from the file
 * `EvalUploadError.savedPath` names. The task is not run again: the saved
 * outputs and local verdicts are sent as they were, and a run the first
 * attempt already started is waited for, not started twice. Resolves with
 * what `Eval` would have; rejects with `EvalUploadError` when the upload fails
 * again (the file is left as it is).
 */
export async function uploadEvalResult(saved: string | SavedEvalResult, options: UploadOptions & { cloud: Pick<Cloud, "execute"> }): Promise<EvalResult> {
  const pending = typeof saved === "string" ? JSON.parse(await (await nodeFiles()).readFile(saved, "utf8")) as SavedEvalResult : saved;
  if (pending?.schema_version !== 1 || typeof pending.result !== "object" || pending.result === null || !pending.workbench_id) throw new Error("not a saved eval result");
  try {
    return await upload(pending, options.cloud, progress(options), options);
  } catch (error) {
    throw new EvalUploadError(`eval "${pending.name}" upload failed: ${error instanceof Error ? error.message : String(error)}`, pending.result, null, { cause: error });
  }
}

type ServerComparison = {
  baseline_run_id: string; baseline_source?: string; quality: string; policy?: string; policy_source?: string; summary?: string;
  paired_cells: number; regressions: number; improvements: number; unchanged?: number; unpaired?: number; changed_cases?: unknown[]; statistics?: unknown;
};

/** Start the run that carries the outputs, wait for Caveman to grade it, and read it against the baseline. */
async function upload(pending: SavedEvalResult, cloud: Pick<Cloud, "execute">, emit: Emit, options: UploadOptions): Promise<EvalResult> {
  const { name, result, workbench_id: workbenchId } = pending;
  const outcomes = result.rows;
  const url = options.consoleURL ? `${options.consoleURL.replace(/\/+$/, "")}/experiments/workbenches/${workbenchId}` : null;
  if (!result.upload?.runId) {
    emit({ type: "upload", step: "run" }, "starting the run");
    const scope = { kind: "all", ...(pending.trials > 1 ? { trials: pending.trials } : {}), ...(pending.budget_usd ? { budget_usd: pending.budget_usd } : {}) };
    const run = (await call(cloud, "evals.run", { workbench_id: workbenchId, scope, outputs: outcomes.map((outcome) => ({
      row_key: outcome.rowKey, trial: outcome.trial, trace_id: outcome.traceId, latency_ms: outcome.durationMs, attempts: outcome.attempts,
      ...(outcome.error === undefined ? { output: outcome.output } : { error: outcome.error.slice(0, 2000) }),
    })) }, `${pending.request_id}:run`)).run;
    result.upload = { datasetId: pending.dataset_id, workbenchId, runId: run.id, runStatus: run.status, url, localEvidence: null };
  }
  const uploaded = result.upload;
  uploaded.url = url;
  const runId = uploaded.runId;

  const evidence = [];
  for (const outcome of outcomes) {
    // A second upload of a saved result reads the server's verdicts again.
    outcome.verdicts = outcome.verdicts.filter((verdict) => verdict.gradedBy === "local");
    for (const verdict of outcome.verdicts) {
      if (verdict.status === "skipped") continue;
      const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`local_function:${verdict.criterion}`))));
      evidence.push({
        observed_at: outcome.finishedAt, result_at: outcome.finishedAt, trace_id: outcome.traceId,
        source_system: "caveman-sdk-local-eval", source_run_id: runId, source_suite_id: workbenchId, source_case_id: outcome.rowKey,
        evaluator_name: verdict.criterion, evaluator_type: "local_function", evaluator_version: "local", evaluator_config_digest: digest,
        completeness: "complete", idempotency_key: `${runId}/${outcome.rowKey}/${outcome.trial}/${verdict.criterion}`,
        ...(verdict.status === "completed"
          ? { status: "processed", passed: verdict.passed, ...(verdict.score === undefined ? {} : { score: verdict.score }) }
          : { status: "error", fault: "customer" }),
        ...(verdict.reason ? { explanation: verdict.reason.slice(0, 1000) } : {}),
      });
    }
  }
  if (evidence.length > 0) {
    emit({ type: "upload", step: "local_criteria" }, "recording local criteria as external evidence (never trusted)");
    const totals = { accepted: 0, rejected: 0, duplicate: 0, conflict: 0 };
    for (let start = 0; start < evidence.length; start += 500) {
      const batch = await call(cloud, "evals.ingest_evidence", { items: evidence.slice(start, start + 500) });
      totals.accepted += batch.accepted; totals.rejected += batch.rejected; totals.duplicate += batch.duplicate; totals.conflict += batch.conflict;
    }
    uploaded.localEvidence = totals;
    if (totals.rejected > 0) throw new Error(`Caveman rejected ${totals.rejected} local criterion result(s)`);
  }

  const deadline = Date.now() + positiveInteger(options.timeoutMs, 1_800_000, "timeoutMs", 86_400_000);
  const pollMs = positiveInteger(options.pollMs, 1000, "pollMs", 60_000);
  let detail = await call(cloud, "evals.result", { workbench_id: workbenchId, run_id: runId });
  while (!terminalStatuses.has(detail.run.status as EvalRunStatus)) {
    emit({ type: "grading", completed: detail.run.progress_completed, total: detail.run.progress_total, status: detail.run.status }, `grading ${detail.run.progress_completed}/${detail.run.progress_total}`);
    if (Date.now() >= deadline) throw new Error("eval_wait_timeout");
    await delay(pollMs);
    detail = await call(cloud, "evals.result", { workbench_id: workbenchId, run_id: runId });
  }
  uploaded.runStatus = detail.run.status;
  const byCell = new Map(outcomes.map((outcome) => [`${outcome.rowKey}\u0000${outcome.trial}`, outcome]));
  for (const cell of (detail.cells ?? []) as Array<{ dataset_row_key: string; trial?: number; evaluator_results?: unknown }>) {
    const outcome = byCell.get(`${cell.dataset_row_key}\u0000${cell.trial ?? 1}`);
    for (const graded of outcome && Array.isArray(cell.evaluator_results) ? cell.evaluator_results as Array<Record<string, unknown>> : []) {
      const status = graded["status"] === "completed" ? "completed" : "error";
      outcome!.verdicts.push({
        criterion: String(graded["name"] ?? graded["key"]), gradedBy: "caveman", status, passed: status === "completed" && typeof graded["passed"] === "boolean" ? graded["passed"] : null,
        ...(typeof graded["score"] === "number" ? { score: graded["score"] } : {}), ...(typeof graded["reason"] === "string" ? { reason: graded["reason"] } : {}), detail: graded,
      });
    }
  }
  if (pending.server_criteria) result.summary.server = detail.quality;

  // The verdict against a baseline is the server's: the run named, else the
  // experiment's saved baseline. With neither there is nothing to read it against.
  const explicit = pending.baseline_run_id;
  result.baseline = null;
  if (pending.server_criteria && detail.run.status === "completed") {
    const saved = explicit ? null : await call(cloud, "evals.get_baseline", { workbench_id: workbenchId });
    if (explicit || saved?.experiment || saved?.project) {
      try {
        const compared = await call(cloud, "evals.compare", { workbench_id: workbenchId, candidate_run_id: runId, ...(explicit ? { baseline_run_id: explicit } : {}) }) as unknown as ServerComparison;
        result.baseline = {
          runId: compared.baseline_run_id, source: compared.baseline_source ?? null, comparable: true, computedBy: "caveman",
          verdict: compared.quality, policy: compared.policy ?? null, policySource: compared.policy_source ?? null, summary: compared.summary ?? null,
          pairedCases: compared.paired_cells, regressions: compared.regressions, improvements: compared.improvements,
          unchanged: compared.unchanged ?? null, unpaired: compared.unpaired ?? null, changedCases: compared.changed_cases ?? [], statistics: compared.statistics ?? null,
        };
      } catch (error) {
        // Only no baseline and a refusal to compare are answers. A project
        // default that is another experiment's run is no baseline of this one.
        const code = (error as { code?: unknown })?.code;
        if (code !== "cave_eval_no_baseline" && code !== "cave_eval_comparison_incompatible") throw error;
        if (code === "cave_eval_comparison_incompatible") result.baseline = { runId: explicit, comparable: false, reason: error instanceof Error ? error.message : String(error), computedBy: "caveman" };
      }
    }
  }

  const against = result.baseline;
  result.passed = locallyPassed(result.summary) && detail.run.status === "completed" && (!pending.server_criteria || detail.quality.status === "passed")
    && !(against?.comparable && against.verdict === "failed");
  const compared = !against ? "" : against.comparable ? `; against the baseline: ${against.summary ?? against.verdict}` : `; not compared: ${against.reason}`;
  emit({ type: "done", passed: result.passed, url }, `${name}: ${result.passed ? "passed" : "failed"}${compared}; ${url ?? `experiment ${workbenchId} run ${runId}`}`);
  return result;
}
