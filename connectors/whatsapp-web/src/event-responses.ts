/**
 * WhatsApp events and their responses (fase 3 / PR-7, ported from the NAS
 * fork's event-responses.ts / event-send.ts and adapted to prod) — the pure
 * part: event definitions, request validation and the response crypto.
 *
 * An event is an `eventMessage` with a `messageContextInfo.messageSecret`,
 * like a poll. A response (RSVP) is an `encEventResponseMessage`: an
 * EventResponseMessage {response GOING|NOT_GOING|MAYBE, timestampMs,
 * extraGuestCount} encrypted with the same derivation as a poll vote, use
 * case "Event Response" (poll-votes.ts encryptMessageSecret).
 *
 * Identities: rc13 decrypts inbound responses itself with PHONE jids only
 * ("all jids need to be PN", process-message.js) and the fork sends them the
 * same way, so OUR response is signed with phone jids (creator's PN — from the
 * key's alternate or Baileys' LID mapping — and our own PN). Inbound ones are
 * tried with every identity we know (PN and LID), like votes.
 */
import { randomBytes } from 'node:crypto';
import {
  decryptEventResponse,
  getKeyAuthor,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
} from '@whiskeysockets/baileys';
import type { AnyMessageContent, WAMessageContent, WAMessageKey } from '@whiskeysockets/baileys';
import { encryptMessageSecret, int64Ms, PollEventInputError } from './poll-votes';

export type EventResponse = 'going' | 'not_going' | 'maybe';
/** `unknown` = the responder cleared their answer. */
export type StoredEventResponse = EventResponse | 'unknown';

export const EVENT_NAME_MAX_LENGTH = 255;
export const EVENT_DESCRIPTION_MAX_LENGTH = 2048;
export const EVENT_LOCATION_MAX_LENGTH = 255;
/** WhatsApp's extraGuestCount is an int32; the app offers far fewer. */
export const EVENT_MAX_EXTRA_GUESTS = 100;
/** Earliest accepted start: catches seconds sent where ms are expected (1970 dates). */
const EARLIEST_START_MS = Date.UTC(2020, 0, 1);

const RESPONSE_CODES: Record<EventResponse, number> = { going: 1, not_going: 2, maybe: 3 };
const RESPONSE_NAMES: Record<number, StoredEventResponse> = {
  0: 'unknown',
  1: 'going',
  2: 'not_going',
  3: 'maybe',
};

export interface EventLocation {
  name?: string;
  degreesLatitude?: number;
  degreesLongitude?: number;
}

export interface ValidatedEvent {
  name: string;
  description?: string;
  startTime: Date;
  endTime?: Date;
  location?: EventLocation;
  /** A WhatsApp call link WhatsApp creates for the event (audio or video). */
  call?: 'audio' | 'video';
  extraGuestsAllowed?: boolean;
}

export interface EventDefinition {
  name: string;
  description: string | null;
  /** epoch ms */
  startTime: number | null;
  endTime: number | null;
  location: EventLocation | null;
  joinLink: string | null;
  isCanceled: boolean;
  extraGuestsAllowed: boolean;
}

// ---------------------------------------------------------------------------
// Reading events
// ---------------------------------------------------------------------------

type AnyContent = proto.IMessage | null | undefined;

export function eventMessageOf(message: AnyContent): proto.Message.IEventMessage | undefined {
  return (
    normalizeMessageContent(message as WAMessageContent | undefined)?.eventMessage || undefined
  );
}

function seconds(value: unknown): number | null {
  const n = int64Ms(value);
  return n === undefined ? null : n * 1000;
}

function locationOf(
  value: proto.Message.ILocationMessage | null | undefined
): EventLocation | null {
  if (!value) return null;
  const out: EventLocation = {};
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (name) out.name = name;
  const lat = Number(value.degreesLatitude);
  const lng = Number(value.degreesLongitude);
  if (
    value.degreesLatitude != null &&
    value.degreesLongitude != null &&
    Number.isFinite(lat) &&
    Number.isFinite(lng)
  ) {
    out.degreesLatitude = lat;
    out.degreesLongitude = lng;
  }
  return Object.keys(out).length ? out : null;
}

/** Name, time, place… of an event message; null when it is not one. */
export function parseEventDefinition(message: AnyContent): EventDefinition | null {
  const event = eventMessageOf(message);
  if (!event) return null;
  return {
    name: String(event.name || ''),
    description: event.description ? String(event.description) : null,
    startTime: seconds(event.startTime),
    endTime: seconds(event.endTime),
    location: locationOf(event.location),
    joinLink: event.joinLink ? String(event.joinLink) : null,
    isCanceled: !!event.isCanceled,
    extraGuestsAllowed: !!event.extraGuestsAllowed,
  };
}

export function isEventResponse(value: unknown): value is EventResponse {
  return value === 'going' || value === 'not_going' || value === 'maybe';
}

