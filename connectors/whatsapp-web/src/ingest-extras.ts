/**
 * Ingest details fixed after the QA audit of 02-10-2026 (console + MCP):
 *
 * - Media WE send (console / MCP: photo, document, sticker, GIF, voice) comes
 *   back from Baileys as `messages.upsert` type `append` (its emitOwnEvents
 *   echo, the same type as messages delivered while the socket was offline),
 *   which the connector ingests like history: the row was written but the
 *   media never reached MinIO nor `attachments`, so the console showed "not
 *   downloaded". A recent `append` now stores its media like a live message
 *   (`appendMediaEligible`).
 * - A document sent through /messages/media/send took its name from the last
 *   segment of the presigned URL (query string included); the caller's
 *   `fileName` wins now and the default drops the query (`documentFileName`).
 * - A quoted reply only kept the quoted id, and only for text replies: the
 *   quoted author and text ride now in `messages.metadata` (`quotedReply`).
 * - Our own participant was linked to every 1:1 chat we wrote in, so the
 *   console named those chats after the account itself ("Skirmshop Spain"):
 *   a 1:1 chat only links the other side (`linksSenderToChat`).
 * - `0@s.whatsapp.net` is WhatsApp's own account (WhatsApp Business notices):
 *   it is named "WhatsApp" instead of its jid.
 */
import type { WAMessage, proto } from '@whiskeysockets/baileys';

/** How old an `append` message can be and still get its media stored. */
export const DEFAULT_APPEND_MEDIA_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function appendMediaMaxAgeMs(): number {
  const hours = Number(process.env.WA_APPEND_MEDIA_MAX_AGE_HOURS);
  return Number.isFinite(hours) && hours >= 0
    ? hours * 60 * 60 * 1000
    : DEFAULT_APPEND_MEDIA_MAX_AGE_MS;
}

/**
 * An `append` upsert is our own send echoed by Baileys or a message delivered
 * while we were offline: both are new, not history, when recent. A timeless
 * message is not eligible (it could be anything from a replay).
 */
