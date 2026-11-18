-- Expand NAS payloads without replacing production merge functions.
-- migrate:always-run
DO $$
BEGIN
  -- Fork table (message_timestamp_ms, no account_id) → declared shape.
  IF to_regclass('whatsapp_message_payloads') IS NOT NULL THEN
    ALTER TABLE whatsapp_message_payloads
      ADD COLUMN IF NOT EXISTS account_id TEXT REFERENCES social_accounts(id);
    ALTER TABLE whatsapp_message_payloads
      ADD COLUMN IF NOT EXISTS wa_timestamp TIMESTAMPTZ;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'whatsapp_message_payloads'
        AND column_name = 'message_timestamp_ms'
    ) THEN
      UPDATE whatsapp_message_payloads
         SET wa_timestamp = to_timestamp(message_timestamp_ms / 1000.0)
       WHERE wa_timestamp IS NULL
         AND message_timestamp_ms IS NOT NULL;
    END IF;
  END IF;
END $$;

UPDATE whatsapp_message_payloads p
SET account_id = s.id
FROM social_accounts s
WHERE p.account_id IS NULL AND s.channel = 'whatsapp' AND s.legacy_namespace = p.account;
