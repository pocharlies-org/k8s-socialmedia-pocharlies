/**
 * Starred and pinned WhatsApp messages (fase 3 follow-up, ported from the NAS
 * fork's star / unstar and "mensajes fijados" and adapted to the multiaccount
 * model): the request parsing, the WhatsApp shapes and the DB side.
 *
 *  - A star is app state of OUR account (regular_high, index
 *    ['star', chat, id, fromMe, participant]): the phone and WhatsApp Web show
 *    it in "Destacados"; nobody else sees it.
 *  - A pin is a message (pinInChatMessage, PIN_FOR_ALL / UNPIN_FOR_ALL) that
 *    everyone in the chat sees, for 24 h, 7 d or 30 d. WhatsApp shows at most
 *    3 per chat, the newest; a pin ends by itself when its time is up.
 *
 * State lives in whatsapp_message_stars / whatsapp_message_pins (mcp-server
 * migration 018), ONE current row per (account, message). Rules (same as
 * message-reactions.ts):
 *  - ids use the SAME namespacing as `messages` (accountKey): wa_message_id
 *    joins to messages.wa_message_id; the chat of a row is its messages row's,
 *    so conversation merges need nothing here;
 *  - the tables are created by the migration, never here. While they are
 *    missing every call fails soft: 42P01 is logged once, writes answer
 *    false and lists answer empty with persisted: false. Re-probed every few
 *    minutes, so no restart is needed once the migration lands;
 *  - a replayed older pin action (history sync, our own echo) never
 *    overwrites a newer one; at the same WhatsApp time an unpin wins.
 *
 * The caller (BaileysClient) only calls in here when `ingest` is on: the
 * per-sub pairing pool (ingest off) never touches these tables.
 */
import {
  isJidGroup,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  type WAMessage,
  type WAPatchCreate,
} from '@whiskeysockets/baileys';
import { accountKey, connectorAccount, getPool, stripAccountKey } from './db-writer';
import { MessageMutationError } from './message-mutations';

const UNDEFINED_TABLE = '42P01';
const MISSING_TABLE_RECHECK_MS = 5 * 60 * 1000;

/** The pin durations WhatsApp offers: 24 h, 7 days (its default), 30 days. */
export const PIN_DURATIONS = [86400, 604800, 2592000] as const;
export type PinDuration = (typeof PIN_DURATIONS)[number];
export const DEFAULT_PIN_DURATION: PinDuration = 604800;
/** WhatsApp shows this many pinned messages per chat, the newest. */
export const MAX_PINS_PER_CHAT = 3;
/** Longest pin accepted from the socket (a client offering a new duration). */
const MAX_INBOUND_PIN_SECONDS = 366 * 24 * 60 * 60;

export const STARRED_DEFAULT_LIMIT = 50;
export const STARRED_MAX_LIMIT = 200;

export type MarkSource = 'connector' | 'whatsapp' | 'history';

// ---------------------------------------------------------------------------
// HTTP bodies
// ---------------------------------------------------------------------------

function invalid(message: string): MessageMutationError {
  return new MessageMutationError(message, 400, 'invalid_request');
}

function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid(`${field} must be a string`);
  return value.trim() || undefined;
}

function requiredId(value: unknown, field: string): string {
  const id = optionalId(value, field);
  if (!id) throw invalid(`Missing ${field}`);
  if (id.length > 512) throw invalid(`${field} is too long`);
  return id;
}

export interface StarRequest {
  /** Optional: the message's own key names its chat. */
  chatId?: string;
  messageId: string;
  star: boolean;
}

/** {conversationId?, messageId, star} of POST /messages/star; 400 otherwise. */
export function parseStarRequest(body: Record<string, unknown>): StarRequest {
  const messageId = requiredId(body.messageId, 'messageId');
  if (typeof body.star !== 'boolean') throw invalid('star must be a boolean');
  return {
    chatId: optionalId(body.conversationId ?? body.chatId, 'conversationId'),
    messageId,
    star: body.star,
  };
}

