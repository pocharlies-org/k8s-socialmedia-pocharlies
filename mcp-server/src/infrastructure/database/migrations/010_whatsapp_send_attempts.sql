-- 010 — WhatsApp send idempotency (fase 3 / PR-2, port of the NAS fork's
-- send-idempotency adapted to prod) + the retention index PR-1 lacked.
--
-- The whatsapp-web connector records one row per explicit Idempotency-Key
-- (opt-in: callers that send no key never touch this table; sendToken is NOT
-- the key, prod callers reuse a constant one). Lifecycle:
--   prepared → pending (claimed right before the network send) → sent
--   prepared → failed  (error before the send; retryable)
--   pending stays pending when the outcome is unknown (crash / timeout)
-- The raw key is never stored: key_hash = sha256(key). Rows older than
-- WA_SEND_ATTEMPT_RETENTION_DAYS (7) are purged by the connector.
--
-- EXPAND only, idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF
-- EXISTS). The connector does NOT create this table: while it is missing
-- (42P01) the key is ignored and the send goes out without idempotency.
--
-- NOTE for migrate.ts: the ledger baselines a file whose first table already
-- exists. whatsapp_send_attempts must not be created by hand before this runs,
-- or the trigger and the indexes below would be skipped.

CREATE TABLE IF NOT EXISTS whatsapp_send_attempts (
  account      TEXT NOT NULL,                  -- legacy namespace (CONNECTOR_ACCOUNT)
  account_id   TEXT REFERENCES social_accounts(id),
  key_hash     TEXT NOT NULL,                  -- sha256 hex of the Idempotency-Key
  request_hash TEXT NOT NULL,                  -- sha256 of the normalised request
  message_id   TEXT,                           -- WhatsApp id (bare, 3EB0… derived from the key)
  status       TEXT NOT NULL CHECK (status IN ('prepared', 'pending', 'sent', 'failed')),
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account, key_hash)
);

-- Retention purge: DELETE … WHERE account = $1 AND created_at < … LIMIT 5000.
CREATE INDEX IF NOT EXISTS idx_whatsapp_send_attempts_created
  ON whatsapp_send_attempts (account, created_at);

-- account_id from (account, 'whatsapp') through the same helper as messages
-- and 009's payloads. key_hash has no namespace prefix, so the account column
-- decides.
CREATE OR REPLACE FUNCTION social_fill_whatsapp_send_attempt_keys() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE s RECORD;
BEGIN
  IF NEW.account_id IS NULL THEN
    s := social_split_legacy_id(NEW.key_hash, NEW.account, 'whatsapp');
    NEW.account_id := s.account_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_social_send_attempt_keys ON whatsapp_send_attempts;
CREATE TRIGGER trg_social_send_attempt_keys BEFORE INSERT
  ON whatsapp_send_attempts FOR EACH ROW EXECUTE FUNCTION social_fill_whatsapp_send_attempt_keys();

-- 009 shipped whatsapp_message_payloads without retention; the connector now
-- purges rows older than DURABLE_PAYLOAD_RETENTION_DAYS (90) the same way.
CREATE INDEX IF NOT EXISTS idx_whatsapp_message_payloads_created
  ON whatsapp_message_payloads (account, created_at);
