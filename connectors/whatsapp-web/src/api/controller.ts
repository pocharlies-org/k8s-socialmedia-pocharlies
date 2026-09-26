import { createConnectorAccess, secretEquals } from './access';
import express, { Request, Response } from 'express';
import { createHash } from 'crypto';
import {
  BaileysClient,
  ProfilePictureDownloadError,
  ProfilePictureTimeoutError,
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
import { CapabilityError } from '../whatsapp-capabilities';
import {
  claimSendAttempt,
  confirmTextSend,
  reserveMediaSend,
  reserveTextSend,
  reserveVoiceSend,
  SendAlreadyClaimedError,
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

function capabilityErrorResponse(res: Response, error: unknown): void {
  if (error instanceof CapabilityError) {
    res.status(error.status).json({
      ok: false,
      error: { code: error.code, message: error.message, details: error.details || undefined },
    });
    return;
  }
  res
    .status(500)
    .json({ ok: false, error: { code: 'CONNECTOR_ERROR', message: errorMessage(error) } });
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
    if (adminToken && bearer && secretEquals(bearer, adminToken)) {
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
  router.use(createConnectorAccess(sharedSecret));
  const auth = createHMACAuth(sharedSecret);
  const manualOpenAuth = createManualOpenAuth(auth, sharedSecret);

  // Detailed health requires authentication; access middleware provides anonymous liveness.
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

  // QR access is protected by the router access middleware.
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
      let attemptedMessageId: string | undefined;
      let reservedMessageId: string | undefined;
      try {
        const body = req.body as {
          sendToken?: string;
          conversationId?: string;
          content?: string;
          replyToMessageId?: string;
        };
        const { sendToken, conversationId, content, replyToMessageId } = body;
        requestConversationId = conversationId;
        requestContent = content;

        if (
          typeof sendToken !== 'string' ||
          !sendToken.trim() ||
          sendToken.length > 200 ||
          typeof conversationId !== 'string' ||
          !conversationId ||
          typeof content !== 'string' ||
          !content
        ) {
          console.warn(
            `WhatsApp send rejected failureClass=invalid_request conversationId=${conversationId || ''}`
          );
          res.status(statusForSendFailure('invalid_request')).json({
            error: 'Missing required fields',
            failureClass: 'invalid_request',
          });
          return;
        }

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

        let reservation;
        try {
          reservation = await reserveTextSend({
            token: sendToken,
            conversationId,
            content,
            replyToMessageId,
          });
        } catch (error) {
          if (errorMessage(error) === 'Invalid sendToken') {
            res.status(400).json({ error: 'Invalid sendToken', failureClass: 'invalid_request' });
            return;
          }
          throw error;
        }
        if (reservation.state === 'conflict') {
          res.status(409).json({
            error: 'sendToken was already used for a different message',
            failureClass: 'invalid_request',
          });
          return;
        }
        if (reservation.state === 'pending') {
          res.status(409).json({
            error: 'Send outcome is uncertain; check message history before a new send',
            failureClass: 'send_outcome_uncertain',
            messageId: reservation.messageId,
          });
          return;
        }
        if (reservation.state === 'sent') {
          res.json({
            messageId: reservation.messageId,
            sentAt: reservation.sentAt,
            deduplicated: true,
          });
          return;
        }
        reservedMessageId = reservation.messageId;
        const messageId = await client.sendMessage(conversationId, content, {
          replyToMessageId,
          messageId: reservation.messageId,
          beforeSend: async () => {
            await claimSendAttempt(sendToken, reservation.messageId);
            attemptedMessageId = reservation.messageId;
          },
        });
        if (messageId !== reservation.messageId) {
          throw new Error(`Baileys returned unexpected message ID: ${messageId || 'missing'}`);
        }
        const sentAt = await confirmTextSend(sendToken, messageId);
        console.info(
          `WhatsApp send ok conversationId=${conversationId} messageId=${messageId || ''}`
        );

        res.json({
          messageId,
          sentAt,
        });
      } catch (error) {
        if (error instanceof SendAlreadyClaimedError) {
          res.status(409).json({
            error: 'Send outcome is uncertain; check message history before a new send',
            failureClass: 'send_outcome_uncertain',
            messageId: reservedMessageId,
          });
          return;
        }
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
              undefined,
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
          ...(attemptedMessageId ? { messageId: attemptedMessageId, outcomeUncertain: true } : {}),
        });
      }
    })();
  });

  // Send a voice note (requires auth) — {conversationId, audioBase64, mimeType}
  router.post('/messages/audio', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      let attemptedMessageId: string | undefined;
      let reservedMessageId: string | undefined;
      try {
        const body = req.body as {
          conversationId?: string;
          audioBase64?: string;
          mimeType?: string;
          sendToken?: string;
          sourceDigest?: string;
          sourceMimeType?: string;
        };
        const { conversationId, audioBase64, mimeType, sendToken, sourceDigest, sourceMimeType } =
          body;

        if (
          !conversationId ||
          !audioBase64 ||
          (sendToken !== undefined &&
            (typeof sendToken !== 'string' || !sendToken.trim() || sendToken.length > 200))
        ) {
          res
            .status(400)
            .json({ error: 'Missing or invalid conversationId, audioBase64, or sendToken' });
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

        const voiceMimeType = mimeType || 'audio/ogg; codecs=opus';
        const reservation = sendToken
          ? await reserveVoiceSend({
              token: sendToken,
              conversationId,
              audioBase64,
              mimeType: voiceMimeType,
              sourceDigest,
              sourceMimeType,
            })
          : undefined;
        if (reservation?.state === 'conflict') {
          res.status(409).json({
            error: 'sendToken was already used for a different message',
            failureClass: 'invalid_request',
          });
          return;
        }
        if (reservation?.state === 'pending') {
          res.status(409).json({
            error: 'Send outcome is uncertain; check message history before a new send',
            failureClass: 'send_outcome_uncertain',
            messageId: reservation.messageId,
          });
          return;
        }
        if (reservation?.state === 'sent') {
          res.json({
            messageId: reservation.messageId,
            sentAt: reservation.sentAt,
            deduplicated: true,
          });
          return;
        }
        reservedMessageId = reservation?.messageId;
        const buf = Buffer.from(audioBase64, 'base64');
        const messageId = await client.sendVoice(
          conversationId,
          buf,
          voiceMimeType,
          reservation?.messageId,
          reservation
            ? async () => {
                await claimSendAttempt(sendToken!, reservation.messageId);
                attemptedMessageId = reservation.messageId;
              }
            : undefined
        );
        if (reservation && messageId !== reservation.messageId)
          throw new Error('Baileys returned unexpected voice message ID');
        const sentAt = reservation
          ? await confirmTextSend(sendToken!, messageId!)
          : new Date().toISOString();
        console.info(
          `WhatsApp voice sent conversationId=${conversationId} messageId=${messageId || ''}`
        );
        res.json({ messageId, sentAt });
      } catch (error) {
        if (error instanceof SendAlreadyClaimedError) {
          res.status(409).json({
            error: 'Send outcome is uncertain; check message history before a new send',
            failureClass: 'send_outcome_uncertain',
            messageId: reservedMessageId,
          });
          return;
        }
        const failureClass = classifyWhatsAppSendFailure(error);
        res.status(statusForSendFailure(failureClass)).json({
          error: `Failed to send voice: ${errorMessage(error)}`,
          failureClass,
          ...(attemptedMessageId ? { messageId: attemptedMessageId, outcomeUncertain: true } : {}),
        });
      }
    })();
  });

  // React to a message (requires auth)
  router.post('/messages/react', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        const body = req.body as { conversationId?: string; messageId?: string; emoji?: string };
        const { conversationId, messageId, emoji } = body;

        // Empty `emoji` is a valid signal to REMOVE the reaction. Baileys
        // accepts `{ react: { text: '', key } }` for un-react.
        if (!conversationId || !messageId) {
          res.status(400).json({ error: 'Missing conversationId or messageId' });
          return;
        }

        if (
          process.env.ENABLE_SENDING !== 'true' ||
          process.env.EMERGENCY_DISABLE_SENDING === 'true'
        ) {
          res.status(403).json({ error: 'Sending is disabled' });
          return;
        }

        await client.reactToMessage(conversationId, messageId, emoji || '');

        res.json({
          reacted: true,
          emoji: emoji || '',
          messageId,
          reactedAt: new Date().toISOString(),
        });
      } catch (error) {
        res.status(500).json({ error: 'Failed to react: ' + String(error) });
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

  router.post(
    '/chats/archive-snapshot/preview',
    auth,
    (req: AuthenticatedRequest, res: Response): void => {
      void (async () => {
        try {
          res.json({ ok: true, ...(await client.previewArchiveSnapshot()) });
        } catch (error) {
          capabilityErrorResponse(res, error);
        }
      })();
    }
  );

  router.post(
    '/chats/archive-snapshot/apply',
    auth,
    (req: AuthenticatedRequest, res: Response): void => {
      void (async () => {
        try {
          res.json({ ok: true, ...(await client.syncArchiveSnapshot()) });
        } catch (error) {
          capabilityErrorResponse(res, error);
        }
      })();
    }
  );

  // Get group info
  router.post('/chats/start', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const phone = typeof req.body?.phone === 'string' ? req.body.phone : '';
        const chat = await client.startChat(phone);
        res.status(201).json({ ok: true, chat });
      } catch (error) {
        capabilityErrorResponse(res, error);
      }
    })();
  });

  router.get('/groups/:id/info', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const info = await client.getGroupInfo(req.params.id);
        res.json(info);
      } catch (e) {
        capabilityErrorResponse(res, e);
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
        capabilityErrorResponse(res, e);
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
        if (e instanceof ProfilePictureTimeoutError) {
          res.status(504).json({ error: 'WhatsApp profile picture timed out' });
          return;
        }
        if (e instanceof ProfilePictureDownloadError) {
          res.status(502).json({ error: e.message });
          return;
        }
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
      let attemptedMessageId: string | undefined;
      let reservedMessageId: string | undefined;
      try {
        if (
          process.env.ENABLE_SENDING !== 'true' ||
          process.env.EMERGENCY_DISABLE_SENDING === 'true'
        ) {
          res.status(403).json({ error: 'Sending disabled' });
          return;
        }
        const {
          conversationId,
          fileUrl,
          fileName,
          caption,
          asSticker,
          kind,
          replyTo,
          sendToken,
          sourceDigest,
          sourceMimeType,
        } = req.body as {
          conversationId?: string;
          fileUrl?: string;
          fileName?: string;
          caption?: string;
          asSticker?: boolean;
          kind?: string;
          replyTo?: string;
          sendToken?: string;
          sourceDigest?: string;
          sourceMimeType?: string;
        };
        if (
          !conversationId ||
          !fileUrl ||
          (sendToken !== undefined &&
            (typeof sendToken !== 'string' || !sendToken.trim() || sendToken.length > 200))
        ) {
          res
            .status(400)
            .json({ error: 'Missing or invalid conversationId, fileUrl, or sendToken' });
          return;
        }
        const options = {
          asSticker: !!asSticker || kind === 'sticker',
          asGif: kind === 'gif',
          replyToMessageId: optionalString(replyTo),
          fileName: optionalString(fileName),
        };
        const reservation = sendToken
          ? await reserveMediaSend({
              token: sendToken,
              conversationId,
              fileUrl,
              fileName: options.fileName,
              caption,
              asSticker: options.asSticker,
              asGif: options.asGif,
              replyToMessageId: options.replyToMessageId,
              sourceDigest,
              sourceMimeType,
            })
          : undefined;
        if (reservation?.state === 'conflict') {
          res.status(409).json({
            error: 'sendToken was already used for a different message',
            failureClass: 'invalid_request',
          });
          return;
        }
        if (reservation?.state === 'pending') {
          res.status(409).json({
            error: 'Send outcome is uncertain; check message history before a new send',
            failureClass: 'send_outcome_uncertain',
            messageId: reservation.messageId,
          });
          return;
        }
        if (reservation?.state === 'sent') {
          res.json({
            sent: true,
            messageId: reservation.messageId,
            sentAt: reservation.sentAt,
            deduplicated: true,
          });
          return;
        }
        reservedMessageId = reservation?.messageId;
        const messageId = await client.sendFile(conversationId, fileUrl, caption, {
          ...options,
          messageId: reservation?.messageId,
          beforeSend: reservation
            ? async () => {
                await claimSendAttempt(sendToken!, reservation.messageId);
                attemptedMessageId = reservation.messageId;
              }
            : undefined,
        });
        if (reservation && messageId !== reservation.messageId)
          throw new Error('Baileys returned unexpected media message ID');
        const sentAt = reservation
          ? await confirmTextSend(sendToken!, messageId!)
          : new Date().toISOString();
        res.json({ sent: true, messageId, sentAt });
      } catch (e) {
        if (e instanceof SendAlreadyClaimedError) {
          res.status(409).json({
            error: 'Send outcome is uncertain; check message history before a new send',
            failureClass: 'send_outcome_uncertain',
            messageId: reservedMessageId,
          });
          return;
        }
        const failureClass = classifyWhatsAppSendFailure(e);
        res.status(statusForSendFailure(failureClass)).json({
          error: errorMessage(e),
          failureClass,
          ...(attemptedMessageId ? { messageId: attemptedMessageId, outcomeUncertain: true } : {}),
        });
      }
    })();
  });

  for (const [path, kind] of [
    ['/messages/sticker', 'sticker'],
    ['/messages/gif', 'gif'],
  ] as const) {
    router.post(path, auth, (req: AuthenticatedRequest, res: Response): void => {
      void (async () => {
        try {
          if (
            process.env.ENABLE_SENDING !== 'true' ||
            process.env.EMERGENCY_DISABLE_SENDING === 'true'
          ) {
            res.status(403).json({
              ok: false,
              error: { code: 'SENDING_DISABLED', message: 'Sending is disabled' },
            });
            return;
          }
          const body = (req.body || {}) as {
            conversationId?: string;
            fileUrl?: string;
            caption?: string;
            fileName?: string;
            replyTo?: string;
          };
          if (!body.conversationId || !body.fileUrl)
            throw new CapabilityError(
              'INVALID_CAPABILITY_INPUT',
              'conversationId and fileUrl are required'
            );
          const messageId = await client.sendFile(body.conversationId, body.fileUrl, body.caption, {
            asSticker: kind === 'sticker',
            asGif: kind === 'gif',
            fileName: optionalString(body.fileName),
            replyToMessageId: optionalString(body.replyTo),
          });
          res.json({ ok: true, messageId, sent: true, kind });
        } catch (error) {
          capabilityErrorResponse(res, error);
        }
      })();
    });
  }

  // Forward message
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
        res.json({ ok: true, forwarded: true, messageId: forwardedMessageId });
      } catch (e) {
        capabilityErrorResponse(res, e);
      }
    })();
  });

  // Delete message
  router.delete(
    '/messages/:chatId/:msgId/for-me',
    auth,
    (req: AuthenticatedRequest, res: Response): void => {
      void (async () => {
        try {
          if (
            process.env.ENABLE_SENDING !== 'true' ||
            process.env.EMERGENCY_DISABLE_SENDING === 'true'
          ) {
            res.status(403).json({
              ok: false,
              error: { code: 'SENDING_DISABLED', message: 'Sending is disabled' },
            });
            return;
          }
          await client.deleteMessageForMe(req.params.chatId, req.params.msgId);
          res.json({ ok: true, deletedForMe: true, messageId: req.params.msgId });
        } catch (error) {
          capabilityErrorResponse(res, error);
        }
      })();
    }
  );

  router.delete(
    '/messages/:chatId/:msgId',
    auth,
    (req: AuthenticatedRequest, res: Response): void => {
      void (async () => {
        try {
          if (
            process.env.ENABLE_SENDING !== 'true' ||
            process.env.EMERGENCY_DISABLE_SENDING === 'true'
          ) {
            res.status(403).json({ error: 'Sending disabled' });
            return;
          }
          await client.deleteMessage(req.params.chatId, req.params.msgId);
          res.json({ ok: true, deleted: true, messageId: req.params.msgId });
        } catch (e) {
          capabilityErrorResponse(res, e);
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

  router.post('/messages/edit', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        if (
          process.env.ENABLE_SENDING !== 'true' ||
          process.env.EMERGENCY_DISABLE_SENDING === 'true'
        ) {
          res.status(403).json({
            ok: false,
            error: { code: 'SENDING_DISABLED', message: 'Sending is disabled' },
          });
          return;
        }
        const body = req.body as {
          conversationId?: string;
          chatId?: string;
          messageId?: string;
          content?: string;
        };
        const chatId = body.conversationId || body.chatId;
        if (!chatId || !body.messageId || !body.content) {
          res.status(400).json({
            ok: false,
            error: {
              code: 'INVALID_REQUEST',
              message: 'conversationId, messageId, and content are required',
            },
          });
          return;
        }
        const messageId = await client.editMessage(chatId, body.messageId, body.content);
        res.json({ ok: true, messageId, edited: true });
      } catch (error) {
        capabilityErrorResponse(res, error);
      }
    })();
  });

  router.patch(
    '/messages/:chatId/:msgId',
    auth,
    (req: AuthenticatedRequest, res: Response): void => {
      void (async () => {
        try {
          if (
            process.env.ENABLE_SENDING !== 'true' ||
            process.env.EMERGENCY_DISABLE_SENDING === 'true'
          ) {
            res.status(403).json({
              ok: false,
              error: { code: 'SENDING_DISABLED', message: 'Sending is disabled' },
            });
            return;
          }
          const content = optionalString((req.body || {}).content || (req.body || {}).text);
          if (!content) {
            res.status(400).json({
              ok: false,
              error: { code: 'INVALID_REQUEST', message: 'content is required' },
            });
            return;
          }
          const messageId = await client.editMessage(req.params.chatId, req.params.msgId, content);
          res.json({ ok: true, messageId, edited: true });
        } catch (error) {
          capabilityErrorResponse(res, error);
        }
      })();
    }
  );

  router.post('/chats/:chatId/modify', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = (req.body || {}) as Record<string, unknown>;
        const action = optionalString(body.action);
        if (!action) {
          res
            .status(400)
            .json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'action is required' } });
          return;
        }
        const ids = Array.isArray(body.messageIds)
          ? (body.messageIds
              .map(id => (typeof id === 'string' ? { id } : id))
              .filter(item => item && typeof item.id === 'string') as Array<{
              id: string;
              fromMe?: boolean;
            }>)
          : [];
        const value = body.value ?? body.enabled ?? body.durationMs;
        const result = await client.modifyChat(req.params.chatId, action, value, ids);
        res.json({ ok: true, data: result });
      } catch (error) {
        capabilityErrorResponse(res, error);
      }
    })();
  });

  router.post('/groups/create', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        if (
          process.env.ENABLE_SENDING !== 'true' ||
          process.env.EMERGENCY_DISABLE_SENDING === 'true'
        ) {
          res.status(403).json({
            ok: false,
            error: { code: 'SENDING_DISABLED', message: 'Sending is disabled' },
          });
          return;
        }
        const body = (req.body || {}) as { subject?: string; participants?: string[] };
        const result = await client.createGroup(
          body.subject || '',
          Array.isArray(body.participants) ? body.participants : []
        );
        res.status(201).json({ ok: true, data: result });
      } catch (error) {
        capabilityErrorResponse(res, error);
      }
    })();
  });

  router.post('/groups/:id/update', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        if (
          process.env.ENABLE_SENDING !== 'true' ||
          process.env.EMERGENCY_DISABLE_SENDING === 'true'
        ) {
          res.status(403).json({
            ok: false,
            error: { code: 'SENDING_DISABLED', message: 'Sending is disabled' },
          });
          return;
        }
        const result = await client.updateGroup(req.params.id, req.body || {});
        res.json({ ok: true, data: result });
      } catch (error) {
        capabilityErrorResponse(res, error);
      }
    })();
  });

  router.post(
    '/groups/:id/participants',
    auth,
    (req: AuthenticatedRequest, res: Response): void => {
      void (async () => {
        try {
          if (
            process.env.ENABLE_SENDING !== 'true' ||
            process.env.EMERGENCY_DISABLE_SENDING === 'true'
          ) {
            res.status(403).json({
              ok: false,
              error: { code: 'SENDING_DISABLED', message: 'Sending is disabled' },
            });
            return;
          }
          const body = (req.body || {}) as {
            action?: 'add' | 'remove' | 'promote' | 'demote';
            participants?: string[];
          };
          const result = await client.updateGroupParticipants(
            req.params.id,
            Array.isArray(body.participants) ? body.participants : [],
            body.action as any
          );
          res.json({ ok: true, data: result });
        } catch (error) {
          capabilityErrorResponse(res, error);
        }
      })();
    }
  );

  router.get('/contacts', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const contacts = await client.listContacts(Number(req.query.limit || 500));
        res.json({ ok: true, contacts });
      } catch (error) {
        capabilityErrorResponse(res, error);
      }
    })();
  });

  router.post('/contacts/create', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        if (
          process.env.ENABLE_SENDING !== 'true' ||
          process.env.EMERGENCY_DISABLE_SENDING === 'true'
        ) {
          res.status(403).json({
            ok: false,
            error: { code: 'SENDING_DISABLED', message: 'Sending is disabled' },
          });
          return;
        }
        const result = await client.createContact(req.body || {});
        res.status(201).json({ ok: true, data: result });
      } catch (error) {
        capabilityErrorResponse(res, error);
      }
    })();
  });

  router.post('/contacts', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        if (
          process.env.ENABLE_SENDING !== 'true' ||
          process.env.EMERGENCY_DISABLE_SENDING === 'true'
        ) {
          res.status(403).json({
            ok: false,
            error: { code: 'SENDING_DISABLED', message: 'Sending is disabled' },
          });
          return;
        }
        res.status(201).json({ ok: true, data: await client.createContact(req.body || {}) });
      } catch (error) {
        capabilityErrorResponse(res, error);
      }
    })();
  });

  router.post('/contacts/share', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        if (
          process.env.ENABLE_SENDING !== 'true' ||
          process.env.EMERGENCY_DISABLE_SENDING === 'true'
        ) {
          res.status(403).json({
            ok: false,
            error: { code: 'SENDING_DISABLED', message: 'Sending is disabled' },
          });
          return;
        }
        const body = (req.body || {}) as Record<string, unknown>;
        const chatId = optionalString(body.conversationId || body.chatId);
        if (!chatId)
          throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'conversationId is required');
        const messageId = await client.shareContact(chatId, {
          displayName: optionalString(body.displayName) || '',
          phone: optionalString(body.phone) || '',
          organization: optionalString(body.organization),
          email: optionalString(body.email),
        });
        res.json({ ok: true, messageId, sent: true });
      } catch (error) {
        capabilityErrorResponse(res, error);
      }
    })();
  });

  router.post('/messages/poll', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        if (
          process.env.ENABLE_SENDING !== 'true' ||
          process.env.EMERGENCY_DISABLE_SENDING === 'true'
        ) {
          res.status(403).json({
            ok: false,
            error: { code: 'SENDING_DISABLED', message: 'Sending is disabled' },
          });
          return;
        }
        const body = (req.body || {}) as Record<string, unknown>;
        const chatId = optionalString(body.conversationId || body.chatId);
        if (!chatId)
          throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'conversationId is required');
        const messageId = await client.sendPoll(chatId, {
          name: optionalString(body.name) || '',
          values: Array.isArray(body.values) ? body.values.map(String) : [],
          selectableCount:
            body.selectableCount === undefined ? undefined : Number(body.selectableCount),
        });
        res.json({ ok: true, messageId, sent: true });
      } catch (error) {
        capabilityErrorResponse(res, error);
      }
    })();
  });

  router.post('/messages/poll/vote', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        if (
          process.env.ENABLE_SENDING !== 'true' ||
          process.env.EMERGENCY_DISABLE_SENDING === 'true'
        ) {
          res.status(403).json({
            ok: false,
            error: { code: 'SENDING_DISABLED', message: 'Sending is disabled' },
          });
          return;
        }
        const body = (req.body || {}) as Record<string, unknown>;
        const chatId = optionalString(body.conversationId || body.chatId);
        if (!chatId)
          throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'conversationId is required');
        const pollMessageId = optionalString(body.pollMessageId || body.messageId);
        if (!pollMessageId)
          throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'pollMessageId is required');
        const messageId = await client.sendPollVote(chatId, {
          pollMessageId,
          options: body.options,
        });
        res.json({ ok: true, messageId: messageId ?? null, sent: true });
      } catch (error) {
        capabilityErrorResponse(res, error);
      }
    })();
  });

  router.post('/messages/poll/results', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = (req.body || {}) as Record<string, unknown>;
        const chatId = optionalString(body.conversationId || body.chatId);
        if (!chatId)
          throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'conversationId is required');
        if (!Array.isArray(body.pollMessageIds) || body.pollMessageIds.length === 0)
          throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'pollMessageIds is required');
        if (body.pollMessageIds.length > 50)
          throw new CapabilityError(
            'INVALID_CAPABILITY_INPUT',
            'At most 50 pollMessageIds are allowed per request'
          );
        const pollMessageIds: string[] = [];
        for (const value of body.pollMessageIds) {
          const id = optionalString(value);
          if (id) pollMessageIds.push(id);
        }
        if (!pollMessageIds.length)
          throw new CapabilityError(
            'INVALID_CAPABILITY_INPUT',
            'pollMessageIds must contain non-empty ids'
          );
        const polls = await client.getPollResults(chatId, pollMessageIds);
        res.json({ ok: true, polls });
      } catch (error) {
        capabilityErrorResponse(res, error);
      }
    })();
  });

  router.post('/messages/event', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        if (
          process.env.ENABLE_SENDING !== 'true' ||
          process.env.EMERGENCY_DISABLE_SENDING === 'true'
        ) {
          res.status(403).json({
            ok: false,
            error: { code: 'SENDING_DISABLED', message: 'Sending is disabled' },
          });
          return;
        }
        const body = (req.body || {}) as Record<string, unknown>;
        const chatId = optionalString(body.conversationId || body.chatId);
        const startDate = new Date(String(body.startDate || ''));
        const locationValue =
          body.location && typeof body.location === 'object' && !Array.isArray(body.location)
            ? (body.location as Record<string, unknown>)
            : undefined;
        if (!chatId)
          throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'conversationId is required');
        const messageId = await client.sendEvent(chatId, {
          name: optionalString(body.name) || '',
          description: optionalString(body.description),
          startDate,
          endDate: body.endDate ? new Date(String(body.endDate)) : undefined,
          location: locationValue
            ? {
                degreesLatitude: Number(locationValue.degreesLatitude),
                degreesLongitude: Number(locationValue.degreesLongitude),
                ...(optionalString(locationValue.name)
                  ? { name: optionalString(locationValue.name) }
                  : {}),
              }
            : undefined,
          call: body.call === 'audio' || body.call === 'video' ? body.call : undefined,
          isCancelled: body.isCancelled === undefined ? undefined : Boolean(body.isCancelled),
          extraGuestsAllowed:
            body.extraGuestsAllowed === undefined ? undefined : Boolean(body.extraGuestsAllowed),
        });
        res.json({ ok: true, messageId, sent: true });
      } catch (error) {
        capabilityErrorResponse(res, error);
      }
    })();
  });

  router.get('/chats/:chatId/presence', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const data = await client.getPresence(
          req.params.chatId,
          optionalString(req.query.participant)
        );
        res.json({ ok: true, data });
      } catch (error) {
        capabilityErrorResponse(res, error);
      }
    })();
  });

  router.post('/chats/:chatId/presence', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = (req.body || {}) as { action?: string; status?: any };
        if (body.action === 'subscribe') {
          res.json({ ok: true, data: await client.subscribePresence(req.params.chatId) });
          return;
        }
        res.json({ ok: true, data: await client.updatePresence(req.params.chatId, body.status) });
      } catch (error) {
        capabilityErrorResponse(res, error);
      }
    })();
  });

  router.get('/privacy', auth, (_req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        res.json({ ok: true, data: await client.getPrivacySettings() });
      } catch (error) {
        capabilityErrorResponse(res, error);
      }
    })();
  });

  router.post('/privacy', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = (req.body || {}) as { field?: string; value?: string };
        if (!body.field || body.value === undefined || body.value === null || body.value === '') {
          throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'field and value are required');
        }
        if (body.field === 'defaultDisappearing') {
          res.json({ ok: true, data: await client.setDefaultDisappearing(Number(body.value)) });
          return;
        }
        res.json({ ok: true, data: await client.updatePrivacy(body.field, body.value) });
      } catch (error) {
        capabilityErrorResponse(res, error);
      }
    })();
  });

  router.get(
    '/chats/:chatId/disappearing',
    auth,
    (req: AuthenticatedRequest, res: Response): void => {
      void (async () => {
        try {
          res.json({ ok: true, data: await client.getDisappearing(req.params.chatId) });
        } catch (error) {
          capabilityErrorResponse(res, error);
        }
      })();
    }
  );

  router.post(
    '/chats/:chatId/disappearing',
    auth,
    (req: AuthenticatedRequest, res: Response): void => {
      void (async () => {
        try {
          const expiration = (req.body || {}).expiration;
          if (typeof expiration !== 'number' && typeof expiration !== 'boolean')
            throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'expiration is required');
          res.json({ ok: true, data: await client.setDisappearing(req.params.chatId, expiration) });
        } catch (error) {
          capabilityErrorResponse(res, error);
        }
      })();
    }
  );
  return router;
}
