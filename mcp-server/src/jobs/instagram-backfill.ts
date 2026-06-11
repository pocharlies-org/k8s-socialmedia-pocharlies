/**
 * Backfill Instagram account data into the unified messages table.
 *
 * The job talks to the instagram-connector HTTP API, so Meta tokens remain
 * isolated in that connector. Dry-run is default:
 *
 *   cd mcp-server && pnpm tsx src/jobs/instagram-backfill.ts
 *   INSTAGRAM_BACKFILL_DRY_RUN=false cd mcp-server && pnpm tsx src/jobs/instagram-backfill.ts
 */
import { Pool } from 'pg';
import pino from 'pino';
import {
  InstagramEvent,
  InstagramIngestionService,
} from '../application/instagram-ingestion.service';

const logger = pino({
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

type BackfillConfig = {
  connectorUrl: string;
  databaseUrl: string;
  account: string;
  dryRun: boolean;
  validateOnly: boolean;
  includeDms: boolean;
  includeMedia: boolean;
  includeComments: boolean;
  includeMentions: boolean;
  maxConversations: number;
  maxMessagesPerConversation: number;
  maxMedia: number;
  maxCommentsPerMedia: number;
  maxMentions: number;
};

type Conversation = {
  id: string;
  updated_time?: string;
  participants?: { data?: Array<{ id?: string; username?: string }> };
  messages?: { data?: InstagramMessage[] };
};

type InstagramMessage = {
  id?: string;
  message?: string;
  text?: string;
  created_time?: string;
  from?: { id?: string; username?: string };
};

type MediaItem = {
  id: string;
  caption?: string;
  media_type?: string;
  permalink?: string;
  timestamp?: string;
};

type CommentItem = {
  id: string;
  text?: string;
  username?: string;
  timestamp?: string;
};

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw.toLowerCase());
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function configFromEnv(): BackfillConfig {
  return {
    connectorUrl: (
      process.env.INSTAGRAM_CONNECTOR_URL || 'http://instagram-connector:3003'
    ).replace(/\/+$/, ''),
    databaseUrl:
      process.env.DATABASE_URL ||
      'postgresql://whatsappmcp:whatsappmcp_dev@localhost:5432/whatsappmcp',
    account: process.env.INSTAGRAM_BACKFILL_ACCOUNT || 'barbelpapis',
    dryRun: boolEnv('INSTAGRAM_BACKFILL_DRY_RUN', true),
    validateOnly: boolEnv('INSTAGRAM_BACKFILL_VALIDATE_ONLY', false),
    includeDms: boolEnv('INSTAGRAM_BACKFILL_INCLUDE_DMS', true),
    includeMedia: boolEnv('INSTAGRAM_BACKFILL_INCLUDE_MEDIA', true),
    includeComments: boolEnv('INSTAGRAM_BACKFILL_INCLUDE_COMMENTS', true),
    includeMentions: boolEnv('INSTAGRAM_BACKFILL_INCLUDE_MENTIONS', true),
    maxConversations: intEnv('INSTAGRAM_BACKFILL_MAX_CONVERSATIONS', 50),
    maxMessagesPerConversation: intEnv('INSTAGRAM_BACKFILL_MAX_MESSAGES_PER_CONVERSATION', 100),
    maxMedia: intEnv('INSTAGRAM_BACKFILL_MAX_MEDIA', 100),
    maxCommentsPerMedia: intEnv('INSTAGRAM_BACKFILL_MAX_COMMENTS_PER_MEDIA', 100),
    maxMentions: intEnv('INSTAGRAM_BACKFILL_MAX_MENTIONS', 100),
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}: ${text.slice(0, 400)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

async function probe(
  name: string,
  fn: () => Promise<unknown>
): Promise<{ name: string; ok: boolean; error?: string }> {
  try {
    await fn();
    return { name, ok: true };
  } catch (error) {
    return { name, ok: false, error: String(error) };
  }
}

type ProbeResult = Awaited<ReturnType<typeof probe>>;

async function validateConnector(config: BackfillConfig) {
  const base = `${config.connectorUrl}/api/v1/${config.account}`;
  const token = await probe('token_valid', () => fetchJson(`${base}/token/validate`));
  const profile = await probe('instagram_business_basic', () => fetchJson(`${base}/profile`));
  const media = await probe('media_read', () => fetchJson(`${base}/media?limit=1`));
  const conversations = await probe('instagram_business_manage_messages', () =>
    fetchJson(`${base}/conversations?limit=1`)
  );

  let comments: ProbeResult = {
    name: 'instagram_business_manage_comments',
    ok: false,
    error: 'no media to probe comments',
  };
  try {
    const mediaRows = await fetchJson<{ data?: MediaItem[] }>(`${base}/media?limit=1`);
    const mediaId = mediaRows.data?.[0]?.id;
    if (mediaId) {
      comments = await probe('instagram_business_manage_comments', () =>
        fetchJson(`${base}/media/${mediaId}/comments?limit=1`)
      );
    }
  } catch (error) {
    comments = { name: 'instagram_business_manage_comments', ok: false, error: String(error) };
  }

  const probes = [token, profile, media, comments, conversations];
  logger.info({ account: config.account, probes }, 'instagram connector validation completed');
  return probes;
}

function messageToEvent(
  account: string,
  conversation: Conversation,
  message: InstagramMessage
): InstagramEvent {
  const from = message.from || {};
  return {
    platform: 'instagram',
    account,
    eventType: 'dm',
    senderId: from.id || 'unknown',
    senderUsername: from.username,
    conversationId: conversation.id,
    messageId: message.id,
    text: message.message || message.text || '',
    timestamp: message.created_time || conversation.updated_time || new Date().toISOString(),
  };
}

function mediaToEvent(account: string, media: MediaItem): InstagramEvent {
  return {
    platform: 'instagram',
    account,
    eventType: 'media',
    senderId: account,
    senderUsername: account,
    mediaId: media.id,
    text: [media.media_type, media.caption, media.permalink].filter(Boolean).join(' | '),
    timestamp: media.timestamp || new Date().toISOString(),
  };
}

function commentToEvent(account: string, media: MediaItem, comment: CommentItem): InstagramEvent {
  return {
    platform: 'instagram',
    account,
    eventType: 'comment',
    senderId: comment.username || comment.id,
    senderUsername: comment.username,
    messageId: comment.id,
    mediaId: media.id,
    text: comment.text || '',
    timestamp: comment.timestamp || media.timestamp || new Date().toISOString(),
  };
}

async function ingestOrLog(
  service: InstagramIngestionService | null,
  event: InstagramEvent,
  stats: Record<string, number>
) {
  stats.seen += 1;
  stats[event.eventType] = (stats[event.eventType] || 0) + 1;
  if (!service) {
    logger.info({ event }, 'DRY_RUN would ingest instagram event');
    return;
  }
  await service.handleEvent(event);
  stats.ingested += 1;
}

async function backfill(config: BackfillConfig, service: InstagramIngestionService | null) {
  const base = `${config.connectorUrl}/api/v1/${config.account}`;
  const stats: Record<string, number> = {
    seen: 0,
    ingested: 0,
    dm: 0,
    media: 0,
    comment: 0,
    mention: 0,
  };

  if (config.includeDms && config.maxConversations > 0) {
    const conversations = await fetchJson<{ data?: Conversation[] }>(
      `${base}/conversations?limit=${config.maxConversations}`
    ).catch(error => {
      logger.warn({ error: String(error) }, 'instagram DMs unavailable; continuing without DMs');
      return { data: [] };
    });
    for (const conversation of conversations.data || []) {
      const messages = await fetchJson<{ data?: InstagramMessage[] }>(
        `${base}/conversations/${encodeURIComponent(conversation.id)}/messages?limit=${config.maxMessagesPerConversation}`
      ).catch(error => {
        logger.warn(
          { conversationId: conversation.id, error: String(error) },
          'failed to fetch IG conversation messages'
        );
        return { data: conversation.messages?.data || [] };
      });
      for (const message of messages.data || []) {
        await ingestOrLog(service, messageToEvent(config.account, conversation, message), stats);
      }
    }
  }

  if (config.includeMedia && config.maxMedia > 0) {
    const media = await fetchJson<{ data?: MediaItem[] }>(`${base}/media?limit=${config.maxMedia}`);
    for (const item of media.data || []) {
      await ingestOrLog(service, mediaToEvent(config.account, item), stats);
      if (!config.includeComments || config.maxCommentsPerMedia <= 0) continue;
      const comments = await fetchJson<{ data?: CommentItem[] }>(
        `${base}/media/${encodeURIComponent(item.id)}/comments?limit=${config.maxCommentsPerMedia}`
      ).catch(error => {
        logger.warn({ mediaId: item.id, error: String(error) }, 'failed to fetch IG comments');
        return { data: [] };
      });
      for (const comment of comments.data || []) {
        await ingestOrLog(service, commentToEvent(config.account, item, comment), stats);
      }
    }
  }

  if (config.includeMentions && config.maxMentions > 0) {
    const mentions = await fetchJson<{ data?: MediaItem[] }>(
      `${base}/mentions?limit=${config.maxMentions}`
    ).catch(error => {
      logger.warn(
        { error: String(error) },
        'instagram mentions unavailable; continuing without mentions'
      );
      return { data: [] };
    });
    for (const mention of mentions.data || []) {
      await ingestOrLog(
        service,
        {
          platform: 'instagram',
          account: config.account,
          eventType: 'mention',
          senderId: mention.id,
          mediaId: mention.id,
          text: [mention.media_type, mention.caption, mention.permalink]
            .filter(Boolean)
            .join(' | '),
          timestamp: mention.timestamp || new Date().toISOString(),
        },
        stats
      );
    }
  }

  return stats;
}

async function main() {
  const config = configFromEnv();
  logger.info(
    { config: { ...config, databaseUrl: config.databaseUrl.replace(/:\/\/.*@/, '://***@') } },
    'instagram backfill starting'
  );

  const probes = await validateConnector(config);
  if (config.validateOnly) {
    logger.info({ probes }, 'validate-only complete');
    return;
  }

  const pool = config.dryRun ? null : new Pool({ connectionString: config.databaseUrl, max: 4 });
  const service = pool ? new InstagramIngestionService(pool) : null;
  try {
    if (pool) await pool.query('SELECT 1');
    const stats = await backfill(config, service);
    logger.info(
      { account: config.account, dryRun: config.dryRun, stats },
      'instagram backfill completed'
    );
  } finally {
    if (pool) await pool.end();
  }
}

main().catch(error => {
  logger.error({ error: String(error) }, 'instagram backfill failed');
  process.exit(1);
});