export function appendMediaEligible(
  msg: Pick<WAMessage, 'messageTimestamp'>,
  nowMs: number = Date.now(),
  maxAgeMs: number = appendMediaMaxAgeMs()
): boolean {
  const seconds = Number(msg.messageTimestamp || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return false;
  return nowMs - seconds * 1000 <= maxAgeMs;
}

const MAX_FILE_NAME = 200;

/** A file name: the last path segment, no control characters, ≤ 200 chars. */
export function cleanFileName(value: string): string {
  const segments = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .split(/[\\/]/);
  return (segments.filter(segment => segment.trim()).pop() ?? '').trim().slice(0, MAX_FILE_NAME);
}

/**
 * The name a sent document carries: the caller's `fileName` when it gives one,
 * else the last path segment of the URL without its query string (a presigned
 * MinIO URL ends in `…/file.pdf?X-Amz-…`). Never empty.
 */
export function documentFileName(fileUrl: string, explicit?: string): string {
  const given = explicit ? cleanFileName(explicit) : '';
  if (given) return given;
  // A data: URL has no path: what follows its type is the payload, not a name.
  if (/^data:/i.test(fileUrl)) return 'attachment';
  let segment = '';
  try {
    segment = new URL(fileUrl).pathname.split('/').pop() || '';
  } catch {
    segment = (fileUrl.split(/[?#]/)[0] || '').split('/').pop() || '';
  }
  try {
    segment = decodeURIComponent(segment);
  } catch {
    // keep it encoded
  }
  return cleanFileName(segment) || 'attachment';
}

/** WhatsApp's own account: its chat is "WhatsApp", not "0@s.whatsapp.net". */
export const OFFICIAL_WHATSAPP_NAME = 'WhatsApp';

export function isOfficialWhatsAppJid(jid: string | null | undefined): boolean {
  if (!jid) return false;
  const bare = jid.replace(/^[a-z]+:/, '');
  return /^0@(s\.whatsapp\.net|c\.us)$/.test(bare);
}

/**
 * Whether a message's sender is linked to its chat in conversation_participants.
 * In a group everyone who writes is a member, us included. A 1:1 chat's only
 * participant is the other side: linking ourselves made the console name the
 * chat after our own account.
 */
export function linksSenderToChat(chat: {
  isGroup: boolean;
  fromMe: boolean;
  chatJid?: string;
}): boolean {
  if (chat.isGroup || !chat.fromMe) return true;
  // Only a direct chat with a person loses our link; statuses and channels
  // (status@broadcast, …@newsletter) keep what they had.
  return !/@(lid|s\.whatsapp\.net|c\.us)$/.test(chat.chatJid ?? '@c.us');
}

export const MAX_REPLY_PREVIEW = 300;

/** The contextInfo of whichever message kind carries one (text, media, poll…). */
export function messageContextInfo(
  content: proto.IMessage | null | undefined
): proto.IContextInfo | undefined {
  if (!content) return undefined;
  for (const value of Object.values(content)) {
    if (value && typeof value === 'object' && 'contextInfo' in value) {
      const ctx = (value as { contextInfo?: proto.IContextInfo | null }).contextInfo;
      if (ctx) return ctx;
    }
  }
  return undefined;
}

/** What a quoted message shows: its text or caption, else a label of its kind. */
export function quotedPreview(quoted: proto.IMessage | null | undefined): {
  text: string;
  type: string;
} | null {
  if (!quoted) return null;
  const clip = (s: string | null | undefined): string =>
    String(s || '')
      .trim()
      .slice(0, MAX_REPLY_PREVIEW);
  const inner =
    quoted.ephemeralMessage?.message ||
    quoted.viewOnceMessage?.message ||
    quoted.viewOnceMessageV2?.message ||
    quoted.documentWithCaptionMessage?.message ||
    quoted;
  if (inner.conversation) return { text: clip(inner.conversation), type: 'TEXT' };
  if (inner.extendedTextMessage)
    return { text: clip(inner.extendedTextMessage.text), type: 'TEXT' };
  if (inner.imageMessage)
    return { text: clip(inner.imageMessage.caption) || '📷 Foto', type: 'IMAGE' };
  if (inner.videoMessage)
    return {
      text:
        clip(inner.videoMessage.caption) ||
        (inner.videoMessage.gifPlayback ? '🎞️ GIF' : '🎥 Vídeo'),
      type: 'VIDEO',
    };
  if (inner.audioMessage)
    return { text: inner.audioMessage.ptt ? '🎤 Nota de voz' : '🎵 Audio', type: 'AUDIO' };
  if (inner.documentMessage)
    return {
      text:
        clip(inner.documentMessage.caption) ||
        `📄 ${clip(inner.documentMessage.fileName) || 'Documento'}`,
      type: 'DOCUMENT',
    };
  if (inner.stickerMessage) return { text: '🏷️ Sticker', type: 'STICKER' };
  if (inner.locationMessage || inner.liveLocationMessage)
    return { text: '📍 Ubicación', type: 'LOCATION' };
  if (inner.contactMessage)
    return { text: `👤 ${clip(inner.contactMessage.displayName) || 'Contacto'}`, type: 'CONTACT' };
  if (inner.contactsArrayMessage) return { text: '👤 Contactos', type: 'CONTACT' };
  const poll =
    inner.pollCreationMessage || inner.pollCreationMessageV2 || inner.pollCreationMessageV3;
  if (poll) return { text: `📊 ${clip(poll.name)}`.trim(), type: 'POLL' };
  if (inner.eventMessage)
    return { text: `📅 ${clip(inner.eventMessage.name)}`.trim(), type: 'EVENT' };
  return null;
}

export interface QuotedReply {
  /** Bare WhatsApp id of the quoted message (contextInfo.stanzaId). */
  stanzaId: string;
  /** Raw jid of the quoted message's author, when WhatsApp says it. */
  participant?: string;
  preview?: { text: string; type: string };
}

/**
 * The quote of a reply, from any message kind. A reaction is not a reply (its
 * target rides in reactionMessage.key) and a forward's context is not a quote.
 */
export function quotedReply(content: proto.IMessage | null | undefined): QuotedReply | null {
  if (!content || content.reactionMessage) return null;
  const ctx = messageContextInfo(content);
  if (!ctx?.stanzaId) return null;
  const preview = quotedPreview(ctx.quotedMessage);
  return {
    stanzaId: ctx.stanzaId,
    ...(ctx.participant ? { participant: ctx.participant } : {}),
    ...(preview ? { preview } : {}),
  };
}
