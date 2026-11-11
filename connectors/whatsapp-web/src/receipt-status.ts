/** A participant receipt cannot establish delivery or reading by an entire group. */
export function directReceiptStatus(update: {
  key?: { remoteJid?: string | null; fromMe?: boolean | null };
  receipt?: { readTimestamp?: unknown; playedTimestamp?: unknown; receiptTimestamp?: unknown };
}): 'read' | 'delivered' | null {
  const jid = update?.key?.remoteJid;
  if (!jid || update.key?.fromMe === false || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) {
    return null;
  }
  const valid = (value: unknown): boolean =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;
  const receipt = update.receipt;
  if (valid(receipt?.readTimestamp) || valid(receipt?.playedTimestamp)) return 'read';
  return valid(receipt?.receiptTimestamp) ? 'delivered' : null;
}
