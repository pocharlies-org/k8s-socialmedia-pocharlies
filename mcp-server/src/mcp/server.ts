import { connectorSecretFor } from '../domain/account-registry';
import { httpBase } from './public-page';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { SearchService } from '../application/search.service';
import {
  isMediaType,
  MEDIA_TYPES,
  mediaTypePredicate,
  messageTypesFor,
  type MediaType,
} from '../application/media-type-filter';
import { SummarizationService } from '../application/summarization.service';
import {
  UnreadDigestService,
  type MessagingPlatform,
  type DigestLanguage,
  type UnreadDigestChat,
} from '../application/unread-digest.service';
import { DraftService } from '../application/draft.service';
import { DatabaseRepository } from '../infrastructure/database/repository';
import {
  actorRequestHeaders,
  generateHMACSignature,
  getRequestActor,
} from '@mcp-socialmedia/shared';
import { accountKey, normalizeAccount, stripAccount, type Account } from '../domain/account';
import { identityBindingEnabled, resolveBoundAccount } from '../domain/identity-bindings';
import {
  findAccount,
  getAccounts,
  requireAccount,
  socialAccountId,
  type AccountChannel,
  type SocialAccount,
} from '../domain/account-registry';
import { ConversationResolver } from '../infrastructure/database/social-accounts';
import { createHash, createHmac } from 'crypto';
import { t } from '../infrastructure/i18n/i18n';
import pino from 'pino';
import {
  SOCIAL_TOOL_REGISTRY,
  publicToolDefinition,
  type SocialChannel,
  type SocialToolDefinition,
} from './tool-registry';
import { SOCIALMEDIA_CONTRACT_DIGEST } from './contract.generated';
import { verifyCurrentChatCapability } from './current-chat-capability';
import { createCurrentChatProposal, requireCurrentChatTurn } from './current-chat-proposals';

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, any> {
  return isObject(value) ? value : {};
}

