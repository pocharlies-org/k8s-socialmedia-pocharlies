-- 004: Manual WhatsApp first-contact handoff queue.
--
-- Baileys cannot reliably create a brand new 1:1 chat when WhatsApp Web does
-- not provide a trusted-contact token. This queue stores the compliant manual
-- fallback: open a wa.me compose URL in the official WhatsApp app/Web session,
-- then let a human press send.

CREATE TABLE IF NOT EXISTS whatsapp_manual_open_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account TEXT NOT NULL DEFAULT 'professional',
  phone_e164 TEXT NOT NULL,
  wa_jid TEXT NOT NULL,
  display_name TEXT,
  message_text TEXT NOT NULL DEFAULT '',
  manual_open_url TEXT NOT NULL,
  source TEXT,
  source_ref TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'opened', 'sent', 'cancelled', 'failed')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_opened_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  completed_by TEXT,
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (phone_e164 ~ '^\+[0-9]{8,15}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_manual_open_account_idempotency
  ON whatsapp_manual_open_requests (account, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_manual_open_status
  ON whatsapp_manual_open_requests (account, status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_whatsapp_manual_open_phone
  ON whatsapp_manual_open_requests (account, phone_e164, created_at DESC);
