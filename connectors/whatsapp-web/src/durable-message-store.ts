/**
 * Durable copy of the raw Baileys messages (fase 3 / PR-1, ported from the NAS
 * fork's durable-message-store and adapted to the multiaccount model).
 *
 * Quoting, forwarding and the Baileys retry callback (getMessage) need the
 * original WAMessage — key AND content. Until now the connector only had it in
 * process memory (keyCache / retryMessageCache), so every restart broke replies
 * with quote, retries of our own sends and made forwarding impossible. The copy
 * lives in `whatsapp_message_payloads` (mcp-server migration 009).
 *
 * Rules:
 *  - ids use the SAME namespacing as `messages` (accountKey), so a payload row
 *    joins to its messages row by wa_message_id and to its conversation by id;
 *  - the table is created by the migration, never here. While it does not exist
 *    yet (connector deployed before the mcp-server image that carries 009) every
 *    call fails soft: 42P01 is logged once and the caller keeps the in-memory
 *    behaviour. The table is re-probed every few minutes, so no restart is
 *    needed once the migration lands;
 *  - size control: live traffic and our own sends are stored, history-sync
 *    messages only when newer than DURABLE_PAYLOAD_HISTORY_DAYS (default 7),
 *    thumbnails and other inline blobs are stripped, and a payload bigger than
 *    DURABLE_PAYLOAD_MAX_BYTES is skipped;
 *  - key material is never stored (senderKeyDistributionMessage, protocol
 *    messages).
 *
 * The caller (BaileysClient) only calls in here when `ingest` is on: the per-sub
 * pairing pool (ingest off) never touches this table.
 */
import { BufferJSON, normalizeMessageContent, proto } from '@whiskeysockets/baileys';
import type { WAMessage, WAMessageKey } from '@whiskeysockets/baileys';
import { accountKey, connectorAccount, getPool, stripAccountKey } from './db-writer';

export type DurablePayloadSource = 'live' | 'history' | 'sent';

const UNDEFINED_TABLE = '42P01';
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

let tableMissingUntil = 0;
let missingTableLogged = false;

