-- INFRA-368 (P2): mailbox of conversations whose text changed after the fact
-- (a late voice-note transcription). `messages` has no updated_at, so the
-- transcribers (WhatsApp wa-voice-transcribe, Telegram complete_transcription)
-- write a row here in the SAME transaction as the UPDATE, and the window
-- builder consumes it (DELETE ... RETURNING). No DDL on `messages`.
CREATE TABLE IF NOT EXISTS brain_window_dirty (
  account         text        NOT NULL,
  conversation_id text        NOT NULL,
  touched_at      timestamptz NOT NULL DEFAULT now(),
  reason          text,
  PRIMARY KEY (account, conversation_id, touched_at)
);