// ---------------------------------------------------------------------------
// Request validation (before anything is sent)
// ---------------------------------------------------------------------------

function timeOf(value: unknown, field: string): Date {
  const ms =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? /^\d+$/.test(value.trim())
          ? Number(value.trim())
          : Date.parse(value)
        : NaN;
  if (!Number.isFinite(ms)) {
    throw new PollEventInputError(`${field} must be an ISO-8601 time or epoch milliseconds`, {
      field,
    });
  }
  if (ms < EARLIEST_START_MS) {
    throw new PollEventInputError(`${field} is before 2020 (epoch milliseconds expected)`, {
      field,
    });
  }
  return new Date(ms);
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new PollEventInputError(`${field} must be text`, { field });
  const text = value.trim();
  if (text.length > max) {
    throw new PollEventInputError(`${field} is longer than ${max} characters`, {
      field,
      maxLength: max,
    });
  }
  return text || undefined;
}

/**
 * A place: a name (what the official form offers), a coordinate pair, or
 * both. A plain string is a name. Coordinates are never invented for a name.
 */
export function validateEventLocation(value: unknown): EventLocation | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') {
    const name = optionalText(value, 'location', EVENT_LOCATION_MAX_LENGTH);
    return name ? { name } : undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new PollEventInputError(
      'location must be a name or {name?, degreesLatitude?, degreesLongitude?}',
      {
        field: 'location',
      }
    );
  }
  const raw = value as Record<string, unknown>;
  const name = optionalText(raw.name, 'location.name', EVENT_LOCATION_MAX_LENGTH);
  const hasLat = raw.degreesLatitude !== undefined && raw.degreesLatitude !== null;
  const hasLng = raw.degreesLongitude !== undefined && raw.degreesLongitude !== null;
  if (hasLat !== hasLng) {
    throw new PollEventInputError('location needs both coordinates or neither', {
      field: 'location',
    });
  }
  if (!hasLat) return name ? { name } : undefined;
  const lat = Number(raw.degreesLatitude);
  const lng = Number(raw.degreesLongitude);
  if (
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90 ||
    !Number.isFinite(lng) ||
    lng < -180 ||
    lng > 180
  ) {
    throw new PollEventInputError('location coordinates are out of range', { field: 'location' });
  }
  return { ...(name ? { name } : {}), degreesLatitude: lat, degreesLongitude: lng };
}

/** An event to send, validated. */
export function validateEventInput(body: Record<string, unknown>): ValidatedEvent {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new PollEventInputError('An event needs a name', { field: 'name' });
  if (name.length > EVENT_NAME_MAX_LENGTH) {
    throw new PollEventInputError(
      `The event name is longer than ${EVENT_NAME_MAX_LENGTH} characters`,
      {
        field: 'name',
        maxLength: EVENT_NAME_MAX_LENGTH,
      }
    );
  }
  const description = optionalText(body.description, 'description', EVENT_DESCRIPTION_MAX_LENGTH);
  if (body.startTime === undefined || body.startTime === null) {
    throw new PollEventInputError('startTime is required', { field: 'startTime' });
  }
  const startTime = timeOf(body.startTime, 'startTime');
  const endTime =
    body.endTime === undefined || body.endTime === null || body.endTime === ''
      ? undefined
      : timeOf(body.endTime, 'endTime');
  if (endTime && endTime.getTime() < startTime.getTime()) {
    throw new PollEventInputError('endTime cannot be before startTime', { field: 'endTime' });
  }
  const location = validateEventLocation(body.location);
  if (
    body.call !== undefined &&
    body.call !== null &&
    body.call !== 'audio' &&
    body.call !== 'video'
  ) {
    throw new PollEventInputError('call must be "audio" or "video"', { field: 'call' });
  }
  if (
    body.extraGuestsAllowed !== undefined &&
    body.extraGuestsAllowed !== null &&
    typeof body.extraGuestsAllowed !== 'boolean'
  ) {
    throw new PollEventInputError('extraGuestsAllowed must be a boolean', {
      field: 'extraGuestsAllowed',
    });
  }
  return {
    name,
    ...(description ? { description } : {}),
    startTime,
    ...(endTime ? { endTime } : {}),
    ...(location ? { location } : {}),
    ...(body.call === 'audio' || body.call === 'video' ? { call: body.call } : {}),
    ...(typeof body.extraGuestsAllowed === 'boolean'
      ? { extraGuestsAllowed: body.extraGuestsAllowed }
      : {}),
  };
}

/** Baileys content of a validated event (it adds the messageSecret; `call` makes WhatsApp create the link). */
export function buildEventContent(event: ValidatedEvent): AnyMessageContent {
  return {
    event: {
      name: event.name,
      ...(event.description ? { description: event.description } : {}),
      startDate: event.startTime,
      ...(event.endTime ? { endDate: event.endTime } : {}),
      ...(event.location ? { location: event.location } : {}),
      ...(event.call ? { call: event.call } : {}),
      ...(event.extraGuestsAllowed === undefined
        ? {}
        : { extraGuestsAllowed: event.extraGuestsAllowed }),
    },
  } as AnyMessageContent;
}

