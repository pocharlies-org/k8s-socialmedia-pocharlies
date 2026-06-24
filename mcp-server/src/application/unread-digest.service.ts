import OpenAI from 'openai';
import { Pool } from 'pg';
import pino from 'pino';
import { randomUUID } from 'crypto';
import { type Account } from '../domain/account';

export type MessagingPlatform = 'whatsapp' | 'telegram';
export type DigestLanguage = 'es' | 'en';
export type DigestStatus = 'in_progress' | 'completed';

export interface UnreadDigestChat {
  platform: MessagingPlatform;
  account: Account;
  chatId: string;
  dbConversationId: string;
  name: string | null;
  unreadCount: number;
  isGroup: boolean;
  source: string;
  metadata?: Record<string, unknown>;
}

interface DigestMessage {
  id: string;
  sender: string;
  timestamp: Date;
  direction: string | null;
  content: string;
  messageType: string | null;
}

interface DigestChatResult {
  platform: MessagingPlatform;
  chatId: string;
  name: string | null;
  unreadCount: number;
  messageCount: number;
  oldestMessageAt: string | null;
  newestMessageAt: string | null;
  warning?: string;
}

interface DigestPartial {
  batchNumber: number;
  fromIndex: number;
  toIndex: number;
  createdAt: string;
  chats: DigestChatResult[];
  summary: string;
  warnings: string[];
}

interface DigestSessionRow {
  id: string;
  account: Account;
  platforms: MessagingPlatform[];
  chat_queue: UnreadDigestChat[];
  next_index: number;
  batch_size: number;
  message_limit: number;
  language: DigestLanguage;
  partial_summaries: DigestPartial[];
  status: DigestStatus;
  global_summary: string | null;
  warnings: string[];
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface StartDigestOptions {
  account: Account;
  platforms: MessagingPlatform[];
  batchSize: number;
  messageLimit: number;
  language: DigestLanguage;
}

export interface DigestResponse {
  digestId: string;
  status: DigestStatus;
  account: Account;
  platforms: MessagingPlatform[];
  totalChats: number;
  processedChats: number;
  remainingChats: number;
  cursorCheckpoint: { digestId: string; nextIndex: number } | null;
  continueTool: { name: 'unread_digest'; arguments: { action: 'continue'; digestId: string } } | null;
  currentBatch: DigestPartial | null;
  partialSummary: string | null;
  partialSummaries: Array<{ batchNumber: number; summary: string }>;
  globalSummary: string | null;
  warnings: string[];
}

export class UnreadDigestService {
  private openai: OpenAI;
  private logger: pino.Logger;
  private llmModel: string;
  private schemaReady = false;

  constructor(
    private dbClient: Pool,
    openaiApiKey: string,
    llmBaseUrl?: string,
    llmModel?: string
  ) {
    this.openai = new OpenAI({
      apiKey: openaiApiKey || 'sk-placeholder',
      ...(llmBaseUrl && { baseURL: llmBaseUrl }),
    });
    this.llmModel = llmModel || 'gpt-4o-mini';
    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
  }

  async start(
    options: StartDigestOptions,
    chats: UnreadDigestChat[],
    initialWarnings: string[] = []
  ): Promise<DigestResponse> {
    await this.ensureSchema();
    const id = randomUUID();
    const limitedChats = chats.map(chat => ({
      ...chat,
      name: chat.name || null,
      metadata: chat.metadata || {},
    }));

    await this.dbClient.query(
      `INSERT INTO unread_digest_sessions
        (id, account, platforms, chat_queue, next_index, batch_size, message_limit,
         language, partial_summaries, status, warnings)
       VALUES ($1, $2, $3, $4::jsonb, 0, $5, $6, $7, '[]'::jsonb, 'in_progress', $8::jsonb)`,
      [
        id,
        options.account,
        options.platforms,
        JSON.stringify(limitedChats),
        options.batchSize,
        options.messageLimit,
        options.language,
        JSON.stringify(initialWarnings),
      ]
    );

    return this.processNext(id);
  }

