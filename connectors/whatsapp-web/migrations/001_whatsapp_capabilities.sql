-- Durable WhatsApp connector state. This file is safe to apply before either
-- account connector starts; all identities are scoped by account.
CREATE TABLE IF NOT EXISTS whatsapp_message_payloads (
  wa_message_id text PRIMARY KEY,
  account text NOT NULL,
  conversation_id text NOT NULL,
  message_key jsonb NOT NULL,
  message_payload jsonb NOT NULL,
  message_timestamp_ms bigint,
  push_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_message_payloads_chat
  ON whatsapp_message_payloads (account, conversation_id, message_timestamp_ms DESC);

CREATE TABLE IF NOT EXISTS whatsapp_chat_state (
  account text NOT NULL,
  chat_id text NOT NULL,
  archived boolean,
  unread_count integer,
  pinned boolean,
  mute_until bigint,
  starred boolean,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, chat_id)
);

CREATE TABLE IF NOT EXISTS whatsapp_contacts (
  account text NOT NULL,
  jid text NOT NULL,
  phone text,
  name text,
  push_name text,
  avatar_url text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, jid)
);

CREATE TABLE IF NOT EXISTS whatsapp_message_reactions (
  account text NOT NULL,
  target_wa_message_id text NOT NULL,
  reactor_jid text NOT NULL,
  reaction_wa_message_id text,
  emoji text,
  removed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, target_wa_message_id, reactor_jid)
);
