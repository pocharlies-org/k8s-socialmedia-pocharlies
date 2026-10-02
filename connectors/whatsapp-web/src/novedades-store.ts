/**
 * Durable isolation layer for "Novedades" (WhatsApp channels + statuses).
 *
 * The official Novedades surface is NOT a chat list: a WhatsApp channel is a
 * newsletter JID (`@newsletter`) and a status belongs to its author (the
 * `key.participant` of a `status@broadcast` message). Validated against Baileys
 * 7.0.0-rc13:
 *  - Newsletter message ids (`key.id`, `key.server_id`) are only unique per
 *    channel, so the global `whatsapp_message_payloads` primary key
 *    (account + message id) makes two channels overwrite each other. This
 *    repository keys channel posts by (account, channel_jid, message id).
 *  - rc13 keys for newsletter stanzas carry `server_id` next to `id`
 *    (Utils/decode-wa-message.js), so a locally-created client id can be
 *    reconciled with the server-confirmed id without inventing a parser.
 *  - Statuses expire 24h after being posted in the official app, so the status
 *    repository stores an explicit `expires_at` and only returns active rows.
 *
 * Rules honored by every function in this module:
 *  - Additive: never reads/writes `whatsapp_message_payloads`, `messages`,
 *    `conversations`, or any pre-existing table.
 *  - Originals preserved: `key`/payload are stored verbatim through the same
 *    durable Buffer/Date/BigInt serialization as the existing store; normalized
 *    facts live in dedicated columns plus the `metadata` JSONB (author,
 *    messageType, visibility, ...).
 *  - Ids are raw text (no accountKey prefixing) because `account` is part of
 *    every primary key.
 *  - No physical delete of stored posts: revokes and reconciliations soft-mark
 *    or archive rows (`is_deleted`, `superseded_by`); nothing is discarded.
 *  - No invented freshness: a status without its posting timestamp is stored
 *    only when the caller opts in, and then as "freshness unknown" — it is
 *    never counted as active.
 *  - Visible content is a whitelist: protocol/reaction/sender-key-distribution
 *    are `event` rows and anything else unrecognized is `unknown`; only known
 *    content types are `visible` in the default reads (no hearts-as-posts).
 */
import type { Pool } from 'pg';
import type { WAMessage, WAMessageKey } from '@whiskeysockets/baileys';
import {
  getContentType,
  isJidNewsletter,
  jidNormalizedUser,
  normalizeMessageContent,
} from '@whiskeysockets/baileys';
import { connectorAccount, getPool } from './db-writer';
import { deserializeDurableValue, serializeDurableValue } from './whatsapp-capabilities';

let tablesReady = false;

/** Official statuses disappear 24h after being posted. */
export const NOVEDADES_STATUS_TTL_MS = 24 * 60 * 60 * 1000;
export const NOVEDADES_STATUS_BROADCAST_JID = 'status@broadcast';

export class NovedadesStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = 'NovedadesStoreError';
  }
}

function pool(): Pool {
  return getPool();
}

function poolClient(db: Pool): Promise<{
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
  release: () => void;
}> {
  return db.connect() as unknown as Promise<{
    query: (
      sql: string,
      params?: unknown[]
    ) => Promise<{ rows: unknown[]; rowCount: number | null }>;
    release: () => void;
  }>;
}

function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: string }).code === '23505';
}

function textId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new NovedadesStoreError('INVALID_NOVEDADES_ID', `${field} must be a non-empty string`);
  const clean = value.trim();
  if (clean.length > 256 || /\s/.test(clean))
    throw new NovedadesStoreError('INVALID_NOVEDADES_ID', `Invalid ${field}`);
  return clean;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string')
    throw new NovedadesStoreError('INVALID_NOVEDADES_INPUT', `${field} must be a string`);
  const clean = value.trim();
  if (!clean) return null;
  if ([...clean].length > max)
    throw new NovedadesStoreError('INVALID_NOVEDADES_INPUT', `Invalid ${field}`);
  return clean;
}

function optionalTimestampMs(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  const num = Number(value);
  if (!Number.isSafeInteger(num) || num <= 0)
    throw new NovedadesStoreError('INVALID_NOVEDADES_INPUT', `${field} must be epoch milliseconds`);
  return num;
}

function optionalCount(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  const num = Number(value);
  if (!Number.isSafeInteger(num) || num < 0)
    throw new NovedadesStoreError('INVALID_NOVEDADES_INPUT', `${field} must be a count`);
  return num;
}

function normalizedAuthor(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.includes('@'))
    throw new NovedadesStoreError(
      'INVALID_NOVEDADES_AUTHOR',
      `${field} must be a WhatsApp user JID`
    );
  const normalized = jidNormalizedUser(value.trim());
  if (!/@(?:s\.whatsapp\.net|lid)$/.test(normalized))
    throw new NovedadesStoreError(
      'INVALID_NOVEDADES_AUTHOR',
      `${field} must be a user (@s.whatsapp.net or @lid) JID`
    );
  return normalized;
}

function optionalBoolean(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  return null;
}

function optionalAuthor(value: unknown): string | null {
  if (typeof value !== 'string' || !value.includes('@')) return null;
  try {
    return normalizedAuthor(value, 'author');
  } catch {
    return null;
  }
}

/** Minimal shape of the Baileys keys this store consumes (rc13 includes server_id). */
export interface NovedadesKeyLike {
  id?: string | null;
  remoteJid?: string | null;
  fromMe?: boolean | null;
  sender?: string | null;
  participant?: string | null;
  server_id?: string | null;
}

/** True when the JID identifies a WhatsApp channel (newsletter). */
export function isNovedadesChannelJid(jid: unknown): boolean {
  return typeof jid === 'string' && isJidNewsletter(jid) === true;
}

function channelJid(value: unknown): string {
  if (!isNovedadesChannelJid(value))
    throw new NovedadesStoreError(
      'INVALID_NOVEDADES_CHANNEL',
      'A channel (@newsletter) JID is required'
    );
  return (value as string).trim();
}

/** Routes a message key to its Novedades bucket without inventing heuristics. */
export function novedadesKind(key: NovedadesKeyLike): 'channel' | 'status' | null {
  if (isNovedadesChannelJid(key?.remoteJid)) return 'channel';
  if (key?.remoteJid === NOVEDADES_STATUS_BROADCAST_JID) return 'status';
  return null;
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value))
    throw new NovedadesStoreError(
      'INVALID_NOVEDADES_INPUT',
      'metadata must be a plain object when provided'
    );
  return value as Record<string, unknown>;
}

/**
 * Baileys getContentType() is shallow; normalizeMessageContent() unwraps the
 * real wrapper messages (ephemeralMessage, viewOnce variants,
 * documentWithCaptionMessage, editedMessage, groupStatusMessage...) so
 * classification sees the true content. The raw payload we store is never
 * mutated — normalization is only used on a classification read.
 */
function contentTypeOf(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  try {
    return getContentType(message as NonNullable<WAMessage['message']>) ?? null;
  } catch {
    return null;
  }
}

function normalizedForClassification(message: unknown): unknown {
  if (!message || typeof message !== 'object') return undefined;
  try {
    return normalizeMessageContent(message as NonNullable<WAMessage['message']>);
  } catch {
    return message;
  }
}

const NOVEDADES_EVENT_FIELDS: readonly string[] = [
  'protocolMessage',
  'reactionMessage',
  'senderKeyDistributionMessage',
];

/** Event fields present at the top level or one ephemeralMessage deep. */
function eventFieldOf(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const top = message as Record<string, unknown>;
  const inner =
    top.ephemeralMessage && typeof top.ephemeralMessage === 'object'
      ? ((top.ephemeralMessage as Record<string, unknown>).message as
          Record<string, unknown> | undefined)
      : undefined;
  for (const level of [top, inner]) {
    if (!level) continue;
    for (const field of NOVEDADES_EVENT_FIELDS) if (level[field]) return field;
  }
  return null;
}

/* --------------------------------------------------------------------------
 * Visible-content classification (whitelist; unknown is never visible)
 * ------------------------------------------------------------------------ */

export type NovedadesVisibility = 'visible' | 'event' | 'unknown';

