import { createHash } from 'node:crypto';

export type SemanticProvider = 'brain' | 'hindsight';
export type HindsightRecallBudget = 'low' | 'mid' | 'high';
export interface HindsightConfig {
  url: string;
  bankId: string;
  timeoutMs: number;
  recallMaxTokens: number;
  recallBudget: HindsightRecallBudget;
  apiKey?: string;
}

export interface HindsightRetainDocument {
  documentId: string;
  operationId: string;
  content: string;
  metadata?: Record<string, string>;
  tags: string[];
  timestamp?: string;
  updateMode?: 'append' | 'replace';
}

export type HindsightOperationStatus =
  'pending' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'not_found';
export interface HindsightOperation {
  operationId: string;
  status: HindsightOperationStatus;
}
export interface HindsightRecallHit {
  id: string;
  documentId: string;
  text: string;
  metadata?: Record<string, string>;
  tags: string[];
  score?: number;
}
export type HindsightFetch = (url: string, init: RequestInit) => Promise<Response>;

export class HindsightError extends Error {
  constructor(
    public readonly code: 'config' | 'input' | 'timeout' | 'transport' | 'http' | 'protocol',
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'HindsightError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE_PREFIX = 'socialmedia:scope:';
const CHAT_PREFIX = 'socialmedia:chat:';
const statuses: HindsightOperationStatus[] = [
  'pending',
  'processing',
  'completed',
  'failed',
  'cancelled',
  'not_found',
];
type Env = Record<string, string | undefined>;
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function fail(code: HindsightError['code'], message: string): never {
  throw new HindsightError(code, message);
}

export function semanticProviderFromEnv(env: Env = process.env): SemanticProvider {
  const provider = env.SEMANTIC_PROVIDER?.trim() || 'brain';
  if (provider !== 'brain' && provider !== 'hindsight') {
    fail('config', 'SEMANTIC_PROVIDER must be brain or hindsight');
  }
  return provider;
}

function integer(value: string | undefined, fallback: number, key: string, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
    fail('config', `${key} must be a positive integer no greater than ${max}`);
  }
  return Number(value);
}

function validateConfig(config: HindsightConfig): HindsightConfig {
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    return fail('config', 'HINDSIGHT_URL must be an HTTP(S) URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    fail('config', 'HINDSIGHT_URL must be HTTP(S) without credentials, query or fragment');
  }
  // Dedicated SocialMedia banks cannot accidentally overwrite personal agent memory.
  if (!/^socialmedia(?:[-_][a-z0-9_-]+)?$/.test(config.bankId)) {
    fail('config', 'HINDSIGHT_BANK_ID must be a dedicated socialmedia bank');
  }
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 300000) {
    fail('config', 'HINDSIGHT_TIMEOUT_MS must be between 1 and 300000');
  }
  if (
    !Number.isInteger(config.recallMaxTokens) ||
    config.recallMaxTokens < 1 ||
    config.recallMaxTokens > 32768
  ) {
    fail('config', 'HINDSIGHT_RECALL_MAX_TOKENS must be between 1 and 32768');
  }
  if (!['low', 'mid', 'high'].includes(config.recallBudget)) {
    fail('config', 'HINDSIGHT_RECALL_BUDGET must be low, mid or high');
  }
  if (config.apiKey && /[\r\n]/.test(config.apiKey)) {
    fail('config', 'HINDSIGHT_API_KEY contains invalid characters');
  }
  return { ...config, url: url.toString().replace(/\/+$/, '') };
}

export function hindsightConfigFromEnv(env: Env = process.env): HindsightConfig {
  return validateConfig({
    url: env.HINDSIGHT_URL?.trim() || 'http://hindsight:8888',
    bankId: env.HINDSIGHT_BANK_ID?.trim() || 'socialmedia-staticduo',
    timeoutMs: integer(env.HINDSIGHT_TIMEOUT_MS, 30000, 'HINDSIGHT_TIMEOUT_MS', 300000),
    recallMaxTokens: integer(
      env.HINDSIGHT_RECALL_MAX_TOKENS,
      4096,
      'HINDSIGHT_RECALL_MAX_TOKENS',
      32768
    ),
    recallBudget: (env.HINDSIGHT_RECALL_BUDGET?.trim() || 'mid') as HindsightRecallBudget,
    apiKey: env.HINDSIGHT_API_KEY?.trim() || undefined,
  });
}

