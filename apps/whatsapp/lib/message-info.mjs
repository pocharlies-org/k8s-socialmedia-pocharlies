function timestamp(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value)) throw Error('Invalid receipt timestamp');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw Error('Invalid receipt timestamp');
  return date.toISOString();
}

/** Accept only the connector response for the selected message and account. */
export function publicMessageInfo(result, { account, chatId, messageId }) {
  if (!result || result.account !== account || result.chatId !== chatId || result.messageId !== messageId || result.fromMe !== true) throw Error('Receipt scope mismatch');
  if (!Array.isArray(result.receipts) || result.receipts.length > 10000) throw Error('Invalid receipt list');
  const recipientCount = result.recipientCount;
  if (recipientCount !== null && (!Number.isSafeInteger(recipientCount) || recipientCount < 0 || recipientCount > 10000)) throw Error('Invalid recipient count');
  if (typeof result.completeRecipients !== 'boolean') throw Error('Invalid recipient snapshot');
  const seen = new Set();
  const receipts = result.receipts.map(receipt => {
    const id = receipt?.participantId;
    if (typeof id !== 'string' || !id || id.length > 256 || seen.has(id)) throw Error('Invalid receipt participant');
    seen.add(id);
    if (receipt.name != null && (typeof receipt.name !== 'string' || receipt.name.length > 256)) throw Error('Invalid receipt name');
    return { participantId: id, name: receipt.name || id, deliveredAt: timestamp(receipt.deliveredAt), readAt: timestamp(receipt.readAt), playedAt: timestamp(receipt.playedAt) };
  });
  const status = ['pending', 'sent', 'delivered', 'read', 'played', 'failed', 'deleted'].includes(result.status) ? result.status : null;
  const info = { status, recipientCount, completeRecipients: result.completeRecipients, receipts, observedAt: timestamp(result.observedAt) };
  if (result.recovery != null) {
    const { state, retryAfterMs } = result.recovery;
    if (!['pending', 'complete', 'unsupported', 'timeout', 'failed'].includes(state)) throw Error('Invalid receipt recovery state');
    if (retryAfterMs != null && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 500 || retryAfterMs > 5000)) throw Error('Invalid receipt recovery delay');
    info.recovery = { state, ...(retryAfterMs == null ? {} : { retryAfterMs }) };
  }
  return info;
}
