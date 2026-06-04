import express from 'express';
import pg from 'pg';
import { chromium, BrowserContext, Page } from 'playwright';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://whatsappmcp:whatsappmcp_dgx_2026@postgres:5432/whatsappmcp';
const ACCOUNT = process.env.CONNECTOR_ACCOUNT || 'professional';
const PROFILE_DIR = process.env.WA_OPEN_WORKER_PROFILE_DIR || '/app/browser-profile';
const PORT = parseInt(process.env.PORT || '3005', 10);
const POLL_INTERVAL_MS = parseInt(process.env.WA_OPEN_WORKER_POLL_INTERVAL_MS || '5000', 10);
const LOGIN_RETRY_MS = parseInt(process.env.WA_OPEN_WORKER_LOGIN_RETRY_MS || '60000', 10);
const SEND_SETTLE_MS = parseInt(process.env.WA_OPEN_WORKER_SEND_SETTLE_MS || '5000', 10);
const SEND_TIMEOUT_MS = parseInt(process.env.WA_OPEN_WORKER_SEND_TIMEOUT_MS || '90000', 10);
const PROCESSING_STALE_MINUTES = parseInt(
  process.env.WA_OPEN_WORKER_PROCESSING_STALE_MINUTES || '15',
  10
);
const HEADLESS = process.env.WA_OPEN_WORKER_HEADLESS === 'true';
const DRY_RUN = process.env.WA_OPEN_WORKER_DRY_RUN === 'true';
const CHROME_USER_AGENT =
  process.env.WA_OPEN_WORKER_USER_AGENT ||
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

type ManualOpenStatus = 'pending' | 'processing' | 'opened' | 'sent' | 'cancelled' | 'failed';

interface ManualOpenRow {
  id: string;
  account: string;
  phone_e164: string;
  wa_jid: string;
  display_name: string | null;
  message_text: string;
  manual_open_url: string;
  source: string | null;
  source_ref: string | null;
  status: ManualOpenStatus;
  attempt_count: number;
  last_error: string | null;
  metadata: Record<string, unknown>;
}

class LoginRequiredError extends Error {
  constructor() {
    super('whatsapp_web_login_required');
  }
}

class InvalidRecipientError extends Error {
  constructor(message = 'whatsapp_web_invalid_recipient') {
    super(message);
  }
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });

let context: BrowserContext | null = null;
let page: Page | null = null;
const workerState = {
  status: 'starting',
  loggedIn: false,
  currentRequestId: null as string | null,
  lastError: null as string | null,
  lastSentAt: null as string | null,
  lastScreenshotAt: null as string | null,
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

function phoneDigits(phoneE164: string): string {
  return phoneE164.replace(/\D/g, '');
}

function whatsappWebSendUrl(row: ManualOpenRow): string {
  const phone = phoneDigits(row.phone_e164);
  const text = encodeURIComponent(row.message_text || '');
  return `https://web.whatsapp.com/send?phone=${phone}&text=${text}&app_absent=0`;
}

async function ensureSchema(): Promise<void> {
  await pool.query(`
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
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_opened_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      completed_by TEXT,
      last_error TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (phone_e164 ~ '^\\+[0-9]{8,15}$')
    )
  `);
  await pool.query(`
    ALTER TABLE whatsapp_manual_open_requests
      DROP CONSTRAINT IF EXISTS whatsapp_manual_open_requests_status_check
  `);
  await pool.query(`
    ALTER TABLE whatsapp_manual_open_requests
      DROP CONSTRAINT IF EXISTS chk_whatsapp_manual_open_status
  `);
  await pool.query(`
    ALTER TABLE whatsapp_manual_open_requests
      ADD CONSTRAINT chk_whatsapp_manual_open_status CHECK (
        status IN ('pending', 'processing', 'opened', 'sent', 'cancelled', 'failed')
      )
  `);
}

async function resetStaleProcessing(): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_manual_open_requests
     SET status = 'pending',
         last_error = 'stale processing claim reset by playwright worker',
         updated_at = now()
     WHERE account = $1
       AND status = 'processing'
       AND updated_at < now() - ($2::text || ' minutes')::interval`,
    [ACCOUNT, PROCESSING_STALE_MINUTES]
  );
}

async function claimNextRequest(): Promise<ManualOpenRow | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `WITH next AS (
         SELECT id
         FROM whatsapp_manual_open_requests
         WHERE account = $1
           AND status = 'pending'
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE whatsapp_manual_open_requests r
       SET status = 'processing',
           attempt_count = r.attempt_count + 1,
           last_opened_at = now(),
           last_error = NULL,
           metadata = r.metadata || jsonb_build_object(
             'playwrightWorkerClaimedAt', now(),
             'playwrightWorkerHost', inet_client_addr()
           ),
           updated_at = now()
       FROM next
       WHERE r.id = next.id
       RETURNING r.*`,
      [ACCOUNT]
    );
    await client.query('COMMIT');
    return (result.rows[0] as ManualOpenRow | undefined) || null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function updateRequest(
  id: string,
  status: ManualOpenStatus,
  options: { lastError?: string | null; completedBy?: string | null } = {}
): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_manual_open_requests
     SET status = $3,
         completed_at = CASE WHEN $3 IN ('sent', 'cancelled', 'failed') THEN now() ELSE completed_at END,
         completed_by = COALESCE($4, completed_by),
         last_error = $5,
         metadata = metadata || jsonb_build_object('playwrightWorkerUpdatedAt', now()),
         updated_at = now()
     WHERE account = $1
       AND id = $2`,
    [ACCOUNT, id, status, options.completedBy || null, options.lastError || null]
  );
}

