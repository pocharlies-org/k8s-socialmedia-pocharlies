-- 048 — dirección de los Mensajes guardados de Telegram (DGX-1938, corrección de datos).
--
-- DGX-1938 (#534/#535, v1.3.206) hizo que el conector marque como saliente lo propio
-- no reenviado del chat consigo mismo (Mensajes guardados), igual que TDLib: Telegram
-- entrega esos mensajes con out=false y parseMessage copiaba message.isOutgoing tal
-- cual, así que todo entraba como INBOUND y /messages pintaba cada envío dos veces.
-- Eso solo afecta a lo que entra desde el despliegue: telegram-sync inserta con
-- ON CONFLICT DO NOTHING y no reescribe filas existentes, así que lo anterior a 27-11
-- sigue como recibido. Esta migración aplica la MISMA regla a esos datos antiguos.
--
-- Acotado a la conversación tg_33285833 (el chat «Dani» = Mensajes guardados de la
-- cuenta personal; los ids de personal no llevan prefijo, ver 002). En ese chat, lo no
-- reenviado es nuestro (DGX-1938); un reenvío y el resto de cuentas/chats —incluida la
-- professional:tg_33285833— conservan la marca de Telegram. Idempotente: al re-correr
-- no queda ningún INBOUND no reenviado que actualizar.
DO $$
DECLARE
  antes int;
BEGIN
  SELECT count(*) INTO antes FROM messages
    WHERE conversation_id = 'tg_33285833'
      AND direction = 'INBOUND'
      AND is_forwarded = false;
  RAISE NOTICE '048: antes % INBOUND no reenviados en tg_33285833', antes;

  UPDATE messages
    SET direction = 'OUTBOUND'
    WHERE conversation_id = 'tg_33285833'
      AND direction = 'INBOUND'
      AND is_forwarded = false;

  RAISE NOTICE '048: despues % INBOUND no reenviados en tg_33285833 (esperado 0)',
    (SELECT count(*) FROM messages
       WHERE conversation_id = 'tg_33285833' AND direction = 'INBOUND' AND is_forwarded = false);
END $$;
