-- SC-2760: el listado de chats de la app de WhatsApp (apps/whatsapp) busca el
-- último mensaje por (account, conversation_id) filtrando solo
-- platform='whatsapp'. Su índice (apps/whatsapp/migrations/001_feature_api.sql)
-- añade NOT is_deleted, que el SQL del app no declara: el planner no puede
-- usarlo y cada conversación escaneaba messages por timestamp global (medido
-- 19-10: 4 s/conversación con 449k mensajes; con este índice, 0,2 s). Sin
-- predicado de borrado a propósito: la app muestra la fila revocada como
-- placeholder, así que no puede implicar NOT is_deleted.
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_chat_time
  ON messages (account, conversation_id, wa_timestamp DESC)
  WHERE platform = 'whatsapp';
