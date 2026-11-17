import { Pool } from 'pg';
import type pino from 'pino';
import { createServiceLogger } from './service-logger';
import { accountKey, normalizeAccount, stripAccount, type Account } from '../domain/account';
import { getAccounts } from '../domain/account-registry';
import { mediaTypePredicate, messageTypesFor, type MediaType } from './media-type-filter';
import { semanticProviderFromEnv } from '../infrastructure/hindsight-client';
import {
  HindsightBoundaryRecall,
  boundaryRecallConfigFromEnv,
} from '../infrastructure/hindsight-boundary-recall';
import { chunkMessageIds, resolveChunks } from './hindsight-chunks';

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
 * Semantic search lives in Hindsight (SC-4304 S8; SC-5827 retiró el Brain y
 * Qdrant): the `personal` bank holds the conversation chunks that the
 * brain-windows cron feeds through Synapse (ADR 0002). This service does not
 * embed anything: it recalls the chunks that match, scoped to the tool's
 * account/channel/chat/dates, and resolves their `message_ids` against
 * `messages` here, where the filters Hindsight does not have (sender,
 * mediaType, deletions, the exact time window) live. Without Hindsight
 * configured the tool answers by keyword only and says so in `fallbackReason`.
 */
/** Semantic recall is capped at 50 hits (the brain's old `/search` top-k). */
const SEMANTIC_MAX_HITS = 50;

export type SearchMode = 'semantic' | 'text';

/** One account whose semantic backend could not be asked. */
export interface SearchFailure {
  accountId: string;
  message: string;
}

export interface SearchOutcome {
  results: SearchResult[];
  mode: SearchMode;
  /** Semantic answered, but these accounts' backends did not (`meta.partialErrors`). */
  partialErrors?: SearchFailure[];
  /** Why the keyword branch answered: no semantic match, or the backend failed. */
  fallbackReason?: string;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Namespaces with a Hindsight bank for message search; the rest answer by keyword (tienda is not granted). */
const HINDSIGHT_NAMESPACES = new Set(['personal']);

export class SearchService {
  private dbClient: Pool;
  private logger: pino.Logger;
  private readonly hindsight: HindsightBoundaryRecall | null;

  constructor(
    dbClient: Pool,
    fetchImpl: FetchLike = (url, init) => fetch(url, init),
    hindsight: HindsightBoundaryRecall | null = semanticProviderFromEnv() === 'hindsight'
      ? new HindsightBoundaryRecall(boundaryRecallConfigFromEnv(), (url, init) =>
          fetchImpl(String(url), init ?? {})
        )
      : null
  ) {
    this.dbClient = dbClient;
    this.hindsight = hindsight;
    this.logger = createServiceLogger();
    this.logger.info(
      hindsight
        ? 'SearchService: búsqueda semántica en Hindsight (banco personal, por AgentGateway)'
        : 'SearchService: SEMANTIC_PROVIDER!=hindsight, solo búsqueda de texto (el Brain se retiró, SC-5827)'
    );
  }

  /** Resolve enabled provider accounts before querying either search backend. */
  private searchScopes(options: SearchOptions): ReturnType<typeof getAccounts> {
    // The argument may be an account id or the namespace it files rows under.
    const requested = options.account
      ? normalizeAccount(options.account, options.platform)
      : undefined;
    return getAccounts(options.platform).filter(
      a => !requested || (options.platform ? a.accountId === requested : a.namespace === requested)
    );
  }

  /**
   * Storage keys for a raw conversation/sender id across the selected accounts.
   * An id already namespaced to a different account is dropped (fail closed).
   * WhatsApp/Telegram rows are keyed by their account namespace; Instagram rows
   * are keyed by the Instagram accountId (ig_<account>_...) while they are
   * FILTERED by the namespace the registry declares for that account.
   */
  private indexKeys(
    scopes: ReturnType<typeof getAccounts>,
    id: string,
    kind: 'thread' | 'sender'
  ): string[] {
    return [
      ...new Set(
        scopes.flatMap(scope => {
          if (scope.channel === 'instagram') {
            const prefix = `ig_${scope.accountId}_`;
            if (id.startsWith(prefix)) return [id];
            if (id.startsWith('ig_')) return [];
            return [`${prefix}${kind === 'thread' ? 'thread_' : ''}${id}`];
          }
          const parsed = stripAccount(id);
          if (parsed.id !== id && parsed.account !== scope.namespace) return [];
          return [accountKey(scope.namespace, id)];
        })
      ),
    ];
  }

