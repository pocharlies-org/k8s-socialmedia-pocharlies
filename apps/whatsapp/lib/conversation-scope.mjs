// Conversations have no platform column. Preserve empty WhatsApp chats by
// their provider address; legacy opaque IDs require a WhatsApp message.
export const WHATSAPP_CONVERSATION_SQL = `(
  c.id ~ '@(lid|c\\.us|s\\.whatsapp\\.net|g\\.us|broadcast|newsletter)$'
  OR c.wa_chat_id ~ '@(lid|c\\.us|s\\.whatsapp\\.net|g\\.us|broadcast|newsletter)$'
  OR EXISTS (
    SELECT 1 FROM messages channel_message
    WHERE channel_message.conversation_id = c.id
      AND channel_message.account = c.account
      AND channel_message.platform = 'whatsapp'
  )
)`;