/** Content types that render as channel posts / statuses in the official app. */
const NOVEDADES_VISIBLE_CONTENTS: ReadonlySet<string> = new Set([
  'conversation',
  'extendedTextMessage',
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'ptvMessage',
  'stickerMessage',
  'documentMessage',
  'locationMessage',
  'liveMessage',
  'contactMessage',
  'contactsArrayMessage',
  'groupInviteMessage',
  'buttonsMessage',
  'buttonsResponseMessage',
  'listMessage',
  'listResponseMessage',
  'templateMessage',
  'eventMessage',
  'pollCreationMessage',
  'pollCreationMessageV2',
  'pollCreationMessageV3',
  'pollCreationMessageV4',
  'pollCreationMessageV5',
]);

/**
 * Classifies a Baileys content object for Novedades reads. Events (revokes,
 * reactions, sender-key distributions) and unrecognized content are never
 * `visible`, so reactions never look like posts and unknown types never leak
 * into the public feed.
 */
export function novedadesContentVisibility(message: unknown): {
  visibility: NovedadesVisibility;
  messageType: string | null;
} {
  // Visible wins even when an event field rides along (e.g. a first contact
  // message that also carries senderKeyDistributionMessage).
  const messageType = contentTypeOf(normalizedForClassification(message));
  if (messageType && NOVEDADES_VISIBLE_CONTENTS.has(messageType))
    return { visibility: 'visible', messageType };
  const event = eventFieldOf(message);
  if (event) return { visibility: 'event', messageType: event };
  if (messageType) return { visibility: 'unknown', messageType };
  return { visibility: 'unknown', messageType: null };
}

/**
 * Channel/status traffic that is NOT a post or status: revokes
 * (protocolMessage), reactions (reactionMessage) and sender-key
 * distributions. Checks documented proto fields at the top level or one
 * ephemeralMessage wrapper deep (same paths the existing store queries).
 */
export function isNovedadesAuxiliaryMessage(message: unknown): boolean {
  return eventFieldOf(message) !== null;
}