  /** Appends the identical account and message filters for both search strategies. */
  private appendSearchFilters(sql: string, params: unknown[], options: SearchOptions) {
    const { chatId, from, to, sender } = options;
    // A stale semantic index must never resurrect a message hidden locally.
    sql += " AND m.metadata->>'deleted_for_me' IS DISTINCT FROM 'true'";
    let paramIndex = params.length + 1;
    const scopes = this.searchScopes(options);
    // Instagram accounts may share a storage namespace; the ingested provider
    // account is authoritative for their search boundary.
    sql += ` AND (m.platform || ':' || CASE WHEN m.platform = 'instagram'
      THEN m.metadata->>'instagram_account' ELSE m.account END) = ANY($${paramIndex++}::text[])`;
    params.push(
      scopes.map(a => `${a.channel}:${a.channel === 'instagram' ? a.accountId : a.namespace}`)
    );

    if (chatId) {
      sql += ` AND m.conversation_id = ANY($${paramIndex++}::text[])`;
      params.push(
        options.rawIds && options.platform !== 'instagram'
          ? [chatId]
          : this.indexKeys(scopes, chatId, 'thread')
      );
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
      sql += ` AND m.sender_wa_id = ANY($${paramIndex++}::text[])`;
      params.push(
        options.rawIds && options.platform !== 'instagram'
          ? [sender]
          : this.indexKeys(scopes, sender, 'sender')
      );
    }

    if (options.account) {
      // The stored dimension is the registry namespace, not the tool argument:
      // an Instagram account argument resolves to the namespace its rows live in.
      sql += ` AND m.account = ANY($${paramIndex}::text[])`;
      params.push([...new Set(scopes.map(a => a.namespace))]);
      paramIndex++;
    }
    if (options.platform) {
      sql += ` AND m.platform = $${paramIndex}`;
      params.push(options.platform);
      paramIndex++;
    }

    const messageTypes = messageTypesFor(options.mediaType);
    if (messageTypes) {
      sql += mediaTypePredicate('m', paramIndex++);
      params.push(messageTypes);
    }

    return { sql, paramIndex };
  }

  /**
   * Performs keyword search using PostgreSQL Full Text Search
   */
  async keywordSearch(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
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
    const filters = this.appendSearchFilters(sql, params, options);
    sql = filters.sql;
    const paramIndex = filters.paramIndex;

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
   * Semantic search (INFRA-486; tras SC-5827 solo Hindsight): los chunks de
   * conversacion que casan, con los filtros de la tool, resueltos a sus mensajes.
   *
   * Every hit is a chunk of 3-8 consecutive messages (ADR 0002 §2): its messages
   * come back in chunk order (best first) and, inside a chunk, in time order,
   * each with the chunk's score as `similarity`. Throws if the semantic backend
   * is not configured at all; one account failing does not fail the others: it comes back in
   * `failures`, so `searchDetailed` can say what is missing or why it fell back.
   */
  async semanticSearch(
    query: string,
    options: SearchOptions = {}
  ): Promise<{ results: SearchResult[]; failures: SearchFailure[] }> {
    if (this.hindsight) return this.hindsightSemanticSearch(query, options);
    throw new Error('Hindsight sin configurar (SEMANTIC_PROVIDER=hindsight)');
  }

  /**
   * Semantic search in Hindsight (SC-4304 S8), bank `personal` through the read-only gateway
   * route. A hit is a retained chunk: `hindsight-chunks` recovers the ledger window it was
   * written from and recomputes its messages, then the same Postgres tail ranks and filters
   * them. Accounts without a bank here answer through `failures`.
   */
  private async hindsightSemanticSearch(
    query: string,
    options: SearchOptions
  ): Promise<{ results: SearchResult[]; failures: SearchFailure[] }> {
    const hindsight = this.hindsight as HindsightBoundaryRecall;
    // Instagram does not go through brain-windows: there are no chunks to find.
    if (options.platform === 'instagram') return { results: [], failures: [] };
    const namespaces = [
      ...new Set(
        this.searchScopes(options)
          .filter(a => a.channel !== 'instagram')
          .map(a => a.namespace)
      ),
    ];
    const failures: SearchFailure[] = [];
    const best = new Map<string, { score: number; order: number; id: string }>();
    for (const account of namespaces) {
      if (!HINDSIGHT_NAMESPACES.has(account)) {
        failures.push({
          accountId: account,
          message: `la cuenta ${account} no tiene banco en Hindsight`,
        });
        continue;
      }
      try {
        const tags = [
          'type:conversation_chunk',
          `account:${account}`,
          ...(options.platform ? [`platform:${options.platform}`] : []),
        ];
        const hits = (await hindsight.recall(query, tags))
          .filter(h => h.score >= hindsight.minScore)
          .sort((a, b) => b.score - a.score)
          .slice(0, SEMANTIC_MAX_HITS);
        const resolved = await resolveChunks(
          this.dbClient,
          hits.map(h => h.documentId),
          account,
          hindsight.writerIdentities
        );
        const ids = await chunkMessageIds(this.dbClient, resolved);
        for (const hit of hits)
          for (const id of ids.get(hit.documentId) ?? []) {
            const key = `${account}\u0000${id}`;
            if (!best.has(key)) best.set(key, { score: hit.score, order: best.size, id });
          }
      } catch (e) {
        failures.push({ accountId: account, message: (e as Error)?.message || String(e) });
      }
    }
    if (!best.size) return { results: [], failures };
    return {
      results: await this.rankedMessages(best, options, searchLimit(options.limit)),
      failures,
    };
  }

  private async rankedMessages(
    best: Map<string, { score: number; order: number; id: string }>,
    options: SearchOptions,
    limit: number
  ): Promise<SearchResult[]> {
    const rows = await this.messagesById([...new Set([...best.values()].map(b => b.id))], options);
    return rows
      .flatMap(row => {
        const rank = best.get(`${row.account}\u0000${row.wa_message_id}`);
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
    // Only WhatsApp and Telegram are ingested as conversation chunks.
    sql += " AND m.platform IN ('whatsapp', 'telegram')";
    sql = this.appendSearchFilters(sql, params, options).sql;
    const result = await this.dbClient.query(sql, params);
    return result.rows;
  }

  /**
   * Semantic first (Hindsight), keyword second (Postgres full-text), and it
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
