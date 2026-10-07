import { MissingTableBackoff } from './missing-table-backoff';
import { describeError } from './error-text';
import { inTransaction } from './db-transaction';
import type { Pool } from 'pg';
import { normalizeMessageContent, proto } from '@whiskeysockets/baileys';
import type { WAMessage, WAMessageKey } from '@whiskeysockets/baileys';
import {
  accountKey,
  canonicalConversationId,
  connectorAccount,
  getPool,
  stripAccountKey,
} from './db-writer';
import { deserializeDurableValue, serializeDurableValue } from './whatsapp-capabilities';
import { novedadesKind } from './novedades-store';

/** Re-exported for the upstream durable tests and HTTP callers that import them from here. */
export { deserializeDurableValue, serializeDurableValue } from './whatsapp-capabilities';

let tablesReady = false;

function pool(): Pool {
  return getPool();
}

export function storageConversationId(jid: string): string {
  return jid.endsWith('@s.whatsapp.net') ? jid.replace(/@s\.whatsapp\.net$/, '@c.us') : jid;
}

/**
 * Payload predicates that define the pins and RSVP partial indexes. They are
 * exported because the scans interpolate the very same strings: keeping one
 * definition means a query can never drift away from the index it relies on,
 * which is what lets Postgres prove the predicate and skip ordinary chat
 * messages entirely instead of filtering them after the fact.
 */
export const PIN_ACTION_SQL = "jsonb_path_exists(message_payload, '$.**.pinInChatMessage')";
export const EVENT_RESPONSE_PRESENT_SQL =
  "jsonb_path_exists(message_payload, '$.**.encEventResponseMessage')";

/**
 * Keyset order shared by both scans: account and chat as equality scopes, then
 * message ids in C collation so the cursor comparison and the index order are
 * byte-exact regardless of the database default collation.
 *
 * CREATE INDEX here is non-concurrent and therefore takes a SHARE lock, so the
 * very first startup on an existing populated table blocks writers while it
 * builds. Later startups are no-ops thanks to IF NOT EXISTS.
 */
const PAYLOAD_INDEX_KEY = `(account, conversation_id, wa_message_id COLLATE "C")`;

function partialPayloadIndex(indexName: string, predicate: string): string {
  return [
    `CREATE INDEX IF NOT EXISTS ${indexName}`,
    `  ON whatsapp_message_payloads ${PAYLOAD_INDEX_KEY}`,
    ` WHERE ${predicate}`,
  ].join('\n');
}

/** Executed by the bootstrap transaction below and by the PostgreSQL specs. */
export const PAYLOAD_PARTIAL_INDEX_DDL = [
  partialPayloadIndex('idx_whatsapp_message_payloads_pins', PIN_ACTION_SQL),
  partialPayloadIndex('idx_whatsapp_message_payloads_event_responses', EVENT_RESPONSE_PRESENT_SQL),
] as const;

/** Tables owned by the connector; deployment migrations can adopt them later. */
export async function ensureDurableTables(): Promise<void> {
  if (tablesReady) return;
  await inTransaction(pool(), async client => {
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [20260923, 1]);
    await client.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_message_payloads (
      wa_message_id text PRIMARY KEY,
      account text NOT NULL,
      conversation_id text NOT NULL,
      message_key jsonb NOT NULL,
      message_payload jsonb NOT NULL,
      message_timestamp_ms bigint,
      push_name text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS idx_whatsapp_message_payloads_chat
      ON whatsapp_message_payloads (account, conversation_id, message_timestamp_ms DESC)
  `);
    for (const ddl of PAYLOAD_PARTIAL_INDEX_DDL) await client.query(ddl);
    await client.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_chat_state (
      account text NOT NULL,
      chat_id text NOT NULL,
      archived boolean,
      unread_count integer,
      pinned boolean,
      mute_until bigint,
      starred boolean,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account, chat_id)
    )
  `);
    await client.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_contacts (
      account text NOT NULL,
      jid text NOT NULL,
      phone text,
      name text,
      push_name text,
      avatar_url text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account, jid)
    )
  `);
    await client.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_message_reactions (
      account text NOT NULL,
      target_wa_message_id text NOT NULL,
      reactor_jid text NOT NULL,
      reaction_wa_message_id text,
      emoji text,
      removed boolean NOT NULL DEFAULT false,
      from_me boolean,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account, target_wa_message_id, reactor_jid)
    )
  `);
    // CREATE TABLE IF NOT EXISTS is a no-op on a table that migration 011 (or an
    // older connector) already built, so the widening is stated separately. Both
    // the fresh and the existing shape end with from_me, and NULL simply means
    // the author side was never observed.
    await client.query(`
    ALTER TABLE whatsapp_message_reactions
      ADD COLUMN IF NOT EXISTS from_me boolean
  `);
  });
  tablesReady = true;
}

