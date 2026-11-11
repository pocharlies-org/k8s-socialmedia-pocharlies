-- CONTRACT: db.whatsapp-message-receipts.v1
-- Additive receipt storage; deliberately no historical membership backfill.
SET LOCAL lock_timeout = '10s';
SET LOCAL TIME ZONE 'UTC';

CREATE TABLE IF NOT EXISTS whatsapp_message_receipt_state (
  account text NOT NULL, chat_id text NOT NULL, message_id text NOT NULL,
  recipients jsonb, aggregate_status text, observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, chat_id, message_id)
);
CREATE TABLE IF NOT EXISTS whatsapp_message_receipts (
  account text NOT NULL, chat_id text NOT NULL, message_id text NOT NULL,
  participant_id text NOT NULL, aliases text[] NOT NULL, name text,
  delivered_at timestamptz, read_at timestamptz, played_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, chat_id, message_id, participant_id)
);

-- Captured outbound payloads prove a send, never delivery or current membership.
UPDATE messages m SET status='sent', status_at=COALESCE(m.status_at,now())
FROM whatsapp_message_payloads p
WHERE m.platform='whatsapp' AND m.direction='OUTBOUND' AND m.status IS NULL
  AND NOT COALESCE(m.is_deleted,FALSE)
  AND p.account=m.account AND p.wa_message_id=m.wa_message_id
  AND p.message_key->>'fromMe'='true'
  AND p.message_payload IS NOT NULL AND p.message_payload <> '{}'::jsonb;

-- Older revoke handlers recorded the detection time only in metadata. Preserve it
-- when it is a valid ISO timestamp, without substituting migration time.
UPDATE messages m SET deleted_at = CASE
  WHEN pg_input_is_valid(m.metadata->>'deleted_at', 'timestamp with time zone')
  THEN (m.metadata->>'deleted_at')::timestamptz ELSE NULL END
WHERE m.platform='whatsapp' AND COALESCE(m.is_deleted,FALSE) AND m.deleted_at IS NULL
  AND m.metadata->>'deleted_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
  AND pg_input_is_valid(m.metadata->>'deleted_at', 'timestamp with time zone');
