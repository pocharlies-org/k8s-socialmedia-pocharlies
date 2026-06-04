-- 005: allow the Playwright sender worker to claim rows atomically.

ALTER TABLE whatsapp_manual_open_requests
  DROP CONSTRAINT IF EXISTS whatsapp_manual_open_requests_status_check;

ALTER TABLE whatsapp_manual_open_requests
  DROP CONSTRAINT IF EXISTS chk_whatsapp_manual_open_status;

ALTER TABLE whatsapp_manual_open_requests
  ADD CONSTRAINT chk_whatsapp_manual_open_status CHECK (
    status IN ('pending', 'processing', 'opened', 'sent', 'cancelled', 'failed')
  );
