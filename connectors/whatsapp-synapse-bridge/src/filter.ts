import { MessageReceivedEvent } from '@mcp-socialmedia/shared';

/**
 * FAIL-CLOSED forwarding filter for the WhatsApp -> synapse bridge.
 *
 * This bridge is intentionally fail-CLOSED: when ANYTHING is uncertain we DROP.
 * We only forward a message when every gate explicitly passes.
 *
 * F0.5 exception (docs/48 in synapse): a message that is OUR OWN outbound on
 * the professional account (operator replying from the linked phone) passes
 * the same gates and is forwarded FLAGGED `fromMe: true` instead of dropped —
 * synapse needs it as a "team touch". Uncertainty still drops (own JID
 * unknown => drop everything).
 */

export interface FilterResult {
  forward: boolean;
  /** Machine-readable reason; safe to log (never contains PII). */
  reason: string;
  /**
   * True when the forwarded message is the account's OWN outbound (operator
   * replying from the linked phone) — a team touch, not customer inbound
   * (F0.5). Only ever set on `forward: true` results; the caller must stamp
   * `fromMe: true` on the outgoing event so downstream never has to re-derive
   * ownership from JIDs.
   */
  fromMe?: boolean;
}

/**
 * 1:1 user JID suffixes that are ALLOWED to forward (locked decision):
 *   @s.whatsapp.net  raw Baileys phone-number jid
 *   @c.us            legacy phone-number jid (what the connector normalizes to)
 *   @lid             opaque privacy id for a 1:1 chat
 * Everything else (groups, broadcasts, newsletters, status) is dropped.
 */
const ALLOWED_1TO1_SUFFIXES = ['@s.whatsapp.net', '@c.us', '@lid'] as const;

/** Multi-party / non-personal endpoints we always drop. */
const GROUP_LIKE_SUFFIXES = ['@g.us', '@broadcast', '@newsletter'] as const;
const STATUS_BROADCAST = 'status@broadcast';

/**
 * Normalize a WhatsApp JID for own-identity comparison.
 *
 * Mirrors the connector's normalizeJid (`@s.whatsapp.net` -> `@c.us`, `@lid`
 * kept as-is) and ADDITIONALLY strips the `:device` suffix from the user part
 * (e.g. `34600:3@c.us` -> `34600@c.us`). The connector's getMe() runs the raw
 * `sock.user.id` through normalizeJid only, so the cached own-JID may still
 * carry a device suffix; senderWaId is likewise device-bearing in some events.
 * Normalizing both sides the same way makes the own-JID compare robust against
 * a reply-to-self loop. Pure / side-effect free.
 */
export function normalizeJid(jid: string | null | undefined): string {
  if (!jid || typeof jid !== 'string') return '';
  let value = jid.trim();
  if (!value) return '';
  if (value.endsWith('@s.whatsapp.net')) {
    value = value.replace('@s.whatsapp.net', '@c.us');
  }
  const at = value.indexOf('@');
  if (at <= 0) return value;
  let user = value.slice(0, at);
  const domain = value.slice(at); // includes '@'
  const colon = user.indexOf(':'); // device suffix like ':3'
  if (colon > 0) user = user.slice(0, colon);
  return `${user}${domain}`;
}

function hasSuffix(jid: string, suffixes: readonly string[]): boolean {
  return suffixes.some(s => jid.endsWith(s));
}

/**
 * Decide whether an inbound MessageReceivedEvent should be forwarded to the
 * synapse gateway. `ownJid` is the bridge account's own JID (from /me); when it
 * is empty the caller MUST treat that as fail-closed BEFORE calling this (we
 * still guard here for safety).
 *
 * Order matters: cheapest/most-decisive drops first.
 */
export function shouldForward(
  event: MessageReceivedEvent,
  ownJid: string,
  dedup: { has(key: string): boolean }
): FilterResult {
  // 0. Sanity: malformed event => drop.
  if (!event || typeof event !== 'object') {
    return { forward: false, reason: 'malformed-event' };
  }

  // 1. Account gate: only the configured account (professional) is ever bridged.
  //    account defaults to 'personal' upstream; an undefined account is NOT
  //    professional, so it drops here (fail-closed).
  if (event.account !== 'professional') {
    return { forward: false, reason: 'account-not-professional' };
  }

  const conversationId = (event.conversationId || '').trim();
  if (!conversationId) {
    return { forward: false, reason: 'missing-conversation-id' };
  }

  // 2. Status / broadcast / group / newsletter => drop.
  if (conversationId === STATUS_BROADCAST) {
    return { forward: false, reason: 'status-broadcast' };
  }
  if (hasSuffix(conversationId, GROUP_LIKE_SUFFIXES)) {
    return { forward: false, reason: 'group-or-broadcast-or-newsletter' };
  }

  // 3. 1:1 ALLOWLIST: the conversation must end in an allowed personal suffix.
  //    Anything not explicitly allowlisted is dropped (fail-closed).
  if (!hasSuffix(conversationId, ALLOWED_1TO1_SUFFIXES)) {
    return { forward: false, reason: 'not-1to1-allowlisted' };
  }

  // 4. waMessageId required (idempotency key for gateway + dedup).
  const waMessageId = (event.waMessageId || '').trim();
  if (!waMessageId) {
    return { forward: false, reason: 'missing-wa-message-id' };
  }

  // 5. Own-message detection (F0.5: team touch). Two independent signals —
  //    the explicit connector flag (`event.fromMe`) and sender == own JID.
  //    Since F0.5 an own message on the professional account is FORWARDED
  //    flagged `fromMe: true` (the operator answering from the phone is a
  //    team touch synapse must see), no longer silently dropped. Detection
  //    itself stays fail-closed: when the own JID is unknown we cannot rule
  //    out a self-message, so we keep dropping EVERYTHING (pre-existing
  //    degraded-mode behavior until the connector's /me succeeds).
  if (!ownJid) {
    return { forward: false, reason: 'own-jid-unknown' };
  }
  const sender = normalizeJid(event.senderWaId);
  if (!sender) {
    return { forward: false, reason: 'missing-sender' };
  }
  const fromMe = event.fromMe === true || sender === normalizeJid(ownJid);

  // 6. Dedup: already-seen waMessageId => drop. Applies to fromMe messages
  //    too (a re-published operator reply must not double-count as two team
  //    touches downstream).
  if (dedup.has(waMessageId)) {
    return { forward: false, reason: 'duplicate' };
  }

  if (fromMe) {
    return { forward: true, reason: 'forward-from-me', fromMe: true };
  }
  return { forward: true, reason: 'forward' };
}
