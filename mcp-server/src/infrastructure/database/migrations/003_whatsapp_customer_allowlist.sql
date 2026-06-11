-- 003: Shopify customer -> WhatsApp professional allowlist.
--
-- This is an internal operational allowlist. It records Shopify customers whose
-- phones should be known to the professional WhatsApp connector, plus the result
-- of the Baileys contact seed / trusted-contact-token probe. It does not imply
-- that WhatsApp will permit an automated first 1:1 message.

CREATE TABLE IF NOT EXISTS whatsapp_customer_allowlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account TEXT NOT NULL DEFAULT 'professional',
  phone_e164 TEXT NOT NULL,
  wa_jid TEXT NOT NULL,
  shopify_customer_id TEXT,
  shop TEXT,
  email TEXT,
  display_name TEXT,
  status TEXT NOT NULL CHECK (
    status IN (
      'ready',
      'seeded_missing_token',
      'not_on_whatsapp',
      'invalid_phone',
      'probe_failed'
    )
  ),
  token_status TEXT NOT NULL DEFAULT 'unknown' CHECK (
    token_status IN (
      'unknown',
      'has_token',
      'missing_token',
      'not_on_whatsapp',
      'error'
    )
  ),
  last_probe_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (phone_e164 ~ '^\+[0-9]{8,15}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_customer_allowlist_account_phone
  ON whatsapp_customer_allowlist (account, phone_e164);

CREATE INDEX IF NOT EXISTS idx_whatsapp_customer_allowlist_shopify_customer
  ON whatsapp_customer_allowlist (shopify_customer_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_customer_allowlist_status
  ON whatsapp_customer_allowlist (account, status, updated_at DESC);
