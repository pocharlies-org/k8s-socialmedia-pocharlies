import pino, { type Logger } from 'pino';
import type { Pool } from 'pg';

export interface MessageChunk {
  messageId: string;
  chunkIndex: number;
  content: string;
  embedding?: number[];
}

/** Processes provider-sized batches sequentially, pausing only between batches. */
export async function generateEmbeddingBatches(
  chunks: MessageChunk[],
  batchSize: number,
  generateBatch: (batch: MessageChunk[]) => Promise<MessageChunk[]>,
  logger: Pick<Logger, 'error'>
): Promise<MessageChunk[]> {
  try {
    const results: MessageChunk[] = [];
    for (let offset = 0; offset < chunks.length; offset += batchSize) {
      results.push(...(await generateBatch(chunks.slice(offset, offset + batchSize))));
      if (offset + batchSize < chunks.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    return results;
  } catch (error) {
    logger.error(`Error generating embeddings: ${error}`);
    throw error;
  }
}

/** Skips absent vectors and preserves best-effort persistence after a failed insert. */
export async function storeMessageEmbeddingChunks(
  chunks: MessageChunk[],
  db: Pool,
  logger: Pick<Logger, 'error'>,
  model: string,
  schema: 'plaintext' | 'legacy'
): Promise<void> {
  const sql =
    schema === 'legacy'
      ? `INSERT INTO message_embeddings (id, message_id, embedding, model, chunk_index, created_at)
       VALUES (gen_random_uuid(), $1, $2::vector, $3, $4, NOW()) ON CONFLICT DO NOTHING`
      : `INSERT INTO message_embeddings (message_id, embedding, model, created_at)
       VALUES ($1, $2::vector, $3, NOW()) ON CONFLICT DO NOTHING`;
  for (const chunk of chunks) {
    if (!chunk.embedding) continue;
    try {
      const params: unknown[] = [chunk.messageId, `[${chunk.embedding.join(',')}]`, model];
      if (schema === 'legacy') params.push(chunk.chunkIndex);
      await db.query(sql, params);
    } catch (error) {
      logger.error(`Error storing embedding for message ${chunk.messageId}: ${error}`);
    }
  }
}

/** Retains short text, then groups sentences or paragraphs without splitting a single part. */
export function chunkEmbeddingMessage(messageId: string, content: string | null): MessageChunk[] {
  if (!content) return [];
  if (content.length < 500) return [{ messageId, chunkIndex: 0, content }];
  const bySentence = content.length <= 2000;
  const parts = content.split(bySentence ? /(?<=[.!?])\s+/ : /\n\n+/);
  const maxLength = bySentence ? 500 : 1000;
  const separator = bySentence ? ' ' : '\n\n';
  const chunks: MessageChunk[] = [];
  let current = '';
  for (const part of parts) {
    if (current.length + part.length > maxLength && current) {
      chunks.push({ messageId, chunkIndex: chunks.length, content: current.trim() });
      current = part;
    } else {
      current += (current ? separator : '') + part;
    }
  }
  if (current) chunks.push({ messageId, chunkIndex: chunks.length, content: current.trim() });
  return chunks;
}

interface EmbeddingMessageRow {
  content: string | null;
  conversation_id: string;
  platform?: string;
}

interface EmbeddingPipeline {
  chunkMessage(messageId: string, content: string | null): MessageChunk[];
  generateEmbeddings(chunks: MessageChunk[]): Promise<MessageChunk[]>;
  storeEmbeddings(chunks: MessageChunk[]): Promise<void>;
}

interface EmbeddingMessageSource {
  select: string;
  ignore?: (row: EmbeddingMessageRow) => boolean;
  decode?: (content: string) => string;
}

/** Shared message lifecycle; providers implement only their generation behavior. */
export abstract class MessageEmbeddingService implements EmbeddingPipeline {
  protected readonly logger: Logger;

  constructor(
    protected readonly dbClient: Pool,
    protected readonly EMBEDDING_MODEL: string,
    private readonly schema: 'plaintext' | 'legacy',
    private readonly source: EmbeddingMessageSource
  ) {
    this.logger = pino({
      transport: { target: 'pino-pretty', options: { colorize: true } },
    });
  }

  chunkMessage(messageId: string, content: string | null): MessageChunk[] {
    return chunkEmbeddingMessage(messageId, content);
  }

  abstract generateEmbeddings(chunks: MessageChunk[]): Promise<MessageChunk[]>;

  async storeEmbeddings(chunks: MessageChunk[]): Promise<void> {
    await storeMessageEmbeddingChunks(
      chunks,
      this.dbClient,
      this.logger,
      this.EMBEDDING_MODEL,
      this.schema
    );
  }

  async processMessage(messageId: string): Promise<void> {
    await processEmbeddingMessage(messageId, this.dbClient, this.logger, this, this.source);
  }
}

/** Runs the shared workflow while preserving each provider's source and decoding rules. */
export async function processEmbeddingMessage(
  messageId: string,
  db: Pool,
  logger: Pick<Logger, 'error' | 'warn' | 'debug'>,
  pipeline: EmbeddingPipeline,
  source: EmbeddingMessageSource
): Promise<void> {
  try {
    const result = await db.query<EmbeddingMessageRow>(source.select, [messageId]);
    const row = result.rows[0];
    if (!row) {
      logger.warn(`Message ${messageId} not found`);
      return;
    }
    if (source.ignore?.(row)) return;
    if (!row.content) {
      logger.debug(`Message ${messageId} has no content to embed`);
      return;
    }
    const content = source.decode ? source.decode(row.content) : row.content;
    const existing = await db.query(
      'SELECT id FROM message_embeddings WHERE message_id = $1 LIMIT 1',
      [messageId]
    );
    if (existing.rows.length > 0) {
      logger.debug(`Embedding already exists for message ${messageId}`);
      return;
    }
    const chunks = pipeline.chunkMessage(messageId, content);
    if (chunks.length === 0) return;
    await pipeline.storeEmbeddings(await pipeline.generateEmbeddings(chunks));
    logger.debug(`Processed embeddings for message ${messageId}`);
  } catch (error) {
    logger.error(`Error processing message ${messageId}: ${error}`);
    throw error;
  }
}
