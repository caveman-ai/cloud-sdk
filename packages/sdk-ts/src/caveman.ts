/**
 * Unified Caveman Cloud SDK client (`Caveman`).
 *
 * One client, one scoped API key (`CAVEMAN_API_KEY` or `CAVE_TOKEN`), and one
 * Credits balance across all 10 Caveman Cloud primitives:
 *
 * - Inference: `inference` (models, multi-provider gateway, route, trim, compact)
 * - Managed Agents: `agents`, `sessions`, `sandboxes`
 * - State & Access: `drives`, `connectors`, `secrets` (write-only)
 * - Multi-Agent Apps: `rooms`, `apps`
 * - Quality & Control: `evals`, `approvals`, `credits`
 */
import {
  Agents,
  type AgentsAppendDriveFileInput,
  type AgentsApproveDriveChangesetInput,
  type AgentsArchiveDeploymentInput,
  type AgentsCallOptions,
  type AgentsCreateAgentInput,
  type AgentsCreateDriveInput,
  type AgentsDeleteDriveFileInput,
  type AgentsDeployInput,
  type AgentsDiffDriveQuery,
  type AgentsEditDriveFileInput,
  type AgentsForkDriveInput,
  type AgentsGrantDriveInput,
  type AgentsGrepDriveInput,
  type AgentsListAgentsQuery,
  type AgentsListDeploymentsQuery,
  type AgentsListDriveChangesQuery,
  type AgentsListDriveChangesetsQuery,
  type AgentsListDriveFileVersionsQuery,
  type AgentsListDriveFilesQuery,
  type AgentsListEventsQuery,
  type AgentsListSessionsQuery,
  type AgentsMergeDriveInput,
  type AgentsMoveDriveFileInput,
  type AgentsPauseDeploymentInput,
  type AgentsReadDriveTextInput,
  type AgentsRestoreDriveFileInput,
  type AgentsRestoreDriveInput,
  type AgentsResumeDeploymentInput,
  type AgentsRollbackDeploymentInput,
  type AgentsSendEventInput,
  type AgentsShareDriveInput,
  type AgentsStartDeploymentSessionInput,
  type AgentsStartSessionInput,
  type AgentsUndoDriveSessionInput,
  type AgentsUpdateAgentInput,
  type AgentsUpdateDriveInput,
  type AgentsWriteDriveTextInput,
  type CodeAgent,
  type CodeAgentBuildFiles,
  type CodeAgentVersion,
  type CodeDeployResult,
  type CodeDeployment,
  type CodeDeploymentRevision,
  type CodeDrive,
  type CodeDriveChangePage,
  type CodeDriveChangesetDecided,
  type CodeDriveChangesetView,
  type CodeDriveCreated,
  type CodeDriveDeleted,
  type CodeDriveDiff,
  type CodeDriveFile,
  type CodeDriveFilePage,
  type CodeDriveGrant,
  type CodeDriveGrepResult,
  type CodeDriveHistory,
  type CodeDriveMerged,
  type CodeDriveRestored,
  type CodeDriveShared,
  type CodeDriveText,
  type CodeDriveUndone,
  type CodeDriveUsage,
  type CodeDriveVerification,
  type CodeDriveWriteResult,
  type CodeMail,
  type CodeSession,
  type CodeStreamEvent,
} from './agents.generated.js';
import {Cloud, CloudError} from './cloud.js';
import {Eval, EvalProjectClient, EvalWorkbenchClient, uploadEvalResult} from './evals.js';
import {Gate} from './gate.js';
import {
  Cave,
  type CompactOptions,
  type CompactResult,
  type CompressOptions,
  type CompressResult,
  type RouteRequest,
  type RouteResult,
  type TrimOptions,
  type TrimResult,
} from './index.js';
import {Apps, ComputerPools, PlatformError, PlatformTransport, Rooms} from './platform2027.js';
import {Sandboxes} from './sandboxes.js';

export const DEFAULT_GATEWAY_URL = 'https://gateway.caveman.so';
export const DEFAULT_CONTROL_URL = 'https://api.caveman.so';

