/**
 * Opt-in send idempotency (fase 3 / PR-2, ported from the NAS fork's
 * send-idempotency and adapted to prod).
 *
 * The fork keyed every send on `sendToken`. Prod callers reuse a CONSTANT
 * sendToken (synapse `synapse-messaging`, dgx-messages WHATSAPP_SEND_TOKEN,
 * skirmshop-labels, the MCP `direct-<ms>`), so keying on it would dedupe or 409
 * different messages. Here idempotency only exists when the caller sends an
 * explicit key — HTTP header `Idempotency-Key` or body field `idempotencyKey`.
 * Without one the routes behave exactly as before and nothing here runs.
 *
 * With a key, one row of `whatsapp_send_attempts` (mcp-server migration 010)
 * per (account, sha256(key)) records the attempt:
 *
 *   prepared ──claim (just before the network send)──▶ pending ──▶ sent
 *      │                                                 │
 *      └─ failed (error before the send: safe to retry)  └─ stays pending when
 *                                                           the outcome is unknown
 *
 *  - same key + same request   → the recorded outcome, no second send;
 *  - same key + other request  → 409 idempotency_key_reused;
 *  - a row left in `pending`   → 409 send_outcome_uncertain (+ its message id);
 *  - `prepared`/`failed`       → nothing went out yet: the send is retried.
 *
 * The WhatsApp message id is derived from (account, key) — `3EB0` + 18 hex, the
 * shape Baileys generates — so a retry after an uncertain outcome is the same
 * message id WhatsApp may already hold. The raw key is never stored.
 *
 * Fail soft, like durable-message-store: while the table does not exist (the
 * connector deployed before the mcp-server image that carries 010) 42P01 is
 * logged once and the send goes out WITHOUT idempotency; the table is re-probed
 * every few minutes. Any other DB error while reserving degrades the same way
 * (today's behaviour), never blocks a send.
 *
 * The caller (controller) only comes here when the client ingests: the per-sub
 * pairing pool (ingest off) never touches this table.
 */
import { createHash, randomUUID } from 'node:crypto';
import { parseMediaQuality, type MediaQuality } from './media-quality';
import { connectorAccount, getPool } from './db-writer';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_BODY_FIELD = 'idempotencyKey';
const MAX_KEY_LENGTH = 200;

const UNDEFINED_TABLE = '42P01';
const MISSING_TABLE_RECHECK_MS = 5 * 60 * 1000;

export type SendReservationState =
  /** first attempt for this key: go ahead and send */
  | 'claimed'
  /** an earlier attempt failed before reaching WhatsApp: send again */
  | 'retry'
  /** Adapter name for a retryable attempt; persisted state remains prepared/failed. */
  | 'prepared'
  /** already sent: answer the recorded outcome */
  | 'sent'
  /** an earlier attempt may or may not have gone out */
  | 'pending'
  /** the key was used for a different request */
  | 'conflict'
  /** no idempotency store (table missing, DB error): send without it */
  | 'unavailable';

export interface SendReservation {
  state: SendReservationState;
  messageId?: string;
  sentAt?: string;
}

/** The attempt was claimed by someone else between reserve and send. */
export class SendAlreadyClaimedError extends Error {
  constructor() {
    super('Send attempt already claimed or completed');
    this.name = 'SendAlreadyClaimedError';
  }
}

let tableMissingUntil = 0;
let missingTableLogged = false;

