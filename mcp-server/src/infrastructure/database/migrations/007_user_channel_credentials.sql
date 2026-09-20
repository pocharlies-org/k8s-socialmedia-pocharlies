-- SC-552: single per-user credential store (CTO ruling 13-09-2026: ONE store
-- keyed by the JWT `sub` the gateway verifies, with one adapter per channel —
-- baileys/WhatsApp, mtcute/Telegram, Graph-token/Instagram — NOT three
-- parallel stores). The payload is an opaque per-channel jsonb blob; the
-- channel adapters (src/infrastructure/session-store/adapters/) own its shape.
-- Idempotent like every other migration here (re-run is a no-op).
CREATE TABLE IF NOT EXISTS user_channel_credentials (
  session_key TEXT NOT NULL,
  channel TEXT NOT NULL,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_key, channel)
);