/** Tables owned by the connector; deployment migrations can adopt them later. */
export async function ensureNovedadesTables(): Promise<void> {
  if (tablesReady) return;
  const db = pool();
  const client = await poolClient(db);
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [20260927, 1]);
    await client.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_novedades_channels (
      account text NOT NULL,
      channel_jid text NOT NULL,
      name text NOT NULL,
      description text,
      owner_jid text,
      role text,
      verification text,
      avatar_url text,
      invite_code text,
      subscriber_count integer,
      creation_timestamp_ms bigint,
      mute_state text,
      raw_metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account, channel_jid)
    )
  `);
    await client.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_novedades_messages (
      account text NOT NULL,
      channel_jid text NOT NULL,
      message_id text NOT NULL,
      server_id text,
      client_id text,
      superseded_by text,
      from_me boolean NOT NULL DEFAULT false,
      message_key jsonb NOT NULL,
      message_payload jsonb,
      message_timestamp_ms bigint,
      message_type text,
      visibility text NOT NULL DEFAULT 'unknown',
      author_jid text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      is_deleted boolean NOT NULL DEFAULT false,
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account, channel_jid, message_id)
    )
  `);
    await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_novedades_messages_server_uidx
      ON whatsapp_novedades_messages (account, channel_jid, server_id)
      WHERE server_id IS NOT NULL AND superseded_by IS NULL
  `);
    await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_novedades_messages_client_uidx
      ON whatsapp_novedades_messages (account, channel_jid, client_id)
      WHERE client_id IS NOT NULL AND superseded_by IS NULL
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS idx_whatsapp_novedades_messages_channel_time
      ON whatsapp_novedades_messages (account, channel_jid, message_timestamp_ms DESC)
  `);
    await client.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_novedades_status (
      account text NOT NULL,
      author_jid text NOT NULL,
      wa_message_id text NOT NULL,
      message_key jsonb NOT NULL,
      message_payload jsonb,
      message_timestamp_ms bigint,
      message_type text,
      visibility text NOT NULL DEFAULT 'unknown',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      posted_at timestamptz,
      expires_at timestamptz,
      is_deleted boolean NOT NULL DEFAULT false,
      deleted_at timestamptz,
      seen_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account, author_jid, wa_message_id)
    )
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS idx_whatsapp_novedades_status_expiry
      ON whatsapp_novedades_status (account, expires_at)
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS idx_whatsapp_novedades_status_author_time
      ON whatsapp_novedades_status (account, author_jid, posted_at DESC)
  `);
    await client.query('COMMIT');
    tablesReady = true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/* --------------------------------------------------------------------------
 * Channel directory
 * ------------------------------------------------------------------------ */

export interface NovedadesChannelInput {
  /** Bare `@newsletter` JID. */
  jid: string;
  name: string;
  description?: string | null;
  ownerJid?: string | null;
  role?: string | null;
  verification?: string | null;
  avatarUrl?: string | null;
  inviteCode?: string | null;
  subscriberCount?: number | null;
  creationTimestampMs?: number | null;
  muteState?: string | null;
  /** Provider metadata preserved verbatim. */
  rawMetadata?: unknown;
}

export interface StoredNovedadesChannel extends NovedadesChannelInput {
  account: string;
}

interface NovedadesChannelRow {
  account?: string;
  channel_jid?: string;
  name?: string;
  description?: string | null;
  owner_jid?: string | null;
  role?: string | null;
  verification?: string | null;
  avatar_url?: string | null;
  invite_code?: string | null;
  subscriber_count?: string | number | null;
  creation_timestamp_ms?: string | number | null;
  mute_state?: string | null;
  raw_metadata?: unknown;
}

function channelFields(input: unknown): NovedadesChannelInput {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new NovedadesStoreError('INVALID_NOVEDADES_INPUT', 'A channel object is required');
  const source = input as Record<string, unknown>;
  return {
    jid: channelJid(source.jid),
    name: optionalText(source.name, 'name', 512) ?? '',
    description: optionalText(source.description, 'description', 4096),
    ownerJid: optionalAuthor(source.ownerJid),
    role: optionalText(source.role, 'role', 32),
    verification: optionalText(source.verification, 'verification', 32),
    avatarUrl: optionalText(source.avatarUrl, 'avatarUrl', 2048),
    inviteCode: optionalText(source.inviteCode, 'inviteCode', 512),
    subscriberCount: optionalCount(source.subscriberCount, 'subscriberCount'),
    creationTimestampMs: optionalTimestampMs(source.creationTimestampMs, 'creationTimestampMs'),
    muteState: optionalText(source.muteState, 'muteState', 16),
    rawMetadata: source.rawMetadata ?? null,
  };
}

/**
 * Maps fields with the NOMINAL names of Baileys Mex.d.ts `NewsletterMetadata`
 * (id/name/description/owner/subscribers/creation_time/picture.url/invite/
 * verification/mute_state) onto normalized columns.
 *
 * WARNING (2026-09-27 review): real WMex channel responses are nested payloads
 * whose raw shape differs from these nominal type names, and no validated
 * provider parser exists yet. Until one lands, treat this helper as
 * NORMALIZED-ONLY (do not feed it raw WMex responses); the integration should
 * build a `NovedadesChannelInput` from a validated parser and call
 * `upsertNovedadesChannel` directly.
 */
export function normalizeNovedadesChannel(
  metadata: unknown,
  options: { role?: string | null } = {}
): NovedadesChannelInput {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new NovedadesStoreError(
      'INVALID_NOVEDADES_INPUT',
      'NewsletterMetadata object is required'
    );
  const meta = metadata as Record<string, unknown>;
  const picture =
    meta.picture && typeof meta.picture === 'object'
      ? (meta.picture as Record<string, unknown>)
      : {};
  const invite =
    typeof meta.invite === 'string'
      ? meta.invite
      : meta.invite && typeof meta.invite === 'object'
        ? ((meta.invite as Record<string, unknown>).code ?? null)
        : null;
  return channelFields({
    jid: meta.id,
    name: meta.name,
    description: meta.description ?? null,
    ownerJid: meta.owner ?? null,
    role: options.role ?? null,
    verification: meta.verification ?? null,
    avatarUrl: picture.url ?? null,
    inviteCode: invite,
    subscriberCount: meta.subscribers ?? null,
    creationTimestampMs: secondsToMs(meta.creation_time),
    muteState: meta.mute_state ?? null,
    rawMetadata: metadata,
  });
}

/** Baileys exposes newsletter creation times in epoch seconds. */
function secondsToMs(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const num = Number(value);
  if (!Number.isSafeInteger(num) || num <= 0) return null;
  return num * 1000;
}

export async function upsertNovedadesChannel(input: unknown): Promise<void> {
  const channel = channelFields(input);
  await pool().query(
    `INSERT INTO whatsapp_novedades_channels
       (account, channel_jid, name, description, owner_jid, role, verification, avatar_url,
        invite_code, subscriber_count, creation_timestamp_ms, mute_state, raw_metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
     ON CONFLICT (account, channel_jid) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, whatsapp_novedades_channels.name),
       description = COALESCE(EXCLUDED.description, whatsapp_novedades_channels.description),
       owner_jid = COALESCE(EXCLUDED.owner_jid, whatsapp_novedades_channels.owner_jid),
       role = COALESCE(EXCLUDED.role, whatsapp_novedades_channels.role),
       verification = COALESCE(EXCLUDED.verification, whatsapp_novedades_channels.verification),
       avatar_url = COALESCE(EXCLUDED.avatar_url, whatsapp_novedades_channels.avatar_url),
       invite_code = COALESCE(EXCLUDED.invite_code, whatsapp_novedades_channels.invite_code),
       subscriber_count = COALESCE(EXCLUDED.subscriber_count, whatsapp_novedades_channels.subscriber_count),
       creation_timestamp_ms = COALESCE(EXCLUDED.creation_timestamp_ms, whatsapp_novedades_channels.creation_timestamp_ms),
       mute_state = COALESCE(EXCLUDED.mute_state, whatsapp_novedades_channels.mute_state),
       raw_metadata = COALESCE(EXCLUDED.raw_metadata, whatsapp_novedades_channels.raw_metadata),
       updated_at = now()`,
    [
      connectorAccount(),
      channel.jid,
      channel.name,
      channel.description,
      channel.ownerJid,
      channel.role,
      channel.verification,
      channel.avatarUrl,
      channel.inviteCode,
      channel.subscriberCount,
      channel.creationTimestampMs,
      channel.muteState,
      channel.rawMetadata === null || channel.rawMetadata === undefined
        ? null
        : serializeDurableValue(channel.rawMetadata),
    ]
  );
}

function boundedLimit(value: unknown, fallback = 500): number {
  if (value === undefined || value === null) return fallback;
  const num = Number(value);
  if (!Number.isSafeInteger(num) || num < 1)
    throw new NovedadesStoreError('INVALID_NOVEDADES_INPUT', 'limit must be a positive integer');
  return Math.min(num, 2000);
}

export async function listNovedadesChannels(
  options: {
    limit?: number;
    /**
     * Keyset cursor for deterministic paging: the previous page's last channel.
     * Sorting is `lower(name), channel_jid`, so equal names still advance.
     */
    after?: { name: string; jid: string } | null;
  } = {}
): Promise<StoredNovedadesChannel[]> {
  const limit = boundedLimit(options.limit);
  const params: unknown[] = [connectorAccount()];
  let where = 'account = $1';
  if (options.after) {
    params.push(String(options.after.name ?? '').toLowerCase(), String(options.after.jid));
    where += `
      AND (lower(name) > $2 OR (lower(name) = $2 AND channel_jid > $3))`;
  }
  params.push(limit);
  const result = await pool().query(
    `${CHANNEL_SELECT}
      WHERE ${where}
      ORDER BY lower(name), channel_jid
      LIMIT $${params.length}`,
    params
  );
  return (result.rows as NovedadesChannelRow[]).map(mapChannelRow);
}

const CHANNEL_SELECT = `SELECT account, channel_jid, name, description, owner_jid, role, verification,
            avatar_url, invite_code, subscriber_count, creation_timestamp_ms, mute_state,
            raw_metadata
       FROM whatsapp_novedades_channels`;

function mapChannelRow(row: NovedadesChannelRow): StoredNovedadesChannel {
  return {
    account: String(row.account),
    jid: String(row.channel_jid),
    name: String(row.name),
    description: row.description ?? null,
    ownerJid: row.owner_jid ?? null,
    role: row.role ?? null,
    verification: row.verification ?? null,
    avatarUrl: row.avatar_url ?? null,
    inviteCode: row.invite_code ?? null,
    subscriberCount: row.subscriber_count == null ? null : Number(row.subscriber_count),
    creationTimestampMs:
      row.creation_timestamp_ms == null ? null : Number(row.creation_timestamp_ms),
    muteState: row.mute_state ?? null,
    rawMetadata: row.raw_metadata == null ? null : deserializeDurableValue(row.raw_metadata),
  };
}

/**
 * One channel row for THIS account, exactly. Used by the read paths (avatar
 * download, post-list channel header) so they never have to scan a page of
 * channels hoping the wanted JID is inside it.
 */
export async function getNovedadesChannel(
  channelJidValue: string
): Promise<StoredNovedadesChannel | undefined> {
  const channel = channelJid(channelJidValue);
  const result = await pool().query(
    `${CHANNEL_SELECT} WHERE account = $1 AND channel_jid = $2 LIMIT 1`,
    [connectorAccount(), channel]
  );
  const row = result.rows[0] as NovedadesChannelRow | undefined;
  return row ? mapChannelRow(row) : undefined;
}

/* --------------------------------------------------------------------------
 * Channel posts
 * ------------------------------------------------------------------------ */

export interface NovedadesMessageInput {
  channelJid: string;
  key: NovedadesKeyLike;
  /** Raw Baileys content (WAMessage['message']); preserved verbatim when provided. */
  message?: unknown;
  messageTimestampMs?: number | null;
  /**
   * Tells the store what `key.id` is when the key carries no `server_id`:
   * 'server' (default) for server-delivered post ids, 'client' for ids created
   * locally when posting to your own channel (reconcile later via
   * reconcileNovedadesMessageIds or a later key that includes key.server_id).
   */
  identityKind?: 'server' | 'client';
  /** Normalized extras (counts, view info, ...) merged into metadata JSONB. */
  metadata?: Record<string, unknown>;
}

export interface StoredNovedadesMessage {
  account: string;
  channelJid: string;
  messageId: string;
  serverId: string | null;
  clientId: string | null;
  /** Set when this row was archived by a client/server reconciliation. */
  supersededBy: string | null;
  fromMe: boolean;
  key: WAMessageKey;
  payload: unknown;
  timestampMs: number | null;
  messageType: string | null;
  visibility: NovedadesVisibility;
  authorJid: string | null;
  metadata: Record<string, unknown>;
  isDeleted: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface NovedadesMessageRow {
  account?: string;
  channel_jid?: string;
  message_id?: string;
  server_id?: string | null;
  client_id?: string | null;
  superseded_by?: string | null;
  from_me?: boolean | null;
  message_key?: unknown;
  message_payload?: unknown;
  message_timestamp_ms?: string | number | null;
  message_type?: string | null;
  visibility?: string | null;
  author_jid?: string | null;
  metadata?: unknown;
  is_deleted?: boolean;
  deleted_at?: Date | string | null;
  created_at?: Date | string;
  updated_at?: Date | string;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value).toISOString();
}

function mapMessageRow(row: NovedadesMessageRow): StoredNovedadesMessage {
  return {
    account: String(row.account),
    channelJid: String(row.channel_jid),
    messageId: String(row.message_id),
    serverId: row.server_id ?? null,
    clientId: row.client_id ?? null,
    supersededBy: row.superseded_by ?? null,
    fromMe: !!row.from_me,
    key: deserializeDurableValue(row.message_key) as WAMessageKey,
    payload: row.message_payload == null ? null : deserializeDurableValue(row.message_payload),
    timestampMs: row.message_timestamp_ms == null ? null : Number(row.message_timestamp_ms),
    messageType: row.message_type ?? null,
    visibility: (row.visibility === 'visible' || row.visibility === 'event'
      ? row.visibility
      : 'unknown') as NovedadesVisibility,
    authorJid: row.author_jid ?? null,
    metadata: (deserializeDurableValue(row.metadata ?? {}) || {}) as Record<string, unknown>,
    isDeleted: !!row.is_deleted,
    deletedAt: iso(row.deleted_at),
    createdAt: String(iso(row.created_at)),
    updatedAt: String(iso(row.updated_at)),
  };
}

/**
 * Resolves which id is canonical for storage. Uses the same fields Baileys
 * rc13 puts on newsletter keys (`id` plus optional `server_id`):
 *  - key.server_id present: canonical = server_id, client_id = key.id (if different)
 *  - identityKind 'client': canonical = key.id stored as client_id
 *  - otherwise: canonical = key.id, stored as server_id (server-delivered posts)
 */
export function novedadesMessageIdentity(
  key: NovedadesKeyLike,
  identityKind: 'server' | 'client' = 'server'
): { messageId: string; serverId: string | null; clientId: string | null } {
  const id = textId(key?.id, 'key.id');
  const serverHint =
    typeof key?.server_id === 'string' && key.server_id.trim() ? key.server_id.trim() : null;
  if (serverHint && serverHint === id) return { messageId: id, serverId: id, clientId: null };
  if (serverHint) return { messageId: serverHint, serverId: serverHint, clientId: id };
  if (identityKind === 'client') return { messageId: id, serverId: null, clientId: id };
  return { messageId: id, serverId: id, clientId: null };
}

interface NovedadesQueryRunner {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** Content of one incoming event, merged into (never replacing) a live post. */
interface PostMergeValues {
  account: string;
  channel: string;
  fromMe: boolean | null;
  messageKey: string;
  messagePayload: string | null;
  timestampMs: number | null;
  messageType: string | null;
  visibility: NovedadesVisibility;
  authorJid: string | null;
  metadataJson: string;
}

type PostIdentity = ReturnType<typeof novedadesMessageIdentity>;

function poolRunner(): NovedadesQueryRunner {
  const db = pool();
  return { query: (sql, params) => db.query(sql, params) };
}

function uniqueConstraint(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const constraint = (error as { constraint?: unknown }).constraint;
  return typeof constraint === 'string' && constraint ? constraint : undefined;
}

/**
 * Merge one event into the live post stored under `targetColumn`. Content only
 * changes when the event actually carries it, so a payload-less ACK cannot erase
 * a stored payload, author, visibility, or `from_me`. `is_deleted` is untouched:
 * a revoked post stays revoked.
 */
async function mergeIntoLivePost(
  runner: NovedadesQueryRunner,
  targetColumn: 'message_id' | 'server_id' | 'client_id',
  targetValue: string,
  values: PostMergeValues,
  identity: PostIdentity
): Promise<string | undefined> {
  const result = await runner.query(
    `UPDATE whatsapp_novedades_messages
        SET message_key = whatsapp_novedades_messages.message_key
          || jsonb_strip_nulls($1::jsonb),
            message_payload = COALESCE($2::jsonb, message_payload),
            message_timestamp_ms = COALESCE($3, message_timestamp_ms),
            message_type = COALESCE($4, message_type),
            visibility = CASE
              WHEN $2::jsonb IS NOT NULL THEN $5
              ELSE whatsapp_novedades_messages.visibility
            END,
            author_jid = COALESCE($6, author_jid),
            server_id = COALESCE($7, server_id),
            client_id = COALESCE($8, client_id),
            from_me = COALESCE($9::boolean, whatsapp_novedades_messages.from_me),
            metadata = whatsapp_novedades_messages.metadata || jsonb_strip_nulls($10::jsonb),
            updated_at = now()
      WHERE account = $11 AND channel_jid = $12 AND ${targetColumn} = $13
        AND superseded_by IS NULL
      RETURNING message_id`,
    [
      values.messageKey,
      values.messagePayload,
      values.timestampMs,
      values.messageType,
      values.visibility,
      values.authorJid,
      identity.serverId,
      identity.clientId,
      values.fromMe,
      values.metadataJson,
      values.account,
      values.channel,
      targetValue,
    ]
  );
  const row = result.rows[0] as { message_id?: unknown } | undefined;
  return row?.message_id === undefined ? undefined : String(row.message_id);
}

/**
 * A unique partial index proved that this channel already holds one of the ids of
 * this key on a DIFFERENT live row. Collapse the duplicate inside a single
 * transaction: archive the client row (which releases the partial unique
 * indexes), merge flags and metadata into the survivor, then apply this event to
 * it. Ingestion therefore never surfaces a raw 23505 and never leaves two live
 * rows for one post. If a concurrent ingest claimed the alias mid-transaction,
 * the whole claim is retried once.
 */
async function reconcileAndMergeSurvivor(
  values: PostMergeValues,
  identity: PostIdentity
): Promise<string | undefined> {
  if (!identity.serverId || !identity.clientId) return undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const client = await poolClient(pool());
    try {
      await client.query('BEGIN');
      const outcome = await reconcileWithinTransaction(client, {
        account: values.account,
        channel: values.channel,
        clientId: identity.clientId,
        serverId: identity.serverId,
      });
      const survivor = outcome.messageId;
      if (!survivor) {
        await client.query('COMMIT');
        return undefined;
      }
      const matched = await mergeIntoLivePost(client, 'message_id', survivor, values, identity);
      await client.query('COMMIT');
      return matched ?? survivor;
    } catch (error) {
      await client.query('ROLLBACK');
      if (!isUniqueViolation(error)) throw error;
    } finally {
      client.release();
    }
  }
  return undefined;
}

/**
 * Upserts one channel post scoped by (account, channel_jid, message id), so the
 * same `server_id` may exist once per channel without collisions (validated on
 * rc13: newsletter ids repeat across channels). The original key and payload
 * are preserved; re-delivery refreshes content but never revives deleted rows.
 * When a unique partial index shows the post already lives under another id
 * (client id confirmed by the server), the existing live row is refreshed in
 * place.
 */
export async function storeNovedadesMessage(
  input: NovedadesMessageInput
): Promise<{ matchedMessageId: string; visibility: NovedadesVisibility }> {
  const account = connectorAccount();
  const channel = channelJid(input.channelJid);
  if (input.key?.remoteJid && input.key.remoteJid.trim() !== channel)
    throw new NovedadesStoreError(
      'NOVEDADES_CHANNEL_MISMATCH',
      'key.remoteJid must match the channel JID the post is stored under'
    );
  const kind = input.identityKind === 'client' ? 'client' : 'server';
  const identity = novedadesMessageIdentity(input.key || {}, kind);
  const timestampMs = optionalTimestampMs(input.messageTimestampMs, 'messageTimestampMs');
  const metadata = metadataObject(input.metadata);
  const content = novedadesContentVisibility(input.message);
  const params = {
    account,
    channel,
    fromMe: optionalBoolean(input.key?.fromMe),
    messageKey: serializeDurableValue(input.key),
    messagePayload:
      input.message === undefined || input.message === null
        ? null
        : serializeDurableValue(input.message),
    timestampMs,
    messageType: content.messageType,
    visibility: content.visibility,
    authorJid: optionalAuthor(input.key?.participant ?? input.key?.sender),
    metadataJson: JSON.stringify(metadata),
  };
  try {
    const inserted = await pool().query<{ message_id: string }>(
      `INSERT INTO whatsapp_novedades_messages
         (account, channel_jid, message_id, server_id, client_id, from_me, message_key,
          message_payload, message_timestamp_ms, message_type, visibility, author_jid, metadata)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::boolean, false), $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13::jsonb)
       ON CONFLICT (account, channel_jid, message_id) DO UPDATE SET
         message_key = whatsapp_novedades_messages.message_key
           || jsonb_strip_nulls(EXCLUDED.message_key),
         message_payload = COALESCE(EXCLUDED.message_payload, whatsapp_novedades_messages.message_payload),
         message_timestamp_ms = COALESCE(EXCLUDED.message_timestamp_ms, whatsapp_novedades_messages.message_timestamp_ms),
         message_type = COALESCE(EXCLUDED.message_type, whatsapp_novedades_messages.message_type),
         visibility = CASE
           WHEN EXCLUDED.message_payload IS NOT NULL
             THEN EXCLUDED.visibility
           ELSE whatsapp_novedades_messages.visibility
         END,
         author_jid = COALESCE(EXCLUDED.author_jid, whatsapp_novedades_messages.author_jid),
         server_id = COALESCE(EXCLUDED.server_id, whatsapp_novedades_messages.server_id),
         client_id = COALESCE(EXCLUDED.client_id, whatsapp_novedades_messages.client_id),
         from_me = COALESCE($6::boolean, whatsapp_novedades_messages.from_me),
         metadata = whatsapp_novedades_messages.metadata
           || jsonb_strip_nulls(EXCLUDED.metadata),
         updated_at = now()
       RETURNING message_id`,
      [
        params.account,
        params.channel,
        identity.messageId,
        identity.serverId,
        identity.clientId,
        params.fromMe,
        params.messageKey,
        params.messagePayload,
        params.timestampMs,
        params.messageType,
        params.visibility,
        params.authorJid,
        params.metadataJson,
      ]
    );
    return {
      matchedMessageId: String(inserted.rows[0]?.message_id ?? identity.messageId),
      visibility: params.visibility,
    };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    try {
      const collapsed = await reconcileAndMergeSurvivor(params, identity);
      if (collapsed) return { matchedMessageId: collapsed, visibility: params.visibility };
      if (identity.serverId) {
        const byServer = await mergeIntoLivePost(
          poolRunner(),
          'server_id',
          identity.serverId,
          params,
          identity
        );
        if (byServer) return { matchedMessageId: byServer, visibility: params.visibility };
      }
      if (identity.clientId) {
        const byClient = await mergeIntoLivePost(
          poolRunner(),
          'client_id',
          identity.clientId,
          params,
          identity
        );
        if (byClient) return { matchedMessageId: byClient, visibility: params.visibility };
      }
    } catch (mergeError) {
      if (!isUniqueViolation(mergeError)) throw mergeError;
      throw new NovedadesStoreError(
        'NOVEDADES_IDENTITY_CONFLICT',
        `A live post of this channel still holds the same server or client id (${
          uniqueConstraint(mergeError) ?? 'unknown constraint'
        }); reconcile it explicitly`,
        409
      );
    }
    throw new NovedadesStoreError(
      'NOVEDADES_IDENTITY_CONFLICT',
      'This channel already stores a different live post under the same server or client id; reconcile it explicitly',
      409
    );
  }
}

/** Looks a live post up by any known id (message_id, server_id, or client_id). */
export async function getNovedadesMessage(
  channelJidValue: string,
  messageId: string,
  options: { includeSuperseded?: boolean } = {}
): Promise<StoredNovedadesMessage | undefined> {
  const channel = channelJid(channelJidValue);
  const id = textId(messageId, 'messageId');
  const params: unknown[] = [connectorAccount(), channel, id];
  let where =
    'account = $1 AND channel_jid = $2 AND (message_id = $3 OR server_id = $3 OR client_id = $3)';
  if (!options.includeSuperseded) where += ' AND superseded_by IS NULL';
  const result = await pool().query(
    `SELECT *
       FROM whatsapp_novedades_messages
      WHERE ${where}
      ORDER BY (message_id = $3) DESC, updated_at DESC
      LIMIT 1`,
    params
  );
  const row = result.rows[0] as NovedadesMessageRow | undefined;
  return row ? mapMessageRow(row) : undefined;
}

export async function listNovedadesMessages(
  channelJidValue: string,
  options: {
    limit?: number;
    beforeTimestampMs?: number | null;
    /**
     * Keyset cursor (previous page's last item). The tie-breaker on
     * `message_id` is what guarantees progress when more rows than `limit`
     * share one exact timestamp; a timestamp-only cursor would keep returning
     * the same page forever.
     */
    after?: { timestampMs: number | null; id: string } | null;
    includeDeleted?: boolean;
    includeSuperseded?: boolean;
    /** Default 'visible'; use 'all' to include events/unknown rows. */
    visibility?: NovedadesVisibility | 'all';
  } = {}
): Promise<StoredNovedadesMessage[]> {
  const channel = channelJid(channelJidValue);
  const params: unknown[] = [connectorAccount(), channel];
  let where = 'account = $1 AND channel_jid = $2';
  const before = optionalTimestampMs(options.beforeTimestampMs, 'beforeTimestampMs');
  if (before !== null) {
    params.push(before);
    where += ` AND message_timestamp_ms < $${params.length}`;
  }
  if (options.after) {
    const cursorId = textId(options.after.id, 'after.id');
    const cursorTs =
      options.after.timestampMs === null
        ? null
        : optionalTimestampMs(options.after.timestampMs, 'after.timestampMs');
    params.push(cursorTs, cursorId);
    const tsParam = `$${params.length - 1}`;
    const idParam = `$${params.length}`;
    // Rows without a timestamp sort last, ordered by id descending, so the
    // tail needs its own branch instead of a NULL comparison that never matches.
    where += `
      AND (CASE
             WHEN ${tsParam}::bigint IS NULL
               THEN (message_timestamp_ms IS NULL AND message_id < ${idParam})
             ELSE message_timestamp_ms IS NULL
               OR message_timestamp_ms < ${tsParam}::bigint
               OR (message_timestamp_ms = ${tsParam}::bigint AND message_id < ${idParam})
           END)`;
  }
  if (options.includeDeleted !== true) where += ' AND NOT is_deleted';
  if (!options.includeSuperseded) where += ' AND superseded_by IS NULL';
  const visibility = options.visibility ?? 'visible';
  if (visibility !== 'all') {
    params.push(visibility);
    where += ` AND visibility = $${params.length}`;
  }
  params.push(boundedLimit(options.limit));
  const result = await pool().query(
    `SELECT *
       FROM whatsapp_novedades_messages
      WHERE ${where}
      ORDER BY message_timestamp_ms DESC NULLS LAST, message_id DESC
      LIMIT $${params.length}`,
    params
  );
  return (result.rows as NovedadesMessageRow[]).map(mapMessageRow);
}

/**
 * Soft-deletes a live post (revoke). The stored key and payload stay intact —
 * the row is never rewritten, so history survives, and re-delivery (upsert)
 * does not revive the flag. When the revoke arrives BEFORE the post row
 * exists, an honest tombstone is inserted (payload NULL, visibility 'unknown',
 * synthetic marker key) so a later post upsert keeps the deletion instead of
 * resurrecting the post. Never a physical delete.
 */
export async function markNovedadesMessageDeleted(
  channelJidValue: string,
  messageId: string,
  options: { deleted?: boolean } = {}
): Promise<{ marked: boolean; createdTombstone: boolean }> {
  const channel = channelJid(channelJidValue);
  const id = textId(messageId, 'messageId');
  const deleted = options.deleted !== false;
  const account = connectorAccount();
  const db = pool();
  const client = await poolClient(db);
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE whatsapp_novedades_messages
          SET is_deleted = $4::boolean,
              deleted_at = CASE WHEN $4::boolean THEN COALESCE(deleted_at, now()) ELSE NULL END,
              updated_at = now()
        WHERE account = $1 AND channel_jid = $2
          AND (message_id = $3 OR server_id = $3 OR client_id = $3)
          AND superseded_by IS NULL`,
      [account, channel, id, deleted]
    );
    let createdTombstone = false;
    if (!updated.rowCount && deleted) {
      await client.query(
        `INSERT INTO whatsapp_novedades_messages
           (account, channel_jid, message_id, from_me, message_key, message_payload,
            visibility, metadata, is_deleted, deleted_at)
         VALUES ($1, $2, $3, false, $4::jsonb, NULL, 'unknown',
                 '{"tombstone": true}'::jsonb, true, now())
         ON CONFLICT (account, channel_jid, message_id) DO UPDATE SET
           is_deleted = TRUE,
           deleted_at = COALESCE(whatsapp_novedades_messages.deleted_at, now()),
           updated_at = now()`,
        [account, channel, id, JSON.stringify({ id, remoteJid: channel, tombstone: true })]
      );
      createdTombstone = true;
    }
    await client.query('COMMIT');
    return { marked: true, createdTombstone };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface NovedadesReconcileInput {
  channelJid: string;
  clientId: string;
  serverId: string;
}