export interface CavemanOptions {
  /** Scoped Caveman Cloud API key (`cave_live_...`). Defaults to `CAVEMAN_API_KEY` or `CAVE_TOKEN`. */
  apiKey?: string;
  /** Inference gateway origin. Defaults to `CAVEMAN_GATEWAY_URL` or `https://gateway.caveman.so`. */
  baseURL?: string;
  /** Control plane API origin. Defaults to `CAVEMAN_API_URL` or `https://api.caveman.so`. */
  controlURL?: string;
  /** Optional relay origin for sandbox exec streams; defaults to `controlURL`. */
  relayURL?: string;
  /** Optional default project UUID for project-scoped operations (evals, prompts). */
  projectId?: string;
  /** Default agent label attached to gateway inference telemetry (default `"default"`). */
  agent?: string;
  /** Per-request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** Retry attempts on 429/5xx responses for idempotent/control calls (default 2). */
  retries?: number;
  /** Base retry delay in milliseconds (default 250). */
  retryDelayMs?: number;
  /** Optional custom fetch implementation (useful for tests). */
  fetch?: typeof globalThis.fetch;
}

function readEnv(name: string): string | undefined {
  return (globalThis as {process?: {env?: Record<string, string | undefined>}}).process?.env?.[name]?.trim() || undefined;
}

/* ============================= INFERENCE ================================ */

export interface ModelCatalogEntry {
  id: string;
  object?: string;
  owned_by?: string;
  endpoints?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export class InferenceClient {
  readonly gateway: Cave;
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly transport: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(opts: {
    baseURL: string;
    controlURL: string;
    apiKey: string;
    agent: string;
    timeoutMs: number;
    fetch?: typeof globalThis.fetch;
  }) {
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs;
    this.transport = opts.fetch ?? globalThis.fetch;
    this.gateway = new Cave({
      apiKey: opts.apiKey,
      baseURL: this.baseURL,
      controlURL: opts.controlURL,
      agent: opts.agent,
      timeoutMs: opts.timeoutMs,
    });
  }

  /** List models available through the unified inference gateway (`GET /v1/models`). */
  async models(opts?: {signal?: AbortSignal}): Promise<ModelCatalogEntry[]> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const res = await this.transport(`${this.baseURL}/v1/models`, {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: {authorization: `Bearer ${this.apiKey}`},
    });
    const body = (await res.json().catch(() => ({}))) as {data?: ModelCatalogEntry[]; error?: {code?: string; message?: string}};
    if (!res.ok) {
      throw new CloudError(body.error?.code ?? 'cave_request_failed', body.error?.message ?? `HTTP ${res.status}`, res.status);
    }
    return body.data ?? [];
  }

  /** Fetch per-attempt routing and cost metadata for a generation (`GET /v1/generations/{id}`). */
  async generation(generationId: string, opts?: {signal?: AbortSignal}): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const res = await this.transport(`${this.baseURL}/v1/generations/${encodeURIComponent(generationId)}`, {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: {authorization: `Bearer ${this.apiKey}`},
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & {error?: {code?: string; message?: string}};
    if (!res.ok) {
      throw new CloudError(body.error?.code ?? 'cave_request_failed', body.error?.message ?? `HTTP ${res.status}`, res.status);
    }
    return body;
  }

  openai(config: {upstreamKey?: string} = {}) { return this.gateway.openai(config); }
  anthropic(config: {upstreamKey?: string} = {}) { return this.gateway.anthropic(config); }
  gemini(config: {upstreamKey?: string} = {}) { return this.gateway.gemini(config); }
  bedrock(config: {region: string; endpoint?: 'runtime' | 'mantle'}) { return this.gateway.bedrock(config); }
  vertex(config: {upstreamKey?: string} = {}) { return this.gateway.vertex(config); }

  route(req: RouteRequest): Promise<RouteResult> { return this.gateway.route(req); }
  trim(input: string, query: string, opts?: TrimOptions): Promise<TrimResult> { return this.gateway.trim(input, query, opts); }
  compact<M = unknown>(messages: M[], opts: CompactOptions): Promise<CompactResult<M>> { return this.gateway.compact(messages, opts); }
  compress(input: string, opts?: CompressOptions): Promise<CompressResult> { return this.gateway.compress(input, opts); }
}

/* =========================== MANAGED AGENTS ============================= */

export class ManagedAgentsClient {
  constructor(private readonly raw: Agents) {}