/**
 * Persist the raw message (key + content) so quoting, forwarding and the
 * Baileys retry callback survive restarts. `conversationId` is the bare,
 * normalised chat id; when omitted the connector resolves the canonical
 * conversation itself (fork path). `source` drives the history retention
 * window: live traffic and our own sends are always kept, history-sync only
 * inside DURABLE_PAYLOAD_HISTORY_DAYS. Key material, thumbnails and protocol
 * messages never land here; oversized payloads are skipped.
 *
 * Three timestamp shapes exist because the deployments diverged: the NAS
 * table (connectors/whatsapp-web/migrations/001) keys the timestamp on
 * `message_timestamp_ms bigint`; fresh migration-015 tables carry only
 * `wa_timestamp timestamptz`; the NAS table EXPANDED by migration 015
 * (ALTER ADD COLUMN + backfill) has both. Baileys bootstrap calls
 * `adoptPayloadTimestampShape()` once to pick the shape with two LIMIT-0
 * probes; if the probe never ran (or a migration lands mid-process), the
 * insert still self-corrects permanently on the first undefined-column
 * error. On the converged table both columns are written so the fork scans
 * and the mcp-server readers see every new row.
 * Never throws: returns whether the payload is stored.
 */
const TS_SHAPE_INSERT = `
     INSERT INTO whatsapp_message_payloads
       (wa_message_id, account, conversation_id, message_key, message_payload, wa_timestamp, push_name)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
     ON CONFLICT (wa_message_id) DO UPDATE SET
       conversation_id = EXCLUDED.conversation_id,
       message_key = EXCLUDED.message_key,
       message_payload = EXCLUDED.message_payload,
       wa_timestamp = COALESCE(EXCLUDED.wa_timestamp, whatsapp_message_payloads.wa_timestamp),
       push_name = COALESCE(EXCLUDED.push_name, whatsapp_message_payloads.push_name)
     WHERE whatsapp_message_payloads.message_payload IS DISTINCT FROM EXCLUDED.message_payload
        OR whatsapp_message_payloads.message_key IS DISTINCT FROM EXCLUDED.message_key`;

const MS_SHAPE_INSERT = `
     INSERT INTO whatsapp_message_payloads
       (wa_message_id, account, conversation_id, message_key, message_payload,
        message_timestamp_ms, push_name)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
     ON CONFLICT (wa_message_id) DO UPDATE SET
       account = EXCLUDED.account,
       conversation_id = EXCLUDED.conversation_id,
       message_key = EXCLUDED.message_key,
       message_payload = EXCLUDED.message_payload,
       message_timestamp_ms = EXCLUDED.message_timestamp_ms,
       push_name = EXCLUDED.push_name,
       updated_at = now()`;

const BOTH_SHAPE_INSERT = `
     INSERT INTO whatsapp_message_payloads
       (wa_message_id, account, conversation_id, message_key, message_payload,
        wa_timestamp, message_timestamp_ms, push_name)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
     ON CONFLICT (wa_message_id) DO UPDATE SET
       conversation_id = EXCLUDED.conversation_id,
       message_key = EXCLUDED.message_key,
       message_payload = EXCLUDED.message_payload,
       wa_timestamp = COALESCE(EXCLUDED.wa_timestamp, whatsapp_message_payloads.wa_timestamp),
       message_timestamp_ms =
         COALESCE(EXCLUDED.message_timestamp_ms, whatsapp_message_payloads.message_timestamp_ms),
       push_name = COALESCE(EXCLUDED.push_name, whatsapp_message_payloads.push_name)
     WHERE whatsapp_message_payloads.message_payload IS DISTINCT FROM EXCLUDED.message_payload
        OR whatsapp_message_payloads.message_key IS DISTINCT FROM EXCLUDED.message_key`;

async function execPayloadInsert(
  shape: PayloadShape,
  base: [string, string, string, string, string],
  timestamp: number | undefined,
  pushName: string | null
): Promise<'ok' | 'missing' | 'column' | 'failed'> {
  const [idKey, account, convKey, key, payload] = base;
  const stamp = timestamp === undefined ? null : new Date(timestamp * 1000);
  const millis = timestamp === undefined ? null : timestamp * 1000;
  const params =
    shape === 'both'
      ? [idKey, account, convKey, key, payload, stamp, millis, pushName]
      : shape === 'ms'
        ? [idKey, account, convKey, key, payload, millis, pushName]
        : [idKey, account, convKey, key, payload, stamp, pushName];
  const sql =
    shape === 'both' ? BOTH_SHAPE_INSERT : shape === 'ms' ? MS_SHAPE_INSERT : TS_SHAPE_INSERT;
  try {
    await pool().query(sql, params);
    tableBackoff.markPresent();
    return 'ok';
  } catch (error) {
    if (isUndefinedColumn(error)) return 'column';
    if (isUndefinedTable(error)) {
      tableBackoff.markMissing();
      return 'missing';
    }
    console.warn(`durable payload store failed for ${idKey}: ${describeError(error)}`);
    return 'failed';
  }
}

