/**
 * Opt-in send idempotency of the Telegram connector (DGX-1235 B2 (i), contract
 * http.telegram-connector.send-idempotency.v1), ported from
 * connectors/whatsapp-web/src/send-idempotency.ts (text sends only; not
 * extracted to shared in this PR).
 *
 * Only an explicit key turns it on: header `Idempotency-Key` and/or body field
 * `idempotencyKey`. Without one the send routes behave exactly as before and
 * nothing here runs. With a key, one row of `telegram_send_attempts` (mcp-server
 * migration 040) per (account, sha256(key)):
 *
 *   prepared ──claim (just before the network send)──▶ pending ──▶ sent
 *      │                                                 │
 *      └─ failed (Telegram refused it: safe to retry)    └─ stays pending when
 *                                                           the outcome is unknown
 *
 *  - same key + same request   → the recorded outcome, deduplicated: true;
 *  - same key + other request  → 409 idempotency_key_reused;
 *  - a row left in `pending`   → 409 send_outcome_uncertain, never resent;
 *  - store unreachable         → 503 idempotency_unavailable, NOT sent.
 *
 * The last line is the difference with WhatsApp on purpose: for «once» a send
 * without idempotency is not acceptable, so a keyed send fails closed.
 *
 * The random_id handed to mtcute is derived from (account, key) — measured:
 * sendText takes `randomId` (mtcute 0.29) and Telegram rejects a reused one with
 * RANDOM_ID_DUPLICATE — so the retry of a `failed` attempt asks Telegram for the
 * same message, and a duplicate cannot be created even by a race. The raw key is
 * never stored.
 */
import { createHash } from 'node:crypto';
import { Long } from '@mtcute/node';
import { getPool } from './db-pool';

export { readIdempotencyKey } from '@mcp-socialmedia/shared';

export interface TextSend {
  chatId: string;
  text: string;
  topicId?: number;
  replyTo?: number;
}

export interface SendOutcome {
  status: number;
  body: Record<string, unknown>;
}

type Reservation =
  | { state: 'claimed' | 'retry' }
  | { state: 'sent'; messageId?: string; sentAt?: string }
  | { state: 'pending'; messageId?: string }
  | { state: 'conflict' };

