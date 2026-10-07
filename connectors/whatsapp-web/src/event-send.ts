import { reserveEventResponseSend } from './send-idempotency';
import { deliverReservedSend, type SendOncePorts } from './send-once';
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
  ports: SendOncePorts<EventSendInput>
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
  return deliverReservedSend(input, reservation, ports, {
    conflict: () =>
      new EventSendError(
        'EVENT_TOKEN_CONFLICT',
        'Token already belongs to a different response',
        409
      ),
    uncertain,
  });
}
