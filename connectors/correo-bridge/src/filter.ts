import { JSONCodec } from 'nats';
import type { MessageReceivedEvent, TelegramMessageReceivedEvent } from '@mcp-socialmedia/shared';
import { trackingOptInBaseUrl, Canal } from './config';
import { cuerpoTelegram, cuerpoWhatsapp, MensajeCanal } from './cuerpo';

/**
 * FAIL-CLOSED filter of correo-bridge (DGX-1235 B1.2/B1.3). The WhatsApp gates
 * are copied from whatsapp-synapse-bridge/src/filter.ts (same order, same
 * reasons); Telegram gets the equivalent ones. When anything is uncertain we
 * DROP. An own outbound message passes, as `saliente`.
 */

// CONTRACT: nats.correo-bridge.whatsapp-message-received.v1
export const SUBJECT_WHATSAPP = 'whatsapp.MessageReceived';
// CONTRACT: nats.correo-bridge.telegram-message-received.v1
export const SUBJECT_TELEGRAM = 'telegram.MessageReceived';

export type Resultado =
  | { forward: true; reason: string; canal: Canal; cuerpo: MensajeCanal }
  /** `reason` is machine-readable and safe to log (never PII). */
  | { forward: false; reason: string };

const ALLOWED_1TO1_SUFFIXES = ['@s.whatsapp.net', '@c.us', '@lid'] as const;
const GROUP_LIKE_SUFFIXES = ['@g.us', '@broadcast', '@newsletter'] as const;
const STATUS_BROADCAST = 'status@broadcast';
const TRACKING_OPT_IN_PREFIX =
  'hola skirmshop, quiero recibir seguimiento por whatsapp del pedido ';
const TRACKING_OPT_IN_ORDER_RE = /\bord\d{3,}\b/i;

const codec = JSONCodec<unknown>();

/** Own-identity comparison form (see whatsapp-synapse-bridge normalizeJid). */
export function normalizeJid(jid: string | null | undefined): string {
  if (!jid || typeof jid !== 'string') return '';
  let value = jid.trim();
  if (!value) return '';
  if (value.endsWith('@s.whatsapp.net')) value = value.replace('@s.whatsapp.net', '@c.us');
  const at = value.indexOf('@');
  if (at <= 0) return value;
  let user = value.slice(0, at);
  const colon = user.indexOf(':');
  if (colon > 0) user = user.slice(0, colon);
  return `${user}${value.slice(at)}`;
}

function hasSuffix(jid: string, suffixes: readonly string[]): boolean {
  return suffixes.some(s => jid.endsWith(s));
}

function isTrackingOptInControlMessage(content: string | null | undefined): boolean {
  if (!content || typeof content !== 'string') return false;
  const trackingBase = trackingOptInBaseUrl();
  if (!trackingBase) return false;
  const text = content.trim().toLowerCase();
  return (
    text.startsWith(TRACKING_OPT_IN_PREFIX) &&
    TRACKING_OPT_IN_ORDER_RE.test(text) &&
    text.includes(trackingBase.toLowerCase())
  );
}

const drop = (reason: string): Resultado => ({ forward: false, reason });

function desdeCuerpo(canal: Canal, r: { cuerpo: MensajeCanal } | { motivo: string }): Resultado {
  return 'cuerpo' in r ? { forward: true, reason: `forward-${r.cuerpo.direccion}`, canal, cuerpo: r.cuerpo } : drop(r.motivo);
}

function whatsapp(event: MessageReceivedEvent, ownJid: string, dedup: { has(key: string): boolean }): Resultado {
  if (event.account !== 'professional') return drop('account-not-professional');
  const conversationId = (event.conversationId || '').trim();
  if (!conversationId) return drop('missing-conversation-id');
  if (conversationId === STATUS_BROADCAST) return drop('status-broadcast');
  if (hasSuffix(conversationId, GROUP_LIKE_SUFFIXES)) return drop('group-or-broadcast-or-newsletter');
  if (!hasSuffix(conversationId, ALLOWED_1TO1_SUFFIXES)) return drop('not-1to1-allowlisted');
  const waMessageId = (event.waMessageId || '').trim();
  if (!waMessageId) return drop('missing-wa-message-id');
  // Own JID unknown => cannot tell entrante from saliente => drop everything.
  if (!ownJid) return drop('own-jid-unknown');
  const sender = normalizeJid(event.senderWaId);
  if (!sender) return drop('missing-sender');
  const fromMe = event.fromMe === true || sender === normalizeJid(ownJid);
  if (dedup.has(waMessageId)) return drop('duplicate');
  if (!fromMe && isTrackingOptInControlMessage(event.content)) return drop('tracking-opt-in-control-message');
  return desdeCuerpo('whatsapp', cuerpoWhatsapp(event, fromMe ? 'saliente' : 'entrante'));
}

function telegram(event: TelegramMessageReceivedEvent, dedup: { has(key: string): boolean }): Resultado {
  if (event.account !== 'professional') return drop('account-not-professional');
  if (!(event.conversationId || '').trim()) return drop('missing-conversation-id');
  if (event.chatType !== 'private') return drop('chat-not-private');
  const id = (event.telegramMessageId || '').trim();
  if (!id) return drop('missing-telegram-message-id');
  if (!(event.senderTelegramId || '').trim()) return drop('missing-sender');
  if (dedup.has(`tg:${id}`)) return drop('duplicate');
  return desdeCuerpo('telegram', cuerpoTelegram(event, event.isOutbound === true ? 'saliente' : 'entrante'));
}

/** One NATS message, start to end: decode, filter, canonical body. Pure but for the dedup. */
export function procesar(subject: string, data: Uint8Array, ownJid: string, dedup: { has(key: string): boolean }): Resultado {
  if (subject !== SUBJECT_WHATSAPP && subject !== SUBJECT_TELEGRAM) return drop('subject-desconocido');
  let event: unknown;
  try {
    event = codec.decode(data);
  } catch {
    return drop('decode-error');
  }
  if (!event || typeof event !== 'object') return drop('malformed-event');
  return subject === SUBJECT_WHATSAPP
    ? whatsapp(event as MessageReceivedEvent, ownJid, dedup)
    : telegram(event as TelegramMessageReceivedEvent, dedup);
}