/** Test hook: forget the "table missing" state between cases. */
export function resetSendIdempotencyStateForTests(): void {
  tableMissingUntil = 0;
  missingTableLogged = false;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUndefinedTable(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === UNDEFINED_TABLE;
}

function noteTableMissing(): void {
  tableMissingUntil = Date.now() + MISSING_TABLE_RECHECK_MS;
  if (!missingTableLogged) {
    missingTableLogged = true;
    console.warn(
      'whatsapp_send_attempts does not exist yet (mcp-server migration 010 not applied): ' +
        'Idempotency-Key is ignored, sends go out without idempotency'
    );
  }
}

function noteTablePresent(): void {
  if (missingTableLogged) {
    missingTableLogged = false;
    console.info('whatsapp_send_attempts is available: Idempotency-Key is honoured');
  }
  tableMissingUntil = 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// ---------------------------------------------------------------------------
// Key parsing and hashing
// ---------------------------------------------------------------------------

/**
 * The caller's idempotency key: header `Idempotency-Key` and/or body
 * `idempotencyKey`. Absent (or blank) → `{}`: the legacy, non-idempotent path.
 * Both given with different values, a non-string or an over-long key → error.
 */
export function readIdempotencyKey(
  headers: Record<string, string | string[] | undefined>,
  body: unknown
): { key?: string; error?: string } {
  const header = headers[IDEMPOTENCY_HEADER];
  const field =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)[IDEMPOTENCY_BODY_FIELD]
      : undefined;
  if (Array.isArray(header)) return { error: 'Idempotency-Key must be a single header' };
  if (field !== undefined && field !== null && typeof field !== 'string') {
    return { error: 'idempotencyKey must be a string' };
  }
  const fromHeader = header?.trim() || undefined;
  const fromBody = (typeof field === 'string' && field.trim()) || undefined;
  if (fromHeader && fromBody && fromHeader !== fromBody) {
    return { error: 'Idempotency-Key header and idempotencyKey body field differ' };
  }
  const key = fromHeader || fromBody;
  if (!key) return {};
  if (key.length > MAX_KEY_LENGTH) {
    return { error: `Idempotency-Key is longer than ${MAX_KEY_LENGTH} characters` };
  }
  return { key };
}

export function idempotencyKeyHash(key: string): string {
  return sha256(key);
}

/**
 * Deterministic WhatsApp message id for (account, key): `3EB0` + 18 upper-case
 * hex, the shape of Baileys' own ids.
 */
export function idempotentMessageId(key: string, account: string = connectorAccount()): string {
  return `3EB0${sha256(JSON.stringify([account, key]))
    .slice(0, 18)
    .toUpperCase()}`;
}

export function textRequestHash(input: {
  conversationId: string;
  content: string;
  replyToMessageId?: string;
}): string {
  return sha256(
    JSON.stringify(['text', input.conversationId, input.content, input.replyToMessageId || null])
  );
}

export function mediaRequestHash(input: {
  conversationId: string;
  fileUrl: string;
  caption?: string;
  asSticker: boolean;
  replyToMessageId?: string;
  viewOnce?: boolean;
  quality?: string;
  fileName?: string;
  asGif?: boolean;
  sourceDigest?: string;
  sourceMimeType?: string;
}): string {
  if (input.sourceDigest || input.sourceMimeType || input.asGif) {
    return mediaSourceRequestHash({
      ...input,
      quality: input.quality as MediaQuality | undefined,
      asGif: !!input.asGif,
    });
  }
  // viewOnce / quality / fileName only enter the hash when set, so a key
  // recorded before they existed still replays the same plain send.
  const options: Record<string, unknown>[] =
    input.viewOnce || (input.quality && input.quality !== 'source')
      ? [{ viewOnce: !!input.viewOnce, quality: input.quality || 'source' }]
      : [];
  if (input.fileName) options.push({ fileName: input.fileName });
  return createHash('sha256')
    .update(
      JSON.stringify([
        'media',
        input.conversationId,
        input.caption || null,
        input.asSticker,
        input.replyToMessageId || null,
        ...options,
      ])
    )
    .update('\0')
    .update(input.fileUrl)
    .digest('hex');
}

export function voiceRequestHash(input: {
  conversationId: string;
  audioBase64: string;
  mimeType: string;
  sourceDigest?: string;
  sourceMimeType?: string;
}): string {
  if (input.sourceDigest || input.sourceMimeType) return voiceSourceRequestHash(input);
  return createHash('sha256')
    .update(JSON.stringify(['voice', input.conversationId, input.mimeType.toLowerCase()]))
    .update('\0')
    .update(input.audioBase64)
    .digest('hex');
}

/** Polls, votes, events and event responses (fase 3 / PR-7): the validated request. */
export function structuredRequestHash(
  kind:
    | 'poll'
    | 'poll-vote'
    | 'event'
    | 'event-response'
    | 'sticker'
    | 'gif'
    | 'contact-share'
    | 'start-chat'
    | 'pin'
    | 'status',
  conversationId: string,
  request: unknown
): string {
  return sha256(JSON.stringify([kind, conversationId, request]));
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface AttemptRow {
  request_hash: string;
  message_id: string | null;
  status: 'prepared' | 'pending' | 'sent' | 'failed';
  updated_at: Date | string | null;
}

function isoOrUndefined(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/**
 * Reserve (or look up) the attempt for `key`. Never throws: any store problem
 * answers `unavailable` and the caller sends without idempotency.
 */
export async function reserveSend(
  key: string,
  requestHash: string,
  attempt = 0
): Promise<SendReservation> {
  if (tableMissingUntil > Date.now()) return { state: 'unavailable' };
  const account = connectorAccount();
  const keyHash = idempotencyKeyHash(key);
  const messageId = idempotentMessageId(key, account);
  try {
    const inserted = await getPool().query(
      `INSERT INTO whatsapp_send_attempts (account, key_hash, request_hash, message_id, status)
       VALUES ($1, $2, $3, $4, 'prepared')
       ON CONFLICT (account, key_hash) DO NOTHING
       RETURNING message_id`,
      [account, keyHash, requestHash, messageId]
    );
    noteTablePresent();
    if (inserted.rowCount) return { state: 'claimed', messageId };
    const existing = await getPool().query(
      `SELECT request_hash, message_id, status, updated_at
         FROM whatsapp_send_attempts
        WHERE account = $1 AND key_hash = $2`,
      [account, keyHash]
    );
    const row = existing.rows[0] as AttemptRow | undefined;
    // Purged between the two statements: nothing to replay, reserve afresh (once).
    if (!row) return attempt ? { state: 'unavailable' } : reserveSend(key, requestHash, 1);
    const recordedId = row.message_id || undefined;
    if (row.request_hash !== requestHash) return { state: 'conflict', messageId: recordedId };
    if (row.status === 'sent') {
      return { state: 'sent', messageId: recordedId, sentAt: isoOrUndefined(row.updated_at) };
    }
    if (row.status === 'pending') return { state: 'pending', messageId: recordedId };
    return { state: 'retry', messageId: recordedId || messageId };
  } catch (error) {
    if (isUndefinedTable(error)) {
      noteTableMissing();
      return { state: 'unavailable' };
    }
    console.warn(
      `send idempotency unavailable (${describeError(error)}): sending without Idempotency-Key`
    );
    return { state: 'unavailable' };
  }
}

/**
 * prepared|failed → pending, right before the network send. Throws
 * SendAlreadyClaimedError when another request got there first (or the row is
 * no longer retryable); a DB error propagates, so nothing is sent.
 */
export async function claimSendAttempt(key: string, requestHash: string): Promise<void> {
  const result = await getPool().query(
    `UPDATE whatsapp_send_attempts
        SET status = 'pending', error = NULL, updated_at = NOW()
      WHERE account = $1 AND key_hash = $2 AND request_hash = $3
        AND status IN ('prepared', 'failed')
      RETURNING message_id`,
    [connectorAccount(), idempotencyKeyHash(key), requestHash]
  );
  if (!result.rowCount) throw new SendAlreadyClaimedError();
}

/**
 * pending → sent with the id WhatsApp acknowledged. Returns the recorded send
 * time; never throws (the message is out — a bookkeeping failure only leaves
 * the row `pending`, which a replay reports as uncertain).
 */
export async function confirmSend(key: string, messageId: string | undefined): Promise<string> {
  try {
    const result = await getPool().query(
      `UPDATE whatsapp_send_attempts
          SET status = 'sent', message_id = COALESCE($3, message_id), error = NULL,
              updated_at = NOW()
        WHERE account = $1 AND key_hash = $2 AND status = 'pending'
        RETURNING updated_at`,
      [connectorAccount(), idempotencyKeyHash(key), messageId || null]
    );
    const sentAt = isoOrUndefined((result.rows[0] as AttemptRow | undefined)?.updated_at);
    if (sentAt) return sentAt;
    console.warn('send idempotency: attempt vanished before confirmation');
  } catch (error) {
    console.warn(`send idempotency confirm failed: ${describeError(error)}`);
  }
  return new Date().toISOString();
}

/**
 * Record a failed attempt. Before the claim nothing reached WhatsApp: the row
 * becomes `failed` (retryable). After it the outcome is unknown: the row stays
 * `pending` and only keeps the error text. Never throws.
 */
export async function recordSendFailure(
  key: string,
  claimed: boolean,
  error: unknown
): Promise<void> {
  const text = describeError(error).slice(0, 1000);
  try {
    await getPool().query(
      claimed
        ? `UPDATE whatsapp_send_attempts SET error = $3, updated_at = NOW()
            WHERE account = $1 AND key_hash = $2 AND status = 'pending'`
        : `UPDATE whatsapp_send_attempts SET status = 'failed', error = $3, updated_at = NOW()
            WHERE account = $1 AND key_hash = $2 AND status = 'prepared'`,
      [connectorAccount(), idempotencyKeyHash(key), text]
    );
  } catch (recordError) {
    console.warn(`send idempotency failure record failed: ${describeError(recordError)}`);
  }
}

export type AdapterSendReservation = SendReservation & { messageId: string };

export async function reserveTextSend(input: {
  token: string;
  conversationId: string;
  content: string;
  replyToMessageId?: string;
}): Promise<AdapterSendReservation> {
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify(['text', input.conversationId, input.content, input.replyToMessageId || null])
    )
    .digest('hex');
  return reserveAdapter(input.token, requestHash);
}

export async function reservePinSend(input: {
  token: string;
  conversationId: string;
  targetMessageId: string;
  pinned: boolean;
  duration: number;
}): Promise<AdapterSendReservation> {
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        'pin-message',
        input.conversationId,
        input.targetMessageId,
        input.pinned,
        input.duration,
      ])
    )
    .digest('hex');
  return reserveAdapter(input.token, hash);
}