export interface PinRequest {
  chatId?: string;
  messageId: string;
  pin: boolean;
  /** Only for a pin. */
  durationSeconds?: PinDuration;
}

/**
 * {conversationId?, messageId, pin, durationSeconds?} of POST /messages/pin;
 * a pin without durationSeconds lasts 7 days (WhatsApp's default); an unpin
 * takes none. 400 otherwise.
 */
export function parsePinRequest(body: Record<string, unknown>): PinRequest {
  const messageId = requiredId(body.messageId, 'messageId');
  if (typeof body.pin !== 'boolean') throw invalid('pin must be a boolean');
  const raw = body.durationSeconds;
  if (!body.pin) {
    if (raw !== undefined && raw !== null) throw invalid('An unpin takes no durationSeconds');
    return {
      chatId: optionalId(body.conversationId ?? body.chatId, 'conversationId'),
      messageId,
      pin: false,
    };
  }
  const duration = raw === undefined || raw === null ? DEFAULT_PIN_DURATION : raw;
  if (!PIN_DURATIONS.includes(duration as PinDuration)) {
    throw invalid(`durationSeconds must be one of ${PIN_DURATIONS.join(', ')}`);
  }
  return {
    chatId: optionalId(body.conversationId ?? body.chatId, 'conversationId'),
    messageId,
    pin: true,
    durationSeconds: duration as PinDuration,
  };
}

export interface StarredQuery {
  chatId?: string;
  limit: number;
  cursor?: StarredCursor;
}

export interface StarredCursor {
  starredAt: string;
  messageId: string;
}

/** The opaque keyset of the starred list: base64url of {t, id}. */
export function encodeStarredCursor(cursor: StarredCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.starredAt, id: cursor.messageId })).toString(
    'base64url'
  );
}

function decodeStarredCursor(value: string): StarredCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      parsed &&
      typeof parsed.t === 'string' &&
      Number.isFinite(Date.parse(parsed.t)) &&
      typeof parsed.id === 'string' &&
      parsed.id
    ) {
      return { starredAt: parsed.t, messageId: parsed.id };
    }
  } catch {
    // fall through
  }
  throw invalid('cursor is not one this route returned');
}

/** {conversationId?, limit?, cursor?} of POST /messages/starred; 400 otherwise. */
export function parseStarredQuery(body: Record<string, unknown>): StarredQuery {
  const chatId = optionalId(body.conversationId ?? body.chatId, 'conversationId');
  let limit = STARRED_DEFAULT_LIMIT;
  if (body.limit !== undefined && body.limit !== null) {
    if (
      typeof body.limit !== 'number' ||
      !Number.isInteger(body.limit) ||
      body.limit < 1 ||
      body.limit > STARRED_MAX_LIMIT
    ) {
      throw invalid(`limit must be an integer from 1 to ${STARRED_MAX_LIMIT}`);
    }
    limit = body.limit;
  }
  const cursor = optionalId(body.cursor, 'cursor');
  return { chatId, limit, ...(cursor ? { cursor: decodeStarredCursor(cursor) } : {}) };
}

// ---------------------------------------------------------------------------
// WhatsApp shapes
// ---------------------------------------------------------------------------

export interface StarKey {
  remoteJid: string;
  id: string;
  fromMe?: boolean | null;
  participant?: string | null;
}

/**
 * The app-state patch of a star / unstar. Baileys' chatModify({star}) files it
 * under regular_low with participant '0' always; WhatsApp keeps stars in
 * regular_high and names the author of a group message someone else sent
 * (the same index whatsmeow's BuildStar writes), so the patch is built here.
 */
export function starPatch(key: StarKey, starred: boolean): WAPatchCreate {
  const chat = jidNormalizedUser(key.remoteJid);
  const participant =
    !key.fromMe && isJidGroup(chat) && key.participant ? jidNormalizedUser(key.participant) : '0';
  return {
    syncAction: { starAction: { starred } },
    index: ['star', chat, key.id, key.fromMe ? '1' : '0', participant],
    type: 'regular_high',
    apiVersion: 2,
    operation: proto.SyncdMutation.SyncdOperation.SET,
  };
}

