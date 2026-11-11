-- 016 — Ventanas de conversación para el brain (INFRA-364, ADR 0002 §6).
--
-- The per-message brain-ingest is replaced by hourly conversation windows. The
-- incremental pass needs to see messages that CHANGE after they were written
-- (edits, deletions, voice notes transcribed hours later, history syncs that
-- land days late), which the `created_at` keyset cursor of brain-ingest could
-- not see. That needs `messages.updated_at` + a trigger.
--
-- EXPAND only. Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF
-- EXISTS). The heavy index on `messages` is NOT here: migrate.ts runs each file
-- inside a transaction, where CREATE INDEX CONCURRENTLY is impossible, and
-- `messages` is 879k rows on a database shared by dozens of services. It is
-- created CONCURRENTLY (no write lock) by ensureBrainWindowsIndexes() in
-- mcp-server/src/jobs/brain-windows-lib.ts, which every brain-windows job runs
-- before it scans — the same split 008 uses for its UNIQUE indexes
-- (multiaccount-backfill.ts). The indexes below ride on brand-new empty tables
-- and cost nothing inside the transaction.
--
-- ADD COLUMN ... NOT NULL DEFAULT now() does NOT rewrite the table on
-- PostgreSQL >= 11 (attmissingval), which is exactly what ADR 0002 §6 relies
-- on. The trigger fires only for UPDATEs that touch one of the three columns
-- the brain cares about (ADR 0002 §6): content (transcriptions land here),
-- is_deleted (tombstones) and is_edited.

-- ALTER TABLE ... ADD COLUMN and CREATE TRIGGER take a brief ACCESS EXCLUSIVE
-- lock on messages; both are metadata-only operations (no rewrite, no scan).
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE OR REPLACE FUNCTION brain_touch_message_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_brain_message_updated_at ON messages;
CREATE TRIGGER trg_brain_message_updated_at BEFORE UPDATE OF content, is_deleted, is_edited
  ON messages FOR EACH ROW EXECUTE FUNCTION brain_touch_message_updated_at();

-- One row per pushed window PART (ADR 0002 §1: a session cut by the 16k cap
-- produces win:{key}, win:{key}:p1...). This is the diff ledger: the builder
-- recomputes windows for the affected chats and compares content_hash against
-- what is here; rows that disappear are deleted from the brain (parent +
-- children) and from here.
CREATE TABLE IF NOT EXISTS brain_windows (
  source_id        TEXT PRIMARY KEY,            -- win:{platform}:{account}:{conv}:{epoch}[:pN]
  account          TEXT NOT NULL,               -- DB namespace (personal|professional|leila)
  platform         TEXT NOT NULL,               -- whatsapp|telegram|instagram
  conversation_id  TEXT NOT NULL,               -- canonical (COALESCE(merged_into, id))
  window_key       TEXT NOT NULL,               -- without the win: prefix, without :pN
  part             INTEGER NOT NULL DEFAULT 0,  -- 0 = unsplit window, 1..N = window part
  start_ts         TIMESTAMPTZ NOT NULL,
  end_ts           TIMESTAMPTZ NOT NULL,
  message_count    INTEGER NOT NULL,
  first_message_id BIGINT NOT NULL,
  last_message_id  BIGINT NOT NULL,
  conv_kind        TEXT NOT NULL,               -- chat|group|channel|bot (ADR 0002 §3)
  content_hash     TEXT NOT NULL,               -- sha256 over the rendered window
  pushed_hash      TEXT,                        -- content_hash as last successfully pushed
  pushed_at        TIMESTAMPTZ,
  chunk_count      INTEGER NOT NULL DEFAULT 0,  -- children pushed with this parent (#c1..#cN)
  llm_status       TEXT NOT NULL DEFAULT 'pending',  -- pending|done|skipped|failed (ADR 0002 §5)
  llm_input_hash   TEXT,                        -- checkpoint: same input → no new LLM call
  llm_done_at      TIMESTAMPTZ,
  llm_error        TEXT,
  -- ADR 0002 §5 feeds the previous window's summary to the LLM as context.
  -- The summary lives in the pushed document's metadata; re-reading the brain
  -- from the job would need a read API the ingest surface does not have, so
  -- the summary is also kept on the row. (Extra column relative to §6.)
  llm_summary      TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "Which windows does this chat have?" — the per-chat diff, and the LLM
-- context lookup (previous summary of the same chat).
CREATE INDEX IF NOT EXISTS idx_brain_windows_chat
  ON brain_windows (account, platform, conversation_id, start_ts);

-- "Closed windows waiting for the LLM, newest first" (backfill phase 3 and the
-- incremental pass).
CREATE INDEX IF NOT EXISTS idx_brain_windows_llm_pending
  ON brain_windows (llm_status, end_ts DESC)
  WHERE llm_status IN ('pending', 'failed');

-- Incremental cursor (ADR 0002 §6): keyset over (account, updated_at, id), the
-- same shape as brain_ingest_cursor but on the new column.
CREATE TABLE IF NOT EXISTS brain_windows_cursor (
  account         TEXT PRIMARY KEY,
  last_updated_at TIMESTAMPTZ NOT NULL,
  last_id         BIGINT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Resume pointers for the reindex Jobs (ADR 0002 §9 phases 2 and 3), keyed by
-- RUN_ID so a second run never collides with an abandoned one. Not in the ADR
-- table list: the backfill has to be resumable across Job restarts the same
-- way brain-replay made its cursor per-run (brain_ingest_replay_cursor).
CREATE TABLE IF NOT EXISTS brain_windows_backfill_cursor (
  run_id               TEXT NOT NULL,
  phase                TEXT NOT NULL,           -- push | llm
  last_account         TEXT,
  last_platform        TEXT,
  last_conversation_id TEXT,                    -- phase=push: chats processed, keyset
  last_end_ts          TIMESTAMPTZ,             -- phase=llm: windows processed, keyset
  last_source_id       TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, phase)
);
