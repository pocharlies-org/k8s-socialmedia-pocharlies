-- Optional app-side migration. The deployment runner applies this after the
-- shared SocialMedia schema; every statement is additive and idempotent.
-- /api/search filtra content con ILIKE '%q%' (server.mjs); sin índice trigram
-- es un seq scan de ~885k filas y revienta el statement_timeout (57014).
-- Nota: en una BD grande esto bloquea escrituras en messages durante la
-- construcción; en la casa se creó CONCURRENTLY a mano antes de aplicar.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_messages_content_trgm
  ON messages USING gin (content gin_trgm_ops);