export interface NovedadesReconcileResult {
  status: 'updated' | 'not_found';
  /** Canonical id of the single live row that now represents the post. */
  messageId?: string;
  /**
   * True when both a server row and a client row existed: the client row was
   * archived (`superseded_by` set, all its original columns preserved) and its
   * ids/metadata/flags merged into the live server row. Nothing is ever
   * physically deleted here.
   */
  mergedDuplicate?: boolean;
}

/**
 * Joins the locally-created client id of a channel post with its
 * server-confirmed id (Baileys delivers the mapping through `key.server_id`
 * or through receipt updates). Ends with exactly one LIVE row per post, stored
 * under the server id and carrying both id columns; a pre-existing duplicate
 * client row is archived (payload preserved) rather than deleted.
 * Transactional; row-locks both candidates first.
 */
export async function reconcileNovedadesMessageIds(
  input: NovedadesReconcileInput
): Promise<NovedadesReconcileResult> {
  const channel = channelJid(input.channelJid);
  const clientId = textId(input.clientId, 'clientId');
  const serverId = textId(input.serverId, 'serverId');
  if (clientId === serverId) return { status: 'updated', messageId: serverId };
  const client = await poolClient(pool());
  try {
    await client.query('BEGIN');
    const outcome = await reconcileWithinTransaction(client, {
      account: connectorAccount(),
      channel,
      clientId,
      serverId,
    });
    await client.query('COMMIT');
    return outcome;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Collapse a client/server duplicate inside the caller's transaction. Rows are
 * locked canonical-first and then alias-held, so concurrent reconciles with the
 * same client/server roles use the same lock order. No physical DELETE is issued: the duplicate row is
 * archived with superseded_by, which also releases the partial unique indexes
 * that hold its ids, and its payload stays verbatim.
 */
async function reconcileWithinTransaction(
  client: NovedadesQueryRunner,
  opts: { account: string; channel: string; clientId: string; serverId: string }
): Promise<NovedadesReconcileResult> {
  const { account, channel, clientId, serverId } = opts;
  const lookup = async (alias: string): Promise<NovedadesMessageRow | undefined> =>
    (
      await client.query(
        `SELECT message_id, server_id, client_id, metadata, is_deleted, deleted_at, from_me
             FROM whatsapp_novedades_messages
            WHERE account = $1 AND channel_jid = $2 AND superseded_by IS NULL
              AND (message_id = $3 OR server_id = $3 OR client_id = $3)
            ORDER BY (message_id = $3) DESC
            LIMIT 1
              FOR UPDATE`,
        [account, channel, alias]
      )
    ).rows[0] as NovedadesMessageRow | undefined;
  const serverRow = await lookup(serverId);
  const clientRow = await lookup(clientId);
  const distinctClientRow =
    clientRow && clientRow.message_id !== serverRow?.message_id ? clientRow : undefined;
  if (serverRow) {
    const serverMessageId = String(serverRow.message_id);
    if (distinctClientRow) {
      // Release the alias first: archive the client row so its ids stop
      // competing with the live row's unique partial indexes. Every original
      // column (key, payload, ids, flags) stays on the archived row.
      await client.query(
        `UPDATE whatsapp_novedades_messages
              SET superseded_by = $4,
                  metadata = metadata || jsonb_build_object('reconciled_into', $5::text),
                  updated_at = now()
            WHERE account = $1 AND channel_jid = $2 AND message_id = $3`,
        [account, channel, String(distinctClientRow.message_id), serverMessageId, serverMessageId]
      );
    }
    await client.query(
      `UPDATE whatsapp_novedades_messages
            SET server_id = COALESCE(server_id, $3),
                client_id = COALESCE(client_id, $4),
                metadata = jsonb_strip_nulls($5::jsonb) || metadata,
                is_deleted = is_deleted OR COALESCE($6::boolean, false),
                deleted_at = CASE
                  WHEN is_deleted OR COALESCE($6::boolean, false)
                    THEN COALESCE(deleted_at, $7::timestamptz, now())
                  ELSE deleted_at
                END,
                from_me = from_me OR COALESCE($8::boolean, false),
                updated_at = now()
          WHERE account = $1 AND channel_jid = $2 AND message_id = $9`,
      [
        account,
        channel,
        serverId,
        distinctClientRow?.client_id ?? clientId,
        typeof distinctClientRow?.metadata === 'string'
          ? distinctClientRow.metadata
          : JSON.stringify(distinctClientRow?.metadata ?? {}),
        distinctClientRow ? !!distinctClientRow.is_deleted : false,
        distinctClientRow?.deleted_at ? new Date(distinctClientRow.deleted_at).toISOString() : null,
        distinctClientRow?.from_me == null ? null : !!distinctClientRow.from_me,
        serverMessageId,
      ]
    );
    return {
      status: 'updated',
      messageId: serverMessageId,
      mergedDuplicate: !!distinctClientRow,
    };
  }
  if (clientRow) {
    await client.query(
      `UPDATE whatsapp_novedades_messages
            SET message_id = $4,
                server_id = $4,
                client_id = COALESCE(client_id, $5),
                updated_at = now()
          WHERE account = $1 AND channel_jid = $2 AND message_id = $3
          RETURNING message_id`,
      [account, channel, String(clientRow.message_id), serverId, clientId]
    );
    return { status: 'updated', messageId: serverId };
  }
  return { status: 'not_found' };
}

/* --------------------------------------------------------------------------
 * Statuses (author-scoped, expire 24h after posting)
 * ------------------------------------------------------------------------ */

export interface NovedadesStatusInput {
  key: NovedadesKeyLike;
  /**
   * Fallback author for statuses published by THIS account itself (Baileys
   * omits key.participant on own sends): only honored when key.fromMe === true
   * and key.participant/key.sender are absent. The raw key is never modified.
   */
  authorJid?: string | null;
  message?: unknown;
  messageTimestampMs?: number | null;
  /**
   * A status without its posting timestamp has unknown freshness: it must not
   * be dressed up as new via Date.now(). Inserts therefore REQUIRE a
   * timestamp, unless the caller explicitly opts into storing the row as
   * freshness-unknown (excluded from active reads, never pruned).
   */
  allowUnknownFreshness?: boolean;
  /** Overrides the default posted-at + 24h expiry (tests / provider hints). */
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
}

export interface StoredNovedadesStatus {
  account: string;
  authorJid: string;
  messageId: string;
  fromMe: boolean;
  key: WAMessageKey;
  payload: unknown;
  timestampMs: number | null;
  messageType: string | null;
  visibility: NovedadesVisibility;
  metadata: Record<string, unknown>;
  postedAt: string | null;
  expiresAt: string | null;
  seenAt: string | null;
  ttlRemainingMs: number;
  active: boolean;
  /** True when the row never carried a posting timestamp (never active). */
  freshnessUnknown: boolean;
  isDeleted: boolean;
}

interface NovedadesStatusRow {
  account?: string;
  author_jid?: string;
  wa_message_id?: string;
  message_key?: unknown;
  message_payload?: unknown;
  message_timestamp_ms?: string | number | null;
  message_type?: string | null;
  visibility?: string | null;
  metadata?: unknown;
  posted_at?: Date | string | null;
  expires_at?: Date | string | null;
  is_deleted?: boolean;
  deleted_at?: Date | string | null;
  seen_at?: Date | string | null;
}

/**
 * Status author JID: the poster is `key.participant` (fallback `key.sender`),
 * never `key.remoteJid` which is always status@broadcast. For statuses this
 * account sent itself, `options.ownJid` is accepted ONLY when
 * `key.fromMe === true`; the key object is never modified.
 */
export function novedadesStatusAuthor(
  key: NovedadesKeyLike,
  options: { ownJid?: string | null } = {}
): string {
  const raw = key?.participant || key?.sender;
  if (raw) return normalizedAuthor(raw, 'status author (key.participant)');
  if (options.ownJid && key?.fromMe === true)
    return normalizedAuthor(options.ownJid, 'ownJid (status authored by this account)');
  throw new NovedadesStoreError(
    'NOVEDADES_STATUS_AUTHOR_REQUIRED',
    'Status keys carry the author in key.participant (fallback key.sender); for own sends pass authorJid with key.fromMe=true',
    400
  );
}

function mapStatusRow(row: NovedadesStatusRow): StoredNovedadesStatus {
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  const key = deserializeDurableValue(row.message_key) as WAMessageKey | undefined;
  return {
    account: String(row.account),
    authorJid: String(row.author_jid),
    messageId: String(row.wa_message_id),
    fromMe: !!key?.fromMe,
    key: key ?? {},
    payload: row.message_payload == null ? null : deserializeDurableValue(row.message_payload),
    timestampMs: row.message_timestamp_ms == null ? null : Number(row.message_timestamp_ms),
    messageType: row.message_type ?? null,
    visibility: (row.visibility === 'visible' || row.visibility === 'event'
      ? row.visibility
      : 'unknown') as NovedadesVisibility,
    metadata: (deserializeDurableValue(row.metadata ?? {}) || {}) as Record<string, unknown>,
    postedAt: iso(row.posted_at),
    expiresAt: iso(row.expires_at),
    seenAt: iso(row.seen_at),
    ttlRemainingMs: expiresAt ? Math.max(0, expiresAt.getTime() - Date.now()) : 0,
    active: !!expiresAt && expiresAt.getTime() > Date.now() && !row.is_deleted,
    freshnessUnknown: expiresAt === null,
    isDeleted: !!row.is_deleted,
  };
}

/**
 * Upserts one status keyed by (account, author, message id) with an explicit
 * `expires_at` (default posted_at + 24h). `key`/payload are preserved exactly.
 * Freshness is never invented: without a timestamp the row is stored (opt-in)
 * as freshness-unknown and stays out of active reads. Redelivery refreshes
 * content but never revives a soft-deleted row nor overwrites existing
 * posted_at/expires_at.
 */
export async function storeNovedadesStatus(
  input: NovedadesStatusInput
): Promise<{ matchedMessageId: string; visibility: NovedadesVisibility }> {
  const account = connectorAccount();
  const key = input.key || {};
  if (key.remoteJid && key.remoteJid !== NOVEDADES_STATUS_BROADCAST_JID)
    throw new NovedadesStoreError(
      'NOVEDADES_STATUS_JID_MISMATCH',
      `Status payloads must arrive on ${NOVEDADES_STATUS_BROADCAST_JID}`,
      400
    );
  const authorJid = novedadesStatusAuthor(key, { ownJid: input.authorJid });
  const messageId = textId(key.id, 'key.id');
  const timestampMs = optionalTimestampMs(input.messageTimestampMs, 'messageTimestampMs');
  if (timestampMs === null && input.allowUnknownFreshness !== true)
    throw new NovedadesStoreError(
      'NOVEDADES_STATUS_TIMESTAMP_REQUIRED',
      'A status needs its posting timestamp; pass allowUnknownFreshness to store it without one',
      400
    );
  if (timestampMs === null && input.expiresAt)
    throw new NovedadesStoreError(
      'INVALID_NOVEDADES_INPUT',
      'expiresAt requires a posting timestamp'
    );
  const postedAt = timestampMs === null ? null : new Date(timestampMs);
  let expiresAt: Date | null;
  if (timestampMs === null) expiresAt = null;
  else if (input.expiresAt === undefined || input.expiresAt === null)
    expiresAt = new Date(timestampMs + NOVEDADES_STATUS_TTL_MS);
  else {
    if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime()))
      throw new NovedadesStoreError(
        'INVALID_NOVEDADES_INPUT',
        'expiresAt must be a Date when provided'
      );
    expiresAt = input.expiresAt;
  }
  const metadata = metadataObject(input.metadata);
  const content = novedadesContentVisibility(input.message);
  const inserted = await pool().query<{ wa_message_id: string }>(
    `INSERT INTO whatsapp_novedades_status
       (account, author_jid, wa_message_id, message_key, message_payload,
        message_timestamp_ms, message_type, visibility, metadata, posted_at, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb, $10::timestamptz, $11::timestamptz)
     ON CONFLICT (account, author_jid, wa_message_id) DO UPDATE SET
       message_key = whatsapp_novedades_status.message_key
         || jsonb_strip_nulls(EXCLUDED.message_key),
       message_payload = COALESCE(EXCLUDED.message_payload, whatsapp_novedades_status.message_payload),
       message_timestamp_ms = COALESCE(EXCLUDED.message_timestamp_ms, whatsapp_novedades_status.message_timestamp_ms),
       message_type = COALESCE(EXCLUDED.message_type, whatsapp_novedades_status.message_type),
       visibility = CASE
         WHEN EXCLUDED.message_payload IS NOT NULL
           THEN EXCLUDED.visibility
         ELSE whatsapp_novedades_status.visibility
       END,
       metadata = whatsapp_novedades_status.metadata || jsonb_strip_nulls(EXCLUDED.metadata),
       posted_at = COALESCE(whatsapp_novedades_status.posted_at, EXCLUDED.posted_at),
       expires_at = COALESCE(whatsapp_novedades_status.expires_at, EXCLUDED.expires_at),
       updated_at = now()
     RETURNING wa_message_id`,
    [
      account,
      authorJid,
      messageId,
      serializeDurableValue(key),
      input.message === undefined || input.message === null
        ? null
        : serializeDurableValue(input.message),
      timestampMs,
      content.messageType,
      content.visibility,
      JSON.stringify(metadata),
      postedAt ? postedAt.toISOString() : null,
      expiresAt ? expiresAt.toISOString() : null,
    ]
  );
  return {
    matchedMessageId: String(inserted.rows[0]?.wa_message_id ?? messageId),
    visibility: content.visibility,
  };
}

