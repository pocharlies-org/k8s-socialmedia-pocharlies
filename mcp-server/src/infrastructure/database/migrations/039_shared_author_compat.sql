-- migrate:always-run
-- Compatibility bootstrap for the author's released 021-023 migrations.
-- The runner records those source files by their full filename and checksum,
-- but does not execute their incompatible CREATE TABLE/VIEW bodies.
-- This migration is additive and runs in the runner before 034 so its tables
-- are available when Hindsight installs row triggers.

-- Materialize the author's read-only view into the durable connector table.
-- The surrounding transaction makes the replacement atomic; no source row is
-- deleted and duplicate/null keys abort before the view is dropped.
DO $$
DECLARE kind "char";
BEGIN
  SELECT c.relkind INTO kind
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'whatsapp_contacts';
  IF kind = 'v' THEN
    CREATE TABLE whatsapp_contacts_compat_materialized (
      account text NOT NULL,
      jid text NOT NULL,
      phone text,
      name text,
      push_name text,
      avatar_url text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account, jid)
    );
    CREATE TEMP TABLE whatsapp_contacts_author_rows ON COMMIT DROP AS
      SELECT account, jid, name, push_name, COALESCE(updated_at, now()) AS updated_at
      FROM whatsapp_contacts;
    DROP VIEW whatsapp_contacts;
    INSERT INTO whatsapp_contacts_compat_materialized(account, jid, name, push_name, updated_at)
      SELECT account, jid, name, push_name, updated_at
      FROM whatsapp_contacts_author_rows;
    ALTER TABLE whatsapp_contacts_compat_materialized RENAME TO whatsapp_contacts;
  END IF;
END $$;

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
ALTER TABLE whatsapp_contacts ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE whatsapp_contacts ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE whatsapp_contacts ADD COLUMN IF NOT EXISTS push_name text;
ALTER TABLE whatsapp_contacts ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE whatsapp_contacts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS whatsapp_novedades_channels (
  account text NOT NULL,
  account_id text REFERENCES social_accounts(id),
  channel_jid text NOT NULL,
  name text,
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
ALTER TABLE whatsapp_novedades_channels ADD COLUMN IF NOT EXISTS account_id text;
ALTER TABLE whatsapp_novedades_channels ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE whatsapp_novedades_channels ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE whatsapp_novedades_channels ADD COLUMN IF NOT EXISTS owner_jid text;
ALTER TABLE whatsapp_novedades_channels ADD COLUMN IF NOT EXISTS role text;
ALTER TABLE whatsapp_novedades_channels ADD COLUMN IF NOT EXISTS verification text;
ALTER TABLE whatsapp_novedades_channels ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE whatsapp_novedades_channels ADD COLUMN IF NOT EXISTS invite_code text;
ALTER TABLE whatsapp_novedades_channels ADD COLUMN IF NOT EXISTS subscriber_count integer;
ALTER TABLE whatsapp_novedades_channels ADD COLUMN IF NOT EXISTS creation_timestamp_ms bigint;
ALTER TABLE whatsapp_novedades_channels ADD COLUMN IF NOT EXISTS mute_state text;
ALTER TABLE whatsapp_novedades_channels ADD COLUMN IF NOT EXISTS raw_metadata jsonb;
ALTER TABLE whatsapp_novedades_channels ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE whatsapp_novedades_channels ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION social_fill_whatsapp_channel_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE s RECORD;
BEGIN
  IF NEW.name IS NULL THEN NEW.name := NEW.channel_jid; END IF;
  IF NEW.account_id IS NULL THEN
    s := social_split_legacy_id(NEW.channel_jid, NEW.account, 'whatsapp');
    NEW.account_id := s.account_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_social_whatsapp_channel_account ON whatsapp_novedades_channels;
CREATE TRIGGER trg_social_whatsapp_channel_account BEFORE INSERT OR UPDATE OF channel_jid, account
  ON whatsapp_novedades_channels FOR EACH ROW
  EXECUTE FUNCTION social_fill_whatsapp_channel_account();

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_chat_time_author
  ON messages (account, conversation_id, wa_timestamp DESC)
  WHERE platform = 'whatsapp';
CREATE INDEX IF NOT EXISTS idx_participants_account_jid_author
  ON participants (account, (CASE WHEN position(':' IN id) > 0 THEN split_part(id, ':', 2) ELSE id END));
