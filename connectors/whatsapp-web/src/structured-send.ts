import { randomUUID } from 'node:crypto';
import {
  claimSendAttempt,
  confirmTextSend,
  reserveEventCreationSend,
  reservePollSend,
  SendAlreadyClaimedError,
  type SendReservation,
} from './send-idempotency';
import {
  CapabilityError,
  validateEventLocation,
  validatePollInput,
  type EventLocationInput,
} from './whatsapp-capabilities';

/**
 * Durable creation of the two structured messages this app can originate: a
 * poll and an event. Both follow the reserve -> claim -> relay -> confirm
 * sequence in send-idempotency.ts, because Baileys generates a fresh message ID
 * per call: without a reservation, a retried "create poll" puts two identical
 * polls in the chat.
 */

export class StructuredSendError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'StructuredSendError';
  }
}

export interface PreparedPoll {
  token: string;
  conversationId: string;
  name: string;
  values: string[];
  selectableCount?: number;
}

export interface PreparedEvent {
  token: string;
  conversationId: string;
  name: string;
  description?: string;
  startDate: string;
  endDate?: string;
  location?: EventLocationInput;
  call?: 'audio' | 'video';
  isCancelled?: boolean;
  extraGuestsAllowed?: boolean;
}

export interface SendResult {
  messageId: string;
  sentAt: string;
  deduplicated: boolean;
}

/**
 * These routes existed before retry tokens did, so a request that does not carry
 * the field at all is a legacy send: it gets a fresh ID per HTTP call and behaves
 * exactly as it always did. A field that *is* present has to be usable — `null`,
 * `""` or a number means the caller meant to dedupe and got it wrong, and
 * quietly ignoring it would switch idempotency off without saying so.
 */
export function sendTokenOrLegacy(value: unknown): string {
  if (value === undefined) return randomUUID();
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new StructuredSendError('INVALID_SEND_TOKEN', 'A usable sendToken is required', 400, {
      field: 'sendToken',
    });
  }
  return value.trim();
}

function conversationOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new StructuredSendError('INVALID_CAPABILITY_INPUT', 'conversationId is required', 400, {
      field: 'conversationId',
    });
  }
  return value.trim();
}

/** Validation happens before any reservation: a bad draft must not burn a token. */
function invalid(error: unknown, code: string): never {
  if (error instanceof StructuredSendError) throw error;
  if (error instanceof CapabilityError) {
    throw new StructuredSendError(code, error.message, 400, error.details);
  }
  throw error;
}

export function preparePollInput(input: {
  token: unknown;
  conversationId: unknown;
  name: unknown;
  values: unknown;
  selectableCount?: unknown;
}): PreparedPoll {
  const token = sendTokenOrLegacy(input.token);
  const conversationId = conversationOf(input.conversationId);
  try {
    const poll = validatePollInput({
      name: input.name,
      values: input.values,
      selectableCount: input.selectableCount,
    });
    return { token, conversationId, ...poll };
  } catch (error) {
    invalid(error, 'INVALID_POLL_REQUEST');
  }
}

function dateOf(value: unknown, field: string): Date {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  if (Number.isNaN(date.getTime())) {
    throw new StructuredSendError('INVALID_EVENT_REQUEST', `${field} must be a valid date`, 400, {
      field,
    });
  }
  // The hash stores one canonical spelling, so the same instant written two
  // ways still replays instead of looking like a changed payload.
  return date;
}

export function prepareEventInput(input: {
  token: unknown;
  conversationId: unknown;
  name: unknown;
  description?: unknown;
  startDate: unknown;
  endDate?: unknown;
  location?: unknown;
  call?: unknown;
  isCancelled?: unknown;
  extraGuestsAllowed?: unknown;
}): PreparedEvent {
  const token = sendTokenOrLegacy(input.token);
  const conversationId = conversationOf(input.conversationId);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    throw new StructuredSendError('INVALID_EVENT_REQUEST', 'An event needs a name', 400, {
      field: 'name',
    });
  }
  const startDate = dateOf(input.startDate, 'startDate');
  const endDate =
    input.endDate === undefined || input.endDate === null || input.endDate === ''
      ? undefined
      : dateOf(input.endDate, 'endDate');
  if (endDate && endDate.getTime() < startDate.getTime()) {
    throw new StructuredSendError(
      'INVALID_EVENT_REQUEST',
      'endDate cannot be before startDate',
      400,
      { field: 'endDate' }
    );
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    throw new StructuredSendError('INVALID_EVENT_REQUEST', 'description must be text', 400, {
      field: 'description',
    });
  }
  const description = input.description?.trim();
  let location: EventLocationInput | undefined;
  try {
    location = validateEventLocation(input.location);
  } catch (error) {
    invalid(error, 'INVALID_EVENT_REQUEST');
  }
  const call = input.call === 'audio' || input.call === 'video' ? input.call : undefined;
  if (input.call !== undefined && call === undefined) {
    throw new StructuredSendError('INVALID_EVENT_REQUEST', 'call must be audio or video', 400, {
      field: 'call',
    });
  }
  const flag = (value: unknown, field: string): boolean | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'boolean') {
      throw new StructuredSendError('INVALID_EVENT_REQUEST', `${field} must be a boolean`, 400, {
        field,
      });
    }
    return value;
  };
  return {
    token,
    conversationId,
    name,
    ...(description ? { description } : {}),
    startDate: startDate.toISOString(),
    ...(endDate ? { endDate: endDate.toISOString() } : {}),
    ...(location ? { location } : {}),
    ...(call ? { call } : {}),
    ...(flag(input.isCancelled, 'isCancelled') === undefined
      ? {}
      : { isCancelled: input.isCancelled as boolean }),
    ...(flag(input.extraGuestsAllowed, 'extraGuestsAllowed') === undefined
      ? {}
      : { extraGuestsAllowed: input.extraGuestsAllowed as boolean }),
  };
}