export interface NovedadesStatusQuery {
  /** Restrict to these authors (normalized or @c.us forms accepted). */
  authorJids?: string[];
  includeExpired?: boolean;
  /** Only statuses not yet opened (seen_at IS NULL). */
  unreadOnly?: boolean;
  includeDeleted?: boolean;
  /** Default 'visible'; use 'all' to include events/unknown rows. */
  visibility?: NovedadesVisibility | 'all';
  limit?: number;
  /**
   * Keyset cursor (previous page's last status). Paging uses the message's own
   * epoch-milliseconds column rather than `posted_at`: `posted_at` is a
   * microsecond `timestamptz`, and the ISO strings handed to callers are only
   * millisecond precise, so a cursor built from them could silently skip or
   * repeat a row. `timestampMs` is null when that status had no posting
   * timestamp at all, which is the `NULLS LAST` tail; the id tie-breaker keeps
   * paging moving across identical timestamps.
   */
  after?: { timestampMs: number | null; id: string } | null;
}

export async function listNovedadesStatus(
  options: NovedadesStatusQuery = {}
): Promise<StoredNovedadesStatus[]> {
  const params: unknown[] = [connectorAccount()];
  let where = 'account = $1';
  if (options.authorJids?.length) {
    params.push(options.authorJids.map(author => normalizedAuthor(author, 'authorJids[]')));
    where += ` AND author_jid = ANY($${params.length}::text[])`;
  }
  if (options.after) {
    const cursorId = textId(options.after.id, 'after.id');
    const cursorTs = optionalTimestampMs(options.after.timestampMs, 'after.timestampMs');
    params.push(cursorTs, cursorId);
    const tsParam = `$${params.length - 1}`;
    const idParam = `$${params.length}`;
    where += `
      AND (CASE
             WHEN ${tsParam}::bigint IS NULL
               THEN (message_timestamp_ms IS NULL AND wa_message_id < ${idParam})
             ELSE message_timestamp_ms IS NULL
               OR message_timestamp_ms < ${tsParam}::bigint
               OR (message_timestamp_ms = ${tsParam}::bigint AND wa_message_id < ${idParam})
           END)`;
  }
  if (!options.includeExpired) where += ' AND expires_at > now()';
  if (options.unreadOnly) where += ' AND seen_at IS NULL';
  if (options.includeDeleted !== true) where += ' AND NOT is_deleted';
  const visibility = options.visibility ?? 'visible';
  if (visibility !== 'all') {
    params.push(visibility);
    where += ` AND visibility = $${params.length}`;
  }
  params.push(boundedLimit(options.limit));
  const result = await pool().query(
    `SELECT *
       FROM whatsapp_novedades_status
      WHERE ${where}
      ORDER BY message_timestamp_ms DESC NULLS LAST, wa_message_id DESC
      LIMIT $${params.length}`,
    params
  );
  return (result.rows as NovedadesStatusRow[]).map(mapStatusRow);
}