async function launchBrowser(): Promise<Page> {
  if (page && !page.isClosed()) return page;
  workerState.status = 'launching_browser';
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: { width: 1365, height: 900 },
    userAgent: CHROME_USER_AGENT,
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
    ],
  });
  page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(15000);
  page.on('console', msg => {
    const text = msg.text();
    if (msg.type() === 'error') console.warn(`browser console error: ${text}`);
  });
  if (page.url() === 'about:blank') {
    await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded' }).catch(error => {
      workerState.lastError = `initial WhatsApp Web load failed: ${errorMessage(error)}`;
    });
  }
  return page;
}

async function isLoggedIn(p: Page): Promise<boolean> {
  const selectors = [
    '#side',
    '[data-testid="chat-list"]',
    '[aria-label="Chat list"]',
    '[aria-label="Lista de chats"]',
    'div[contenteditable="true"][role="textbox"]',
  ];
  for (const selector of selectors) {
    if ((await p.locator(selector).count().catch(() => 0)) > 0) return true;
  }
  return false;
}

async function looksLikeLoginRequired(p: Page): Promise<boolean> {
  const selectors = [
    'canvas',
    'text=/Log in to WhatsApp Web/i',
    'text=/Use WhatsApp on your computer/i',
    'text=/Usa WhatsApp en tu ordenador/i',
    'text=/Inicia sesi[o\\u00f3]n/i',
  ];
  for (const selector of selectors) {
    if ((await p.locator(selector).count().catch(() => 0)) > 0) return true;
  }
  return false;
}

async function looksLikeInvalidRecipient(p: Page): Promise<boolean> {
  const patterns = [
    /phone number shared via url is invalid/i,
    /n.uacute;mero.*no.*v.aacute;lido/i,
    /n[u\u00fa]mero.*no.*v[a\u00e1]lido/i,
    /invalid phone/i,
  ];
  const bodyText = await p.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  return patterns.some(pattern => pattern.test(bodyText));
}

async function waitForComposerOrLogin(p: Page, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    workerState.loggedIn = await isLoggedIn(p);
    if (workerState.loggedIn && (await hasSendButton(p))) return;
    if (await looksLikeInvalidRecipient(p)) throw new InvalidRecipientError();
    if (!workerState.loggedIn && (await looksLikeLoginRequired(p))) throw new LoginRequiredError();
    await sleep(1000);
  }
  throw new Error('whatsapp_web_send_button_timeout');
}

async function hasSendButton(p: Page): Promise<boolean> {
  return (
    (await p
      .locator('button[aria-label="Send"], button[aria-label="Enviar"], span[data-icon*="send"]')
      .count()
      .catch(() => 0)) > 0
  );
}

async function ensureMessageTextPresent(p: Page, text: string): Promise<void> {
  if (!text) return;
  const composer = p.locator('div[contenteditable="true"][role="textbox"]').last();
  const current = await composer.innerText({ timeout: 5000 }).catch(() => '');
  if (current.trim().length > 0) return;
  await composer.click();
  await composer.fill(text);
}

