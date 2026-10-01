-- 019 — WhatsApp statuses ("Estados") of the account's contacts and our own
-- (fase 3 follow-up, the store half of the NAS fork's "novedades", adapted to
-- the multiaccount model of 008).
--
-- What already exists, measured on prod (01-10):
--   - statuses already land in `messages`, in the conversation
--     `status@broadcast` of each account (≈4.1k rows since 2026-03-18; 492 of
--     them OUTBOUND = posted from our phone), with their media in
--     `attachments` like any message. dgx-messages lists that conversation as
--     "Estados de WhatsApp";
--   - channel (newsletter) posts land in `messages` too, one conversation per
--     channel (`<id>@newsletter`).
-- So nothing here copies content: the fork's whatsapp_novedades_messages
-- (channel posts) is NOT ported — reading posts is a query over `messages` —
-- and its channel directory is what POST /channels/list (live, #177) answers.
-- What `messages` cannot answer cheaply is "the statuses of the account, of one
-- author, still visible": it has no author+time index for one conversation
-- and no notion of expiry. This table is that index, one row per status:
--   author_id   — the sender as messages.sender_wa_id stores it (namespaced);
--   posted_at   — WhatsApp time of the status;
--   expires_at  — posted_at + 24 h, when WhatsApp stops showing it;
--   audience_size / actor — only for a status published through the
--                 connector (POST /statuses/publish): how many contacts it
--                 went to and who asked.
-- Content, type, media and revokes (is_deleted) stay in `messages`: readers
-- JOIN on wa_message_id. Written by the whatsapp-web connector on ingest
-- (live and history sync) and on publish; purged by its retention
-- (WA_STATUS_RETENTION_DAYS, by posted_at). The `messages` rows are not
-- touched here or there.
--
-- No conversation_id: every row is in its account's status@broadcast, which
-- is never merged. No FK to messages: the status row may be written before
-- its messages row (the publish path).
--
-- EXPAND only, idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF
-- EXISTS / ON CONFLICT DO NOTHING). The connector does NOT create this table:
-- while it is missing (42P01) statuses still land in `messages`, nothing is
-- indexed and the list answers empty with persisted: false; re-probed every
-- few minutes, no restart needed.
--
-- NOTE for migrate.ts: the ledger baselines a file whose first table already
-- exists. whatsapp_statuses must not be created by hand before this runs, or
-- the backfill below would be skipped.

CREATE TABLE IF NOT EXISTS whatsapp_statuses (
  account          TEXT NOT NULL,          -- legacy namespace (CONNECTOR_ACCOUNT)
  account_id       TEXT REFERENCES social_accounts(id),
  wa_message_id    TEXT NOT NULL,          -- accountKey(<status id>) = messages.wa_message_id
  author_id        TEXT NOT NULL,          -- accountKey(<normalised author jid>) = messages.sender_wa_id
  from_me          BOOLEAN NOT NULL DEFAULT FALSE,
  message_type     TEXT,                   -- TEXT, IMAGE, VIDEO or AUDIO (messages.message_type)
  posted_at        TIMESTAMPTZ NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  audience_size    INTEGER,                -- statusJidList size of a status we published
  source           TEXT NOT NULL CHECK (source IN ('live', 'history', 'connector', 'backfill')),
  actor            TEXT,                   -- who asked the connector to publish it
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account, wa_message_id)
);

-- "Recent statuses of the account", newest first (keyset of POST /statuses).
CREATE INDEX IF NOT EXISTS idx_whatsapp_statuses_recent
  ON whatsapp_statuses (account, posted_at DESC, wa_message_id DESC);

-- "Statuses of one contact" (its PN and LID ids), newest first.
CREATE INDEX IF NOT EXISTS idx_whatsapp_statuses_author
  ON whatsapp_statuses (account, author_id, posted_at DESC);

-- account_id from (account, 'whatsapp'): the helper 018 declared (re-declared
-- identical so this file stands alone).
CREATE OR REPLACE FUNCTION social_fill_whatsapp_message_mark_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE s RECORD;
BEGIN
  IF NEW.account_id IS NULL THEN
    s := social_split_legacy_id(NEW.wa_message_id, NEW.account, 'whatsapp');
    NEW.account_id := s.account_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_social_status_account ON whatsapp_statuses;
CREATE TRIGGER trg_social_status_account BEFORE INSERT
  ON whatsapp_statuses FOR EACH ROW EXECUTE FUNCTION social_fill_whatsapp_message_mark_account();

-- Backfill from the statuses `messages` already holds: the status@broadcast
-- conversation of every account (found through `conversations`, ~2.6k rows,
-- then idx_messages_conversation: never a scan of messages). Only real
-- statuses (the conversation also carries sender-key distribution and E2E
-- notification rows). Rows older than the connector's retention are purged
-- by it on its next pass.
INSERT INTO whatsapp_statuses
  (account, account_id, wa_message_id, author_id, from_me, message_type,
   posted_at, expires_at, source)
SELECT m.account, m.account_id, m.wa_message_id, m.sender_wa_id,
       m.direction = 'OUTBOUND', m.message_type,
       m.wa_timestamp, m.wa_timestamp + INTERVAL '24 hours', 'backfill'
  FROM conversations c
  JOIN messages m ON m.conversation_id = c.id
 WHERE (c.external_id = 'status@broadcast' OR c.id = 'status@broadcast'
        OR c.id LIKE '%:status@broadcast')
   AND m.platform = 'whatsapp'
   AND m.message_type IN ('TEXT', 'IMAGE', 'VIDEO', 'AUDIO')
   AND m.wa_timestamp IS NOT NULL
   AND m.sender_wa_id IS NOT NULL
   AND m.sender_wa_id NOT LIKE '%status@broadcast'
ON CONFLICT (account, wa_message_id) DO NOTHING;