/**
 * One status row, exactly, for THIS account + author + message id. The media
 * path needs this: scanning a page of statuses and hoping the wanted id is in
 * it silently turns a real status into a 404 once the author posts more than
 * the window holds. Defaults stay conservative (active, visible, not deleted);
 * a caller that wants an expired or deleted row must ask for it.
 */
export async function getNovedadesStatus(
  authorJidValue: string,
  messageId: string,
  options: {
    includeExpired?: boolean;
    includeDeleted?: boolean;
    /** Default 'visible'; use 'all' to include events/unknown rows. */
    visibility?: NovedadesVisibility | 'all';
  } = {}
): Promise<StoredNovedadesStatus | undefined> {
  const params: unknown[] = [
    connectorAccount(),
    normalizedAuthor(authorJidValue, 'authorJid'),
    textId(messageId, 'messageId'),
  ];
  let where = 'account = $1 AND author_jid = $2 AND wa_message_id = $3';
  if (!options.includeExpired) where += ' AND expires_at > now()';
  if (options.includeDeleted !== true) where += ' AND NOT is_deleted';
  const visibility = options.visibility ?? 'visible';
  if (visibility !== 'all') {
    params.push(visibility);
    where += ` AND visibility = $${params.length}`;
  }
  const result = await pool().query(
    `SELECT * FROM whatsapp_novedades_status WHERE ${where} LIMIT 1`,
    params
  );
  const row = result.rows[0] as NovedadesStatusRow | undefined;
  return row ? mapStatusRow(row) : undefined;
}