function extractArrayPayload(value: unknown, keys: string[]): any[] {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return [];
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function pickString(value: unknown, keys: string[]): string {
  if (!isObject(value)) return '';
  for (const key of keys) {
    const raw = value[key];
    if (raw !== undefined && raw !== null && String(raw).trim()) {
      return String(raw).trim();
    }
  }
  return '';
}

function pickNumber(value: unknown, keys: string[], fallback: number): number {
  if (!isObject(value)) return fallback;
  for (const key of keys) {
    const raw = Number(value[key]);
    if (Number.isFinite(raw)) return raw;
  }
  return fallback;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new McpError(ErrorCode.InvalidParams, `${field} must be a positive integer`);
  }
  return parsed;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  const parsed = optionalPositiveInteger(value, field);
  if (parsed === undefined) {
    throw new McpError(ErrorCode.InvalidParams, `${field} is required`);
  }
  return parsed;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeDigestPlatforms(value: unknown): MessagingPlatform[] {
  const raw = Array.isArray(value) ? value : ['whatsapp', 'telegram'];
  const platforms = raw.filter(
    (item): item is MessagingPlatform => item === 'whatsapp' || item === 'telegram'
  );
  return platforms.length ? [...new Set(platforms)] : ['whatsapp', 'telegram'];
}

function compileInputValidators(): Map<string, ValidateFunction> {
  const schemaValidator = new Ajv({ allErrors: true, strict: false });
  addFormats(schemaValidator);
  return new Map(
    SOCIAL_TOOL_REGISTRY.map(definition => [
      definition.name,
      schemaValidator.compile(definition.inputSchema),
    ])
  );
}

function phoneFromDirectWhatsAppId(chatId: unknown): string | null {
  const jid = normalizeDirectWhatsAppJid(chatId);
  return jid ? jid.split('@')[0] || null : null;
}

function manualWhatsAppOpenUrl(chatId: unknown, text: unknown): string | undefined {
  const phone = phoneFromDirectWhatsAppId(chatId);
  if (!phone) return undefined;
  const suffix =
    typeof text === 'string' && text.length > 0 ? `?text=${encodeURIComponent(text)}` : '';
  return `${httpBase(process.env.WHATSAPP_LINK_BASE_URL || 'https://wa.me', 'WHATSAPP_LINK_BASE_URL')}/${phone}${suffix}`;
}

function phoneE164FromSendJid(sendJid: string): string {
  return `+${sendJid.split('@')[0].replace(/\D/g, '')}`;
}

function phoneWaJidFromSendJid(sendJid: string): string {
  return `${sendJid.split('@')[0].replace(/\D/g, '')}@c.us`;
}

/**
 * True for WhatsApp LID jids (`<n>@lid` / `<n>@hosted.lid`). LID ids are an
 * opaque Baileys identity, NOT a phone number: they must be looked up and sent
 * to verbatim (digit-stripping + forcing `@s.whatsapp.net` would point at a
 * non-existent conversation and the wrong recipient).
 */
export function isLidJid(chatId: unknown): boolean {
  if (typeof chatId !== 'string') return false;
  const id = stripAccount(chatId.trim()).id;
  return id.endsWith('@lid') || id.endsWith('@hosted.lid');
}

/**
 * True when the chatId points at a WhatsApp group (`@g.us`), regardless of any
 * `personal:` / `professional:` / `leila:` account prefix. Canonical reads
 * (`social_get_conversation`, `social_resolve_target`, ...) return
 * account-prefixed ids; those must be reduced to the
 * bare jid before they reach the connector, which calls `sock.groupMetadata()`
 * with the value verbatim — a prefixed group jid is malformed and WhatsApp
 * silently drops the query, surfacing as "group metadata timeout".
 */
export function isGroupJid(chatId: unknown): boolean {
  if (typeof chatId !== 'string') return false;
  return stripAccount(chatId.trim()).id.endsWith('@g.us');
}

/** Reduce an account-prefixed WhatsApp id to the bare jid the connector expects. */
export function bareWhatsAppJid(chatId: string): string {
  return stripAccount(String(chatId).trim()).id;
}

/**
 * The ways one WhatsApp chat id is written: with or without the account
 * namespace, a phone jid as @c.us (how the index and the connector store it)
 * or @s.whatsapp.net (how WhatsApp writes it).
 */
export function whatsAppChatKeys(chatId: string): string[] {
  const bare = bareWhatsAppJid(chatId);
  if (!bare) return [];
  const keys = [bare];
  if (bare.endsWith('@s.whatsapp.net')) keys.push(bare.replace(/@s\.whatsapp\.net$/, '@c.us'));
  if (bare.endsWith('@c.us')) keys.push(bare.replace(/@c\.us$/, '@s.whatsapp.net'));
  return keys;
}

/**
 * Resolve a professional WhatsApp direct-send chatId into the conversation key
 * to gate on and the jid to actually send to.
 *
 * - LID jids keep their opaque id verbatim. Caller-supplied phone hints never
 *   change their destination; Baileys sends to the LID natively.
 * - Bare phones / `@c.us` / `@s.whatsapp.net` normalize to a phone jid:
 *   sendJid = `<digits>@s.whatsapp.net`, lookupKey = `professional:<jid>`.
 *
 * Returns null when the id is neither a LID jid nor a normalizable phone jid,
 * so the caller can raise the "valid individual phone or WhatsApp chat ID" error.
 */
export function resolveProfessionalSendTarget(
  chatId: unknown,
  _evidence: { phone?: unknown; phoneE164?: unknown; manualOpenUrl?: unknown } = {},
  account: Account = 'personal'
): {
  lookupKey: string;
  lookupKeys: string[];
  sendJid: string;
} | null {
  let target: unknown = chatId;
  if (typeof chatId === 'string') {
    let raw = chatId.trim();
    if (raw.startsWith('personal:')) {
      if (account !== 'personal') return null;
      raw = raw.slice('personal:'.length);
      target = raw;
    }
    const parsed = stripAccount(raw);
    if (parsed.id !== raw && parsed.account !== account) return null;
  }
  if (isLidJid(target)) {
    const lidJid = stripAccount(String(target).trim()).id;
    const lidLookupKey = accountKey(account, lidJid);
    return { lookupKey: lidLookupKey, lookupKeys: [lidLookupKey], sendJid: lidJid };
  }
  const waJid = normalizeDirectWhatsAppJid(target);
  if (!waJid) return null;
  const lookupKey = accountKey(account, waJid);
  return { lookupKey, lookupKeys: [lookupKey], sendJid: waJid };
}

export function normalizeDirectWhatsAppJid(chatId: unknown): string | null {
  if (typeof chatId !== 'string' && typeof chatId !== 'number') return null;

  let raw = String(chatId).trim();
  if (!raw) return null;
  raw = stripAccount(raw).id;
  if (raw.includes('@g.us')) return null;
  if (raw.includes('@') && !/@(?:c\.us|s\.whatsapp\.net)$/.test(raw)) return null;

  const user = raw.split('@')[0];
  if (raw.includes('@') ? !/^\d+(?::\d+)?$/.test(user) : !/^\+?\d[\d\s().-]*$/.test(user)) {
    return null;
  }
  let digits = user.split(':')[0].replace(/\D/g, '');
  if (digits.length === 9 && /^[6789]/.test(digits)) {
    digits = `34${digits}`;
  }
  if (digits.length < 8 || digits.length > 15) return null;

  return `${digits}@s.whatsapp.net`;
}

export class MCPServer {
  private server: Server;
  private searchService: SearchService;
  private summarizationService: SummarizationService;
  private unreadDigestService: UnreadDigestService;
  private draftService: DraftService;
  private repository: DatabaseRepository;
  private dbClient: Pool;
  private conversationResolver?: ConversationResolver;
  private redisClient: Redis;
  private logger: pino.Logger;
  private connectorUrl: string;
  private telegramUrl: string;
  private telegramBridgeUrl: string;
  private telegramBridgeSecret: string;
  private instagramUrl: string;
  private connectorSecret: string;
  // Kept as a test seam and fallback; production routing is resolved from the registry.
  private waUrls!: Record<string, string>;
  private tgUrls!: Record<string, string>;
  private tgBridgeUrls!: Record<string, string>;
  private inputValidators?: Map<string, ValidateFunction>;

  constructor(
    dbClient: Pool,
    redisClient: Redis,
    openaiApiKey: string,
    encryptionKey: string,
    _connectorSharedSecret: string,
    _connectorUrl: string,
    redisUrl: string,
    llmBaseUrl?: string,
    llmModel?: string
  ) {
    this.server = new Server(
      {
        name: 'socialmedia-mcp-server',
        version: '2.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );
    this.inputValidators = compileInputValidators();

    this.dbClient = dbClient;
    this.redisClient = redisClient;
    this.repository = new DatabaseRepository(dbClient);
    this.searchService = new SearchService(dbClient);
    this.summarizationService = new SummarizationService(
      openaiApiKey,
      dbClient,
      redisUrl,
      encryptionKey,
      llmBaseUrl,
      llmModel
    );
    this.unreadDigestService = new UnreadDigestService(
      dbClient,
      openaiApiKey,
      llmBaseUrl,
      llmModel
    );
    this.draftService = new DraftService(
      openaiApiKey,
      dbClient,
      encryptionKey,
      llmBaseUrl,
      llmModel
    );

    this.connectorUrl = _connectorUrl || 'http://whatsapp-connector:3001';
    this.telegramUrl = process.env.TELEGRAM_CONNECTOR_URL || 'http://telegram-connector:3002';
    this.telegramBridgeUrl = process.env.TELEGRAM_BRIDGE_URL || 'http://telegram-sync:3080';
    this.telegramBridgeSecret = process.env.TELEGRAM_BRIDGE_SECRET || '';
    this.instagramUrl = process.env.INSTAGRAM_CONNECTOR_URL || 'http://instagram-connector:3003';
    this.connectorSecret = _connectorSharedSecret;

    this.waUrls = Object.fromEntries(
      getAccounts('whatsapp')
        .filter(a => a.connectorUrl)
        .map(a => [a.accountId, a.connectorUrl!])
    );
    this.tgUrls = Object.fromEntries(
      getAccounts('telegram')
        .filter(a => a.connectorUrl)
        .map(a => [a.accountId, a.connectorUrl!])
    );
    this.tgBridgeUrls = Object.fromEntries(
      getAccounts('telegram')
        .filter(a => a.bridgeUrl)
        .map(a => [a.accountId, a.bridgeUrl!])
    );

    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });

    this.setupHandlers();
  }

  /** Registry entry for an enabled account. */
  private registryAccount(channel: AccountChannel, account?: string): SocialAccount {
    const id = normalizeAccount(account, channel);
    const entry = findAccount(channel, id);
    if (!entry) {
      throw this.canonicalError(
        'unsupported_capability',
        `${channel === 'whatsapp' ? 'WhatsApp' : channel === 'telegram' ? 'Telegram' : 'Instagram'} account '${id}' is not configured`
      );
    }
    return entry;
  }

  /** Connector URLs stay registry-driven; cached maps preserve older test seams. */
  private waUrl(account?: string): string {
    const entry = this.registryAccount('whatsapp', account);
    const url = entry.connectorUrl || this.waUrls[entry.accountId];
    if (!url)
      throw this.canonicalError(
        'unsupported_capability',
        `WhatsApp account '${entry.accountId}' is not configured`
      );
    return url;
  }

  private tgUrl(account?: string): string {
    const entry = this.registryAccount('telegram', account);
    const url = entry.connectorUrl || this.tgUrls[entry.accountId];
    if (!url)
      throw this.canonicalError(
        'unsupported_capability',
        `Telegram account '${entry.accountId}' is not configured`
      );
    return url;
  }

  private tgBridgeUrl(account?: string): string {
    const entry = this.registryAccount('telegram', account);
    const url = entry.bridgeUrl || this.tgBridgeUrls[entry.accountId];
    if (!url)
      throw this.canonicalError(
        'unsupported_capability',
        `Telegram bridge account '${entry.accountId}' is not configured`
      );
    return url;
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: SOCIAL_TOOL_REGISTRY.map(publicToolDefinition),
      _meta: { 'socialmedia/contractDigest': SOCIALMEDIA_CONTRACT_DIGEST },
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async request => {
      const { name, arguments: rawArguments } = request.params;
      const definition = SOCIAL_TOOL_REGISTRY.find(candidate => candidate.name === name);
      if (!definition) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }

      try {
        return await this.executeCanonicalTool(definition, asObject(rawArguments));
      } catch (error) {
        this.logger.error({ tool: name, error: safeError(error) }, 'Canonical tool failed');
        return this.errorResponse(this.errorCode(error), safeError(error), error);
      }
    });
  }

  /**
   * SC-1144 fase 2 — the single identity-binding gate. Every canonical tool
   * except social_list_accounts carries `accountId` in its inputSchema, so
   * this is the one point all account-routed calls pass through (WhatsApp,
   * Telegram and Instagram alike: the binding is per account, not per channel).
   *
   * With SOCIAL_IDENTITY_BINDING off this returns immediately without even
   * touching the bindings file — the legacy path stays byte-identical.
   */
  private applyIdentityBinding(definition: SocialToolDefinition, args: Record<string, any>): void {
    if (!identityBindingEnabled()) return;
    const properties = asObject((definition.inputSchema as any)?.properties);
    if (!('accountId' in properties)) return;
    const requested =
      typeof args.accountId === 'string' && args.accountId.trim() ? args.accountId : undefined;
    // Throws IdentityBindingError (canonicalCode 'forbidden') fail-closed when the
    // caller has no verified sub, no binding, or asked for an unbound account.
    // Omitted accountId resolves to the FIRST account of the binding — never the
    // global 'personal' default.
    args.accountId = resolveBoundAccount(requested, getRequestActor());
  }

  private async executeCanonicalTool(
    definition: SocialToolDefinition,
    args: Record<string, any>
  ): Promise<any> {
    this.applyIdentityBinding(definition, args);
    this.validateCanonicalArguments(definition, args);
    if (['readCurrentChat', 'sendCurrentChat', 'deliverCurrentChat'].includes(definition.handler)) {
      const scope = verifyCurrentChatCapability(
        args.capability,
        definition.handler === 'readCurrentChat'
          ? 'read'
          : definition.handler === 'sendCurrentChat'
            ? 'propose'
            : 'send'
      );
      await requireCurrentChatTurn(this.redisClient, scope);
    }
    if (definition.handler === 'sendCurrentChat') {
      if (
        process.env.HERMES_CHAT_ALLOW_PROPOSALS !== 'true' ||
        process.env.EMERGENCY_DISABLE_SENDING === 'true'
      ) {
        return this.errorResponse('unsupported_capability', 'Current-chat proposals are disabled');
      }
    } else if (definition.handler === 'deliverCurrentChat') {
      if (
        process.env.HERMES_CHAT_ALLOW_DIRECT_SEND !== 'true' ||
        process.env.EMERGENCY_DISABLE_SENDING === 'true'
      ) {
        return this.errorResponse('unsupported_capability', 'Hermes direct sending is disabled');
      }
    } else if (
      (definition.effect === 'externalWrite' || definition.effect === 'destructive') &&
      (process.env.ENABLE_SENDING !== 'true' || process.env.EMERGENCY_DISABLE_SENDING === 'true')
    ) {
      return this.errorResponse('unsupported_capability', 'External writes are disabled');
    }

    const execute = async () => {
      try {
        const legacyResult = await this.dispatchCanonicalTool(definition.handler, args);
        const canonical = isObject(legacyResult?.__canonicalResult)
          ? legacyResult.__canonicalResult
          : null;
        const data = canonical ? canonical.data : this.legacyResultData(legacyResult);
        const status =
          definition.effect === 'externalWrite' || definition.effect === 'destructive'
            ? 'accepted'
            : 'completed';
        return this.successResponse(data, status, {
          ...this.canonicalMeta(definition, args),
          ...(canonical ? asObject(canonical.meta) : {}),
        });
      } catch (error) {
        return this.errorResponse(this.errorCode(error), safeError(error), error);
      }
    };

    const directScope =
      definition.handler === 'deliverCurrentChat'
        ? verifyCurrentChatCapability(args.capability, 'send')
        : null;
    const idempotencyKey =
      (directScope ? `${directScope.requestId}\0${args.idempotencyKey || 'default'}` : '') ||
      (typeof args.idempotencyKey === 'string' ? args.idempotencyKey.trim() : '');
    const mutates = definition.effect !== 'read' && definition.effect !== 'compute';
    if (definition.handler === 'sendCurrentChat') return execute();
    if (!idempotencyKey || !mutates) return execute();

    const payload = { ...args };
    delete payload.idempotencyKey;
    const payloadHash = createHash('sha256')
      .update(
        directScope
          ? this.stableJson({ text: args.text || '', ...(args.media ? { media: args.media } : {}) })
          : this.stableJson(payload)
      )
      .digest('hex');
    const idempotencyScope = directScope
      ? `${directScope.account}\0${directScope.chat}`
      : `${args.channel}\0${args.accountId}`;
    const storageKey = `social:v2:idempotency:${createHash('sha256')
      .update(`${definition.name}\0${idempotencyScope}\0${idempotencyKey}`)
      .digest('hex')}`;
    const pending = JSON.stringify({
      payloadHash,
      state: 'pending',
      createdAt: new Date().toISOString(),
    });
    const claimed = await this.redisClient.set(storageKey, pending, 'EX', 86400, 'NX');

    if (!claimed) {
      const previousRaw = await this.redisClient.get(storageKey);
      const previous = previousRaw ? JSON.parse(previousRaw) : null;
      if (!previous || previous.payloadHash !== payloadHash) {
        return this.errorResponse(
          'conflict',
          'idempotencyKey was already used with a different payload'
        );
      }
      if (previous.response) {
        return this.withReplayMetadata(previous.response);
      }
      return this.errorResponse(
        'outcome_unknown',
        'An operation with this idempotencyKey is still pending; its outcome is unknown'
      );
    }

    const response = await execute();
    try {
      await this.redisClient.set(
        storageKey,
        JSON.stringify({
          payloadHash,
          state: response.isError ? 'failed' : 'completed',
          response,
          completedAt: new Date().toISOString(),
        }),
        'EX',
        86400
      );
    } catch (error) {
      this.logger.error(
        { tool: definition.name, error: safeError(error) },
        'Could not persist canonical idempotency result'
      );
      if (!response.isError) {
        return this.errorResponse(
          'outcome_unknown',
          'The operation returned success but its idempotency result could not be persisted; do not retry automatically',
          { acceptedResponse: response.structuredContent }
        );
      }
    }
    return response;
  }

  private validateCanonicalArguments(
    definition: SocialToolDefinition,
    args: Record<string, any>
  ): void {
    this.inputValidators ??= compileInputValidators();
    const validator = this.inputValidators.get(definition.name);
    if (!validator || !validator(args)) {
      throw this.canonicalError(
        'invalid_request',
        `Arguments do not match ${definition.name}.inputSchema: ${
          validator?.errors
            ?.map(error => `${error.instancePath || '/'} ${error.message || 'is invalid'}`)
            .join('; ') || 'validation failed'
        }`
      );
    }
    const mutates = definition.effect !== 'read' && definition.effect !== 'compute';
    if (
      mutates &&
      definition.handler !== 'sendCurrentChat' &&
      definition.handler !== 'deliverCurrentChat'
    ) {
      if (typeof args.channel !== 'string' || !args.channel.trim()) {
        throw this.canonicalError('invalid_request', 'channel is required for every write');
      }
      if (typeof args.accountId !== 'string' || !args.accountId.trim()) {
        throw this.canonicalError('invalid_request', 'accountId is required for every write');
      }
    }
    if (args.channel !== undefined) this.channel(args);
    if (args.target !== undefined && typeof args.target !== 'string') {
      throw this.canonicalError(
        'invalid_request',
        'target must be a string; numeric targets never infer a channel'
      );
    }
    if (
      args.readSource !== undefined &&
      !['auto', 'provider', 'index'].includes(String(args.readSource))
    ) {
      throw this.canonicalError(
        'invalid_request',
        "readSource must be 'auto', 'provider' or 'index'"
      );
    }
  }

  private async dispatchCanonicalTool(handler: string, args: Record<string, any>): Promise<any> {
    switch (handler) {
      case 'readCurrentChat': {
        const scope = verifyCurrentChatCapability(args.capability, 'read');
        await requireCurrentChatTurn(this.redisClient, scope);
        const chat = await this.resolveCurrentChatReadScope(scope.account, scope.chat);
        return this.handleWhatsAppGetMessages({
          account: scope.account,
          chatId: chat.chatId,
          conversationIds: chat.conversationIds,
          limit: args.limit || 20,
        });
      }
      case 'sendCurrentChat': {
        const scope = verifyCurrentChatCapability(args.capability, 'propose');
        const result = await createCurrentChatProposal(
          this.redisClient,
          scope,
          args.text,
          args.idempotencyKey
        );
        return this.jsonResponse({
          proposalId: result.proposal.id,
          account: scope.account,
          chat: scope.chat,
          turn: scope.turn,
          text: result.proposal.text,
          expiresAt: result.proposal.expiresAt,
          replayed: result.replayed,
          requiresOwnerApproval: true,
        });
      }
      case 'deliverCurrentChat': {
        const scope = verifyCurrentChatCapability(args.capability, 'send');
        await requireCurrentChatTurn(this.redisClient, scope);
        if (!args.media && !args.text?.trim())
          throw this.canonicalError('invalid_request', 'Text or media is required');
        if (args.media) {
          const url = String(args.media.url);
          const inline = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,([a-z0-9+/]+={0,2})$/i.exec(url);
          if (url.startsWith('data:')) {
            if (
              !inline ||
              inline[1].length % 4 !== 0 ||
              Buffer.from(inline[1], 'base64').length > 8 * 1024 * 1024
            ) {
              throw this.canonicalError(
                'invalid_request',
                'Inline media must be base64 and at most 8 MiB'
              );
            }
          } else {
            const parsed = new URL(url);
            if (
              !['http:', 'https:'].includes(parsed.protocol) ||
              parsed.username ||
              parsed.password
            ) {
              throw this.canonicalError(
                'invalid_request',
                'Media URL must use HTTP(S) without credentials'
              );
            }
          }
        }
        const chat = await this.resolveCurrentChatReadScope(scope.account, scope.chat);
        const digest = createHash('sha256')
          .update(
            `${scope.account}\0${scope.chat}\0${scope.requestId}\0${args.idempotencyKey || 'default'}`
          )
          .digest('hex');
        const token = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
        const destination = this.whatsAppProviderJid(chat.chatId, scope.account, 'chatId');
        const result = args.media
          ? await this.handleSendFile(
              {
                account: scope.account,
                conversationId: destination,
                fileUrl: args.media.url,
                fileName: args.media.name,
                caption: args.text || undefined,
                scopedSendToken: token,
              },
              { idempotencyKey: `mcp-current-${digest}` }
            )
          : await this.handleSendMessage(
              {
                account: scope.account,
                chatId: this.whatsAppProviderJid(chat.chatId, scope.account, 'chatId'),
                text: args.text,
                scopedSendToken: token,
              },
              { idempotencyKey: `mcp-current-${digest}` }
            );
        if (!pickString(asObject(this.legacyResultData(result)), ['messageId'])) {
          throw this.canonicalError(
            'outcome_unknown',
            'Connector did not confirm a message ID; do not retry automatically'
          );
        }
        return result;
      }
      case 'listAccounts':
        return this.canonicalListAccounts(args);
      case 'listConversations':
        return this.canonicalListConversations(args);
      case 'getConversation':
        return this.canonicalGetConversation(args);
      case 'listParticipants':
        return this.canonicalListParticipants(args);
      case 'listMessages':
        return this.canonicalListMessages(args);
      case 'searchMessages':
        return this.canonicalSearchMessages(args);
      case 'resolveTarget':
        return this.canonicalResolveTarget(args);
      case 'getMedia':
        return this.canonicalGetMedia(args);
      case 'summarize':
        return this.canonicalSummarize(args);
      case 'listDrafts':
        if (this.readSource(args, 'index') === 'provider') {
          throw this.canonicalError(
            'unsupported_capability',
            'Drafts only exist in the local index'
          );
        }
        this.requireChannel(args, 'whatsapp');
        return this.handleListDrafts({
          chatId: accountKey(
            normalizeAccount(this.account(args)),
            this.whatsAppProviderTarget(args)
          ),
          status: args.status,
        });
      case 'getDigest':
        if (this.readSource(args, 'index') === 'provider') {
          throw this.canonicalError(
            'unsupported_capability',
            'Digest checkpoints only exist in the local index'
          );
        }
        return this.canonicalGetDigest(args);
      case 'getProfile':
        return this.canonicalGetProfile(args);
      case 'listContent':
        return this.canonicalListContent(args);
      case 'listComments':
        this.requireChannel(args, 'instagram');
        if (this.readSource(args, 'provider') === 'index') {
          throw this.canonicalError(
            'unsupported_capability',
            'Instagram comments are not available from the local index'
          );
        }
        return this.handleInstagramGetComments({
          account: this.instagramAccount(args),
          mediaId: this.target(args),
        });
      case 'getInsights':
        return this.canonicalGetInsights(args);
      case 'discoverBusiness':
        return this.canonicalDiscoverBusiness(args);
      case 'listMentions':
        this.requireChannel(args, 'instagram');
        if (this.readSource(args, 'provider') === 'index') {
          throw this.canonicalError(
            'unsupported_capability',
            'Instagram mentions are not available from the local index'
          );
        }
        return this.handleInstagramGetMentions({
          account: this.instagramAccount(args),
          limit: args.limit,
        });
      case 'validateAccount':
        return this.canonicalValidateAccount(args);
      case 'getForum':
        this.requireChannel(args, 'telegram');
        if (this.readSource(args, 'provider') === 'index') {
          throw this.canonicalError(
            'unsupported_capability',
            'Telegram forum topics are only available from the provider'
          );
        }
        return this.handleTelegramGetTopics({
          chatId: this.target(args),
          account: this.account(args),
          query: args.query,
          limit: args.limit,
        });
      case 'sendMessage':
        return this.canonicalSendMessage(args);
      case 'forwardMessage':
        return this.canonicalForwardMessage(args);
      case 'deleteMessage':
        return this.canonicalDeleteMessage(args);
      case 'editMessage':
        return this.canonicalEditMessage(args);
      case 'markRead':
        return this.canonicalMarkRead(args);
      case 'createDraft':
        this.requireChannel(args, 'whatsapp');
        return this.handleDraftReply({
          chatId: accountKey(
            normalizeAccount(this.account(args)),
            this.whatsAppProviderTarget(args)
          ),
          messageId: args.messageId,
          lastN: args.lastN,
          tone: args.tone,
          language: args.language,
          constraints: args.constraints,
        });
      case 'approveDraft':
        this.requireChannel(args, 'whatsapp');
        await this.requireDraftAccount(
          this.string(args, 'draftId'),
          normalizeAccount(this.account(args))
        );
        return this.handleApproveDraft({ draftId: this.string(args, 'draftId') });
      case 'sendDraft':
        this.requireChannel(args, 'whatsapp');
        return this.handleSendApprovedReply({
          sendToken: this.string(args, 'sendToken'),
          account: this.account(args),
        });
      case 'startDigest': {
        const platforms = [
          ...new Set([args.channel, ...(Array.isArray(args.channels) ? args.channels : [])]),
        ];
        if (platforms.some((item: unknown) => item !== 'whatsapp' && item !== 'telegram')) {
          throw this.canonicalError(
            'unsupported_capability',
            'Unread digests are only supported for WhatsApp and Telegram'
          );
        }
        return this.handleUnreadDigest({
          action: 'start',
          account: this.account(args),
          platforms,
          batchSize: args.batchSize,
          maxChats: args.maxChats,
          messageLimit: args.messageLimit,
          language: args.language,
        });
      }
      case 'continueDigest':
        return this.canonicalContinueDigest(args);
      case 'manageSession':
        return this.canonicalManageSession(args);
      case 'clickInteraction':
        return this.canonicalClickInteraction(args);
      case 'manageForum':
        return this.canonicalManageForum(args);
      case 'manageChat':
        return this.canonicalManageChat(args);
      case 'publishContent':
        return this.canonicalPublishContent(args);
      case 'manageComment':
        return this.canonicalManageComment(args);
      case 'reactMessage':
        return this.canonicalReactMessage(args);
      case 'starMessage':
        return this.canonicalStarMessage(args);
      case 'pinMessage':
        return this.canonicalPinMessage(args);
      case 'listPinned':
        return this.canonicalListPinned(args);
      case 'listStarred':
        return this.canonicalListStarred(args);
      case 'listStatuses':
        return this.canonicalListStatuses(args);
      case 'listChannelPosts':
        return this.canonicalListChannelPosts(args);
      case 'publishStatus':
        return this.canonicalPublishStatus(args);
      case 'setChatState':
        return this.canonicalSetChatState(args);
      case 'getGroup':
        return this.canonicalGetGroup(args);
      case 'manageGroup':
        return this.canonicalManageGroup(args);
      case 'inviteToGroup':
        return this.canonicalInviteToGroup(args);
      case 'listCommunities':
        return this.canonicalListCommunities(args);
      case 'getCommunity':
        return this.canonicalGetCommunity(args);
      case 'manageCommunity':
        return this.canonicalManageCommunity(args);
      case 'lookupChannel':
        return this.canonicalLookupChannel(args);
      case 'listChannels':
        return this.canonicalListChannels(args);
      case 'manageChannelSubscription':
        return this.canonicalManageChannelSubscription(args);
      case 'sendPoll':
        return this.canonicalSendPoll(args);
      case 'votePoll':
        return this.canonicalVotePoll(args);
      case 'getPollResults':
        return this.canonicalGetPollResults(args);
      case 'sendEvent':
        return this.canonicalSendEvent(args);
      case 'respondEvent':
        return this.canonicalRespondEvent(args);
      case 'getEventResults':
        return this.canonicalGetEventResults(args);
      case 'startChat':
        return this.canonicalStartChat(args);
      case 'shareContact':
        return this.canonicalShareContact(args);
      case 'listContacts':
        return this.canonicalListContacts(args);
      case 'getPresence':
        return this.canonicalGetPresence(args);
      case 'getPrivacy':
        return this.canonicalGetPrivacy(args);
      case 'setPrivacy':
        return this.canonicalSetPrivacy(args);
      case 'setDisappearing':
        return this.canonicalSetDisappearing(args);
      case 'getMyProfile':
        return this.canonicalGetMyProfile(args);
      case 'updateMyProfile':
        return this.canonicalUpdateMyProfile(args);
      case 'sendTyping':
        return this.canonicalSendTyping(args);
      case 'sendSticker':
        return this.canonicalSendSticker(args);
      case 'sendGif':
        return this.whatsAppStickerOrGif('gif', args);
      case 'blockContact':
        return this.canonicalBlockContact(args);
      case 'listBlocked':
        return this.canonicalListBlocked(args);
      default:
        throw this.canonicalError(
          'unsupported_capability',
          `No canonical handler is registered for capability '${handler}'`
        );
    }
  }

  private canonicalError(code: string, message: string, details?: unknown): Error {
    const error = new Error(message) as Error & {
      canonicalCode?: string;
      canonicalDetails?: unknown;
    };
    error.canonicalCode = code;
    if (details !== undefined) error.canonicalDetails = details;
    return error;
  }

  private errorCode(error: unknown): string {
    const candidate = error as { canonicalCode?: string; code?: number; name?: string };
    if (candidate?.canonicalCode) return candidate.canonicalCode;
    const message = safeError(error).toLowerCase();
    // fase 3 / PR-2: the WhatsApp connector's Idempotency-Key answers (409).
    if (message.includes('send_outcome_uncertain')) return 'outcome_unknown';
    if (message.includes('idempotency_key_reused')) return 'conflict';
    if (
      candidate?.name === 'TimeoutError' ||
      candidate?.name === 'AbortError' ||
      message.includes('timeout') ||
      message.includes('timed out')
    ) {
      return 'outcome_unknown';
    }
    if (
      error instanceof McpError &&
      (error.code === ErrorCode.InvalidParams || error.code === ErrorCode.InvalidRequest)
    ) {
      return 'invalid_request';
    }
    return 'provider_error';
  }

  private successResponse(
    data: unknown,
    status: 'completed' | 'accepted' | 'delivered' | 'read',
    meta: Record<string, unknown> = {}
  ): any {
    const structuredContent = { ok: true, status, data, meta };
    return {
      structuredContent,
      content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
    };
  }

  private errorResponse(code: string, message: string, details?: unknown): any {
    const status =
      code === 'conflict' ? 'conflict' : code === 'outcome_unknown' ? 'outcome_unknown' : 'failed';
    const structuredContent = {
      ok: false,
      status,
      data: null,
      meta: {},
      error: {
        code,
        message,
        ...(details && !(details instanceof Error) ? { details } : {}),
        // A canonical error may carry its own details (connector failureClass, fallback).
        ...(details instanceof Error && (details as { canonicalDetails?: unknown }).canonicalDetails
          ? { details: (details as { canonicalDetails?: unknown }).canonicalDetails }
          : {}),
      },
    };
    return {
      isError: true,
      structuredContent,
      content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
    };
  }

  private withReplayMetadata(response: any): any {
    const structuredContent = {
      ...asObject(response?.structuredContent),
      meta: { ...asObject(response?.structuredContent?.meta), replayed: true },
    };
    return {
      ...response,
      structuredContent,
      content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
    };
  }

  private legacyResultData(result: any): unknown {
    if (result?.structuredContent !== undefined) return result.structuredContent;
    const content = Array.isArray(result?.content) ? result.content : [];
    const textItems = content
      .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
      .map((item: any) => item.text);
    if (textItems.length === 1) {
      try {
        return JSON.parse(textItems[0]);
      } catch {
        return textItems[0];
      }
    }
    return content.length ? content : result;
  }

  private canonicalMeta(
    definition: SocialToolDefinition,
    args: Record<string, any>
  ): Record<string, unknown> {
    if (definition.effect !== 'read' && definition.effect !== 'compute') return {};
    const requested = String(args.readSource || 'auto');
    let kind: 'providerQuery' | 'providerSync' | 'localIndex';
    if (requested === 'provider') {
      kind = 'providerQuery';
    } else if (requested === 'index') {
      kind = 'localIndex';
    } else if (
      [
        'searchMessages',
        'summarize',
        'listDrafts',
        'getDigest',
        'listContacts',
        'readCurrentChat',
      ].includes(definition.handler)
    ) {
      kind = 'localIndex';
    } else if (definition.handler === 'listMessages') {
      kind = args.channel === 'instagram' ? 'providerQuery' : 'providerSync';
    } else if (definition.handler === 'resolveTarget') {
      kind = args.channel === 'whatsapp' ? 'providerSync' : 'providerQuery';
    } else {
      kind = 'providerQuery';
    }
    return {
      source: {
        kind,
        asOf: new Date().toISOString(),
        // WhatsApp's followed-channel list cannot be read: only the channels seen.
        completeness: definition.handler === 'listChannels' ? 'partial' : 'complete',
      },
    };
  }

  private stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(item => this.stableJson(item)).join(',')}]`;
    if (isObject(value)) {
      return `{${Object.keys(value)
        .sort()
        .map(key => `${JSON.stringify(key)}:${this.stableJson(value[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }

  private channel(args: Record<string, any>): SocialChannel {
    if (!['whatsapp', 'telegram', 'instagram'].includes(String(args.channel))) {
      throw this.canonicalError(
        'invalid_request',
        "channel must be 'whatsapp', 'telegram' or 'instagram'"
      );
    }
    return args.channel as SocialChannel;
  }

  private requireChannel(args: Record<string, any>, expected: SocialChannel): void {
    const actual = this.channel(args);
    if (actual !== expected) {
      throw this.canonicalError(
        'unsupported_capability',
        `This operation is not supported for channel '${actual}'`
      );
    }
  }

  private account(args: Record<string, any>): string {
    const accountIdValue = this.string(args, 'accountId');
    const channelName = this.channel(args);
    if (
      !this.configuredAccounts(channelName).some(
        configured => configured.accountId === accountIdValue
      )
    ) {
      throw this.canonicalError(
        'unsupported_capability',
        `Account '${accountIdValue}' is not configured for channel '${channelName}'`
      );
    }
    return accountIdValue;
  }

  private instagramAccount(args: Record<string, any>): string {
    this.requireChannel(args, 'instagram');
    return this.account(args);
  }

  private target(args: Record<string, any>): string {
    return this.string(args, 'target');
  }

  private whatsAppProviderTarget(args: Record<string, any>, field = 'target'): string {
    this.requireChannel(args, 'whatsapp');
    const accountIdValue = normalizeAccount(this.account(args));
    const raw = this.string(args, field);
    return this.whatsAppProviderJid(raw, accountIdValue, field);
  }

  /** Validate the selected namespace, then remove it before calling Baileys. */
  private whatsAppProviderJid(raw: string, accountIdValue: string, field = 'target'): string {
    const parsed = stripAccount(raw);
    if (raw.startsWith(`${accountIdValue}:`)) return raw.slice(accountIdValue.length + 1);
    if (/^[a-z][a-z0-9_-]*:(?!\/\/)/.test(raw) && parsed.id === raw)
      throw this.canonicalError('invalid_request', 'Unknown account namespace');
    if (parsed.id !== raw && parsed.account !== accountIdValue) {
      throw this.canonicalError(
        'invalid_request',
        `${field} belongs to the ${parsed.account} WhatsApp namespace but accountId is '${accountIdValue}'`
      );
    }
    return parsed.id;
  }

  private string(args: Record<string, any>, field: string): string {
    if (typeof args[field] !== 'string' || !args[field].trim()) {
      throw this.canonicalError('invalid_request', `${field} is required and must be a string`);
    }
    return args[field].trim();
  }

  private readSource(
    args: Record<string, any>,
    fallback: 'provider' | 'index'
  ): 'provider' | 'index' {
    const value = String(args.readSource || 'auto');
    return value === 'auto' ? fallback : (value as 'provider' | 'index');
  }

  private async providerGet(baseUrl: string, path: string, timeoutMs = 30000): Promise<any> {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { ...this.authHeaders(baseUrl), ...actorRequestHeaders() },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Provider query failed (${response.status}): ${await response.text()}`);
    }
    return response.json();
  }

  private async canonicalListAccounts(args: Record<string, any>): Promise<any> {
    const status = this.legacyResultData(await this.handleMessagingStatus());
    const selectedChannel = args.channel === undefined ? undefined : this.channel(args);
    const igStatus = (accountId: string) =>
      asObject(asObject(asObject(status).instagram).accounts)[accountId] || null;
    // SC-1256: the connector answers `no_credential` per account when the
    // caller's sub has no row; those entries are omitted, never listed.
    const noCredential = (item: { channel: string; accountId: string }) =>
      item.channel === 'instagram' && asObject(igStatus(item.accountId)).status === 'no_credential';
    const candidates = getAccounts(selectedChannel, true).map(item => ({
      channel: item.channel,
      accountId: item.accountId,
      label: item.label,
      namespace: item.namespace,
      profile: item.profile,
      brainInstance: item.brainInstance,
      enabled: item.enabled,
      qrUrl: item.qrUrl || null,
      transport: item.transport,
      capabilities: {
        ...item.capabilities,
        conversations: item.enabled && item.capabilities.conversations,
        messages: item.enabled && item.capabilities.messages,
        media: item.enabled && item.capabilities.media,
        send:
          item.enabled &&
          item.capabilities.send &&
          process.env.ENABLE_SENDING === 'true' &&
          process.env.EMERGENCY_DISABLE_SENDING !== 'true',
        groups: item.enabled && item.capabilities.groups,
        publish:
          item.enabled &&
          item.capabilities.publish &&
          item.channel === 'instagram' &&
          process.env.ENABLE_SENDING === 'true' &&
          process.env.EMERGENCY_DISABLE_SENDING !== 'true',
      },
      status: item.enabled
        ? item.channel === 'instagram'
          ? asObject(asObject(asObject(status).instagram).accounts)[item.accountId] ||
            asObject(asObject(status)[item.channel])[item.accountId] ||
            null
          : asObject(asObject(status)[item.channel])[item.accountId] || null
        : { status: 'disabled' },
    }));
    const omitted = candidates.filter(item => item.enabled && noCredential(item));
    const accounts = candidates.filter(item => !item.enabled || !noCredential(item));
    if (omitted.length) {
      const first = asObject(igStatus(omitted[0].accountId));
      const code = String(first.error || 'no_instagram_credential');
      const message = String(first.message || 'no instagram credential for this user');
      if (!accounts.length) throw this.canonicalError(code, message);
      return this.jsonResponse({
        contractDigest: SOCIALMEDIA_CONTRACT_DIGEST,
        accounts,
        partialErrors: [{ channel: 'instagram', code, message }],
      });
    }
    return this.jsonResponse({
      contractDigest: SOCIALMEDIA_CONTRACT_DIGEST,
      accounts,
    });
  }

  private configuredAccounts(channel?: SocialChannel): Array<{
    channel: SocialChannel;
    accountId: string;
  }> {
    return getAccounts(channel);
  }

  private async canonicalListConversations(args: Record<string, any>): Promise<any> {
    const selectedChannel = args.channel === undefined ? undefined : this.channel(args);
    const selectedAccount =
      args.accountId === undefined ? undefined : this.string(args, 'accountId');
    const accounts = this.configuredAccounts(selectedChannel).filter(
      item => !selectedAccount || item.accountId === selectedAccount
    );
    if (!accounts.length) {
      throw this.canonicalError(
        'unsupported_capability',
        `No configured account matches channel=${selectedChannel || '*'} accountId=${selectedAccount || '*'}`
      );
    }

    const conversations: any[] = [];
    const partialErrors: any[] = [];
    for (const account of accounts) {
      try {
        const result = await this.listConversationsFor(account.channel, account.accountId, args);
        let providerSelfId = '';
        if (account.channel === 'instagram') {
          const profile = this.legacyResultData(
            await this.handleInstagramGetProfile({ account: account.accountId })
          );
          providerSelfId = pickString(profile, ['id']);
          if (!providerSelfId) {
            throw this.canonicalError(
              'provider_error',
              `Instagram profile '${account.accountId}' did not return its provider id`
            );
          }
        }
        const data = this.legacyResultData(result);
        for (const row of extractArrayPayload(data, [
          'conversations',
          'chats',
          'dialogs',
          'data',
        ])) {
          const participants = extractArrayPayload(asObject(row).participants, ['data']);
          const sendPeer =
            account.channel === 'instagram'
              ? participants.find(
                  participant =>
                    pickString(participant, ['id']) &&
                    pickString(participant, ['id']) !== providerSelfId
                )
              : null;
          const rawType = pickString(row, ['kind', 'type', 'chatType']).toLowerCase();
          const rawTarget = pickString(row, [
            'target',
            'conversationId',
            'chatId',
            'id',
            'waChatId',
            'username',
          ]);
          const providerTarget =
            account.channel === 'whatsapp'
              ? bareWhatsAppJid(rawTarget)
              : account.channel === 'telegram'
                ? stripAccount(rawTarget).id.replace(/^tg_/, '')
                : rawTarget;
          const conversation = {
            ...account,
            target: rawTarget,
            sendTarget: pickString(sendPeer, ['id']) || providerTarget,
            name:
              pickString(sendPeer, ['username', 'name']) ||
              pickString(row, ['name', 'title', 'displayName']) ||
              null,
            handle: pickString(sendPeer, ['username']) || null,
            kind:
              rawType.includes('group') || Boolean(row?.isGroup) || Boolean(row?.is_group)
                ? 'group'
                : rawType.includes('channel')
                  ? 'channel'
                  : 'user',
            unreadCount: pickNumber(row, ['unreadCount', 'unread_count'], 0),
            lastMessageAt:
              pickString(row, ['lastMessageAt', 'last_message_at', 'timestamp']) || null,
            raw: row,
          };
          const query = String(args.query || '')
            .trim()
            .toLowerCase();
          if (
            !query ||
            [conversation.target, conversation.sendTarget, conversation.name, conversation.handle]
              .join(' ')
              .toLowerCase()
              .includes(query)
          ) {
            conversations.push(conversation);
          }
        }
      } catch (error) {
        partialErrors.push({
          ...account,
          code: this.errorCode(error),
          message: safeError(error),
        });
      }
    }
    if (!conversations.length && partialErrors.length === accounts.length) {
      const first = partialErrors[0];
      throw this.canonicalError(first.code, first.message);
    }
    return {
      __canonicalResult: {
        data: { conversations, count: conversations.length },
        meta: {
          source: {
            kind: this.readSource(args, 'provider') === 'provider' ? 'providerQuery' : 'localIndex',
            asOf: new Date().toISOString(),
            completeness: partialErrors.length ? 'partial' : 'complete',
          },
          ...(partialErrors.length ? { partialErrors } : {}),
        },
      },
    };
  }

  private async listConversationsFor(
    channelName: SocialChannel,
    accountIdValue: string,
    args: Record<string, any>
  ): Promise<any> {
    const source = this.readSource(args, 'provider');
    if (channelName === 'whatsapp') {
      if (source === 'provider') {
        return this.jsonResponse(
          await this.providerGet(this.waUrl(accountIdValue), '/api/public/chats')
        );
      }
      return this.handleListConversations({
        account: accountIdValue,
        query: args.query,
        limit: args.limit,
      });
    }
    if (channelName === 'telegram') {
      if (source === 'provider') {
        const data = await this.providerGet(this.tgUrl(accountIdValue), '/api/public/dialogs');
        const dialogs = extractArrayPayload(data, ['dialogs']).slice(0, args.limit || 50);
        return this.jsonResponse({ ...asObject(data), dialogs, count: dialogs.length });
      }
      return this.handleTelegramGetDialogs({ account: accountIdValue });
    }
    if (source === 'index') {
      throw this.canonicalError(
        'unsupported_capability',
        'Instagram conversations are not available from the local index'
      );
    }
    return this.handleInstagramGetConversations({
      account: accountIdValue,
      limit: args.limit,
    });
  }

  private async canonicalGetConversation(args: Record<string, any>): Promise<any> {
    const channelName = this.channel(args);
    const source = this.readSource(args, 'provider');
    const accountIdValue = this.account(args);
    const conversationTarget = this.target(args);
    if (channelName === 'whatsapp') {
      if (source === 'index') {
        return this.handleGetChat({ chatId: conversationTarget, account: accountIdValue });
      }
      const data = await this.providerGet(this.waUrl(accountIdValue), '/api/public/chats');
      const conversations = extractArrayPayload(data, ['chats']);
      const wanted = whatsAppChatKeys(conversationTarget);
      const conversation = conversations.find(item =>
        whatsAppChatKeys(pickString(item, ['id', 'chatId'])).some(key => wanted.includes(key))
      );
      if (conversation) return this.jsonResponse(conversation);
      // The connector lists only the chats of its last history snapshot (10 in
      // prod after a relink), so most 1:1 chats were "not_found" (QA 02-10).
      // The index knows every chat, PN ↔ LID aliases and merges included.
      const indexed = await this.whatsAppIndexedConversation(
        normalizeAccount(accountIdValue),
        wanted
      );
      if (!indexed) {
        throw this.canonicalError(
          'not_found',
          `WhatsApp conversation '${conversationTarget}' was not returned by the provider nor found in the index`
        );
      }
      return this.jsonResponse(indexed);
    }
    if (channelName === 'telegram') {
      if (source === 'index') {
        return this.handleTelegramChatInfo({
          chatId: conversationTarget,
          account: accountIdValue,
        });
      }
      const data = await this.providerGet(this.tgUrl(accountIdValue), '/api/public/dialogs');
      const conversation = extractArrayPayload(data, ['dialogs']).find(item => {
        const id = pickString(item, ['id', 'chatId', 'peerId']);
        return id === conversationTarget || `tg_${id}` === conversationTarget;
      });
      if (!conversation) {
        throw this.canonicalError(
          'not_found',
          `Telegram conversation '${conversationTarget}' was not returned by the provider`
        );
      }
      return this.jsonResponse(conversation);
    }
    if (source === 'index') {
      throw this.canonicalError(
        'unsupported_capability',
        'Instagram conversations are not available from the local index'
      );
    }
    const result = await this.handleInstagramGetConversations({
      account: accountIdValue,
      limit: 100,
    });
    const data = this.legacyResultData(result);
    const conversation = extractArrayPayload(data, ['conversations', 'data']).find(
      item => pickString(item, ['id', 'conversationId']) === conversationTarget
    );
    if (!conversation) {
      throw this.canonicalError(
        'not_found',
        `Instagram conversation '${conversationTarget}' was not returned by the provider`
      );
    }
    return this.jsonResponse(conversation);
  }

  /**
   * A WhatsApp chat from the index in the provider's shape ({id, name, isGroup,
   * timestamp}) plus its conversationId and `resolvedFrom: 'index'`. A 1:1
   * chat whose stored name is only its jid is named after the other side.
   */
  private async whatsAppIndexedConversation(
    account: Account,
    refs: string[]
  ): Promise<Record<string, unknown> | null> {
    let row: Awaited<ReturnType<ConversationResolver['resolve']>> = null;
    for (const ref of refs) {
      row = await this.conversations().resolve('whatsapp', account, ref);
      if (row && ConversationResolver.belongsTo(row, 'whatsapp', account)) break;
      row = null;
    }
    if (!row) return null;
    const externalId = String(row.external_id || bareWhatsAppJid(row.id));
    const isGroup = row.is_group === true || externalId.endsWith('@g.us');
    let name = typeof row.name === 'string' ? row.name : null;
    if (!isGroup && (!name || name.includes('@'))) {
      const other = await this.dbClient.query(
        `SELECT COALESCE(
                  CASE WHEN position('@' in COALESCE(p.name, '@')) = 0 THEN p.name END,
                  CASE WHEN position('@' in COALESCE(p.push_name, '@')) = 0 THEN p.push_name END
                ) AS name
           FROM conversation_participants cp
           JOIN participants p ON p.id = cp.participant_id
          WHERE cp.conversation_id = $1
          ORDER BY p.last_seen DESC NULLS LAST
          LIMIT 1`,
        [row.id]
      );
      name = (other.rows[0]?.name as string | null) || name;
    }
    const last = row.last_message_at ? new Date(row.last_message_at as string) : null;
    return {
      id: externalId,
      name,
      isGroup,
      timestamp: last && !Number.isNaN(last.getTime()) ? Math.floor(last.getTime() / 1000) : 0,
      conversationId: row.id,
      resolvedFrom: 'index',
    };
  }

  private async canonicalListParticipants(args: Record<string, any>): Promise<any> {
    const channelName = this.channel(args);
    const accountIdValue = this.account(args);
    if (channelName === 'whatsapp') {
      if (this.readSource(args, 'provider') === 'index') {
        throw this.canonicalError(
          'unsupported_capability',
          'WhatsApp group participants are only available from the provider'
        );
      }
      return this.handleGetGroupParticipants({
        groupId: this.target(args),
        account: accountIdValue,
      });
    }
    if (channelName === 'telegram') {
      if (this.readSource(args, 'provider') === 'provider') {
        return this.jsonResponse(
          await this.connectorCall(
            this.tgUrl(accountIdValue),
            'GET',
            `/api/v1/chats/${encodeURIComponent(this.target(args))}/participants?limit=${
              args.limit || 100
            }`
          )
        );
      }
      return this.handleTelegramParticipants({
        chatId: this.target(args),
        account: accountIdValue,
        limit: args.limit,
      });
    }
    throw this.canonicalError(
      'unsupported_capability',
      'Instagram participant listing is not supported by the deployed connector'
    );
  }

  private async canonicalListMessages(args: Record<string, any>): Promise<any> {
    const channelName = this.channel(args);
    const accountIdValue = this.account(args);
    const conversationTarget = this.target(args);
    const source = this.readSource(args, channelName === 'instagram' ? 'provider' : 'index');
    if (channelName === 'whatsapp') {
      if (source === 'provider') {
        return this.jsonResponse(
          await this.providerGet(
            this.waUrl(accountIdValue),
            `/api/public/history/${encodeURIComponent(conversationTarget)}?limit=${
              args.limit || 50
            }`,
            45000
          )
        );
      }
      return this.handleWhatsAppGetMessages({
        chatId: conversationTarget,
        account: accountIdValue,
        limit: args.limit,
        before: args.before === undefined ? undefined : String(args.before),
        after: args.after === undefined ? undefined : String(args.after),
      });
    }
    if (channelName === 'telegram') {
      if (source === 'provider') {
        return this.jsonResponse(
          await this.providerGet(
            this.tgUrl(accountIdValue),
            `/api/public/messages/${encodeURIComponent(conversationTarget)}?limit=${
              args.limit || 50
            }`
          )
        );
      }
      return this.handleTelegramGetMessages({
        chatId: conversationTarget,
        topicId: args.threadId,
        account: accountIdValue,
        limit: args.limit,
        offsetId: args.before === undefined ? undefined : Number(args.before),
      });
    }
    if (source === 'index') {
      throw this.canonicalError(
        'unsupported_capability',
        'Instagram messages are not available from the local index'
      );
    }
    return this.handleInstagramGetConversationMessages({
      account: accountIdValue,
      conversationId: conversationTarget,
      limit: args.limit,
    });
  }

  private async canonicalSearchMessages(args: Record<string, any>): Promise<any> {
    if (this.readSource(args, 'index') === 'provider') {
      throw this.canonicalError(
        'unsupported_capability',
        'Provider-side message search is not supported; use readSource=index'
      );
    }
    if (args.mediaType !== undefined && !isMediaType(args.mediaType)) {
      throw this.canonicalError(
        'invalid_request',
        `mediaType must be one of ${MEDIA_TYPES.join(', ')}`
      );
    }
    const mediaType: MediaType | undefined = args.mediaType;
    if (args.channel === 'telegram') {
      return this.handleTelegramSearch({
        query: this.string(args, 'query'),
        chatId: args.target,
        topicId: args.threadId,
        account: this.account(args),
        limit: args.limit,
        mediaType,
      });
    }
    if (args.channel === 'instagram') {
      // The ingester files Instagram rows under the account's DB namespace
      // with ids that already carry the Instagram account (ig_<account>_…).
      return this.handleSearchMessages({
        query: this.string(args, 'query'),
        chatId: args.target,
        account: this.account(args),
        platform: 'instagram',
        rawIds: true,
        from: args.from,
        to: args.to,
        sender: args.sender,
        limit: args.limit,
        mediaType,
      });
    }
    const account =
      args.accountId === undefined
        ? undefined
        : normalizeAccount(
            this.account({
              ...args,
              channel: args.channel || 'whatsapp',
            })
          );
    return this.handleSearchMessages({
      query: this.string(args, 'query'),
      chatId: args.target,
      account,
      platform: args.channel,
      from: args.from,
      to: args.to,
      sender: args.sender,
      limit: args.limit,
      mediaType,
    });
  }

  private async canonicalResolveTarget(args: Record<string, any>): Promise<any> {
    const channelName = this.channel(args);
    const accountIdValue = this.account(args);
    const query = this.string(args, 'query').toLowerCase();
    if (channelName === 'whatsapp' && this.readSource(args, 'index') === 'index') {
      const result = await this.handleSearchUsers({
        query: this.string(args, 'query'),
        account: accountIdValue,
        limit: args.limit,
      });
      const data = this.legacyResultData(result);
      const targets = extractArrayPayload(data, ['users']).flatMap(user => {
        const conversations = extractArrayPayload(user, ['conversations']);
        if (conversations.length) {
          return conversations.map(conversation => ({
            target: bareWhatsAppJid(pickString(conversation, ['waChatId', 'id'])),
            name: pickString(user, ['displayName', 'name']) || null,
            kind: pickString(conversation, ['type']).toLowerCase() === 'group' ? 'group' : 'user',
            raw: { user, conversation },
          }));
        }
        return [
          {
            target: pickString(user, ['waUserId', 'id']),
            name: pickString(user, ['displayName', 'name']) || null,
            kind: 'user',
            raw: user,
          },
        ];
      });
      return this.jsonResponse({ query: args.query, targets });
    }
    if (this.readSource(args, 'provider') === 'index') {
      throw this.canonicalError(
        'unsupported_capability',
        `${channelName} target resolution is only available from the provider`
      );
    }
    if (channelName === 'instagram') {
      return this.canonicalResolveInstagramTarget(
        accountIdValue,
        this.string(args, 'query'),
        Number(args.limit || 10)
      );
    }
    const listed = await this.listConversationsFor(channelName, accountIdValue, {
      ...args,
      readSource: 'provider',
      limit: Math.max(Number(args.limit || 10), 100),
    });
    const data = this.legacyResultData(listed);
    const candidates = extractArrayPayload(data, ['chats', 'dialogs', 'conversations', 'data'])
      .filter(item =>
        [
          pickString(item, ['id', 'chatId', 'peerId', 'conversationId']),
          pickString(item, ['name', 'title', 'username', 'displayName']),
        ]
          .join(' ')
          .toLowerCase()
          .includes(query)
      )
      .slice(0, args.limit || 10)
      .map(item => ({
        target: pickString(item, ['id', 'chatId', 'peerId', 'conversationId']),
        name: pickString(item, ['name', 'title', 'username', 'displayName']) || null,
        raw: item,
      }));
    return this.jsonResponse({ query: args.query, targets: candidates });
  }

  private async canonicalResolveInstagramTarget(
    accountIdValue: string,
    query: string,
    limit: number
  ): Promise<any> {
    const listed = await this.canonicalListConversations({
      channel: 'instagram',
      accountId: accountIdValue,
      query,
      limit,
      readSource: 'provider',
    });
    const conversations = extractArrayPayload(asObject(asObject(listed).__canonicalResult).data, [
      'conversations',
    ]);
    const targets = conversations
      .map(conversation => ({
        target: pickString(conversation, ['sendTarget']),
        name: pickString(conversation, ['name']) || null,
        handle: pickString(conversation, ['handle']) || null,
        kind: 'user',
        conversationId: pickString(conversation, ['target']) || null,
        raw: conversation,
      }))
      .filter(candidate => candidate.target)
      .slice(0, limit);
    return this.jsonResponse({ query, targets });
  }

  private async canonicalGetMedia(args: Record<string, any>): Promise<any> {
    const channelName = this.channel(args);
    if (this.readSource(args, 'provider') === 'index') {
      throw this.canonicalError(
        'unsupported_capability',
        'Media bytes are only available from providers'
      );
    }
    if (channelName === 'whatsapp') {
      return this.handleDownloadMedia({
        chatId: this.whatsAppProviderTarget(args),
        messageId: this.string(args, 'messageId'),
        account: this.account(args),
      });
    }
    if (channelName === 'telegram') {
      return this.handleTelegramDownloadMedia({
        chatId: this.target(args),
        messageId: this.string(args, 'messageId'),
        account: this.account(args),
      });
    }
    throw this.canonicalError(
      'unsupported_capability',
      'Instagram message-media retrieval is not implemented by the deployed connector; use social_list_content for published media'
    );
  }

  private async canonicalSummarize(args: Record<string, any>): Promise<any> {
    if (this.readSource(args, 'index') === 'provider') {
      throw this.canonicalError(
        'unsupported_capability',
        'Provider-side summarization is not supported; use readSource=index'
      );
    }
    const channelName = this.channel(args);
    if (channelName === 'instagram') {
      throw this.canonicalError(
        'unsupported_capability',
        'Instagram messages are not ingested into the local summary index'
      );
    }
    const account = normalizeAccount(this.account(args));
    switch (args.range || 'conversation') {
      case 'day':
        return this.handleSummarizeDay({
          date: this.string(args, 'date'),
          language: args.language,
          account,
          platform: channelName,
        });
      case 'week':
        return this.handleSummarizeWeek({
          weekStartDate: this.string(args, 'weekStart'),
          language: args.language,
          account,
          platform: channelName,
        });
    }
    const rawTarget = this.target(args);
    const chatId =
      channelName === 'whatsapp'
        ? accountKey(account, bareWhatsAppJid(rawTarget))
        : await this.resolveTelegramChatId(rawTarget, account);
    if (!chatId) {
      throw this.canonicalError(
        'not_found',
        `Conversation '${rawTarget}' was not found in the ${channelName} index for account '${account}'`
      );
    }
    if (args.range === 'context') {
      return this.handleGetContext({
        chatId,
        messageId: this.string(args, 'messageId'),
        windowBefore: args.lastN,
        windowAfter: args.lastN,
      });
    }
    return this.handleSummarizeChat({
      chatId,
      language: args.language,
    });
  }

  private async canonicalGetProfile(args: Record<string, any>): Promise<any> {
    const channelName = this.channel(args);
    if (this.readSource(args, 'provider') === 'index') {
      throw this.canonicalError(
        'unsupported_capability',
        'Provider profiles are not available from the local index'
      );
    }
    if (channelName === 'whatsapp') {
      return this.handleGetMe({ account: this.account(args) });
    }
    if (channelName === 'telegram') {
      return this.handleTelegramGetMe({ account: this.account(args) });
    }
    return this.handleInstagramGetProfile({ account: this.account(args) });
  }

  private assertDigestSelector(digest: Record<string, any>, args: Record<string, any>): void {
    const accountIdValue = this.account(args);
    const channelName = this.channel(args);
    if (digest.account !== accountIdValue) {
      throw this.canonicalError(
        'not_found',
        `Digest '${this.string(args, 'digestId')}' does not belong to account '${accountIdValue}'`
      );
    }
    const platforms = Array.isArray(digest.platforms) ? digest.platforms : [];
    if (!platforms.includes(channelName)) {
      throw this.canonicalError(
        'unsupported_capability',
        `Digest '${this.string(args, 'digestId')}' does not include channel '${channelName}'`
      );
    }
  }

  private async canonicalGetDigest(args: Record<string, any>): Promise<any> {
    const digest = await this.unreadDigestService.status(this.string(args, 'digestId'));
    this.assertDigestSelector(asObject(digest), args);
    return this.jsonResponse(digest);
  }

  private async canonicalContinueDigest(args: Record<string, any>): Promise<any> {
    const digestId = this.string(args, 'digestId');
    const before = await this.unreadDigestService.status(digestId);
    this.assertDigestSelector(asObject(before), args);
    return this.jsonResponse(
      await this.unreadDigestService.continue(digestId, clampInteger(args.batchSize, 5, 1, 10))
    );
  }

  private async canonicalListContent(args: Record<string, any>): Promise<any> {
    this.requireChannel(args, 'instagram');
    if (this.readSource(args, 'provider') === 'index') {
      throw this.canonicalError(
        'unsupported_capability',
        'Instagram content is not available from the local index'
      );
    }
    return args.kind === 'stories'
      ? this.handleInstagramGetStories({ account: this.account(args) })
      : this.handleInstagramGetMedia({ account: this.account(args), limit: args.limit });
  }

  private async canonicalGetInsights(args: Record<string, any>): Promise<any> {
    this.requireChannel(args, 'instagram');
    if (this.readSource(args, 'provider') === 'index') {
      throw this.canonicalError(
        'unsupported_capability',
        'Instagram insights are not available from the local index'
      );
    }
    if (args.kind === 'publishingLimit') {
      return this.handleInstagramGetContentPublishingLimit({
        account: this.account(args),
      });
    }
    if (args.kind === 'media') {
      return this.handleInstagramMediaInsights({
        account: this.account(args),
        mediaId: this.target(args),
      });
    }
    return this.handleInstagramGetAccountInsights({
      account: this.account(args),
      metrics: args.metrics,
      period: args.period,
    });
  }

  private async canonicalDiscoverBusiness(args: Record<string, any>): Promise<any> {
    this.requireChannel(args, 'instagram');
    if (this.readSource(args, 'provider') === 'index') {
      throw this.canonicalError(
        'unsupported_capability',
        'Instagram discovery is not available from the local index'
      );
    }
    if (args.kind === 'hashtag') {
      return this.handleInstagramSearchHashtag({
        account: this.account(args),
        hashtag: this.string(args, 'query'),
      });
    }
    if (args.kind === 'hashtagMedia') {
      return this.handleInstagramGetHashtagMedia({
        account: this.account(args),
        hashtagId: this.string(args, 'query'),
        limit: args.limit,
      });
    }
    return this.handleInstagramBusinessDiscovery({
      account: this.account(args),
      username: this.string(args, 'query'),
    });
  }

  private async canonicalValidateAccount(args: Record<string, any>): Promise<any> {
    const channelName = this.channel(args);
    if (this.readSource(args, 'provider') === 'index') {
      throw this.canonicalError(
        'unsupported_capability',
        'Account validation requires a provider query'
      );
    }
    if (channelName === 'whatsapp') {
      return this.handleGetConnectionStatus({ account: this.account(args) });
    }
    if (channelName === 'telegram') {
      return this.handleTelegramGetStatus({ account: this.account(args) });
    }
    return this.handleInstagramValidateAccessToken({ account: this.account(args) });
  }

  private async canonicalSendMessage(args: Record<string, any>): Promise<any> {
    const channelName = this.channel(args);
    const accountIdValue = this.account(args);
    const destination =
      channelName === 'whatsapp' ? this.whatsAppProviderTarget(args) : this.target(args);
    const message = typeof args.message === 'string' ? args.message : '';
    const attachments = Array.isArray(args.attachments) ? args.attachments : [];
    const mediaGroup = args.mediaGroup === true;

    if (args.template) {
      throw this.canonicalError(
        'unsupported_capability',
        channelName === 'whatsapp'
          ? 'WhatsApp templates are not supported by the deployed Baileys connectors'
          : `Templates are not supported for channel '${channelName}'`
      );
    }
    if (!message && !attachments.length) {
      throw this.canonicalError(
        'invalid_request',
        'message or at least one attachment is required'
      );
    }
    if (mediaGroup && channelName !== 'telegram') {
      throw this.canonicalError(
        'unsupported_capability',
        'Native media groups are only supported for Telegram'
      );
    }
    if (mediaGroup && (attachments.length < 2 || attachments.length > 10)) {
      throw this.canonicalError(
        'invalid_request',
        'A native Telegram image album requires between 2 and 10 attachments'
      );
    }
    if (
      mediaGroup &&
      attachments.some(item => {
        const mimeType = pickString(asObject(item), ['mimeType']);
        return mimeType && !mimeType.toLowerCase().startsWith('image/');
      })
    ) {
      throw this.canonicalError(
        'invalid_request',
        'Every attachment in a native Telegram image album must have an image/* mimeType'
      );
    }

    if (channelName === 'instagram') {
      if (attachments.length) {
        throw this.canonicalError(
          'unsupported_capability',
          'Instagram DM attachments are not supported by the deployed connector'
        );
      }
      if (args.replyTo !== null && args.replyTo !== undefined) {
        throw this.canonicalError(
          'unsupported_capability',
          'Instagram DM replies are not supported by the deployed connector'
        );
      }
      if (args.threadId !== null && args.threadId !== undefined) {
        throw this.canonicalError(
          'unsupported_capability',
          'Instagram DM threads are not supported by the deployed connector'
        );
      }
      return this.handleInstagramSendDm({
        account: accountIdValue,
        recipientId: destination,
        message,
      });
    }
    if (channelName === 'whatsapp' && args.threadId !== null && args.threadId !== undefined) {
      throw this.canonicalError(
        'unsupported_capability',
        'WhatsApp does not support Telegram threadId'
      );
    }
    if (
      channelName !== 'whatsapp' &&
      attachments.some(item => {
        const value = asObject(item);
        return value.viewOnce === true || value.hd === true;
      })
    ) {
      throw this.canonicalError(
        'unsupported_capability',
        'viewOnce and hd attachments are only supported for WhatsApp'
      );
    }

    const operations: unknown[] = [];
    try {
      if (mediaGroup) {
        const sent = await this.handleTelegramSendMediaGroup({
          chatId: destination,
          attachments: attachments.map((item, index) => {
            const attachmentValue = asObject(item);
            return {
              filePath: pickString(attachmentValue, ['url']),
              name: pickString(attachmentValue, ['name']) || undefined,
              mimeType: pickString(attachmentValue, ['mimeType']) || undefined,
              caption:
                index === 0
                  ? message || pickString(attachmentValue, ['caption']) || undefined
                  : undefined,
            };
          }),
          account: accountIdValue,
          replyTo: args.replyTo ?? undefined,
          threadId: args.threadId ?? undefined,
        });
        operations.push(this.legacyResultData(sent));
      } else if (message) {
        const sent =
          channelName === 'whatsapp'
            ? await this.handleSendMessage(
                {
                  chatId: destination,
                  text: message,
                  account: accountIdValue,
                  replyTo:
                    args.replyTo === null || args.replyTo === undefined
                      ? undefined
                      : String(args.replyTo),
                },
                ...this.connectorIdempotency(args, 'text')
              )
            : await this.handleTelegramSendMessage({
                chatId: destination,
                text: message,
                account: accountIdValue,
                topicId: args.threadId ?? undefined,
                replyTo: args.replyTo ?? undefined,
              });
        operations.push(this.legacyResultData(sent));
      }

      for (const [index, item] of (mediaGroup ? [] : attachments).entries()) {
        const attachmentValue = asObject(item);
        const location = pickString(attachmentValue, ['url']);
        const sent =
          channelName === 'whatsapp'
            ? await this.handleSendFile(
                {
                  conversationId: destination,
                  fileUrl: location,
                  caption: pickString(attachmentValue, ['caption']) || undefined,
                  // Additive: absent unless asked, so a plain attachment sends as before.
                  // The attachment's name is the document's name (QA 02-10: it was
                  // taken from the URL); the connector cleans it.
                  ...(pickString(attachmentValue, ['name'])
                    ? { fileName: pickString(attachmentValue, ['name']) }
                    : {}),
                  ...(attachmentValue.viewOnce === true ? { viewOnce: true } : {}),
                  ...(attachmentValue.hd === true ? { quality: 'hd' as const } : {}),
                  account: accountIdValue,
                  replyTo:
                    args.replyTo === null || args.replyTo === undefined
                      ? undefined
                      : String(args.replyTo),
                },
                ...this.connectorIdempotency(args, `attachment:${index}`)
              )
            : await this.handleTelegramSendFile({
                chatId: destination,
                filePath: location,
                caption: pickString(attachmentValue, ['caption']) || undefined,
                account: accountIdValue,
                replyTo: args.replyTo ?? undefined,
                threadId: args.threadId ?? undefined,
              });
        operations.push(this.legacyResultData(sent));
      }
    } catch (error) {
      if (operations.length) {
        throw this.canonicalError(
          'outcome_unknown',
          `Provider accepted ${operations.length} sub-operation(s) before a later send failed: ${safeError(
            error
          )}`
        );
      }
      throw error;
    }

    const providerMessageIds = operations
      .map(operation =>
        pickString(operation, ['providerMessageId', 'messageId', 'operationId', 'receiptId', 'id'])
      )
      .filter(Boolean);
    return this.jsonResponse({
      accepted: true,
      providerMessageId: providerMessageIds[0] || null,
      providerMessageIds,
      operations,
    });
  }

  /**
   * The connector-side Idempotency-Key of one WhatsApp sub-operation of a
   * canonical send (fase 3 / PR-2): the caller's idempotencyKey scoped like its
   * Redis record (tool, channel, account) plus the sub-operation, so the text
   * and each attachment of one call never share a key. [] without a key, so
   * the legacy handlers keep their one-argument call.
   */
  private connectorIdempotency(
    args: Record<string, any>,
    operation: string,
    toolName = 'social_send_message'
  ): [] | [{ idempotencyKey: string }] {
    const key = typeof args.idempotencyKey === 'string' ? args.idempotencyKey.trim() : '';
    if (!key) return [];
    const digest = createHash('sha256')
      .update(`${toolName}\0${args.channel}\0${args.accountId}\0${key}\0${operation}`)
      .digest('hex');
    return [{ idempotencyKey: `mcp-${digest}` }];
  }

  private async canonicalForwardMessage(args: Record<string, any>): Promise<any> {
    const channelName = this.channel(args);
    if (channelName === 'whatsapp') {
      return this.handleForwardMessage({
        chatId: this.whatsAppProviderTarget(args, 'fromTarget'),
        messageId: this.string(args, 'messageId'),
        toChatId: this.whatsAppProviderTarget(args),
        account: this.account(args),
      });
    }
    if (channelName === 'telegram') {
      return this.handleTelegramForwardMessage({
        fromChatId: this.string(args, 'fromTarget'),
        messageId: this.string(args, 'messageId'),
        toChatId: this.target(args),
        account: this.account(args),
        threadId: args.threadId ?? undefined,
      });
    }
    throw this.canonicalError(
      'unsupported_capability',
      'Instagram DM forwarding is not supported by the deployed connector'
    );
  }

  private async canonicalDeleteMessage(args: Record<string, any>): Promise<any> {
    const channelName = this.channel(args);
    const forMe = args.forMe === true;
    if (channelName === 'whatsapp') {
      return this.handleDeleteMessage({
        chatId: this.whatsAppProviderTarget(args),
        messageId: this.string(args, 'messageId'),
        account: this.account(args),
        forMe,
      });
    }
    if (forMe) {
      // The Telegram connector always revokes for everyone.
      throw this.canonicalError(
        'unsupported_capability',
        'Deleting a message only for this account (forMe) is only supported on WhatsApp'
      );
    }
    if (channelName === 'telegram') {
      return this.handleTelegramDeleteMessage({
        chatId: this.target(args),
        messageId: this.string(args, 'messageId'),
        account: this.account(args),
      });
    }
    throw this.canonicalError(
      'unsupported_capability',
      'Instagram DM deletion is not supported by the deployed connector'
    );
  }

  private async canonicalEditMessage(args: Record<string, any>): Promise<any> {
    const channelName = this.channel(args);
    if (channelName === 'whatsapp') {
      return this.handleEditMessage({
        chatId: this.whatsAppProviderTarget(args),
        messageId: this.string(args, 'messageId'),
        content: this.string(args, 'message'),
        account: this.account(args),
      });
    }
    if (channelName === 'telegram') {
      return this.handleTelegramEditMessage({
        chatId: this.target(args),
        messageId: this.string(args, 'messageId'),
        content: this.string(args, 'message'),
        account: this.account(args),
      });
    }
    throw this.canonicalError(
      'unsupported_capability',
      `Message editing is not supported by the deployed ${channelName} connector`
    );
  }

  // -------------------------------------------------------------------------
  // Fase 3 WhatsApp capabilities (reactions, chat state, groups, polls /
  // events, start chat, contacts, presence / privacy reads). Same pattern as
  // social_edit_message: ids bare inside the HMAC-signed body, namespaced ids
  // of another account refused, the connector applies ENABLE_SENDING and
  // answers {error, failureClass}, which whatsAppCall maps to canonical codes.
  // -------------------------------------------------------------------------

  private async canonicalReactMessage(args: Record<string, any>): Promise<any> {
    const channelName = this.channel(args);
    const emoji = typeof args.emoji === 'string' ? args.emoji : '';
    if (channelName === 'whatsapp') {
      const account = this.account(args);
      return this.jsonResponse(
        await this.whatsAppCall(account, 'POST', '/api/v1/messages/react', {
          conversationId: this.whatsAppProviderTarget(args),
          messageId: this.bareWhatsAppMessageId(this.string(args, 'messageId'), account),
          emoji,
        })
      );
    }
    if (channelName === 'telegram') {
      return this.handleTelegramReactMessage({
        chatId: this.target(args),
        messageId: this.string(args, 'messageId'),
        emoji,
        account: this.account(args),
      });
    }
    throw this.canonicalError(
      'unsupported_capability',
      'Reactions are not supported by the deployed instagram connector'
    );
  }

  private async canonicalSetChatState(args: Record<string, any>): Promise<any> {
    const { account, chatId } = this.whatsAppChat(args);
    const action = this.string(args, 'action');
    const mute =
      action === 'mute'
        ? {
            ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
            ...(args.muteUntil !== undefined ? { muteUntil: args.muteUntil } : {}),
          }
        : {};
    return this.jsonResponse(
      await this.whatsAppCall(account, 'POST', '/api/v1/chats/modify', {
        conversationId: chatId,
        action,
        ...mute,
        ...this.connectorActor(),
      })
    );
  }

  private async canonicalGetGroup(args: Record<string, any>): Promise<any> {
    this.providerOnlyRead(args, 'Group state');
    const { account, chatId } = this.whatsAppChat(args);
    return this.jsonResponse(
      await this.whatsAppCall(account, 'POST', '/api/v1/groups/state', {
        groupId: this.requireGroupJid(chatId),
      })
    );
  }

  private async canonicalManageGroup(args: Record<string, any>): Promise<any> {
    this.requireChannel(args, 'whatsapp');
    const account = this.account(args);
    const action = this.string(args, 'action');
    const participants = () =>
      (Array.isArray(args.participants) ? args.participants : []).map((value: unknown) =>
        this.whatsAppParticipant(value, account)
      );
    if (action === 'create') {
      return this.jsonResponse(
        await this.whatsAppCall(account, 'POST', '/api/v1/groups/create', {
          subject: this.string(args, 'subject'),
          participants: participants(),
          ...this.connectorActor(),
        })
      );
    }
    const groupId = this.requireGroupJid(this.whatsAppProviderTarget(args));
    if (action === 'update') {
      const settings = {
        ...(typeof args.announce === 'boolean' ? { announce: args.announce } : {}),
        ...(typeof args.restrict === 'boolean' ? { restrict: args.restrict } : {}),
      };
      return this.jsonResponse(
        await this.whatsAppCall(account, 'POST', '/api/v1/groups/update', {
          groupId,
          ...(typeof args.subject === 'string' ? { subject: args.subject } : {}),
          ...(typeof args.description === 'string' ? { description: args.description } : {}),
          ...(Object.keys(settings).length ? { settings } : {}),
          ...this.connectorActor(),
        })
      );
    }
    const participantAction: Record<string, string> = {
      addParticipants: 'add',
      removeParticipants: 'remove',
      promoteParticipants: 'promote',
      demoteParticipants: 'demote',
    };
    if (!participantAction[action]) {
      throw this.canonicalError('invalid_request', `Unknown group action '${action}'`);
    }
    return this.jsonResponse(
      await this.whatsAppCall(account, 'POST', '/api/v1/groups/participants', {
        groupId,
        action: participantAction[action],
        participants: participants(),
        ...this.connectorActor(),
      })
    );
  }

  /** Private "join group" cards for the people an add could not reach (inviteRequired). */
  private async canonicalInviteToGroup(args: Record<string, any>): Promise<any> {
    this.requireChannel(args, 'whatsapp');
    const account = this.account(args);
    const groupId = this.requireGroupJid(this.whatsAppProviderTarget(args));
    const participants = (Array.isArray(args.participants) ? args.participants : []).map(
      (value: unknown) => this.whatsAppParticipant(value, account)
    );
    return this.jsonResponse(
      await this.whatsAppCall(
        account,
        'POST',
        '/api/v1/groups/invite',
        {
          groupId,
          participants,
          ...(typeof args.text === 'string' ? { text: args.text } : {}),
          ...this.connectorActor(),
        },
        ...this.connectorIdempotency(args, 'group-invite', 'social_invite_to_group')
      )
    );
  }

  /** GET /communities: every community of the account, its groups and capabilities. */
  private async canonicalListCommunities(args: Record<string, any>): Promise<any> {
    this.providerOnlyRead(args, 'The community list');
    this.requireChannel(args, 'whatsapp');
    const account = this.account(args);
    return this.jsonResponse(await this.whatsAppCall(account, 'GET', '/api/v1/communities'));
  }

  private async canonicalGetCommunity(args: Record<string, any>): Promise<any> {
    this.providerOnlyRead(args, 'Community state');
    const { account, chatId } = this.whatsAppChat(args);
    return this.jsonResponse(
      await this.whatsAppCall(account, 'POST', '/api/v1/communities/state', {
        communityId: this.requireGroupJid(chatId),
      })
    );
  }

  /**
   * POST /communities/create | /communities/groups | /communities/leave. The
   * connector checks admin rights on fresh metadata and reads every change
   * back; leave passes the schema-forced confirm: true through.
   */
  private async canonicalManageCommunity(args: Record<string, any>): Promise<any> {
    this.requireChannel(args, 'whatsapp');
    const account = this.account(args);
    const action = this.string(args, 'action');
    if (action === 'create') {
      return this.jsonResponse(
        await this.whatsAppCall(account, 'POST', '/api/v1/communities/create', {
          subject: this.string(args, 'subject'),
          ...(typeof args.description === 'string' ? { description: args.description } : {}),
          ...this.connectorActor(),
        })
      );
    }
    const communityId = this.requireGroupJid(this.whatsAppProviderTarget(args));
    if (action === 'link' || action === 'unlink') {
      return this.jsonResponse(
        await this.whatsAppCall(account, 'POST', '/api/v1/communities/groups', {
          communityId,
          groupId: this.requireGroupJid(this.whatsAppProviderTarget(args, 'group')),
          action,
          ...this.connectorActor(),
        })
      );
    }
    if (action !== 'leave') {
      throw this.canonicalError('invalid_request', `Unknown community action '${action}'`);
    }
    if (args.confirm !== true) {
      throw this.canonicalError('invalid_request', 'confirm must be true to leave a community');
    }
    return this.jsonResponse(
      await this.whatsAppCall(account, 'POST', '/api/v1/communities/leave', {
        communityId,
        confirm: true,
        ...this.connectorActor(),
      })
    );
  }

  /** POST /channels/lookup: a channel by jid, share link or invite code. */
  private async canonicalLookupChannel(args: Record<string, any>): Promise<any> {
    this.providerOnlyRead(args, 'Channel look-up');
    const { account, chatId } = this.whatsAppChat(args);
    return this.jsonResponse(
      await this.whatsAppCall(account, 'POST', '/api/v1/channels/lookup', { channel: chatId })
    );
  }

  /** GET /channels: the followed ones among the channels the connector has seen. */
  private async canonicalListChannels(args: Record<string, any>): Promise<any> {
    this.providerOnlyRead(args, 'The followed channels');
    this.requireChannel(args, 'whatsapp');
    const account = this.account(args);
    return this.jsonResponse(await this.whatsAppCall(account, 'GET', '/api/v1/channels'));
  }

  private async canonicalManageChannelSubscription(args: Record<string, any>): Promise<any> {
    const { account, chatId } = this.whatsAppChat(args);
    if (!chatId.endsWith('@newsletter')) {
      throw this.canonicalError(
        'invalid_request',
        'target must be a WhatsApp channel (…@newsletter); social_lookup_channel resolves a link'
      );
    }
    return this.jsonResponse(
      await this.whatsAppCall(account, 'POST', '/api/v1/channels/subscription', {
        channelId: chatId,
        action: this.string(args, 'action'),
        ...this.connectorActor(),
      })
    );
  }

  private async canonicalSendPoll(args: Record<string, any>): Promise<any> {
    const { account, chatId } = this.whatsAppChat(args);
    return this.jsonResponse(
      await this.whatsAppCall(
        account,
        'POST',
        '/api/v1/messages/poll',
        {
          conversationId: chatId,
          name: this.string(args, 'question'),
          options: args.options,
          ...(args.selectableCount !== undefined ? { selectableCount: args.selectableCount } : {}),
          ...this.connectorActor(),
        },
        ...this.connectorIdempotency(args, 'poll', 'social_send_poll')
      )
    );
  }

  private async canonicalVotePoll(args: Record<string, any>): Promise<any> {
    const { account, chatId } = this.whatsAppChat(args);
    return this.jsonResponse(
      await this.whatsAppCall(
        account,
        'POST',
        '/api/v1/messages/poll/vote',
        {
          conversationId: chatId,
          messageId: this.bareWhatsAppMessageId(this.string(args, 'messageId'), account),
          options: Array.isArray(args.options) ? args.options : [],
          ...this.connectorActor(),
        },
        ...this.connectorIdempotency(args, 'poll-vote', 'social_vote_poll')
      )
    );
  }

  /** Optional chat of a message action: bare, never another account's (undefined when absent). */
  private optionalWhatsAppTarget(args: Record<string, any>): { conversationId?: string } {
    return args.target === undefined ? {} : { conversationId: this.whatsAppProviderTarget(args) };
  }

  private async canonicalStarMessage(args: Record<string, any>): Promise<any> {
    this.requireChannel(args, 'whatsapp');
    const account = this.account(args);
    if (typeof args.star !== 'boolean') {
      throw this.canonicalError('invalid_request', 'star is required and must be a boolean');
    }
    return this.jsonResponse(
      await this.whatsAppCall(account, 'POST', '/api/v1/messages/star', {
        ...this.optionalWhatsAppTarget(args),
        messageId: this.bareWhatsAppMessageId(this.string(args, 'messageId'), account),
        star: args.star,
        ...this.connectorActor(),
      })
    );
  }

  private async canonicalPinMessage(args: Record<string, any>): Promise<any> {
    this.requireChannel(args, 'whatsapp');
    const account = this.account(args);
    if (typeof args.pin !== 'boolean') {
      throw this.canonicalError('invalid_request', 'pin is required and must be a boolean');
    }
    if (!args.pin && args.durationSeconds !== undefined) {
      throw this.canonicalError('invalid_request', 'durationSeconds is only for a pin');
    }
    return this.jsonResponse(
      await this.whatsAppCall(
        account,
        'POST',
        '/api/v1/messages/pin',
        {
          ...this.optionalWhatsAppTarget(args),
          messageId: this.bareWhatsAppMessageId(this.string(args, 'messageId'), account),
          pin: args.pin,
          ...(args.pin && args.durationSeconds !== undefined
            ? { durationSeconds: args.durationSeconds }
            : {}),
          ...this.connectorActor(),
        },
        ...this.connectorIdempotency(args, 'pin', 'social_pin_message')
      )
    );
  }

  private async canonicalListPinned(args: Record<string, any>): Promise<any> {
    this.providerOnlyRead(args, 'Pinned messages');
    const { account, chatId } = this.whatsAppChat(args);
    return this.jsonResponse(
      await this.whatsAppCall(account, 'POST', '/api/v1/messages/pins', { conversationId: chatId })
    );
  }

  private async canonicalListStarred(args: Record<string, any>): Promise<any> {
    this.providerOnlyRead(args, 'Starred messages');
    this.requireChannel(args, 'whatsapp');
    const account = this.account(args);
    return this.jsonResponse(
      await this.whatsAppCall(account, 'POST', '/api/v1/messages/starred', {
        ...this.optionalWhatsAppTarget(args),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(typeof args.cursor === 'string' && args.cursor.trim()
          ? { cursor: args.cursor.trim() }
          : {}),
      })
    );
  }

  /** Optional `cursor` / `limit` of a paged connector list. */
  private pageArgs(args: Record<string, any>): Record<string, unknown> {
    return {
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(typeof args.cursor === 'string' && args.cursor.trim()
        ? { cursor: args.cursor.trim() }
        : {}),
    };
  }

  /** POST /statuses: the account's statuses, optionally of one contact (bare, never another account's). */
  private async canonicalListStatuses(args: Record<string, any>): Promise<any> {
    this.providerOnlyRead(args, 'Statuses');
    this.requireChannel(args, 'whatsapp');
    const account = this.account(args);
    const contact =
      args.contact === undefined ? undefined : this.whatsAppParticipant(args.contact, account);
    return this.jsonResponse(
      await this.whatsAppCall(account, 'POST', '/api/v1/statuses', {
        ...(contact ? { contact } : {}),
        ...(typeof args.includeExpired === 'boolean'
          ? { includeExpired: args.includeExpired }
          : {}),
        ...(typeof args.includeOwn === 'boolean' ? { includeOwn: args.includeOwn } : {}),
        ...this.pageArgs(args),
      })
    );
  }

  private async canonicalListChannelPosts(args: Record<string, any>): Promise<any> {
    this.providerOnlyRead(args, 'Channel posts');
    this.requireChannel(args, 'whatsapp');
    const account = this.account(args);
    let channelId: string | undefined;
    if (args.target !== undefined) {
      channelId = this.whatsAppProviderTarget(args);
      if (!/^\d+@newsletter$/.test(channelId)) {
        throw this.canonicalError(
          'invalid_request',
          'target must be a WhatsApp channel (…@newsletter)'
        );
      }
    }
    return this.jsonResponse(
      await this.whatsAppCall(account, 'POST', '/api/v1/channels/posts', {
        ...(channelId ? { channelId } : {}),
        ...this.pageArgs(args),
      })
    );
  }

  /**
   * POST /statuses/publish: confirm: true and an explicit audience are forced
   * by the schema and passed through (the connector refuses without them, and
   * answers 403 status_publish_disabled unless WA_STATUS_PUBLISH_ENABLED).
   * Recipients are bare; one namespaced to another account is refused.
   */
  private async canonicalPublishStatus(args: Record<string, any>): Promise<any> {
    this.requireChannel(args, 'whatsapp');
    const account = this.account(args);
    if (args.confirm !== true) {
      throw this.canonicalError('invalid_request', 'confirm must be true');
    }
    if (!Array.isArray(args.recipients) || args.recipients.length === 0) {
      throw this.canonicalError('invalid_request', 'recipients must be a non-empty array');
    }
    const type = this.string(args, 'type');
    const optional = (field: string) => (args[field] !== undefined ? { [field]: args[field] } : {});
    return this.jsonResponse(
      await this.whatsAppCall(
        account,
        'POST',
        '/api/v1/statuses/publish',
        {
          type,
          ...optional('text'),
          ...optional('url'),
          ...optional('backgroundColor'),
          ...optional('font'),
          recipients: args.recipients.map((recipient: unknown) =>
            this.whatsAppParticipant(recipient, account)
          ),
          confirm: true,
          ...this.connectorActor(),
        },
        ...this.connectorIdempotency(args, 'status', 'social_publish_status')
      )
    );
  }

  private async canonicalGetPollResults(args: Record<string, any>): Promise<any> {
    this.providerOnlyRead(args, 'Poll results');
    const { account, chatId } = this.whatsAppChat(args);
    return this.jsonResponse(
      await this.whatsAppCall(account, 'POST', '/api/v1/messages/poll/results', {
        conversationId: chatId,
        messageId: this.bareWhatsAppMessageId(this.string(args, 'messageId'), account),
      })
    );
  }

  private async canonicalSendEvent(args: Record<string, any>): Promise<any> {
    const { account, chatId } = this.whatsAppChat(args);
    const optional = (field: string) => (args[field] !== undefined ? { [field]: args[field] } : {});
    return this.jsonResponse(
      await this.whatsAppCall(
        account,
        'POST',
        '/api/v1/messages/event',
        {
          conversationId: chatId,
          name: this.string(args, 'name'),
          startTime: this.string(args, 'startTime'),
          ...optional('description'),
          ...optional('endTime'),
          ...optional('location'),
          ...optional('call'),
          ...optional('extraGuestsAllowed'),
          ...this.connectorActor(),
        },
        ...this.connectorIdempotency(args, 'event', 'social_send_event')
      )
    );
  }

  private async canonicalRespondEvent(args: Record<string, any>): Promise<any> {
    const { account, chatId } = this.whatsAppChat(args);
    return this.jsonResponse(
      await this.whatsAppCall(
        account,
        'POST',
        '/api/v1/messages/event/respond',
        {
          conversationId: chatId,
          messageId: this.bareWhatsAppMessageId(this.string(args, 'messageId'), account),
          response: this.string(args, 'response'),
          ...(args.extraGuestCount !== undefined ? { extraGuestCount: args.extraGuestCount } : {}),
          ...this.connectorActor(),
        },
        ...this.connectorIdempotency(args, 'event-response', 'social_respond_event')
      )
    );
  }

  private async canonicalGetEventResults(args: Record<string, any>): Promise<any> {
    this.providerOnlyRead(args, 'Event results');
    const { account, chatId } = this.whatsAppChat(args);
    return this.jsonResponse(
      await this.whatsAppCall(account, 'POST', '/api/v1/messages/event/results', {
        conversationId: chatId,
        messageId: this.bareWhatsAppMessageId(this.string(args, 'messageId'), account),
      })
    );
  }

  /**
   * POST /chats/start: the connector resolves the number (gated: bulk lookups
   * get accounts restricted), returns the canonical conversation and, with a
   * message, sends it through the normal send path. account_restricted comes
   * back with a wa.me link a human can open to send by hand.
   */
  private async canonicalStartChat(args: Record<string, any>): Promise<any> {
    this.requireChannel(args, 'whatsapp');
    const account = this.account(args);
    const phone = this.string(args, 'phone');
    const message = typeof args.message === 'string' ? args.message : undefined;
    try {
      return this.jsonResponse(
        await this.whatsAppCall(
          account,
          'POST',
          '/api/v1/chats/start',
          { phone, ...(message ? { message } : {}), ...this.connectorActor() },
          ...(message ? this.connectorIdempotency(args, 'start-chat', 'social_start_chat') : [])
        )
      );
    } catch (error) {
      const failure = error as Error & { canonicalCode?: string; canonicalDetails?: unknown };
      if (failure.canonicalCode !== 'account_restricted') throw error;
      const details = asObject(failure.canonicalDetails);
      const jid = normalizeDirectWhatsAppJid(phone);
      const manualOpenUrl =
        asObject(details.fallback).manualOpenUrl ||
        (jid ? manualWhatsAppOpenUrl(jid, message) : undefined);
      if (!manualOpenUrl) throw error;
      throw this.canonicalError(
        'account_restricted',
        `${failure.message} Manual fallback: open ${manualOpenUrl} in the official WhatsApp app/Web session and press send manually.`,
        { ...details, fallback: { ...asObject(details.fallback), manualOpenUrl } }
      );
    }
  }

  private async canonicalShareContact(args: Record<string, any>): Promise<any> {
    const { account, chatId } = this.whatsAppChat(args);
    return this.jsonResponse(
      await this.whatsAppCall(
        account,
        'POST',
        '/api/v1/contacts/share',
        { conversationId: chatId, contacts: args.contacts, ...this.connectorActor() },
        ...this.connectorIdempotency(args, 'contact-share', 'social_share_contact')
      )
    );
  }

  private async canonicalListContacts(args: Record<string, any>): Promise<any> {
    this.requireChannel(args, 'whatsapp');
    if (this.readSource(args, 'index') === 'provider') {
      throw this.canonicalError(
        'unsupported_capability',
        'WhatsApp contacts are only available from the local index'
      );
    }
    const account = this.account(args);
    const query = new URLSearchParams();
    if (typeof args.query === 'string' && args.query.trim()) query.set('q', args.query.trim());
    query.set('limit', String(clampInteger(args.limit, 50, 1, 500)));
    return this.jsonResponse(
      await this.whatsAppCall(account, 'GET', `/api/v1/contacts?${query.toString()}`)
    );
  }

  private async canonicalGetPresence(args: Record<string, any>): Promise<any> {
    this.providerOnlyRead(args, 'Presence');
    const { account, chatId } = this.whatsAppChat(args);
    return this.jsonResponse(
      await this.whatsAppCall(account, 'POST', '/api/v1/chats/presence/read', {
        conversationId: chatId,
        ...(typeof args.participant === 'string'
          ? { participant: this.whatsAppParticipant(args.participant, account) }
          : {}),
      })
    );
  }

  private async canonicalGetPrivacy(args: Record<string, any>): Promise<any> {
    this.providerOnlyRead(args, 'Privacy settings');
    this.requireChannel(args, 'whatsapp');
    const account = this.account(args);
    const chatId = args.target === undefined ? undefined : this.whatsAppProviderTarget(args);
    const privacy = await this.whatsAppCall(account, 'GET', '/api/v1/privacy');
    const disappearing = chatId
      ? await this.whatsAppCall(account, 'POST', '/api/v1/chats/disappearing/read', {
          conversationId: chatId,
        })
      : undefined;
    return this.jsonResponse({
      ...asObject(privacy),
      ...(disappearing ? asObject(disappearing) : {}),
    });
  }

  /**
   * POST /contacts/block: exactly one of target (the 1:1 conversation) or
   * phone; confirm: true is forced by the schema and passed through (the
   * connector refuses without it). The connector re-reads the blocklist as
   * proof; changed: false = already so.
   */
  private async canonicalBlockContact(args: Record<string, any>): Promise<any> {
    this.requireChannel(args, 'whatsapp');
    const account = this.account(args);
    const hasTarget = typeof args.target === 'string' && args.target.trim() !== '';
    const hasPhone = typeof args.phone === 'string' && args.phone.trim() !== '';
    if (hasTarget === hasPhone) {
      throw this.canonicalError('invalid_request', 'Provide exactly one of target or phone');
    }
    if (args.confirm !== true) {
      throw this.canonicalError('invalid_request', 'confirm must be true');
    }
    return this.jsonResponse(
      await this.whatsAppCall(account, 'POST', '/api/v1/contacts/block', {
        ...(hasTarget
          ? { conversationId: this.whatsAppProviderTarget(args) }
          : { phone: args.phone.trim() }),
        action: this.string(args, 'action'),
        confirm: true,
        ...this.connectorActor(),
      })
    );
  }

  private async canonicalListBlocked(args: Record<string, any>): Promise<any> {
    this.providerOnlyRead(args, 'The blocklist');
    this.requireChannel(args, 'whatsapp');
    const account = this.account(args);
    return this.jsonResponse(
      await this.whatsAppCall(
        account,
        'GET',
        `/api/v1/contacts/blocklist${args.fresh === true ? '?fresh=1' : ''}`
      )
    );
  }

  /**
   * POST /privacy: one account-wide setting per call (every contact, every
   * device). confirm: true is forced by the schema and passed through (the
   * connector refuses without it); the connector reads the current value
   * first and does not re-send an equal one (changed: false).
   */
  private async canonicalSetPrivacy(args: Record<string, any>): Promise<any> {
    this.requireChannel(args, 'whatsapp');
    const account = this.account(args);
    if (args.confirm !== true) {
      throw this.canonicalError('invalid_request', 'confirm must be true');
    }
    return this.jsonResponse(
      await this.whatsAppCall(account, 'POST', '/api/v1/privacy', {
        setting: this.string(args, 'setting'),
        value: args.value,
        confirm: true,
        ...this.connectorActor(),
      })
    );
  }

  /** GET /profile/me: the account's own name, about, photo and what can change. */
  private async canonicalGetMyProfile(args: Record<string, any>): Promise<any> {
    this.providerOnlyRead(args, 'The own profile');
    this.requireChannel(args, 'whatsapp');
    return this.jsonResponse(
      await this.whatsAppCall(this.account(args), 'GET', '/api/v1/profile/me')
    );
  }

  /**
   * POST /profile/me (name / about), then POST /profile/me/photo (photoUrl,
   * fetched by the connector) or /profile/me/photo/remove. confirm: true is
   * forced by the schema and passed through (the connector refuses without
   * it). Name and about go in one call; when a later photo step fails after
   * them, the answer is outcome_unknown naming what was already applied.
   */
  private async canonicalUpdateMyProfile(args: Record<string, any>): Promise<any> {
    this.requireChannel(args, 'whatsapp');
    const account = this.account(args);
    if (args.confirm !== true) {
      throw this.canonicalError('invalid_request', 'confirm must be true');
    }
    const fields: Record<string, string> = {};
    if (typeof args.name === 'string') fields.name = args.name;
    if (typeof args.about === 'string') fields.about = args.about;
    const photoUrl = typeof args.photoUrl === 'string' ? args.photoUrl.trim() : '';
    const removePhoto = args.removePhoto === true;
    if (photoUrl && removePhoto) {
      throw this.canonicalError('invalid_request', 'Provide photoUrl or removePhoto, not both');
    }
    if (!Object.keys(fields).length && !photoUrl && !removePhoto) {
      throw this.canonicalError(
        'invalid_request',
        'Provide at least one of name, about, photoUrl or removePhoto'
      );
    }
    const result: Record<string, unknown> = {};
    if (Object.keys(fields).length) {
      result.profile = await this.whatsAppCall(account, 'POST', '/api/v1/profile/me', {
        ...fields,
        confirm: true,
        ...this.connectorActor(),
      });
    }
    if (photoUrl || removePhoto) {
      try {
        result.photo = photoUrl
          ? await this.whatsAppCall(account, 'POST', '/api/v1/profile/me/photo', {
              fileUrl: photoUrl,
              confirm: true,
              ...this.connectorActor(),
            })
          : await this.whatsAppCall(account, 'POST', '/api/v1/profile/me/photo/remove', {
              confirm: true,
              ...this.connectorActor(),
            });
      } catch (error) {
        if (result.profile) {
          throw this.canonicalError(
            'outcome_unknown',
            `WhatsApp accepted ${Object.keys(fields).join(' and ')} but the photo change failed: ${safeError(
              error
            )}`
          );
        }
        throw error;
      }
    }
    return this.jsonResponse({ updated: true, ...result });
  }

  private async canonicalSetDisappearing(args: Record<string, any>): Promise<any> {
    const { account, chatId } = this.whatsAppChat(args);
    return this.jsonResponse(
      await this.whatsAppCall(account, 'POST', '/api/v1/chats/disappearing', {
        conversationId: chatId,
        expiration: args.expiration,
        ...this.connectorActor(),
      })
    );
  }

  /**
   * Our typing indicator in ONE chat (POST /chats/presence with a chat-state).
   * Never unavailable / available: those are account-wide, and available
   * silences the phone's notifications.
   */
  private async canonicalSendTyping(args: Record<string, any>): Promise<any> {
    const { account, chatId } = this.whatsAppChat(args);
    const state = this.string(args, 'state');
    if (!['composing', 'recording', 'paused'].includes(state)) {
      throw this.canonicalError('invalid_request', 'state must be composing, recording or paused');
    }
    return this.jsonResponse(
      await this.whatsAppCall(account, 'POST', '/api/v1/chats/presence', {
        conversationId: chatId,
        state,
        ...this.connectorActor(),
      })
    );
  }

  /** WhatsApp: POST /messages/sticker. Telegram: its media send with sticker: true. */
  private async canonicalSendSticker(args: Record<string, any>): Promise<any> {
    const channelName = this.channel(args);
    if (channelName === 'whatsapp') return this.whatsAppStickerOrGif('sticker', args);
    if (channelName !== 'telegram') {
      throw this.canonicalError(
        'unsupported_capability',
        `Stickers are not supported by the deployed ${channelName} connector`
      );
    }
    const account = normalizeAccount(this.account(args));
    const target = stripAccount(this.target(args));
    if (target.account !== 'personal' && target.account !== account) {
      throw this.canonicalError(
        'invalid_request',
        `target belongs to the ${target.account} Telegram namespace but accountId is '${account}'`
      );
    }
    const { chatId, topicId } = this.telegramTopicTarget(
      this.target(args),
      args.threadId ?? undefined
    );
    const replyTo =
      args.replyTo === undefined || args.replyTo === null
        ? undefined
        : this.telegramMessageNumber(String(args.replyTo), chatId, account);
    return this.jsonResponse(
      await this.classifiedConnectorCall(
        this.tgUrl(args.accountId),
        'POST',
        '/api/v1/messages/media/send',
        {
          chatId,
          filePath: this.string(args, 'fileUrl'),
          sticker: true,
          ...(replyTo ? { replyTo } : {}),
          ...(topicId ? { threadId: topicId } : {}),
        }
      )
    );
  }

  /**
   * POST /messages/sticker | /messages/gif: the connector fetches fileUrl,
   * checks its bytes (WebP ≤ 1 MiB / MP4 ≤ 16 MiB, nothing converted) and
   * takes the caller's idempotencyKey, scoped to the tool, as Idempotency-Key.
   */
  private async whatsAppStickerOrGif(
    kind: 'sticker' | 'gif',
    args: Record<string, any>
  ): Promise<any> {
    const { account, chatId } = this.whatsAppChat(args);
    if (args.threadId !== undefined && args.threadId !== null) {
      throw this.canonicalError(
        'unsupported_capability',
        'WhatsApp does not support Telegram threadId'
      );
    }
    const replyTo =
      args.replyTo === undefined || args.replyTo === null
        ? undefined
        : this.bareWhatsAppMessageId(String(args.replyTo), account);
    return this.jsonResponse(
      await this.whatsAppCall(
        account,
        'POST',
        `/api/v1/messages/${kind}`,
        {
          conversationId: chatId,
          fileUrl: this.string(args, 'fileUrl'),
          ...(typeof args.caption === 'string' && args.caption.trim()
            ? { caption: args.caption }
            : {}),
          ...(replyTo ? { replyTo } : {}),
          ...this.connectorActor(),
        },
        ...this.connectorIdempotency(args, kind, `social_send_${kind}`)
      )
    );
  }

  /** WhatsApp account + bare chat jid of a canonical call (another account's target refused). */
  private whatsAppChat(args: Record<string, any>): { account: string; chatId: string } {
    const chatId = this.whatsAppProviderTarget(args);
    return { account: this.account(args), chatId };
  }

  private requireGroupJid(chatId: string): string {
    if (!chatId.endsWith('@g.us')) {
      throw this.canonicalError('invalid_request', `target must be a WhatsApp group (…@g.us)`);
    }
    return chatId;
  }

  /** Participant phone / jid, bare; one namespaced to another account is refused. */
  private whatsAppParticipant(value: unknown, accountArg: string): string {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) throw this.canonicalError('invalid_request', 'participants must be strings');
    const account = normalizeAccount(accountArg);
    const parsed = stripAccount(raw);
    if (parsed.account !== 'personal' && parsed.account !== account) {
      throw this.canonicalError(
        'invalid_request',
        `participant ${raw} belongs to the ${parsed.account} WhatsApp namespace but accountId is '${account}'`
      );
    }
    return parsed.id;
  }

  /** These reads only exist at the provider (the connector); readSource=index is unsupported. */
  private providerOnlyRead(args: Record<string, any>, what: string): void {
    if (this.readSource(args, 'provider') === 'index') {
      throw this.canonicalError(
        'unsupported_capability',
        `${what} is only available from the provider`
      );
    }
  }

  /**
   * connectorCall to the account's WhatsApp connector, with its `{error,
   * failureClass}` answers mapped to canonical codes: invalid_request stays,
   * idempotency_key_reused → conflict, send_outcome_uncertain →
   * outcome_unknown, a route the deployed connector lacks (404 without
   * failureClass) → unsupported_capability, any other failureClass
   * (disabled_sending, disconnected, not_group_admin, not_on_whatsapp,
   * account_restricted, rejected_by_whatsapp, message_unavailable…) is the
   * code itself. The connector payload travels as error.details. Timeouts are
   * rethrown untouched (outcome_unknown via errorCode).
   */
  private async whatsAppCall(
    account: string,
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    idempotency?: { idempotencyKey: string }
  ): Promise<any> {
    return this.classifiedConnectorCall(this.waUrl(account), method, path, body, idempotency);
  }

  /** whatsAppCall's error mapping for any connector (the Telegram edit / delete answer the same shape). */
  private async classifiedConnectorCall(
    baseUrl: string,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
    idempotency?: { idempotencyKey: string }
  ): Promise<any> {
    try {
      return idempotency
        ? await this.connectorCall(baseUrl, method, path, body, undefined, {
            'Idempotency-Key': idempotency.idempotencyKey,
          })
        : await this.connectorCall(baseUrl, method, path, body);
    } catch (error) {
      const match = /^Connector error (\d{3}): ([\s\S]*)$/.exec(safeError(error));
      if (!match) throw error;
      const status = Number(match[1]);
      let payload: Record<string, any>;
      try {
        payload = asObject(JSON.parse(match[2]));
      } catch {
        payload = {};
      }
      const failureClass = typeof payload.failureClass === 'string' ? payload.failureClass : '';
      const code =
        failureClass === 'invalid_request' || (!failureClass && status === 400)
          ? 'invalid_request'
          : failureClass === 'idempotency_key_reused'
            ? 'conflict'
            : failureClass === 'send_outcome_uncertain'
              ? 'outcome_unknown'
              : !failureClass && status === 404
                ? 'unsupported_capability'
                : failureClass || 'provider_error';
      throw this.canonicalError(code, safeError(error), { status, ...payload });
    }
  }

  private async canonicalMarkRead(args: Record<string, any>): Promise<any> {
    const channelName = this.channel(args);
    if (channelName === 'whatsapp') {
      return this.handleMarkAsRead({
        chatId: this.whatsAppProviderTarget(args),
        messageId: args.messageId,
        account: this.account(args),
      });
    }
    if (channelName === 'telegram') {
      return this.handleTelegramMarkAsRead({
        chatId: this.target(args),
        account: this.account(args),
      });
    }
    throw this.canonicalError(
      'unsupported_capability',
      'Instagram read-state mutation is not supported by the deployed connector'
    );
  }

  private async canonicalManageSession(args: Record<string, any>): Promise<any> {
    if (this.channel(args) === 'instagram') {
      const action = this.string(args, 'action');
      if (action !== 'startPairing') {
        throw this.canonicalError(
          'invalid_request',
          "for channel 'instagram', action must be 'startPairing'"
        );
      }
      return this.handleInstagramStartPairing();
    }
    this.requireChannel(args, 'whatsapp');
    switch (this.string(args, 'action')) {
      case 'renewQr':
        return this.handleRenewQRCode({
          account: this.account(args),
          confirmDisconnect: args.confirmDisconnect,
        });
      case 'repairGroup':
        return this.handleRepairGroupSession({
          groupId: this.target(args),
          account: this.account(args),
        });
      default:
        throw this.canonicalError('invalid_request', "action must be 'renewQr' or 'repairGroup'");
    }
  }

  /**
   * SC-1194 P1 (criterion 2): Instagram pairing over the existing session
   * surface. The authorize link is returned as tool output — chat.e-dani.com
   * renders it as text, the same way the WhatsApp flow already hands out its
   * QR page link — so no new screen is needed (epic gate C5). The connector
   * owns the OAuth app config; this call only needs the verified actor, which
   * instagramCall forwards as x-user-sub (SC-705 pattern).
   */
  private async handleInstagramStartPairing(): Promise<any> {
    const actor = getRequestActor();
    if (!actor.sub) {
      throw this.canonicalError(
        'invalid_request',
        'Instagram pairing requires a verified user: this call carries no x-user-sub. Start it from your own chat.e-dani.com conversation.'
      );
    }
    const data = asObject(await this.instagramCall('GET', '/api/v1/oauth/instagram/authorize-url'));
    return this.jsonResponse({
      action: 'startPairing',
      channel: 'instagram',
      pairingUrl: data.url,
      scopes: data.scopes,
      linkExpiresInSec: data.stateExpiresInSec,
      instructions:
        'Open this link, log in with your Instagram professional account and approve. The credential is stored encrypted under YOUR user id; afterwards the MCP serves only your own accounts. To pair a second account, run this again.',
    });
  }

  private async canonicalClickInteraction(args: Record<string, any>): Promise<any> {
    this.requireChannel(args, 'telegram');
    // Either form identifies the button; dataB64 is the lossless one and wins
    // for bots with binary callback payloads.
    const dataB64 = typeof args.dataB64 === 'string' ? args.dataB64 : undefined;
    if (dataB64 === undefined && typeof args.data !== 'string') {
      throw this.canonicalError('invalid_request', "Provide either 'data' or 'dataB64'");
    }
    return this.handleTelegramClickButton({
      chatId: this.target(args),
      messageId: args.messageId,
      data: typeof args.data === 'string' ? args.data : '',
      dataB64,
      account: this.account(args),
    });
  }

  private async canonicalManageForum(args: Record<string, any>): Promise<any> {
    this.requireChannel(args, 'telegram');
    const action = this.string(args, 'action');
    const common = {
      chatId: typeof args.target === 'string' ? args.target : '',
      account: this.account(args),
      topicId: args.threadId,
    };
    switch (action) {
      case 'createTopic':
        return this.handleTelegramCreateTopic({
          ...common,
          title: this.string(args, 'title'),
          icon: args.icon,
        });
      case 'editTopic':
        return this.handleTelegramEditTopic({
          ...common,
          title: args.title,
          hidden: args.hidden,
          clearIcon: args.clearIcon,
        });
      case 'closeTopic':
      case 'reopenTopic':
        return this.handleTelegramToggleTopicClosed({
          ...common,
          closed: action === 'closeTopic',
        });
      case 'pinTopic':
      case 'unpinTopic':
        return this.handleTelegramToggleTopicPinned({
          ...common,
          pinned: action === 'pinTopic',
        });
      case 'deleteTopic':
        return this.handleTelegramDeleteTopic(common);
      case 'createGroup':
        return this.connectorCall(this.tgUrl(common.account), 'POST', '/api/v1/groups', {
          title: this.string(args, 'title'),
          type: args.groupType || 'supergroup',
          description: args.description,
          forum: args.forum === true,
          members: Array.isArray(args.members) ? args.members : [],
        }).then(data => this.jsonResponse(data));
      case 'addMembers':
        if (!Array.isArray(args.members) || !args.members.length) {
          throw this.canonicalError(
            'invalid_request',
            'members must contain at least one Telegram peer'
          );
        }
        return this.connectorCall(
          this.tgUrl(common.account),
          'POST',
          `/api/v1/chats/${encodeURIComponent(this.target(args))}/members`,
          { members: args.members, forwardCount: args.forwardCount }
        ).then(data => this.jsonResponse(data));
      case 'setAdminPermissions':
        return this.connectorCall(
          this.tgUrl(common.account),
          'PUT',
          `/api/v1/chats/${encodeURIComponent(this.target(args))}/admins/${encodeURIComponent(
            String(args.userId)
          )}`,
          {
            rights: isObject(args.rights) ? args.rights : {},
            rank: args.rank,
          }
        ).then(data => this.jsonResponse(data));
      default:
        throw this.canonicalError('invalid_request', `Unsupported forum action '${action}'`);
    }
  }

  private async canonicalManageChat(args: Record<string, any>): Promise<any> {
    this.requireChannel(args, 'telegram');
    const action = this.string(args, 'action');
    const common = { chatId: this.target(args), account: this.account(args) };
    switch (action) {
      case 'setTitle':
        return this.handleTelegramSetChatTitle({
          ...common,
          title: this.string(args, 'title'),
        });
      case 'setDescription':
        return this.handleTelegramSetChatDescription({
          ...common,
          description: String(args.description),
        });
      case 'setPhoto':
        return this.handleTelegramSetChatPhoto({
          ...common,
          filePath: this.string(args, 'mediaUrl'),
        });
      case 'setForumEnabled':
        return this.handleTelegramUpdateForumSettings({
          ...common,
          isForum: args.enabled,
        });
      default:
        throw this.canonicalError('invalid_request', `Unsupported chat action '${action}'`);
    }
  }

  private async canonicalPublishContent(args: Record<string, any>): Promise<any> {
    this.requireChannel(args, 'instagram');
    const accountIdValue = this.account(args);
    switch (this.string(args, 'kind')) {
      case 'image':
        return this.handleInstagramPublish({
          account: accountIdValue,
          imageUrl: this.string(args, 'imageUrl'),
          caption: typeof args.caption === 'string' ? args.caption : '',
        });
      case 'carousel':
        if (!Array.isArray(args.items) || args.items.length < 2) {
          throw this.canonicalError(
            'invalid_request',
            'A carousel requires at least two item URLs'
          );
        }
        return this.handleInstagramPublishCarousel({
          account: accountIdValue,
          items: args.items,
          caption: args.caption,
        });
      case 'reel':
        return this.handleInstagramPublishReel({
          account: accountIdValue,
          videoUrl: this.string(args, 'videoUrl'),
          caption: args.caption,
          shareToFeed: args.shareToFeed,
        });
      case 'story':
        if (!args.imageUrl && !args.videoUrl) {
          throw this.canonicalError('invalid_request', 'A story requires imageUrl or videoUrl');
        }
        return this.handleInstagramPublishStory({
          account: accountIdValue,
          imageUrl: args.imageUrl,
          videoUrl: args.videoUrl,
        });
      default:
        throw this.canonicalError('invalid_request', `Unsupported content kind '${args.kind}'`);
    }
  }

  private async canonicalManageComment(args: Record<string, any>): Promise<any> {
    this.requireChannel(args, 'instagram');
    const accountIdValue = this.account(args);
    const commentTarget = this.target(args);
    switch (this.string(args, 'action')) {
      case 'create':
        return this.handleInstagramPostComment({
          account: accountIdValue,
          mediaId: commentTarget,
          message: this.string(args, 'message'),
        });
      case 'reply':
        return this.handleInstagramReplyComment({
          account: accountIdValue,
          commentId: commentTarget,
          message: this.string(args, 'message'),
        });
      case 'hide':
      case 'unhide':
        return this.handleInstagramHideComment({
          account: accountIdValue,
          commentId: commentTarget,
          hide: args.action === 'hide',
        });
      case 'delete':
        return this.handleInstagramDeleteComment({
          account: accountIdValue,
          commentId: commentTarget,
        });
      default:
        throw this.canonicalError('invalid_request', `Unsupported comment action '${args.action}'`);
    }
  }

  private async handleSearchMessages(args: {
    query: string;
    chatId?: string;
    from?: string;
    to?: string;
    sender?: string;
    limit?: number;
    account?: Account;
    platform?: 'whatsapp' | 'telegram' | 'instagram';
    rawIds?: boolean;
    mediaType?: MediaType;
  }) {
    const { results, mode, fallbackReason, partialErrors } =
      await this.searchService.searchDetailed(args.query, {
        chatId: args.chatId,
        from: args.from ? new Date(args.from) : undefined,
        to: args.to ? new Date(args.to) : undefined,
        sender: args.sender,
        limit: args.limit || 20,
        account: args.account,
        platform: args.platform,
        rawIds: args.rawIds,
        mediaType: args.mediaType,
      });

    return {
      __canonicalResult: {
        data: {
          results: results.map(r => ({
            messageId: r.messageId,
            conversationId: r.conversationId,
            content: r.content,
            sender: r.senderWaId,
            timestamp: r.waTimestamp.toISOString(),
            channel: r.platform,
            accountId: r.account,
            messageType: r.messageType ?? null,
            similarity: r.similarity,
            rank: r.rank,
          })),
          // Which branch answered: `semantic` = the brain (INFRA-486),
          // `text` = Postgres full-text, with why the brain did not.
          mode,
          ...(fallbackReason ? { fallbackReason } : {}),
        },
        // An instance that did not answer is a partial read, not a text fallback;
        // `source` goes whole because executeCanonicalTool merges meta shallowly.
        meta: partialErrors?.length
          ? {
              source: {
                kind: 'localIndex',
                asOf: new Date().toISOString(),
                completeness: 'partial',
              },
              partialErrors: partialErrors.map(e => ({
                accountId: e.accountId,
                code: 'provider_error',
                message: e.message,
              })),
            }
          : {},
      },
    };
  }

  /** Conversation references → canonical row (ADR 0001: account from account_id). */
  private conversations(): ConversationResolver {
    this.conversationResolver ??= new ConversationResolver(this.dbClient);
    return this.conversationResolver;
  }

  private async handleGetChat(args: { chatId: string; account?: string }) {
    const account = normalizeAccount(args.account, 'whatsapp');
    const parsed = stripAccount(args.chatId);
    if (parsed.id !== args.chatId && parsed.account !== account) {
      throw this.canonicalError('invalid_request', 'Conversation belongs to another account');
    }
    const row = await this.conversations().resolve('whatsapp', account, parsed.id);

    if (!row || !ConversationResolver.belongsTo(row, 'whatsapp', account)) {
      throw this.canonicalError(
        'not_found',
        `Conversation '${args.chatId}' was not found in the WhatsApp index for account '${account}'`
      );
    }
    const chatId = row.id;
    const conversation = {
      id: row.id,
      waChatId: row.external_id || stripAccount(row.id).id,
      type: row.type || (row.is_group ? 'GROUP' : 'INDIVIDUAL'),
      name: row.name,
    };

    const messages = await this.dbClient.query(
      `SELECT * FROM messages
       WHERE conversation_id = $1 AND account = $2 AND platform = 'whatsapp'
       ORDER BY wa_timestamp DESC
       LIMIT 50`,
      [chatId, account]
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              conversation,
              messages: messages.rows.map(row => ({
                id: row.id,
                content: row.content || null,
                sender: row.sender_wa_id,
                timestamp: row.wa_timestamp,
                messageType: row.message_type,
                direction: row.direction,
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async resolveWhatsAppCursor(
    chatId: string,
    cursor?: string
  ): Promise<{ timestamp: Date; id?: string } | null> {
    if (!cursor) return null;
    const parsed = new Date(cursor);
    if (!Number.isNaN(parsed.getTime())) return { timestamp: parsed };

    const result = await this.dbClient.query(
      `SELECT id, wa_timestamp
       FROM messages
       WHERE conversation_id = $1
         AND platform = 'whatsapp'
         AND (wa_message_id = $2 OR id::text = $2)
       LIMIT 1`,
      [chatId, cursor]
    );
    if (!result.rows.length) {
      throw new McpError(ErrorCode.InvalidRequest, `Cursor message not found: ${cursor}`);
    }
    return { timestamp: result.rows[0].wa_timestamp, id: String(result.rows[0].id) };
  }

  private async resolveCurrentChatReadScope(
    account: string,
    chat: string
  ): Promise<{ chatId: string; conversationIds: string[] }> {
    const accountId = normalizeAccount(account, 'whatsapp');
    let chatId = accountKey(accountId, chat);
    const found = await this.dbClient.query(
      `SELECT id, wa_chat_id, COALESCE(is_group, false) AS is_group
       FROM conversations WHERE account=$1 AND id=$2`,
      [accountId, chatId]
    );
    if (!found.rows.length) throw new McpError(ErrorCode.InvalidRequest, 'Current chat not found');
    let conversation = found.rows[0];
    if (!conversation.is_group && /(?:^|:)\d+@(c\.us|s\.whatsapp\.net)$/.test(chatId)) {
      const linked = await this.dbClient.query(
        `SELECT lid.id, lid.wa_chat_id FROM conversations lid
         WHERE lid.account=$1 AND COALESCE(lid.is_group, false)=false AND lid.id ~ '@lid$'
           AND regexp_replace(lid.wa_chat_id, '@c\\.us$', '@s.whatsapp.net') =
               regexp_replace($2::text, '@c\\.us$', '@s.whatsapp.net')`,
        [accountId, chatId]
      );
      if (linked.rows.length === 1) {
        conversation = linked.rows[0];
        chatId = conversation.id;
      }
    }
    if (conversation.is_group || !/@lid$/.test(chatId) || !conversation.wa_chat_id) {
      return { chatId, conversationIds: [chatId] };
    }
    const aliases = await this.dbClient.query(
      `SELECT pn.id FROM conversations pn
       WHERE pn.account=$1 AND COALESCE(pn.is_group, false)=false
         AND pn.id ~ '[0-9]+@(c\\.us|s\\.whatsapp\\.net)$'
         AND regexp_replace(pn.id, '@c\\.us$', '@s.whatsapp.net') =
             regexp_replace($2::text, '@c\\.us$', '@s.whatsapp.net')
         AND (SELECT COUNT(*) FROM conversations lid
              WHERE lid.account=$1 AND COALESCE(lid.is_group, false)=false
                AND lid.id ~ '@lid$'
                AND regexp_replace(lid.wa_chat_id, '@c\\.us$', '@s.whatsapp.net') =
                    regexp_replace($2::text, '@c\\.us$', '@s.whatsapp.net')) = 1`,
      [accountId, conversation.wa_chat_id]
    );
    return { chatId, conversationIds: [chatId, ...aliases.rows.map(row => row.id)] };
  }

  private async handleWhatsAppGetMessages(args: {
    chatId: string;
    conversationIds?: string[];
    limit?: number;
    before?: string;
    after?: string;
    order?: 'asc' | 'desc';
    includeMetadata?: boolean;
    includeAttachments?: boolean;
    account?: string;
  }) {
    const limit = Math.max(1, Math.min(args.limit || 100, 500));
    const order = args.order === 'asc' ? 'ASC' : 'DESC';
    const chatId = accountKey(normalizeAccount(args.account), args.chatId);
    const before = await this.resolveWhatsAppCursor(chatId, args.before);
    const after = await this.resolveWhatsAppCursor(chatId, args.after);

    const where = [
      args.conversationIds ? `conversation_id = ANY($1::text[])` : `conversation_id = $1`,
      `platform = 'whatsapp'`,
      `account = $2`,
    ];
    const params: any[] = [
      args.conversationIds || chatId,
      normalizeAccount(args.account, 'whatsapp'),
    ];

    if (before) {
      params.push(before.timestamp);
      const tsParam = `$${params.length}`;
      if (before.id) {
        params.push(before.id);
        where.push(`(wa_timestamp, id) < (${tsParam}, $${params.length})`);
      } else {
        where.push(`wa_timestamp < ${tsParam}`);
      }
    }
    if (after) {
      params.push(after.timestamp);
      const tsParam = `$${params.length}`;
      if (after.id) {
        params.push(after.id);
        where.push(`(wa_timestamp, id) > (${tsParam}, $${params.length})`);
      } else {
        where.push(`wa_timestamp > ${tsParam}`);
      }
    }
    params.push(limit);

    const messages = await this.dbClient.query(
      `SELECT id, wa_message_id, conversation_id, sender_wa_id, wa_timestamp,
              direction, content, message_type, is_forwarded, reply_to_message_id,
              platform, metadata
       FROM messages
       WHERE ${where.join(' AND ')}
       ORDER BY wa_timestamp ${order}, id ${order}
       LIMIT $${params.length}`,
      params
    );

    const attachmentMap = new Map<string, any[]>();
    if (args.includeAttachments !== false && messages.rows.length) {
      const ids = messages.rows.map(row => row.id);
      const attachments = await this.dbClient.query(
        `SELECT message_id, file_type, mime_type, file_name, file_size, file_url, caption
         FROM attachments
         WHERE message_id = ANY($1)
         ORDER BY id ASC`,
        [ids]
      );
      for (const row of attachments.rows) {
        const key = String(row.message_id);
        const list = attachmentMap.get(key) || [];
        list.push({
          fileType: row.file_type,
          mimeType: row.mime_type,
          fileName: row.file_name,
          fileSize: row.file_size,
          fileUrl: row.file_url,
          caption: row.caption,
        });
        attachmentMap.set(key, list);
      }
    }

    const rows = messages.rows.map(row => ({
      id: row.id,
      waMessageId: row.wa_message_id,
      conversationId: row.conversation_id,
      sender: row.sender_wa_id,
      timestamp: row.wa_timestamp,
      direction: row.direction,
      content: row.content || null,
      messageType: row.message_type,
      isForwarded: row.is_forwarded,
      replyToWaId: row.reply_to_message_id,
      attachments: attachmentMap.get(String(row.id)) || [],
      ...(args.includeMetadata ? { metadata: row.metadata || {} } : {}),
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              chatId: args.chatId,
              order: args.order || 'desc',
              limit,
              count: rows.length,
              nextBefore: rows.length ? rows[rows.length - 1].waMessageId : null,
              nextAfter: rows.length ? rows[0].waMessageId : null,
              messages: rows,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleWhatsAppHistoryStatus(args: { chatId?: string; limit?: number }) {
    const limit = Math.max(1, Math.min(args.limit || 100, 500));
    const tableStatus = await this.dbClient.query(
      `SELECT
         to_regclass('public.whatsapp_sync_state') AS sync_table,
         to_regclass('public.whatsapp_message_keys') AS key_table`
    );
    const hasSyncState = !!tableStatus.rows[0]?.sync_table;
    const hasMessageKeys = !!tableStatus.rows[0]?.key_table;

    const stateSelect = hasSyncState
      ? `s.status AS sync_status,
         s.oldest_message_id,
         s.oldest_timestamp,
         s.newest_timestamp,
         s.total_imported,
         s.last_error,
         s.updated_at AS sync_updated_at`
      : `NULL::text AS sync_status,
         NULL::text AS oldest_message_id,
         NULL::timestamptz AS oldest_timestamp,
         NULL::timestamptz AS newest_timestamp,
         0::bigint AS total_imported,
         NULL::text AS last_error,
         NULL::timestamptz AS sync_updated_at`;
    const stateJoin = hasSyncState
      ? `LEFT JOIN whatsapp_sync_state s ON s.conversation_id = c.id`
      : '';
    const keySelect = hasMessageKeys
      ? `(SELECT count(*) FROM whatsapp_message_keys k WHERE k.conversation_id = c.id) AS persisted_keys`
      : `0::bigint AS persisted_keys`;

    const params: any[] = [];
    const filter = args.chatId ? `AND c.id = $1` : '';
    if (args.chatId) params.push(args.chatId);
    params.push(limit);

    const status = await this.dbClient.query(
      `SELECT
         c.id AS conversation_id,
         c.name,
         count(m.id) AS message_count,
         min(m.wa_timestamp) AS oldest_message_at,
         max(m.wa_timestamp) AS newest_message_at,
         count(*) FILTER (WHERE m.metadata->>'source' = 'ios_backup_import') AS ios_backup_messages,
         count(*) FILTER (WHERE m.metadata->>'source' = 'baileys_history_sync') AS baileys_history_messages,
         count(*) FILTER (WHERE m.metadata->>'source' = 'live' OR m.metadata->>'source' IS NULL) AS live_messages,
         ${keySelect},
         ${stateSelect}
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id AND m.platform = 'whatsapp'
       ${stateJoin}
       WHERE 1 = 1 ${filter}
       GROUP BY c.id, c.name${hasSyncState ? ', s.status, s.oldest_message_id, s.oldest_timestamp, s.newest_timestamp, s.total_imported, s.last_error, s.updated_at' : ''}
       ORDER BY max(m.wa_timestamp) DESC
       LIMIT $${params.length}`,
      params
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              historyTables: {
                syncState: hasSyncState,
                messageKeys: hasMessageKeys,
              },
              conversations: status.rows.map(row => ({
                conversationId: row.conversation_id,
                name: row.name,
                messageCount: Number(row.message_count || 0),
                oldestMessageAt: row.oldest_message_at,
                newestMessageAt: row.newest_message_at,
                sources: {
                  iosBackupImport: Number(row.ios_backup_messages || 0),
                  baileysHistorySync: Number(row.baileys_history_messages || 0),
                  live: Number(row.live_messages || 0),
                },
                persistedKeys: Number(row.persisted_keys || 0),
                sync: {
                  status: row.sync_status,
                  oldestMessageId: row.oldest_message_id,
                  oldestTimestamp: row.oldest_timestamp,
                  newestTimestamp: row.newest_timestamp,
                  totalImported: Number(row.total_imported || 0),
                  lastError: row.last_error,
                  updatedAt: row.sync_updated_at,
                },
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleGetContext(args: {
    chatId: string;
    messageId: string;
    windowBefore?: number;
    windowAfter?: number;
  }) {
    const windowBefore = args.windowBefore || 5;
    const windowAfter = args.windowAfter || 5;

    const message = await this.dbClient.query(
      `SELECT id, wa_timestamp
         FROM messages
        WHERE conversation_id = $1
          AND (id::text = $2 OR wa_message_id = $2)
        LIMIT 1`,
      [args.chatId, args.messageId]
    );

    if (message.rows.length === 0) {
      throw new McpError(ErrorCode.InvalidRequest, t('errors.MESSAGE_NOT_FOUND'));
    }
    const databaseMessageId = message.rows[0].id;

    // conversations.id IS the chatId directly
    const context = await this.dbClient.query(
      `(SELECT * FROM messages
        WHERE conversation_id = $1
          AND wa_timestamp < (SELECT wa_timestamp FROM messages WHERE id = $2)
        ORDER BY wa_timestamp DESC
        LIMIT $3)
       UNION ALL
       (SELECT * FROM messages WHERE conversation_id = $1 AND id = $2)
       UNION ALL
       (SELECT * FROM messages
        WHERE conversation_id = $1
          AND wa_timestamp > (SELECT wa_timestamp FROM messages WHERE id = $2)
        ORDER BY wa_timestamp ASC
        LIMIT $4)
       ORDER BY wa_timestamp ASC`,
      [args.chatId, databaseMessageId, windowBefore, windowAfter]
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              context: context.rows.map(row => ({
                id: row.id,
                content: row.content || null,
                sender: row.sender_wa_id,
                timestamp: row.wa_timestamp,
                messageType: row.message_type,
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleSummarizeChat(args: {
    chatId: string;
    range?: { from?: string; to?: string };
    style?: 'brief' | 'detailed' | 'bullet';
    language?: 'en' | 'es';
  }) {
    const summary = await this.summarizationService.summarizeChat(args.chatId, {
      style: args.style || 'brief',
      language: args.language || 'en',
      range: args.range
        ? {
            from: args.range.from ? new Date(args.range.from) : undefined,
            to: args.range.to ? new Date(args.range.to) : undefined,
          }
        : undefined,
    });

    return {
      content: [
        {
          type: 'text',
          text: summary,
        },
      ],
    };
  }

  private async handleSummarizeDay(args: {
    date: string;
    scope?: 'all' | 'important';
    language?: 'en' | 'es';
    account?: Account;
    platform?: 'whatsapp' | 'telegram';
  }) {
    const summary = await this.summarizationService.summarizeDay(
      new Date(args.date),
      args.scope || 'all',
      args.language || 'en',
      args.account && args.platform ? { account: args.account, platform: args.platform } : undefined
    );

    return {
      content: [
        {
          type: 'text',
          text: summary,
        },
      ],
    };
  }

  private async handleSummarizeWeek(args: {
    weekStartDate: string;
    scope?: 'all' | 'important';
    language?: 'es' | 'en';
    account?: Account;
    platform?: 'whatsapp' | 'telegram';
  }) {
    const summary = await this.summarizationService.summarizeWeek(
      new Date(args.weekStartDate),
      args.scope || 'all',
      args.language || 'en',
      args.account && args.platform ? { account: args.account, platform: args.platform } : undefined
    );

    return {
      content: [
        {
          type: 'text',
          text: summary,
        },
      ],
    };
  }

  private async handleDraftReply(args: {
    chatId: string;
    messageId?: string;
    lastN?: number;
    tone?: 'professional' | 'casual' | 'friendly' | 'formal';
    language?: 'en' | 'es';
    constraints?: {
      maxLength?: number;
      requiredTopics?: string[];
      avoidTopics?: string[];
    };
  }) {
    const draft = await this.draftService.createDraft(
      args.chatId,
      {
        tone: args.tone || 'casual',
        language: args.language || 'en',
        constraints: args.constraints,
      },
      args.messageId,
      args.lastN
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              draftId: draft.id,
              content: draft.content,
              status: draft.status,
              createdAt: draft.createdAt.toISOString(),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleListDrafts(args: { chatId: string; status?: 'DRAFT' | 'APPROVED' | 'SENT' }) {
    const drafts = await this.draftService.listDrafts(args.chatId, args.status);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              drafts: drafts.map(d => ({
                id: d.id,
                content: d.content,
                status: d.status,
                createdAt: d.createdAt.toISOString(),
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async requireDraftAccount(draftId: string, expectedAccount: Account): Promise<void> {
    const draft = await this.draftService.getDraftById(draftId);
    if (!draft) {
      throw this.canonicalError('not_found', `Draft '${draftId}' was not found`);
    }
    const owner = await this.dbClient.query(
      `SELECT a.legacy_namespace AS ns FROM conversations c
         JOIN social_accounts a ON a.id = c.account_id WHERE c.id = $1`,
      [draft.conversationId]
    );
    const actualAccount = owner.rows[0]?.ns;
    if (actualAccount !== expectedAccount) {
      throw this.canonicalError(
        'not_found',
        `Draft '${draftId}' does not belong to account '${expectedAccount}'`
      );
    }
  }

  private async handleApproveDraft(args: { draftId: string }) {
    const sendToken = await this.draftService.approveDraft(args.draftId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              sendToken,
              message: t('messages.draft_approved'),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleSendApprovedReply(args: { sendToken: string; account?: string }) {
    if (process.env.ENABLE_SENDING !== 'true') {
      throw new McpError(ErrorCode.InvalidRequest, t('errors.SENDING_DISABLED'));
    }

    if (process.env.EMERGENCY_DISABLE_SENDING === 'true') {
      throw new McpError(ErrorCode.InvalidRequest, t('errors.SENDING_DISABLED'));
    }

    // Extract draft ID from send token (format: send-{id}-{timestamp}).
    const tokenMatch = args.sendToken.match(/^send-(.+)-(\d+)$/);
    if (!tokenMatch) {
      throw new McpError(ErrorCode.InvalidRequest, t('errors.INVALID_SEND_TOKEN'));
    }
    const draftId = tokenMatch[1];
    const expectedAccount = normalizeAccount(args.account, 'whatsapp');
    await this.requireDraftAccount(draftId, expectedAccount);

    const draft = await this.draftService.getDraftById(draftId);
    if (!draft) {
      throw new McpError(ErrorCode.InvalidRequest, t('errors.INVALID_SEND_TOKEN'));
    }

    if (draft.status !== 'APPROVED') {
      throw new McpError(ErrorCode.InvalidRequest, t('errors.DRAFT_NOT_FOUND'));
    }

    // Draft ownership uses the account-namespaced DB key. The provider must
    // receive the bare WhatsApp JID, never `professional:<jid>`.
    const providerChatId = this.whatsAppProviderJid(
      draft.conversationId,
      expectedAccount,
      'conversationId'
    );
    const conversationId = isGroupJid(providerChatId)
      ? providerChatId
      : requireAccount('whatsapp', expectedAccount).requireInboundBeforeSend
        ? await this.requireProfessionalInboundChat(providerChatId, {}, expectedAccount)
        : providerChatId;

    // Call connector API to send message
    const connectorUrl = this.waUrl(expectedAccount);
    const sharedSecret = this.secretForUrl(connectorUrl);
    const body = {
      sendToken: args.sendToken,
      conversationId,
      content: draft.content,
    };

    try {
      const response = await this.postWhatsAppMessage(connectorUrl, body, sharedSecret);

      if (!response.ok) {
        throw new Error(`Failed to send message: ${response.statusText}`);
      }

      await this.draftService.markAsSent(draftId);

      return this.jsonResponse({
        message: t('messages.draft_sent'),
        sentAt: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error(`Error sending message: ${error}`);
      throw new McpError(ErrorCode.InternalError, `Failed to send message: ${error}`);
    }
  }

  private async handleSendMessage(
    args: {
      chatId: string;
      text: string;
      account?: string;
      replyTo?: string;
      phone?: string;
      phoneE164?: string;
      manualOpenUrl?: string;
      scopedSendToken?: string;
    },
    // Set only by canonicalSendMessage, never from tool arguments.
    options?: { idempotencyKey?: string }
  ) {
    if (!args.scopedSendToken && process.env.ENABLE_SENDING !== 'true') {
      throw new McpError(ErrorCode.InvalidRequest, 'Sending is disabled (ENABLE_SENDING != true)');
    }
    if (process.env.EMERGENCY_DISABLE_SENDING === 'true') {
      throw new McpError(ErrorCode.InvalidRequest, 'Sending is emergency disabled');
    }

    const account = normalizeAccount(args.account, 'whatsapp');
    const providerChatId = this.whatsAppProviderJid(args.chatId, account, 'chatId');
    // Group sends bypass the professional cold-send gate: membership in a group
    // already implies established context (no unsolicited first-contact), and the
    // gate only ever supported 1:1 targets. Both accounts must hand the connector
    // the BARE `@g.us` jid — a `professional:`/`personal:` prefix reaches
    // `sock.groupMetadata()` verbatim and times out. Non-group professional sends
    // keep the inbound gate untouched.
    const conversationId = isGroupJid(providerChatId)
      ? providerChatId
      : requireAccount('whatsapp', account).requireInboundBeforeSend
        ? await this.requireProfessionalInboundChat(
            providerChatId,
            {
              phone: args.phone,
              phoneE164: args.phoneE164,
              manualOpenUrl: args.manualOpenUrl,
            },
            account
          )
        : providerChatId;
    const connectorUrl = this.waUrl(account);
    const sharedSecret = connectorSecretFor(requireAccount('whatsapp', account));
    const body = {
      sendToken: args.scopedSendToken || `direct-${Date.now()}`,
      conversationId,
      content: args.text,
      ...(args.replyTo ? { replyToMessageId: args.replyTo } : {}),
    };

    try {
      const response = await this.postWhatsAppMessage(
        connectorUrl,
        body,
        sharedSecret,
        options?.idempotencyKey
      );

      if (!response.ok) {
        const errorPayload = await this.readConnectorError(response);
        const failure = errorPayload.failureClass ? ` (${errorPayload.failureClass})` : '';
        const actionable = errorPayload.actionable ? ` - ${errorPayload.actionable}` : '';
        const fallbackUrl = !isLidJid(conversationId)
          ? manualWhatsAppOpenUrl(conversationId, args.text)
          : undefined;
        const fallback =
          errorPayload.failureClass === 'account_restricted' && fallbackUrl
            ? ` Manual fallback: open ${fallbackUrl} in the official WhatsApp app/Web session and press send manually. Automated first-contact sends require an existing inbound chat/trusted-contact token or an official WhatsApp Business Platform template.`
            : '';
        throw new Error(
          `Connector returned ${response.status}${failure}: ${errorPayload.error || response.statusText}${actionable}${fallback}`
        );
      }

      const result = (await response.json()) as Record<string, unknown>;
      return this.jsonResponse({
        message: 'Message sent',
        messageId: result.messageId || null,
        sentAt: result.sentAt || new Date().toISOString(),
        chatId: conversationId,
      });
    } catch (error) {
      this.logger.error(`Error sending message: ${error}`);
      throw new McpError(ErrorCode.InternalError, `Failed to send message: ${error}`);
    }
  }

  private async professionalInboundDestination(
    sendJid: string,
    account: Account
  ): Promise<string | null> {
    const lid = isLidJid(sendJid);
    const conversationIds = lid
      ? [accountKey(account, sendJid)]
      : [accountKey(account, sendJid), accountKey(account, phoneWaJidFromSendJid(sendJid))];
    const result = await this.dbClient.query(
      `SELECT c.id, max(m.wa_timestamp) AS last_inbound_at
         FROM conversations c
         JOIN messages m ON m.conversation_id = c.id
        WHERE (c.id = ANY($1::text[])
               OR ($3::text IS NOT NULL
                   AND (c.id LIKE '%@lid' OR c.id LIKE '%@hosted.lid')
                   AND m.metadata->>'senderPnE164' = $3))
          AND c.account = $2
          AND COALESCE(c.is_group, false) = false
          AND m.account = $2
          AND m.platform = 'whatsapp'
          AND m.direction = 'INBOUND'
        GROUP BY c.id
        ORDER BY CASE WHEN c.id = ANY($1::text[]) THEN 0 ELSE 1 END`,
      [conversationIds, account, lid ? null : phoneE164FromSendJid(sendJid)]
    );
    if (result.rows.some(row => conversationIds.includes(row.id))) return sendJid;
    const mappedLids = result.rows.map(row => stripAccount(row.id).id).filter(isLidJid);
    return mappedLids.length === 1 ? mappedLids[0] : null;
  }

  /**
   * Gate professional WhatsApp direct sends behind an existing inbound message
   * (no cold first-contact sends) and return the jid that must actually be sent.
   *
   * LID chats require inbound for that exact LID. Phone chats require their
   * own inbound, or a LID inbound carrying provider-derived senderPnE164.
   */
  private async requireProfessionalInboundChat(
    chatId: string,
    _evidence: { phone?: unknown; phoneE164?: unknown; manualOpenUrl?: unknown } = {},
    account: Account = 'personal'
  ): Promise<string> {
    const target = resolveProfessionalSendTarget(chatId, {}, account);
    if (!target) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Professional WhatsApp direct sends require a valid individual phone or WhatsApp chat ID'
      );
    }

    const destination = await this.professionalInboundDestination(target.sendJid, account);
    if (!destination) {
      const fallbackUrl = isLidJid(target.sendJid)
        ? undefined
        : manualWhatsAppOpenUrl(target.sendJid, '');
      const fallback = fallbackUrl ? ` Manual fallback: ${fallbackUrl}` : '';
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Professional WhatsApp direct sends are only allowed after the customer has sent an inbound message.${fallback}`
      );
    }

    return destination;
  }

  private async handleSendTemplate(args: {
    chatId: string;
    templateName: string;
    languageCode?: string;
    components?: unknown[];
    account?: string;
  }) {
    if (process.env.ENABLE_SENDING !== 'true') {
      throw new McpError(ErrorCode.InvalidRequest, 'Sending is disabled (ENABLE_SENDING != true)');
    }
    if (process.env.EMERGENCY_DISABLE_SENDING === 'true') {
      throw new McpError(ErrorCode.InvalidRequest, 'Sending is emergency disabled');
    }

    const account = normalizeAccount(args.account);
    throw this.canonicalError(
      'unsupported_capability',
      'Templates require a configured Cloud API transport'
    );
    if (!args.chatId || !args.templateName) {
      throw new McpError(ErrorCode.InvalidRequest, 'chatId and templateName are required');
    }

    try {
      const result = await this.connectorCall(
        this.waUrl(account),
        'POST',
        '/api/v1/messages/template',
        {
          sendToken: `template-${Date.now()}`,
          conversationId: args.chatId,
          templateName: args.templateName,
          languageCode: args.languageCode || 'es',
          ...(Array.isArray(args.components) ? { components: args.components } : {}),
        },
        30000
      );

      return this.jsonResponse({
        message: 'Template sent',
        messageId: result.messageId || null,
        sentAt: result.sentAt || new Date().toISOString(),
        chatId: args.chatId,
        templateName: args.templateName,
      });
    } catch (error) {
      this.logger.error(`Error sending WhatsApp template: ${error}`);
      throw new McpError(ErrorCode.InternalError, `Failed to send WhatsApp template: ${error}`);
    }
  }

  private async readConnectorError(response: Response): Promise<Record<string, any>> {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return { error: text || response.statusText };
    }
  }

  private async handleRenewQRCode(args: { confirmDisconnect?: boolean; account?: string }) {
    if (!args.confirmDisconnect) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'You must set confirmDisconnect to true to renew QR code. This will disconnect WhatsApp.'
      );
    }

    const connectorUrl = this.waUrl(args.account);
    const sharedSecret = this.secretForUrl(connectorUrl);

    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const body = { action: 'logout' };
      const response = await this.signedConnectorPost(
        connectorUrl,
        '/api/v1/auth/logout',
        body,
        timestamp,
        sharedSecret
      );

      if (!response.ok) {
        throw new Error(`Failed to logout: ${response.statusText}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                message:
                  'WhatsApp disconnected successfully. New QR code will be generated shortly.',
                instructions: `Visit ${requireAccount('whatsapp', normalizeAccount(args?.account)).qrUrl || 'configured pairing page'} to scan the new QR code.`,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      this.logger.error(`Error renewing QR code: ${error}`);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to renew QR code: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleGetConnectionStatus(args?: { account?: string }) {
    const connectorUrl = this.waUrl(args?.account);

    try {
      const response = await fetch(`${connectorUrl}/api/v1/health`, {
        headers: this.authHeaders(connectorUrl),
      });

      if (!response.ok) {
        throw new Error(`Failed to get status: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        status: string;
        connected: boolean;
        qrAvailable: boolean;
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: data.status,
                connected: data.connected,
                qrAvailable: data.qrAvailable,
                message: data.connected
                  ? 'WhatsApp is connected'
                  : data.qrAvailable
                    ? 'QR code is available for scanning'
                    : 'WhatsApp is disconnected. Use social_manage_session with action=renewQr.',
                qrUrl: requireAccount('whatsapp', normalizeAccount(args?.account)).qrUrl || null,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      this.logger.error(`Error getting connection status: ${error}`);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get connection status: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleSearchUsers(args: { query: string; limit?: number; account?: string }) {
    const results = await this.repository.searchParticipants(
      args.query,
      args.limit || 20,
      normalizeAccount(args.account)
    );

    const usersMap = new Map<
      string,
      {
        waUserId: string;
        displayName: string;
        conversations: { id: string; waChatId: string; type: string; name: string | null }[];
      }
    >();

    for (const result of results) {
      if (!usersMap.has(result.waUserId)) {
        usersMap.set(result.waUserId, {
          waUserId: result.waUserId,
          displayName: result.displayName,
          conversations: [],
        });
      }
      usersMap.get(result.waUserId)!.conversations.push({
        id: result.conversationId,
        waChatId: result.waChatId,
        type: result.conversationType,
        name: result.conversationName,
      });
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              query: args.query,
              totalResults: usersMap.size,
              users: Array.from(usersMap.values()),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleListConversations(args: {
    type?: 'INDIVIDUAL' | 'GROUP';
    query?: string;
    limit?: number;
    includeParticipants?: boolean;
    account?: string;
  }) {
    const conversations = await this.repository.listConversations({
      type: args.type,
      query: args.query,
      limit: args.limit || 20,
      includeParticipants: args.includeParticipants !== false,
      account: args.account,
      channel: 'whatsapp',
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              totalResults: conversations.length,
              filters: {
                type: args.type || 'all',
                query: args.query || null,
              },
              conversations: conversations.map(conv => ({
                id: conv.id,
                waChatId: conv.waChatId,
                type: conv.type,
                name: conv.name,
                lastMessageAt: conv.lastMessageAt?.toISOString() || null,
                messageCount: conv.messageCount,
                unreadCount: conv.unreadCount,
                participants: conv.participants,
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleGetUserMessages(args: {
    waUserId: string;
    conversationId?: string;
    from?: string;
    to?: string;
    limit?: number;
    account?: string;
  }) {
    const account = normalizeAccount(args.account);
    const userInfo = await this.repository.getUserInfo(args.waUserId, account);

    const messages = await this.repository.getMessagesByUser(
      args.waUserId,
      {
        conversationId: args.conversationId,
        from: args.from ? new Date(args.from) : undefined,
        to: args.to ? new Date(args.to) : undefined,
        limit: args.limit || 50,
      },
      account
    );

    // No decryption needed - content is plaintext
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              user: userInfo
                ? {
                    waUserId: userInfo.waUserId,
                    names: userInfo.names,
                    conversationCount: userInfo.conversationCount,
                    totalMessageCount: userInfo.messageCount,
                    lastSeen: userInfo.lastSeen?.toISOString() || null,
                  }
                : {
                    waUserId: args.waUserId,
                    names: [],
                    conversationCount: 0,
                    totalMessageCount: 0,
                    lastSeen: null,
                  },
              filters: {
                conversationId: args.conversationId || null,
                from: args.from || null,
                to: args.to || null,
              },
              messagesReturned: messages.length,
              messages: messages.map(msg => ({
                id: msg.id,
                conversationId: msg.conversationId,
                waChatId: msg.waChatId,
                conversationName: msg.conversationName,
                waMessageId: msg.waMessageId,
                content: msg.content || null,
                messageType: msg.messageType,
                timestamp: msg.waTimestamp.toISOString(),
                isForwarded: msg.isForwarded,
                isEdited: msg.isEdited,
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleTelegramSendMessage(args: {
    chatId: string;
    text: string;
    topicId?: number | string;
    replyTo?: number | string;
    account?: string;
  }) {
    const target = this.telegramTopicTarget(args.chatId, args.topicId);
    const replyTo = optionalPositiveInteger(args.replyTo, 'replyTo');
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'POST',
      `/api/v1/messages/${encodeURIComponent(target.chatId)}`,
      {
        text: args.text,
        ...(target.topicId ? { topicId: target.topicId } : {}),
        ...(replyTo ? { replyTo } : {}),
      }
    );
    return this.jsonResponse(data);
  }

  /**
   * Resolve the (chatId, topicId) pair for the forum-topic admin tools. Same shorthand
   * rules as the message tools: tg_<chat>_<topic> works instead of a separate topicId.
   */
  private telegramTopicAdminTarget(
    chatId: string,
    explicitTopicId?: number | string
  ): { chatId: string; topicId: number } {
    const target = this.telegramTopicTarget(chatId, explicitTopicId);
    if (!target.topicId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'topicId is required (pass it directly or as the tg_<chat>_<topic> shorthand)'
      );
    }
    return { chatId: target.chatId, topicId: target.topicId };
  }

  private async handleTelegramGetTopics(args: {
    chatId: string;
    limit?: number;
    query?: string;
    account?: string;
  }) {
    const target = this.telegramTopicTarget(args.chatId);
    const limit = clampInteger(args.limit, 100, 1, 200);
    const params = new URLSearchParams({ limit: String(limit) });
    if (args.query) params.set('query', args.query);
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'GET',
      `/api/v1/chats/${encodeURIComponent(target.chatId)}/topics?${params.toString()}`
    );
    return this.jsonResponse(data);
  }

  private async handleTelegramCreateTopic(args: {
    chatId: string;
    title: string;
    icon?: number;
    account?: string;
  }) {
    const target = this.telegramTopicTarget(args.chatId);
    if (typeof args.title !== 'string' || !args.title.trim()) {
      throw new McpError(ErrorCode.InvalidParams, 'title is required');
    }
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'POST',
      `/api/v1/chats/${encodeURIComponent(target.chatId)}/topics`,
      {
        title: args.title,
        ...(args.icon !== undefined ? { icon: args.icon } : {}),
      }
    );
    return this.jsonResponse(data);
  }

  private async handleTelegramEditTopic(args: {
    chatId: string;
    topicId?: number | string;
    title?: string;
    closed?: boolean;
    hidden?: boolean;
    clearIcon?: boolean;
    account?: string;
  }) {
    const target = this.telegramTopicAdminTarget(args.chatId, args.topicId);
    if (
      args.title === undefined &&
      args.closed === undefined &&
      args.hidden === undefined &&
      args.clearIcon === undefined
    ) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'at least one of title, closed, hidden or clearIcon is required'
      );
    }
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'PATCH',
      `/api/v1/chats/${encodeURIComponent(target.chatId)}/topics/${target.topicId}`,
      {
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.closed !== undefined ? { closed: args.closed } : {}),
        ...(args.hidden !== undefined ? { hidden: args.hidden } : {}),
        ...(args.clearIcon !== undefined ? { clearIcon: args.clearIcon } : {}),
      }
    );
    return this.jsonResponse(data);
  }

  private async handleTelegramToggleTopicClosed(args: {
    chatId: string;
    topicId?: number | string;
    closed: boolean;
    account?: string;
  }) {
    const target = this.telegramTopicAdminTarget(args.chatId, args.topicId);
    if (typeof args.closed !== 'boolean') {
      throw new McpError(ErrorCode.InvalidParams, 'closed must be a boolean');
    }
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'POST',
      `/api/v1/chats/${encodeURIComponent(target.chatId)}/topics/${target.topicId}/closed`,
      { closed: args.closed }
    );
    return this.jsonResponse(data);
  }

  private async handleTelegramToggleTopicPinned(args: {
    chatId: string;
    topicId?: number | string;
    pinned: boolean;
    account?: string;
  }) {
    const target = this.telegramTopicAdminTarget(args.chatId, args.topicId);
    if (typeof args.pinned !== 'boolean') {
      throw new McpError(ErrorCode.InvalidParams, 'pinned must be a boolean');
    }
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'POST',
      `/api/v1/chats/${encodeURIComponent(target.chatId)}/topics/${target.topicId}/pinned`,
      { pinned: args.pinned }
    );
    return this.jsonResponse(data);
  }

  private async handleTelegramDeleteTopic(args: {
    chatId: string;
    topicId?: number | string;
    account?: string;
  }) {
    const target = this.telegramTopicAdminTarget(args.chatId, args.topicId);
    // topicId travels in the path: connectorCall sends no body on DELETE.
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'DELETE',
      `/api/v1/chats/${encodeURIComponent(target.chatId)}/topics/${target.topicId}`
    );
    return this.jsonResponse(data);
  }

  private async handleTelegramUpdateForumSettings(args: {
    chatId: string;
    isForum: boolean;
    threadsMode?: 'list' | 'tabs';
    account?: string;
  }) {
    const target = this.telegramTopicTarget(args.chatId);
    if (typeof args.isForum !== 'boolean') {
      throw new McpError(ErrorCode.InvalidParams, 'isForum must be a boolean');
    }
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'POST',
      `/api/v1/chats/${encodeURIComponent(target.chatId)}/forum-settings`,
      {
        isForum: args.isForum,
        ...(args.threadsMode !== undefined ? { threadsMode: args.threadsMode } : {}),
      }
    );
    return this.jsonResponse(data);
  }

  private async handleTelegramSetChatTitle(args: {
    chatId: string;
    title: string;
    account?: string;
  }) {
    const target = this.telegramTopicTarget(args.chatId);
    if (typeof args.title !== 'string' || !args.title.trim()) {
      throw new McpError(ErrorCode.InvalidParams, 'title is required');
    }
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'PATCH',
      `/api/v1/chats/${encodeURIComponent(target.chatId)}/title`,
      { title: args.title }
    );
    return this.jsonResponse(data);
  }

  private async handleTelegramSetChatDescription(args: {
    chatId: string;
    description: string;
    account?: string;
  }) {
    const target = this.telegramTopicTarget(args.chatId);
    if (typeof args.description !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'description must be a string');
    }
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'PATCH',
      `/api/v1/chats/${encodeURIComponent(target.chatId)}/description`,
      { description: args.description }
    );
    return this.jsonResponse(data);
  }

  private async handleTelegramSetChatPhoto(args: {
    chatId: string;
    filePath: string;
    type?: 'photo' | 'video';
    account?: string;
  }) {
    const target = this.telegramTopicTarget(args.chatId);
    if (typeof args.filePath !== 'string' || !args.filePath.trim()) {
      throw new McpError(ErrorCode.InvalidParams, 'filePath is required');
    }
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'PATCH',
      `/api/v1/chats/${encodeURIComponent(target.chatId)}/photo`,
      {
        filePath: args.filePath,
        ...(args.type !== undefined ? { type: args.type } : {}),
      }
    );
    return this.jsonResponse(data);
  }

  private async handleTelegramClickButton(args: {
    chatId: string;
    messageId: number | string;
    data: string;
    dataB64?: string;
    timeoutMs?: number;
    fireAndForget?: boolean;
    account?: string;
  }) {
    const target = this.telegramTopicTarget(args.chatId);
    const messageId = requiredPositiveInteger(args.messageId, 'messageId');
    const timeoutMs = clampInteger(args.timeoutMs, 10000, 1000, 60000);
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'POST',
      '/api/v1/messages/callback',
      {
        chatId: target.chatId,
        messageId,
        data: args.data,
        ...(args.dataB64 ? { dataB64: args.dataB64 } : {}),
        timeoutMs,
        fireAndForget: args.fireAndForget === true,
      }
    );
    return this.jsonResponse(data);
  }

  private async handleTelegramSendFile(args: {
    chatId: string;
    filePath: string;
    caption?: string;
    voiceNote?: boolean;
    replyTo?: number | string;
    threadId?: number | string;
    account?: string;
  }) {
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'POST',
      '/api/v1/messages/media/send',
      {
        chatId: args.chatId,
        filePath: args.filePath,
        caption: args.caption,
        voiceNote: args.voiceNote || false,
        replyTo: args.replyTo,
        threadId: args.threadId,
      }
    );
    return this.jsonResponse(data);
  }

  private async handleTelegramSendMediaGroup(args: {
    chatId: string;
    attachments: Array<{
      filePath: string;
      name?: string;
      mimeType?: string;
      caption?: string;
    }>;
    replyTo?: number | string;
    threadId?: number | string;
    account?: string;
  }) {
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'POST',
      '/api/v1/messages/media/group',
      {
        chatId: args.chatId,
        attachments: args.attachments,
        replyTo: args.replyTo,
        threadId: args.threadId,
      }
    );
    return this.jsonResponse(data);
  }

  /**
   * Normalize a user-provided Telegram chat identifier to the DB form `tg_<id>`.
   * Accepts `tg_xxx` (returned as-is), bare numeric ids like `-1003749364241`
   * or `1629757854` (prefixed), or `@username` (resolved via DB metadata).
   */
  private async resolveTelegramChatId(
    chatId: string,
    account: Account = 'personal'
  ): Promise<string | null> {
    const target = this.telegramTopicTarget(chatId);
    if (/^-?\d+$/.test(target.chatId)) return accountKey(account, `tg_${target.chatId}`);
    if (chatId.startsWith('@')) {
      const username = chatId.slice(1).toLowerCase();
      const r = await this.dbClient.query(
        `SELECT COALESCE(merged_into, id) AS id FROM conversations
          WHERE account_id = $2 AND lower(metadata->>'username') = $1 LIMIT 1`,
        [username, socialAccountId('telegram', account)]
      );
      return r.rows[0]?.id ?? null;
    }
    return null;
  }

  private telegramTopicTarget(
    chatId: string,
    explicitTopicId?: number | string
  ): { chatId: string; topicId?: number } {
    if (!chatId || !String(chatId).trim()) {
      throw new McpError(ErrorCode.InvalidParams, 'chatId is required');
    }
    let id = stripAccount(String(chatId).trim()).id;
    if (id.startsWith('tg_')) id = id.slice(3);

    let topicId = optionalPositiveInteger(explicitTopicId, 'topicId');
    if (!topicId) {
      const match = id.match(/^(-?\d+)_(\d+)$/);
      if (match) {
        id = match[1];
        topicId = Number(match[2]);
      }
    }
    return { chatId: id, ...(topicId ? { topicId } : {}) };
  }

  private appendTelegramTopicWhere(
    where: string,
    params: any[],
    conversationParamIndex: number,
    topicId?: number
  ): string {
    if (!topicId) return where;
    params.push(String(topicId));
    const topicParamIndex = params.length;
    return `${where}
          AND (
            metadata->>'topic_id' = $${topicParamIndex}
            OR metadata->>'topicId' = $${topicParamIndex}
            OR metadata->>'thread_id' = $${topicParamIndex}
            OR metadata->>'threadId' = $${topicParamIndex}
            OR reply_to_message_id = ($${conversationParamIndex} || '_' || $${topicParamIndex})
          )`;
  }

  private bareTelegramTgId(chatId: string): string | null {
    const id = stripAccount(String(chatId).trim()).id;
    if (id.startsWith('tg_')) return id;
    if (/^-?\d+$/.test(id)) return `tg_${id}`;
    return null;
  }

  private async resolveTelegramMediaAccount(
    chatId: string,
    messageId: string,
    requested: Account
  ): Promise<{
    account: Account;
    source:
      'message' | 'message-ambiguous' | 'conversation' | 'conversation-ambiguous' | 'fallback';
    candidates: string[];
  }> {
    normalizeAccount(requested, 'telegram');
    const bare = this.bareTelegramTgId(chatId);
    return {
      account: requested,
      source: 'message',
      candidates: bare ? [accountKey(requested, bare)] : [],
    };
  }

  private async handleTelegramGetMessages(args: {
    chatId: string;
    topicId?: number | string;
    limit?: number;
    offsetId?: number;
    account?: string;
  }) {
    const target = this.telegramTopicTarget(args.chatId, args.topicId);
    const id = await this.resolveTelegramChatId(target.chatId, normalizeAccount(args.account));
    if (!id)
      throw new McpError(
        ErrorCode.InvalidParams,
        `Could not resolve Telegram chatId '${args.chatId}'. Use 'tg_<numeric>' or numeric id.`
      );
    const limit = Math.min(args.limit ?? 50, 500);
    const params: any[] = [id, limit];
    let where = `conversation_id = $1 AND (is_deleted IS NULL OR is_deleted = false)`;
    if (args.offsetId) {
      params.push(args.offsetId);
      where += ` AND id < $3`;
    }
    where = this.appendTelegramTopicWhere(where, params, 1, target.topicId);
    const result = await this.dbClient.query(
      `SELECT id, conversation_id, sender_wa_id, direction, content, message_type,
              wa_timestamp, is_forwarded, is_edited, is_deleted, reply_to_message_id, metadata
         FROM messages
        WHERE ${where}
        ORDER BY wa_timestamp DESC
        LIMIT $2`,
      params
    );
    return this.jsonResponse({
      source: 'db',
      chatId: id,
      topicId: target.topicId ?? null,
      count: result.rows.length,
      messages: result.rows.map((m: any) => ({
        id: m.id,
        conversationId: m.conversation_id,
        senderId: m.sender_wa_id,
        direction: m.direction,
        content: m.content,
        type: m.message_type,
        timestamp: m.wa_timestamp,
        forwarded: m.is_forwarded,
        edited: m.is_edited,
        deleted: m.is_deleted,
        replyTo: m.reply_to_message_id,
        topicId:
          m.metadata?.topic_id ??
          m.metadata?.topicId ??
          m.metadata?.thread_id ??
          m.metadata?.threadId ??
          null,
        metadata: m.metadata,
      })),
    });
  }

  private async handleTelegramForwardMessage(args: {
    fromChatId: string;
    messageId: string;
    toChatId: string;
    threadId?: number | string;
    account?: string;
  }) {
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'POST',
      '/api/v1/messages/forward',
      {
        fromChatId: args.fromChatId,
        messageId: args.messageId,
        toChatId: args.toChatId,
        threadId: args.threadId,
      }
    );
    return this.jsonResponse(data);
  }

  private async handleTelegramDeleteMessage(args: {
    chatId: string;
    messageId: string;
    account?: string;
  }) {
    const account = normalizeAccount(args.account);
    const data = await this.classifiedConnectorCall(
      this.tgUrl(args.account),
      'DELETE',
      `/api/v1/messages/${args.chatId}/${args.messageId}`
    );
    const id = await this.resolveTelegramChatId(args.chatId, account);
    if (id && data?.deleted === true) {
      await this.dbClient.query(
        `UPDATE messages
            SET is_deleted = true,
                status = 'deleted',
                status_at = NOW()
          WHERE conversation_id = $1
            AND (
              wa_message_id = $2
              OR metadata->>'telegram_message_id' = $2
            )`,
        [id, String(args.messageId)]
      );
    }
    return this.jsonResponse(data);
  }

  /**
   * Edit one of our own Telegram text messages through the connector's POST
   * /messages/edit. The connector checks the message (ours, text), applies
   * its sending gate and publishes telegram.MessageEdited; telegram-sync
   * writes the row (replaced text kept in metadata.edit_history), so the MCP
   * writes nothing itself. Telegram's own limits come back as 422
   * rejected_by_telegram.
   */
  // CONTRACT: http.telegram-connector.messages-edit.v1
  private async handleTelegramEditMessage(args: {
    chatId: string;
    messageId: string;
    content: string;
    account?: string;
  }) {
    const account = normalizeAccount(args.account);
    const target = stripAccount(String(args.chatId).trim());
    if (target.account !== 'personal' && target.account !== account) {
      throw this.canonicalError(
        'invalid_request',
        `target belongs to the ${target.account} Telegram namespace but accountId is '${account}'`
      );
    }
    const { chatId } = this.telegramTopicTarget(args.chatId);
    const data = await this.classifiedConnectorCall(
      this.tgUrl(args.account),
      'POST',
      '/api/v1/messages/edit',
      {
        chatId,
        messageId: this.telegramMessageNumber(args.messageId, chatId, account),
        content: args.content,
        ...this.connectorActor(),
      }
    );
    return this.jsonResponse(data);
  }

  /** Set or clear ('' → null) our reaction through the Telegram connector's POST /messages/react. */
  private async handleTelegramReactMessage(args: {
    chatId: string;
    messageId: string;
    emoji: string;
    account?: string;
  }) {
    const account = normalizeAccount(args.account);
    const target = stripAccount(String(args.chatId).trim());
    if (target.account !== 'personal' && target.account !== account) {
      throw this.canonicalError(
        'invalid_request',
        `target belongs to the ${target.account} Telegram namespace but accountId is '${account}'`
      );
    }
    const { chatId } = this.telegramTopicTarget(args.chatId);
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'POST',
      '/api/v1/messages/react',
      {
        chatId,
        messageId: this.telegramMessageNumber(args.messageId, chatId, account),
        emoji: args.emoji || null,
      }
    );
    return this.jsonResponse(data);
  }

  /**
   * Telegram message id (per chat) from what a caller holds: the bare number
   * or the stored id `[<account>:]tg_<chat>_<msg>`, whose chat and account
   * must be the ones addressed.
   */
  private telegramMessageNumber(messageId: string, chatId: string, account: Account): number {
    const parsed = stripAccount(String(messageId).trim());
    if (parsed.account !== 'personal' && parsed.account !== account) {
      throw this.canonicalError(
        'invalid_request',
        `messageId belongs to the ${parsed.account} Telegram namespace but accountId is '${account}'`
      );
    }
    const stored = parsed.id.match(/^tg_(-?\d+)_(\d+)$/);
    if (stored && stored[1] !== chatId) {
      throw this.canonicalError(
        'invalid_request',
        `messageId ${messageId} belongs to Telegram chat ${stored[1]}, not ${chatId}`
      );
    }
    const raw = stored ? stored[2] : parsed.id;
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw this.canonicalError(
        'invalid_request',
        `messageId must be a Telegram message number or tg_<chat>_<message>, got '${messageId}'`
      );
    }
    return n;
  }

  private async handleTelegramMarkAsRead(args: { chatId: string; account?: string }) {
    const data = await this.connectorCall(
      this.tgUrl(args.account),
      'POST',
      `/api/v1/messages/read/${args.chatId}`
    );
    return this.jsonResponse(data);
  }

  private async handleTelegramGetDialogs(args?: { account?: string }) {
    const account = normalizeAccount(args?.account);
    const result = await this.dbClient.query(
      `SELECT c.id, c.external_id, c.name, c.type, c.is_group, c.last_message_at, c.metadata,
              (SELECT count(*)::int FROM messages
                WHERE conversation_id = c.id
                  AND (is_deleted IS NULL OR is_deleted = false)) AS message_count
         FROM conversations c
        WHERE c.account_id = $1 AND c.merged_into IS NULL
        ORDER BY c.last_message_at DESC NULLS LAST
        LIMIT 1000`,
      [socialAccountId('telegram', account)]
    );
    return this.jsonResponse({
      source: 'db',
      count: result.rows.length,
      dialogs: result.rows.map((c: any) => ({
        id: c.id,
        chatId: String(c.external_id).replace(/^tg_/, ''),
        name: c.name,
        type: c.is_group ? 'group' : 'private',
        lastMessageAt: c.last_message_at,
        messageCount: c.message_count,
        username: c.metadata?.username ?? null,
      })),
    });
  }

  private async handleTelegramGetUnread(args?: {
    limit?: number;
    only_with_unread?: boolean;
    account?: string;
  }) {
    const account = normalizeAccount(args?.account);
    const data = await this.getTelegramUnreadPayload(
      account,
      args?.limit ?? 200,
      args?.only_with_unread ?? true
    );
    return this.jsonResponse(data);
  }

  private async getTelegramUnreadPayload(
    account: Account,
    limit: number,
    onlyWithUnread: boolean
  ): Promise<any> {
    // Live unread state — fetched via telegram-sync (Telethon) over its
    // HMAC-authenticated bridge. The Node connector (gramJS) cannot read this
    // against current Telegram MTProto.
    const payload = {
      limit: Math.min(limit, 500),
      only_with_unread: onlyWithUnread,
    };
    const body = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', this.telegramBridgeSecret)
      .update(`${ts}:${body}`)
      .digest('hex');
    const resp = await fetch(`${this.tgBridgeUrl(account)}/unread`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Timestamp': ts,
        'X-Bridge-Signature': sig,
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      throw new Error(`telegram-sync /unread error ${resp.status}: ${await resp.text()}`);
    }
    return resp.json();
  }

  private async handleTelegramDownloadMedia(args: {
    chatId: string;
    messageId: string;
    account?: string;
  }) {
    const requested = normalizeAccount(args.account);
    const path = `/api/v1/messages/media/${encodeURIComponent(args.chatId)}/${encodeURIComponent(
      String(args.messageId)
    )}`;
    const data = await this.connectorCall(this.tgUrl(requested), 'GET', path);
    return this.jsonResponse(data);
  }

  private async handleTelegramGetStatus(args?: { account?: string }) {
    const data = await this.connectorCall(this.tgUrl(args?.account), 'GET', '/api/v1/status');
    return this.jsonResponse(data);
  }

  private async handleTelegramGetMe(args?: { account?: string }) {
    const data = await this.connectorCall(this.tgUrl(args?.account), 'GET', '/api/v1/me');
    return this.jsonResponse(data);
  }

  private secretForUrl(baseUrl: string): string {
    const entries = getAccounts().filter(a => a.connectorUrl === baseUrl);
    if (!entries.length) throw new Error('Connector URL is not registered');
    const secrets = [...new Set(entries.map(a => connectorSecretFor(a)))];
    if (secrets.length !== 1) throw new Error('Conflicting secrets for shared connector');
    return secrets[0];
  }

  private authHeaders(baseUrl: string): Record<string, string> {
    const secret = this.secretForUrl(baseUrl);
    const timestamp = Math.floor(Date.now() / 1000);
    return {
      Authorization: `Bearer ${secret}`,
      'X-Connector-Timestamp': String(timestamp),
      'X-Connector-Signature': generateHMACSignature({}, timestamp, secret),
    };
  }

  private signedConnectorHeaders(connectorUrl: string, timestamp: number, signature: string) {
    return {
      'Content-Type': 'application/json',
      ...this.authHeaders(connectorUrl),
      'X-Connector-Signature': signature,
      'X-Connector-Timestamp': timestamp.toString(),
      // SC-705: forward the verified caller identity to the connector.
      ...actorRequestHeaders(),
    };
  }

  /** Posts a WhatsApp message with a fresh timestamp and the selected account's secret. */
  private postWhatsAppMessage(
    connectorUrl: string,
    body: Record<string, unknown>,
    sharedSecret: string,
    idempotencyKey?: string
  ): Promise<Response> {
    return this.signedConnectorPost(
      connectorUrl,
      '/api/v1/messages/send',
      body,
      Math.floor(Date.now() / 1000),
      sharedSecret,
      idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}
    );
  }

  /** Sends a signed POST; each handler retains its status and result processing. */
  private signedConnectorPost(
    connectorUrl: string,
    path: string,
    body: Record<string, unknown>,
    timestamp: number,
    sharedSecret: string,
    extraHeaders: Record<string, string> = {}
  ): Promise<Response> {
    const signature = generateHMACSignature(body, timestamp, sharedSecret);
    return fetch(`${connectorUrl}${path}`, {
      method: 'POST',
      headers: {
        ...this.signedConnectorHeaders(connectorUrl, timestamp, signature),
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
  }

  private async connectorCall(
    baseUrl: string,
    method: string,
    path: string,
    body?: any,
    timeoutMs = 15000,
    extraHeaders: Record<string, string> = {}
  ): Promise<any> {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = body || {};
    const signature = generateHMACSignature(payload, timestamp, this.secretForUrl(baseUrl));

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...this.signedConnectorHeaders(baseUrl, timestamp, signature), ...extraHeaders },
      ...(method !== 'GET' && method !== 'DELETE' ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Connector error ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }

  private jsonResponse(data: any) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  }

  private async handleDownloadMedia(args: { chatId: string; messageId: string; account?: string }) {
    const data = await this.connectorCall(
      this.waUrl(args.account),
      'GET',
      `/api/v1/messages/media/${encodeURIComponent(
        bareWhatsAppJid(args.chatId)
      )}/${encodeURIComponent(args.messageId)}`
    );
    return this.jsonResponse(data);
  }

  private async handleSendFile(
    args: {
      conversationId: string;
      fileUrl: string;
      caption?: string;
      replyTo?: string;
      account?: string;
      fileName?: string;
      viewOnce?: boolean;
      quality?: 'hd';
      scopedSendToken?: string;
    },
    options?: { idempotencyKey?: string }
  ) {
    if (
      (!args.scopedSendToken && process.env.ENABLE_SENDING !== 'true') ||
      process.env.EMERGENCY_DISABLE_SENDING === 'true'
    ) {
      throw new McpError(ErrorCode.InvalidRequest, 'Sending disabled');
    }
    const { account: requestedAccount, scopedSendToken, ...rest } = args;
    const body = { ...rest, ...(scopedSendToken ? { sendToken: scopedSendToken } : {}) };
    const account = normalizeAccount(requestedAccount, 'whatsapp');
    body.conversationId = this.whatsAppProviderJid(body.conversationId, account, 'conversationId');
    if (isGroupJid(body.conversationId)) {
      // Group sends bypass the professional cold-send gate — parity with
      // handleSendMessage: group membership already implies established
      // context (no unsolicited first-contact), and the connector needs the
      // BARE `@g.us` jid on both accounts (an account prefix reaches
      // sock.groupMetadata() verbatim and times out).
    } else if (requireAccount('whatsapp', normalizeAccount(account)).requireInboundBeforeSend) {
      // Same cold-send guard as text sends: block first-contact media to a
      // professional chat with no prior inbound (Baileys account_restricted /
      // ban risk) and resolve the @lid-aware send jid. Mirrors handleSendMessage.
      body.conversationId = await this.requireProfessionalInboundChat(
        body.conversationId,
        {},
        normalizeAccount(account)
      );
    }
    const data = options?.idempotencyKey
      ? await this.connectorCall(
          this.waUrl(account),
          'POST',
          '/api/v1/messages/media/send',
          body,
          undefined,
          { 'Idempotency-Key': options.idempotencyKey }
        )
      : await this.connectorCall(this.waUrl(account), 'POST', '/api/v1/messages/media/send', body);
    return this.jsonResponse(data);
  }

  private async handleForwardMessage(args: {
    chatId: string;
    messageId: string;
    toChatId: string;
    account?: string;
  }) {
    if (process.env.ENABLE_SENDING !== 'true') {
      throw new McpError(ErrorCode.InvalidRequest, 'Sending disabled');
    }
    const { account: requestedAccount, ...body } = args;
    const account = normalizeAccount(requestedAccount, 'whatsapp');
    body.toChatId = this.whatsAppProviderJid(body.toChatId, account, 'toChatId');
    if (isGroupJid(body.toChatId)) {
      // Forwarding INTO a group bypasses the cold-send gate — same parity as
      // handleSendMessage/handleSendFile: membership implies established
      // context, and the connector needs the bare `@g.us` jid.
    } else if (requireAccount('whatsapp', normalizeAccount(account)).requireInboundBeforeSend) {
      // Gate the forward DESTINATION (toChatId) through the same inbound guard
      // as text/media sends — chatId is only the source we read from, so it
      // does not initiate contact. Resolves the @lid-aware send jid too.
      body.toChatId = await this.requireProfessionalInboundChat(
        body.toChatId,
        {},
        normalizeAccount(account)
      );
    }
    const data = await this.connectorCall(
      this.waUrl(account),
      'POST',
      '/api/v1/messages/forward',
      body
    );
    return this.jsonResponse(data);
  }

  /**
   * Delete for everyone (revoke) or, with forMe, only for this account through
   * the connector's POST /messages/delete (fase 3 / PR-3): ids travel inside
   * the HMAC-signed body, the connector
   * rebuilds the real key from its durable copies, applies ENABLE_SENDING and
   * flags the row (content kept). messageId may be bare or namespaced to this
   * account; another account's id is refused like a foreign target.
   */
  private async handleDeleteMessage(args: {
    chatId: string;
    messageId: string;
    account?: string;
    forMe?: boolean;
  }) {
    const data = await this.classifiedConnectorCall(
      this.waUrl(args.account),
      'POST',
      '/api/v1/messages/delete',
      {
        chatId: bareWhatsAppJid(args.chatId),
        messageId: this.bareWhatsAppMessageId(args.messageId, args.account),
        // forMe: only this account (WhatsApp app-state deleteForMe); absent = for everyone.
        ...(args.forMe ? { forMe: true } : {}),
        ...this.connectorActor(),
      }
    );
    return this.jsonResponse(data);
  }

  /**
   * Edit one of our own text messages through the connector's POST
   * /messages/edit (fase 3 / PR-3). Same id rules as handleDeleteMessage; the
   * connector applies ENABLE_SENDING, rebuilds the key and keeps the replaced
   * text in metadata.edit_history. WhatsApp's own limits (its edit window)
   * come back as 422 rejected_by_whatsapp.
   */
  private async handleEditMessage(args: {
    chatId: string;
    messageId: string;
    content: string;
    account?: string;
  }) {
    const data = await this.classifiedConnectorCall(
      this.waUrl(args.account),
      'POST',
      '/api/v1/messages/edit',
      {
        chatId: bareWhatsAppJid(args.chatId),
        messageId: this.bareWhatsAppMessageId(args.messageId, args.account),
        content: args.content,
        ...this.connectorActor(),
      }
    );
    return this.jsonResponse(data);
  }

  /** messageId bare or namespaced to `account`; another account's id is refused like a foreign target. */
  private bareWhatsAppMessageId(messageId: string, accountArg?: string): string {
    const account = normalizeAccount(accountArg);
    const parsed = stripAccount(messageId);
    if (parsed.account !== 'personal' && parsed.account !== account) {
      throw this.canonicalError(
        'invalid_request',
        `messageId belongs to the ${parsed.account} WhatsApp namespace but accountId is '${account}'`
      );
    }
    return parsed.id;
  }

  /** The caller recorded by the connector (never used for auth). */
  private connectorActor(): { actor?: string } {
    const actor = getRequestActor();
    return actor.name || actor.sub ? { actor: actor.name || actor.sub } : {};
  }

  private async handleGetMe(args?: { account?: string }) {
    const data = await this.connectorCall(this.waUrl(args?.account), 'GET', '/api/v1/me');
    return this.jsonResponse(data);
  }

  private async handleGetUnreadChats(args?: { account?: string }) {
    const account = normalizeAccount(args?.account);
    // The connector live store can be stale/empty after WhatsApp Web conflict
    // reconnects, and enumerating live chats can block. Use persisted unread
    // counters as the primary source so agents answer fast and do not report a
    // false zero when the live Baileys store is empty.
    return this.jsonResponse(
      await this.getUnreadWhatsAppChatsFromDb(account, 'database unread counters')
    );
  }

  private async getUnreadWhatsAppChatsFromDb(account: Account, reason: string) {
    const result = await this.dbClient.query(
      `SELECT c.id, c.external_id, c.name, c.type, c.is_group, c.unread_count, c.last_message_at
         FROM conversations c
        WHERE c.account_id = $1
          AND c.merged_into IS NULL
          AND COALESCE(c.unread_count, 0) > 0
          AND regexp_replace(c.id, '^[a-z][a-z0-9_-]*:', '') NOT LIKE 'tg_%'
          AND (
            regexp_replace(c.id, '^[a-z][a-z0-9_-]*:', '') LIKE '%@%'
            OR regexp_replace(COALESCE(c.wa_chat_id, ''), '^[a-z][a-z0-9_-]*:', '') LIKE '%@%'
            OR EXISTS (
              SELECT 1
                FROM messages m
               WHERE m.conversation_id = c.id
                 AND m.account = $1
                 AND m.platform = 'whatsapp'
               LIMIT 1
            )
          )
        ORDER BY c.unread_count DESC, c.last_message_at DESC NULLS LAST
        LIMIT 200`,
      [socialAccountId('whatsapp', account)]
    );

    return {
      source: 'database-fallback',
      reason,
      totalResults: result.rows.length,
      chats: result.rows.map(row => ({
        id: row.id,
        waChatId: row.external_id,
        name: row.name,
        unreadCount: Number(row.unread_count || 0),
        isGroup: Boolean(row.is_group),
        type: row.type || (row.is_group ? 'GROUP' : 'INDIVIDUAL'),
        lastMessageAt: row.last_message_at?.toISOString?.() || row.last_message_at || null,
      })),
    };
  }

  // Live-connector unread enumeration. Retained as the data source for
  // social_start_digest (collectUnreadDigestChats); canonical conversation reads
  // now prefers persisted db counters via handleGetUnreadChats above.
  private async getWhatsAppUnreadPayload(account: Account, limit: number): Promise<any> {
    // The whatsapp-web.js connector enumerates every chat to compute unread —
    // can be slow on accounts with hundreds of chats. Cap at 8s so we don't
    // hang the SSE client; surface a clear error if the connector is too slow
    // (the user can fall back to social_list_conversations / social_list_messages).
    try {
      const data = await this.connectorCall(
        this.waUrl(account),
        'GET',
        '/api/v1/chats/unread',
        undefined,
        8000
      );
      const chats = extractArrayPayload(data, ['chats', 'unreadChats', 'conversations', 'results']);
      return {
        ...asObject(data),
        chats: chats.slice(0, limit),
        count: Math.min(chats.length, limit),
      };
    } catch (e: any) {
      const reason = e?.name === 'TimeoutError' ? 'timeout after 8s' : e?.message || String(e);
      throw new McpError(
        ErrorCode.InternalError,
        `WhatsApp unread query failed (${reason}). Try social_list_conversations(limit=20) or social_list_messages for specific contacts instead.`
      );
    }
  }

  private async handleUnreadDigest(args?: {
    action?: 'start' | 'continue' | 'status';
    digestId?: string;
    platforms?: string[];
    batchSize?: number;
    maxChats?: number;
    messageLimit?: number;
    language?: string;
    account?: string;
  }) {
    const action = args?.action || (args?.digestId ? 'continue' : 'start');
    const digestId = String(args?.digestId || '').trim();
    const batchSize = clampInteger(args?.batchSize, 5, 1, 10);

    if (action === 'continue') {
      if (!digestId) {
        throw new McpError(ErrorCode.InvalidRequest, 'digestId is required for continue');
      }
      return this.jsonResponse(await this.unreadDigestService.continue(digestId, batchSize));
    }

    if (action === 'status') {
      if (!digestId) {
        throw new McpError(ErrorCode.InvalidRequest, 'digestId is required for status');
      }
      return this.jsonResponse(await this.unreadDigestService.status(digestId));
    }

    const account = normalizeAccount(args?.account);
    const platforms = normalizeDigestPlatforms(args?.platforms);
    const maxChats = clampInteger(args?.maxChats, 50, 1, 100);
    const messageLimit = clampInteger(args?.messageLimit, 30, 5, 100);
    const language: DigestLanguage = args?.language === 'en' ? 'en' : 'es';
    const { chats, warnings } = await this.collectUnreadDigestChats(account, platforms, maxChats);

    return this.jsonResponse(
      await this.unreadDigestService.start(
        {
          account,
          platforms,
          batchSize,
          messageLimit,
          language,
        },
        chats,
        warnings
      )
    );
  }

  private async collectUnreadDigestChats(
    account: Account,
    platforms: MessagingPlatform[],
    maxChats: number
  ): Promise<{ chats: UnreadDigestChat[]; warnings: string[] }> {
    const chats: UnreadDigestChat[] = [];
    const warnings: string[] = [];
    const perPlatformLimit = maxChats;

    if (platforms.includes('whatsapp')) {
      try {
        const payload = await this.getWhatsAppUnreadPayload(account, perPlatformLimit);
        for (const chat of extractArrayPayload(payload, [
          'chats',
          'unreadChats',
          'conversations',
          'results',
        ])) {
          const chatId = stripAccount(
            pickString(chat, ['chatId', 'waChatId', 'waUserId', 'conversationId', 'id', 'jid'])
          ).id;
          if (!chatId) continue;
          chats.push({
            platform: 'whatsapp',
            account,
            chatId,
            dbConversationId: accountKey(account, chatId),
            name:
              pickString(chat, ['name', 'displayName', 'pushName', 'contactName', 'title']) || null,
            unreadCount: pickNumber(chat, ['unreadCount', 'unread_count'], 0),
            isGroup: Boolean(chat?.isGroup) || /@g\.us$/i.test(chatId),
            source: 'whatsapp-unread',
            metadata: isObject(chat) ? chat : {},
          });
        }
      } catch (error) {
        warnings.push(`WhatsApp unread failed for ${account}: ${safeError(error)}`);
      }
    }

    if (platforms.includes('telegram')) {
      try {
        const payload = await this.getTelegramUnreadPayload(account, perPlatformLimit, true);
        for (const dialog of extractArrayPayload(payload, [
          'dialogs',
          'chats',
          'results',
          'unread',
        ])) {
          const rawId = pickString(dialog, ['id', 'chatId', 'dialogId', 'peerId']);
          if (!rawId) continue;
          const bareId = stripAccount(rawId).id;
          const chatId = bareId.startsWith('tg_') ? bareId : `tg_${bareId}`;
          chats.push({
            platform: 'telegram',
            account,
            chatId,
            dbConversationId: accountKey(account, chatId),
            name: pickString(dialog, ['name', 'title', 'displayName']) || null,
            unreadCount: pickNumber(dialog, ['unread_count', 'unreadCount'], 0),
            isGroup:
              Boolean(dialog?.is_group) ||
              Boolean(dialog?.isGroup) ||
              String(dialog?.type || '').includes('group'),
            source: 'telegram-unread',
            metadata: isObject(dialog) ? dialog : {},
          });
        }
      } catch (error) {
        warnings.push(`Telegram unread failed for ${account}: ${safeError(error)}`);
      }
    }

    const seen = new Set<string>();
    const deduped = chats
      .filter(chat => {
        const key = `${chat.platform}:${chat.dbConversationId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.unreadCount - a.unreadCount)
      .slice(0, maxChats);

    if (deduped.length === 0 && warnings.length === 0) {
      warnings.push(`No unread chats found for ${account} (${platforms.join(', ')}).`);
    }
    return { chats: deduped, warnings };
  }

  private async handleGetGroupInfo(args: { groupId: string; account?: string }) {
    const data = await this.connectorCall(
      this.waUrl(args.account),
      'GET',
      `/api/v1/groups/${bareWhatsAppJid(args.groupId)}/info`
    );
    return this.jsonResponse(data);
  }

  private async handleGetGroupParticipants(args: { groupId: string; account?: string }) {
    const data = await this.connectorCall(
      this.waUrl(args.account),
      'GET',
      `/api/v1/groups/${bareWhatsAppJid(args.groupId)}/participants`
    );
    return this.jsonResponse(data);
  }

  private async handleRepairGroupSession(args: { groupId: string; account?: string }) {
    const data = await this.connectorCall(
      this.waUrl(args.account),
      'POST',
      `/api/v1/groups/${bareWhatsAppJid(args.groupId)}/session/repair`,
      {},
      120000
    );
    return this.jsonResponse(data);
  }

  private async handleMarkAsRead(args: { chatId?: string; messageId?: string; account?: string }) {
    const account = normalizeAccount(args.account);
    // Both accounts are Baileys (WhatsApp Web): mark the whole chat read by chatId.
    if (!args.chatId) {
      throw new McpError(ErrorCode.InvalidParams, 'social_mark_read requires target.');
    }
    const data = await this.connectorCall(
      this.waUrl(account),
      'POST',
      `/api/v1/messages/read/${encodeURIComponent(bareWhatsAppJid(args.chatId))}`
    );
    return this.jsonResponse(data);
  }

  private async handleMessagingStatus() {
    const targets = getAccounts().map(
      a =>
        [
          a.channel,
          a.accountId,
          a.connectorUrl || (a.channel === 'instagram' ? this.instagramBaseUrl() : undefined),
          a.channel === 'whatsapp' ? '/api/v1/health' : '/health',
        ] as const
    );
    const checks = await Promise.all(
      targets.map(async ([kind, account, url, endpoint]) => {
        try {
          if (!url) throw new Error('Connector URL is not configured');
          const resp = await fetch(`${url}${endpoint}`, {
            headers:
              kind === 'instagram'
                ? {
                    Authorization: `Bearer ${connectorSecretFor(requireAccount('instagram', account))}`,
                    ...actorRequestHeaders(),
                  }
                : this.authHeaders(url),
            signal: AbortSignal.timeout(3000),
          });
          if (!resp.ok) throw new Error(`Health HTTP ${resp.status}`);
          const body = await resp.json();
          return [kind, account, body] as const;
        } catch (e: any) {
          const reason = e?.name === 'TimeoutError' ? 'timeout after 3s' : e?.message || String(e);
          return [kind, account, { status: 'unreachable', error: reason }] as const;
        }
      })
    );
    const results: any = {};
    for (const [kind, account, body] of checks) {
      if (kind === 'instagram') {
        results.instagram = results.instagram || { accounts: {} };
        const statusBody = asObject(body);
        // /health resolves credentials for the verified actor. Keep only this
        // configured account when several accounts share one connector.
        results.instagram.accounts[account] = isObject(statusBody.accounts)
          ? statusBody.accounts[account] || {
              status: 'no_credential',
              error: 'no_instagram_credential',
              message: 'No Instagram credential for this user',
            }
          : body;
        continue;
      }
      if (account === 'default') {
        results[kind] = body;
      } else {
        results[kind] = results[kind] || {};
        results[kind][account] = body;
      }
    }
    return this.jsonResponse(results);
  }

  private async handleTelegramSearch(args: {
    query: string;
    chatId?: string;
    topicId?: number | string;
    limit?: number;
    account?: string;
    mediaType?: MediaType;
  }) {
    const account = normalizeAccount(args.account);
    const limit = Math.min(args.limit ?? 20, 200);
    const params: any[] = [`%${args.query}%`, limit, account];
    let where = `platform = 'telegram' AND account = $3 AND content ILIKE $1`;
    const messageTypes = messageTypesFor(args.mediaType);
    if (messageTypes) {
      params.push(messageTypes);
      where += mediaTypePredicate('', params.length);
    }
    let topicId: number | undefined;
    if (args.chatId) {
      const target = this.telegramTopicTarget(args.chatId, args.topicId);
      topicId = target.topicId;
      const id = await this.resolveTelegramChatId(target.chatId, account);
      if (!id)
        throw new McpError(
          ErrorCode.InvalidParams,
          `Could not resolve Telegram chatId '${args.chatId}'`
        );
      params.push(id);
      const conversationParam = params.length;
      where += ` AND conversation_id = $${conversationParam}`;
      where = this.appendTelegramTopicWhere(where, params, conversationParam, topicId);
    } else if (args.topicId !== undefined) {
      throw new McpError(ErrorCode.InvalidParams, 'topicId requires chatId');
    }
    const result = await this.dbClient.query(
      `SELECT id, conversation_id, sender_wa_id, direction, content, message_type, wa_timestamp,
              reply_to_message_id, metadata
         FROM messages WHERE ${where}
        ORDER BY wa_timestamp DESC LIMIT $2`,
      params
    );
    return this.jsonResponse({
      source: 'db',
      query: args.query,
      topicId: topicId ?? null,
      count: result.rows.length,
      messages: result.rows.map((m: any) => ({
        id: m.id,
        conversationId: m.conversation_id,
        senderId: m.sender_wa_id,
        direction: m.direction,
        content: m.content,
        messageType: m.message_type ?? null,
        timestamp: m.wa_timestamp,
        replyTo: m.reply_to_message_id,
        topicId:
          m.metadata?.topic_id ??
          m.metadata?.topicId ??
          m.metadata?.thread_id ??
          m.metadata?.threadId ??
          null,
      })),
    });
  }

  private async handleTelegramChatInfo(args: { chatId: string; account?: string }) {
    const id = await this.resolveTelegramChatId(args.chatId, normalizeAccount(args.account));
    if (!id)
      throw new McpError(
        ErrorCode.InvalidParams,
        `Could not resolve Telegram chatId '${args.chatId}'`
      );
    const result = await this.dbClient.query(
      `SELECT id, external_id, name, type, is_group, participant_count, last_message_at, metadata,
              (SELECT count(*)::int FROM messages
                WHERE conversation_id = c.id
                  AND (is_deleted IS NULL OR is_deleted = false)) AS message_count
         FROM conversations c WHERE id = $1`,
      [id]
    );
    if (!result.rows.length)
      throw new McpError(ErrorCode.InvalidParams, `Telegram chat '${id}' not found in DB`);
    const c = result.rows[0];
    return this.jsonResponse({
      source: 'db',
      id: c.id,
      chatId: String(c.external_id).replace(/^tg_/, ''),
      name: c.name,
      type: c.is_group ? 'group' : 'private',
      participantCount: c.participant_count,
      lastMessageAt: c.last_message_at,
      messageCount: c.message_count,
      metadata: c.metadata,
    });
  }

  private async handleTelegramParticipants(args: {
    chatId: string;
    limit?: number;
    account?: string;
  }) {
    const id = await this.resolveTelegramChatId(args.chatId, normalizeAccount(args.account));
    if (!id)
      throw new McpError(
        ErrorCode.InvalidParams,
        `Could not resolve Telegram chatId '${args.chatId}'`
      );
    const limit = Math.min(args.limit ?? 100, 500);
    const result = await this.dbClient.query(
      `SELECT cp.participant_id, cp.role, p.name, p.push_name, p.phone, p.metadata
         FROM conversation_participants cp
         LEFT JOIN participants p ON p.id = cp.participant_id
        WHERE cp.conversation_id = $1
        LIMIT $2`,
      [id, limit]
    );
    return this.jsonResponse({
      source: 'db',
      chatId: id,
      count: result.rows.length,
      participants: result.rows.map((r: any) => ({
        id: r.participant_id,
        name: r.name || r.push_name,
        phone: r.phone,
        role: r.role,
        metadata: r.metadata,
      })),
    });
  }

  // === Instagram handlers ===

  private instagramBaseUrl(): string {
    return (
      this.instagramUrl || process.env.INSTAGRAM_CONNECTOR_URL || 'http://instagram-connector:3003'
    );
  }

  private async instagramCall(method: string, path: string, body?: any, timeoutMs = 30000) {
    // Pairing precedes an account credential; its route uses the shared connector.
    const account = path.startsWith('/api/v1/oauth/')
      ? undefined
      : requireAccount('instagram', decodeURIComponent(path.split('/')[3] || ''));
    const secret = account ? connectorSecretFor(account) : process.env.CONNECTOR_SHARED_SECRET;
    if (!secret) throw new Error('Missing connector secret for Instagram pairing');
    const url = `${account?.connectorUrl || this.instagramBaseUrl()}${path}`;
    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
        ...actorRequestHeaders(),
      },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body) options.body = JSON.stringify(body);
    const resp = await fetch(url, options);
    if (!resp.ok) throw new Error(`Instagram API error (${resp.status}): ${await resp.text()}`);
    return resp.json();
  }

  private async handleInstagramGetProfile(args: { account: string }) {
    const data = await this.instagramCall('GET', `/api/v1/${args.account}/profile`);
    return this.jsonResponse(data);
  }

  private async handleInstagramGetMedia(args: { account: string; limit?: number }) {
    const data = await this.instagramCall(
      'GET',
      `/api/v1/${args.account}/media?limit=${args.limit || 25}`
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramGetComments(args: { account: string; mediaId: string }) {
    const data = await this.instagramCall(
      'GET',
      `/api/v1/${args.account}/media/${args.mediaId}/comments`
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramReplyComment(args: {
    account: string;
    commentId: string;
    message: string;
  }) {
    const data = await this.instagramCall(
      'POST',
      `/api/v1/${args.account}/comments/${args.commentId}/reply`,
      { message: args.message }
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramGetConversations(args: { account: string; limit?: number }) {
    const data = await this.instagramCall(
      'GET',
      `/api/v1/${args.account}/conversations?limit=${args.limit || 20}`
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramSendDm(args: {
    account: string;
    recipientId: string;
    message: string;
  }) {
    const data = await this.instagramCall('POST', `/api/v1/${args.account}/messages/send`, {
      recipient_id: args.recipientId,
      message: args.message,
    });
    return this.jsonResponse(data);
  }

  private async handleInstagramGetStories(args: { account: string }) {
    const data = await this.instagramCall('GET', `/api/v1/${args.account}/stories`);
    return this.jsonResponse(data);
  }

  private async handleInstagramPublish(args: {
    account: string;
    imageUrl: string;
    caption: string;
    mediaType?: string;
  }) {
    const data = await this.instagramCall('POST', `/api/v1/${args.account}/publish`, {
      image_url: args.imageUrl,
      caption: args.caption,
      media_type: args.mediaType || 'IMAGE',
    });
    return this.jsonResponse(data);
  }

  private async handleInstagramMediaInsights(args: { account: string; mediaId: string }) {
    const data = await this.instagramCall(
      'GET',
      `/api/v1/${args.account}/media/${args.mediaId}/insights`
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramPublishCarousel(args: {
    account: string;
    items: string[];
    caption?: string;
  }) {
    const data = await this.instagramCall(
      'POST',
      `/api/v1/${args.account}/publish/carousel`,
      { items: args.items, caption: args.caption },
      120000
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramPublishReel(args: {
    account: string;
    videoUrl: string;
    caption?: string;
    shareToFeed?: boolean;
  }) {
    const data = await this.instagramCall(
      'POST',
      `/api/v1/${args.account}/publish/reel`,
      { video_url: args.videoUrl, caption: args.caption, share_to_feed: args.shareToFeed ?? true },
      120000
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramPublishStory(args: {
    account: string;
    imageUrl?: string;
    videoUrl?: string;
  }) {
    const data = await this.instagramCall(
      'POST',
      `/api/v1/${args.account}/publish/story`,
      { image_url: args.imageUrl, video_url: args.videoUrl },
      120000
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramPostComment(args: {
    account: string;
    mediaId: string;
    message: string;
  }) {
    const data = await this.instagramCall(
      'POST',
      `/api/v1/${args.account}/media/${args.mediaId}/comments`,
      { message: args.message }
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramHideComment(args: {
    account: string;
    commentId: string;
    hide?: boolean;
  }) {
    const data = await this.instagramCall(
      'POST',
      `/api/v1/${args.account}/comments/${args.commentId}/hide`,
      { hide: args.hide ?? true }
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramDeleteComment(args: { account: string; commentId: string }) {
    const data = await this.instagramCall(
      'DELETE',
      `/api/v1/${args.account}/comments/${args.commentId}`
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramGetAccountInsights(args: {
    account: string;
    metrics?: string[];
    period?: string;
  }) {
    const params = new URLSearchParams();
    if (args.metrics?.length) params.set('metrics', args.metrics.join(','));
    if (args.period) params.set('period', args.period);
    const qs = params.toString();
    const data = await this.instagramCall(
      'GET',
      `/api/v1/${args.account}/insights${qs ? `?${qs}` : ''}`
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramGetAccountPages(args: { account: string }) {
    const data = await this.instagramCall('GET', `/api/v1/${args.account}/pages`);
    return this.jsonResponse(data);
  }

  private async handleInstagramGetContentPublishingLimit(args: { account: string }) {
    const data = await this.instagramCall('GET', `/api/v1/${args.account}/publishing-limit`);
    return this.jsonResponse(data);
  }

  private async handleInstagramGetHashtagMedia(args: {
    account: string;
    hashtagId: string;
    mediaType?: 'top' | 'recent';
    limit?: number;
  }) {
    const qs = new URLSearchParams({
      media_type: args.mediaType ?? 'top',
      limit: String(args.limit ?? 25),
    }).toString();
    const data = await this.instagramCall(
      'GET',
      `/api/v1/${args.account}/hashtag/${args.hashtagId}/media?${qs}`
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramSearchHashtag(args: { account: string; hashtag: string }) {
    const qs = new URLSearchParams({ q: args.hashtag.replace(/^#/, '') }).toString();
    const data = await this.instagramCall('GET', `/api/v1/${args.account}/hashtag/search?${qs}`);
    return this.jsonResponse(data);
  }

  private async handleInstagramBusinessDiscovery(args: { account: string; username: string }) {
    const qs = new URLSearchParams({ username: args.username }).toString();
    const data = await this.instagramCall(
      'GET',
      `/api/v1/${args.account}/business-discovery?${qs}`
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramGetMentions(args: { account: string; limit?: number }) {
    const data = await this.instagramCall(
      'GET',
      `/api/v1/${args.account}/mentions?limit=${args.limit ?? 25}`
    );
    return this.jsonResponse(data);
  }

  private async handleInstagramValidateAccessToken(args: { account: string }) {
    const data = await this.instagramCall('GET', `/api/v1/${args.account}/token/validate`);
    return this.jsonResponse(data);
  }

  private async handleInstagramGetConversationMessages(args: {
    account: string;
    conversationId: string;
    limit?: number;
  }) {
    const data = await this.instagramCall(
      'GET',
      `/api/v1/${args.account}/conversations/${args.conversationId}/messages?limit=${args.limit ?? 25}`
    );
    return this.jsonResponse(data);
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.logger.info('MCP Server started (stdio)');
  }

  /** Returns the underlying MCP Server instance for SSE transport use */
  getServer(): Server {
    return this.server;
  }

  /**
   * Returns a FRESH, isolated MCP Server bound to the shared services, for the
   * Streamable-HTTP transport. Each HTTP session must get its own Server so the
   * SDK Protocol._transport routes responses to the right client (the legacy SSE
   * path shares a single Server and only routes correctly for one live client).
   * setupHandlers() only registers handlers on this.server, and those handlers
   * close over the shared services (db/redis/openai), so the swap below is cheap
   * and side-effect free.
   */
  createSessionServer(): Server {
    const prev = this.server;
    const fresh = new Server(
      { name: 'socialmedia-mcp-server', version: '2.0.0' },
      { capabilities: { tools: {} } }
    );
    this.server = fresh;
    this.setupHandlers();
    this.server = prev;
    return fresh;
  }
}