  create(input: AgentsCreateAgentInput, opts?: AgentsCallOptions): Promise<CodeAgent> { return this.raw.createAgent(input, opts); }
  async list(query: AgentsListAgentsQuery = {}, opts?: AgentsCallOptions): Promise<CodeAgent[]> {
    const res = await this.raw.listAgents(query, opts);
    return res.agents ?? [];
  }
  get(agentId: string, opts?: AgentsCallOptions): Promise<CodeAgent> { return this.raw.getAgent(agentId, opts); }
  update(agentId: string, input: AgentsUpdateAgentInput, opts?: AgentsCallOptions): Promise<CodeAgent> { return this.raw.updateAgent(agentId, input, opts); }
  async versions(agentId: string, opts?: AgentsCallOptions): Promise<CodeAgentVersion[]> {
    const res = await this.raw.listAgentVersions(agentId, opts);
    return res.versions ?? [];
  }
  getVersion(agentId: string, version: number, opts?: AgentsCallOptions): Promise<CodeAgentVersion> { return this.raw.getAgentVersion(agentId, version, opts); }
  getBuild(agentId: string, version: number, opts?: AgentsCallOptions): Promise<CodeAgentBuildFiles> { return this.raw.getAgentBuild(agentId, version, opts); }
  archive(agentId: string, opts?: AgentsCallOptions): Promise<CodeAgent> { return this.raw.archiveAgent(agentId, opts); }

  deploy(input: AgentsDeployInput, opts?: AgentsCallOptions): Promise<CodeDeployResult> { return this.raw.deploy(input, opts); }
  async listDeployments(query: AgentsListDeploymentsQuery = {}, opts?: AgentsCallOptions): Promise<CodeDeployment[]> {
    const res = await this.raw.listDeployments(query, opts);
    return res.deployments ?? [];
  }
  getDeployment(deployment: string, opts?: AgentsCallOptions): Promise<CodeDeployment> { return this.raw.getDeployment(deployment, opts); }
  async revisions(deployment: string, opts?: AgentsCallOptions): Promise<CodeDeploymentRevision[]> {
    const res = await this.raw.listDeploymentRevisions(deployment, opts);
    return res.revisions ?? [];
  }
  rollback(deployment: string, input: AgentsRollbackDeploymentInput, opts?: AgentsCallOptions): Promise<CodeDeployment> { return this.raw.rollbackDeployment(deployment, input, opts); }
  pause(deployment: string, input: AgentsPauseDeploymentInput = {}, opts?: AgentsCallOptions): Promise<CodeDeployment> { return this.raw.pauseDeployment(deployment, input, opts); }
  resume(deployment: string, input: AgentsResumeDeploymentInput = {}, opts?: AgentsCallOptions): Promise<CodeDeployment> { return this.raw.resumeDeployment(deployment, input, opts); }
  archiveDeployment(deployment: string, input: AgentsArchiveDeploymentInput = {}, opts?: AgentsCallOptions): Promise<CodeDeployment> { return this.raw.archiveDeployment(deployment, input, opts); }

  /** Start a durable session against a named live deployment. */
  run(deployment: string, input: AgentsStartDeploymentSessionInput, opts?: AgentsCallOptions): Promise<CodeSession> {
    return this.raw.startDeploymentSession(deployment, input, opts);
  }
}

/* ============================== SESSIONS ================================ */

export class SessionsClient {
  constructor(private readonly raw: Agents) {}

  start(input: AgentsStartSessionInput, opts?: AgentsCallOptions): Promise<CodeSession> { return this.raw.startSession(input, opts); }
  async list(query: AgentsListSessionsQuery = {}, opts?: AgentsCallOptions): Promise<CodeSession[]> {
    const res = await this.raw.listSessions(query, opts);
    return res.sessions ?? [];
  }
  get(sessionId: string, opts?: AgentsCallOptions): Promise<CodeSession> { return this.raw.getSession(sessionId, opts); }
  send(sessionId: string, input: AgentsSendEventInput, opts?: AgentsCallOptions): Promise<CodeMail> { return this.raw.sendEvent(sessionId, input, opts); }
  events(sessionId: string, query: AgentsListEventsQuery = {}, opts?: AgentsCallOptions) { return this.raw.listEvents(sessionId, query, opts); }
  stream(sessionId: string, query: {after?: number} = {}, opts?: Parameters<Agents['streamEvents']>[2]): AsyncGenerator<CodeStreamEvent, void, void> {
    return this.raw.streamEvents(sessionId, query, opts);
  }
  approve(sessionId: string, askId: string, requestId: string, message?: string, opts?: AgentsCallOptions): Promise<CodeMail> {
    return this.raw.sendEvent(sessionId, {
      request_id: requestId,
      type: 'user.approval',
      ask_id: askId,
      decision: 'allow',
      ...(message !== undefined ? {message} : {}),
    }, opts);
  }
  deny(sessionId: string, askId: string, requestId: string, message?: string, opts?: AgentsCallOptions): Promise<CodeMail> {
    return this.raw.sendEvent(sessionId, {
      request_id: requestId,
      type: 'user.approval',
      ask_id: askId,
      decision: 'deny',
      ...(message !== undefined ? {message} : {}),
    }, opts);
  }
}

/* =============================== DRIVES ================================= */

/** Fluent handle bound to a single Caveman Drive (by name or UUID). */
export class DriveHandle {
  constructor(private readonly raw: Agents, readonly id: string) {}