export async function reserveEventResponseSend(input: {
  token: string;
  conversationId: string;
  eventMessageId: string;
  attendance: string;
  extraGuestCount: number;
}): Promise<AdapterSendReservation> {
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        'event-response',
        input.conversationId,
        input.eventMessageId,
        input.attendance,
        input.extraGuestCount,
      ])
    )
    .digest('hex');
  return reserveAdapter(input.token, hash);
}

/**
 * A created poll is identified by its whole payload: the same token reused with
 * a different question, option list or choice count is a different send, so it
 * has to conflict instead of silently replaying the first one.
 */
export async function reservePollSend(input: {
  token: string;
  conversationId: string;
  name: string;
  values: string[];
  selectableCount?: number;
}): Promise<AdapterSendReservation> {
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        'poll-creation',
        input.conversationId,
        input.name,
        input.values,
        input.selectableCount ?? null,
      ])
    )
    .digest('hex');
  return reserveAdapter(input.token, hash);
}

export async function reservePollVoteSend(input: {
  token: string;
  conversationId: string;
  pollMessageId: string;
  options: string[];
}): Promise<AdapterSendReservation> {
  const hash = createHash('sha256')
    .update(JSON.stringify(['poll-vote', input.conversationId, input.pollMessageId, input.options]))
    .digest('hex');
  return reserveAdapter(input.token, hash);
}