  async continue(digestId: string, batchSize?: number): Promise<DigestResponse> {
    await this.ensureSchema();
    if (batchSize !== undefined) {
      await this.dbClient.query(
        `UPDATE unread_digest_sessions
            SET batch_size = $2, updated_at = NOW()
          WHERE id = $1 AND status = 'in_progress'`,
        [digestId, clampInteger(batchSize, 1, 10)]
      );
    }
    return this.processNext(digestId);
  }

  async status(digestId: string): Promise<DigestResponse> {
    await this.ensureSchema();
    const session = await this.loadSession(digestId);
    return this.toResponse(session, null);
  }

  private async processNext(digestId: string): Promise<DigestResponse> {
    const session = await this.loadSession(digestId);
    if (session.status === 'completed') {
      return this.toResponse(session, null);
    }

    const totalChats = session.chat_queue.length;
    if (session.next_index >= totalChats) {
      const completed = await this.completeSession(session);
      return this.toResponse(completed, null);
    }

    const fromIndex = session.next_index;
    const toIndex = Math.min(totalChats, fromIndex + session.batch_size);
    const batchChats = session.chat_queue.slice(fromIndex, toIndex);
    const batchNumber = session.partial_summaries.length + 1;
    const warnings: string[] = [];

    const chatBlocks: string[] = [];
    const chatResults: DigestChatResult[] = [];
    for (const chat of batchChats) {
      try {
        const messages = await this.getRecentMessages(chat, session.message_limit);
        const oldest = messages[0]?.timestamp?.toISOString() || null;
        const newest = messages[messages.length - 1]?.timestamp?.toISOString() || null;
        chatResults.push({
          platform: chat.platform,
          chatId: chat.chatId,
          name: chat.name,
          unreadCount: chat.unreadCount,
          messageCount: messages.length,
          oldestMessageAt: oldest,
          newestMessageAt: newest,
          ...(messages.length === 0 ? { warning: 'No indexed messages found for this chat.' } : {}),
        });
        chatBlocks.push(this.formatChatBlock(chat, messages));
      } catch (error) {
        const warning = `Could not read ${chat.platform} ${chat.chatId}: ${safeError(error)}`;
        warnings.push(warning);
        chatResults.push({
          platform: chat.platform,
          chatId: chat.chatId,
          name: chat.name,
          unreadCount: chat.unreadCount,
          messageCount: 0,
          oldestMessageAt: null,
          newestMessageAt: null,
          warning,
        });
      }
    }

    const fallback = this.fallbackBatchSummary(chatResults, session.language);
    const summary = await this.generateSummary({
      system:
        session.language === 'es'
          ? 'Resume tandas de chats no leidos de forma breve, clara y accionable. No inventes datos; si faltan mensajes indexados dilo.'
          : 'Summarize unread chat batches briefly and actionably. Do not invent facts; mention missing indexed messages.',
      user:
        session.language === 'es'
          ? `Tanda ${batchNumber}. Resume estos chats no leidos. Prioriza decisiones, preguntas pendientes, urgencias y acciones.\n\n${chatBlocks.join('\n\n')}`
          : `Batch ${batchNumber}. Summarize these unread chats. Prioritize decisions, pending questions, urgency, and actions.\n\n${chatBlocks.join('\n\n')}`,
      maxTokens: 700,
      fallback,
      timeoutMs: 60_000,
    });

    const partial: DigestPartial = {
      batchNumber,
      fromIndex,
      toIndex,
      createdAt: new Date().toISOString(),
      chats: chatResults,
      summary,
      warnings,
    };

    const partials = [...session.partial_summaries, partial];
    const nextIndex = toIndex;
    const allWarnings = [...session.warnings, ...warnings];
    const completed = nextIndex >= totalChats;
    const globalSummary = completed
      ? await this.generateGlobalSummary(partials, session.language)
      : session.global_summary;

    const updated = await this.updateSession(digestId, {
      nextIndex,
      partials,
      status: completed ? 'completed' : 'in_progress',
      globalSummary,
      warnings: allWarnings,
    });

    return this.toResponse(updated, partial);
  }

  private async completeSession(session: DigestSessionRow): Promise<DigestSessionRow> {
    const globalSummary =
      session.global_summary ||
      (await this.generateGlobalSummary(session.partial_summaries, session.language));
    return this.updateSession(session.id, {
      nextIndex: session.chat_queue.length,
      partials: session.partial_summaries,
      status: 'completed',
      globalSummary,
      warnings: session.warnings,
    });
  }

