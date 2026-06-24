CREATE TABLE IF NOT EXISTS unread_digest_sessions (
  id UUID PRIMARY KEY,
  account TEXT NOT NULL,
  platforms TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  chat_queue JSONB NOT NULL DEFAULT '[]'::jsonb,
  next_index INTEGER NOT NULL DEFAULT 0,
  batch_size INTEGER NOT NULL DEFAULT 5,
  message_limit INTEGER NOT NULL DEFAULT 30,
  language TEXT NOT NULL DEFAULT 'es',
  partial_summaries JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'in_progress',
  global_summary TEXT,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_unread_digest_sessions_status_updated
  ON unread_digest_sessions (status, updated_at DESC);
