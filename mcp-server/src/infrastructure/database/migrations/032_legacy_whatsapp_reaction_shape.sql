-- Expand the fork reaction table before installing the unchanged prod 011 body.
ALTER TABLE whatsapp_message_reactions ADD COLUMN IF NOT EXISTS account_id text REFERENCES social_accounts(id);
ALTER TABLE whatsapp_message_reactions ADD COLUMN IF NOT EXISTS reactor_seen_jid text;
ALTER TABLE whatsapp_message_reactions ADD COLUMN IF NOT EXISTS conversation_id text;
ALTER TABLE whatsapp_message_reactions ADD COLUMN IF NOT EXISTS from_me boolean;
ALTER TABLE whatsapp_message_reactions ADD COLUMN IF NOT EXISTS reacted_at timestamptz;
ALTER TABLE whatsapp_message_reactions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
UPDATE whatsapp_message_reactions r SET conversation_id=m.conversation_id
  FROM messages m WHERE r.conversation_id IS NULL AND m.account=r.account AND m.wa_message_id=r.target_wa_message_id;
UPDATE whatsapp_message_reactions r SET account_id=a.id
  FROM social_accounts a WHERE r.account_id IS NULL AND a.channel='whatsapp' AND a.legacy_namespace=r.account;
-- Missing history targets stay nullable until ingestion supplies their chat.
