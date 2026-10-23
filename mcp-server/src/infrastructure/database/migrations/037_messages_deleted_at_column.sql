-- SKIRM-257: the deployed message table was created by hand without 001's
-- deleted_at, and 038 backfills that column. Expand the house schema to 001's
-- shape before 038 instead of editing 038; revocations stay authoritative in
-- metadata->>'deleted_at', which every reader prefers over the column.
SET LOCAL lock_timeout = '10s';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
