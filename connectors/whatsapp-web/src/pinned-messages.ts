import {
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  type WAMessage,
  type WAMessageKey,
} from '@whiskeysockets/baileys';

export const PIN_DURATIONS = [86400, 604800, 2592000] as const;
type PinDuration = (typeof PIN_DURATIONS)[number];
export interface CapturedPin {
  messageId: string;
  actionId: string;
  pinned: boolean;
  timestampMs: number;
  expiresAtMs: number | null;
}

function chat(jid: string | null | undefined): string | null {
  if (!jid || !/^(?:\d+(?::\d+)?@(?:s\.whatsapp\.net|c\.us|lid)|\d+(?:-\d+)?@g\.us)$/.test(jid))
    return null;
  return jid.endsWith('@g.us') ? jid : jidNormalizedUser(jid);
}

function integer(value: unknown): number | null {
  const number =
    typeof value === 'number'
      ? value
      : value &&
          typeof value === 'object' &&
          'toNumber' in value &&
          typeof value.toNumber === 'function'
        ? value.toNumber()
        : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function capturedPin(message: WAMessage, chatId: string): CapturedPin | null {
  const scope = chat(chatId);
  const content = normalizeMessageContent(message.message);
  const pin = content?.pinInChatMessage;
  if (
    !scope ||
    chat(message.key.remoteJid) !== scope ||
    !message.key.id ||
    !pin?.key?.id ||
    (pin.key.remoteJid && chat(pin.key.remoteJid) !== scope)
  )
    return null;
  const type = pin.type;
  if (
    type !== proto.Message.PinInChatMessage.Type.PIN_FOR_ALL &&
    type !== proto.Message.PinInChatMessage.Type.UNPIN_FOR_ALL
  )
    return null;
  const timestampMs =
    pin.senderTimestampMs == null
      ? (integer(message.messageTimestamp) ?? NaN) * 1000
      : integer(pin.senderTimestampMs);
  if (
    timestampMs == null ||
    !Number.isSafeInteger(timestampMs) ||
    timestampMs <= 0 ||
    timestampMs > 8640000000000000
  )
    return null;
  const pinned = type === proto.Message.PinInChatMessage.Type.PIN_FOR_ALL;
  const duration =
    content?.messageContextInfo?.messageAddOnDurationInSecs ??
    message.message?.messageContextInfo?.messageAddOnDurationInSecs;
  if (pinned && !PIN_DURATIONS.includes(duration as PinDuration)) return null;
  const expiresAtMs = pinned ? timestampMs + Number(duration) * 1000 : null;
  if (expiresAtMs !== null && expiresAtMs > 8640000000000000) return null;
  return { messageId: pin.key.id, actionId: message.key.id, pinned, timestampMs, expiresAtMs };
}

export function activePinnedMessages(
  messages: WAMessage[],
  chatId: string,
  nowMs = Date.now()
): CapturedPin[] {
  const latest = new Map<string, CapturedPin>();
  for (const message of messages) {
    const entry = capturedPin(message, chatId);
    if (!entry) continue;
    const previous = latest.get(entry.messageId);
    // Resolve timestamp ties deterministically; an unpin wins over a pin.
    if (
      !previous ||
      entry.timestampMs > previous.timestampMs ||
      (entry.timestampMs === previous.timestampMs &&
        ((!entry.pinned && previous.pinned) ||
          (entry.pinned === previous.pinned && entry.actionId > previous.actionId)))
    )
      latest.set(entry.messageId, entry);
  }
  // Keep expired/unpinned actions until after reduction so older pins cannot return.
  return [...latest.values()]
    .filter(entry => entry.pinned && entry.expiresAtMs! > nowMs)
    .sort((a, b) => b.timestampMs - a.timestampMs || a.messageId.localeCompare(b.messageId))
    .slice(0, 3);
}

export function pinMessageContent(
  key: WAMessageKey,
  chatId: string,
  pinned: boolean,
  duration: number = 604800
) {
  if (
    !key.id ||
    !chat(chatId) ||
    chat(key.remoteJid) !== chat(chatId) ||
    typeof pinned !== 'boolean' ||
    (pinned && !PIN_DURATIONS.includes(duration as PinDuration))
  )
    throw new Error('Invalid pinned message request');
  return {
    pin: { ...key },
    type: pinned
      ? proto.Message.PinInChatMessage.Type.PIN_FOR_ALL
      : proto.Message.PinInChatMessage.Type.UNPIN_FOR_ALL,
    ...(pinned ? { time: duration as PinDuration } : {}),
  };
}
