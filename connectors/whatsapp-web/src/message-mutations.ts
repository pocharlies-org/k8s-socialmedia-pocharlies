/**
 * Edit and delete of WhatsApp messages (fase 3 / PR-3) — the DB side.
 *
 * The connector is the writer of `messages` for WhatsApp (db-writer.ts), so it
 * also records edits and deletes: the outbound ones it performs and the ones
 * WhatsApp tells it about (a contact editing or revoking, our phone doing it).
 * Only a client with `ingest` on calls in here — the per-sub pairing pool never
 * writes.
 *
 * No migration: the existing columns plus `metadata`. Nothing is ever lost:
 *  - edit: `content` becomes the new text, `is_edited = true`; the text it
 *    replaces is appended to `metadata.edit_history`
 *    ([{content, replaced_at, source, actor?}], oldest first) and
 *    `metadata.edited_at` is the last edit;
 *  - delete for everyone (revoke): `is_deleted = true`, `status = 'deleted'`
 *    (what inbound revokes already set), `metadata.deleted_at`; the content
 *    stays;
 *  - delete for me: `metadata.deleted_for_me = true` + `deleted_for_me_at`.
 *    `is_deleted` is NOT touched: the message still exists for the other side,
 *    this is a view flag of this account, not a change of the message.
 *
 * Rows are addressed by the namespaced message id + `account_id`, never by
 * the chat: a merged (tombstone) conversation moved its messages to the
 * canonical one and the message id is what stays stable. Every write is
 * idempotent (a replay changes nothing), so our own action and the echo
 * WhatsApp sends back can never double an edit-history entry.
 */
import type { proto } from '@whiskeysockets/baileys';
import { accountKey, connectorAccount, getPool, stripAccountKey } from './db-writer';

/** Who told us: this connector's own HTTP action, or WhatsApp (contact / our phone). */
export type MutationSource = 'connector' | 'whatsapp';

export interface MutationOptions {
  source: MutationSource;
  /** Who asked for it (dgx-messages user, MCP caller); recorded, never trusted for auth. */
  actor?: string;
  at?: Date;
}

/**
 * An edit or delete WhatsApp would not accept, refused before anything is
 * sent (not the author, not a text message…). The HTTP layer maps it to
 * `status` with `failureClass`.
 */
export class MessageMutationError extends Error {
  readonly status: number;
  readonly failureClass: string;
  readonly code?: string;

  constructor(message: string, status: number, failureClass: string, code?: string) {
    super(message);
    this.name = 'MessageMutationError';
    this.status = status;
    this.failureClass = failureClass;
    this.code = code;
  }
}

/** social_accounts id of this connector's account (ADR 0001). */
export function whatsappAccountId(): string {
  return `whatsapp:${connectorAccount()}`;
}

export interface StoredMessage {
  /** Bare WhatsApp id. */
  id: string;
  conversationId: string | null;
  senderWaId: string | null;
  direction: string;
  messageType: string;
  content: string | null;
  isDeleted: boolean;
  deletedForMe: boolean;
  waTimestampSeconds?: number;
  /** whatsapp_message_keys row, when the message went through ingest. */
  key?: {
    remoteJid: string;
    fromMe: boolean;
    participant?: string;
    timestampSeconds?: number;
  };
}

function seconds(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const ms = value instanceof Date ? value.getTime() : new Date(value as string).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : undefined;
}

