/**
 * WhatsApp disappearing messages (fase 3 / PR-8, mcp-server migration 014):
 * the timer of a chat. Ported from the NAS fork (setDisappearing,
 * getDisappearing) and adapted to prod.
 *
 * Only WhatsApp's own durations exist: off, 24 h, 7 d, 90 d (0, 86400,
 * 604800, 7776000 s). Anything else is 400 before WhatsApp.
 *
 * Where the timer of a chat is known from:
 *  - a group: its fresh metadata (ephemeralDuration) — nothing to store;
 *  - a direct chat: WhatsApp has no query for it. The connector learns it from
 *    what goes through the socket — the timer change of either side (an
 *    EPHEMERAL_SETTING protocol message, which Baileys turns into a
 *    chats.update {ephemeralExpiration, ephemeralSettingTimestamp}), the
 *    history-sync / chats.upsert snapshot of the chat, and our own change —
 *    and keeps it on the CANONICAL conversation row (014):
 *      ephemeral_expiration  — seconds, 0 = off, NULL = never learnt;
 *      ephemeral_setting_at  — when it was set (WhatsApp's time when it said).
 *    An older value (by ephemeral_setting_at) never replaces a newer one.
 *  The USync disappearing_mode of a contact (what the fork read) is THEIR
 *  default for new chats, not this chat's timer: reported apart as
 *  `contactDefault`, never as the chat's.
 *
 * Same rules as chat-state.ts: the columns come from the migration (while
 * they are missing, 42703, nothing is recorded, a log, re-probe every few
 * minutes); only a client with `ingest` calls the writers.
 */
import { getPool, accountKey } from './db-writer';
import { resolveCanonicalConversation } from './chat-state';
import { MessageMutationError, whatsappAccountId } from './message-mutations';

/** off, 24 h, 7 d, 90 d — the only timers WhatsApp offers. */
export const DISAPPEARING_DURATIONS = [0, 86_400, 604_800, 7_776_000] as const;

const LABELS: Record<string, number> = {
  off: 0,
  '0': 0,
  '24h': 86_400,
  '1d': 86_400,
  '7d': 604_800,
  '90d': 7_776_000,
};

const UNDEFINED_COLUMN = '42703';
const MISSING_COLUMNS_RECHECK_MS = 5 * 60 * 1000;

let columnsMissingUntil = 0;
let missingColumnsLogged = false;

/** Test hook: forget the "columns missing" state between cases. */
export function resetDisappearingStateForTests(): void {
  columnsMissingUntil = 0;
  missingColumnsLogged = false;
}

function pgCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function columnsKnownMissing(): boolean {
  return columnsMissingUntil > Date.now();
}

function noteColumnsMissing(): void {
  columnsMissingUntil = Date.now() + MISSING_COLUMNS_RECHECK_MS;
  if (!missingColumnsLogged) {
    missingColumnsLogged = true;
    console.warn(
      'conversations.ephemeral_expiration / ephemeral_setting_at do not exist yet (mcp-server ' +
        'migration 014 not applied): disappearing timers go to WhatsApp but are not recorded'
    );
  }
}

function noteColumnsPresent(): void {
  if (missingColumnsLogged) {
    missingColumnsLogged = false;
    console.info('conversations ephemeral columns are available: disappearing timers are recorded');
  }
  columnsMissingUntil = 0;
}

/** Human label of a timer (off / 24h / 7d / 90d, else `<n>s`). */
export function disappearingLabel(seconds: number | null): string | null {
  if (seconds === null) return null;
  switch (seconds) {
    case 0:
      return 'off';
    case 86_400:
      return '24h';
    case 604_800:
      return '7d';
    case 7_776_000:
      return '90d';
    default:
      return `${seconds}s`;
  }
}

/**
 * A timer of a request: one of the four durations in seconds, or its label
 * ('off', '24h', '7d', '90d'); `false` = off. 400 otherwise (no rounding: a
 * 3-day timer is not silently turned into 7).
 */
export function parseDisappearingExpiration(value: unknown): number {
  if (value === false) return 0;
  let seconds: number | undefined;
  if (typeof value === 'number') seconds = value;
  else if (typeof value === 'string' && value.trim()) {
    const text = value.trim().toLowerCase();
    seconds = Object.prototype.hasOwnProperty.call(LABELS, text) ? LABELS[text] : Number(text);
  }
  if (
    seconds === undefined ||
    !Number.isInteger(seconds) ||
    !(DISAPPEARING_DURATIONS as readonly number[]).includes(seconds)
  ) {
    throw new MessageMutationError(
      'expiration must be 0 (off), 86400 (24h), 604800 (7d) or 7776000 (90d)',
      400,
      'invalid_request'
    );
  }
  return seconds;
}

export interface EphemeralSetting {
  /** Seconds; 0 = off. */
  expiration: number;
  /** When it was set, when WhatsApp said. */
  setAt: Date | null;
}

