-- INFRA-367 (P1b): candidatos bot/difusión para chat-kinds.json. SOLO LECTURA.
-- Uso: psql -d whatsappmcp -v ON_ERROR_STOP=1 -f scripts/sql/brain-windows-chat-candidates.sql
-- Cuenta con la regla 4 del contrato: is_deleted=false AND btrim(content)<>''.
-- Esquema: migraciones 001/002 + columna platform usada por mcp-server/src/jobs/brain-ingest-lib.ts.
SET default_transaction_read_only = on;

-- 1) Los 60 chats de mayor volumen con señales de bot/difusión.
--    senders=1 o top_sender_share ~1.0 => monólogo (bot/difusión).
--    inbound_share ~1.0 => solo recibimos (alertas); ~0 => solo emitimos (difusión propia).
WITH m AS (
  SELECT m.platform, m.account, m.conversation_id, m.sender_wa_id, m.direction,
         m.content, m.wa_timestamp,
         count(*) OVER (PARTITION BY m.platform, m.account, m.conversation_id, m.sender_wa_id) AS sender_cnt
  FROM messages m
  WHERE m.is_deleted = false AND btrim(m.content) <> ''
)
SELECT m.platform, m.account, m.conversation_id, c.name AS conversation_name, c.type,
       count(*)                                                AS msgs,
       count(DISTINCT m.sender_wa_id)                          AS senders,
       round(max(m.sender_cnt)::numeric / count(*), 2)         AS top_sender_share,
       round(avg(length(m.content)))                           AS avg_len,
       round(avg((m.direction = 'INBOUND')::int), 2)           AS inbound_share,
       min(m.wa_timestamp)::date AS first_day, max(m.wa_timestamp)::date AS last_day
FROM m JOIN conversations c ON c.id = m.conversation_id
GROUP BY m.platform, m.account, m.conversation_id, c.name, c.type
ORDER BY msgs DESC
LIMIT 60;

-- 2) Los chats que Dani nombró (puede devolver 0 filas: se explica en el informe).
SELECT c.id AS conversation_id, c.name, c.type, c.account
FROM conversations c
WHERE c.name ~* '(synapse monitor|alertas monitoring|skirmshop es op|pocharlies operations|ofertas chollos)';