  get(opts?: AgentsCallOptions): Promise<CodeDrive> { return this.raw.getDrive(this.id, opts); }
  update(input: AgentsUpdateDriveInput, opts?: AgentsCallOptions): Promise<CodeDrive> { return this.raw.updateDrive(this.id, input, opts); }
  archive(opts?: AgentsCallOptions): Promise<CodeDrive> { return this.raw.archiveDrive(this.id, opts); }
  unarchive(opts?: AgentsCallOptions): Promise<CodeDrive> { return this.raw.unarchiveDrive(this.id, opts); }
  files(query: AgentsListDriveFilesQuery = {}, opts?: AgentsCallOptions): Promise<CodeDriveFilePage> { return this.raw.listDriveFiles(this.id, query, opts); }
  read(input: AgentsReadDriveTextInput, opts?: AgentsCallOptions): Promise<CodeDriveText> { return this.raw.readDriveText(this.id, input, opts); }
  write(input: AgentsWriteDriveTextInput, opts?: AgentsCallOptions): Promise<CodeDriveWriteResult> { return this.raw.writeDriveText(this.id, input, opts); }
  edit(input: AgentsEditDriveFileInput, opts?: AgentsCallOptions): Promise<CodeDriveWriteResult> { return this.raw.editDriveFile(this.id, input, opts); }
  append(input: AgentsAppendDriveFileInput, opts?: AgentsCallOptions): Promise<CodeDriveWriteResult> { return this.raw.appendDriveFile(this.id, input, opts); }
  move(input: AgentsMoveDriveFileInput, opts?: AgentsCallOptions): Promise<CodeDriveFile> { return this.raw.moveDriveFile(this.id, input, opts); }
  delete(input: AgentsDeleteDriveFileInput, opts?: AgentsCallOptions): Promise<CodeDriveDeleted> { return this.raw.deleteDriveFile(this.id, input, opts); }
  history(query: AgentsListDriveFileVersionsQuery = {}, opts?: AgentsCallOptions): Promise<CodeDriveHistory> { return this.raw.listDriveFileVersions(this.id, query, opts); }
  verify(opts?: AgentsCallOptions): Promise<CodeDriveVerification> { return this.raw.verifyDrive(this.id, opts); }
  grep(input: AgentsGrepDriveInput, opts?: AgentsCallOptions): Promise<CodeDriveGrepResult> { return this.raw.grepDrive(this.id, input, opts); }
  changes(query: AgentsListDriveChangesQuery = {}, opts?: AgentsCallOptions): Promise<CodeDriveChangePage> { return this.raw.listDriveChanges(this.id, query, opts); }
  restoreFile(input: AgentsRestoreDriveFileInput, opts?: AgentsCallOptions): Promise<CodeDriveWriteResult> { return this.raw.restoreDriveFile(this.id, input, opts); }
  restore(input: AgentsRestoreDriveInput, opts?: AgentsCallOptions): Promise<CodeDriveRestored> { return this.raw.restoreDrive(this.id, input, opts); }
  fork(input: AgentsForkDriveInput, opts?: AgentsCallOptions): Promise<CodeDrive> { return this.raw.forkDrive(this.id, input, opts); }
  merge(input: AgentsMergeDriveInput = {}, opts?: AgentsCallOptions): Promise<CodeDriveMerged> { return this.raw.mergeDrive(this.id, input, opts); }
  diff(query: AgentsDiffDriveQuery = {}, opts?: AgentsCallOptions): Promise<CodeDriveDiff> { return this.raw.diffDrive(this.id, query, opts); }
  changesets(query: AgentsListDriveChangesetsQuery = {}, opts?: AgentsCallOptions) { return this.raw.listDriveChangesets(this.id, query, opts); }
  getChangeset(changesetId: string, opts?: AgentsCallOptions): Promise<CodeDriveChangesetView> { return this.raw.getDriveChangeset(this.id, changesetId, opts); }
  approveChangeset(changesetId: string, input: AgentsApproveDriveChangesetInput, opts?: AgentsCallOptions): Promise<CodeDriveChangesetDecided> {
    return this.raw.approveDriveChangeset(this.id, changesetId, input, opts);
  }
  rejectChangeset(changesetId: string, opts?: AgentsCallOptions): Promise<CodeDriveChangesetDecided> {
    return this.raw.rejectDriveChangeset(this.id, changesetId, opts);
  }
  undoSession(input: AgentsUndoDriveSessionInput, opts?: AgentsCallOptions): Promise<CodeDriveUndone> { return this.raw.undoDriveSession(this.id, input, opts); }
  share(input: AgentsShareDriveInput, opts?: AgentsCallOptions): Promise<CodeDriveShared> { return this.raw.shareDrive(this.id, input, opts); }
  async grants(opts?: AgentsCallOptions): Promise<CodeDriveGrant[]> {
    const res = await this.raw.listDriveGrants(this.id, opts);
    return res.grants ?? [];
  }
  grant(input: AgentsGrantDriveInput, opts?: AgentsCallOptions): Promise<CodeDriveGrant> { return this.raw.grantDrive(this.id, input, opts); }
  revokeGrant(grantId: string, opts?: AgentsCallOptions): Promise<CodeDriveGrant> { return this.raw.revokeDriveGrant(this.id, grantId, opts); }
}

/** First-class client for Caveman Drives (durable versioned long-term storage). */
export class DrivesClient {
  constructor(private readonly raw: Agents) {}