/** The stored row of a message of this account (bare or namespaced id); undefined if unknown. */
export async function loadStoredMessage(messageId: string): Promise<StoredMessage | undefined> {
  const bare = stripAccountKey(messageId);
  const result = await getPool().query(
    `SELECT m.wa_message_id, m.conversation_id, m.sender_wa_id, m.direction, m.message_type,
            m.content, COALESCE(m.is_deleted, FALSE) AS is_deleted,
            (m.metadata->>'deleted_for_me') = 'true' AS deleted_for_me, m.wa_timestamp,
            k.remote_jid, k.from_me, k.participant_jid, k.message_timestamp_ms
       FROM messages m
       LEFT JOIN whatsapp_message_keys k ON k.wa_message_id = m.wa_message_id
      WHERE m.wa_message_id = $1 AND m.account_id = $2 AND m.platform = 'whatsapp'
      LIMIT 1`,
    [accountKey(bare), whatsappAccountId()]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const keyMs = row.message_timestamp_ms == null ? NaN : Number(row.message_timestamp_ms);
  return {
    id: bare,
    conversationId: row.conversation_id ?? null,
    senderWaId: row.sender_wa_id ?? null,
    direction: String(row.direction || ''),
    messageType: String(row.message_type || ''),
    content: row.content ?? null,
    isDeleted: !!row.is_deleted,
    deletedForMe: !!row.deleted_for_me,
    waTimestampSeconds: seconds(row.wa_timestamp),
    key: row.remote_jid
      ? {
          remoteJid: String(row.remote_jid),
          fromMe: !!row.from_me,
          participant: row.participant_jid || undefined,
          timestampSeconds:
            Number.isFinite(keyMs) && keyMs > 0 ? Math.floor(keyMs / 1000) : undefined,
        }
      : undefined,
  };
}

function isoAt(options: MutationOptions): string {
  return (options.at || new Date()).toISOString();
}

/**
 * New text for a message; the one it replaces goes to metadata.edit_history.
 * No-op (false) when the text is already that one or the row is unknown.
 */
export async function markMessageEdited(
  messageId: string,
  content: string,
  options: MutationOptions
): Promise<boolean> {
  // On the right-hand side of SET, `content` / `metadata` are the OLD values.
  const result = await getPool().query(
    `UPDATE messages
        SET content = $3,
            is_edited = TRUE,
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'edit_history',
              COALESCE(metadata->'edit_history', '[]'::jsonb) || jsonb_build_array(
                jsonb_strip_nulls(jsonb_build_object(
                  'content', content, 'replaced_at', $4::text,
                  'source', $5::text, 'actor', $6::text))),
              'edited_at', $4::text)
      WHERE wa_message_id = $1 AND account_id = $2 AND platform = 'whatsapp'
        AND content IS DISTINCT FROM $3
      RETURNING id`,
    [
      accountKey(stripAccountKey(messageId)),
      whatsappAccountId(),
      content,
      isoAt(options),
      options.source,
      options.actor || null,
    ]
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

/** Revoked for everyone: flagged, content kept. No-op (false) when already flagged. */
export async function markMessageRevoked(
  messageId: string,
  options: MutationOptions
): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE messages
        SET is_deleted = TRUE,
            status = 'deleted',
            status_at = now(),
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
              'deleted_at', $3::text, 'deleted_source', $4::text, 'deleted_by', $5::text))
      WHERE wa_message_id = $1 AND account_id = $2 AND platform = 'whatsapp'
        AND NOT COALESCE(is_deleted, FALSE)
      RETURNING id`,
    [
      accountKey(stripAccountKey(messageId)),
      whatsappAccountId(),
      isoAt(options),
      options.source,
      options.actor || null,
    ]
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

/** Deleted for me only: a metadata flag, the row stays as it is. No-op when already set. */
export async function markMessageDeletedForMe(
  messageId: string,
  options: MutationOptions
): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE messages
        SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
              'deleted_for_me', TRUE, 'deleted_for_me_at', $3::text,
              'deleted_for_me_source', $4::text, 'deleted_for_me_by', $5::text))
      WHERE wa_message_id = $1 AND account_id = $2 AND platform = 'whatsapp'
        AND (metadata->>'deleted_for_me') IS DISTINCT FROM 'true'
      RETURNING id`,
    [
      accountKey(stripAccountKey(messageId)),
      whatsappAccountId(),
      isoAt(options),
      options.source,
      options.actor || null,
    ]
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

/**
 * The current text of a message that was edited (the row's `content` once
 * `is_edited`), undefined when it never was, the row is unknown, or it has no
 * text. What a quote or forward must show: the stored payload
 * (whatsapp_message_payloads, the in-memory copy) is the original — an edit
 * only rewrites the messages row.
 */
export async function loadEditedContent(messageId: string): Promise<string | undefined> {
  const result = await getPool().query(
    `SELECT content FROM messages
      WHERE wa_message_id = $1 AND account_id = $2 AND platform = 'whatsapp'
        AND COALESCE(is_edited, FALSE)
      LIMIT 1`,
    [accountKey(stripAccountKey(messageId)), whatsappAccountId()]
  );
  const content = result.rows[0]?.content;
  return typeof content === 'string' ? content : undefined;
}

/** Wrappers whose `.message` holds the real content. */
const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
] as const;

/**
 * `message` with its text (conversation / extendedTextMessage.text) or its
 * caption (image, video, document) replaced by `text`, wrappers followed; the
 * rest (context, media keys, secrets) kept. undefined when it carries no
 * text, or already that one — nothing to change.
 */
export function withEditedText(
  message: proto.IMessage | null | undefined,
  text: string
): proto.IMessage | undefined {
  if (!message) return undefined;
  for (const wrapper of WRAPPERS) {
    const inner = message[wrapper]?.message;
    if (inner) {
      const replaced = withEditedText(inner, text);
      return replaced
        ? { ...message, [wrapper]: { ...message[wrapper], message: replaced } }
        : undefined;
    }
  }
  if (typeof message.conversation === 'string' && message.conversation) {
    return message.conversation === text ? undefined : { ...message, conversation: text };
  }
  if (message.extendedTextMessage) {
    return message.extendedTextMessage.text === text
      ? undefined
      : { ...message, extendedTextMessage: { ...message.extendedTextMessage, text } };
  }
  for (const media of ['imageMessage', 'videoMessage', 'documentMessage'] as const) {
    const node = message[media];
    if (node) {
      return node.caption === text
        ? undefined
        : { ...message, [media]: { ...node, caption: text } };
    }
  }
  return undefined;
}