function nonempty(value: string): void {
  if (typeof value !== 'string' || !value.trim())
    fail('input', 'SocialMedia scope values must be nonempty strings');
}

export function socialmediaScopeTag(
  platform: string,
  namespace: string,
  providerAccount: string
): string {
  [platform, namespace, providerAccount].forEach(nonempty);
  return (
    SCOPE_PREFIX +
    Buffer.from(JSON.stringify([platform, namespace, providerAccount])).toString('base64url')
  );
}

export function socialmediaChatTag(conversationId: string): string {
  nonempty(conversationId);
  return CHAT_PREFIX + Buffer.from(conversationId).toString('base64url');
}

export function socialmediaDocumentId(messageId: string): string {
  if (!UUID.test(messageId)) fail('input', 'SocialMedia message ID must be a UUID');
  return `socialmedia-${messageId.toLowerCase()}`;
}

export interface SocialmediaConversationScope {
  platform: string;
  namespace: string;
  provider_account: string;
  conversation_id: string;
  topic_id?: string;
}

export function socialmediaConversationDocumentId(scope: SocialmediaConversationScope): string;
export function socialmediaConversationDocumentId(
  platform: string,
  namespace: string,
  providerAccount: string,
  conversationId: string,
  topicId?: string
): string;
export function socialmediaConversationDocumentId(
  platformOrScope: string | SocialmediaConversationScope,
  namespace?: string,
  providerAccount?: string,
  conversationId?: string,
  topicId?: string
): string {
  const scope =
    typeof platformOrScope === 'string'
      ? [platformOrScope, namespace, providerAccount, conversationId, topicId || '']
      : [
          platformOrScope.platform,
          platformOrScope.namespace,
          platformOrScope.provider_account,
          platformOrScope.conversation_id,
          platformOrScope.topic_id || '',
        ];
  scope.slice(0, 4).forEach(value => nonempty(value as string));
  if (typeof scope[4] !== 'string') fail('input', 'SocialMedia topic ID must be a string');
  return `socialmedia-conversation-${createHash('sha256').update(JSON.stringify(scope)).digest('hex')}`;
}

export function isSocialmediaConversationDocumentId(id: string): boolean {
  return /^socialmedia-conversation-[0-9a-f]{64}$/.test(id);
}

export function hindsightDestinationKey(config: Pick<HindsightConfig, 'url' | 'bankId'>): string {
  return createHash('sha256')
    .update(JSON.stringify([config.url.replace(/\/+$/, ''), config.bankId]))
    .digest('hex');
}

export function messageIdFromHindsightDocumentId(documentId: string): string | undefined {
  const id = documentId.startsWith('socialmedia-') ? documentId.slice('socialmedia-'.length) : '';
  return UUID.test(id) ? id.toLowerCase() : undefined;
}

function validateTags(tags: string[], requireChat: boolean): void {
  if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string' || !tag.trim())) {
    fail('input', 'Hindsight tags must be nonempty strings');
  }
  const scopes = tags.filter(tag => tag.startsWith(SCOPE_PREFIX));
  const chats = tags.filter(tag => tag.startsWith(CHAT_PREFIX));
  if (scopes.length !== 1 || chats.length > 1 || (requireChat && chats.length !== 1)) {
    fail('input', 'Hindsight requires one compound account scope and at most one chat scope');
  }
  try {
    const encoded = scopes[0].slice(SCOPE_PREFIX.length);
    const triple: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (
      !Array.isArray(triple) ||
      triple.length !== 3 ||
      triple.some(v => typeof v !== 'string' || !v.trim()) ||
      socialmediaScopeTag(triple[0], triple[1], triple[2]) !== scopes[0]
    )
      throw new Error();
    if (chats.length) {
      const decoded = Buffer.from(chats[0].slice(CHAT_PREFIX.length), 'base64url').toString('utf8');
      if (socialmediaChatTag(decoded) !== chats[0]) throw new Error();
    }
  } catch {
    fail('input', 'Hindsight scope tags must use canonical SocialMedia encoding');
  }
}