export interface NovedadesStatusAuthorSummary {
  authorJid: string;
  total: number;
  active: number;
  unseen: number;
  latestPostedAt: string | null;
  /**
   * Message id of the author's newest status row, and when that row first
   * reached this store (see `LATEST_STATUS_ORDER`). `null` only when the rollup
   * has no row at all.
   */
  latestStatusId: string | null;
  latestReceivedAt: string | null;
}

/**
 * Total order that defines an author's "newest" status: posting time first, then
 * the arrival time at this store, then the message id. Arrival is decisive
 * because `wa_message_id` is an opaque provider id: two statuses posted in the
 * same second can arrive with ids that sort backwards, and a tie-break that
 * stopped at the id would keep pointing at the older one and hide the new post.
 * `created_at` is never rewritten by the status upsert, so it grows with
 * arrival, and a backfilled OLDER status cannot move the newest row.
 */
const LATEST_STATUS_ORDER = 'posted_at DESC NULLS LAST, created_at DESC, wa_message_id DESC';

/**
 * Author rollup for the Novedades list (visible statuses only).
 *
 * `latest_posted_at` stays `MAX(posted_at)`, so its value is unchanged for
 * existing clients; the two identity columns describe the very same row that
 * maximum comes from, never an independent aggregate. `latest_received_at` is
 * rendered in SQL rather than through `Date`: the driver parses `timestamptz`
 * into a millisecond `Date`, and collapsing microseconds would put two
 * same-millisecond arrivals on the same watermark and hide the newer one.
 */