export async function storeRawWAMessage(
  message: WAMessage,
  conversationId?: string,
  source: DurablePayloadSource = 'live'
): Promise<boolean> {
  const id = message?.key?.id;
  const remoteJid = message?.key?.remoteJid;
  if (!id || !remoteJid || !message.message) return false;
  if (novedadesKind(message.key)) return false;
  const timestamp = unixSeconds(message.messageTimestamp);
  if (!shouldStoreDurablePayload(source, timestamp)) return false;
  if (tableBackoff.isMissing()) return false;

  let payload: string;
  let key: string;
  try {
    const content = toDurablePayload(message.message);
    if (!content) return false;
    payload = serializeDurableValue(content);
    key = serializeDurableValue(message.key);
  } catch (error) {
    console.warn(`durable payload encode failed for ${id}: ${describeError(error)}`);
    return false;
  }
  if (Buffer.byteLength(payload) > maxPayloadBytes()) {
    console.warn(`durable payload for ${id} skipped: ${Buffer.byteLength(payload)} bytes over cap`);
    return false;
  }

  const conv = conversationId || (await canonicalConversationId(storageConversationId(remoteJid)));
  const base: [string, string, string, string, string] = [
    accountKey(id),
    connectorAccount(),
    accountKey(conv),
    key,
    payload,
  ];
  const pushName = message.pushName || null;

  let outcome = await execPayloadInsert(currentPayloadShape(), base, timestamp, pushName);
  if (outcome === 'column') {
    flipPayloadShape();
    outcome = await execPayloadInsert(currentPayloadShape(), base, timestamp, pushName);
    if (outcome === 'column') {
      console.warn(`durable payload insert failed on both timestamp shapes for ${id}`);
      return false;
    }
  }
  return outcome === 'ok';
}

/**
 * The stored WAMessage for a Baileys message id (bare or namespaced), scoped to
 * this connector's account, optionally pinned to one chat (fork path).
 * undefined when unknown or on any DB error.
 */
export async function getRawWAMessage(
  messageId: string,
  chatId?: string
): Promise<WAMessage | undefined> {
  const bare = messageId ? stripAccountKey(messageId) : '';
  if (!bare || tableBackoff.isMissing()) return undefined;
  try {
    let row = await selectRawWAMessage(bare, chatId, currentPayloadShape());
    if (row === 'column') {
      flipPayloadShape();
      row = await selectRawWAMessage(bare, chatId, currentPayloadShape());
      if (row === 'column') return undefined;
    }
    tableBackoff.markPresent();
    if (!row?.message_key || !row.message_payload) return undefined;
    const key = deserializeDurableValue(row.message_key) as WAMessageKey;
    const tsMs = toEpochMs(
      row.message_timestamp_ms !== undefined && row.message_timestamp_ms !== null
        ? row.message_timestamp_ms
        : row.wa_timestamp
    );
    return {
      key: { ...key, id: bare },
      message: fromDurablePayload(row.message_payload),
      messageTimestamp: Number.isFinite(tsMs) ? Math.floor(tsMs / 1000) : undefined,
      pushName: row.push_name || undefined,
    } as WAMessage;
  } catch (error) {
    if (isUndefinedTable(error)) {
      tableBackoff.markMissing();
      return undefined;
    }
    console.warn(`durable payload lookup failed for ${bare}: ${describeError(error)}`);
    return undefined;
  }
}

/**
 * Both timestamp shapes end as epoch milliseconds: pg hands back the NAS
 * bigint as a numeric string and migration 015's timestamptz as a Date (or an
 * ISO string through mocks), and plain `new Date(string)` rejects the first.
 */
function toEpochMs(value: unknown): number {
  if (value === null || value === undefined) return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  return Date.parse(String(value));
}

function payloadTimestampSelect(shape: PayloadShape): string {
  if (shape === 'ms') return 'message_timestamp_ms';
  if (shape === 'both')
    return 'COALESCE(message_timestamp_ms, EXTRACT(EPOCH FROM wa_timestamp)::bigint * 1000) AS message_timestamp_ms';
  return 'wa_timestamp';
}

async function selectRawWAMessage(
  bare: string,
  chatId: string | undefined,
  shape: PayloadShape
): Promise<
  | 'column'
  | {
      message_key?: unknown;
      message_payload?: unknown;
      message_timestamp_ms?: string | number | null;
      wa_timestamp?: Date | string | null;
      push_name?: string | null;
    }
  | undefined
