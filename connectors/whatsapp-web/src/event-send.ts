import {
  claimSendAttempt,
  confirmTextSend,
  reserveEventResponseSend,
  SendAlreadyClaimedError,
  type SendReservation,
} from './send-idempotency';
import type { EventAttendance } from './event-responses';

export interface EventSendInput {
  token: string;
  conversationId: string;
  eventMessageId: string;
  attendance: Exclude<EventAttendance, 'unknown'>;
  extraGuestCount: number;
}

export class EventSendError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export async function sendEventResponseOnce(
  input: EventSendInput,
  ports: {
    send: (
      input: EventSendInput,
      messageId: string,
      beforeSend: () => Promise<void>
    ) => Promise<string>;
    reserve?: (input: EventSendInput) => Promise<SendReservation>;
    claim?: typeof claimSendAttempt;
    confirm?: typeof confirmTextSend;
  }
) {
  if (
    typeof input.token !== 'string' ||
    !input.token.trim() ||
    input.token.length > 200 ||
    typeof input.conversationId !== 'string' ||
    !input.conversationId ||
    typeof input.eventMessageId !== 'string' ||
    !input.eventMessageId.trim() ||
    input.eventMessageId.length > 512 ||
    !['going', 'not_going', 'maybe'].includes(input.attendance) ||
    !Number.isSafeInteger(input.extraGuestCount) ||
    input.extraGuestCount < 0 ||
    input.extraGuestCount > 2147483647 ||
    (input.attendance !== 'going' && input.extraGuestCount !== 0)
  ) {
    throw new EventSendError('INVALID_EVENT_RESPONSE', 'Invalid event response', 400);
  }
  const reservation = await (ports.reserve || reserveEventResponseSend)(input);
  const uncertain = () =>
    new EventSendError(
      'EVENT_SEND_OUTCOME_UNCERTAIN',
      'Response delivery is not confirmed; refresh the event before trying a new response',
      409
    );
  if (reservation.state === 'conflict')
    throw new EventSendError(
      'EVENT_TOKEN_CONFLICT',
      'Token already belongs to a different response',
      409
    );
  if (reservation.state === 'pending') throw uncertain();
  if (reservation.state === 'sent')
    return { messageId: reservation.messageId, sentAt: reservation.sentAt, deduplicated: true };
  let claimed = false;
  try {
    const messageId = await ports.send(input, reservation.messageId, async () => {
      await (ports.claim || claimSendAttempt)(input.token, reservation.messageId);
      claimed = true;
    });
    if (!claimed || messageId !== reservation.messageId) throw uncertain();
    const sentAt = await (ports.confirm || confirmTextSend)(input.token, messageId);
    return { messageId, sentAt, deduplicated: false };
  } catch (error) {
    if (claimed || error instanceof SendAlreadyClaimedError) throw uncertain();
    throw error;
  }
}