export async function reserveEventCreationSend(input: {
  token: string;
  conversationId: string;
  name: string;
  description?: string;
  startDate: string;
  endDate?: string;
  location?: { degreesLatitude?: number; degreesLongitude?: number; name?: string };
  call?: string;
  isCancelled?: boolean;
  extraGuestsAllowed?: boolean;
}): Promise<AdapterSendReservation> {
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        'event-creation',
        input.conversationId,
        input.name,
        input.description ?? null,
        input.startDate,
        input.endDate ?? null,
        input.location ?? null,
        input.call ?? null,
        input.isCancelled ?? null,
        input.extraGuestsAllowed ?? null,
      ])
    )
    .digest('hex');
  return reserveAdapter(input.token, hash);
}

export async function reserveMediaSend(
  input: MediaSourceInput & { token: string }
): Promise<AdapterSendReservation> {
  return reserveAdapter(input.token, mediaSourceRequestHash(input));
}

export async function reserveVoiceSend(
  input: VoiceSourceInput & { token: string }
): Promise<AdapterSendReservation> {
  return reserveAdapter(input.token, voiceSourceRequestHash(input));
}

async function reserveAdapter(key: string, requestHash: string): Promise<AdapterSendReservation> {
  const token = key.trim();
  if (!token || token.length > 200) throw new Error('Invalid sendToken');
  const reservation = await reserveSend(token, requestHash);
  return {
    ...reservation,
    sentAt: reservation.sentAt,
    messageId: reservation.messageId || idempotentMessageId(randomUUID()),
    ...(reservation.state === 'retry' ? { state: 'prepared' as const } : {}),
  };
}