> {
  const params: unknown[] = [accountKey(bare), connectorAccount()];
  let where = 'wa_message_id = $1 AND account = $2';
  if (chatId) {
    params.push(accountKey(await canonicalConversationId(storageConversationId(chatId))));
    where += ' AND conversation_id = $3';
  }
  let rows: unknown[];
  try {
    const result = await pool().query(
      `SELECT message_key, message_payload, ${payloadTimestampSelect(shape)}, push_name
         FROM whatsapp_message_payloads
        WHERE ${where}
        LIMIT 1`,
      params
    );
    rows = result.rows;
  } catch (error) {
    if (isUndefinedColumn(error)) return 'column';
    throw error;
  }
  const row = rows[0] as
    | {
        message_key?: unknown;
        message_payload?: unknown;
        message_timestamp_ms?: string | number | null;
        wa_timestamp?: Date | string | null;
        push_name?: string | null;
      }
    | undefined;
  return row as
    | {
        message_key?: unknown;
        message_payload?: unknown;
        message_timestamp_ms?: string | number | null;
        wa_timestamp?: Date | string | null;
        push_name?: string | null;
      }
    | undefined;
}

export interface DurableMessageKey {
  key: WAMessageKey;
  messageTimestamp?: number;
}

export async function getMessageKeysForChat(
  chatId: string,
  options: { unreadOnly?: boolean } = {}
): Promise<DurableMessageKey[]> {
  const unread = options.unreadOnly
    ? `AND m.direction = 'INBOUND' AND m.status IS DISTINCT FROM 'read' AND NOT COALESCE(m.is_deleted, false)`
    : '';
  const result = await pool().query(
    `SELECT k.wa_message_id, k.remote_jid, k.from_me, k.participant_jid,
            k.message_timestamp_ms
       FROM whatsapp_message_keys k
       JOIN messages m ON m.wa_message_id = k.wa_message_id
      WHERE k.conversation_id = $1
        AND m.account = $2
        AND m.platform = 'whatsapp'
        ${unread}
      -- Baileys expects lastMessages in reverse chronological order, with the
      -- oldest item last so its message range ends at the latest received key.
      ORDER BY k.message_timestamp_ms DESC`,
    [accountKey(await canonicalConversationId(storageConversationId(chatId))), connectorAccount()]
  );
  return result.rows.map(row => ({
    key: {
      remoteJid: row.remote_jid,
      id: stripAccountKey(String(row.wa_message_id)),
      fromMe: !!row.from_me,
      participant: row.participant_jid || undefined,
    },
    messageTimestamp:
      row.message_timestamp_ms == null
        ? undefined
        : Math.floor(Number(row.message_timestamp_ms) / 1000),
  }));
}

export async function markMessageEdited(
  messageId: string,
  content?: string | null,
  messageType?: string
): Promise<void> {
  const fields: string[] = ['is_edited = TRUE', 'edited_at = now()', 'updated_at = now()'];
  const params: unknown[] = [accountKey(messageId)];
  if (content !== undefined) {
    params.push(content);
    fields.push(`content = $${params.length}`);
  }
  if (messageType !== undefined) {
    params.push(messageType);
    fields.push(`message_type = $${params.length}`);
  }
  params.push(connectorAccount());
  await pool().query(
    `UPDATE messages SET ${fields.join(', ')}
      WHERE wa_message_id = $1 AND account = $${params.length}`,
    params
  );
}

export async function markMessageDeleted(messageId: string): Promise<void> {
  await pool().query(
    `UPDATE messages
        SET is_deleted = TRUE, deleted_at = now(), status = 'deleted', status_at = now(), updated_at = now()
      WHERE wa_message_id = $1 AND account = $2`,
    [accountKey(messageId), connectorAccount()]
  );
}

export async function markMessageDeletedForMe(messageId: string, chatId: string): Promise<void> {
  await pool().query(
    `UPDATE messages
        SET is_deleted = TRUE, deleted_at = now(), updated_at = now()
      WHERE wa_message_id = $1 AND account = $2 AND conversation_id = $3`,
    [
      accountKey(messageId),
      connectorAccount(),
      accountKey(await canonicalConversationId(storageConversationId(chatId))),
    ]
  );
}

export interface ChatStatePatch {
  archived?: boolean;
  unreadCount?: number;
  pinned?: boolean;
  muteUntil?: number | null;
  starred?: boolean;
}

