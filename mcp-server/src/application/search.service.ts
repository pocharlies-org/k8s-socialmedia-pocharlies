import { Pool } from 'pg';
import pino from 'pino';
import { accountKey, stripAccount, type Account } from '../domain/account';
import { accountNamespaces, brainInstanceForNamespace } from '../domain/account-registry';
import { mediaTypePredicate, messageTypesFor, type MediaType } from './media-type-filter';

export interface SearchResult {
  messageId: string;
  conversationId: string;
  content: string;
  senderWaId: string;
  waTimestamp: Date;
  similarity?: number;
  rank?: number;
  platform: string;
  account: string;
  messageType?: string;
}

export interface SearchOptions {
  chatId?: string;
  from?: Date;
  to?: Date;
  sender?: string;
  limit?: number;
  /** Account scope (personal|professional|leila). Defaults to personal. */
  account?: Account;
  platform?: 'whatsapp' | 'telegram' | 'instagram';
  /** image|video|audio|document|sticker|any (see media-type-filter). */
  mediaType?: MediaType;
  /**
   * chatId/sender are stored ids, matched as given. Instagram ids
   * (`ig_<account>_…`) carry their account and are never namespace-prefixed.
   */
  rawIds?: boolean;
}

export const MAX_SEARCH_LIMIT = 100;

/** 1..100, default 20: an unbounded LIMIT ranks and ships every match. */
export function searchLimit(limit: unknown): number {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n < 1) return 20;
  return Math.min(n, MAX_SEARCH_LIMIT);
}

/**
 * Semantic search lives in the brain (INFRA-486/487, Dani 04-10-2026): one
 * vector index for the WhatsApp/Telegram conversations, the Qdrant collections
 * that `brain-windows` already feeds (ADR 0002). This service no longer embeds
 * anything: it asks `POST /instances/{instance}/search` for the conversation
 * chunks that match, scoped to the tool's account/channel/chat/dates, and
 * resolves their `message_ids` against `messages` here, where the filters the
 * brain does not have (sender, mediaType, deletions, the exact time window) live.
 */
export interface BrainSearchConfig {
  url: string;
  apiKey: string;
  timeoutMs: number;
  /**
   * Relevance floor on the brain's score: the raw logit of its reranker
   * (bge-reranker-v2-m3), not a 0..1 similarity. Below it a chunk is noise and
   * the search falls through to keyword search.
   */
  minScore: number;
}

/** A conversation chunk is stamped with its first message (`observed_at`):
 *  one that starts before `from` can still hold messages after it. The brain
 *  is asked a day earlier and the exact cut is applied per message here. */
const CHUNK_WINDOW_SLACK_MS = 24 * 60 * 60 * 1000;
/** The brain caps a search at 50 hits (`/search` top-k). */
const BRAIN_MAX_HITS = 50;

function envNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(n) ? n : fallback;
}

/**
 * The brain only opens messaging conversations to its scoped messaging key
 * (`BRAIN_MESSAGING_SEARCH_KEY`, INFRA-487): `/search` only, the messaging
 * instances only, always with an account. The shared key cannot lift the
 * `skirmshop` audience filter nor read `leila`, so without the scoped key there
 * is no semantic search, and the tool says so instead of half-working.
 */
export function brainSearchConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): BrainSearchConfig | null {
  const url = (env.BRAIN_SEARCH_URL || '').trim().replace(/\/+$/, '');
  const apiKey = (env.BRAIN_MESSAGING_SEARCH_KEY || '').trim();
  if (!url || !apiKey) return null;
  return {
    url,
    apiKey,
    timeoutMs: envNumber(env.BRAIN_SEARCH_TIMEOUT_MS, 10000),
    minScore: envNumber(env.SEMANTIC_MIN_SCORE, DEFAULT_SEMANTIC_MIN_SCORE),
  };
}

/**
 * Measured 04-10-2026 against prod (scoped chunk searches, brain-39c0788):
 * on-topic queries score +0.8..+3.5 at the top; the hard paraphrase «el gestor
 * de contraseñas no me deja acceder a mis claves» finds its 1Password chunks at
 * -2.3 (first) and -4.9; nonsense («xqzv plorf bandurria…») tops out at -6.7
 * (professional) and -7.8 (personal). -5 keeps the paraphrase and drops the noise.
 */
export const DEFAULT_SEMANTIC_MIN_SCORE = -5;

