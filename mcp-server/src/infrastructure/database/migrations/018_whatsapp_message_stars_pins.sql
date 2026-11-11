-- 018 — Starred and pinned WhatsApp messages (fase 3 follow-up, port of the
-- NAS fork's star / unstar and "mensajes fijados" adapted to the multiaccount
-- model of 008).
--
-- Two states of a message that WhatsApp keeps outside the message itself:
--   whatsapp_message_stars — a star is app state of OUR account: the phone,
--                            WhatsApp Web and the connector share the same
--                            "Destacados"; nobody else sees it;
--   whatsapp_message_pins  — a pin is a message (pinInChatMessage) that
--                            everyone in the chat sees, for 24 h, 7 d or 30 d;
--                            WhatsApp shows at most 3 per chat, the newest.
-- Written by the whatsapp-web connector: what it does through
-- POST /api/v1/messages/star and /messages/pin once WhatsApp accepted it, and
-- what the socket tells it — a star from our phone (app-state sync), the
-- starred flag of a history-sync message, a pin / unpin from anyone in the
-- chat. ONE current state per (account, message): nothing is deleted, an
-- unstar / unpin flips the flag and keeps the last details.
--
-- Why tables and not messages.metadata: listing the account's starred
-- messages needs an index, and messages (739 MB, 882k rows, measured 01-10)
-- cannot get one inside migrate.ts's transaction without blocking every
-- writer of messages for the whole build (see 016). Without it the query is
-- a full scan (11.7 s on the replica, 01-10). These tables start empty:
-- creating them and their indexes costs nothing.
--
-- No conversation_id on purpose: the chat of a starred / pinned message is
-- its messages row's (JOIN on wa_message_id, which conversation merges
-- already move), so social_merge_conversation is NOT re-declared and there is
-- no redirect trigger. seen_chat_id is the chat the key named when we learnt
-- it, kept only for a message we never ingested; it is never redirected.
--
-- Ids use the SAME namespacing as messages (accountKey in
-- connectors/whatsapp-web/src/db-writer.ts): wa_message_id joins to
-- messages.wa_message_id. No FK on purpose: a star or a pin can arrive before
-- (or without) its message row.
--
-- EXPAND only, idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF
-- EXISTS). The connector does NOT create these tables: while they are missing
-- (42P01) stars and pins still go to WhatsApp (persisted: false), nothing is
-- recorded, the lists answer empty with persisted: false; re-probed every few
-- minutes, no restart needed.
--
-- NOTE for migrate.ts: the ledger baselines a file whose first table already
-- exists. whatsapp_message_stars must not be created by hand before this
-- runs, or everything below would be skipped.

CREATE TABLE IF NOT EXISTS whatsapp_message_stars (
  account          TEXT NOT NULL,          -- legacy namespace (CONNECTOR_ACCOUNT)
  account_id       TEXT REFERENCES social_accounts(id),
  wa_message_id    TEXT NOT NULL,          -- accountKey(<id of the starred message>)
  seen_chat_id     TEXT NOT NULL,          -- accountKey(<normalised chat jid of the key>)
  from_me          BOOLEAN,                -- the starred message is ours; NULL = unknown
  starred          BOOLEAN NOT NULL,
  starred_at       TIMESTAMPTZ NOT NULL,   -- when the current state (star or unstar) was set
  source           TEXT NOT NULL CHECK (source IN ('connector', 'whatsapp', 'history')),
  actor            TEXT,                   -- who asked the connector (dgx-messages user, MCP caller)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account, wa_message_id)
);

-- "Starred messages of the account", newest star first (the keyset of
-- POST /api/v1/messages/starred).
CREATE INDEX IF NOT EXISTS idx_whatsapp_message_stars_starred
  ON whatsapp_message_stars (account, starred_at DESC, wa_message_id DESC) WHERE starred;

CREATE TABLE IF NOT EXISTS whatsapp_message_pins (
  account               TEXT NOT NULL,          -- legacy namespace (CONNECTOR_ACCOUNT)
  account_id            TEXT REFERENCES social_accounts(id),
  wa_message_id         TEXT NOT NULL,          -- accountKey(<id of the pinned message>)
  seen_chat_id          TEXT NOT NULL,          -- accountKey(<normalised chat jid of the pin>)
  pinned                BOOLEAN NOT NULL,
  pinned_at             TIMESTAMPTZ,            -- WhatsApp time of the current (or last) pin
  expires_at            TIMESTAMPTZ,            -- pinned_at + duration; a pin ends by itself
  duration_seconds      INTEGER,                -- 86400, 604800 or 2592000 as the pin said
  pinned_by             TEXT,                   -- accountKey(<normalised jid>) of the last pin / unpin
  action_wa_message_id  TEXT,                   -- accountKey(<id of the pin / unpin message>)
  action_at             TIMESTAMPTZ NOT NULL,   -- WhatsApp time of the latest action
  source                TEXT NOT NULL CHECK (source IN ('connector', 'whatsapp', 'history')),
  actor                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account, wa_message_id)
);

-- Active pins of the account (a handful); the chat comes from the join.
CREATE INDEX IF NOT EXISTS idx_whatsapp_message_pins_active
  ON whatsapp_message_pins (account, expires_at) WHERE pinned;

-- account_id from (account, 'whatsapp') through the same helper the messages
-- trigger uses.
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

DROP TRIGGER IF EXISTS trg_social_star_account ON whatsapp_message_stars;
CREATE TRIGGER trg_social_star_account BEFORE INSERT
  ON whatsapp_message_stars FOR EACH ROW EXECUTE FUNCTION social_fill_whatsapp_message_mark_account();

DROP TRIGGER IF EXISTS trg_social_pin_account ON whatsapp_message_pins;
CREATE TRIGGER trg_social_pin_account BEFORE INSERT
  ON whatsapp_message_pins FOR EACH ROW EXECUTE FUNCTION social_fill_whatsapp_message_mark_account();
