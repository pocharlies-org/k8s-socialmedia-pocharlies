export async function publishWithAcknowledgement(
  publishAck: (subject: string, payload: Uint8Array, messageId: string) => Promise<void>,
  subject: string,
  payload: Uint8Array,
  messageId: string,
): Promise<void> {
  await publishAck(subject, payload, messageId);
}
