import { reservePinSend } from './send-idempotency';
import { deliverReservedSend, type SendOncePorts } from './send-once';
import { PIN_DURATIONS } from './pinned-messages';
export interface PinSendInput {
  token: string;
  conversationId: string;
  targetMessageId: string;
  pinned: boolean;
  duration: number;
}
export class PinSendError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}
export async function sendPinOnce(input: PinSendInput, ports: SendOncePorts<PinSendInput>) {
  if (
    typeof input.token !== 'string' ||
    !input.token.trim() ||
    input.token.length > 200 ||
    typeof input.conversationId !== 'string' ||
    !input.conversationId ||
    typeof input.targetMessageId !== 'string' ||
    !input.targetMessageId.trim() ||
    input.targetMessageId.length > 512 ||
    typeof input.pinned !== 'boolean' ||
    (input.pinned ? !PIN_DURATIONS.includes(input.duration as any) : input.duration !== 0)
  ) {
    throw new PinSendError('INVALID_PIN_REQUEST', 'Invalid pin request', 400);
  }
  const reservation = await (ports.reserve || reservePinSend)(input);
  const uncertain = () =>
    new PinSendError(
      'PIN_SEND_OUTCOME_UNCERTAIN',
      'Pin delivery is not confirmed; refresh before sending another action',
      409
    );
  return deliverReservedSend(input, reservation, ports, {
    conflict: () => new PinSendError('PIN_TOKEN_CONFLICT', 'Token belongs to another action', 409),
    uncertain,
  });
}
