import express, { Request, Response } from 'express';
import { createHash } from 'crypto';
import {
  BaileysClient,
  classifyWhatsAppSendFailure,
  normalizeChatModifyAction,
  ProfilePictureDownloadError,
  ProfilePictureTimeoutError,
  WhatsAppSendError,
  WhatsAppSendFailureClass,
} from '../baileys-client';
import { MuteState } from '../chat-state';
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
import { parsePinRequest, parseStarredQuery, parseStarRequest } from '../message-stars-pins';
import { parseChannelPostsQuery, parseStatusListQuery } from '../statuses';
import { PollEventInputError, validatePollInput } from '../poll-votes';
import { validateEventInput, validateEventResponse } from '../event-responses';
import { availablePresenceAllowed, parsePresenceRequest } from '../presence';
import { parsePrivacyRequest } from '../privacy-settings';
import { parseDisappearingExpiration } from '../disappearing';
import {
  parseCreateContactRequest,
  parseShareContactRequest,
  parseStartChatRequest,
  StartedChat,
} from '../contacts';
import { parseStickerGifRequest, stickerGifHashInput } from '../sticker-gif';
import { parseContactBlockRequest } from '../contact-block';
import {
  parseCommunityDescription,
  parseCommunityGroupRequest,
  parseCommunityJid,
  parseCommunitySubject,
  requireLeaveConfirmation,
} from '../communities';
import { parseChannelJid, parseChannelQuery, parseChannelSubscriptionAction } from '../channels';
import {
  GroupActionError,
  normalizeGroupParticipantAction,
  parseGroupJid,
  parseGroupInviteParticipants,
  parseGroupInviteText,
  parseGroupParticipants,
  parseGroupSubject,
  parseGroupUpdate,
} from '../group-management';
import {
  claimSendAttempt,
  confirmSend,
  mediaRequestHash,
  readIdempotencyKey,
  recordSendFailure,
  reserveSend,
  SendAlreadyClaimedError,
  SendReservation,
  structuredRequestHash,
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

/**
 * The first-contact guard of a 1:1 send (or another classified send failure)
 * keeps its status — 403 account_restricted — on routes that otherwise
 * answer 500.
 */
function directSendRefused(res: Response, error: unknown): boolean {
  if (!(error instanceof WhatsAppSendError)) return false;
  const failureClass = classifyWhatsAppSendFailure(error);
  res.status(statusForSendFailure(failureClass)).json({ error: errorMessage(error), failureClass });
  return true;
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
  if (error instanceof PollEventInputError) {
    res.status(error.status).json({
      error: error.message,
      failureClass: error.failureClass,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }
  if (error instanceof MessageUnavailableError || error instanceof MessageMutationError) {
    res.status(error.status).json({
      error: error.message,
      failureClass: error.failureClass,
      ...(error instanceof MessageMutationError && error.code ? { code: error.code } : {}),
      // Group actions: per-participant results, what was already applied.
      ...(error instanceof GroupActionError && error.details ? error.details : {}),
    });
    return;
  }
  const failureClass = classifyWhatsAppSendFailure(error);
  res.status(statusForSendFailure(failureClass)).json({
    error: `Failed to ${what}: ${errorMessage(error)}`,
    failureClass,
  });
}

/** Longest timed mute accepted; beyond that, mute without an end ("always"). */
const MAX_MUTE_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * Mute end of a /chats/modify body: `durationMs` (from now) or `muteUntil`
 * (ISO-8601 or epoch ms), neither = forever. A string is the 400 reason.
 */
function muteFromBody(body: Record<string, unknown>): MuteState | string {
  const hasDuration = body.durationMs !== undefined && body.durationMs !== null;
  const hasUntil = body.muteUntil !== undefined && body.muteUntil !== null;
  if (hasDuration && hasUntil) return 'Pass durationMs or muteUntil, not both';
  const now = Date.now();
  let until: number | undefined;
  if (hasDuration) {
    const ms = typeof body.durationMs === 'number' ? body.durationMs : Number(body.durationMs);
    if (!Number.isInteger(ms) || ms <= 0) return 'durationMs must be a positive integer';
    until = now + ms;
  } else if (hasUntil) {
    const raw = body.muteUntil;
    until = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : NaN;
    if (!Number.isFinite(until) || until <= now) return 'muteUntil must be a future time';
  }
  if (until !== undefined && until - now > MAX_MUTE_MS) {
    return 'A timed mute is at most 366 days (omit durationMs / muteUntil to mute always)';
  }
  return { until: until === undefined ? null : new Date(until) };
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

/**
 * Polls, votes, events and responses (fase 3 / PR-7): the send gate, the
 * connection and the opt-in Idempotency-Key, after the body was validated.
 * null when the response was already sent (403 / 503 / replay / 409);
 * otherwise the attempt (null inside when there is no key) to hand the client.
 */
async function beginStructuredSend(
  client: BaileysClient,
  req: AuthenticatedRequest,
  res: Response,
  requestHash: () => string
): Promise<{ attempt: IdempotentSend | null } | null> {
  if (rejectWhenSendingDisabled(res)) return null;
  if (rejectWhenDisconnected(client, res)) return null;
  const begun = await beginIdempotentSend(client, req, res, requestHash, reservation => ({
    messageId: reservation.messageId,
    sentAt: reservation.sentAt,
  }));
  if (begun === 'answered') return null;
  return { attempt: begun };
}

function structuredSendOptions(attempt: IdempotentSend | null, actor: string | undefined) {
  return attempt
    ? { messageId: attempt.messageId, beforeSend: attempt.beforeSend, actor }
    : { actor };
}

/** Error path of a structured send: the idempotency bookkeeping, then the usual mapping. */
async function failStructuredSend(
  attempt: IdempotentSend | null,
  error: unknown,
  res: Response,
  what: string
): Promise<void> {
  if (await failIdempotentSend(attempt, error, res)) return;
  mutationErrorResponse(res, error, what);
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

  // Polls and events (fase 3 / PR-7). Ids inside the signed body. The body is
  // validated first (400), then — for the four that reach people — the same
  // gate as every send (403), the connection (503) and the opt-in
  // Idempotency-Key (PR-2). Results are reads: no gate.

  // CONTRACT: http.whatsapp-connector.messages-poll.v1 — body {conversationId, name, options[2..12], selectableCount?, actor?}, 200 {sent, messageId, conversationId, sentAt}
  router.post('/messages/poll', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      let attempt: IdempotentSend | null = null;
      try {
        const body = optionalObject(req.body);
        const chatId = optionalString(body.conversationId ?? body.chatId);
        if (!chatId) {
          res
            .status(400)
            .json({ error: 'Missing conversationId', failureClass: 'invalid_request' });
          return;
        }
        const poll = validatePollInput({
          name: body.name,
          options: body.options,
          selectableCount: body.selectableCount,
        });
        const begun = await beginStructuredSend(client, req, res, () =>
          structuredRequestHash('poll', chatId, poll)
        );
        if (!begun) return;
        attempt = begun.attempt;
        const result = await client.sendPoll(
          chatId,
          poll,
          structuredSendOptions(attempt, actorFromBody(body.actor))
        );
        res.json({
          sent: true,
          ...result,
          ...(attempt ? { sentAt: await confirmSend(attempt.key, result.messageId) } : {}),
        });
      } catch (e) {
        await failStructuredSend(attempt, e, res, 'send poll');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.messages-poll-vote.v1 — body {conversationId, messageId, options[], actor?} ([] retracts), 200 {voted, messageId, pollMessageId, conversationId, options, retracted, votedAt, persisted}
  router.post('/messages/poll/vote', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      let attempt: IdempotentSend | null = null;
      try {
        const body = optionalObject(req.body);
        const chatId = optionalString(body.conversationId ?? body.chatId);
        const messageId = optionalString(body.messageId);
        const options = body.options;
        if (
          !chatId ||
          !messageId ||
          !Array.isArray(options) ||
          options.some(option => typeof option !== 'string')
        ) {
          res.status(400).json({
            error: 'Missing conversationId or messageId, or options is not a list of option names',
            failureClass: 'invalid_request',
          });
          return;
        }
        const begun = await beginStructuredSend(client, req, res, () =>
          structuredRequestHash('poll-vote', chatId, { messageId, options })
        );
        if (!begun) return;
        attempt = begun.attempt;
        const result = await client.sendPollVote(
          chatId,
          messageId,
          options,
          structuredSendOptions(attempt, actorFromBody(body.actor))
        );
        if (attempt) await confirmSend(attempt.key, result.messageId);
        res.json({ voted: true, ...result });
      } catch (e) {
        await failStructuredSend(attempt, e, res, 'vote');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.messages-poll-results.v1 — body {conversationId, messageId}, 200 {poll: {messageId, conversationId, question, selectableCount, options: [{name, votes, voters}], totalVoters, myVote, persisted}}
  router.post('/messages/poll/results', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        const body = optionalObject(req.body);
        const chatId = optionalString(body.conversationId ?? body.chatId);
        const messageId = optionalString(body.messageId);
        if (!chatId || !messageId) {
          res.status(400).json({
            error: 'Missing conversationId or messageId',
            failureClass: 'invalid_request',
          });
          return;
        }
        res.json({ poll: await client.getPollResults(chatId, messageId) });
      } catch (e) {
        mutationErrorResponse(res, e, 'read poll results');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.messages-event.v1 — body {conversationId, name, description?, startTime, endTime?, location?, call?, extraGuestsAllowed?, actor?}, 200 {sent, messageId, conversationId, sentAt}
  router.post('/messages/event', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      let attempt: IdempotentSend | null = null;
      try {
        const body = optionalObject(req.body);
        const chatId = optionalString(body.conversationId ?? body.chatId);
        if (!chatId) {
          res
            .status(400)
            .json({ error: 'Missing conversationId', failureClass: 'invalid_request' });
          return;
        }
        const event = validateEventInput(body);
        const begun = await beginStructuredSend(client, req, res, () =>
          structuredRequestHash('event', chatId, event)
        );
        if (!begun) return;
        attempt = begun.attempt;
        const result = await client.sendEvent(
          chatId,
          event,
          structuredSendOptions(attempt, actorFromBody(body.actor))
        );
        res.json({
          sent: true,
          ...result,
          ...(attempt ? { sentAt: await confirmSend(attempt.key, result.messageId) } : {}),
        });
      } catch (e) {
        await failStructuredSend(attempt, e, res, 'send event');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.messages-event-respond.v1 — body {conversationId, messageId, response: going|not_going|maybe, extraGuestCount?, actor?}, 200 {responded, messageId, eventMessageId, conversationId, response, extraGuestCount, respondedAt, persisted}
  router.post('/messages/event/respond', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      let attempt: IdempotentSend | null = null;
      try {
        const body = optionalObject(req.body);
        const chatId = optionalString(body.conversationId ?? body.chatId);
        const messageId = optionalString(body.messageId);
        if (!chatId || !messageId) {
          res.status(400).json({
            error: 'Missing conversationId or messageId',
            failureClass: 'invalid_request',
          });
          return;
        }
        const answer = validateEventResponse(body.response, body.extraGuestCount);
        const begun = await beginStructuredSend(client, req, res, () =>
          structuredRequestHash('event-response', chatId, { messageId, ...answer })
        );
        if (!begun) return;
        attempt = begun.attempt;
        const result = await client.respondToEvent(
          chatId,
          messageId,
          answer,
          structuredSendOptions(attempt, actorFromBody(body.actor))
        );
        if (attempt) await confirmSend(attempt.key, result.messageId);
        res.json({ responded: true, ...result });
      } catch (e) {
        await failStructuredSend(attempt, e, res, 'respond to event');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.messages-event-results.v1 — body {conversationId, messageId}, 200 {event: {messageId, conversationId, name, startTime, endTime, location, isCanceled, counts, extraGuests, responses, myResponse, persisted}}
  router.post('/messages/event/results', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        const body = optionalObject(req.body);
        const chatId = optionalString(body.conversationId ?? body.chatId);
        const messageId = optionalString(body.messageId);
        if (!chatId || !messageId) {
          res.status(400).json({
            error: 'Missing conversationId or messageId',
            failureClass: 'invalid_request',
          });
          return;
        }
        res.json({ event: await client.getEventResults(chatId, messageId) });
      } catch (e) {
        mutationErrorResponse(res, e, 'read event results');
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

  // Archive / pin / mute / read-unread a chat (fase 3 / PR-5): an app-state
  // patch to WhatsApp, same gate as every send, recorded on the canonical
  // conversation. Ids travel inside the signed body.
  // CONTRACT: http.whatsapp-connector.chats-modify.v1 — body {conversationId, action, durationMs?, muteUntil?, actor?}, 200 {modified, action, chatId, conversationId, persisted, state}
  router.post('/chats/modify', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        const body = optionalObject(req.body);
        const chatId = optionalString(body.conversationId ?? body.chatId);
        const action = normalizeChatModifyAction(body.action);
        if (!chatId || !action) {
          res.status(400).json({
            error:
              'Missing conversationId or action (archive, unarchive, pin, unpin, mute, unmute, markRead, markUnread)',
            failureClass: 'invalid_request',
          });
          return;
        }
        const mute = action === 'mute' ? muteFromBody(body) : undefined;
        if (typeof mute === 'string') {
          res.status(400).json({ error: mute, failureClass: 'invalid_request' });
          return;
        }
        if (rejectWhenSendingDisabled(res)) return;
        if (rejectWhenDisconnected(client, res)) return;
        const result = await client.modifyChat(chatId, action, {
          mute,
          actor: actorFromBody(body.actor),
        });
        res.json({ modified: true, ...result });
      } catch (error) {
        mutationErrorResponse(res, error, 'modify chat');
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

  // Group management (fase 3 / PR-6). Ids inside the signed body; only group
  // jids (…@g.us). The body is validated before anything else (400), then —
  // for the three that change the group, which notify its members — the same
  // gate as every send, then the connection. What this account may do comes
  // from its own participant row in fresh metadata (403 not_group_admin /
  // not_group_member).

  // CONTRACT: http.whatsapp-connector.groups-state.v1 — body {groupId}, 200 {group: {groupId, subject, description, announce, restrict, memberAddMode, community, size, createdAt, owner, capabilities, participants}}
  router.post('/groups/state', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = optionalObject(req.body);
        const groupId = parseGroupJid(body.groupId ?? body.conversationId);
        if (rejectWhenDisconnected(client, res)) return;
        res.json({ group: await client.getGroupState(groupId) });
      } catch (e) {
        mutationErrorResponse(res, e, 'read group');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.groups-create.v1 — body {subject, participants[], actor?}, 200 {created, groupId, conversationId, subject, persisted, participants, succeeded, failed, group}
  router.post('/groups/create', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = optionalObject(req.body);
        const subject = parseGroupSubject(body.subject);
        const participants = parseGroupParticipants(body.participants);
        if (rejectWhenSendingDisabled(res)) return;
        if (rejectWhenDisconnected(client, res)) return;
        const result = await client.createGroup(
          subject,
          participants.map(p => p.input),
          { actor: actorFromBody(body.actor) }
        );
        res.json({ created: true, ...result });
      } catch (e) {
        mutationErrorResponse(res, e, 'create group');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.groups-update.v1 — body {groupId, subject?, description?, settings?: {announce?, restrict?}, actor?}, 200 {updated, groupId, changed, unchanged, persisted, group}
  router.post('/groups/update', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = optionalObject(req.body);
        const groupId = parseGroupJid(body.groupId ?? body.conversationId);
        const update = parseGroupUpdate(body);
        if (rejectWhenSendingDisabled(res)) return;
        if (rejectWhenDisconnected(client, res)) return;
        const result = await client.updateGroup(groupId, update, {
          actor: actorFromBody(body.actor),
        });
        res.json({ updated: true, ...result });
      } catch (e) {
        mutationErrorResponse(res, e, 'update group');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.groups-participants.v1 — body {groupId, action: add|remove|promote|demote, participants[], actor?}, 200 {updated, action, groupId, results, succeeded, failed, partial, persisted, group}
  router.post('/groups/participants', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = optionalObject(req.body);
        const groupId = parseGroupJid(body.groupId ?? body.conversationId);
        const action = normalizeGroupParticipantAction(body.action);
        if (!action) {
          res.status(400).json({
            error: 'action must be one of add, remove, promote, demote',
            failureClass: 'invalid_request',
          });
          return;
        }
        const participants = parseGroupParticipants(body.participants);
        if (rejectWhenSendingDisabled(res)) return;
        if (rejectWhenDisconnected(client, res)) return;
        const result = await client.updateGroupParticipants(
          groupId,
          action,
          participants.map(p => p.input),
          { actor: actorFromBody(body.actor) }
        );
        res.json({ updated: true, ...result });
      } catch (e) {
        mutationErrorResponse(res, e, 'update group participants');
      }
    })();
  });

  // Invite by private message the people WhatsApp would not add (403 on
  // /groups/participants add → inviteRequired): opt-in, admin only, a real
  // message to each person — validated (400), gated (403), connected (503).
  // CONTRACT: http.whatsapp-connector.groups-invite.v1 — body {groupId, participants[], text?, actor?}, 200 {invited, groupId, results[{participant, jid, ok, reason, invite, messageId}], succeeded, failed, partial}
  router.post('/groups/invite', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = optionalObject(req.body);
        const groupId = parseGroupJid(body.groupId ?? body.conversationId);
        const participants = parseGroupInviteParticipants(body.participants);
        const text = parseGroupInviteText(body.text);
        if (rejectWhenSendingDisabled(res)) return;
        if (rejectWhenDisconnected(client, res)) return;
        const result = await client.sendGroupInvites(
          groupId,
          participants.map(p => p.input),
          { actor: actorFromBody(body.actor), text }
        );
        res.json({ invited: true, ...result });
      } catch (e) {
        mutationErrorResponse(res, e, 'send group invites');
      }
    })();
  });

  // Communities. Ids inside the signed body (communityId / groupId:
  // …@g.us). Reads are not gated; create / link / unlink / leave reach every
  // member: validated first (400, leave also needs confirm: true), then the
  // sending gate (403), then the connection (503). Admin checks against fresh
  // metadata (403 not_community_admin / not_community_member / not_group_admin);
  // every write is read back (409 change_not_confirmed when it does not show).

  // CONTRACT: http.whatsapp-connector.communities-list.v1 — GET (signed over "{}"), 200 {communities: [{communityId, subject, description, size, createdAt, owner, capabilities, announcementGroup, linkedGroups, linkedGroupsComplete}], count}
  router.get('/communities', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        if (rejectWhenDisconnected(client, res)) return;
        const { communities } = await client.listCommunities();
        res.json({ communities, count: communities.length });
      } catch (e) {
        mutationErrorResponse(res, e, 'list communities');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.communities-state.v1 — body {communityId}, 200 {community: {communityId, subject, description, size, createdAt, owner, capabilities, announcementGroup, linkedGroups, linkedGroupsComplete}}, 422 not_a_community
  router.post('/communities/state', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = optionalObject(req.body);
        const communityId = parseCommunityJid(body.communityId ?? body.conversationId);
        if (rejectWhenDisconnected(client, res)) return;
        res.json({ community: await client.getCommunityState(communityId) });
      } catch (e) {
        mutationErrorResponse(res, e, 'read community');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.communities-create.v1 — body {subject, description?, actor?}, 200 {created, communityId, community}, 409 change_not_confirmed
  router.post('/communities/create', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = optionalObject(req.body);
        const subject = parseCommunitySubject(body.subject);
        const description = parseCommunityDescription(body.description);
        if (rejectWhenSendingDisabled(res)) return;
        if (rejectWhenDisconnected(client, res)) return;
        const result = await client.createCommunity(subject, description, {
          actor: actorFromBody(body.actor),
        });
        res.json({ created: true, ...result });
      } catch (e) {
        mutationErrorResponse(res, e, 'create community');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.communities-groups.v1 — body {communityId, groupId, action: link|unlink, actor?}, 200 {updated, action, communityId, groupId, changed, confirmed, community}, 409 linked_elsewhere|change_not_confirmed, 422 not_a_community|not_linkable_group|announcement_group
  router.post('/communities/groups', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = optionalObject(req.body);
        const request = parseCommunityGroupRequest(body);
        if (rejectWhenSendingDisabled(res)) return;
        if (rejectWhenDisconnected(client, res)) return;
        const result = await client.updateCommunityGroup(
          request.communityId,
          request.groupId,
          request.action,
          { actor: actorFromBody(body.actor) }
        );
        res.json({ updated: true, ...result });
      } catch (e) {
        mutationErrorResponse(res, e, 'update community groups');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.communities-leave.v1 — body {communityId, confirm: true, actor?}, 200 {left, communityId, changed, confirmed}, 403 not_community_member, 409 change_not_confirmed
  router.post('/communities/leave', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = optionalObject(req.body);
        const communityId = parseCommunityJid(body.communityId ?? body.conversationId);
        requireLeaveConfirmation(body);
        if (rejectWhenSendingDisabled(res)) return;
        if (rejectWhenDisconnected(client, res)) return;
        const result = await client.leaveCommunity(communityId, {
          actor: actorFromBody(body.actor),
        });
        res.json({ left: true, ...result });
      } catch (e) {
        mutationErrorResponse(res, e, 'leave community');
      }
    })();
  });

  // Channels (newsletters). Look-up and the followed list are reads (not
  // gated); follow / unfollow / mute / unmute are validated (400), gated
  // (403), connected (503) and proven by the channel's own metadata.

  // CONTRACT: http.whatsapp-connector.channels-lookup.v1 — body {channel: jid | whatsapp.com/channel link | invite code}, 200 {channel: {channelId, name, description, subscribers, verification, createdAt, inviteLink, role, following, muted}}, 404 channel_unavailable
  router.post('/channels/lookup', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = optionalObject(req.body);
        const query = body.channel ?? body.channelId;
        parseChannelQuery(query);
        if (rejectWhenDisconnected(client, res)) return;
        res.json({ channel: await client.lookupChannel(query) });
      } catch (e) {
        mutationErrorResponse(res, e, 'look up channel');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.channels-list.v1 — GET (signed over "{}"), 200 {channels: [channel], count, coverage: {complete: false, source, candidates, checked, unreadable}}
  router.get('/channels', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        if (rejectWhenDisconnected(client, res)) return;
        const result = await client.listChannels();
        res.json({
          channels: result.channels,
          count: result.channels.length,
          coverage: result.coverage,
        });
      } catch (e) {
        mutationErrorResponse(res, e, 'list channels');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.channels-subscription.v1 — body {channelId, action: follow|unfollow|mute|unmute, actor?}, 200 {updated, action, channelId, changed, confirmed, channel}, 409 change_not_confirmed, 422 not_following|rejected_by_whatsapp
  router.post('/channels/subscription', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = optionalObject(req.body);
        const channelId = parseChannelJid(body.channelId ?? body.channel);
        const action = parseChannelSubscriptionAction(body.action);
        if (rejectWhenSendingDisabled(res)) return;
        if (rejectWhenDisconnected(client, res)) return;
        const result = await client.setChannelSubscription(channelId, action, {
          actor: actorFromBody(body.actor),
        });
        res.json({ updated: true, ...result });
      } catch (e) {
        mutationErrorResponse(res, e, 'change the channel subscription');
      }
    })();
  });

  // Presence, privacy settings and disappearing messages (fase 3 / PR-8).
  // Ids inside the signed body. Reads are not gated; what reaches WhatsApp
  // (our typing indicator, a privacy change, a timer) is validated first
  // (400), then the same gate as every send (403), then the connection (503).

  // CONTRACT: http.whatsapp-connector.chats-presence.v1 — body {conversationId?, state: composing|recording|paused|unavailable|available, actor?}, 200 {ok, state, scope, chatId, conversationId, sent, throttled}
  router.post('/chats/presence', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = optionalObject(req.body);
        const request = parsePresenceRequest(body);
        if (rejectWhenSendingDisabled(res)) return;
        // Never online by default: `available` stops the phone's push
        // notifications. Only with the deployment's explicit opt-in.
        if (request.state === 'available' && !availablePresenceAllowed()) {
          res.status(403).json({
            error:
              'Presence available is disabled on this connector (WA_PRESENCE_ALLOW_AVAILABLE): being online on a linked device silences the phone',
            failureClass: 'presence_available_disabled',
          });
          return;
        }
        if (rejectWhenDisconnected(client, res)) return;
        const result = await client.sendPresence(request.state, request.conversationId, {
          actor: actorFromBody(body.actor),
        });
        res.json({ ok: true, ...result });
      } catch (e) {
        mutationErrorResponse(res, e, 'send presence');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.chats-presence-read.v1 — body {conversationId, participant?}, 200 {presence: {chatId, conversationId, isGroup, presence: {participantId, status, lastSeen, observedAt}, participants, refreshing}}
  router.post('/chats/presence/read', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = optionalObject(req.body);
        const chatId = optionalString(body.conversationId ?? body.chatId);
        if (!chatId) {
          res
            .status(400)
            .json({ error: 'Missing conversationId', failureClass: 'invalid_request' });
          return;
        }
        if (rejectWhenDisconnected(client, res)) return;
        res.json({ presence: await client.getPresence(chatId, body.participant) });
      } catch (e) {
        mutationErrorResponse(res, e, 'read presence');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.privacy-read.v1 — GET, 200 {privacy: {settings: {lastSeen, online, profilePicture, status, readReceipts, groupsAdd, call, messages}, defaultDisappearing, other, allowed}}
  router.get('/privacy', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        if (rejectWhenDisconnected(client, res)) return;
        res.json({ privacy: await client.getPrivacySettings() });
      } catch (e) {
        mutationErrorResponse(res, e, 'read privacy settings');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.privacy-update.v1 — body {setting, value, confirm: true, actor?}, 200 {updated, setting, value, previous, changed, privacy}
  router.post('/privacy', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = optionalObject(req.body);
        // Setting + value (Baileys' exact names) and confirm: true, or 400.
        const update = parsePrivacyRequest(body);
        if (rejectWhenSendingDisabled(res)) return;
        if (rejectWhenDisconnected(client, res)) return;
        const result = await client.updatePrivacySetting(update.setting, update.value, {
          actor: actorFromBody(body.actor),
        });
        res.json({ updated: true, ...result });
      } catch (e) {
        mutationErrorResponse(res, e, 'update privacy settings');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.chats-disappearing-read.v1 — body {conversationId}, 200 {disappearing: {chatId, conversationId, isGroup, expiration, label, known, setAt, source, canChange, contactDefault}}
  router.post(
    '/chats/disappearing/read',
    auth,
    (req: AuthenticatedRequest, res: Response): void => {
      void (async () => {
        try {
          const body = optionalObject(req.body);
          const chatId = optionalString(body.conversationId ?? body.chatId);
          if (!chatId) {
            res
              .status(400)
              .json({ error: 'Missing conversationId', failureClass: 'invalid_request' });
            return;
          }
          res.json({ disappearing: await client.getDisappearing(chatId) });
        } catch (e) {
          mutationErrorResponse(res, e, 'read the disappearing timer');
        }
      })();
    }
  );

  // CONTRACT: http.whatsapp-connector.chats-disappearing.v1 — body {conversationId, expiration: 0|86400|604800|7776000 (or off|24h|7d|90d), actor?}, 200 {updated, chatId, conversationId, isGroup, expiration, label, previous, changed, persisted}
  router.post('/chats/disappearing', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = optionalObject(req.body);
        const chatId = optionalString(body.conversationId ?? body.chatId);
        if (!chatId) {
          res
            .status(400)
            .json({ error: 'Missing conversationId', failureClass: 'invalid_request' });
          return;
        }
        const expiration = parseDisappearingExpiration(body.expiration);
        if (rejectWhenSendingDisabled(res)) return;
        if (rejectWhenDisconnected(client, res)) return;
        const result = await client.setDisappearing(chatId, expiration, {
          actor: actorFromBody(body.actor),
        });
        res.json({ updated: true, ...result });
      } catch (e) {
        mutationErrorResponse(res, e, 'change the disappearing timer');
      }
    })();
  });

  // Start chat, stickers / GIFs and contacts (fase 3 / PR-9). Ids inside the
  // signed body (GET /contacts: its query only filters a read). The body is
  // validated first (400); what reaches WhatsApp then takes the same gate as
  // every send (403) and the connection (503), and sends take the opt-in
  // Idempotency-Key. Starting a chat is gated even without a first message:
  // it asks WhatsApp about a number, and bulk number lookups are what gets an
  // account restricted. The contact list is a read: no gate.

  // CONTRACT: http.whatsapp-connector.chats-start.v1 — body {phone, message?, actor?}, 200 {started, chat: {conversationId, chatId, phone, lid, name, created, existing, persisted}, message?: {sent, messageId, sentAt}}, 422 not_on_whatsapp
  router.post('/chats/start', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      let attempt: IdempotentSend | null = null;
      let chat: StartedChat | undefined;
      try {
        const body = optionalObject(req.body);
        const request = parseStartChatRequest(body);
        const actor = actorFromBody(body.actor);
        if (rejectWhenSendingDisabled(res)) return;
        if (rejectWhenDisconnected(client, res)) return;
        chat = await client.startChat(request.phone, { actor });
        if (!request.message) {
          res.json({ started: true, chat });
          return;
        }
        const started = chat;
        const begun = await beginIdempotentSend(
          client,
          req,
          res,
          () =>
            structuredRequestHash('start-chat', request.phone.phoneE164, {
              message: request.message,
            }),
          reservation => ({
            started: true,
            chat: started,
            message: { sent: true, messageId: reservation.messageId, sentAt: reservation.sentAt },
          })
        );
        if (begun === 'answered') return;
        attempt = begun;
        // The normal send path, to the chat's own jid (the LID when it has one):
        // the echo then lands on this conversation, not on a phone-jid twin.
        const messageId = await client.sendMessage(
          chat.chatId,
          request.message,
          attempt ? { messageId: attempt.messageId, beforeSend: attempt.beforeSend } : undefined
        );
        const sentAt = attempt
          ? await confirmSend(attempt.key, messageId)
          : new Date().toISOString();
        res.json({ started: true, chat, message: { sent: true, messageId, sentAt } });
      } catch (e) {
        if (await failIdempotentSend(attempt, e, res)) return;
        if (!chat) {
          mutationErrorResponse(res, e, 'start chat');
          return;
        }
        // The chat exists; only the first message failed.
        const failureClass = classifyWhatsAppSendFailure(e);
        res.status(statusForSendFailure(failureClass)).json({
          error: `Chat started but the first message failed: ${errorMessage(e)}`,
          failureClass,
          started: true,
          chat,
          message: { sent: false },
          ...(failureClass === 'account_restricted'
            ? { fallback: accountRestrictedFallback(chat.phone, optionalObject(req.body).message) }
            : {}),
        });
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.messages-sticker.v1 — body {conversationId, fileUrl (image/webp ≤ 1 MiB), replyTo?, actor?}, 200 {sent, messageId, conversationId, sentAt, kind, animated}
  // CONTRACT: http.whatsapp-connector.messages-gif.v1 — body {conversationId, fileUrl (video/mp4 ≤ 16 MiB, never .gif), caption?, replyTo?, actor?}, 200 {sent, messageId, conversationId, sentAt, kind}
  for (const [path, kind] of [
    ['/messages/sticker', 'sticker'],
    ['/messages/gif', 'gif'],
  ] as const) {
    router.post(path, auth, (req: AuthenticatedRequest, res: Response): void => {
      void (async () => {
        let attempt: IdempotentSend | null = null;
        try {
          const body = optionalObject(req.body);
          const request = parseStickerGifRequest(kind, body);
          const begun = await beginStructuredSend(client, req, res, () =>
            structuredRequestHash(kind, request.conversationId, stickerGifHashInput(kind, request))
          );
          if (!begun) return;
          attempt = begun.attempt;
          const result = await client.sendStickerOrGif(
            kind,
            request,
            structuredSendOptions(attempt, actorFromBody(body.actor))
          );
          res.json({
            sent: true,
            ...result,
            ...(attempt ? { sentAt: await confirmSend(attempt.key, result.messageId) } : {}),
          });
        } catch (e) {
          await failStructuredSend(attempt, e, res, `send ${kind}`);
        }
      })();
    });
  }

  // CONTRACT: http.whatsapp-connector.contacts-list.v1 — GET ?q&limit (signed over "{}"), 200 {contacts: [{id, name, pushName, phone, jids, conversationId, lastActivityAt}], count}
  router.get('/contacts', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const q = typeof req.query.q === 'string' ? req.query.q : undefined;
        const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
          res
            .status(400)
            .json({ error: 'limit must be a positive integer', failureClass: 'invalid_request' });
          return;
        }
        const contacts = await client.listContacts({ query: q, limit });
        res.json({ contacts, count: contacts.length });
      } catch (e) {
        mutationErrorResponse(res, e, 'list contacts');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.contacts-create.v1 — body {phone, name, firstName?, actor?} (POST /contacts/create or POST /contacts), 200 {created, contact: {phone, jid, lid, name, addressBookSync, persisted}}, 422 not_on_whatsapp
  const createContactRoute = (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = optionalObject(req.body);
        const request = parseCreateContactRequest(body);
        if (rejectWhenSendingDisabled(res)) return;
        if (rejectWhenDisconnected(client, res)) return;
        const contact = await client.createContact(request, { actor: actorFromBody(body.actor) });
        res.json({ created: true, contact });
      } catch (e) {
        mutationErrorResponse(res, e, 'create contact');
      }
    })();
  };
  router.post('/contacts/create', auth, createContactRoute);
  router.post('/contacts', auth, createContactRoute);

  // CONTRACT: http.whatsapp-connector.contacts-share.v1 — body {conversationId, displayName + phone (+ organization?, email?) | contacts[1..5], actor?}, 200 {sent, messageId, conversationId, sentAt, contacts}
  router.post('/contacts/share', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      let attempt: IdempotentSend | null = null;
      try {
        const body = optionalObject(req.body);
        const chatId = optionalString(body.conversationId ?? body.chatId);
        if (!chatId) {
          res
            .status(400)
            .json({ error: 'Missing conversationId', failureClass: 'invalid_request' });
          return;
        }
        const cards = parseShareContactRequest(body);
        const begun = await beginStructuredSend(client, req, res, () =>
          structuredRequestHash('contact-share', chatId, cards)
        );
        if (!begun) return;
        attempt = begun.attempt;
        const result = await client.shareContacts(
          chatId,
          cards,
          structuredSendOptions(attempt, actorFromBody(body.actor))
        );
        res.json({
          sent: true,
          ...result,
          ...(attempt ? { sentAt: await confirmSend(attempt.key, result.messageId) } : {}),
        });
      } catch (e) {
        await failStructuredSend(attempt, e, res, 'share contact');
      }
    })();
  });

  // Contact block / unblock and the account's blocklist. Blocking is outward
  // and visible (the contact can no longer reach us; every linked device
  // shows it): the body is validated first, `confirm: true` included (400),
  // then the sending gate (403) and the connection (503). The blocklist is a
  // read: no gate, only the connection. Ids inside the signed body.

  // CONTRACT: http.whatsapp-connector.contacts-block.v1 — body {phone | conversationId, action: block|unblock, confirm: true, actor?}, 200 {ok, action, blocked, changed, confirmed, jid, jids, conversationId}, 409 block_not_confirmed, 422 identity_unresolved|rejected_by_whatsapp
  router.post('/contacts/block', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        const body = optionalObject(req.body);
        const request = parseContactBlockRequest(body);
        if (rejectWhenSendingDisabled(res)) return;
        if (rejectWhenDisconnected(client, res)) return;
        const result = await client.setContactBlock(request, { actor: actorFromBody(body.actor) });
        res.json({ ok: true, ...result });
      } catch (e) {
        mutationErrorResponse(res, e, 'change the contact block');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.contacts-blocklist.v1 — GET ?fresh=1 (signed over "{}"), 200 {blocked: [{id, jids, blockedJids, phone, name, pushName, conversationId}], count, readAt, cached}
  router.get('/contacts/blocklist', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async () => {
      try {
        if (rejectWhenDisconnected(client, res)) return;
        const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
        const result = await client.listBlockedContacts({ fresh });
        res.json({ ...result, count: result.blocked.length });
      } catch (e) {
        mutationErrorResponse(res, e, 'read the blocklist');
      }
    })();
  });

  // Download a chat/contact's profile picture as base64 (mirrors telegram-connector shape).
  // CONTRACT: http.whatsapp-connector.chat-photo.v1 — path and 200 {data, size, contentType}; 404 no photo, 504 lookup timeout, 502 download
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
        if (directSendRefused(res, e)) return;
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
        if (directSendRefused(res, e)) return;
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

  // Starred and pinned messages. Ids inside the signed body; the body is
  // validated first (400). Star and pin go out to WhatsApp: the send gate
  // (403) and the connection (503); a pin is a message everyone in the chat
  // sees, so it also takes the opt-in Idempotency-Key. The lists read the DB:
  // no gate, and they answer while disconnected.

  // CONTRACT: http.whatsapp-connector.messages-star.v1 — body {conversationId?, messageId, star, actor?}, 200 {starred, messageId, conversationId, starredAt, persisted}
  router.post('/messages/star', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        const body = optionalObject(req.body);
        const request = parseStarRequest(body);
        if (rejectWhenSendingDisabled(res)) return;
        if (rejectWhenDisconnected(client, res)) return;
        res.json(
          await client.starMessage(request.chatId, request.messageId, request.star, {
            actor: actorFromBody(body.actor),
          })
        );
      } catch (e) {
        mutationErrorResponse(res, e, 'star message');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.messages-starred.v1 — body {conversationId?, limit?, cursor?}, 200 {starred: [...], nextCursor, persisted, conversationId?}
  router.post('/messages/starred', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        res.json(await client.listStarredMessages(parseStarredQuery(optionalObject(req.body))));
      } catch (e) {
        mutationErrorResponse(res, e, 'list starred messages');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.messages-pin.v1 — body {conversationId?, messageId, pin, durationSeconds?, actor?}, 200 {pinned, messageId, pinnedMessageId, conversationId, pinnedAt?, expiresAt?, durationSeconds?, persisted, sentAt?}
  router.post('/messages/pin', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      let attempt: IdempotentSend | null = null;
      try {
        const body = optionalObject(req.body);
        const request = parsePinRequest(body);
        const begun = await beginStructuredSend(client, req, res, () =>
          structuredRequestHash('pin', request.chatId || '', {
            messageId: request.messageId,
            pin: request.pin,
            durationSeconds: request.durationSeconds ?? null,
          })
        );
        if (!begun) return;
        attempt = begun.attempt;
        const result = await client.pinMessage(
          request,
          structuredSendOptions(attempt, actorFromBody(body.actor))
        );
        res.json({
          ...result,
          ...(attempt ? { sentAt: await confirmSend(attempt.key, result.messageId) } : {}),
        });
      } catch (e) {
        await failStructuredSend(attempt, e, res, 'pin message');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.messages-pins.v1 — body {conversationId}, 200 {conversationId, pinned: [...], limit, persisted}
  router.post('/messages/pins', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        const body = optionalObject(req.body);
        const chatId = optionalString(body.conversationId ?? body.chatId);
        if (!chatId) {
          res
            .status(400)
            .json({ error: 'Missing conversationId', failureClass: 'invalid_request' });
          return;
        }
        res.json(await client.listPinnedMessages(chatId));
      } catch (e) {
        mutationErrorResponse(res, e, 'list pinned messages');
      }
    })();
  });

  // Statuses and channel posts (fase 3 follow-up). The lists read the DB: no
  // gate, and they answer while disconnected.

  // CONTRACT: http.whatsapp-connector.statuses-list.v1 — body {contact?, includeExpired?, includeOwn?, limit?, cursor?}, 200 {statuses: [{messageId, conversationId, authorId, authorName, fromMe, messageType, text, hasMedia, mimeType, postedAt, expiresAt, active, audienceSize, source}], nextCursor, persisted, contact?}
  router.post('/statuses', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        res.json(await client.listStatuses(parseStatusListQuery(optionalObject(req.body))));
      } catch (e) {
        mutationErrorResponse(res, e, 'list statuses');
      }
    })();
  });

  // CONTRACT: http.whatsapp-connector.channels-posts.v1 — body {channelId?, limit?, cursor?}, 200 {posts: [{messageId, channelId, channelName, messageType, text, hasMedia, mimeType, postedAt, structured?}], nextCursor, channels}
  router.post('/channels/posts', auth, (req: AuthenticatedRequest, res: Response): void => {
    void (async (): Promise<void> => {
      try {
        res.json(await client.listChannelPosts(parseChannelPostsQuery(optionalObject(req.body))));
      } catch (e) {
        mutationErrorResponse(res, e, 'list channel posts');
      }
    })();
  });

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