export async function upsertChatState(chatId: string, patch: ChatStatePatch): Promise<void> {
  const account = connectorAccount();
  const canonicalChatId = await canonicalConversationId(storageConversationId(chatId));
  await pool().query(
    `INSERT INTO whatsapp_chat_state
       (account, chat_id, archived, unread_count, pinned, mute_until, starred)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (account, chat_id) DO UPDATE SET
       archived = COALESCE(EXCLUDED.archived, whatsapp_chat_state.archived),
       unread_count = COALESCE(EXCLUDED.unread_count, whatsapp_chat_state.unread_count),
       pinned = COALESCE(EXCLUDED.pinned, whatsapp_chat_state.pinned),
       mute_until = CASE WHEN $8::boolean THEN $6 ELSE whatsapp_chat_state.mute_until END,
       starred = COALESCE(EXCLUDED.starred, whatsapp_chat_state.starred),
       updated_at = now()`,
    [
      account,
      accountKey(canonicalChatId),
      patch.archived ?? null,
      patch.unreadCount ?? null,
      patch.pinned ?? null,
      patch.muteUntil === undefined ? null : patch.muteUntil,
      patch.starred ?? null,
      patch.muteUntil !== undefined,
    ]
  );
}

/** Restore pin actions from a complete provider snapshot without replacing newer events. */
export async function applyPinnedChatSnapshot(
  states: Map<string, boolean>,
  startedAt: Date
): Promise<number> {
  if (!Number.isFinite(startedAt.getTime())) throw new Error('Invalid pin snapshot time');
  const account = connectorAccount();
  const resolved = new Map<string, boolean>();
  for (const [jid, pinned] of states) {
    if (!/^\d+(?:\.\d+)?@(?:g\.us|c\.us|s\.whatsapp\.net|lid)$/.test(jid)) {
      throw new Error('Invalid pin snapshot chat');
    }
    const chatId = accountKey(await canonicalConversationId(storageConversationId(jid)));
    if (resolved.has(chatId) && resolved.get(chatId) !== pinned) {
      throw new Error('Conflicting pin snapshot aliases');
    }
    resolved.set(chatId, pinned);
  }
  if (!resolved.size) return 0;
  const db = await pool().connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1), $2)', [account, 20260928]);
    for (const [chatId, pinned] of resolved) {
      await db.query(
        `INSERT INTO whatsapp_chat_state (account, chat_id, pinned)
         VALUES ($1, $2, $3)
         ON CONFLICT (account, chat_id) DO UPDATE SET
           pinned = EXCLUDED.pinned, updated_at = now()
         WHERE whatsapp_chat_state.updated_at <= $4`,
        [account, chatId, pinned, startedAt]
      );
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
  return resolved.size;
}

export interface StoredContact {
  jid: string;
  phone?: string | null;
  name?: string | null;
  pushName?: string | null;
  avatarUrl?: string | null;
}

export async function storeContact(contact: StoredContact): Promise<void> {
  await pool().query(
    `INSERT INTO whatsapp_contacts (account, jid, phone, name, push_name, avatar_url)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (account, jid) DO UPDATE SET
       phone = COALESCE(EXCLUDED.phone, whatsapp_contacts.phone),
       name = COALESCE(EXCLUDED.name, whatsapp_contacts.name),
       push_name = COALESCE(EXCLUDED.push_name, whatsapp_contacts.push_name),
       avatar_url = COALESCE(EXCLUDED.avatar_url, whatsapp_contacts.avatar_url),
       updated_at = now()`,
    [
      connectorAccount(),
      contact.jid,
      contact.phone || null,
      contact.name || null,
      contact.pushName || null,
      contact.avatarUrl || null,
    ]
  );
}

export async function listStoredContacts(limit = 500): Promise<StoredContact[]> {
  const result = await pool().query(
    `SELECT jid, phone, name, push_name, avatar_url
       FROM whatsapp_contacts
      WHERE account = $1
      ORDER BY COALESCE(name, push_name, jid)
      LIMIT $2`,
    [connectorAccount(), Math.max(1, Math.min(limit, 5000))]
  );
  return result.rows.map(row => ({
    jid: row.jid,
    phone: row.phone,
    name: row.name,
    pushName: row.push_name,
    avatarUrl: row.avatar_url,
  }));
}

export async function storeMessageReaction(input: {
  targetMessageId: string;
  reactorJid: string;
  reactionMessageId?: string;
  emoji: string;
  /**
   * Whether this account authored the reaction: `true` for a reaction we sent
   * or that Baileys echoed back from one of our own devices, `false` for a peer
   * (including a LID participant), and `undefined` or `null` -- Baileys can hand
   * over a key with no side at all -- when nothing said, which stores NULL. The
   * database turns this into the `reaction-to-own-message` hint only for an
   * explicit `false`, so guessing `false` here would notify the user about their
   * own tap.
   */
  fromMe?: boolean | null;
}): Promise<void> {
  await pool().query(
    `INSERT INTO whatsapp_message_reactions
       (account, target_wa_message_id, reactor_jid, reaction_wa_message_id, emoji, removed, from_me)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (account, target_wa_message_id, reactor_jid) DO UPDATE SET
       reaction_wa_message_id = EXCLUDED.reaction_wa_message_id,
       emoji = EXCLUDED.emoji,
       removed = EXCLUDED.removed,
       from_me = COALESCE(EXCLUDED.from_me, whatsapp_message_reactions.from_me),
       updated_at = now()`,
    [
      connectorAccount(),
      accountKey(input.targetMessageId),
      accountKey(input.reactorJid),
      input.reactionMessageId ? accountKey(input.reactionMessageId) : null,
      input.emoji || null,
      !input.emoji,
      input.fromMe ?? null,
    ]
  );
}

