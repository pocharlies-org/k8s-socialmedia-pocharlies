import {
  claimReservedSend,
  confirmTextSend,
  SendAlreadyClaimedError,
  recordSendFailure,
  type SendReservation,
} from './send-idempotency';

export interface SendOncePorts<Input> {
  send: (input: Input, messageId: string, beforeSend: () => Promise<void>) => Promise<string>;
  reserve?: (input: Input) => Promise<SendReservation>;
  claim?: typeof claimReservedSend;
  confirm?: typeof confirmTextSend;
}

/** Claims immediately before socket delivery and never retries an uncertain send. */
export async function deliverReservedSend<Input extends { token: string }>(
  input: Input,
  reservation: SendReservation,
  ports: SendOncePorts<Input>,
  errors: { conflict: () => Error; uncertain: () => Error }
) {
  if (reservation.state === 'conflict') throw errors.conflict();
  if (reservation.state === 'pending') throw errors.uncertain();
  if (reservation.state === 'sent')
    return { messageId: reservation.messageId, sentAt: reservation.sentAt, deduplicated: true };
  const reservedId = reservation.messageId;
  if (!reservedId) throw errors.uncertain();
  if (reservation.state === 'unavailable') {
    const messageId = await ports.send(input, reservedId, async () => {});
    return { messageId, sentAt: new Date().toISOString(), deduplicated: false };
  }
  let claimed = false;
  try {
    const messageId = await ports.send(input, reservedId, async () => {
      await (ports.claim || claimReservedSend)(input.token, reservedId);
      claimed = true;
    });
    if (!claimed || messageId !== reservedId) throw errors.uncertain();
    const sentAt = await (ports.confirm || confirmTextSend)(input.token, messageId);
    return { messageId, sentAt, deduplicated: false };
  } catch (error) {
    if (!(error instanceof SendAlreadyClaimedError))
      await recordSendFailure(input.token, claimed, error);
    if (claimed || error instanceof SendAlreadyClaimedError) throw errors.uncertain();
    throw error;
  }
}
