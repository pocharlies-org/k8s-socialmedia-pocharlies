import { MissingTableBackoff } from './missing-table-backoff';
import { describeError } from './error-text';
/**
 * WhatsApp message reactions (fase 3 / PR-4, ported from the NAS fork's
 * storeMessageReaction and adapted to the multiaccount model) — the DB side.
 *
 * One current reaction per (account, target message, reactor) in
 * `whatsapp_message_reactions` (mcp-server migration 011): a new emoji
 * replaces the old one, an empty emoji marks it `removed` and keeps the last
 * emoji, nothing is deleted. The connector records inbound reactions,
 * reactions made on our phone and the ones it sends itself. This is IN
 * ADDITION to the REACTION messages it keeps ingesting, which prod folds into
 * `messages.reactions` (what dgx-messages shows today).
 *
 * Rules (same as durable-message-store.ts):
 *  - ids use the SAME namespacing as `messages` (accountKey): the target joins
 *    to messages.wa_message_id, the reactor to participants.id; the DB files a
 *    phone-jid reactor under its LID when social_contact_aliases knows it;
 *  - the table is created by the migration, never here. While it is missing
 *    every write fails soft: 42P01 is logged once and the caller carries on
 *    (the REACTION message is still ingested, the reaction is still sent).
 *    The table is re-probed every few minutes, so no restart is needed once
 *    the migration lands;
 *  - a replayed older reaction (history sync) never overwrites a newer one:
 *    the upsert only applies when its WhatsApp time is not older.
 *
 * The caller (BaileysClient) only calls in here when `ingest` is on: the
 * per-sub pairing pool (ingest off) never touches this table.
 */
import { accountKey, connectorAccount, getPool } from './db-writer';

const UNDEFINED_TABLE = '42P01';
const MISSING_TABLE_RECHECK_MS = 5 * 60 * 1000;

export interface MessageReactionInput {
  /** Reacted message, bare or namespaced WhatsApp id. */
  targetMessageId: string;
  /** Bare, normalised chat id (the one messages.conversation_id uses). */
  conversationId: string;
  /** Bare, normalised jid of who reacted (this account's own jid for ours). */
  reactorJid: string;
  /** '' (or blank) = the reaction was removed. */
  emoji: string;
  /**
   * Whether this account reacted: true for ours (sent here or from our phone),
   * false for a contact, undefined/null when the key never said — stored as
   * NULL and never overwriting a side already known.
   */
  fromMe?: boolean | null;
  /** Id of the reaction message itself. */
  reactionMessageId?: string;
  /** WhatsApp time of the reaction; orders out-of-order replays. */
  reactedAt?: Date;
}

const tableBackoff = new MissingTableBackoff(
  MISSING_TABLE_RECHECK_MS,
  'whatsapp_message_reactions does not exist yet (mcp-server migration 011 not applied): ' +
    'reactions only reach messages.reactions, as before',
  'whatsapp_message_reactions is available: reactions are recorded'
);

/** Test hook: forget the "table missing" state between cases. */
export function resetReactionStoreStateForTests(): void {
  tableBackoff.reset();
}

/**
 * The WhatsApp time of a reaction: the reaction's own senderTimestampMs when
 * present (ms, number | Long | string), else the message timestamp (seconds).
 */
export function reactionTime(
  senderTimestampMs: unknown,
  messageTimestampSeconds?: number
): Date | undefined {
  const ms = toNumber(senderTimestampMs);
  if (ms && ms > 0) return new Date(ms);
  if (messageTimestampSeconds && messageTimestampSeconds > 0) {
    return new Date(messageTimestampSeconds * 1000);
  }
  return undefined;
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

/**
 * Record the current reaction of `reactorJid` to a message. Never throws:
 * returns whether the row was written (false when the table is missing, the
 * input is incomplete or the DB failed — logged).
 */
export async function storeMessageReaction(input: MessageReactionInput): Promise<boolean> {
  const target = String(input.targetMessageId || '').trim();
  const reactor = String(input.reactorJid || '').trim();
  const conversation = String(input.conversationId || '').trim();
  if (!target || !reactor || !conversation) return false;
  if (tableBackoff.isMissing()) return false;
  const emoji = typeof input.emoji === 'string' ? input.emoji.trim() : '';
  try {
    // On the right-hand side of SET the table name is the row already stored.
    await getPool().query(
      `INSERT INTO whatsapp_message_reactions
         (account, target_wa_message_id, reactor_jid, conversation_id, reaction_wa_message_id,
          emoji, removed, from_me, reacted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (account, target_wa_message_id, reactor_jid) DO UPDATE SET
         reactor_seen_jid = EXCLUDED.reactor_seen_jid,
         reaction_wa_message_id = COALESCE(EXCLUDED.reaction_wa_message_id,
                                           whatsapp_message_reactions.reaction_wa_message_id),
         emoji = CASE WHEN EXCLUDED.removed THEN whatsapp_message_reactions.emoji
                      ELSE EXCLUDED.emoji END,
         removed = EXCLUDED.removed,
         from_me = COALESCE(EXCLUDED.from_me, whatsapp_message_reactions.from_me),
         reacted_at = COALESCE(EXCLUDED.reacted_at, whatsapp_message_reactions.reacted_at),
         updated_at = now()
       WHERE EXCLUDED.reacted_at IS NULL OR whatsapp_message_reactions.reacted_at IS NULL
          OR EXCLUDED.reacted_at >= whatsapp_message_reactions.reacted_at`,
      [
        connectorAccount(),
        accountKey(target),
        accountKey(reactor),
        accountKey(conversation),
        input.reactionMessageId ? accountKey(input.reactionMessageId) : null,
        emoji || null,
        !emoji,
        input.fromMe ?? null,
        input.reactedAt || null,
      ]
    );
    tableBackoff.markPresent();
    return true;
  } catch (error) {
    if ((error as { code?: string } | null)?.code === UNDEFINED_TABLE) {
      tableBackoff.markMissing();
      return false;
    }
    console.warn(`reaction store failed for ${target}: ${describeError(error)}`);
    return false;
  }
}
