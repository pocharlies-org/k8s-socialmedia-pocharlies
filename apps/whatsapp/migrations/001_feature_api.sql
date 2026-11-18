-- Optional app-side migration. The deployment runner applies this after the
-- shared SocialMedia schema; every statement is additive and idempotent.

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_account_chat_time
  ON messages (account, conversation_id, wa_timestamp DESC)
  WHERE platform = 'whatsapp' AND NOT is_deleted;

CREATE INDEX IF NOT EXISTS idx_whatsapp_attachments_account_chat
  ON attachments (message_id);

-- This table is reserved for deployments that prefer PostgreSQL app state.
-- The default app store remains the atomic /data/app-state.json file so a
-- schema upgrade cannot make local favorites unavailable.
CREATE TABLE IF NOT EXISTS whatsapp_app_state (
  account text PRIMARY KEY,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