  create(input: AgentsCreateDriveInput, opts?: AgentsCallOptions): Promise<CodeDriveCreated> { return this.raw.createDrive(input, opts); }
  async list(opts?: AgentsCallOptions): Promise<CodeDrive[]> {
    const res = await this.raw.listDrives(opts);
    return res.drives ?? [];
  }
  get(driveId: string, opts?: AgentsCallOptions): Promise<CodeDrive> { return this.raw.getDrive(driveId, opts); }
  usage(opts?: AgentsCallOptions): Promise<CodeDriveUsage> { return this.raw.getDriveUsage(opts); }
  /** Return a fluent handle bound to one Drive by name or UUID. */
  drive(driveId: string): DriveHandle { return new DriveHandle(this.raw, driveId); }
}

/* ============================= CONNECTORS =============================== */

export interface ConnectorSummary {
  id?: string;
  name: string;
  state?: string;
  url?: string;
  tools?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export class ConnectorsClient {
  constructor(private readonly tx: PlatformTransport) {}

  async list(opts?: {signal?: AbortSignal}): Promise<ConnectorSummary[]> {
    const res = await this.tx.request<{connectors?: ConnectorSummary[]}>('GET', '/api/v1/code/connectors', undefined, opts);
    return res.connectors ?? [];
  }
  get(connector: string, opts?: {signal?: AbortSignal}): Promise<ConnectorSummary> {
    return this.tx.request('GET', `/api/v1/code/connectors/${encodeURIComponent(connector)}`, undefined, opts);
  }
  create(input: Record<string, unknown>, opts?: {signal?: AbortSignal}): Promise<ConnectorSummary> {
    return this.tx.request('POST', '/api/v1/code/connectors', input, opts);
  }
  accept(connector: string, input: Record<string, unknown> = {}, opts?: {signal?: AbortSignal}): Promise<Record<string, unknown>> {
    return this.tx.request('POST', `/api/v1/code/connectors/${encodeURIComponent(connector)}/accept`, input, opts);
  }
  pause(connector: string, input: {reason?: string} = {}, opts?: {signal?: AbortSignal}): Promise<Record<string, unknown>> {
    return this.tx.request('POST', `/api/v1/code/connectors/${encodeURIComponent(connector)}/pause`, input, opts);
  }
  resume(connector: string, opts?: {signal?: AbortSignal}): Promise<Record<string, unknown>> {
    return this.tx.request('POST', `/api/v1/code/connectors/${encodeURIComponent(connector)}/resume`, {}, opts);
  }
  remove(connector: string, opts?: {signal?: AbortSignal}): Promise<Record<string, unknown>> {
    return this.tx.request('POST', `/api/v1/code/connectors/${encodeURIComponent(connector)}/remove`, {}, opts);
  }
  listGrants(connector: string, opts?: {signal?: AbortSignal}): Promise<Record<string, unknown>> {
    return this.tx.request('GET', `/api/v1/code/connectors/${encodeURIComponent(connector)}/grants`, undefined, opts);
  }
  grant(connector: string, input: Record<string, unknown>, opts?: {signal?: AbortSignal}): Promise<Record<string, unknown>> {
    return this.tx.request('POST', `/api/v1/code/connectors/${encodeURIComponent(connector)}/grants`, input, opts);
  }
  revokeGrant(connector: string, input: Record<string, unknown>, opts?: {signal?: AbortSignal}): Promise<Record<string, unknown>> {
    return this.tx.request('POST', `/api/v1/code/connectors/${encodeURIComponent(connector)}/grants/revoke`, input, opts);
  }
}

/* =============================== SECRETS ================================ */

export interface SecretMetadata {
  id?: string;
  name: string;
  scope?: string;
  environment?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/**
 * First-class write-only Secrets client.
 * Secret values are encrypted server-side and injected per command at the
 * execution boundary; list operations return metadata only, never values.
 */
export class SecretsClient {
  constructor(private readonly tx: PlatformTransport) {}

