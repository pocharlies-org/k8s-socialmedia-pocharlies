-- 040 — Telegram send idempotency (DGX-1235 B2 (i), contract
-- http.telegram-connector.send-idempotency.v1), the Telegram twin of 010.
--
-- The telegram connector records one row per explicit Idempotency-Key (opt-in:
-- a send without a key never touches this table). Lifecycle:
--   prepared → pending (claimed right before the network send) → sent
--   prepared → failed  (Telegram refused the send: nothing went out; retryable)
--   pending stays pending when the outcome is unknown (crash / timeout)
-- The raw key is never stored: key_hash = sha256(key). Unlike WhatsApp, a send
-- with a key and no reachable table is refused (503), never sent without it.
--
-- EXPAND only, idempotent (IF NOT EXISTS). The connector does NOT create it.

CREATE TABLE IF NOT EXISTS telegram_send_attempts (
  account      TEXT NOT NULL,                  -- CONNECTOR_ACCOUNT of the connector
  key_hash     TEXT NOT NULL,                  -- sha256 hex of the Idempotency-Key
  request_hash TEXT NOT NULL,                  -- sha256 of the normalised request
  message_id   TEXT,                           -- Telegram message id once sent
  status       TEXT NOT NULL CHECK (status IN ('prepared', 'pending', 'sent', 'failed')),
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account, key_hash)
);

CREATE INDEX IF NOT EXISTS idx_telegram_send_attempts_created
  ON telegram_send_attempts (account, created_at);