export async function listMessageReactions(
  messageId: string
): Promise<Array<{ reactorJid: string; emoji: string }>> {
  const result = await pool().query(
    `SELECT reactor_jid, emoji
       FROM whatsapp_message_reactions
      WHERE account = $1 AND target_wa_message_id = $2 AND NOT removed
      ORDER BY updated_at ASC`,
    [connectorAccount(), accountKey(messageId)]
  );
  return result.rows.map(row => ({
    reactorJid: stripAccountKey(row.reactor_jid),
    emoji: row.emoji,
  }));
}

export interface StoredRawMessageRow {
  /** Provider message id without the account prefix (echoed to clients). */
  waMessageId: string;
  key: WAMessageKey;
  content: unknown;
  timestampMs: number | null;
}

function toStoredRawRows(
  rows: Array<{
    wa_message_id?: string | null;
    message_key?: unknown;
    message_payload?: unknown;
    message_timestamp_ms?: string | number | null;
  }>
): StoredRawMessageRow[] {
  return rows
    .filter(row => row.wa_message_id && row.message_key && row.message_payload)
    .map(row => ({
      waMessageId: stripAccountKey(String(row.wa_message_id)),
      key: deserializeDurableValue(row.message_key) as WAMessageKey,
      content: deserializeDurableValue(row.message_payload),
      timestampMs: row.message_timestamp_ms == null ? null : Number(row.message_timestamp_ms),
    }));
}

/** Batch raw-payload lookup by unprefixed provider message ids. */
export async function getRawWAMessagesByIds(
  messageIds: string[],
  chatId?: string
): Promise<StoredRawMessageRow[]> {
  if (!messageIds.length) return [];
  const params: unknown[] = [connectorAccount(), messageIds.map(id => accountKey(id))];
  let where = 'account = $1 AND wa_message_id = ANY($2::text[])';
  if (chatId) {
    params.push(accountKey(await canonicalConversationId(storageConversationId(chatId))));
    where += ` AND conversation_id = $${params.length}`;
  }
  const result = await queryPayloadScan(
    `SELECT wa_message_id, message_key, message_payload, message_timestamp_ms
       FROM whatsapp_message_payloads
      WHERE ${where}`,
    params
  );
  return toStoredRawRows(result.rows);
}

/**
 * Raw pollUpdateMessage payloads captured for the given (unprefixed) poll ids.
 * Votes are independent messages, so this is inherently limited to what this
 * connector has actually stored — never an extrapolation of total votes.
 */
export async function listCapturedPollUpdates(
  pollMessageIds: string[],
  chatId: string,
  limit = 1000
): Promise<StoredRawMessageRow[]> {
  if (!pollMessageIds.length) return [];
  const boundedLimit = Math.max(1, Math.min(limit, 5000));
  const params: unknown[] = [
    connectorAccount(),
    pollMessageIds,
    accountKey(await canonicalConversationId(storageConversationId(chatId))),
    boundedLimit,
  ];
  const result = await queryPayloadScan(
    `SELECT wa_message_id, message_key, message_payload, message_timestamp_ms
       FROM whatsapp_message_payloads
      WHERE account = $1
        AND conversation_id = $3
        AND (
          message_payload->'pollUpdateMessage'->'pollCreationMessageKey'->>'id' = ANY($2::text[])
          OR
          message_payload#>>'{ephemeralMessage,message,pollUpdateMessage,pollCreationMessageKey,id}' = ANY($2::text[])
        )
      ORDER BY message_timestamp_ms ASC NULLS FIRST
      LIMIT $4`,
    params
  );
  return toStoredRawRows(result.rows);
}