  async list(opts?: {signal?: AbortSignal}): Promise<SecretMetadata[]> {
    const res = await this.tx.request<{secrets?: SecretMetadata[]}>('GET', '/api/v1/code/secrets', undefined, opts);
    return res.secrets ?? [];
  }
  set(input: {name: string; value: string; scope?: string; agent_id?: string; environment?: string; preview?: boolean}, opts?: {signal?: AbortSignal}): Promise<SecretMetadata> {
    return this.tx.request('PUT', '/api/v1/code/secrets', input, opts);
  }
  delete(name: string, opts?: {signal?: AbortSignal}): Promise<{ok?: boolean}> {
    return this.tx.request('DELETE', `/api/v1/code/secrets/${encodeURIComponent(name)}`, undefined, opts);
  }
  async listOrg(opts?: {signal?: AbortSignal}): Promise<SecretMetadata[]> {
    const res = await this.tx.request<{secrets?: SecretMetadata[]}>('GET', '/api/v1/code/org-secrets', undefined, opts);
    return res.secrets ?? [];
  }
  createOrg(input: Record<string, unknown>, opts?: {signal?: AbortSignal}): Promise<SecretMetadata> {
    return this.tx.request('POST', '/api/v1/code/org-secrets', input, opts);
  }
  updateOrg(secretId: string, input: Record<string, unknown>, opts?: {signal?: AbortSignal}): Promise<SecretMetadata> {
    return this.tx.request('PATCH', `/api/v1/code/org-secrets/${encodeURIComponent(secretId)}`, input, opts);
  }
  deleteOrg(secretId: string, opts?: {signal?: AbortSignal}): Promise<{ok?: boolean}> {
    return this.tx.request('DELETE', `/api/v1/code/org-secrets/${encodeURIComponent(secretId)}`, undefined, opts);
  }
}

/* =============================== CREDITS ================================ */

export class CreditsClient {
  constructor(private readonly tx: PlatformTransport) {}

  /** Read the organization's unified Credits balance and auto-reload settings. */
  get(opts?: {signal?: AbortSignal}): Promise<Record<string, unknown>> {
    return this.tx.request('GET', '/api/v1/credits', undefined, opts);
  }
  models(opts?: {signal?: AbortSignal}): Promise<Record<string, unknown>> {
    return this.tx.request('GET', '/api/v1/code/credits/models', undefined, opts);
  }
}

/* ================================ EVALS ================================= */

export class EvalsClient {
  readonly Eval = Eval;
  readonly uploadResult = uploadEvalResult;

  constructor(private readonly opts: {controlURL: string; apiKey: string; projectId?: string; timeoutMs: number}) {}

  workbench(workbenchId: string, projectId = this.opts.projectId): EvalWorkbenchClient {
    if (!projectId) {
      throw new PlatformError('cave_project_required', 'projectId is required for eval workbenches.', 0);
    }
    return new EvalWorkbenchClient({
      controlURL: this.opts.controlURL,
      accessToken: this.opts.apiKey,
      projectId,
      timeoutMs: this.opts.timeoutMs,
    }, workbenchId);
  }

