/** Baileys 7 uses a timestamp for pinned chats and null for an unpin delta. */
export function chatPinState(chat: unknown): boolean | undefined {
  if (!chat || typeof chat !== 'object' || !('pinned' in chat)) return undefined;
  const value = (chat as { pinned?: unknown }).pinned;
  if (value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value > 0;
  return undefined;
}
