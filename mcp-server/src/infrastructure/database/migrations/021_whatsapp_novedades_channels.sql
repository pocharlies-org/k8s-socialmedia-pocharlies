-- 021 — WhatsApp channels (newsletters) an account follows (SKIRM-106, F4c)
--
-- Baileys 7.0.0-rc13 has no query for the channels an account follows. The
-- connector's `GET /channels` therefore builds its list from candidates: the
-- chats of a history sync, the conversations that already hold a channel post
-- and the look-ups and follows of the running process; each candidate is then
-- confirmed with WhatsApp (the account's role in the channel's own metadata).
-- A channel that is followed, has no post in `messages` and was looked up by a
-- process that has since restarted is no candidate any more, so it dropped out
-- of the list although the account still follows it.
--
-- This table is that memory and nothing more: one row per channel the
-- connector saw its account follow, written when a look-up or a follow
-- confirms it and deleted when WhatsApp confirms the account no longer follows
-- it. It is not the answer: every row is confirmed again on each listing, so a
-- stale row never lists a channel that is not followed.
--   account     — legacy namespace of the connector (CONNECTOR_ACCOUNT:
--                 personal, professional, leila); with channel_jid the key;
--   account_id  — social_accounts id of (account, 'whatsapp'), filled by the
--                 trigger below as 019 does;
--   channel_jid — `<digits>@newsletter`, bare (no account prefix);
--   created_at  — when it was first remembered.
--
-- No FK to conversations or messages (a followed channel may have neither) and
-- no index beyond the primary key. EXPAND only and idempotent (IF NOT EXISTS /
-- CREATE OR REPLACE / DROP TRIGGER IF EXISTS); no backfill and no DDL on any
-- existing table. The connector does NOT create this table: while it is
-- missing (42P01) it logs once, remembers nothing and asks again every few
-- minutes, so the order connector / migration does not matter.
--
-- NOTE for migrate.ts: the ledger baselines a file whose first table already
-- exists. whatsapp_novedades_channels must not be created by hand before this
-- runs.

CREATE TABLE IF NOT EXISTS whatsapp_novedades_channels (
  account      TEXT NOT NULL,
  account_id   TEXT REFERENCES social_accounts(id),
  channel_jid  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account, channel_jid)
);

CREATE OR REPLACE FUNCTION social_fill_whatsapp_channel_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE s RECORD;
BEGIN
  IF NEW.account_id IS NULL THEN
    s := social_split_legacy_id(NEW.channel_jid, NEW.account, 'whatsapp');
    NEW.account_id := s.account_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_social_whatsapp_channel_account ON whatsapp_novedades_channels;
CREATE TRIGGER trg_social_whatsapp_channel_account BEFORE INSERT
  ON whatsapp_novedades_channels FOR EACH ROW
  EXECUTE FUNCTION social_fill_whatsapp_channel_account();
