-- nas-local: el conquirer whatsapp-web (ensureHistoryTables) declara
--   whatsapp_message_keys.wa_message_id REFERENCES messages(wa_message_id)
--   y exige UNIQUE global sobre messages(wa_message_id). El esquema 001 del
--   repo solo tiene UNIQUE(conversation_id, wa_message_id); el cluster real
--   de pocharlies si tiene el unique global.
CREATE UNIQUE INDEX IF NOT EXISTS messages_wa_message_id_unique ON messages(wa_message_id);
