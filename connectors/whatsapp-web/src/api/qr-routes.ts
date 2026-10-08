import express from 'express';
import type { BaileysClient } from '../baileys-client';
import type { EventPublisher } from '../events/publisher';
import type { QRHandler } from '../qr-handler';

export interface QrRouterDeps {
  qrHandler: QRHandler;
  client: Pick<BaileysClient, 'getStatus' | 'renewQR'>;
  eventPublisher: Pick<EventPublisher, 'isConnected'>;
  sessionPath: string;
  /** ALLOW_WEB_RENEW: the "Generate new QR" button and POST /qr/renew. */
  allowWebRenew: boolean;
}

/**
 * The human-facing pairing pages and the liveness probe: /qr, /qr/page, /qr/renew
 * and /status. No connector credential on purpose — on the LAN hosts they sit
 * behind sso-chain, and dgx-infra probes /status without one. Moved here from
 * main.ts unchanged (SKIRM-103) so they can be exercised without starting Baileys.
 */
export function createQrRouter({
  qrHandler,
  client,
  eventPublisher,
  sessionPath,
  allowWebRenew,
}: QrRouterDeps): express.Router {
  const router = express.Router();

  // Live QR endpoint — serves QR as PNG image from memory
  router.get('/qr', (_req, res) => {
    const qrData = qrHandler.getCurrentQR();
    if (qrData) {
      const base64Data = qrData.qrCode.replace(/^data:image\/png;base64,/, '');
      const imgBuffer = Buffer.from(base64Data, 'base64');
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.send(imgBuffer);
    } else {
      res.status(404).json({
        status: 'no_qr',
        message: 'No QR available — already connected or waiting for generation',
      });
    }
  });

  // QR page — smart page that polls /status and stops on connection
  router.get('/qr/page', (_req, res) => {
    const renewButton = allowWebRenew
      ? `<button id="renew-btn" onclick="renewQr()">Generate new QR</button>
  <p id="renew-msg" class="waiting"></p>`
      : '';
    const renewScript = allowWebRenew
      ? `<script>
async function renewQr() {
  if (!confirm('Generate a new QR? This restarts the WhatsApp connection.')) return;
  const btn = document.getElementById('renew-btn');
  const msg = document.getElementById('renew-msg');
  btn.disabled = true; msg.textContent = 'Regenerating QR...';
  try {
    const r = await fetch('/qr/renew', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    msg.textContent = r.ok ? 'New QR coming in a few seconds — scan it.' : ('Error: ' + (d.error || r.status));
  } catch (e) { msg.textContent = 'Error: ' + e; }
  setTimeout(() => { btn.disabled = false; }, 8000);
}
</script>`
      : '';
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html><head><title>WhatsApp QR</title>
<style>
body{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#111;color:#fff;font-family:sans-serif;flex-direction:column}
img{width:400px;height:400px;border:4px solid #25D366;border-radius:8px}
.connected{color:#25D366;font-size:2em;padding:20px;border:3px solid #25D366;border-radius:12px}
.waiting{color:#666;font-size:1.2em}
button{margin-top:18px;padding:12px 22px;font-size:1.05em;color:#fff;background:#25D366;border:none;border-radius:8px;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
</style>
<script>
async function checkStatus() {
  try {
    const res = await fetch('/status');
    const data = await res.json();
    if (data.connected) {
      document.getElementById('qr-section').style.display = 'none';
      document.getElementById('connected-section').style.display = 'block';
      return;
    }
  } catch(e) {}
  document.getElementById('qr-img').src = '/qr?' + Date.now();
  setTimeout(checkStatus, 3000);
}
window.onload = checkStatus;
</script>
</head><body>
<div id="qr-section">
  <h2>Scan with WhatsApp</h2>
  <img id="qr-img" src="/qr" onerror="this.style.opacity='0.3'" />
  <p class="waiting">Waiting for scan... (auto-refreshes every 3s)</p>
  ${renewButton}
</div>
<div id="connected-section" style="display:none">
  <p class="connected">WhatsApp Connected!</p>
  <p>Session is saved. You can close this page.</p>
</div>
${renewScript}
</body></html>`);
  });

  // Manual QR renew (LAN-only pages; gated by ALLOW_WEB_RENEW). Lets a human force
  // a fresh QR when the socket is wedged/INITIALIZING instead of waiting for the
  // watchdog. Same effect as MCP social_manage_session(action=renewQr) but without the HMAC secret, so it
  // MUST stay disabled on the internet-exposed personal connector.
  router.post('/qr/renew', async (_req, res) => {
    if (!allowWebRenew) {
      res.status(403).json({ error: 'Web renew disabled (set ALLOW_WEB_RENEW=true)' });
      return;
    }
    try {
      console.log('Manual QR renew requested via web button');
      qrHandler.clearQR();
      await client.renewQR();
      res.json({ ok: true, message: 'Renewing — new QR will appear shortly.' });
    } catch (e) {
      console.error('Manual QR renew failed:', e);
      res.status(500).json({ error: String(e) });
    }
  });

  // Status endpoint
  router.get('/status', (_req, res) => {
    res.json({
      ...client.getStatus(),
      natsConnected: eventPublisher.isConnected(),
      session_path: sessionPath,
    });
  });

  return router;
}