/** sendMessage content of a pin / unpin (Baileys adds the edit="2" stanza attribute). */
export function pinContent(
  key: {
    remoteJid?: string | null;
    id?: string | null;
    fromMe?: boolean | null;
    participant?: string | null;
  },
  pinned: boolean,
  durationSeconds: PinDuration = DEFAULT_PIN_DURATION
) {
  return pinned
    ? {
        pin: key,
        type: proto.PinInChat.Type.PIN_FOR_ALL,
        time: durationSeconds,
      }
    : { pin: key, type: proto.PinInChat.Type.UNPIN_FOR_ALL };
}

export interface PinAction {
  /** Bare id of the pinned / unpinned message. */
  targetId: string;
  /** Chat the action came in (raw jid). */
  chatJid: string;
  pinned: boolean;
  /** WhatsApp time of the action. */
  at: Date;
  /** A pin's duration; undefined for an unpin. */
  durationSeconds?: number;
  /** Id of the pin / unpin message itself. */
  actionId?: string;
}

function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  const long = value as { toNumber?: () => number; low?: number; high?: number };
  if (typeof long.toNumber === 'function') return toNumber(long.toNumber());
  if (typeof long.low === 'number') return (long.high || 0) * 2 ** 32 + (long.low >>> 0);
  return undefined;
}

/** Whether a message is a pin / unpin action (state of another message, never a chat row). */
export function isPinAction(msg: WAMessage): boolean {
  return !!normalizeMessageContent(msg.message)?.pinInChatMessage;
}

/**
 * The pin / unpin a pinInChatMessage carries; null when it is not one we can
 * apply (unknown type, no target, a pin without a usable duration, no time).
 */
