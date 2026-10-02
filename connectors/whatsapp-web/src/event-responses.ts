import { randomBytes } from 'node:crypto';
import {
  aesEncryptGCM,
  decryptEventResponse,
  getKeyAuthor,
  hmacSign,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  type WAMessageKey,
  type WAMessageContent,
} from '@whiskeysockets/baileys';

export type EventAttendance = 'unknown' | 'going' | 'not_going' | 'maybe';
export interface CapturedEventResponse {
  messageId: string;
  responderJid: string;
  fromMe: boolean;
  timestampMs: number;
  attendance: EventAttendance;
  extraGuestCount: number;
}

export interface EventResponseInput {
  eventKey: WAMessageKey;
  eventSecret: Uint8Array;
  creatorJid: string;
  responderJid: string;
  attendance: Exclude<EventAttendance, 'unknown'>;
  timestampMs?: number;
  extraGuestCount?: number;
  iv?: Uint8Array;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function integer(value: unknown): number | null {
  let result: number;
  if (typeof value === 'number') result = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) result = Number(value);
  else if (typeof value === 'bigint') result = Number(value);
  else {
    const bits = record(value);
    if (!bits || !Number.isInteger(bits.low) || !Number.isInteger(bits.high)) return null;
    const raw = (BigInt((bits.high as number) >>> 0) << 32n) | BigInt((bits.low as number) >>> 0);
    result = Number(bits.unsigned === false ? BigInt.asIntN(64, raw) : raw);
  }
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function person(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d+(?::\d+)?@(?:s\.whatsapp\.net|c\.us|lid)$/.test(value))
    return null;
  return jidNormalizedUser(value);
}

/** Inverse of rc13 decryptEventResponse; the caller must resolve PN identities. */
export function buildEventResponse(input: EventResponseInput): WAMessageContent {
  const creatorJid = person(input.creatorJid);
  const responderJid = person(input.responderJid);
  const id = input.eventKey.id;
  const timestampMs = input.timestampMs ?? Date.now();
  const extraGuestCount = input.extraGuestCount ?? 0;
  const response = new Map<string, number>([
    ['going', 1],
    ['not_going', 2],
    ['maybe', 3],
  ]).get(input.attendance);
  if (
    !creatorJid?.endsWith('@s.whatsapp.net') ||
    !responderJid?.endsWith('@s.whatsapp.net') ||
    typeof id !== 'string' ||
    !id ||
    id.length > 512 ||
    !input.eventKey.remoteJid ||
    !(input.eventSecret instanceof Uint8Array) ||
    input.eventSecret.length !== 32 ||
    !response ||
    integer(timestampMs) === null ||
    integer(extraGuestCount) === null ||
    extraGuestCount > 2147483647 ||
    (input.attendance !== 'going' && extraGuestCount !== 0)
  ) {
    throw new Error('Invalid event response input');
  }
  const iv = input.iv ?? randomBytes(12);
  if (!(iv instanceof Uint8Array) || iv.length !== 12) throw new Error('Invalid event response IV');
  const sign = Buffer.concat([
    Buffer.from(id),
    Buffer.from(creatorJid),
    Buffer.from(responderJid),
    Buffer.from('Event Response'),
    Buffer.from([1]),
  ]);
  const key0 = hmacSign(input.eventSecret, new Uint8Array(32), 'sha256');
  const encryptionKey = hmacSign(sign, key0, 'sha256');
  const payload = proto.Message.EventResponseMessage.encode({
    response,
    timestampMs,
    extraGuestCount,
  }).finish();
  return {
    encEventResponseMessage: {
      eventCreationMessageKey: { ...input.eventKey },
      encIv: iv,
      encPayload: aesEncryptGCM(
        payload,
        encryptionKey,
        iv,
        Buffer.from(`${id}\u0000${responderJid}`)
      ),
    },
  };
}

