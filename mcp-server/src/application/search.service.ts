import { Pool } from 'pg';
import OpenAI from 'openai';
import pino from 'pino';
import { accountKey, type Account } from '../domain/account';
import { accountNamespaces } from '../domain/account-registry';
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

export class SearchService {
  private openai: OpenAI;
  private dbClient: Pool;
  private logger: pino.Logger;
  private readonly EMBEDDING_MODEL: string;
  private readonly EMBEDDING_DIMENSION: number;

  constructor(openaiApiKey: string, dbClient: Pool, _encryptionKey: string, llmBaseUrl?: string) {
    // The query vector must come from the SAME model that wrote message_embeddings.
    // EmbeddingService (the writer) talks to EMBEDDING_BASE_URL — bge-m3,
    // vector(1024) in prod; this reader was pointed at the LiteLLM chat route with
    // a hardcoded text-embedding-3-small (1536 dims), which the `socialmedia` key
    // cannot use and which would not have fit the column either way: every semantic
    // search died here and silently fell back to keyword search.
    const baseURL = process.env.EMBEDDING_BASE_URL || llmBaseUrl || undefined;
    this.EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'bge-m3';
    this.EMBEDDING_DIMENSION = parseInt(process.env.EMBEDDING_DIMENSION || '1024', 10);
    this.openai = new OpenAI({
      apiKey: openaiApiKey || 'not-needed',
      ...(baseURL && { baseURL }),
    });
    this.dbClient = dbClient;
    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
    this.logger.info(
      `SearchService: modelo=${this.EMBEDDING_MODEL} dim=${this.EMBEDDING_DIMENSION} baseURL=${baseURL || 'openai-default'}`
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
   * Performs semantic search using vector similarity
   */
  async semanticSearch(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { chatId, from, to, sender } = options;
    const limit = searchLimit(options.limit);

    // Generate embedding for query
    const response = await this.openai.embeddings.create({
      model: this.EMBEDDING_MODEL,
      input: query,
    });

    const queryEmbedding = response.data[0].embedding;
    // A vector of another width is a wrong-model bug, not a miss: say which,
    // instead of letting Postgres fail on the <=> operator.
    if (queryEmbedding.length !== this.EMBEDDING_DIMENSION) {
      throw new Error(
        `embedding del query: ${queryEmbedding.length} dims, y message_embeddings es vector(${this.EMBEDDING_DIMENSION}) con ${this.EMBEDDING_MODEL}`
      );
    }
    const embeddingVector = `[${queryEmbedding.join(',')}]`;

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
        1 - (me.embedding <=> $1::vector) as similarity
      FROM messages m
      JOIN message_embeddings me ON m.id = me.message_id
      WHERE 1 - (me.embedding <=> $1::vector) > 0.7
        AND (m.is_deleted IS NULL OR m.is_deleted = false)
    `;

    const params: unknown[] = [embeddingVector];
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

    sql += ` ORDER BY similarity DESC, m.wa_timestamp DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await this.dbClient.query(sql, params);

    return result.rows.map(row => ({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      content: row.content || '',
      senderWaId: row.sender_wa_id,
      waTimestamp: row.wa_timestamp,
      similarity: parseFloat(row.similarity),
      platform: row.platform,
      account: row.account,
      messageType: row.message_type,
    }));
  }

  /**
   * Hybrid search: combines keyword and semantic search
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    // Try semantic search first, fallback to keyword search
    try {
      const semanticResults = await this.semanticSearch(query, options);
      if (semanticResults.length > 0) {
        return semanticResults;
      }
    } catch (error) {
      this.logger.warn(`Semantic search failed, falling back to keyword search: ${error}`);
    }

    // Fallback to keyword search
    return this.keywordSearch(query, options);
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

/** Account-less filter: the raw id under every declared namespace (personal = bare). */
function inEveryNamespace(id: string): string[] {
  return [...new Set(accountNamespaces().map(a => accountKey(a, id)))];
}