export function pinActionOf(msg: WAMessage): PinAction | null {
  const content = normalizeMessageContent(msg.message);
  const pin = content?.pinInChatMessage;
  const chatJid = msg.key?.remoteJid;
  const targetId = pin?.key?.id;
  if (!pin || !chatJid || !targetId) return null;
  const type = pin.type;
  if (
    type !== proto.Message.PinInChatMessage.Type.PIN_FOR_ALL &&
    type !== proto.Message.PinInChatMessage.Type.UNPIN_FOR_ALL
  ) {
    return null;
  }
  const senderMs = toNumber(pin.senderTimestampMs);
  const messageSeconds = toNumber(msg.messageTimestamp);
  const ms =
    senderMs && senderMs > 0
      ? senderMs
      : messageSeconds && messageSeconds > 0
        ? messageSeconds * 1000
        : 0;
  if (!ms || ms > 8.64e15) return null;
  const pinned = type === proto.Message.PinInChatMessage.Type.PIN_FOR_ALL;
  let durationSeconds: number | undefined;
  if (pinned) {
    const duration = toNumber(
      content?.messageContextInfo?.messageAddOnDurationInSecs ??
        msg.message?.messageContextInfo?.messageAddOnDurationInSecs
    );
    if (
      !duration ||
      !Number.isInteger(duration) ||
      duration <= 0 ||
      duration > MAX_INBOUND_PIN_SECONDS
    ) {
      return null;
    }
    durationSeconds = duration;
  }
  return {
    targetId,
    chatJid,
    pinned,
    at: new Date(ms),
    ...(durationSeconds ? { durationSeconds } : {}),
    ...(msg.key.id ? { actionId: msg.key.id } : {}),
  };
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

let tablesMissingUntil = 0;
let missingTablesLogged = false;

/** Test hook: forget the "tables missing" state between cases. */
export function resetStarPinStoreStateForTests(): void {
  tablesMissingUntil = 0;
  missingTablesLogged = false;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tablesKnownMissing(): boolean {
  return tablesMissingUntil > Date.now();
}

function noteTablesMissing(): void {
  tablesMissingUntil = Date.now() + MISSING_TABLE_RECHECK_MS;
  if (!missingTablesLogged) {
    missingTablesLogged = true;
    console.warn(
      'whatsapp_message_stars / whatsapp_message_pins do not exist yet (mcp-server migration ' +
        '018 not applied): stars and pins go to WhatsApp but are not recorded'
    );
  }
}

function noteTablesPresent(): void {
  if (missingTablesLogged) {
    missingTablesLogged = false;
    console.info('whatsapp_message_stars / whatsapp_message_pins are available: recorded');
  }
  tablesMissingUntil = 0;
}

/** 42P01 → noted, true; anything else → false (the caller decides). */
function tableMissing(error: unknown): boolean {
  if ((error as { code?: string } | null)?.code !== UNDEFINED_TABLE) return false;
  noteTablesMissing();
  return true;
}

export interface StarInput {
  /** Bare or namespaced WhatsApp id. */
  messageId: string;
  /** Bare, normalised chat id of the key (the one messages.conversation_id uses). */
  chatId: string;
  fromMe?: boolean | null;
  starred: boolean;
  at?: Date;
  source: MarkSource;
  actor?: string;
}

/**
 * Record the star state of a message. 'history' only fills a message we know
 * nothing about (a history snapshot is older than any star we saw); the
 * others replace the state when it changes. Never throws: false when the
 * table is missing, the input is incomplete or the DB failed (logged).
 */
export async function recordMessageStar(input: StarInput): Promise<boolean> {
  const id = stripAccountKey(String(input.messageId || '').trim());
  const chat = stripAccountKey(String(input.chatId || '').trim());
  if (!id || !chat || tablesKnownMissing()) return false;
  const conflict =
    input.source === 'history'
      ? 'DO NOTHING'
      : `DO UPDATE SET
           seen_chat_id = EXCLUDED.seen_chat_id,
           from_me = COALESCE(EXCLUDED.from_me, whatsapp_message_stars.from_me),
           starred = EXCLUDED.starred,
           starred_at = EXCLUDED.starred_at,
           source = EXCLUDED.source,
           actor = EXCLUDED.actor,
           updated_at = now()
         WHERE whatsapp_message_stars.starred IS DISTINCT FROM EXCLUDED.starred`;
  try {
    await getPool().query(
      `INSERT INTO whatsapp_message_stars
         (account, wa_message_id, seen_chat_id, from_me, starred, starred_at, source, actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (account, wa_message_id) ${conflict}`,
      [
        connectorAccount(),
        accountKey(id),
        accountKey(chat),
        input.fromMe ?? null,
        input.starred,
        input.at || new Date(),
        input.source,
        input.actor || null,
      ]
    );
    noteTablesPresent();
    return true;
  } catch (error) {
    if (!tableMissing(error)) console.warn(`star store failed for ${id}: ${describeError(error)}`);
    return false;
  }
}

export interface PinInput {
  /** Bare or namespaced id of the pinned / unpinned message. */
  messageId: string;
  /** Bare, normalised chat id the action came in. */
  chatId: string;
  pinned: boolean;
  at: Date;
  durationSeconds?: number;
  /** Bare, normalised jid of who pinned / unpinned. */
  byJid?: string;
  actionId?: string;
  source: MarkSource;
  actor?: string;
}

/**
 * Record a pin / unpin. Applies only when its WhatsApp time is newer than the
 * stored action (an unpin also at the same time), so a history replay or the
 * echo of our own action never undoes a newer one. Never throws (see
 * recordMessageStar).
 */
export async function recordMessagePin(input: PinInput): Promise<boolean> {
  const id = stripAccountKey(String(input.messageId || '').trim());
  const chat = stripAccountKey(String(input.chatId || '').trim());
  if (!id || !chat || !(input.at instanceof Date) || tablesKnownMissing()) return false;
  const duration = input.pinned ? input.durationSeconds || DEFAULT_PIN_DURATION : null;
  const expiresAt = duration ? new Date(input.at.getTime() + duration * 1000) : null;
  try {
    await getPool().query(
      `INSERT INTO whatsapp_message_pins
         (account, wa_message_id, seen_chat_id, pinned, pinned_at, expires_at, duration_seconds,
          pinned_by, action_wa_message_id, action_at, source, actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (account, wa_message_id) DO UPDATE SET
         seen_chat_id = EXCLUDED.seen_chat_id,
         pinned = EXCLUDED.pinned,
         pinned_at = CASE WHEN EXCLUDED.pinned THEN EXCLUDED.pinned_at
                          ELSE whatsapp_message_pins.pinned_at END,
         expires_at = CASE WHEN EXCLUDED.pinned THEN EXCLUDED.expires_at
                           ELSE whatsapp_message_pins.expires_at END,
         duration_seconds = CASE WHEN EXCLUDED.pinned THEN EXCLUDED.duration_seconds
                                 ELSE whatsapp_message_pins.duration_seconds END,
         pinned_by = EXCLUDED.pinned_by,
         action_wa_message_id = EXCLUDED.action_wa_message_id,
         action_at = EXCLUDED.action_at,
         source = EXCLUDED.source,
         actor = EXCLUDED.actor,
         updated_at = now()
       WHERE EXCLUDED.action_at > whatsapp_message_pins.action_at
          OR (EXCLUDED.action_at = whatsapp_message_pins.action_at
              AND NOT EXCLUDED.pinned AND whatsapp_message_pins.pinned)`,
      [
        connectorAccount(),
        accountKey(id),
        accountKey(chat),
        input.pinned,
        input.pinned ? input.at : null,
        expiresAt,
        duration,
        input.byJid ? accountKey(input.byJid) : null,
        input.actionId ? accountKey(input.actionId) : null,
        input.at,
        input.source,
        input.actor || null,
      ]
    );
    noteTablesPresent();
    return true;
  } catch (error) {
    if (!tableMissing(error)) console.warn(`pin store failed for ${id}: ${describeError(error)}`);
    return false;
  }
}

/** The message a star / pin points at, as the messages row has it (null when never ingested). */
export interface MarkedMessage {
  messageId: string;
  conversationId: string;
  chatName: string | null;
  senderId: string | null;
  direction: string | null;
  messageType: string | null;
  content: string | null;
  sentAt: string | null;
  isDeleted: boolean;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function markedMessage(row: Record<string, any>): MarkedMessage {
  return {
    messageId: stripAccountKey(String(row.wa_message_id)),
    conversationId: stripAccountKey(String(row.conversation_id || row.seen_chat_id)),
    chatName: row.chat_name ?? null,
    senderId: row.sender_wa_id ? stripAccountKey(String(row.sender_wa_id)) : null,
    direction: row.direction ?? null,
    messageType: row.message_type ?? null,
    content: row.content ?? null,
    sentAt: iso(row.wa_timestamp),
    isDeleted: !!row.is_deleted,
  };
}

export interface StarredMessage extends MarkedMessage {
  starredAt: string;
  source: MarkSource;
}

export interface StarredList {
  starred: StarredMessage[];
  nextCursor: string | null;
  persisted: boolean;
}

/**
 * Starred messages of this account, newest star first, optionally of one
 * chat (`chatIds`: the canonical conversation id + the chat's external ids,
 * all namespaced). A message deleted for me is left out (WhatsApp drops it
 * from "Destacados" too).
 */
export async function listStarredMessages(options: {
  chatIds?: string[];
  limit: number;
  cursor?: StarredCursor;
}): Promise<StarredList> {
  if (tablesKnownMissing()) return { starred: [], nextCursor: null, persisted: false };
  const params: unknown[] = [connectorAccount()];
  const filters = ['s.account = $1', 's.starred'];
  if (options.chatIds) {
    params.push(options.chatIds);
    filters.push(`COALESCE(m.conversation_id, s.seen_chat_id) = ANY($${params.length}::text[])`);
  }
  if (options.cursor) {
    params.push(options.cursor.starredAt, accountKey(options.cursor.messageId));
    filters.push(
      `(s.starred_at, s.wa_message_id) < ($${params.length - 1}::timestamptz, $${params.length}::text)`
    );
  }
  params.push(options.limit + 1);
  try {
    const result = await getPool().query(
      `SELECT s.wa_message_id, s.seen_chat_id, s.starred_at, s.source,
              m.conversation_id, m.sender_wa_id, m.direction, m.message_type, m.content,
              m.wa_timestamp, COALESCE(m.is_deleted, FALSE) AS is_deleted, c.name AS chat_name
         FROM whatsapp_message_stars s
         LEFT JOIN messages m ON m.wa_message_id = s.wa_message_id AND m.platform = 'whatsapp'
         LEFT JOIN conversations c ON c.id = COALESCE(m.conversation_id, s.seen_chat_id)
        WHERE ${filters.join(' AND ')}
          AND (m.metadata->>'deleted_for_me') IS DISTINCT FROM 'true'
        ORDER BY s.starred_at DESC, s.wa_message_id DESC
        LIMIT $${params.length}`,
      params
    );
    noteTablesPresent();
    const rows = result.rows.slice(0, options.limit);
    const last = rows[rows.length - 1];
    return {
      starred: rows.map(row => ({
        ...markedMessage(row),
        starredAt: iso(row.starred_at) || '',
        source: row.source as MarkSource,
      })),
      nextCursor:
        result.rows.length > options.limit && last
          ? encodeStarredCursor({
              starredAt: iso(last.starred_at) || '',
              messageId: stripAccountKey(String(last.wa_message_id)),
            })
          : null,
      persisted: true,
    };
  } catch (error) {
    if (tableMissing(error)) return { starred: [], nextCursor: null, persisted: false };
    throw error;
  }
}

export interface PinnedMessage extends MarkedMessage {
  pinnedAt: string;
  expiresAt: string;
  durationSeconds: number;
  pinnedBy: string | null;
  source: MarkSource;
}

/**
 * Active pins of one chat (`chatIds` as in listStarredMessages), newest
 * first, at most MAX_PINS_PER_CHAT — what WhatsApp shows. A revoked message
 * loses its pin.
 */
export async function listPinnedMessages(
  chatIds: string[],
  now: Date = new Date()
): Promise<{ pinned: PinnedMessage[]; persisted: boolean }> {
  if (!chatIds.length || tablesKnownMissing()) return { pinned: [], persisted: false };
  try {
    const result = await getPool().query(
      `SELECT p.wa_message_id, p.seen_chat_id, p.pinned_at, p.expires_at, p.duration_seconds,
              p.pinned_by, p.source,
              m.conversation_id, m.sender_wa_id, m.direction, m.message_type, m.content,
              m.wa_timestamp, COALESCE(m.is_deleted, FALSE) AS is_deleted, c.name AS chat_name
         FROM whatsapp_message_pins p
         LEFT JOIN messages m ON m.wa_message_id = p.wa_message_id AND m.platform = 'whatsapp'
         LEFT JOIN conversations c ON c.id = COALESCE(m.conversation_id, p.seen_chat_id)
        WHERE p.account = $1 AND p.pinned AND p.expires_at > $3
          AND COALESCE(m.conversation_id, p.seen_chat_id) = ANY($2::text[])
          AND NOT COALESCE(m.is_deleted, FALSE)
        ORDER BY p.pinned_at DESC, p.wa_message_id DESC
        LIMIT ${MAX_PINS_PER_CHAT}`,
      [connectorAccount(), chatIds, now]
    );
    noteTablesPresent();
    return {
      pinned: result.rows.map(row => ({
        ...markedMessage(row),
        pinnedAt: iso(row.pinned_at) || '',
        expiresAt: iso(row.expires_at) || '',
        durationSeconds: Number(row.duration_seconds),
        pinnedBy: row.pinned_by ? stripAccountKey(String(row.pinned_by)) : null,
        source: row.source as MarkSource,
      })),
      persisted: true,
    };
  } catch (error) {
    if (tableMissing(error)) return { pinned: [], persisted: false };
    throw error;
  }
}
