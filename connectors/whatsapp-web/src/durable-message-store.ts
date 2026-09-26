import type { Pool } from 'pg';
import type { WAMessage, WAMessageKey } from '@whiskeysockets/baileys';
import {
  accountKey,
  canonicalConversationId,
  connectorAccount,
  getPool,
  stripAccountKey,
} from './db-writer';
import { deserializeDurableValue, serializeDurableValue } from './whatsapp-capabilities';

let tablesReady = false;

function pool(): Pool {
  return getPool();
}

export function storageConversationId(jid: string): string {
  return jid.endsWith('@s.whatsapp.net') ? jid.replace(/@s\.whatsapp\.net$/, '@c.us') : jid;
}

/** Tables owned by the connector; deployment migrations can adopt them later. */
export async function ensureDurableTables(): Promise<void> {
  if (tablesReady) return;
  const db = pool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
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
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account, target_wa_message_id, reactor_jid)
    )
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

export async function storeRawWAMessage(
  message: WAMessage,
  conversationId?: string
): Promise<void> {
  const id = message.key?.id;
  const remoteJid = message.key?.remoteJid;
  if (!id || !remoteJid || !message.message) return;
  const account = connectorAccount();
  await pool().query(
    `INSERT INTO whatsapp_message_payloads
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
       updated_at = now()`,
    [
      accountKey(id),
      account,
      accountKey(
        conversationId || (await canonicalConversationId(storageConversationId(remoteJid)))
      ),
      serializeDurableValue(message.key),
      serializeDurableValue(message.message),
      message.messageTimestamp ? Number(message.messageTimestamp) * 1000 : null,
      message.pushName || null,
    ]
  );
}

export async function getRawWAMessage(
  messageId: string,
  chatId?: string
): Promise<WAMessage | undefined> {
  if (!messageId) return undefined;
  const params: unknown[] = [accountKey(messageId), connectorAccount()];
  let where = 'wa_message_id = $1 AND account = $2';
  if (chatId) {
    params.push(accountKey(await canonicalConversationId(storageConversationId(chatId))));
    where += ' AND conversation_id = $3';
  }
  const result = await pool().query(
    `SELECT message_key, message_payload, message_timestamp_ms, push_name
       FROM whatsapp_message_payloads
      WHERE ${where}
      LIMIT 1`,
    params
  );
  const row = result.rows[0] as
    | {
        message_key?: unknown;
        message_payload?: unknown;
        message_timestamp_ms?: string | number | null;
        push_name?: string | null;
      }
    | undefined;
  if (!row?.message_key || !row.message_payload) return undefined;
  const key = deserializeDurableValue(row.message_key) as WAMessageKey;
  const message = deserializeDurableValue(row.message_payload) as WAMessage['message'];
  return {
    key,
    message,
    messageTimestamp:
      row.message_timestamp_ms == null
        ? undefined
        : Math.floor(Number(row.message_timestamp_ms) / 1000),
    pushName: row.push_name || undefined,
  } as WAMessage;
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
}): Promise<void> {
  await pool().query(
    `INSERT INTO whatsapp_message_reactions
       (account, target_wa_message_id, reactor_jid, reaction_wa_message_id, emoji, removed)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (account, target_wa_message_id, reactor_jid) DO UPDATE SET
       reaction_wa_message_id = EXCLUDED.reaction_wa_message_id,
       emoji = EXCLUDED.emoji,
       removed = EXCLUDED.removed,
       updated_at = now()`,
    [
      connectorAccount(),
      accountKey(input.targetMessageId),
      accountKey(input.reactorJid),
      input.reactionMessageId ? accountKey(input.reactionMessageId) : null,
      input.emoji || null,
      !input.emoji,
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
  const result = await pool().query(
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
  const result = await pool().query(
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
