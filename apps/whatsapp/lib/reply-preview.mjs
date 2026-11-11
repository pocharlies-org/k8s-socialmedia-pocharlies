const text = value => typeof value === 'string' ? value.slice(0, 4096).trim() : '';
const bare = value => String(value || '').replace(/^[^:]+:/, '');
const identifier = value => /@(lid|c\.us|s\.whatsapp\.net|g\.us|broadcast|newsletter)$/.test(bare(value));

export function projectReplyPreview(row, metadata, conversation) {
  if (row.replyLocallyDeleted) return { type: null, text: '', senderName: null, available: false };
  const captured = text(metadata?.reply_preview)
    ? { text: text(metadata.reply_preview), type: text(metadata.reply_type) || 'TEXT', participant: metadata.reply_from_id } : null;
  const available = row.replyAvailable === true || Boolean(captured);
  if (!available) return { type: null, text: '', senderName: null, available: false };
  let senderName = [row.replySenderName, metadata?.reply_from].map(text).find(value => value && !identifier(value)) || null;
  const participant = metadata?.reply_from_id || row.replySenderName;
  const chatIds = [conversation.id, conversation.wa_chat_id, conversation.provider_chat_id].map(bare);
  if (!senderName && !conversation.is_group && chatIds.includes(bare(participant))) {
    const name = text(conversation.name);
    if (name && !identifier(name)) senderName = name;
  }
  return { type: row.replyType || captured?.type || 'TEXT',
    text: (text(row.replyText) || captured?.text || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    senderName, available: true };
}
