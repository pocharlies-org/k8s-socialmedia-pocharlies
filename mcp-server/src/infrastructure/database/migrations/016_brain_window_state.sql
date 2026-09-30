-- INFRA-370 (P4): state of the conversation-window builder (contract v1, INFRA-364).
-- brain_window_state: one row per window pushed (or to push); hashes make the
-- job idempotent and resumable (same window_hash => no re-push; llm_json kept
-- => no second LLM call). brain_window_cursor: per-account keyset over
-- messages (created_at, id), the same shape as brain_ingest_cursor.
CREATE TABLE IF NOT EXISTS brain_window_state (
  window_id        text        PRIMARY KEY,
  account          text        NOT NULL,
  platform         text        NOT NULL,
  conversation_id  text        NOT NULL,
  first_msg_id     text        NOT NULL,
  last_msg_id      text        NOT NULL,
  start_ts         timestamptz NOT NULL,
  end_ts           timestamptz NOT NULL,
  msg_count        integer     NOT NULL,
  window_hash      text        NOT NULL,
  kind             text        NOT NULL DEFAULT 'chat',
  pushed_hash      text,
  pushed_at        timestamptz,
  llm_status       text        NOT NULL DEFAULT 'pending'
                   CHECK (llm_status IN ('pending', 'done', 'skipped')),
  llm_input_hash   text,
  llm_json         jsonb,
  packet_hash      text,
  push_error       text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_brain_window_state_chat
  ON brain_window_state (account, conversation_id, start_ts);
CREATE INDEX IF NOT EXISTS idx_brain_window_state_pending
  ON brain_window_state (account, end_ts DESC) WHERE llm_status = 'pending';

CREATE TABLE IF NOT EXISTS brain_window_cursor (
  account          text        PRIMARY KEY,
  last_created_at  timestamptz NOT NULL,
  last_id          text        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