/** rc13 emits response/senderTimestampMs; persisted protobuf uses different names. */
export function captureEventResponse(value: unknown, ownJid: string): CapturedEventResponse | null {
  const update = record(value);
  if (!update) return null;
  const key = record(update.eventResponseMessageKey) as WAMessageKey | null;
  const body = record(update.response) || record(update.eventResponseMessage);
  if (!key || !body || typeof key.id !== 'string' || !key.id || key.id.length > 512) return null;
  const attendance = new Map<unknown, EventAttendance>([
    [0, 'unknown'],
    [1, 'going'],
    [2, 'not_going'],
    [3, 'maybe'],
    ['UNKNOWN', 'unknown'],
    ['GOING', 'going'],
    ['NOT_GOING', 'not_going'],
    ['MAYBE', 'maybe'],
  ]).get(body.response);
  if (!attendance) return null;
  const timestampMs = integer(body.timestampMs ?? update.senderTimestampMs ?? update.timestampMs);
  if (timestampMs === null) return null;
  const fromMe = key.fromMe === true;
  // Keep PN and LID distinct until an account-local mapping proves equivalence.
  const responderJid = person(fromMe ? ownJid : key.participant || key.remoteJid);
  if (!responderJid) return null;
  const extraGuestCount = body.extraGuestCount == null ? 0 : integer(body.extraGuestCount);
  if (extraGuestCount === null || extraGuestCount > 2147483647) return null;
  return {
    messageId: key.id,
    responderJid,
    fromMe,
    timestampMs,
    attendance,
    extraGuestCount: attendance === 'going' ? extraGuestCount : 0,
  };
}

export function latestEventResponses(
  responses: CapturedEventResponse[],
  latest = new Map<string, CapturedEventResponse>()
) {
  for (const response of responses) {
    const previous = latest.get(response.responderJid);
    if (
      !previous ||
      response.timestampMs > previous.timestampMs ||
      (response.timestampMs === previous.timestampMs && response.messageId > previous.messageId)
    ) {
      latest.set(response.responderJid, response);
    }
  }
  return latest;
}

export function aggregateEventResponses(responses: CapturedEventResponse[]) {
  const latest = latestEventResponses(responses);
  const counts = { going: 0, not_going: 0, maybe: 0 };
  let extraGuests = 0;
  let selectedByMe: EventAttendance | null = null;
  let selectedExtraGuestCount = 0;
  for (const response of latest.values()) {
    if (response.fromMe) {
      selectedByMe = response.attendance;
      selectedExtraGuestCount = response.attendance === 'going' ? response.extraGuestCount : 0;
    }
    if (response.attendance === 'unknown') continue;
    counts[response.attendance]++;
    extraGuests += response.extraGuestCount;
  }
  return {
    counts,
    extraGuests,
    selectedByMe,
    selectedExtraGuestCount,
    capturedResponders: latest.size,
    availability: 'local_partial' as const,
  };
}

export interface StoredEventResponse {
  key: WAMessageKey;
  content: WAMessageContent | undefined;
}

/** Read captured ciphertext without assuming that a LID is a phone identity. */
export async function decryptCapturedEventResponses(
  updates: StoredEventResponse[],
  context: {
    eventKey: WAMessageKey;
    eventSecret: Uint8Array;
    creatorJid: string;
    ownJid: string;
    resolvePhoneJid: (jid: string) => Promise<string | null>;
  }
): Promise<{ responses: CapturedEventResponse[]; undecryptable: number }> {
  const creator = person(context.creatorJid);
  const own = person(context.ownJid);
  const eventId = context.eventKey.id;
  const chat = context.eventKey.remoteJid;
  if (
    !creator?.endsWith('@s.whatsapp.net') ||
    !own?.endsWith('@s.whatsapp.net') ||
    !eventId ||
    !chat ||
    !(context.eventSecret instanceof Uint8Array) ||
    context.eventSecret.length !== 32
  ) {
    throw new Error('Invalid event decryption context');
  }
  const responses: CapturedEventResponse[] = [];
  let undecryptable = 0;
  for (const update of updates) {
    const content = normalizeMessageContent(update.content);
    const encrypted = content?.encEventResponseMessage;
    if (
      !encrypted ||
      encrypted.eventCreationMessageKey?.id !== eventId ||
      !update.key.remoteJid ||
      jidNormalizedUser(update.key.remoteJid) !== jidNormalizedUser(chat)
    )
      continue;
    try {
      const author = person(getKeyAuthor(update.key, own));
      const responder = author?.endsWith('@lid')
        ? person(await context.resolvePhoneJid(author))
        : author;
      if (!responder?.endsWith('@s.whatsapp.net')) throw new Error('Unresolved event responder');
      const response = decryptEventResponse(encrypted, {
        eventCreatorJid: creator,
        eventMsgId: eventId,
        eventEncKey: context.eventSecret,
        responderJid: responder,
      });
      const captured = captureEventResponse(
        {
          eventResponseMessageKey: { ...update.key, participant: responder },
          response,
        },
        own
      );
      if (!captured) throw new Error('Invalid decrypted event response');
      responses.push(captured);
    } catch {
      undecryptable++;
    }
  }
  return { responses, undecryptable };
}
