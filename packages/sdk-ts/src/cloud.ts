import {CloudResources, cloudOperationMetadata, type CloudOperation, type CloudOperations, type CloudCallOptions, type CloudResult} from './cloud.generated.js';
export * from './cloud.generated.js';

export interface CloudOptions {
  controlURL: string;
  accessToken: string;
  projectId?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  /** How long `prompts.get(slug)` answers from memory before asking again; default 60000. */
  promptCacheTtlMs?: number;
}
export class CloudError extends Error {
  constructor(readonly code: string, message: string, readonly status = 0) { super(message); this.name = 'CloudError'; }
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const maxBytes = 16 * 1024 * 1024;
// A server that no longer speaks this build's operation contract answers a bare 409: say what to do about it.
const versionConflict = 'This @caveman-ai/sdk and the Caveman server speak different API versions. Upgrade the SDK (npm install @caveman-ai/sdk@latest), or install the version that matches a self-hosted server, then run again.';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A prompt version as `GET /prompts/resolve` returns it. `environment` is null when resolved by version. */
export interface PromptContent {
  prompt_id: string; slug: string; name: string; version: number; version_id: string; environment: string | null;
  system_text: string; user_text: string; variables: unknown; model_parameters: Record<string, unknown>; tools: unknown[]; resolved_at: string;
}
export interface ResolvedPrompt extends PromptContent {
  /** "server": just fetched. "cache": within the TTL. "stale": the refresh failed, last good value. "fallback": the caller's own. */
  source: 'server' | 'cache' | 'stale' | 'fallback';
  /** Substitute `{{name}}` in both texts; throws `cave_prompt_variable_unmapped` on a variable with no value. */
  render(variables?: Record<string, string>): {system_text: string; user_text: string};
  /** Headers for the model call so the gateway records which prompt version produced it. Empty for a fallback with no id. */
  headers(): Record<string, string>;
}
export interface PromptGetOptions { environment?: string; version?: number; fallback?: Partial<PromptContent> & {user_text: string} }
type PromptsGet = CloudResources['prompts']['get'] & ((slug: string, options?: PromptGetOptions) => Promise<ResolvedPrompt>);

function resolvedPrompt(content: Partial<PromptContent>, source: ResolvedPrompt['source']): ResolvedPrompt {
  const prompt: PromptContent = {prompt_id: '', slug: '', name: '', version: 0, version_id: '', environment: null, system_text: '', user_text: '', variables: [], model_parameters: {}, tools: [], resolved_at: '', ...content};
  const fill = (text: string, variables: Record<string, string>) => text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, name: string) => {
    if (typeof variables[name] !== 'string') throw new CloudError('cave_prompt_variable_unmapped', `Prompt variable "${name}" has no value.`);
    return variables[name];
  });
  return {
    ...prompt, source,
    render: (variables = {}) => ({system_text: fill(prompt.system_text, variables), user_text: fill(prompt.user_text, variables)}),
    headers: () => prompt.prompt_id ? {'x-cave-tags': [`cave.prompt.id=${prompt.prompt_id}`, `cave.prompt.version=${prompt.version}`, ...(prompt.environment ? [`cave.prompt.environment=${prompt.environment}`] : [])].join(',')} : {},
  };
}