  project(projectId = this.opts.projectId): EvalProjectClient {
    if (!projectId) {
      throw new PlatformError('cave_project_required', 'projectId is required for eval project operations.', 0);
    }
    return new EvalProjectClient({
      controlURL: this.opts.controlURL,
      accessToken: this.opts.apiKey,
      projectId,
      timeoutMs: this.opts.timeoutMs,
    });
  }
}

/* =============================== CAVEMAN ================================ */

/**
 * Unified Caveman Cloud client.
 *
 * ```ts
 * import { Caveman } from "@caveman-ai/sdk";
 *
 * const cv = new Caveman(); // reads CAVEMAN_API_KEY
 * const models = await cv.inference.models();
 * const sb = await cv.sandboxes.create({ name: "scratch" });
 * const hits = await cv.drives.drive("knowledge").grep({ pattern: "refund" });
 * ```
 */
export class Caveman {
  readonly inference: InferenceClient;
  readonly agents: ManagedAgentsClient;
  readonly sessions: SessionsClient;
  readonly sandboxes: Sandboxes;
  readonly pools: ComputerPools;
  readonly drives: DrivesClient;
  readonly connectors: ConnectorsClient;
  readonly secrets: SecretsClient;
  readonly rooms: Rooms;
  readonly apps: Apps;
  readonly evals: EvalsClient;
  readonly approvals: Gate;
  readonly credits: CreditsClient;
  readonly cloud: Cloud;

  constructor(options: CavemanOptions = {}) {
    const apiKey = options.apiKey?.trim() || readEnv('CAVEMAN_API_KEY') || readEnv('CAVE_TOKEN');
    if (!apiKey) {
      throw new PlatformError('cave_auth_required', 'apiKey is required (pass { apiKey } or set CAVEMAN_API_KEY).', 0);
    }
    const baseURL = (options.baseURL ?? readEnv('CAVEMAN_GATEWAY_URL') ?? DEFAULT_GATEWAY_URL).replace(/\/+$/, '');
    const controlURL = (options.controlURL ?? readEnv('CAVEMAN_API_URL') ?? DEFAULT_CONTROL_URL).replace(/\/+$/, '');
    const timeoutMs = options.timeoutMs ?? 30_000;
    const retries = options.retries ?? 2;
    const retryDelayMs = options.retryDelayMs ?? 250;

    const platformOpts = {
      controlURL,
      apiKey,
      timeoutMs,
      retries,
      retryDelayMs,
      ...(options.fetch !== undefined ? {fetch: options.fetch} : {}),
    };
    const tx = new PlatformTransport(platformOpts);
    const rawAgents = new Agents({
      controlURL,
      apiKey,
      timeoutMs,
      ...(options.fetch !== undefined ? {fetch: options.fetch} : {}),
    });

    this.inference = new InferenceClient({
      baseURL,
      controlURL,
      apiKey,
      agent: options.agent ?? 'default',
      timeoutMs,
      ...(options.fetch !== undefined ? {fetch: options.fetch} : {}),
    });
    this.agents = new ManagedAgentsClient(rawAgents);
    this.sessions = new SessionsClient(rawAgents);
    this.sandboxes = new Sandboxes({
      controlURL,
      apiKey,
      timeoutMs,
      retries,
      retryDelayMs,
      ...(options.relayURL !== undefined ? {relayURL: options.relayURL} : {}),
      ...(options.fetch !== undefined ? {fetch: options.fetch} : {}),
    });
    this.pools = new ComputerPools(platformOpts);
    this.drives = new DrivesClient(rawAgents);
    this.connectors = new ConnectorsClient(tx);
    this.secrets = new SecretsClient(tx);
    this.rooms = new Rooms(platformOpts);
    this.apps = new Apps(platformOpts);
    this.evals = new EvalsClient({
      controlURL,
      apiKey,
      timeoutMs,
      ...(options.projectId !== undefined ? {projectId: options.projectId} : {}),
    });
    this.approvals = new Gate({
      ...platformOpts,
      ...(options.projectId !== undefined ? {projectId: options.projectId} : {}),
    });
    this.credits = new CreditsClient(tx);
    this.cloud = new Cloud({
      controlURL,
      accessToken: apiKey,
      timeoutMs,
      ...(options.projectId !== undefined ? {projectId: options.projectId} : {}),
      ...(options.fetch !== undefined ? {fetch: options.fetch} : {}),
    });
  }
}
