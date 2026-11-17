-- 045 — brain-windows por evento (SC-5926, pieza A5 de SC-5806).
--
-- El incremental de ventanas era un CronJob de 30 min que releía `messages`
-- por el cursor (updated_at, id). Ahora lo despierta la propia base: el trigger
-- de abajo avisa por `pg_notify('brain_windows_changes', {account, n})` una vez
-- por cuenta y por sentencia, y el worker residente brain-windows
-- (mcp-server/src/jobs/brain-windows.ts, Deployment `brain-windows`) escucha
-- ese canal y recalcula la cuenta. La base es la única fuente que ve a TODOS los
-- escritores (whatsapp-web, telegram-sync, voz, history sync): el mismo motivo
-- de la 024, cuyo canal `socialmedia_changes` no se toca (filtra whatsapp y
-- tiene su consumidor en apps/whatsapp).
--
-- Solo avisan las filas cuyo `updated_at` movió esta transacción: lo pone NOW()
-- el INSERT (default) y trg_brain_message_updated_at (016) en un UPDATE de
-- content / is_deleted / is_edited, que es justo lo que lee el cursor. Un acuse
-- de entrega no despierta a nadie. NOTIFY sale tras el COMMIT y no es durable:
-- el worker hace una pasada por cursor al arrancar y al reconectar, así que un
-- aviso perdido retrasa una ventana, no la pierde.
--
-- Y el backoff del LLM (criterio 3): una ventana fallida no vuelve a elegirse
-- hasta `llm_retry_after` (now + min(2^llm_attempts × 10 min, 6 h)).
--
-- EXPAND only, idempotente. brain-windows-lib.ensureBrainWindowsTables repite
-- las dos columnas para que el worker arranque aunque esta migración llegue
-- después (misma postura que 016).

ALTER TABLE brain_windows ADD COLUMN IF NOT EXISTS llm_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE brain_windows ADD COLUMN IF NOT EXISTS llm_retry_after TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION brain_windows_notify_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT account, count(*) AS n FROM brain_windows_new_rows
     WHERE updated_at >= now() GROUP BY account
  LOOP
    BEGIN
      PERFORM pg_notify('brain_windows_changes',
                        jsonb_build_object('account', r.account, 'n', r.n)::text);
    EXCEPTION WHEN OTHERS THEN
      -- Un aviso que falla nunca deshace la escritura del mensaje: el worker lo
      -- recoge en su próxima pasada (aviso de otra sentencia o arranque).
      RAISE WARNING 'brain_windows change notify failed for account %', r.account;
    END;
  END LOOP;
  RETURN NULL;
END;
$$;

-- Dos triggers: una tabla de transición no admite lista de columnas, y así cada
-- uno es un solo evento.
DROP TRIGGER IF EXISTS trg_brain_windows_notify_insert ON messages;
CREATE TRIGGER trg_brain_windows_notify_insert AFTER INSERT ON messages
  REFERENCING NEW TABLE AS brain_windows_new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION brain_windows_notify_change();

DROP TRIGGER IF EXISTS trg_brain_windows_notify_update ON messages;
CREATE TRIGGER trg_brain_windows_notify_update AFTER UPDATE ON messages
  REFERENCING NEW TABLE AS brain_windows_new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION brain_windows_notify_change();