/** Typed Cloud control-plane resources. The token's live permissions remain authoritative. */
export class Cloud extends CloudResources {
  /** `get({prompt_id})` is the generated read by id; `get(slug, {environment | version})` resolves the promoted version, cached. */
  declare readonly prompts: Omit<CloudResources['prompts'], 'get'> & {get: PromptsGet};
  private readonly promptCache = new Map<string, {content: PromptContent; expires: number}>();
  private readonly endpoint: string;
  private readonly transport: typeof globalThis.fetch;
  private readonly timeout: number;
  constructor(private readonly options: CloudOptions) {
    super();
    const url = new URL(options.controlURL);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw new CloudError('cave_endpoint_invalid', 'Use HTTPS or loopback HTTP without credentials, query, or fragment.');
    if (!options.accessToken.trim()) throw new CloudError('cave_auth_required', 'A Cloud access token is required.');
    if (options.projectId !== undefined && !uuid.test(options.projectId)) throw new CloudError('cave_project_required', 'projectId must be a UUID.');
    this.timeout = options.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 100 || this.timeout > 120000) throw new CloudError('cave_timeout_invalid', 'timeoutMs must be 100–120000.');
    this.endpoint = url.toString().replace(/\/$/, '');
    this.transport = options.fetch ?? globalThis.fetch;
    const byId = this.prompts.get;
    (this.prompts as {get: unknown}).get = (input: string | CloudOperations['prompts.get']['input'], callOptions?: PromptGetOptions & CloudCallOptions) =>
      typeof input === 'string' ? this.resolvePrompt(input, callOptions) : byId(input, callOptions);
  }

  private async resolvePrompt(slug: string, options: PromptGetOptions = {}): Promise<ResolvedPrompt> {
    if (!this.options.projectId) throw new CloudError('cave_project_required', 'Select a project before calling this resource.');
    if (options.environment !== undefined && options.version !== undefined) throw new CloudError('cave_input_invalid', 'Pass environment or version, not both.');
    const selector: [string, string] = options.version !== undefined ? ['version', String(options.version)] : ['environment', options.environment ?? 'production'];
    const key = `${this.options.projectId}|${slug.toLowerCase()}|${selector.join('=')}`;
    const cached = this.promptCache.get(key);
    if (cached && cached.expires > Date.now()) return resolvedPrompt(cached.content, 'cache');
    try {
      const response = await this.transport(`${this.endpoint}/api/v1/projects/${this.options.projectId}/prompts/resolve?${new URLSearchParams([['slug', slug], selector])}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(this.timeout), headers: {authorization: `Bearer ${this.options.accessToken}`},
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !object(body) || typeof body['prompt_id'] !== 'string') {
        const error = object(body) && object(body['error']) ? body['error'] : {};
        throw new CloudError(typeof error['code'] === 'string' ? error['code'] : 'cave_request_failed', typeof error['message'] === 'string' ? error['message'] : `Prompt request failed (${response.status}).`, response.status);
      }
      const content = body as unknown as PromptContent;
      this.promptCache.set(key, {content, expires: Date.now() + (this.options.promptCacheTtlMs ?? 60000)});
      return resolvedPrompt(content, 'server');
    } catch (error) {
      if (cached) return resolvedPrompt(cached.content, 'stale');
      if (options.fallback) return resolvedPrompt(options.fallback, 'fallback');
      throw error;
    }
  }

  async execute<K extends CloudOperation>(operation: K, input: CloudOperations[K]['input'], options: CloudCallOptions = {}): Promise<CloudResult<CloudOperations[K]['output']>> {
    const op = cloudOperationMetadata[operation];
    if (!op) throw new CloudError('cave_unknown_operation', 'Unknown Cloud operation.');
    if (op.scope === 'project' && !this.options.projectId) throw new CloudError('cave_project_required', 'Select a project before calling this resource.');
    if (op.transactional && !options.idempotencyKey?.trim()) throw new CloudError('cave_idempotency_key_required', 'This write requires an idempotency key; reuse it only for identical retries.');
    const body = JSON.stringify(input);
    if (!object(input) || new TextEncoder().encode(body).byteLength > maxBytes) throw new CloudError('cave_input_invalid', 'Input must be an object of at most 16 MiB.');
    const response = await this.transport(`${this.endpoint}/api/v1${op.scope === 'project' ? `/projects/${this.options.projectId}` : ''}/cloud/operations/${encodeURIComponent(operation)}`, {
      method: 'POST', redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(this.timeout)]) : AbortSignal.timeout(this.timeout),
      headers: {authorization: `Bearer ${this.options.accessToken}`, 'content-type': 'application/json', 'x-cave-operation-contract': op.contract, ...(options.idempotencyKey ? {'idempotency-key': options.idempotencyKey} : {})}, body,
    });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder(); let text = ''; let bytes = 0;
    if (reader) try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > maxBytes) { await reader.cancel(); throw new CloudError('cave_result_too_large', 'Result exceeds 16 MiB; narrow the query.'); } text += decoder.decode(part.value, {stream: true}); } text += decoder.decode(); } finally { reader.releaseLock(); }
    let result: unknown;
    try { result = JSON.parse(text); } catch { throw new CloudError('cave_invalid_response', 'Cloud returned invalid JSON.', response.status); }
    if (!object(result)) throw new CloudError('cave_invalid_response', 'Cloud returned an invalid envelope.', response.status);
    if (!response.ok) {
      const outer = object(result['error']) ? result['error'] : result;
      const error = object(outer['error']) ? outer['error'] : outer;
      if (error['code'] === 'cave_operation_version_conflict') throw new CloudError('cave_operation_version_conflict', versionConflict, response.status);
      throw new CloudError(typeof error['code'] === 'string' ? error['code'] : 'cave_request_failed', typeof error['message'] === 'string' ? error['message'] : `Cloud request failed (${response.status}).`, response.status);
    }
    if (result['schema_version'] !== 1 || result['operation'] !== operation || result['version'] !== op.version || result['contract_sha256'] !== op.contract || result['ok'] !== true || !['completed','accepted'].includes(String(result['status'])) || !Object.hasOwn(result, 'data')) throw new CloudError('cave_operation_version_conflict', versionConflict, response.status);
    return result as CloudResult<CloudOperations[K]['output']>;
  }
}