function numeric(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  const long = value as { toNumber?: () => number; low?: number; high?: number };
  if (typeof long.toNumber === 'function') return numeric(long.toNumber());
  if (typeof long.low === 'number') return (long.high || 0) * 2 ** 32 + (long.low >>> 0);
  return undefined;
}

/**
 * Timer of a Baileys chat object. A chats.update from a timer change carries
 * `ephemeralExpiration` (null = turned off) with its timestamp; a snapshot
 * (history / chats.upsert) carries it only when set. undefined = says nothing.
 */
export function ephemeralFromBaileys(
  chat: unknown,
  source: 'change' | 'snapshot'
): EphemeralSetting | undefined {
  if (!chat || typeof chat !== 'object' || !('ephemeralExpiration' in chat)) return undefined;
  const raw = (chat as { ephemeralExpiration?: unknown }).ephemeralExpiration;
  let expiration = numeric(raw);
  if (expiration === undefined) {
    if ((raw === null || raw === undefined) && source === 'change') expiration = 0;
    else return undefined;
  }
  if (expiration < 0) return undefined;
  const ts = numeric((chat as { ephemeralSettingTimestamp?: unknown }).ephemeralSettingTimestamp);
  const setAt = ts && ts > 0 ? new Date(ts < 1e11 ? ts * 1000 : ts) : null;
  return { expiration: Math.floor(expiration), setAt };
}

/**
 * Timer of a group from its metadata: Baileys reads the `<ephemeral
 * expiration>` child, absent = off.
 */
export function groupEphemeral(meta: { ephemeralDuration?: unknown }): number {
  const n = numeric(meta.ephemeralDuration);
  return n && n > 0 ? Math.floor(n) : 0;
}

/**
 * The stored timer of a canonical conversation. undefined = no row / never
 * learnt; null = the 014 columns are missing (unknown, not an error).
 */
export async function readConversationEphemeral(
  conversationId: string
): Promise<EphemeralSetting | undefined | null> {
  if (columnsKnownMissing()) return null;
  try {
    const result = await getPool().query(
      `SELECT ephemeral_expiration, ephemeral_setting_at FROM conversations
        WHERE id = $1 AND account_id = $2`,
      [accountKey(conversationId), whatsappAccountId()]
    );
    noteColumnsPresent();
    const row = result.rows[0];
    if (!row || row.ephemeral_expiration === null || row.ephemeral_expiration === undefined) {
      return undefined;
    }
    const setAt = row.ephemeral_setting_at ? new Date(row.ephemeral_setting_at) : null;
    return {
      expiration: Number(row.ephemeral_expiration),
      setAt: setAt && Number.isFinite(setAt.getTime()) ? setAt : null,
    };
  } catch (error) {
    if (pgCode(error) !== UNDEFINED_COLUMN) throw error;
    noteColumnsMissing();
    return null;
  }
}

/**
 * Record a timer on the canonical conversation row `conversationId`. A value
 * with a time older than the stored one is ignored; a value without a time
 * (a snapshot) only fills a timer never learnt. Returns whether the row
 * changed. Throws only on unexpected DB errors.
 */
export async function writeConversationEphemeral(
  conversationId: string,
  setting: EphemeralSetting
): Promise<boolean> {
  if (columnsKnownMissing()) return false;
  try {
    const result = await getPool().query(
      `UPDATE conversations
          SET ephemeral_expiration = $3,
              ephemeral_setting_at = COALESCE($4::timestamptz, ephemeral_setting_at),
              updated_at = now()
        WHERE id = $1 AND account_id = $2 AND merged_into IS NULL
          AND (ephemeral_expiration IS DISTINCT FROM $3
               OR ($4::timestamptz IS NOT NULL
                   AND ephemeral_setting_at IS DISTINCT FROM $4::timestamptz))
          AND (ephemeral_expiration IS NULL
               OR ($4::timestamptz IS NOT NULL
                   AND (ephemeral_setting_at IS NULL OR ephemeral_setting_at <= $4::timestamptz)))`,
      [accountKey(conversationId), whatsappAccountId(), setting.expiration, setting.setAt]
    );
    noteColumnsPresent();
    return (result.rowCount || 0) > 0;
  } catch (error) {
    if (pgCode(error) !== UNDEFINED_COLUMN) throw error;
    noteColumnsMissing();
    return false;
  }
}

/**
 * A timer WhatsApp told us about (chats.update / chats.upsert / history):
 * resolve the canonical conversation of `jid` and record it there. Never
 * throws; returns whether a row changed.
 */
export async function recordInboundEphemeral(
  jid: string,
  setting: EphemeralSetting | undefined
): Promise<boolean> {
  if (!setting || columnsKnownMissing()) return false;
  try {
    const conversation = await resolveCanonicalConversation(jid);
    if (!conversation) return false;
    return await writeConversationEphemeral(conversation.id, setting);
  } catch (error) {
    console.warn(`disappearing timer persist failed for ${jid}: ${describeError(error)}`);
    return false;
  }
}