/** Adapter callers reserve by key and claim by the stable message ID. */
export async function claimReservedSend(key: string, messageId: string): Promise<void> {
  const result = await getPool().query(
    `UPDATE whatsapp_send_attempts SET status = 'pending', error = NULL, updated_at = NOW()
     WHERE account = $1 AND key_hash = $2 AND message_id = $3
       AND status IN ('prepared', 'failed') RETURNING message_id`,
    [connectorAccount(), idempotencyKeyHash(key), messageId]
  );
  if (!result.rowCount) throw new SendAlreadyClaimedError();
}

export const confirmTextSend = confirmSend;

function validateSourceMetadata(input: { sourceDigest?: string; sourceMimeType?: string }): void {
  if (input.sourceDigest && !/^[a-f0-9]{64}$/i.test(input.sourceDigest))
    throw new Error('Invalid sourceDigest');
  if (
    input.sourceMimeType !== undefined &&
    (typeof input.sourceMimeType !== 'string' || !input.sourceMimeType.trim())
  )
    throw new Error('Invalid sourceMimeType');
  if (input.sourceDigest && !input.sourceMimeType)
    throw new Error('sourceMimeType is required with sourceDigest');
}

interface MediaSourceInput {
  quality?: MediaQuality;
  conversationId: string;
  fileUrl: string;
  fileName?: string;
  caption?: string;
  asSticker: boolean;
  asGif: boolean;
  replyToMessageId?: string;
  sourceDigest?: string;
  sourceMimeType?: string;
  /** Replay protection for play-once media: the same bytes replayed without
   * the flag (or vice versa) are a different message. The marker is appended
   * only when true so every pre-existing fingerprint stays byte-identical. */
  viewOnce?: boolean;
}

export function mediaSourceRequestHash(input: MediaSourceInput): string {
  validateSourceMetadata(input);
  const quality = parseMediaQuality(input.quality);
  const dataHeader = input.fileUrl.match(/^data:([^,]*),/i)?.[1];
  const outputMimeType =
    dataHeader
      ?.replace(/;base64$/i, '')
      .trim()
      .toLowerCase() || null;
  const sourceMimeType = input.sourceMimeType?.trim().toLowerCase() || outputMimeType;
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify([
        'media',
        input.conversationId,
        input.fileName || null,
        input.caption || null,
        input.asSticker,
        input.asGif,
        input.replyToMessageId || null,
        outputMimeType,
        sourceMimeType,
        // Preserve existing source reservations across upgrades.
        ...(quality === 'source' ? [] : [quality]),
        ...(input.viewOnce === true ? ['viewOnce'] : []),
      ])
    )
    .update('\0')
    .update(input.sourceDigest || input.fileUrl)
    .digest('hex');
  return requestHash;
}

interface VoiceSourceInput {
  conversationId: string;
  audioBase64: string;
  mimeType: string;
  sourceDigest?: string;
  sourceMimeType?: string;
}

export function voiceSourceRequestHash(input: VoiceSourceInput): string {
  validateSourceMetadata(input);
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify([
        'voice',
        input.conversationId,
        input.mimeType.toLowerCase(),
        input.sourceMimeType?.trim().toLowerCase() || input.mimeType.toLowerCase(),
      ])
    )
    .update('\0')
    .update(input.sourceDigest || input.audioBase64)
    .digest('hex');
  return requestHash;
}
