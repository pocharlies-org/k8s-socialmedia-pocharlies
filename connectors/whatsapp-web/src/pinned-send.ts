import {
  claimSendAttempt,
  confirmTextSend,
  reservePinSend,
  SendAlreadyClaimedError,
  type SendReservation,
} from './send-idempotency';
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
export async function sendPinOnce(
  input: PinSendInput,
  ports: {
    send: (
      input: PinSendInput,
      messageId: string,
      beforeSend: () => Promise<void>
    ) => Promise<string>;
    reserve?: (input: PinSendInput) => Promise<SendReservation>;
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
  if (reservation.state === 'conflict')
    throw new PinSendError('PIN_TOKEN_CONFLICT', 'Token belongs to another action', 409);
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
