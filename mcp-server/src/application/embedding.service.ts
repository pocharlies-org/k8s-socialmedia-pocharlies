import OpenAI from 'openai';
import { Pool } from 'pg';
import { isWhatsAppUpdate } from '../domain/whatsapp-surface';
import { embeddingConfig } from './embedding-config';

import {
  generateEmbeddingBatches,
  MessageEmbeddingService,
  MessageChunk,
} from './embedding-batches';
export type { MessageChunk } from './embedding-batches';

export class EmbeddingService extends MessageEmbeddingService {
  private openai: OpenAI;
  private readonly EMBEDDING_DIMENSION: number;

  constructor(openaiApiKey: string, dbClient: Pool, _encryptionKey: string) {
    const baseURL = process.env.EMBEDDING_BASE_URL || undefined;
    const config = embeddingConfig();
    super(dbClient, config.model, 'plaintext', {
      select: 'SELECT id, content, conversation_id, platform FROM messages WHERE id = $1',
      ignore: row => row.platform === 'whatsapp' && isWhatsAppUpdate(row.conversation_id),
    });
    this.EMBEDDING_DIMENSION = config.dimensions;
    this.openai = new OpenAI({
      apiKey: openaiApiKey || 'not-needed',
      baseURL,
    });

    this.logger.info(
      `EmbeddingService: model=${this.EMBEDDING_MODEL} dim=${this.EMBEDDING_DIMENSION} baseURL=${baseURL || 'openai-default'}`
    );
  }

  /**
   * Generates embeddings for message chunks
   */
  async generateEmbeddings(chunks: MessageChunk[]): Promise<MessageChunk[]> {
    return generateEmbeddingBatches(
      chunks,
      100,
      async batch => {
        const response = await this.openai.embeddings.create({
          model: this.EMBEDDING_MODEL,
          input: batch.map(chunk => chunk.content),
          encoding_format: 'float',
        });
        return batch.map((chunk, index) => {
          const embedding = response.data[index]?.embedding;
          if (!embedding || embedding.length !== this.EMBEDDING_DIMENSION) {
            throw new Error(
              `Embedding has ${embedding?.length ?? 0} dimensions; expected ${this.EMBEDDING_DIMENSION} for ${this.EMBEDDING_MODEL}`
            );
          }
          return { ...chunk, embedding };
        });
      },
      this.logger
    );
  }
}