  private async getRecentMessages(
    chat: UnreadDigestChat,
    limit: number
  ): Promise<DigestMessage[]> {
    const result = await this.dbClient.query(
      `SELECT id, wa_message_id, sender_wa_id, wa_timestamp, direction,
              content, message_type
         FROM messages
        WHERE conversation_id = $1
          AND platform = $2
          AND (is_deleted IS NULL OR is_deleted = false)
        ORDER BY wa_timestamp DESC, id DESC
        LIMIT $3`,
      [chat.dbConversationId, chat.platform, limit]
    );

    return result.rows
      .map(row => ({
        id: String(row.wa_message_id || row.id),
        sender: String(row.sender_wa_id || ''),
        timestamp: row.wa_timestamp,
        direction: row.direction || null,
        content: cleanMessage(row.content, row.message_type),
        messageType: row.message_type || null,
      }))
      .reverse();
  }

  private formatChatBlock(chat: UnreadDigestChat, messages: DigestMessage[]): string {
    const title = chat.name || chat.chatId;
    const header = [
      `### ${chat.platform.toUpperCase()} ${title}`,
      `chatId: ${chat.chatId}`,
      `account: ${chat.account}`,
      `unreadCount: ${chat.unreadCount}`,
      `isGroup: ${chat.isGroup}`,
    ].join('\n');
    if (!messages.length) return `${header}\n(no indexed messages found)`;
    const body = messages
      .map(
        msg =>
          `[${msg.timestamp.toISOString()}] ${msg.sender}${msg.direction ? ` (${msg.direction})` : ''}: ${msg.content}`
      )
      .join('\n');
    return `${header}\n${body}`;
  }

  private async generateGlobalSummary(
    partials: DigestPartial[],
    language: DigestLanguage
  ): Promise<string> {
    if (!partials.length) {
      return language === 'es'
        ? 'No hay chats no leidos para resumir.'
        : 'There are no unread chats to summarize.';
    }
    const fallback = partials.map(p => `Tanda ${p.batchNumber}: ${p.summary}`).join('\n\n');
    return this.generateSummary({
      system:
        language === 'es'
          ? 'Combina resumenes parciales de chats no leidos en un resumen global conciso y accionable.'
          : 'Combine partial unread-chat summaries into one concise, actionable global summary.',
      user:
        language === 'es'
          ? `Genera el resumen global final. Agrupa por urgencia, pendientes y contexto relevante.\n\n${fallback}`
          : `Generate the final global summary. Group by urgency, pending actions, and relevant context.\n\n${fallback}`,
      maxTokens: 1000,
      fallback,
      timeoutMs: 90_000,
    });
  }

  private async generateSummary(options: {
    system: string;
    user: string;
    maxTokens: number;
    fallback: string;
    timeoutMs: number;
  }): Promise<string> {
    try {
      const response = await this.openai.chat.completions.create(
        {
          model: this.llmModel,
          messages: [
            { role: 'system', content: options.system },
            { role: 'user', content: truncate(options.user, 28_000) },
          ],
          temperature: 0.2,
          max_tokens: options.maxTokens,
        },
        { timeout: options.timeoutMs }
      );
      return response.choices[0]?.message?.content?.trim() || options.fallback;
    } catch (error) {
      this.logger.warn(`Unread digest summary fallback: ${safeError(error)}`);
      return options.fallback;
    }
  }

  private fallbackBatchSummary(
    chats: DigestChatResult[],
    language: DigestLanguage
  ): string {
    if (!chats.length) {
      return language === 'es'
        ? 'No hay chats en esta tanda.'
        : 'There are no chats in this batch.';
    }
    return chats
      .map(chat => {
        const name = chat.name || chat.chatId;
        const warning = chat.warning ? ` (${chat.warning})` : '';
        return `- [${chat.platform}] ${name}: ${chat.unreadCount} unread, ${chat.messageCount} indexed messages${warning}`;
      })
      .join('\n');
  }