function outcome(code: string, message: string): StructuredSendError {
  return new StructuredSendError(code, message, 409);
}

async function runOnce(
  reservation: SendReservation,
  codes: { conflict: string; uncertain: string },
  send: (messageId: string, beforeSend: () => Promise<void>) => Promise<string>,
  claim: (token: string, messageId: string) => Promise<void>,
  confirm: (token: string, messageId: string) => Promise<string>,
  token: string
): Promise<SendResult> {
  if (reservation.state === 'conflict') {
    throw outcome(codes.conflict, 'That sendToken belongs to a different payload');
  }
  if (reservation.state === 'pending') {
    throw outcome(
      codes.uncertain,
      'Delivery is not confirmed; check the chat before starting a new send'
    );
  }
  if (reservation.state === 'sent') {
    if (!reservation.sentAt) {
      throw outcome(codes.uncertain, 'The recorded send has no confirmation time; check the chat');
    }
    return {
      messageId: reservation.messageId,
      sentAt: reservation.sentAt,
      deduplicated: true,
    };
  }
  let claimed = false;
  try {
    const messageId = await send(reservation.messageId, async () => {
      await claim(token, reservation.messageId);
      claimed = true;
    });
    if (!claimed || messageId !== reservation.messageId) {
      throw outcome(
        codes.uncertain,
        'WhatsApp returned a different message ID; check the chat before sending again'
      );
    }
    const sentAt = await confirm(token, messageId);
    return { messageId, sentAt, deduplicated: false };
  } catch (error) {
    if (claimed || error instanceof SendAlreadyClaimedError) {
      throw outcome(
        codes.uncertain,
        'Delivery is not confirmed; check the chat before starting a new send'
      );
    }
    throw error;
  }
}

export async function sendPollOnce(
  input: {
    token: unknown;
    conversationId: unknown;
    name: unknown;
    values: unknown;
    selectableCount?: unknown;
  },
  ports: {
    send: (
      input: PreparedPoll,
      messageId: string,
      beforeSend: () => Promise<void>
    ) => Promise<string>;
    reserve?: (input: PreparedPoll) => Promise<SendReservation>;
    claim?: typeof claimSendAttempt;
    confirm?: typeof confirmTextSend;
  }
): Promise<SendResult> {
  const prepared = preparePollInput(input);
  const reservation = await (ports.reserve || reservePollSend)(prepared);
  return runOnce(
    reservation,
    { conflict: 'POLL_TOKEN_CONFLICT', uncertain: 'POLL_SEND_OUTCOME_UNCERTAIN' },
    (messageId, beforeSend) => ports.send(prepared, messageId, beforeSend),
    ports.claim || claimSendAttempt,
    ports.confirm || confirmTextSend,
    prepared.token
  );
}

export async function sendEventOnce(
  input: {
    token: unknown;
    conversationId: unknown;
    name: unknown;
    description?: unknown;
    startDate: unknown;
    endDate?: unknown;
    location?: unknown;
    call?: unknown;
    isCancelled?: unknown;
    extraGuestsAllowed?: unknown;
  },
  ports: {
    send: (
      input: PreparedEvent,
      messageId: string,
      beforeSend: () => Promise<void>
    ) => Promise<string>;
    reserve?: (input: PreparedEvent) => Promise<SendReservation>;
    claim?: typeof claimSendAttempt;
    confirm?: typeof confirmTextSend;
  }
): Promise<SendResult> {
  const prepared = prepareEventInput(input);
  const reservation = await (ports.reserve || reserveEventCreationSend)(prepared);
  return runOnce(
    reservation,
    {
      conflict: 'EVENT_CREATE_TOKEN_CONFLICT',
      uncertain: 'EVENT_CREATE_OUTCOME_UNCERTAIN',
    },
    (messageId, beforeSend) => ports.send(prepared, messageId, beforeSend),
    ports.claim || claimSendAttempt,
    ports.confirm || confirmTextSend,
    prepared.token
  );
}
