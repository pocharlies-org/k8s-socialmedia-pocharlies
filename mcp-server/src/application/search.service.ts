import { Pool } from 'pg';
import OpenAI from 'openai';
import pino from 'pino';
import { accountKey, type Account } from '../domain/account';

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
}

export interface SearchOptions {
  chatId?: string;
  from?: Date;
  to?: Date;
  sender?: string;
  limit?: number;
  /** Account scope (personal|professional). Defaults to personal. */
  account?: Account;
  platform?: 'whatsapp' | 'telegram';
}

export class SearchService {
  private openai: OpenAI;
  private dbClient: Pool;
  private logger: pino.Logger;
  private readonly EMBEDDING_MODEL = 'text-embedding-3-small';

  constructor(openaiApiKey: string, dbClient: Pool, _encryptionKey: string, llmBaseUrl?: string) {
    this.openai = new OpenAI({
      apiKey: openaiApiKey || 'sk-placeholder',
      ...(llmBaseUrl && { baseURL: llmBaseUrl }),
    });
    this.dbClient = dbClient;
    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
  }

  /**
   * Performs keyword search using PostgreSQL Full Text Search
   */
  async keywordSearch(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { chatId, from, to, sender, limit = 20 } = options;

    let sql = `
      SELECT 
        m.id as message_id,
        m.conversation_id,
        m.content,
        m.sender_wa_id,
        m.wa_timestamp,
        m.platform,
        m.account,
        ts_rank(to_tsvector('english', m.content), plainto_tsquery('english', $1)) as rank
      FROM messages m
      WHERE to_tsvector('english', m.content) @@ plainto_tsquery('english', $1)
        AND (m.is_deleted IS NULL OR m.is_deleted = false)
    `;

    const params: unknown[] = [query];
    let paramIndex = 2;

    if (chatId) {
      if (options.account) {
        sql += ` AND m.conversation_id = $${paramIndex}`;
        params.push(accountKey(options.account, chatId));
      } else {
        sql += ` AND m.conversation_id = ANY($${paramIndex}::text[])`;
        params.push([chatId, accountKey('professional', chatId)]);
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
      if (options.account) {
        sql += ` AND m.sender_wa_id = $${paramIndex}`;
        params.push(accountKey(options.account, sender));
      } else {
        sql += ` AND m.sender_wa_id = ANY($${paramIndex}::text[])`;
        params.push([sender, accountKey('professional', sender)]);
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
    }));
  }

  /**
   * Performs semantic search using vector similarity
   */
  async semanticSearch(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { chatId, from, to, sender, limit = 20 } = options;

    // Generate embedding for query
    const response = await this.openai.embeddings.create({
      model: this.EMBEDDING_MODEL,
      input: query,
    });

    const queryEmbedding = response.data[0].embedding;
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
        1 - (me.embedding <=> $1::vector) as similarity
      FROM messages m
      JOIN message_embeddings me ON m.id = me.message_id
      WHERE 1 - (me.embedding <=> $1::vector) > 0.7
        AND (m.is_deleted IS NULL OR m.is_deleted = false)
    `;

    const params: unknown[] = [embeddingVector];
    let paramIndex = 2;

    if (chatId) {
      if (options.account) {
        sql += ` AND m.conversation_id = $${paramIndex}`;
        params.push(accountKey(options.account, chatId));
      } else {
        sql += ` AND m.conversation_id = ANY($${paramIndex}::text[])`;
        params.push([chatId, accountKey('professional', chatId)]);
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
      if (options.account) {
        sql += ` AND m.sender_wa_id = $${paramIndex}`;
        params.push(accountKey(options.account, sender));
      } else {
        sql += ` AND m.sender_wa_id = ANY($${paramIndex}::text[])`;
        params.push([sender, accountKey('professional', sender)]);
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
