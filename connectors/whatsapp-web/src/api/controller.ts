import express, { Request, Response } from 'express';
import { createHash } from 'crypto';
import {
  BaileysClient,
  classifyWhatsAppSendFailure,
  WhatsAppSendFailureClass,
} from '../baileys-client';
import { QRHandler } from '../qr-handler';
import { createHMACAuth, AuthenticatedRequest } from './auth';
import {
  connectorAccount,
  createWhatsAppManualOpenRequest,
  listWhatsAppManualOpenRequests,
  updateWhatsAppManualOpenRequestStatus,
  upsertWhatsAppCustomerAllowlist,
  WhatsAppManualOpenStatus,
} from '../db-writer';
import {
  appendCompanyToDisplayName,
  buildManualWhatsAppOpenUrl,
  companyOrNull,
  displayNameOrPhone,
  normalizePhoneForWhatsApp,
  WhatsAppContactSeedInput,
} from '../contact-sync';
import { MessageUnavailableError } from '../durable-message-store';
import { MessageMutationError } from '../message-mutations';
import {
  claimSendAttempt,
  confirmSend,
  mediaRequestHash,
  readIdempotencyKey,
  recordSendFailure,
  reserveSend,
  SendAlreadyClaimedError,
  SendReservation,
  textRequestHash,
  voiceRequestHash,
} from '../send-idempotency';