/** A response to send, validated: extra guests only when going (and the event allows them). */
export function validateEventResponse(
  response: unknown,
  extraGuestCount: unknown
): { response: EventResponse; extraGuestCount: number } {
  if (!isEventResponse(response)) {
    throw new PollEventInputError('response must be going, not_going or maybe', {
      field: 'response',
    });
  }
  const extra =
    extraGuestCount === undefined || extraGuestCount === null ? 0 : Number(extraGuestCount);
  if (!Number.isInteger(extra) || extra < 0 || extra > EVENT_MAX_EXTRA_GUESTS) {
    throw new PollEventInputError(
      `extraGuestCount must be an integer from 0 to ${EVENT_MAX_EXTRA_GUESTS}`,
      {
        field: 'extraGuestCount',
      }
    );
  }
  if (extra > 0 && response !== 'going') {
    throw new PollEventInputError('extraGuestCount only goes with response "going"', {
      field: 'extraGuestCount',
    });
  }
  return { response, extraGuestCount: extra };
}

// ---------------------------------------------------------------------------
// Response crypto
// ---------------------------------------------------------------------------

export interface EventResponseBuild {
  eventKey: WAMessageKey;
  secret: Uint8Array;
  /** Phone jids (see the header). */
  creator: string;
  responder: string;
  response: EventResponse;
  extraGuestCount: number;
  timestampMs: number;
  iv?: Uint8Array;
}

/** The encEventResponseMessage of our response. */
export function buildEventResponseContent(input: EventResponseBuild): WAMessageContent {
  const eventId = String(input.eventKey.id || '');
  if (!eventId) throw new Error('event key without id');
  const plaintext = proto.Message.EventResponseMessage.encode({
    response: RESPONSE_CODES[input.response],
    timestampMs: input.timestampMs,
    extraGuestCount: input.response === 'going' ? input.extraGuestCount : 0,
  }).finish();
  const enc = encryptMessageSecret({
    secret: input.secret,
    messageId: eventId,
    creator: input.creator,
    modifier: input.responder,
    useCase: 'Event Response',
    plaintext,
    iv: input.iv,
  });
  return {
    encEventResponseMessage: {
      eventCreationMessageKey: {
        remoteJid: input.eventKey.remoteJid,
        fromMe: !!input.eventKey.fromMe,
        id: eventId,
        ...(input.eventKey.participant ? { participant: input.eventKey.participant } : {}),
      },
      encPayload: enc.encPayload,
      encIv: enc.encIv,
    },
  };
}

export interface DecryptedEventResponse {
  response: StoredEventResponse;
  /** epoch ms the responder stamped (undefined when absent) */
  timestampMs?: number;
  extraGuestCount: number;
  creator: string;
  responder: string;
}

/** Decrypt a response trying every (creator, responder) pair; null when none authenticates. */
export function decryptEventResponseWith(
  enc: proto.Message.IEncEventResponseMessage | null | undefined,
  context: { eventId: string; secret: Uint8Array; creators: string[]; responders: string[] }
): DecryptedEventResponse | null {
  const encPayload = enc?.encPayload;
  const encIv = enc?.encIv;
  if (!(encPayload instanceof Uint8Array) || !(encIv instanceof Uint8Array) || !context.eventId) {
    return null;
  }
  for (const creator of context.creators) {
    for (const responder of context.responders) {
      try {
        const decoded = decryptEventResponse(
          { encPayload, encIv },
          {
            eventCreatorJid: creator,
            eventMsgId: context.eventId,
            eventEncKey: context.secret,
            responderJid: responder,
          }
        );
        const response = RESPONSE_NAMES[Number(decoded.response ?? 0)] || 'unknown';
        const extra = Number(decoded.extraGuestCount ?? 0);
        return {
          response,
          timestampMs: int64Ms(decoded.timestampMs),
          extraGuestCount:
            response === 'going' && Number.isInteger(extra) && extra > 0
              ? Math.min(extra, 2147483647)
              : 0,
          creator,
          responder,
        };
      } catch {
        // Not this pair: try the next identity.
      }
    }
  }
  return null;
}

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
  return buildEventResponseContent({
    eventKey: input.eventKey,
    secret: input.eventSecret,
    creator: creatorJid,
    responder: responderJid,
    response: input.attendance,
    extraGuestCount,
    timestampMs,
    iv,
  });
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

export interface CapturedEventCiphertext {
  key: WAMessageKey;
  content: WAMessageContent | undefined;
}

/** Read captured ciphertext without assuming that a LID is a phone identity. */
export async function decryptCapturedEventResponses(
  updates: CapturedEventCiphertext[],
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