async function clickSendButton(p: Page): Promise<void> {
  const clicked = await p.evaluate(() => {
    const selectors = [
      'button[aria-label="Send"]',
      'button[aria-label="Enviar"]',
      'span[data-icon*="send"]',
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const clickable = el?.closest('button,[role="button"]') || el;
      if (clickable instanceof HTMLElement) {
        clickable.click();
        return true;
      }
    }
    return false;
  });
  if (!clicked) throw new Error('whatsapp_web_send_button_not_found');
}

async function sendRequest(row: ManualOpenRow): Promise<void> {
  const p = await launchBrowser();
  const url = whatsappWebSendUrl(row);
  workerState.status = 'opening_compose';
  workerState.currentRequestId = row.id;
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: SEND_TIMEOUT_MS });
  await p.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
  await waitForComposerOrLogin(p, SEND_TIMEOUT_MS);
  await ensureMessageTextPresent(p, row.message_text || '');
  await updateRequest(row.id, 'opened');
  if (DRY_RUN) {
    workerState.status = 'dry_run_opened';
    return;
  }
  workerState.status = 'clicking_send';
  await clickSendButton(p);
  await sleep(SEND_SETTLE_MS);
  await updateRequest(row.id, 'sent', { completedBy: 'playwright-whatsapp-open-worker' });
  workerState.lastSentAt = new Date().toISOString();
  workerState.status = 'idle';
}

async function handleRequest(row: ManualOpenRow): Promise<void> {
  try {
    await sendRequest(row);
    workerState.lastError = null;
  } catch (error) {
    const message = errorMessage(error);
    workerState.lastError = message;
    workerState.status = error instanceof LoginRequiredError ? 'login_required' : 'error';
    if (error instanceof LoginRequiredError) {
      await updateRequest(row.id, 'pending', { lastError: message });
      await sleep(LOGIN_RETRY_MS);
      return;
    }
    const status = error instanceof InvalidRecipientError ? 'failed' : 'failed';
    await updateRequest(row.id, status, { lastError: message });
  } finally {
    workerState.currentRequestId = null;
  }
}

async function workerLoop(): Promise<void> {
  await ensureSchema();
  await launchBrowser();
  workerState.status = 'idle';
  for (;;) {
    await resetStaleProcessing();
    const row = await claimNextRequest();
    if (!row) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    await handleRequest(row);
  }
}

function startStatusServer(): void {
  const app = express();
  app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>WhatsApp Open Worker</title>
<style>body{font:14px system-ui;margin:0;background:#111;color:#eee}main{max-width:1100px;margin:0 auto;padding:16px}pre{background:#1d2421;padding:12px;border-radius:8px;overflow:auto}img{max-width:100%;border:1px solid #38443f;border-radius:8px}</style>
<script>async function refresh(){try{const s=await fetch('/status').then(r=>r.json());document.getElementById('state').textContent=JSON.stringify(s,null,2);document.getElementById('shot').src='/screenshot?'+Date.now();}catch(e){}} setInterval(refresh,3000);window.onload=refresh;</script>
</head><body><main><h1>WhatsApp Open Worker</h1><pre id="state">{}</pre><img id="shot" /></main></body></html>`);
  });
  app.get('/status', (_req, res) => {
    res.json({
      ...workerState,
      account: ACCOUNT,
      headless: HEADLESS,
      dryRun: DRY_RUN,
      profileDir: PROFILE_DIR,
      now: new Date().toISOString(),
    });
  });
  app.get('/screenshot', (_req, res): void => {
    void (async () => {
      if (!page || page.isClosed()) {
        res.status(503).json({ error: 'browser page unavailable' });
        return;
      }
      const png = await page.screenshot({ type: 'png', fullPage: false });
      workerState.lastScreenshotAt = new Date().toISOString();
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      res.send(png);
    })().catch(error => {
      res.status(500).json({ error: errorMessage(error) });
    });
  });
  app.listen(PORT, () => {
    console.log(`WhatsApp open worker status listening on ${PORT}`);
  });
}

process.on('SIGTERM', () => {
  void (async () => {
    await context?.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  })();
});

startStatusServer();
workerLoop().catch(error => {
  console.error('Fatal WhatsApp open worker error:', error);
  process.exit(1);
});