function statusForSendFailure(
  failureClass: WhatsAppSendFailureClass | 'disabled_sending' | 'invalid_request'
): number {
  if (failureClass === 'invalid_request') return 400;
  if (failureClass === 'disabled_sending') return 403;
  if (failureClass === 'disconnected') return 503;
  if (failureClass === 'account_restricted') return 403;
  if (failureClass === 'timeout') return 504;
  if (failureClass === 'missing_session' || failureClass === 'group_metadata') return 424;
  if (failureClass === 'invalid_recipient') return 422;
  if (failureClass === 'auth') return 401;
  return 500;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

function phoneFromDirectWhatsAppId(chatId: unknown): string | null {
  if (typeof chatId !== 'string') return null;
  const jid = chatId.includes(':') ? chatId.split(':').pop() || chatId : chatId;
  if (jid.includes('@g.us')) return null;
  const user = jid.split('@')[0] || '';
  const digits = user.replace(/\D/g, '');
  return digits.length >= 8 ? digits : null;
}

function accountRestrictedFallback(
  chatId: unknown,
  content: unknown
): Record<string, unknown> | undefined {
  const phone = phoneFromDirectWhatsAppId(chatId);
  if (!phone) return undefined;
  const normalized = normalizePhoneForWhatsApp(phone);
  if (!normalized) return undefined;
  const text = typeof content === 'string' ? content : '';
  return {
    mode: 'manual_whatsapp_compose',
    manualOpenUrl: buildManualWhatsAppOpenUrl(normalized.phoneE164, text),
    note: 'Open this URL in the official WhatsApp app/Web session to compose manually. A human must press send; Baileys cannot reliably automate a first 1:1 reachout without a trusted-contact token.',
  };
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function optionalObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Edits, deletes and reactions go out to WhatsApp: the same two kill switches
 * as sends. Answers 403 and returns true when sending is off.
 */
function rejectWhenSendingDisabled(res: Response): boolean {
  const disabled = process.env.ENABLE_SENDING !== 'true';
  if (!disabled && process.env.EMERGENCY_DISABLE_SENDING !== 'true') return false;
  res.status(statusForSendFailure('disabled_sending')).json({
    error: disabled ? 'Sending is disabled' : 'Sending is emergency disabled',
    failureClass: 'disabled_sending',
  });
  return true;
}

/** Optional `actor` of a mutation body: who asked, for the record (≤ 200 chars). */
function actorFromBody(value: unknown): string | undefined {
  const actor = typeof value === 'string' ? value.trim() : '';
  return actor ? actor.slice(0, 200) : undefined;
}

/** Error of an edit/delete/reaction → status + failureClass (same classes as sends). */
function mutationErrorResponse(res: Response, error: unknown, what: string): void {
  if (error instanceof MessageUnavailableError || error instanceof MessageMutationError) {
    res.status(error.status).json({
      error: error.message,
      failureClass: error.failureClass,
      ...(error instanceof MessageMutationError && error.code ? { code: error.code } : {}),
    });
    return;
  }
  const failureClass = classifyWhatsAppSendFailure(error);
  res.status(statusForSendFailure(failureClass)).json({
    error: `Failed to ${what}: ${errorMessage(error)}`,
    failureClass,
  });
}

function rejectWhenDisconnected(client: BaileysClient, res: Response): boolean {
  if (client.isConnected()) return false;
  res.status(statusForSendFailure('disconnected')).json({
    error: `WhatsApp is not connected (state=${client.getCachedState() || 'unknown'})`,
    failureClass: 'disconnected',
  });
  return true;
}

function statusFromBody(value: unknown): WhatsAppManualOpenStatus | null {
  const status = optionalString(value);
  if (
    status === 'pending' ||
    status === 'processing' ||
    status === 'opened' ||
    status === 'sent' ||
    status === 'cancelled' ||
    status === 'failed'
  ) {
    return status;
  }
  return null;
}

/**
 * One send under an explicit Idempotency-Key (fase 3 / PR-2). `beforeSend`
 * claims the attempt right before the network send; `claimed` says whether it
 * did, i.e. whether a failure may have reached WhatsApp.
 */
interface IdempotentSend {
  key: string;
  messageId?: string;
  claimed: boolean;
  beforeSend: () => Promise<void>;
}

function uncertainOutcomeBody(messageId: string | undefined): Record<string, unknown> {
  return {
    error:
      'The outcome of an earlier send with this Idempotency-Key is unknown; check the chat before sending again',
    failureClass: 'send_outcome_uncertain',
    messageId,
  };
}

// CONTRACT: http.whatsapp-connector.send-idempotency.v1 — opt-in Idempotency-Key, replay + deduplicated, 409 idempotency_key_reused / send_outcome_uncertain
/**
 * Opt-in idempotency for a send route. Returns null when the request carries
 * no key (or the client keeps no DB state, or the store is unavailable): the
 * route then runs its legacy path, byte for byte. 'answered' when the response
 * is already sent (invalid key, replay, 409).
 */
async function beginIdempotentSend(
  client: BaileysClient,
  req: AuthenticatedRequest,
  res: Response,
  requestHash: () => string,
  replayBody: (reservation: SendReservation) => Record<string, unknown>
): Promise<IdempotentSend | null | 'answered'> {
  const { key, error } = readIdempotencyKey(req.headers, req.body);
  if (error) {
    res.status(400).json({ error, failureClass: 'invalid_request' });
    return 'answered';
  }
  // SC-1225: a pairing-only client (ingest off) never touches the table.
  if (!key || !client.isIngestEnabled()) return null;
  const hash = requestHash();
  const reservation = await reserveSend(key, hash);
  switch (reservation.state) {
    case 'unavailable':
      return null;
    case 'conflict':
      res.status(409).json({
        error: 'Idempotency-Key was already used for a different request',
        failureClass: 'idempotency_key_reused',
      });
      return 'answered';
    case 'pending':
      res.status(409).json(uncertainOutcomeBody(reservation.messageId));
      return 'answered';
    case 'sent':
      console.info(`WhatsApp send replayed messageId=${reservation.messageId || ''}`);
      res.json({ ...replayBody(reservation), deduplicated: true });
      return 'answered';
    default: {
      const attempt: IdempotentSend = {
        key,
        messageId: reservation.messageId,
        claimed: false,
        beforeSend: async () => {
          await claimSendAttempt(key, hash);
          attempt.claimed = true;
        },
      };
      return attempt;
    }
  }
}

/** Error path of an idempotent send: true when the response was answered here. */
async function failIdempotentSend(
  attempt: IdempotentSend | null,
  error: unknown,
  res: Response
): Promise<boolean> {
  if (!attempt) return false;
  if (error instanceof SendAlreadyClaimedError) {
    res.status(409).json(uncertainOutcomeBody(attempt.messageId));
    return true;
  }
  await recordSendFailure(attempt.key, attempt.claimed, error);
  return false;
}

function manualOpenIdempotencyKey(phoneE164: string, text: string): string {
  const digest = createHash('sha256')
    .update(`${connectorAccount()}\n${phoneE164}\n${text}`)
    .digest('hex')
    .slice(0, 32);
  return `send:${digest}`;
}

function createManualOpenAuth(
  hmacAuth: ReturnType<typeof createHMACAuth>,
  sharedSecret: string
): express.RequestHandler {
  const adminToken = process.env.WA_MANUAL_OPEN_ADMIN_TOKEN || sharedSecret;
  return (req, res, next): void => {
    const authz = req.headers.authorization || '';
    const bearer = authz.startsWith('Bearer ') ? authz.slice('Bearer '.length).trim() : '';
    if (adminToken && bearer && bearer === adminToken) {
      next();
      return;
    }
    hmacAuth(req as AuthenticatedRequest, res, next);
  };
}

async function enqueueManualOpenFromSendFailure(
  chatId: unknown,
  content: unknown,
  sourceRef: unknown,
  details: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const normalized = normalizePhoneForWhatsApp(chatId);
  if (!normalized) return undefined;
  const text = typeof content === 'string' ? content : '';
  const manualOpenUrl = buildManualWhatsAppOpenUrl(normalized.phoneE164, text);
  const request = await createWhatsAppManualOpenRequest({
    phoneE164: normalized.phoneE164,
    waJid: normalized.waJid,
    displayName: optionalString(details.displayName) || normalized.phoneE164,
    messageText: text,
    manualOpenUrl,
    source: 'baileys_send_account_restricted',
    sourceRef: optionalString(sourceRef),
    idempotencyKey: manualOpenIdempotencyKey(normalized.phoneE164, text),
    metadata: {
      connectorAccount: connectorAccount(),
      failureClass: 'account_restricted',
      rawJid: details.rawJid,
      normalizedJid: details.normalizedJid,
      actionable: details.actionable,
    },
  });
  return {
    id: request.id,
    status: request.status,
    phoneE164: request.phoneE164,
    manualOpenUrl: request.manualOpenUrl,
    attemptCount: request.attemptCount,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

function manualOpenPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WhatsApp Manual Open</title>
  <style>
    :root{color-scheme:light dark;--bg:#f6f7f8;--panel:#fff;--text:#18201c;--muted:#66736c;--line:#dfe5e1;--accent:#128c7e;--danger:#b42318}
    @media (prefers-color-scheme: dark){:root{--bg:#101413;--panel:#171d1b;--text:#eff6f2;--muted:#a5b4ac;--line:#29332f;--accent:#25d366;--danger:#ffb4ab}}
    body{margin:0;background:var(--bg);color:var(--text);font:14px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    header{position:sticky;top:0;z-index:2;background:var(--panel);border-bottom:1px solid var(--line)}
    .bar{max-width:1120px;margin:0 auto;padding:14px 16px;display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center}
    h1{font-size:18px;margin:0;font-weight:700;letter-spacing:0}
    input,textarea,select,button{font:inherit;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--text)}
    input,textarea,select{padding:9px 10px;min-width:0}
    button{padding:9px 12px;cursor:pointer;font-weight:650}
    button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
    button.danger{color:var(--danger)}
    main{max-width:1120px;margin:0 auto;padding:16px;display:grid;grid-template-columns:340px 1fr;gap:16px}
    form,.list{background:var(--panel);border:1px solid var(--line);border-radius:8px}
    form{padding:14px;display:grid;gap:10px;align-content:start}
    label{display:grid;gap:5px;color:var(--muted);font-size:12px;font-weight:650}
    label span{color:var(--muted)}
    textarea{min-height:128px;resize:vertical}
    .list{min-height:320px}
    .toolbar{display:flex;justify-content:space-between;gap:10px;padding:12px;border-bottom:1px solid var(--line);align-items:center}
    .items{display:grid}
    .item{display:grid;gap:9px;padding:14px;border-bottom:1px solid var(--line)}
    .item:last-child{border-bottom:0}
    .top{display:flex;gap:8px;justify-content:space-between;align-items:start}
    .phone{font-size:16px;font-weight:750}
    .meta{color:var(--muted);font-size:12px}
    .text{white-space:pre-wrap;overflow-wrap:anywhere;background:rgba(128,128,128,.08);border-radius:6px;padding:10px}
    .actions{display:flex;flex-wrap:wrap;gap:8px}
    .empty{padding:28px;color:var(--muted);text-align:center}
    .token{width:260px}
    @media (max-width:820px){.bar{grid-template-columns:1fr}.token{width:100%}main{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <header>
    <div class="bar">
      <h1>WhatsApp Manual Open</h1>
      <input id="token" class="token" type="password" placeholder="Admin token" autocomplete="current-password" />
      <button id="refresh" type="button">Refresh</button>
    </div>
  </header>
  <main>
    <form id="create">
      <label><span>Telefono</span><input id="phone" name="phone" placeholder="660242739" /></label>
      <label><span>Nombre</span><input id="displayName" name="displayName" placeholder="Cliente" /></label>
      <label><span>Mensaje</span><textarea id="text" name="text"></textarea></label>
      <button class="primary" type="submit">Crear tarea</button>
      <div id="notice" class="meta"></div>
    </form>
    <section class="list">
      <div class="toolbar">
        <strong>Pendientes</strong>
        <select id="status">
          <option value="pending">pending</option>
          <option value="processing">processing</option>
          <option value="opened">opened</option>
          <option value="all">all</option>
        </select>
      </div>
      <div id="items" class="items"><div class="empty">Sin datos</div></div>
    </section>
  </main>
<script>
const tokenInput = document.getElementById('token');
const items = document.getElementById('items');
const notice = document.getElementById('notice');
const phoneInput = document.getElementById('phone');
const displayNameInput = document.getElementById('displayName');
const textInput = document.getElementById('text');
const saved = localStorage.getItem('waManualOpenToken') || '';
tokenInput.value = saved;
tokenInput.addEventListener('change', () => localStorage.setItem('waManualOpenToken', tokenInput.value));
function headers(json=true){const h={Authorization:'Bearer '+tokenInput.value}; if(json) h['Content-Type']='application/json'; return h;}
function esc(s){return String(s || '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function patch(id,status){
  const res = await fetch('/api/v1/manual-open/requests/'+id,{method:'PATCH',headers:headers(),body:JSON.stringify({status,completedBy:'manual-admin-page'})});
  if(!res.ok) throw new Error(await res.text());
  await load();
}
function render(rows){
  if(!rows.length){items.innerHTML='<div class="empty">No hay tareas</div>';return;}
  items.innerHTML = rows.map(r => '<article class="item"><div class="top"><div><div class="phone">'+esc(r.displayName || r.phoneE164)+'</div><div class="meta">'+esc(r.phoneE164)+' - '+esc(r.status)+' - '+esc(r.createdAt)+'</div></div><div class="meta">#'+esc(r.attemptCount)+'</div></div><div class="text">'+esc(r.messageText)+'</div><div class="actions"><button class="primary" data-open="'+esc(r.id)+'">Abrir</button><button data-sent="'+esc(r.id)+'">Enviado</button><button class="danger" data-cancel="'+esc(r.id)+'">Cancelar</button></div></article>').join('');
  for(const b of items.querySelectorAll('[data-open]')) b.onclick = async () => { const row = rows.find(x=>x.id===b.dataset.open); if(row) window.open(row.manualOpenUrl,'_blank','noopener'); await patch(b.dataset.open,'opened'); };
  for(const b of items.querySelectorAll('[data-sent]')) b.onclick = () => patch(b.dataset.sent,'sent');
  for(const b of items.querySelectorAll('[data-cancel]')) b.onclick = () => patch(b.dataset.cancel,'cancelled');
}
async function load(){
  notice.textContent='';
  const status = document.getElementById('status').value;
  const res = await fetch('/api/v1/manual-open/requests?status='+encodeURIComponent(status),{headers:headers(false)});
  if(!res.ok){items.innerHTML='<div class="empty">Auth o API error</div>';return;}
  const data = await res.json();
  render(data.requests || []);
}
document.getElementById('refresh').onclick = load;
document.getElementById('status').onchange = load;
document.getElementById('create').onsubmit = async (ev) => {
  ev.preventDefault();
  const body = {phone:phoneInput.value,displayName:displayNameInput.value,text:textInput.value,source:'manual_admin_page'};
  const res = await fetch('/api/v1/manual-open/requests',{method:'POST',headers:headers(),body:JSON.stringify(body)});
  notice.textContent = res.ok ? 'Tarea creada' : await res.text();
  if(res.ok){phoneInput.value='';displayNameInput.value='';textInput.value='';await load();}
};
load();
</script>
</body>
</html>`;
}

export function createRouter(
  client: BaileysClient,
  qrHandler: QRHandler,
  sharedSecret: string
): express.Router {
  const router = express.Router();
  const auth = createHMACAuth(sharedSecret);
  const manualOpenAuth = createManualOpenAuth(auth, sharedSecret);

  // Health check (no auth required)
  router.get('/health', (_req: Request, res: Response) => {
    const qr = qrHandler.getCurrentQR();
    const connected = client.isConnected();
    res.json({
      status: connected ? 'ok' : 'degraded',
      ...client.getStatus(),
      connected,
      serviceReady: connected || qr !== null,
      qrAvailable: qr !== null,
    });
  });

  router.get('/manual-open/page', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(manualOpenPageHtml());
  });

  router.get(
    '/manual-open/requests',
    manualOpenAuth,
    (req: AuthenticatedRequest, res: Response): void => {
      void (async (): Promise<void> => {
        try {
          const statusParam = optionalString((req.query as any).status) || 'pending';
          const status = statusParam === 'all' ? 'all' : statusFromBody(statusParam);
          if (statusParam !== 'all' && !status) {
            res.status(400).json({ error: 'Invalid status' });
            return;
          }
          const requests = await listWhatsAppManualOpenRequests({
            status: status || 'pending',
            limit: Number((req.query as any).limit || 50),
          });
          res.json({ account: connectorAccount(), requests });
        } catch (error) {
          res.status(500).json({ error: `Failed to list manual open requests: ${String(error)}` });
        }
      })();
    }
  );

  router.post(
    '/manual-open/requests',
    manualOpenAuth,
    (req: AuthenticatedRequest, res: Response): void => {
      void (async (): Promise<void> => {
        try {
          const body = (req.body || {}) as Record<string, unknown>;
          const phoneCandidate = body.phone || body.chatId || body.conversationId;
          const normalized = normalizePhoneForWhatsApp(phoneCandidate);
          if (!normalized) {
            res.status(422).json({ error: 'Invalid WhatsApp phone', status: 'invalid_phone' });
            return;
          }
          const text = optionalString(body.text) || optionalString(body.content) || '';
          const request = await createWhatsAppManualOpenRequest({
            phoneE164: normalized.phoneE164,
            waJid: normalized.waJid,
            displayName: optionalString(body.displayName) || normalized.phoneE164,
            messageText: text,
            manualOpenUrl: buildManualWhatsAppOpenUrl(normalized.phoneE164, text),
            source: optionalString(body.source) || 'manual_api',
            sourceRef: optionalString(body.sourceRef),
            idempotencyKey: optionalString(body.idempotencyKey),
            metadata: {
              ...optionalObject(body.metadata),
              connectorAccount: connectorAccount(),
              rawJid: normalized.rawJid,
            },
          });
          res.status(201).json({ account: connectorAccount(), request });
        } catch (error) {
          res.status(500).json({ error: `Failed to create manual open request: ${String(error)}` });
        }
      })();
    }
  );

  router.patch(
    '/manual-open/requests/:id',
    manualOpenAuth,
    (req: AuthenticatedRequest, res: Response): void => {
      void (async (): Promise<void> => {
        try {
          const status = statusFromBody((req.body || {}).status);
          if (!status) {
            res.status(400).json({ error: 'Invalid status' });
            return;
          }
          const request = await updateWhatsAppManualOpenRequestStatus(req.params.id, status, {
            completedBy: optionalString((req.body || {}).completedBy),
            lastError: optionalString((req.body || {}).lastError) || null,
            metadata: optionalObject((req.body || {}).metadata),
          });
          if (!request) {
            res.status(404).json({ error: 'Manual open request not found' });
            return;
          }
          res.json({ account: connectorAccount(), request });
        } catch (error) {
          res.status(500).json({ error: `Failed to update manual open request: ${String(error)}` });
        }
      })();
    }
  );

  // Seed a Shopify customer into this connector account's WhatsApp contacts
  // without sending a message. Production calls this through
  // whatsapp-connector-professional, so rows are stored as account=professional.
  router.post('/contacts/seed', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      const body = (req.body || {}) as WhatsAppContactSeedInput;
      const normalized = normalizePhoneForWhatsApp(body.phone);
      if (!normalized) {
        res.status(422).json({
          error: 'Invalid WhatsApp phone',
          status: 'invalid_phone',
          tokenStatus: 'unknown',
          account: connectorAccount(),
        });
        return;
      }

      const company = companyOrNull(body.company || body.shopifyOrderName);
      const sourceTopic = optionalString(body.sourceTopic);
      const displayName = appendCompanyToDisplayName(
        displayNameOrPhone(body.displayName, normalized.phoneE164),
        company
      );
      const baseAllowlist = {
        phoneE164: normalized.phoneE164,
        waJid: normalized.waJid,
        shopifyCustomerId: optionalString(body.shopifyCustomerId),
        shop: optionalString(body.shop),
        email: optionalString(body.email),
        displayName,
        metadata: {
          source:
            sourceTopic && sourceTopic.startsWith('orders/') ? 'shopify_order' : 'shopify_customer',
          sourceTopic,
          company,
          shopifyOrderId: optionalString(body.shopifyOrderId),
          shopifyOrderName: optionalString(body.shopifyOrderName) || company,
          rawJid: normalized.rawJid,
          connectorAccount: connectorAccount(),
        },
      };

      if (!client.isConnected()) {
        const error = `WhatsApp is not connected (state=${client.getCachedState() || 'unknown'})`;
        await upsertWhatsAppCustomerAllowlist({
          ...baseAllowlist,
          status: 'probe_failed',
          tokenStatus: 'error',
          lastProbeAt: new Date(),
          lastError: error,
        });
        res.status(statusForSendFailure('disconnected')).json({
          error,
          status: 'probe_failed',
          tokenStatus: 'error',
          account: connectorAccount(),
        });
        return;
      }

      try {
        const result = await client.seedContactAndProbe({
          ...body,
          phone: normalized.phoneE164,
          displayName,
        });
        await upsertWhatsAppCustomerAllowlist({
          ...baseAllowlist,
          status: result.status,
          tokenStatus: result.tokenStatus,
          lastProbeAt: new Date(),
          lastError: result.error || null,
          metadata: {
            ...baseAllowlist.metadata,
            existsOnWhatsApp: result.existsOnWhatsApp,
            contactSeeded: result.contactSeeded,
            elapsedMs: result.elapsedMs,
            actionable: result.actionable,
          },
        });
        res.json({
          ...result,
          account: connectorAccount(),
        });
      } catch (error) {
        const failureClass = classifyWhatsAppSendFailure(error);
        const message = errorMessage(error);
        const status = failureClass === 'invalid_recipient' ? 'not_on_whatsapp' : 'probe_failed';
        const tokenStatus = failureClass === 'invalid_recipient' ? 'not_on_whatsapp' : 'error';
        await upsertWhatsAppCustomerAllowlist({
          ...baseAllowlist,
          status,
          tokenStatus,
          lastProbeAt: new Date(),
          lastError: message,
          metadata: {
            ...baseAllowlist.metadata,
            failureClass,
          },
        });
        res.status(statusForSendFailure(failureClass)).json({
          error: message,
          failureClass,
          status,
          tokenStatus,
          account: connectorAccount(),
        });
      }
    })();
  });

  // Get QR code (no auth required for local dev)
  // CONTRACT: http.whatsapp-connector.auth-qr — path, no-auth and {qrCode, expiresAt} are frozen
  router.get('/auth/qr', (req: Request, res: Response) => {
    const qr = qrHandler.getCurrentQR();
    if (!qr) {
      res.status(404).json({ error: 'No QR code available' });
      return;
    }
    res.json({
      qrCode: qr.qrCode,
      expiresAt: qr.expiresAt.toISOString(),
    });
  });

  // Logout and clear session (requires auth)
  router.post('/auth/logout', auth, (req: AuthenticatedRequest, res: Response): void => {
    try {
      client.disconnect();
      qrHandler.clearQR();

      res.json({
        message: 'WhatsApp disconnected successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({ error: `Failed to logout: ${String(error)}` });
    }
  });

  // Send message (requires auth)
  router.post('/messages/send', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      let requestConversationId: unknown;
      let requestContent: unknown;
      let requestSendToken: unknown;
      let idempotent: IdempotentSend | null = null;
      try {
        const body = req.body as {
          sendToken?: string;
          conversationId?: string;
          content?: string;
          replyToMessageId?: string;
        };
        const { sendToken, conversationId, content, replyToMessageId } = body;
        requestSendToken = sendToken;
        requestConversationId = conversationId;
        requestContent = content;

        if (!sendToken || !conversationId || !content) {
          console.warn(
            `WhatsApp send rejected failureClass=invalid_request conversationId=${conversationId || ''}`
          );
          res.status(statusForSendFailure('invalid_request')).json({
            error: 'Missing required fields',
            failureClass: 'invalid_request',
          });
          return;
        }

        // In production, validate sendToken here
        // For now, we'll just check if sending is enabled
        if (process.env.ENABLE_SENDING !== 'true') {
          console.warn(
            `WhatsApp send blocked failureClass=disabled_sending conversationId=${conversationId}`
          );
          res.status(statusForSendFailure('disabled_sending')).json({
            error: 'Sending is disabled',
            failureClass: 'disabled_sending',
          });
          return;
        }

        if (process.env.EMERGENCY_DISABLE_SENDING === 'true') {
          console.warn(
            `WhatsApp send blocked failureClass=disabled_sending reason=emergency_disable conversationId=${conversationId}`
          );
          res.status(statusForSendFailure('disabled_sending')).json({
            error: 'Sending is emergency disabled',
            failureClass: 'disabled_sending',
          });
          return;
        }

        if (!client.isConnected()) {
          console.warn(
            `WhatsApp send blocked failureClass=disconnected conversationId=${conversationId} state=${client.getCachedState() || 'unknown'}`
          );
          res.status(statusForSendFailure('disconnected')).json({
            error: `WhatsApp is not connected (state=${client.getCachedState() || 'unknown'})`,
            failureClass: 'disconnected',
            actionable: 'Reconnect WhatsApp or renew the QR code before sending.',
          });
          return;
        }

        // Opt-in: only an explicit Idempotency-Key, never sendToken (callers reuse it).
        const begun = await beginIdempotentSend(
          client,
          req,
          res,
          () => textRequestHash({ conversationId, content, replyToMessageId }),
          reservation => ({ messageId: reservation.messageId, sentAt: reservation.sentAt })
        );
        if (begun === 'answered') return;
        idempotent = begun;

        const messageId = await client.sendMessage(
          conversationId,
          content,
          idempotent
            ? {
                replyToMessageId,
                messageId: idempotent.messageId,
                beforeSend: idempotent.beforeSend,
              }
            : { replyToMessageId }
        );
        console.info(
          `WhatsApp send ok conversationId=${conversationId} messageId=${messageId || ''}`
        );

        res.json({
          messageId,
          sentAt: idempotent
            ? await confirmSend(idempotent.key, messageId)
            : new Date().toISOString(),
        });
      } catch (error) {
        if (await failIdempotentSend(idempotent, error, res)) return;
        const failureClass = classifyWhatsAppSendFailure(error);
        const details = (error as any)?.details || {};
        console.error(
          `WhatsApp send failed failureClass=${failureClass} conversationId=${details.normalizedJid || ''} rawJid=${details.rawJid || ''}${details.groupSubject ? ` groupSubject="${details.groupSubject}"` : ''}: ${errorMessage(error)}`
        );
        const fallback =
          failureClass === 'account_restricted'
            ? accountRestrictedFallback(
                details.normalizedJid || details.rawJid || requestConversationId,
                requestContent
              )
            : undefined;
        if (fallback) {
          try {
            const manualRequest = await enqueueManualOpenFromSendFailure(
              details.normalizedJid || details.rawJid || requestConversationId,
              requestContent,
              requestSendToken,
              details
            );
            if (manualRequest) fallback.manualRequest = manualRequest;
          } catch (queueError) {
            fallback.queueError = errorMessage(queueError);
          }
        }
        res.status(statusForSendFailure(failureClass)).json({
          error: `Failed to send message: ${errorMessage(error)}`,
          failureClass,
          actionable: details.actionable,
          details,
          fallback,
        });
      }
    })();
  });

  // Send a voice note (requires auth) — {conversationId, audioBase64, mimeType}
  router.post('/messages/audio', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      let idempotent: IdempotentSend | null = null;
      try {
        const body = req.body as {
          conversationId?: string;
          audioBase64?: string;
          mimeType?: string;
        };
        const { conversationId, audioBase64, mimeType } = body;

        if (!conversationId || !audioBase64) {
          res.status(400).json({ error: 'Missing conversationId or audioBase64' });
          return;
        }
        if (
          process.env.ENABLE_SENDING !== 'true' ||
          process.env.EMERGENCY_DISABLE_SENDING === 'true'
        ) {
          res.status(statusForSendFailure('disabled_sending')).json({
            error: 'Sending is disabled',
            failureClass: 'disabled_sending',
          });
          return;
        }
        if (!client.isConnected()) {
          res.status(statusForSendFailure('disconnected')).json({
            error: `WhatsApp is not connected (state=${client.getCachedState() || 'unknown'})`,
            failureClass: 'disconnected',
          });
          return;
        }

        const effectiveMimeType = mimeType || 'audio/ogg; codecs=opus';
        const begun = await beginIdempotentSend(
          client,
          req,
          res,
          () => voiceRequestHash({ conversationId, audioBase64, mimeType: effectiveMimeType }),
          reservation => ({ messageId: reservation.messageId, sentAt: reservation.sentAt })
        );
        if (begun === 'answered') return;
        idempotent = begun;

        const buf = Buffer.from(audioBase64, 'base64');
        const messageId = idempotent
          ? await client.sendVoice(conversationId, buf, effectiveMimeType, {
              messageId: idempotent.messageId,
              beforeSend: idempotent.beforeSend,
            })
          : await client.sendVoice(conversationId, buf, effectiveMimeType);
        console.info(
          `WhatsApp voice sent conversationId=${conversationId} messageId=${messageId || ''}`
        );
        res.json({
          messageId,
          sentAt: idempotent
            ? await confirmSend(idempotent.key, messageId)
            : new Date().toISOString(),
        });
      } catch (error) {
        if (await failIdempotentSend(idempotent, error, res)) return;
        const failureClass = classifyWhatsAppSendFailure(error);
        res.status(statusForSendFailure(failureClass)).json({
          error: `Failed to send voice: ${errorMessage(error)}`,
          failureClass,
        });
      }
    })();
  });

  // React to a message ('' removes our reaction). Fase 3 / PR-4: same gate
  // as every send, the key survives restarts, an unknown message is a 404
  // instead of a silent 200, and the reaction is recorded.
  // CONTRACT: http.whatsapp-connector.messages-react.v1 — body {conversationId, messageId, emoji}, 200 {reacted, emoji, messageId, reactedAt}
  router.post('/messages/react', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        const body = optionalObject(req.body);
        const chatId = optionalString(body.conversationId ?? body.chatId);
        const messageId = optionalString(body.messageId);
        const emoji = body.emoji ?? '';
        if (!chatId || !messageId || typeof emoji !== 'string') {
          res.status(400).json({
            error: 'Missing conversationId or messageId (emoji must be a string)',
            failureClass: 'invalid_request',
          });
          return;
        }
        if (rejectWhenSendingDisabled(res)) return;
        if (rejectWhenDisconnected(client, res)) return;
        const result = await client.reactToMessage(chatId, messageId, emoji);
        res.json({
          reacted: true,
          emoji: result.emoji,
          // As before: the id the caller sent (bare or namespaced).
          messageId,
          reactionId: result.reactionId,
          reactedAt: result.reactedAt,
        });
      } catch (error) {
        mutationErrorResponse(res, error, 'react');
      }
    })();
  });

  // History sync endpoint
  router.post('/history/sync', (req: Request, res: Response): void => {
    const limit = parseInt((req.query as any).limit || '500', 10);

    if (!client.isConnected()) {
      res.status(503).json({ error: 'WhatsApp not connected' });
      return;
    }

    res.json({ status: 'started', limit, message: 'Fetching chat history...' });

    void (async () => {
      try {
        const results = await (client as any).getAllChatsWithHistory(limit);
        console.log('History sync complete: ' + results.length + ' chats');
      } catch (e) {
        console.error('History sync error: ' + String(e));
      }
    })();
  });

  router.get('/history/status', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const limit = parseInt((req.query as any).limit || '200', 10);
        const status = await client.getHistorySyncStatus(limit);
        res.json({ status });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Get chat history
  router.get('/history/:chatId', (req: Request, res: Response): void => {
    const chatId = req.params.chatId;
    const limit = parseInt((req.query as any).limit || '100', 10);

    void (async () => {
      try {
        const messages = await (client as any).fetchChatHistory(chatId, limit);
        res.json({ chatId, count: messages.length, messages });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Request older Baileys history for chats where we have persisted message keys.
  router.post('/history/backfill', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = req.body as {
          chatId?: string;
          maxChats?: number;
          maxBatchesPerChat?: number;
          batchSize?: number;
          dryRun?: boolean;
        };
        const result = await client.backfillHistory(body || {});
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Get authenticated account info
  router.get('/me', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const me = await client.getMe();
        res.json(me);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Get unread chats
  router.get('/chats/unread', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const chats = await client.getUnreadChats();
        res.json({ chats });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Force app-state resync → persists current unread/archived to the DB.
  router.post('/chats/resync-state', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const result = await client.resyncChatState('api');
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Get group info
  router.get('/groups/:id/info', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const info = await client.getGroupInfo(req.params.id);
        res.json(info);
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Get group participants
  router.get('/groups/:id/participants', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const participants = await client.getGroupParticipants(req.params.id);
        res.json({ participants });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Download a chat/contact's profile picture as base64 (mirrors telegram-connector shape).
  router.get('/chats/:jid/photo', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const bytes = await client.getProfilePictureBytes(req.params.jid);
        if (!bytes) {
          res.status(404).json({ error: 'No photo' });
          return;
        }
        res.json({
          data: bytes.toString('base64'),
          size: bytes.length,
          contentType: 'image/jpeg',
        });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Refresh group metadata and Signal sender-key/session state before a group send.
  router.post(
    '/groups/:id/session/repair',
    auth,
    (req: AuthenticatedRequest, res: Response): void => {
      void (async () => {
        try {
          const result = await client.refreshGroupSession(req.params.id, {
            reason: 'manual-api',
            warmSessions: true,
            forceSessions: true,
            clearSenderKeyMemory: true,
            failOnWarmupError: true,
          });
          res.json(result);
        } catch (e) {
          const failureClass = classifyWhatsAppSendFailure(e);
          res.status(statusForSendFailure(failureClass)).json({
            error: String(e),
            failureClass,
          });
        }
      })();
    }
  );

  // Download media from a message
  router.get(
    '/messages/media/:chatId/:msgId',
    auth,
    (req: AuthenticatedRequest, res: Response): void => {
      void (async () => {
        try {
          const media = await client.downloadMedia(req.params.chatId, req.params.msgId);
          if (!media) {
            res.status(404).json({ error: 'No media found' });
            return;
          }
          res.json(media);
        } catch (e) {
          res.status(500).json({ error: String(e) });
        }
      })();
    }
  );

  // Send file/media
  router.post('/messages/media/send', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      let idempotent: IdempotentSend | null = null;
      try {
        if (process.env.ENABLE_SENDING !== 'true') {
          res.status(403).json({ error: 'Sending disabled' });
          return;
        }
        const { conversationId, fileUrl, caption, asSticker, kind, replyTo } = req.body as {
          conversationId?: string;
          fileUrl?: string;
          caption?: string;
          asSticker?: boolean;
          kind?: string;
          replyTo?: string;
        };
        if (!conversationId || !fileUrl) {
          res.status(400).json({ error: 'Missing conversationId or fileUrl' });
          return;
        }
        const sticker = !!asSticker || kind === 'sticker';
        const replyToMessageId = optionalString(replyTo);
        const begun = await beginIdempotentSend(
          client,
          req,
          res,
          () =>
            mediaRequestHash({
              conversationId,
              fileUrl,
              caption,
              asSticker: sticker,
              replyToMessageId,
            }),
          reservation => ({
            sent: true,
            sentAt: reservation.sentAt,
            messageId: reservation.messageId,
          })
        );
        if (begun === 'answered') return;
        idempotent = begun;

        if (!idempotent) {
          await client.sendFile(conversationId, fileUrl, caption, {
            asSticker: sticker,
            replyToMessageId,
          });
          res.json({ sent: true, sentAt: new Date().toISOString() });
          return;
        }
        // Idempotent sends also answer the message id (additive).
        const messageId = await client.sendFile(conversationId, fileUrl, caption, {
          asSticker: sticker,
          replyToMessageId,
          messageId: idempotent.messageId,
          beforeSend: idempotent.beforeSend,
        });
        res.json({
          sent: true,
          sentAt: await confirmSend(idempotent.key, messageId),
          messageId,
        });
      } catch (e) {
        if (await failIdempotentSend(idempotent, e, res)) return;
        if (e instanceof MessageUnavailableError) {
          res.status(e.status).json({ error: e.message, failureClass: e.failureClass });
          return;
        }
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Forward message
  // CONTRACT: http.whatsapp-connector.messages-forward.v1 — body, {forwarded, messageId}, 404 message_unavailable
  router.post('/messages/forward', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        if (
          process.env.ENABLE_SENDING !== 'true' ||
          process.env.EMERGENCY_DISABLE_SENDING === 'true'
        ) {
          res.status(403).json({ error: 'Sending disabled' });
          return;
        }
        const { chatId, messageId, toChatId } = req.body;
        if (!chatId || !messageId || !toChatId) {
          res.status(400).json({ error: 'Missing chatId, messageId, or toChatId' });
          return;
        }
        const forwardedMessageId = await client.forwardMessage(chatId, messageId, toChatId);
        res.json({ forwarded: true, messageId: forwardedMessageId });
      } catch (e) {
        if (e instanceof MessageUnavailableError) {
          res.status(e.status).json({ error: e.message, failureClass: e.failureClass });
          return;
        }
        res.status(500).json({ error: String(e) });
      }
    })();
  });

  // Edit one of our own text messages (fase 3 / PR-3).
  // CONTRACT: http.whatsapp-connector.messages-edit.v1 — body {chatId, messageId, content}, 200 {edited, messageId, editId, editedAt}
  router.post('/messages/edit', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        if (rejectWhenSendingDisabled(res)) return;
        const body = optionalObject(req.body);
        const chatId = optionalString(body.chatId ?? body.conversationId);
        const messageId = optionalString(body.messageId);
        const content = typeof body.content === 'string' ? body.content : '';
        if (!chatId || !messageId || !content.trim()) {
          res.status(400).json({
            error: 'Missing chatId, messageId or content',
            failureClass: 'invalid_request',
          });
          return;
        }
        if (rejectWhenDisconnected(client, res)) return;
        const result = await client.editMessage(chatId, messageId, content, {
          actor: actorFromBody(body.actor),
        });
        res.json({ edited: true, ...result });
      } catch (e) {
        mutationErrorResponse(res, e, 'edit message');
      }
    })();
  });

  // Delete for everyone (revoke) or, with forMe: true, only for this account.
  // CONTRACT: http.whatsapp-connector.messages-delete.v1 — body {chatId, messageId, forMe?}, 200 {deleted, scope, messageId, deletedAt}
  router.post('/messages/delete', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        if (rejectWhenSendingDisabled(res)) return;
        const body = optionalObject(req.body);
        const chatId = optionalString(body.chatId ?? body.conversationId);
        const messageId = optionalString(body.messageId);
        if (
          !chatId ||
          !messageId ||
          (body.forMe !== undefined && typeof body.forMe !== 'boolean')
        ) {
          res.status(400).json({
            error: 'Missing chatId or messageId (forMe must be a boolean)',
            failureClass: 'invalid_request',
          });
          return;
        }
        if (rejectWhenDisconnected(client, res)) return;
        const request = { actor: actorFromBody(body.actor) };
        const forMe = body.forMe === true;
        const result = forMe
          ? await client.deleteMessageForMe(chatId, messageId, request)
          : await client.deleteMessage(chatId, messageId, request);
        res.json({ deleted: true, scope: forMe ? 'me' : 'everyone', ...result });
      } catch (e) {
        mutationErrorResponse(res, e, 'delete message');
      }
    })();
  });

  // Legacy delete for everyone (path params are not covered by the HMAC:
  // prefer POST /messages/delete). Same gate and behaviour.
  router.delete(
    '/messages/:chatId/:msgId',
    auth,
    (req: AuthenticatedRequest, res: Response): void => {
      void (async () => {
        try {
          if (rejectWhenSendingDisabled(res)) return;
          if (rejectWhenDisconnected(client, res)) return;
          const result = await client.deleteMessage(req.params.chatId, req.params.msgId);
          res.json({ deleted: true, scope: 'everyone', ...result });
        } catch (e) {
          mutationErrorResponse(res, e, 'delete message');
        }
      })();
    }
  );

  // Mark chat as read
  router.post('/messages/read/:chatId', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        await client.markAsRead(req.params.chatId);
        res.json({ markedAsRead: true });
      } catch (e) {
        res.status(500).json({ error: String(e) });
      }
    })();
  });
  return router;
}