/** The attempt was claimed by someone else between reserve and send. */
export class SendAlreadyClaimedError extends Error {
  constructor() {
    super('Send attempt already claimed or completed');
    this.name = 'SendAlreadyClaimedError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function account(): string {
  return process.env.CONNECTOR_ACCOUNT || 'personal';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function textRequestHash(input: TextSend): string {
  return sha256(
    JSON.stringify(['text', input.chatId, input.text, input.topicId ?? null, input.replyTo ?? null])
  );
}

/** The random_id of the message for (account, key): the first 8 bytes of a sha256, signed. */
export function idempotentRandomId(key: string, acct: string = account()): Long {
  const bytes = createHash('sha256')
    .update(JSON.stringify([acct, key]))
    .digest()
    .subarray(0, 8);
  return Long.fromBytesBE([...bytes], false);
}

function isoOrUndefined(value: unknown): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** Reserve (or look up) the attempt for `key`. Any store problem throws: the caller answers 503. */
async function reserveSend(key: string, requestHash: string, attempt = 0): Promise<Reservation> {
  const acct = account();
  const keyHash = sha256(key);
  const pool = getPool();
  const inserted = await pool.query(
    `INSERT INTO telegram_send_attempts (account, key_hash, request_hash, status)
     VALUES ($1, $2, $3, 'prepared')
     ON CONFLICT (account, key_hash) DO NOTHING
     RETURNING key_hash`,
    [acct, keyHash, requestHash]
  );
  if (inserted.rowCount) return { state: 'claimed' };
  const existing = await pool.query(
    `SELECT request_hash, message_id, status, updated_at
       FROM telegram_send_attempts
      WHERE account = $1 AND key_hash = $2`,
    [acct, keyHash]
  );
  const row = existing.rows[0] as
    | { request_hash: string; message_id: string | null; status: string; updated_at: unknown }
    | undefined;
  if (!row) {
    if (attempt) throw new Error('send attempt vanished twice');
    return reserveSend(key, requestHash, 1);
  }
  const messageId = row.message_id || undefined;
  if (row.request_hash !== requestHash) return { state: 'conflict' };
  if (row.status === 'sent')
    return { state: 'sent', messageId, sentAt: isoOrUndefined(row.updated_at) };
  if (row.status === 'pending') return { state: 'pending', messageId };
  return { state: 'retry' };
}

/** prepared|failed → pending, right before the network send. */
async function claimSendAttempt(key: string, requestHash: string): Promise<void> {
  const result = await getPool().query(
    `UPDATE telegram_send_attempts
        SET status = 'pending', error = NULL, updated_at = NOW()
      WHERE account = $1 AND key_hash = $2 AND request_hash = $3
        AND status IN ('prepared', 'failed')
      RETURNING key_hash`,
    [account(), sha256(key), requestHash]
  );
  if (!result.rowCount) throw new SendAlreadyClaimedError();
}

/** pending → sent. Never throws: the message is out; a failure leaves it pending (uncertain). */
async function confirmSend(key: string, messageId: string | null): Promise<string> {
  try {
    const result = await getPool().query(
      `UPDATE telegram_send_attempts
          SET status = 'sent', message_id = $3, error = NULL, updated_at = NOW()
        WHERE account = $1 AND key_hash = $2 AND status = 'pending'
        RETURNING updated_at`,
      [account(), sha256(key), messageId]
    );
    const sentAt = isoOrUndefined(result.rows[0]?.updated_at);
    if (sentAt) return sentAt;
    console.warn('telegram send idempotency: attempt vanished before confirmation');
  } catch (error) {
    console.warn(`telegram send idempotency confirm failed: ${describeError(error)}`);
  }
  return new Date().toISOString();
}

/**
 * Whether Telegram answered the send with an RPC error that means it did not
 * take it (4xx, FLOOD_WAIT 420). A timeout, a dropped connection, a 5xx or
 * RANDOM_ID_DUPLICATE (it already has it) leave the outcome unknown.
 */
function refusedByTelegram(error: unknown): boolean {
  const e = error as { code?: unknown; text?: unknown } | null;
  return (
    !!e &&
    typeof e.code === 'number' &&
    e.code >= 400 &&
    e.code < 500 &&
    typeof e.text === 'string' &&
    e.text !== 'RANDOM_ID_DUPLICATE'
  );
}

/** Record a failed send: `failed` (retryable) if Telegram refused it, otherwise it stays pending. Never throws. */
async function recordSendFailure(key: string, error: unknown): Promise<void> {
  const text = describeError(error).slice(0, 1000);
  try {
    await getPool().query(
      refusedByTelegram(error)
        ? `UPDATE telegram_send_attempts SET status = 'failed', error = $3, updated_at = NOW()
            WHERE account = $1 AND key_hash = $2 AND status = 'pending'`
        : `UPDATE telegram_send_attempts SET error = $3, updated_at = NOW()
            WHERE account = $1 AND key_hash = $2 AND status = 'pending'`,
      [account(), sha256(key), text]
    );
  } catch (recordError) {
    console.warn(`telegram send idempotency failure record failed: ${describeError(recordError)}`);
  }
}

const UNAVAILABLE: SendOutcome = {
  status: 503,
  body: {
    error: 'The idempotency store is unavailable; nothing was sent',
    failureClass: 'idempotency_unavailable',
  },
};

function uncertain(messageId?: string): SendOutcome {
  return {
    status: 409,
    body: {
      error:
        'The outcome of an earlier send with this Idempotency-Key is unknown; check the chat before sending again',
      failureClass: 'send_outcome_uncertain',
      ...(messageId ? { messageId } : {}),
    },
  };
}

/**
 * One keyed text send, start to end. `send` does the network send with the
 * derived random_id and returns Telegram's message id; its errors propagate
 * (after the bookkeeping) so the route maps them as it always did.
 */
export async function sendOnce(
  key: string,
  input: TextSend,
  send: (randomId: Long) => Promise<string | null>
): Promise<SendOutcome> {
  const requestHash = textRequestHash(input);
  let reservation: Reservation;
  try {
    reservation = await reserveSend(key, requestHash);
  } catch (error) {
    console.warn(`telegram send idempotency unavailable: ${describeError(error)}`);
    return UNAVAILABLE;
  }
  switch (reservation.state) {
    case 'conflict':
      return {
        status: 409,
        body: {
          error: 'Idempotency-Key was already used for a different request',
          failureClass: 'idempotency_key_reused',
        },
      };
    case 'pending':
      return uncertain(reservation.messageId);
    case 'sent':
      return {
        status: 200,
        body: {
          success: true,
          messageId: reservation.messageId ?? null,
          sentAt: reservation.sentAt,
          deduplicated: true,
        },
      };
  }
  try {
    await claimSendAttempt(key, requestHash);
  } catch (error) {
    if (error instanceof SendAlreadyClaimedError) return uncertain();
    console.warn(`telegram send idempotency claim failed: ${describeError(error)}`);
    return UNAVAILABLE;
  }
  let messageId: string | null;
  try {
    messageId = await send(idempotentRandomId(key));
  } catch (error) {
    await recordSendFailure(key, error);
    throw error;
  }
  const sentAt = await confirmSend(key, messageId);
  return { status: 200, body: { success: true, messageId, sentAt, deduplicated: false } };
}