  private async loadSession(digestId: string): Promise<DigestSessionRow> {
    const result = await this.dbClient.query(`SELECT * FROM unread_digest_sessions WHERE id = $1`, [
      digestId,
    ]);
    if (!result.rows.length) {
      throw new Error(`Unread digest session not found: ${digestId}`);
    }
    return normalizeSessionRow(result.rows[0]);
  }

  private async updateSession(
    digestId: string,
    values: {
      nextIndex: number;
      partials: DigestPartial[];
      status: DigestStatus;
      globalSummary: string | null;
      warnings: string[];
    }
  ): Promise<DigestSessionRow> {
    const result = await this.dbClient.query(
      `UPDATE unread_digest_sessions
          SET next_index = $2,
              partial_summaries = $3::jsonb,
              status = $4,
              global_summary = $5,
              warnings = $6::jsonb,
              updated_at = NOW(),
              completed_at = CASE WHEN $4 = 'completed' THEN COALESCE(completed_at, NOW()) ELSE completed_at END
        WHERE id = $1
        RETURNING *`,
      [
        digestId,
        values.nextIndex,
        JSON.stringify(values.partials),
        values.status,
        values.globalSummary,
        JSON.stringify(values.warnings),
      ]
    );
    return normalizeSessionRow(result.rows[0]);
  }

  private toResponse(session: DigestSessionRow, currentBatch: DigestPartial | null): DigestResponse {
    const totalChats = session.chat_queue.length;
    const processedChats = Math.min(session.next_index, totalChats);
    const remainingChats = Math.max(0, totalChats - processedChats);
    const latest = currentBatch || session.partial_summaries[session.partial_summaries.length - 1] || null;
    const inProgress = session.status === 'in_progress';
    return {
      digestId: session.id,
      status: session.status,
      account: session.account,
      platforms: session.platforms,
      totalChats,
      processedChats,
      remainingChats,
      cursorCheckpoint: inProgress ? { digestId: session.id, nextIndex: session.next_index } : null,
      continueTool: inProgress
        ? { name: 'unread_digest', arguments: { action: 'continue', digestId: session.id } }
        : null,
      currentBatch: latest,
      partialSummary: latest?.summary || null,
      partialSummaries: session.partial_summaries.map(partial => ({
        batchNumber: partial.batchNumber,
        summary: partial.summary,
      })),
      globalSummary: session.global_summary,
      warnings: session.warnings,
    };
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    await this.dbClient.query(`
      CREATE TABLE IF NOT EXISTS unread_digest_sessions (
        id UUID PRIMARY KEY,
        account TEXT NOT NULL,
        platforms TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        chat_queue JSONB NOT NULL DEFAULT '[]'::jsonb,
        next_index INTEGER NOT NULL DEFAULT 0,
        batch_size INTEGER NOT NULL DEFAULT 5,
        message_limit INTEGER NOT NULL DEFAULT 30,
        language TEXT NOT NULL DEFAULT 'es',
        partial_summaries JSONB NOT NULL DEFAULT '[]'::jsonb,
        status TEXT NOT NULL DEFAULT 'in_progress',
        global_summary TEXT,
        warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `);
    await this.dbClient.query(`
      CREATE INDEX IF NOT EXISTS idx_unread_digest_sessions_status_updated
        ON unread_digest_sessions (status, updated_at DESC)
    `);
    this.schemaReady = true;
  }
}

function normalizeSessionRow(row: any): DigestSessionRow {
  return {
    id: row.id,
    account: row.account,
    platforms: asArray(row.platforms) as MessagingPlatform[],
    chat_queue: asArray(row.chat_queue) as UnreadDigestChat[],
    next_index: Number(row.next_index || 0),
    batch_size: Number(row.batch_size || 5),
    message_limit: Number(row.message_limit || 30),
    language: row.language === 'en' ? 'en' : 'es',
    partial_summaries: asArray(row.partial_summaries) as DigestPartial[],
    status: row.status === 'completed' ? 'completed' : 'in_progress',
    global_summary: row.global_summary || null,
    warnings: asArray(row.warnings) as string[],
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at || null,
  };
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function cleanMessage(content: unknown, messageType: unknown): string {
  const raw = typeof content === 'string' ? content : '';
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (trimmed) return truncate(trimmed, 500);
  return `[${String(messageType || 'non-text message')}]`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}...`;
}

function clampInteger(value: unknown, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
