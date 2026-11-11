-- Additive Novedades persistence (WhatsApp channels + statuses), 2026-09-27.
-- Purely additive: no pre-existing table is read, altered, or dropped, and no
-- historical row is rewritten. Identities are raw text ids scoped by account
-- (account is part of every primary key, so ids are NOT accountKey-prefixed).
-- Safe to apply before either account connector starts; mirrors
-- ensureNovedadesTables() in src/novedades-store.ts.

-- Directory of followed channels (channel metadata normalized + preserved).
CREATE TABLE IF NOT EXISTS whatsapp_novedades_channels (
  account text NOT NULL,
  channel_jid text NOT NULL,
  name text NOT NULL,
  description text,
  owner_jid text,
  role text,
  verification text,
  avatar_url text,
  invite_code text,
  subscriber_count integer,
  creation_timestamp_ms bigint,
  mute_state text,
  raw_metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, channel_jid)
);

-- Channel posts. Newsletter ids are only unique per channel (validated on
-- Baileys 7.0.0-rc13), hence the channel-scoped composite key instead of the
-- global account+id key of whatsapp_message_payloads. superseded_by archives a
-- duplicate id-row after client/server reconciliation without ever deleting
-- its original key/payload.
CREATE TABLE IF NOT EXISTS whatsapp_novedades_messages (
  account text NOT NULL,
  channel_jid text NOT NULL,
  message_id text NOT NULL,
  server_id text,
  client_id text,
  superseded_by text,
  from_me boolean NOT NULL DEFAULT false,
  message_key jsonb NOT NULL,
  message_payload jsonb,
  message_timestamp_ms bigint,
  message_type text,
  visibility text NOT NULL DEFAULT 'unknown',
  author_jid text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_deleted boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, channel_jid, message_id)
);

-- One server-confirmed and one locally-created id may name the same post; the
-- reconcile flow keeps exactly one live row per identity per channel (archived
-- rows are exempt so the alias stays free for the live row).
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_novedades_messages_server_uidx
  ON whatsapp_novedades_messages (account, channel_jid, server_id)
  WHERE server_id IS NOT NULL AND superseded_by IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_novedades_messages_client_uidx
  ON whatsapp_novedades_messages (account, channel_jid, client_id)
  WHERE client_id IS NOT NULL AND superseded_by IS NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_novedades_messages_channel_time
  ON whatsapp_novedades_messages (account, channel_jid, message_timestamp_ms DESC);

-- Author-scoped statuses. The official app expires them 24h after posting, so
-- expiry is stored explicitly (default posted_at + 24h at write time); a row
-- without a posting timestamp stays freshness-unknown (NULL posted_at /
-- expires_at, never active, never pruned). Revokes are soft (is_deleted).
CREATE TABLE IF NOT EXISTS whatsapp_novedades_status (
  account text NOT NULL,
  author_jid text NOT NULL,
  wa_message_id text NOT NULL,
  message_key jsonb NOT NULL,
  message_payload jsonb,
  message_timestamp_ms bigint,
  message_type text,
  visibility text NOT NULL DEFAULT 'unknown',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  posted_at timestamptz,
  expires_at timestamptz,
  is_deleted boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, author_jid, wa_message_id)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_novedades_status_expiry
  ON whatsapp_novedades_status (account, expires_at);

CREATE INDEX IF NOT EXISTS idx_whatsapp_novedades_status_author_time
  ON whatsapp_novedades_status (account, author_jid, posted_at DESC);