/** Page captured RSVP ciphertext in one account/chat, including wrapped messages. */
export async function listCapturedEventResponses(
  eventMessageId: string,
  chatId: string,
  { cursor = null, limit = 200 }: { cursor?: string | null; limit?: number } = {}
): Promise<{ items: StoredRawMessageRow[]; nextCursor: string | null }> {
  if (
    !eventMessageId ||
    !chatId ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500 ||
    (cursor !== null && (typeof cursor !== 'string' || !cursor || cursor.length > 512))
  ) {
    throw new Error('Invalid event response page');
  }
  // Parameters are numbered per branch: PostgreSQL needs a determinable type for
  // every symbol up to the highest one in the statement, so an unreferenced $4
  // would fail the first page, and a nullable OR would push the keyset bound out
  // of the index condition into a post-scan filter.
  const params: unknown[] = [
    connectorAccount(),
    eventMessageId,
    accountKey(await canonicalConversationId(storageConversationId(chatId))),
  ];
  const filters = [
    // Same expression as idx_whatsapp_message_payloads_event_responses.
    EVENT_RESPONSE_PRESENT_SQL,
    `jsonb_path_exists(message_payload,
          '$.**.encEventResponseMessage.eventCreationMessageKey.id ? (@ == $eventId)',
          jsonb_build_object('eventId', $2::text))`,
  ];
  if (cursor !== null) {
    params.push(accountKey(cursor));
    filters.push(`wa_message_id COLLATE "C" > $${params.length}::text COLLATE "C"`);
  }
  params.push(limit + 1);
  const result = await queryPayloadScan(
    [
      `SELECT wa_message_id, message_key, message_payload, message_timestamp_ms`,
      `  FROM whatsapp_message_payloads`,
      ` WHERE account = $1 AND conversation_id = $3`,
      ...filters.map(filter => `   AND ${filter}`),
      ` ORDER BY wa_message_id COLLATE "C" ASC LIMIT $${params.length}`,
    ].join('\n'),
    params
  );
  const items = toStoredRawRows(result.rows.slice(0, limit));
  return { items, nextCursor: result.rows.length > limit ? items.at(-1)!.waMessageId : null };
}

// ---------------------------------------------------------------------------
// Upstream (fase 3 / PR-1) additions: retention, size control, availability
// ---------------------------------------------------------------------------

export type DurablePayloadSource = 'live' | 'history' | 'sent';

const UNDEFINED_TABLE = '42P01';
const UNDEFINED_COLUMN = '42703';
const MISSING_TABLE_RECHECK_MS = 5 * 60 * 1000;
const DEFAULT_HISTORY_DAYS = 7;
const DEFAULT_MAX_BYTES = 256 * 1024;
/** Inline binaries above this size are dropped unless the object carries a mediaKey. */
const INLINE_BLOB_MAX_BYTES = 16 * 1024;

/**
 * Fields never persisted: preview thumbnails (the bulk of a media payload; the
 * media itself stays downloadable through url/directPath/mediaKey) and Signal
 * key material that rides along some messages.
 */
const DROPPED_FIELDS = new Set([
  'jpegThumbnail',
  'pngThumbnail',
  'thumbnail',
  'senderKeyDistributionMessage',
  'fastRatchetKeySenderKeyDistributionMessage',
]);

/**
 * A referenced message (forward source, quoted message) is neither in memory
 * nor in the durable store. The HTTP layer maps it to `status`.
 */
export class MessageUnavailableError extends Error {
  readonly status: number;
  readonly failureClass: string;

  constructor(message: string, status: number, failureClass: string) {
    super(message);
    this.name = 'MessageUnavailableError';
    this.status = status;
    this.failureClass = failureClass;
  }
}

const tableBackoff = new MissingTableBackoff(
  MISSING_TABLE_RECHECK_MS,
  'whatsapp_message_payloads does not exist yet (mcp-server migration 015 not applied): ' +
    'durable message payloads are off, quoting/forward/retry fall back to process memory',
  'whatsapp_message_payloads is available: durable message payloads are on'
);
// NAS tables carry `message_timestamp_ms`; fresh migration-015 tables carry
// only `wa_timestamp`; the EXPANDED NAS table has both. The bootstrap probe
// picks the shape up front, the first undefined-column error is the fallback.
type PayloadShape = 'ts' | 'ms' | 'both';
let payloadShape: PayloadShape = 'ts';
// Scan functions read the fork column first; on k8s they flip once to derive
// the same alias from `wa_timestamp`.
let scansUseWaTimestamp = false;

/** Test hook: forget cached availability and timestamp-shape state between cases. */
export function resetDurableStoreStateForTests(): void {
  tableBackoff.reset();
  payloadShape = 'ts';
  scansUseWaTimestamp = false;
}

function currentPayloadShape(): PayloadShape {
  return payloadShape;
}

function flipPayloadShape(): void {
  // The runtime fallback only ever demotes the fresh-015 default; the probe
  // has already ruled out ambiguity for 'ms' and 'both'.
  if (payloadShape === 'ts') payloadShape = 'ms';
}

/**
 * One-shot startup probe run next to the table bootstrap: two LIMIT-0
 * selects settle which timestamp columns the table actually carries before
 * the first real insert pays a 42703. Table missing → fail soft like every
 * other durable path; transient DB trouble → keep the default and let the
 * 42703 fallback handle it.
 */