export async function listNovedadesStatusAuthors(
  options: { includeExpiredTotals?: boolean } = {}
): Promise<NovedadesStatusAuthorSummary[]> {
  const activePredicate = "expires_at > now() AND visibility = 'visible'";
  const result = await pool().query(
    `SELECT author_jid,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE ${activePredicate}) AS active,
            COUNT(*) FILTER (WHERE ${activePredicate} AND seen_at IS NULL) AS unseen,
            MAX(posted_at) AS latest_posted_at,
            (array_agg(wa_message_id ORDER BY ${LATEST_STATUS_ORDER}))[1] AS latest_status_id,
            to_char(
              (array_agg(created_at ORDER BY ${LATEST_STATUS_ORDER}))[1] AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS latest_received_at
       FROM whatsapp_novedades_status
      WHERE account = $1 AND NOT is_deleted AND visibility = 'visible'
      GROUP BY author_jid
      ORDER BY MAX(posted_at) DESC NULLS LAST`,
    [connectorAccount()]
  );
  return (result.rows as Array<Record<string, unknown>>)
    .map(row => ({
      authorJid: String(row.author_jid),
      total: Number(row.total ?? 0),
      active: Number(row.active ?? 0),
      unseen: Number(row.unseen ?? 0),
      latestPostedAt: row.latest_posted_at
        ? new Date(row.latest_posted_at as Date | string).toISOString()
        : null,
      latestStatusId:
        typeof row.latest_status_id === 'string' && row.latest_status_id
          ? row.latest_status_id
          : null,
      latestReceivedAt:
        typeof row.latest_received_at === 'string' && row.latest_received_at
          ? row.latest_received_at
          : null,
    }))
    .filter(summary => (options.includeExpiredTotals === true ? true : summary.active > 0));
}

export async function markNovedadesStatusSeen(input: {
  authorJid: string;
  messageId: string;
}): Promise<void> {
  await pool().query(
    `UPDATE whatsapp_novedades_status
        SET seen_at = now(), updated_at = now()
      WHERE account = $1 AND author_jid = $2 AND wa_message_id = $3
        AND NOT is_deleted AND seen_at IS NULL`,
    [
      connectorAccount(),
      normalizedAuthor(input.authorJid, 'authorJid'),
      textId(input.messageId, 'messageId'),
    ]
  );
}

/**
 * Soft-deletes one status by (account, author, message id). No physical delete;
 * hidden from the default reads and from the author rollup; a redelivery of
 * the same status refreshes content but does NOT revive it. If the deletion
 * arrives BEFORE the status row exists, an honest freshness-unknown tombstone
 * is inserted so the later upsert keeps the deletion.
 */
export async function markNovedadesStatusDeleted(input: {
  authorJid: string;
  messageId: string;
  deleted?: boolean;
}): Promise<{ marked: boolean; createdTombstone: boolean }> {
  const deleted = input.deleted !== false;
  const account = connectorAccount();
  const authorJid = normalizedAuthor(input.authorJid, 'authorJid');
  const messageId = textId(input.messageId, 'messageId');
  const db = pool();
  const client = await poolClient(db);
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE whatsapp_novedades_status
          SET is_deleted = $4::boolean,
              deleted_at = CASE WHEN $4::boolean THEN COALESCE(deleted_at, now()) ELSE NULL END,
              updated_at = now()
        WHERE account = $1 AND author_jid = $2 AND wa_message_id = $3`,
      [account, authorJid, messageId, deleted]
    );
    let createdTombstone = false;
    if (!updated.rowCount && deleted) {
      await client.query(
        `INSERT INTO whatsapp_novedades_status
           (account, author_jid, wa_message_id, message_key, message_payload,
            visibility, metadata, is_deleted, deleted_at)
         VALUES ($1, $2, $3, $4::jsonb, NULL, 'unknown',
                 '{"tombstone": true}'::jsonb, true, now())
         ON CONFLICT (account, author_jid, wa_message_id) DO UPDATE SET
           is_deleted = TRUE,
           deleted_at = COALESCE(whatsapp_novedades_status.deleted_at, now()),
           updated_at = now()`,
        [
          account,
          authorJid,
          messageId,
          JSON.stringify({
            id: messageId,
            remoteJid: NOVEDADES_STATUS_BROADCAST_JID,
            tombstone: true,
          }),
        ]
      );
      createdTombstone = true;
    }
    await client.query('COMMIT');
    return { marked: true, createdTombstone };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Deletes only status rows with a known expiry past `now - grace` (opt-in;
 * freshness-unknown rows are never pruned). Unlike the channel-post tables,
 * expired statuses are ephemeral by the official app's own contract, so this
 * is intended cleanup, not history loss; it never touches channel posts or any
 * pre-existing table.
 */
export async function pruneExpiredNovedadesStatus(
  options: { now?: Date; graceMs?: number } = {}
): Promise<{ deleted: number }> {
  const now = options.now instanceof Date ? options.now : new Date();
  const graceMs = Math.max(0, options.graceMs ?? 0);
  const result = await pool().query(
    `DELETE FROM whatsapp_novedades_status
      WHERE account = $1
        AND expires_at IS NOT NULL
        AND expires_at < $2::timestamptz - ($3::double precision * interval '1 millisecond')
      RETURNING 1`,
    [connectorAccount(), now.toISOString(), graceMs]
  );
  return { deleted: result.rowCount ?? result.rows.length };
}
