-- SC-2760: la app de WhatsApp del fork de Jordi (apps/whatsapp) lee la tabla
-- `whatsapp_contacts` (su conector la mantiene del agenda de WhatsApp). El
-- conector de la casa no la crea: sin ella el listado de chats revienta con
-- 42P01. Vista de solo lectura sobre `participants` (la app nunca escribe
-- aquí: grep INSERT/UPDATE/DELETE en apps/whatsapp = 0). El jid va sin el
-- prefijo de cuenta, que es lo que el SQL del app espera.
CREATE OR REPLACE VIEW whatsapp_contacts AS
SELECT
  account,
  CASE WHEN position(':' IN id) > 0 THEN split_part(id, ':', 2) ELSE id END AS jid,
  name,
  push_name,
  NULL::timestamptz AS updated_at
FROM participants;
