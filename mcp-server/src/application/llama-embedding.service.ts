import { Pool } from 'pg';
import { decryptString } from '@mcp-socialmedia/shared';
import { LlamaService } from './llama.service';

import {
  generateEmbeddingBatches,
  MessageEmbeddingService,
  MessageChunk,
} from './embedding-batches';
export type { MessageChunk } from './embedding-batches';

/**
 * Embedding service using local Llama/Ollama models
 * Drop-in replacement for the OpenAI-based EmbeddingService
 */
export class LlamaEmbeddingService extends MessageEmbeddingService {
  private llamaService: LlamaService;
  private encryptionKey: Buffer;
  private readonly EMBEDDING_DIMENSION = 768; // nomic-embed-text dimension

  constructor(
    llamaService: LlamaService,
    dbClient: Pool,
    encryptionKey: string,
    embeddingModel: string = 'nomic-embed-text'
  ) {
    const key = Buffer.from(encryptionKey, 'utf-8');
    super(dbClient, embeddingModel, 'legacy', {
      select: 'SELECT id, content, conversation_id FROM messages WHERE id = $1',
      decode: content => decryptString(content, key),
    });
    this.llamaService = llamaService;
    this.encryptionKey = key;
  }

  /**
   * Generates embeddings for message chunks using local Ollama
   */
  async generateEmbeddings(chunks: MessageChunk[]): Promise<MessageChunk[]> {
    return generateEmbeddingBatches(
      chunks,
      10,
      async batch => {
        const generated: MessageChunk[] = [];
        for (const chunk of batch) {
          try {
            const embedding = await this.llamaService.generateEmbedding(chunk.content);
            generated.push({ ...chunk, embedding });
          } catch (error) {
            this.logger.error(`Error generating embedding for chunk: ${error}`);
          }
        }
        return generated;
      },
      this.logger
    );
  }

  /**
   * Generate embedding for a search query
   */
  async generateQueryEmbedding(query: string): Promise<number[]> {
    return this.llamaService.generateEmbedding(query);
  }

  /**
   * Semantic search using local embeddings
   */
  async semanticSearch(
    query: string,
    limit: number = 10,
    conversationId?: string
  ): Promise<Array<{ messageId: string; content: string; score: number }>> {
    try {
      // Generate embedding for the query
      const queryEmbedding = await this.generateQueryEmbedding(query);

      // Build SQL query
      let sql = `
        SELECT
          me.message_id,
          m.content,
          1 - (me.embedding <=> $1::vector) as score
        FROM message_embeddings me
        JOIN messages m ON me.message_id = m.id
        WHERE m.is_deleted = false
      `;

      const params: unknown[] = [`[${queryEmbedding.join(',')}]`];
      let paramIndex = 2;

      if (conversationId) {
        sql += ` AND m.conversation_id = (SELECT id FROM conversations WHERE wa_chat_id = $${paramIndex})`;
        params.push(conversationId);
        paramIndex++;
      }

      sql += ` ORDER BY me.embedding <=> $1::vector LIMIT $${paramIndex}`;
      params.push(limit);

      const result = await this.dbClient.query(sql, params);

      return result.rows.map(row => {
        let content = '';
        if (row.content) {
          try {
            content = decryptString(row.content, this.encryptionKey);
          } catch {
            content = '[Decryption failed]';
          }
        }

        return {
          messageId: row.message_id,
          content,
          score: row.score,
        };
      });
    } catch (error) {
      this.logger.error(`Error in semantic search: ${error}`);
      throw error;
    }
  }
}