/** Test hook: forget the "table missing" state between cases. */
export function resetDurableStoreStateForTests(): void {
  tableMissingUntil = 0;
  missingTableLogged = false;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUndefinedTable(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === UNDEFINED_TABLE;
}

/** true → skip the DB entirely (table known missing, re-probe not due yet). */
function tableKnownMissing(): boolean {
  return tableMissingUntil > Date.now();
}

function noteTableMissing(): void {
  tableMissingUntil = Date.now() + MISSING_TABLE_RECHECK_MS;
  if (!missingTableLogged) {
    missingTableLogged = true;
    console.warn(
      'whatsapp_message_payloads does not exist yet (mcp-server migration 009 not applied): ' +
        'durable message payloads are off, quoting/forward/retry fall back to process memory'
    );
  }
}

function noteTablePresent(): void {
  if (missingTableLogged) {
    missingTableLogged = false;
    console.info('whatsapp_message_payloads is available: durable message payloads are on');
  }
  tableMissingUntil = 0;
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

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/** JSON with Buffers/Uint8Arrays as base64 (Baileys' BufferJSON). */
export function serializeDurableValue(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer);
}

/** Inverse of serializeDurableValue; accepts the text or the object pg returns for JSONB. */
export function deserializeDurableValue(value: unknown): unknown {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return JSON.parse(text, BufferJSON.reviver);
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
 * Buffers for BufferJSON, heavy fields stripped. null → do not store.
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

// ---------------------------------------------------------------------------
// Store / lookup
// ---------------------------------------------------------------------------

/**
 * Persist the raw message. `conversationId` is the bare, normalised chat id the
 * connector uses for `messages.conversation_id` (namespaced here). Never
 * throws: returns whether the payload is stored (written now or already current).
 */
export async function storeRawWAMessage(
  msg: WAMessage,
  conversationId: string,
  source: DurablePayloadSource
): Promise<boolean> {
  const id = msg?.key?.id;
  if (!id || !msg.key.remoteJid || !conversationId || !msg.message) return false;
  const timestamp = unixSeconds(msg.messageTimestamp);
  if (!shouldStoreDurablePayload(source, timestamp)) return false;
  if (tableKnownMissing()) return false;

  let payload: string;
  let key: string;
  try {
    const content = toDurablePayload(msg.message);
    if (!content) return false;
    payload = serializeDurableValue(content);
    key = serializeDurableValue(msg.key);
  } catch (error) {
    console.warn(`durable payload encode failed for ${id}: ${describeError(error)}`);
    return false;
  }
  if (Buffer.byteLength(payload) > maxPayloadBytes()) {
    console.warn(`durable payload for ${id} skipped: ${Buffer.byteLength(payload)} bytes over cap`);
    return false;
  }

  try {
    await getPool().query(
      `INSERT INTO whatsapp_message_payloads
         (wa_message_id, account, conversation_id, message_key, message_payload, wa_timestamp, push_name)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
       ON CONFLICT (wa_message_id) DO UPDATE SET
         conversation_id = EXCLUDED.conversation_id,
         message_key = EXCLUDED.message_key,
         message_payload = EXCLUDED.message_payload,
         wa_timestamp = COALESCE(EXCLUDED.wa_timestamp, whatsapp_message_payloads.wa_timestamp),
         push_name = COALESCE(EXCLUDED.push_name, whatsapp_message_payloads.push_name)
       WHERE whatsapp_message_payloads.message_payload IS DISTINCT FROM EXCLUDED.message_payload
          OR whatsapp_message_payloads.message_key IS DISTINCT FROM EXCLUDED.message_key`,
      [
        accountKey(id),
        connectorAccount(),
        accountKey(conversationId),
        key,
        payload,
        timestamp ? new Date(timestamp * 1000) : null,
        msg.pushName || null,
      ]
    );
    noteTablePresent();
    return true;
  } catch (error) {
    if (isUndefinedTable(error)) {
      noteTableMissing();
      return false;
    }
    console.warn(`durable payload store failed for ${id}: ${describeError(error)}`);
    return false;
  }
}

/**
 * The stored WAMessage for a Baileys message id (bare or namespaced), scoped to
 * this connector's account. undefined when unknown or on any DB error.
 */
export async function getRawWAMessage(messageId: string): Promise<WAMessage | undefined> {
  const bare = messageId ? stripAccountKey(messageId) : '';
  if (!bare || tableKnownMissing()) return undefined;
  try {
    const result = await getPool().query(
      `SELECT message_key, message_payload, wa_timestamp, push_name
         FROM whatsapp_message_payloads
        WHERE wa_message_id = $1 AND account = $2
        LIMIT 1`,
      [accountKey(bare), connectorAccount()]
    );
    noteTablePresent();
    const row = result.rows[0] as
      | {
          message_key?: unknown;
          message_payload?: unknown;
          wa_timestamp?: Date | string | null;
          push_name?: string | null;
        }
      | undefined;
    if (!row?.message_key || !row.message_payload) return undefined;
    const key = deserializeDurableValue(row.message_key) as WAMessageKey;
    const ts = row.wa_timestamp ? new Date(row.wa_timestamp).getTime() : NaN;
    return {
      key: { ...key, id: bare },
      message: fromDurablePayload(row.message_payload),
      messageTimestamp: Number.isFinite(ts) ? Math.floor(ts / 1000) : undefined,
      pushName: row.push_name || undefined,
    } as WAMessage;
  } catch (error) {
    if (isUndefinedTable(error)) {
      noteTableMissing();
      return undefined;
    }
    console.warn(`durable payload lookup failed for ${bare}: ${describeError(error)}`);
    return undefined;
  }
}