export async function adoptPayloadTimestampShape(): Promise<void> {
  let hasMs = false;
  let hasTs = false;
  for (const column of ['message_timestamp_ms', 'wa_timestamp'] as const) {
    try {
      await pool().query(`SELECT ${column} FROM whatsapp_message_payloads LIMIT 0`);
      if (column === 'message_timestamp_ms') hasMs = true;
      else hasTs = true;
    } catch (error) {
      if (isUndefinedColumn(error)) continue;
      if (isUndefinedTable(error)) {
        tableBackoff.markMissing();
        return;
      }
      return;
    }
  }
  payloadShape = hasMs && hasTs ? 'both' : hasMs ? 'ms' : 'ts';
}

function isUndefinedTable(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === UNDEFINED_TABLE;
}

function isUndefinedColumn(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === UNDEFINED_COLUMN;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function historyDays(): number {
  return envNumber('DURABLE_PAYLOAD_HISTORY_DAYS', DEFAULT_HISTORY_DAYS);
}

function maxPayloadBytes(): number {
  return envNumber('DURABLE_PAYLOAD_MAX_BYTES', DEFAULT_MAX_BYTES);
}

/** Baileys timestamps are number | Long | string | null (seconds). */
export function unixSeconds(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  const long = value as { toNumber?: () => number; low?: number; high?: number };
  if (typeof long.toNumber === 'function') return unixSeconds(long.toNumber());
  if (typeof long.low === 'number') {
    return unixSeconds((long.high || 0) * 2 ** 32 + (long.low >>> 0));
  }
  return undefined;
}

/**
 * Whether a message from `source` with this timestamp is worth storing. History
 * sync can replay months of chats: only the recent window is kept (0 = none).
 */
export function shouldStoreDurablePayload(
  source: DurablePayloadSource,
  timestampSeconds: number | undefined,
  nowMs: number = Date.now()
): boolean {
  if (source !== 'history') return true;
  const days = historyDays();
  if (days <= 0 || !timestampSeconds) return false;
  return timestampSeconds * 1000 >= nowMs - days * 24 * 60 * 60 * 1000;
}

function isBinary(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function stripHeavyFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripHeavyFields);
  if (!value || typeof value !== 'object' || isBinary(value)) return value;
  const obj = value as Record<string, unknown>;
  const hasMediaKey = obj.mediaKey !== undefined && obj.mediaKey !== null;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(obj)) {
    if (DROPPED_FIELDS.has(key)) continue;
    if (isBinary(child) && child.length > INLINE_BLOB_MAX_BYTES && !hasMediaKey) continue;
    out[key] = stripHeavyFields(child);
  }
  return out;
}

/**
 * proto.Message → plain object ready for JSONB: enums as numbers, 64-bit ints
 * as decimal strings (both round-trip through fromObject), bytes kept as
 * Buffers for the durable serialiser, heavy fields stripped. null → do not
 * store.
 */
export function toDurablePayload(
  message: proto.IMessage | null | undefined
): Record<string, unknown> | null {
  if (!message) return null;
  const decoded = proto.Message.fromObject(message as Record<string, unknown>);
  // Also inside ephemeral / view-once wrappers.
  if (decoded.protocolMessage || normalizeMessageContent(decoded)?.protocolMessage) return null;
  const plain = proto.Message.toObject(decoded, { longs: String, enums: Number });
  const stripped = stripHeavyFields(plain) as Record<string, unknown>;
  return Object.keys(stripped).length ? stripped : null;
}

/** Inverse of toDurablePayload: a real proto.Message Baileys can encode. */
export function fromDurablePayload(value: unknown): proto.IMessage {
  return proto.Message.fromObject(deserializeDurableValue(value) as Record<string, unknown>);
}

/**
 * Fork scans (batch lookup, poll votes, RSVP pages) interpolate the NAS
 * `message_timestamp_ms` column. On migration-015 tables that column does not
 * exist, so on the first undefined-column error the very same statement is
 * retried deriving the alias from `wa_timestamp`, and the shape sticks.
 */
const SCAN_TS_EXPR = 'EXTRACT(EPOCH FROM wa_timestamp)::bigint * 1000 AS message_timestamp_ms';

function rewriteScanForWaTimestamp(sql: string): string {
  return sql.replace('message_payload, message_timestamp_ms', `message_payload, ${SCAN_TS_EXPR}`);
}

async function queryPayloadScan(
  sql: string,
  params: unknown[]
): Promise<{ rows: Array<Record<string, unknown>> }> {
  if (scansUseWaTimestamp) {
    return (await pool().query(rewriteScanForWaTimestamp(sql), params)) as {
      rows: Array<Record<string, unknown>>;
    };
  }
  try {
    return (await pool().query(sql, params)) as { rows: Array<Record<string, unknown>> };
  } catch (error) {
    if (!isUndefinedColumn(error)) throw error;
    scansUseWaTimestamp = true;
    return (await pool().query(rewriteScanForWaTimestamp(sql), params)) as {
      rows: Array<Record<string, unknown>>;
    };
  }
}