function operationUuid(id: string): void {
  if (!UUID.test(id)) fail('input', 'Hindsight operation ID must be a stable UUID');
}

function documentId(id: string): void {
  if (!messageIdFromHindsightDocumentId(id) && !isSocialmediaConversationDocumentId(id)) {
    fail('input', 'Hindsight document ID must identify a SocialMedia message or conversation');
  }
}

// CONTRACT: http.hindsight.socialmedia-bank.v1
export class HindsightClient {
  private readonly config: HindsightConfig;
  private readonly baseUrl: string;

  constructor(
    config: HindsightConfig,
    private readonly fetchImpl: HindsightFetch = fetch
  ) {
    this.config = validateConfig(config);
    this.baseUrl = `${this.config.url}/v1/default/banks/${encodeURIComponent(this.config.bankId)}`;
  }

  get destination(): string {
    return hindsightDestinationKey(this.config);
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    absentOk = false
  ): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new HindsightError('timeout', 'Hindsight request timed out'));
      }, this.config.timeoutMs);
    });
    const perform = async (): Promise<unknown> => {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
      const response = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        signal: controller.signal,
        redirect: 'error',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.status === 404 && absentOk) return undefined;
      if (!response.ok)
        throw new HindsightError(
          'http',
          `Hindsight returned HTTP ${response.status}`,
          response.status
        );
      let result: unknown;
      try {
        result = await response.json();
      } catch {
        return fail('protocol', 'Hindsight returned invalid JSON');
      }
      if (!object(result)) fail('protocol', 'Hindsight returned an invalid response object');
      return result;
    };
    try {
      return await Promise.race([perform(), timeout]);
    } catch (error) {
      if (error instanceof HindsightError) throw error;
      // Provider bodies and transport messages may contain credentials or private content.
      throw new HindsightError(
        controller.signal.aborted ? 'timeout' : 'transport',
        controller.signal.aborted ? 'Hindsight request timed out' : 'Hindsight transport failed'
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async initializeBank(): Promise<void> {
    const bank = await this.request('PUT', '', {
      name: this.config.bankId,
      retain_extraction_mode: 'chunks',
    });
    if (!object(bank) || bank.bank_id !== this.config.bankId)
      fail('protocol', 'Hindsight returned an unexpected bank');
    const config = await this.request('PATCH', '/config', {
      updates: { retain_extraction_mode: 'chunks', store_document_text: true },
    });
    if (
      !object(config) ||
      config.bank_id !== this.config.bankId ||
      !object(config.config) ||
      config.config.retain_extraction_mode !== 'chunks'
    ) {
      fail('protocol', 'Hindsight did not confirm chunks extraction mode');
    }
    if (config.config.store_document_text !== true) {
      fail('protocol', 'Hindsight did not confirm document text storage required for append');
    }
  }

  async retainDocument(input: HindsightRetainDocument): Promise<{ operationId: string }> {
    documentId(input.documentId);
    operationUuid(input.operationId);
    validateTags(input.tags, true);
    nonempty(input.content);
    if (input.updateMode !== undefined && !['append', 'replace'].includes(input.updateMode)) {
      fail('input', 'Hindsight update mode must be append or replace');
    }
    if (
      input.metadata &&
      (!object(input.metadata) || Object.values(input.metadata).some(v => typeof v !== 'string'))
    ) {
      fail('input', 'Hindsight metadata values must be strings');
    }
    if (input.timestamp !== undefined && !Number.isFinite(Date.parse(input.timestamp))) {
      fail('input', 'Hindsight timestamp must be a date-time string');
    }
    const result = await this.request('POST', '/memories', {
      async: true,
      operation_id: input.operationId,
      items: [
        {
          content: input.content,
          document_id: input.documentId,
          update_mode: input.updateMode || 'replace',
          metadata: input.metadata,
          tags: input.tags,
          timestamp: input.timestamp,
        },
      ],
    });
    if (
      !object(result) ||
      result.success !== true ||
      result.bank_id !== this.config.bankId ||
      result.async !== true ||
      result.operation_id !== input.operationId ||
      result.items_count !== 1
    ) {
      fail('protocol', 'Hindsight did not acknowledge the expected retain operation');
    }
    return { operationId: input.operationId };
  }

  async getOperation(operationId: string): Promise<HindsightOperation> {
    operationUuid(operationId);
    const result = await this.request(
      'GET',
      `/operations/${encodeURIComponent(operationId)}`,
      undefined,
      true
    );
    if (result === undefined) return { operationId, status: 'not_found' };
    if (
      !object(result) ||
      result.operation_id !== operationId ||
      !statuses.includes(result.status as HindsightOperationStatus)
    ) {
      fail('protocol', 'Hindsight returned an invalid operation status');
    }
    return { operationId, status: result.status as HindsightOperationStatus };
  }

  async retryOperation(operationId: string): Promise<{ operationId: string }> {
    operationUuid(operationId);
    const result = await this.request(
      'POST',
      `/operations/${encodeURIComponent(operationId)}/retry`
    );
    if (!object(result) || result.success !== true || result.operation_id !== operationId) {
      fail('protocol', 'Hindsight did not acknowledge the expected operation retry');
    }
    return { operationId };
  }

  async deleteDocument(id: string): Promise<void> {
    documentId(id);
    const result = await this.request(
      'DELETE',
      `/documents/${encodeURIComponent(id)}`,
      undefined,
      true
    );
    if (result === undefined) return;
    if (!object(result) || result.success !== true || result.document_id !== id) {
      fail('protocol', 'Hindsight did not acknowledge the expected document deletion');
    }
  }

  async recall(input: { query: string; tags: string[] }): Promise<HindsightRecallHit[]> {
    nonempty(input.query);
    validateTags(input.tags, false);
    const result = await this.request('POST', '/memories/recall', {
      query: input.query,
      tags: input.tags,
      tags_match: 'all_strict',
      max_tokens: this.config.recallMaxTokens,
      budget: this.config.recallBudget,
    });
    if (!object(result) || !Array.isArray(result.results))
      fail('protocol', 'Hindsight returned invalid recall results');
    const hits: HindsightRecallHit[] = [];
    for (const raw of result.results) {
      if (!object(raw) || typeof raw.id !== 'string' || typeof raw.text !== 'string') {
        fail('protocol', 'Hindsight returned an invalid recall hit');
      }
      // Observations may lack document IDs. Never hydrate them or unscoped results.
      if (
        typeof raw.document_id !== 'string' ||
        (!messageIdFromHindsightDocumentId(raw.document_id) &&
          !isSocialmediaConversationDocumentId(raw.document_id)) ||
        !Array.isArray(raw.tags) ||
        raw.tags.some(tag => typeof tag !== 'string') ||
        !input.tags.every(tag => (raw.tags as string[]).includes(tag))
      )
        continue;
      const metadata =
        object(raw.metadata) && Object.values(raw.metadata).every(v => typeof v === 'string')
          ? (raw.metadata as Record<string, string>)
          : undefined;
      const score =
        object(raw.scores) &&
        typeof raw.scores.final === 'number' &&
        Number.isFinite(raw.scores.final)
          ? raw.scores.final
          : undefined;
      hits.push({
        id: raw.id,
        documentId: raw.document_id,
        text: raw.text,
        tags: raw.tags as string[],
        metadata,
        score,
      });
    }
    return hits;
  }
}