interface BrainScope {
  instance: string;
  account: Account;
  conversationIds?: string[];
}

interface BrainChunk {
  /** The scope's account: with `messageIds` it is the key of the row it ranks. */
  account: string;
  score: number;
  messageIds: string[];
}

export type SearchMode = 'semantic' | 'text';

/** One brain instance that could not be asked, named by the account it serves. */
export interface SearchFailure {
  accountId: string;
  message: string;
}

export interface SearchOutcome {
  results: SearchResult[];
  mode: SearchMode;
  /** Semantic answered, but these accounts' instances did not (`meta.partialErrors`). */
  partialErrors?: SearchFailure[];
  /** Why the keyword branch answered: no semantic match, or the brain failed. */
  fallbackReason?: string;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class SearchService {
  private dbClient: Pool;
  private logger: pino.Logger;
  private readonly brain: BrainSearchConfig | null;
  private readonly fetchImpl: FetchLike;

  constructor(
    dbClient: Pool,
    brain: BrainSearchConfig | null = brainSearchConfigFromEnv(),
    fetchImpl: FetchLike = (url, init) => fetch(url, init)
  ) {
    this.dbClient = dbClient;
    this.brain = brain;
    this.fetchImpl = fetchImpl;
    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
    this.logger.info(
      brain
        ? `SearchService: búsqueda semántica en el brain ${brain.url} (corte ${brain.minScore})`
        : 'SearchService: BRAIN_SEARCH_URL o BRAIN_MESSAGING_SEARCH_KEY sin configurar, solo búsqueda de texto'
    );
  }

  /**
   * Performs keyword search using PostgreSQL Full Text Search
   */
  async keywordSearch(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { chatId, from, to, sender } = options;
    const limit = searchLimit(options.limit);

    let sql = `
      SELECT 
        m.id as message_id,
        m.conversation_id,
        m.content,
        m.sender_wa_id,
        m.wa_timestamp,
        m.platform,
        m.account,
        m.message_type,
        ts_rank(to_tsvector('english', m.content), plainto_tsquery('english', $1)) as rank
      FROM messages m
      WHERE to_tsvector('english', m.content) @@ plainto_tsquery('english', $1)
        AND (m.is_deleted IS NULL OR m.is_deleted = false)
    `;

    const params: unknown[] = [query];
    let paramIndex = 2;

    if (chatId) {
      if (options.rawIds) {
        sql += ` AND m.conversation_id = $${paramIndex}`;
        params.push(chatId);
      } else if (options.account) {
        sql += ` AND m.conversation_id = $${paramIndex}`;
        params.push(accountKey(options.account, chatId));
      } else {
        sql += ` AND m.conversation_id = ANY($${paramIndex}::text[])`;
        params.push(inEveryNamespace(chatId));
      }
      paramIndex++;
    }

    if (from) {
      sql += ` AND m.wa_timestamp >= $${paramIndex}`;
      params.push(from);
      paramIndex++;
    }

    if (to) {
      sql += ` AND m.wa_timestamp <= $${paramIndex}`;
      params.push(to);
      paramIndex++;
    }

    if (sender) {
      if (options.rawIds) {
        sql += ` AND m.sender_wa_id = $${paramIndex}`;
        params.push(sender);
      } else if (options.account) {
        sql += ` AND m.sender_wa_id = $${paramIndex}`;
        params.push(accountKey(options.account, sender));
      } else {
        sql += ` AND m.sender_wa_id = ANY($${paramIndex}::text[])`;
        params.push(inEveryNamespace(sender));
      }
      paramIndex++;
    }

    if (options.account) {
      sql += ` AND m.account = $${paramIndex}`;
      params.push(options.account);
      paramIndex++;
    }
    if (options.platform) {
      sql += ` AND m.platform = $${paramIndex}`;
      params.push(options.platform);
      paramIndex++;
    }
    const messageTypes = messageTypesFor(options.mediaType);
    if (messageTypes) {
      sql += mediaTypePredicate('m', paramIndex);
      params.push(messageTypes);
      paramIndex++;
    }

    sql += ` ORDER BY rank DESC, m.wa_timestamp DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await this.dbClient.query(sql, params);

    return result.rows.map(row => ({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      content: row.content || '',
      senderWaId: row.sender_wa_id,
      waTimestamp: row.wa_timestamp,
      rank: parseFloat(row.rank),
      platform: row.platform,
      account: row.account,
      messageType: row.message_type,
    }));
  }

  /**
   * Semantic search in the brain (INFRA-486): the conversation chunks that
   * match, scoped to the tool's filters, resolved to the messages they hold.
   *
   * Every hit is a chunk of 3-8 consecutive messages (ADR 0002 §2): its messages
   * come back in chunk order (best first) and, inside a chunk, in time order,
   * each with the chunk's score as `similarity`. Throws if the brain cannot be
   * asked at all; one instance failing does not fail the others: it comes back in
   * `failures`, so `searchDetailed` can say what is missing or why it fell back.
   */
  async semanticSearch(
    query: string,
    options: SearchOptions = {}
  ): Promise<{ results: SearchResult[]; failures: SearchFailure[] }> {
    if (!this.brain)
      throw new Error('BRAIN_SEARCH_URL o BRAIN_MESSAGING_SEARCH_KEY sin configurar');
    // Instagram does not go through brain-windows: there are no chunks to find.
    if (options.platform === 'instagram') return { results: [], failures: [] };
    const limit = searchLimit(options.limit);
    const scopes = this.brainScopes(options);
    if (!scopes.length) return { results: [], failures: [] };

    const settled = await Promise.allSettled(
      scopes.map(scope => this.askBrain(query, scope, options, limit))
    );
    const failures: SearchFailure[] = [];
    const perScope: BrainChunk[][] = [];
    settled.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled') perScope.push(outcome.value);
      else
        failures.push({
          accountId: scopes[i].account,
          message: (outcome.reason as Error)?.message || String(outcome.reason),
        });
    });
    const chunks = perScope
      .flat()
      .filter(c => c.score >= (this.brain as BrainSearchConfig).minScore)
      .sort((a, b) => b.score - a.score);
    if (!chunks.length) return { results: [], failures };

    // The key carries the account: a row only ranks under the scope whose chunk named it.
    const rankKey = (account: string, id: string) => `${account}\u0000${id}`;
    const best = new Map<string, { score: number; order: number; id: string }>();
    chunks.forEach((chunk, order) => {
      for (const id of chunk.messageIds) {
        const key = rankKey(chunk.account, id);
        if (!best.has(key)) best.set(key, { score: chunk.score, order, id });
      }
    });
    const rows = await this.messagesById([...new Set([...best.values()].map(b => b.id))], options);
    const results = rows
      .flatMap(row => {
        const rank = best.get(rankKey(row.account, row.wa_message_id));
        return rank ? [{ row, rank }] : [];
      })
      .sort(
        (a, b) =>
          a.rank.order - b.rank.order ||
          new Date(a.row.wa_timestamp).getTime() - new Date(b.row.wa_timestamp).getTime()
      )
      .slice(0, limit)
      .map(({ row, rank }) => ({
        messageId: row.message_id,
        conversationId: row.conversation_id,
        content: row.content || '',
        senderWaId: row.sender_wa_id,
        waTimestamp: row.wa_timestamp,
        similarity: rank.score,
        platform: row.platform,
        account: row.account,
        messageType: row.message_type,
      }));
    return { results, failures };
  }

  /**
   * One brain query per account in scope: each account's conversations live
   * in its own brain instance (`brainInstance` in the account registry), and
   * the account goes in the filter too, so a search never returns another
   * account's chunks even if two ever shared an instance.
   */
  private brainScopes(options: SearchOptions): BrainScope[] {
    // An account-less chat id that already names an account is asked of that account only.
    const carried =
      options.chatId && !options.rawIds ? carriedNamespace(options.chatId) : undefined;
    const namespaces = options.account
      ? [options.account]
      : carried
        ? [carried]
        : accountNamespaces();
    const scopes: BrainScope[] = [];
    for (const account of namespaces) {
      const instance = brainInstanceForNamespace(account);
      if (!instance) continue;
      const scope: BrainScope = { instance, account };
      if (options.chatId) {
        scope.conversationIds = [
          options.rawIds ? options.chatId : accountKey(account, options.chatId),
        ];
      }
      scopes.push(scope);
    }
    return scopes;
  }

  private async askBrain(
    query: string,
    scope: BrainScope,
    options: SearchOptions,
    limit: number
  ): Promise<BrainChunk[]> {
    const brain = this.brain as BrainSearchConfig;
    const filters: Record<string, unknown> = {
      account: scope.account,
      types: ['conversation_chunk'],
    };
    if (options.platform) filters.platform = options.platform;
    if (scope.conversationIds) filters.conversation_ids = scope.conversationIds;
    if (options.from)
      filters.from = new Date(options.from.getTime() - CHUNK_WINDOW_SLACK_MS).toISOString();
    if (options.to) filters.to = options.to.toISOString();

    let body: {
      instance_id?: string;
      documents?: Array<{ score?: number; metadata?: Record<string, unknown> }>;
    };
    try {
      const response = await this.fetchImpl(
        `${brain.url}/instances/${encodeURIComponent(scope.instance)}/search`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(brain.apiKey ? { 'X-API-Key': brain.apiKey } : {}),
          },
          body: JSON.stringify({
            query,
            limit: Math.min(limit, BRAIN_MAX_HITS),
            filters,
            // The chunk with ITS message ids, not the whole parent window.
            expand_windows: false,
            // `skirmshop` hides WhatsApp/Telegram from its customer chat; the
            // professional account's conversations live there and this caller
            // is internal.
            include_internal: true,
          }),
          signal: AbortSignal.timeout(brain.timeoutMs),
        }
      );
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        throw new Error(`brain ${scope.instance} ${response.status}: ${detail}`);
      }
      body = (await response.json()) as typeof body;
    } catch (e) {
      const message = (e as Error).message;
      // the 'brain <instance> <status>' message above already names the instance
      throw new Error(
        message.startsWith(`brain ${scope.instance} `)
          ? message
          : `brain ${scope.instance}: ${message}`
      );
    }
    // Each instance is its own collection: an answer from another one is not ours to read.
    if (body.instance_id !== scope.instance)
      throw new Error(`brain ${scope.instance}: respondió la instancia ${body.instance_id}`);
    return (body.documents || [])
      .filter(
        d => d.metadata?.type === 'conversation_chunk' && d.metadata?.account === scope.account
      )
      .map(d => ({
        account: scope.account,
        score: Number(d.score) || 0,
        messageIds: Array.isArray(d.metadata?.message_ids)
          ? (d.metadata?.message_ids as unknown[]).map(String)
          : [],
      }))
      .filter(c => c.messageIds.length > 0);
  }

  /** The rows behind a set of `wa_message_id`s, with the tool's filters applied exactly. */
  private async messagesById(waMessageIds: string[], options: SearchOptions) {
    let sql = `
      SELECT
        m.id as message_id,
        m.wa_message_id,
        m.conversation_id,
        m.content,
        m.sender_wa_id,
        m.wa_timestamp,
        m.platform,
        m.account,
        m.message_type
      FROM messages m
      WHERE m.wa_message_id = ANY($1::text[])
        AND (m.is_deleted IS NULL OR m.is_deleted = false)
    `;
    const params: unknown[] = [waMessageIds];
    let paramIndex = 2;
    const add = (clause: string, value: unknown) => {
      sql += ` AND ${clause.replace('?', `$${paramIndex}`)}`;
      params.push(value);
      paramIndex++;
    };
    const { chatId, from, to, sender } = options;
    if (chatId) {
      if (options.rawIds) add('m.conversation_id = ?', chatId);
      else if (options.account) add('m.conversation_id = ?', accountKey(options.account, chatId));
      else add('m.conversation_id = ANY(?::text[])', inEveryNamespace(chatId));
    }
    if (from) add('m.wa_timestamp >= ?', from);
    if (to) add('m.wa_timestamp <= ?', to);
    if (sender) {
      if (options.rawIds) add('m.sender_wa_id = ?', sender);
      else if (options.account) add('m.sender_wa_id = ?', accountKey(options.account, sender));
      else add('m.sender_wa_id = ANY(?::text[])', inEveryNamespace(sender));
    }
    if (options.account) add('m.account = ?', options.account);
    if (options.platform) add('m.platform = ?', options.platform);
    const messageTypes = messageTypesFor(options.mediaType);
    if (messageTypes) {
      sql += mediaTypePredicate('m', paramIndex);
      params.push(messageTypes);
      paramIndex++;
    }
    const result = await this.dbClient.query(sql, params);
    return result.rows;
  }

  /**
   * Semantic first (the brain), keyword second (Postgres full-text), and it
   * says which one answered and why the second one had to.
   */
  async searchDetailed(query: string, options: SearchOptions = {}): Promise<SearchOutcome> {
    let fallbackReason = 'sin coincidencias semánticas';
    try {
      const { results, failures } = await this.semanticSearch(query, options);
      if (results.length > 0)
        return {
          results,
          mode: 'semantic',
          ...(failures.length ? { partialErrors: failures } : {}),
        };
      if (failures.length) {
        fallbackReason = `búsqueda semántica no disponible: ${[...new Set(failures.map(f => f.message))].join('; ')}`;
        this.logger.warn(
          `Semantic search failed, falling back to keyword search: ${fallbackReason}`
        );
      }
    } catch (error) {
      fallbackReason = `búsqueda semántica no disponible: ${(error as Error)?.message || error}`;
      this.logger.warn(`Semantic search failed, falling back to keyword search: ${fallbackReason}`);
    }
    return { results: await this.keywordSearch(query, options), mode: 'text', fallbackReason };
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    return (await this.searchDetailed(query, options)).results;
  }
}

/**
 * The full-text index keywordSearch needs. Without it a search that is not
 * scoped to a chat computed to_tsvector over every message (885k rows,
 * 11.7 s measured on the replica 02-10) and hit the pool's 10 s statement
 * timeout (QA 02-10: social_search_messages → outcome_unknown). The expression
 * is the one in keywordSearch's WHERE, so the planner matches it.
 */
export const SEARCH_FTS_INDEX = 'idx_messages_content_fts';
const SEARCH_FTS_INDEX_SQL = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${SEARCH_FTS_INDEX}
  ON messages USING gin (to_tsvector('english', content))`;

export interface IndexClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

export type EnsureIndexOutcome = 'exists' | 'created' | 'busy' | 'disabled' | 'failed';

/**
 * Build the full-text index once, CONCURRENTLY (no write lock on a table that
 * dozens of services write), outside any transaction — which is why it is not
 * in a migration: migrate.ts runs every file inside one, where CONCURRENTLY is
 * impossible (same split as 016's ensureBrainWindowsIndexes). Runs on its own
 * connection without statement timeout, under an advisory lock so two pods
 * never build it at once; an INVALID leftover of a failed build is dropped
 * first (IF NOT EXISTS would keep it forever). Never throws: search still
 * works without the index, only slower.
 */
export async function ensureSearchIndexes(
  connect: () => Promise<IndexClient>,
  log: (message: string) => void = () => {}
): Promise<EnsureIndexOutcome> {
  if (process.env.SOCIAL_SEARCH_ENSURE_INDEX === 'false') return 'disabled';
  let client: IndexClient | null = null;
  let locked = false;
  try {
    client = await connect();
    const lock = await client.query(
      `SELECT pg_try_advisory_lock(hashtext('socialmedia:${SEARCH_FTS_INDEX}')) AS locked`
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) return 'busy';
    const existing = await client.query(
      `SELECT i.indisvalid AS valid
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = $1`,
      [SEARCH_FTS_INDEX]
    );
    if (existing.rows[0]?.valid === true) return 'exists';
    await client.query('SET statement_timeout = 0');
    if (existing.rows.length) {
      log(`${SEARCH_FTS_INDEX} is INVALID (an interrupted build): dropping it`);
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${SEARCH_FTS_INDEX}`);
    }
    log(`building ${SEARCH_FTS_INDEX} CONCURRENTLY`);
    const started = Date.now();
    await client.query(SEARCH_FTS_INDEX_SQL);
    log(`${SEARCH_FTS_INDEX} ready in ${Date.now() - started} ms`);
    return 'created';
  } catch (error) {
    log(`${SEARCH_FTS_INDEX} not built: ${(error as Error)?.message || error}`);
    return 'failed';
  } finally {
    if (client) {
      if (locked) {
        await client
          .query(`SELECT pg_advisory_unlock(hashtext('socialmedia:${SEARCH_FTS_INDEX}'))`)
          .catch(() => {});
      }
      await client.end().catch(() => {});
    }
  }
}

/** The namespace an id already carries ('professional:42@…' → 'professional'); undefined for a bare id. */
function carriedNamespace(id: string): string | undefined {
  const parsed = stripAccount(id);
  return parsed.id === id ? undefined : parsed.account;
}

/**
 * Account-less filter: the raw id under every declared namespace (personal = bare).
 * An id that already names an account is that account's alone (accountKey would
 * refuse it under any other): it is not widened.
 */
function inEveryNamespace(id: string): string[] {
  if (carriedNamespace(id)) return [id];
  return [...new Set(accountNamespaces().map(a => accountKey(a, id)))];
}
