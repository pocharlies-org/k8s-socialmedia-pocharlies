/**
 * WhatsApp connector client backed by @whiskeysockets/baileys.
 *
 * Replaces the previous whatsapp-web.js + Chromium implementation. Same public
 * surface (methods, events, payloads) so the HTTP controller, db-writer, NATS
 * publisher and the MCP server keep working unchanged.
 *
 * Baileys uses native WhatsApp JIDs (`@s.whatsapp.net` for users), but the
 * existing DB schema and downstream consumers expect `@c.us`. All JIDs are
 * normalised at the boundary so the rest of the system never sees Baileys
 * format.
 */
import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
  WASocket,
  WAMessage,
  WAMessageKey,
  WAMessageUpdate,
  proto,
  isJidGroup,
  jidEncode,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  AnyMessageContent,
  CacheStore,
  ChatModification,
  GroupMetadata,
  Browsers,
} from '@whiskeysockets/baileys';
import {
  isTcTokenExpired,
  resolveIssuanceJid,
  resolveTcTokenJid,
  storeTcTokensFromIqResult,
} from '@whiskeysockets/baileys/lib/Utils/tc-token-utils.js';
import { Boom } from '@hapi/boom';
import { EventEmitter } from 'events';
import { promises as fsp } from 'fs';
import { join } from 'path';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import pino from 'pino';
import {
  accountKey,
  stripAccountKey,
  connectorAccount,
  storeMessage,
  ensureConversation,
  ensureParticipant,
  linkParticipantToConversation,
  storeAttachment,
  getPool,
  MessageData,
  ensureHistoryTables,
  storeMessageKey,
  recordHistorySyncProgress,
  getHistorySyncStatus,
  HistorySyncState,
  getConversationAvatar,
  getParticipantAvatar,
  setConversationAvatar,
  setParticipantAvatar,
  setConversationState,
  setMessageStatus,
  setConversationWaChatId,
  getUnreadMessageKeysForChat,
  markMessagesRead,
} from './db-writer';
import {
  DurablePayloadSource,
  getRawWAMessage,
  MessageUnavailableError,
  storeRawWAMessage,
  unixSeconds,
} from './durable-message-store';
import {
  loadStoredMessage,
  markMessageDeletedForMe,
  markMessageEdited,
  markMessageRevoked,
  MessageMutationError,
  StoredMessage,
} from './message-mutations';
import { reactionTime, storeMessageReaction } from './message-reactions';
import {
  ChatState,
  ChatStatePatch,
  latestMessageId,
  muteEndTimestamp,
  muteFromBaileys,
  MuteState,
  pinFromBaileys,
  recordInboundChatState,
  resolveCanonicalConversation,
  writeChatState,
} from './chat-state';
import {
  allowsParticipantAction,
  countResults,
  findParticipant,
  GroupActionError,
  groupCapabilities,
  GroupParticipantAction,
  GroupParticipantResult,
  groupStateView,
  GroupStateView,
  GroupUpdate,
  isCommunityGroup,
  normalizeGroupParticipantAction,
  ownParticipant,
  parseGroupJid,
  parseGroupParticipants,
  parseGroupSubject,
  parseGroupUpdate,
  participantApiJid,
  participantIds,
  participantOutcome,
  recordGroupChange,
  recordGroupConversation,
  recordInboundGroup,
} from './group-management';
import { maybeRunRetention } from './retention';
import {
  appendCompanyToDisplayName,
  displayNameOrPhone,
  normalizePhoneForWhatsApp,
  WhatsAppContactSeedInput,
  WhatsAppContactSeedResult,
  WhatsAppCustomerTokenStatus,
} from './contact-sync';
import {
  uploadMedia,
  ensureMediaBucket,
  fetchMedia,
  uploadAvatar,
  presignMediaUrl,
  presignExpirySeconds,
} from './media-storage';
import { buildAudioAttachmentsBeforeEmit, StoredMediaInfo } from './audio-attachments';
import { notifyDashboard as dashboardNotify } from './dashboard-notifier';

// WhatsApp Web message status enum → human/dashboard strings.
// proto.WebMessageInfo.Status: ERROR=0, PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5
function mapWaStatus(s: number): string | null {
  switch (s) {
    case 0:
      return 'failed';
    case 1:
      return 'pending';
    case 2:
      return 'sent';
    case 3:
      return 'delivered';
    case 4:
      return 'read';
    case 5:
      return 'read';
    default:
      return null;
  }
}

export interface WhatsAppMessage {
  waMessageId: string;
  waTimestamp: Date;
  conversationId: string;
  senderWaId: string;
  content: string | null;
  messageType: string;
  isForwarded: boolean;
  replyToWaId?: string;
  /** Sender's WhatsApp display name (Baileys `pushName`). Optional. */
  pushName?: string;
  /**
   * Real sender phone in E.164 (with '+'), ONLY when the chat is @lid-addressed
   * and Baileys surfaced the alternate PN jid (see pnFromLidMessage). Never an
   * invented value; omitted otherwise. Same value persisted as
   * `messages.metadata->>'senderPnE164'`.
   */
  senderPnE164?: string;
  /** Baileys `key.fromMe`: true when this account sent the message (any device). */
  fromMe?: boolean;
  attachments?: Array<{
    type: string;
    url: string;
    metadata: Record<string, unknown>;
  }>;
}

interface CachedChat {
  id: string; // normalised JID
  rawJid: string; // original Baileys JID (used when calling sock APIs)
  name: string;
  isGroup: boolean;
  unreadCount: number;
  timestamp: number;
}

type IngestSource = 'live' | 'baileys_history_sync';

interface IngestOptions {
  source?: IngestSource;
  publishEvent?: boolean;
  syncType?: string;
  isLatest?: boolean;
}

interface IngestResult {
  inserted: boolean;
  waMessage?: WhatsAppMessage;
}

export type WhatsAppSendFailureClass =
  | 'timeout'
  | 'missing_session'
  | 'group_metadata'
  | 'disconnected'
  | 'account_restricted'
  | 'invalid_recipient'
  | 'auth'
  | 'unknown';

export interface GroupSessionRefreshResult {
  rawJid: string;
  normalizedJid: string;
  groupSubject: string;
  participantCount: number;
  lidParticipantCount: number;
  deviceCount: number;
  skippedSenderKeyDevices: number;
  sessionFetchAttempted: boolean;
  forceSessions: boolean;
  senderKeyMemoryCleared: boolean;
  warnings: string[];
}

interface GroupSessionRefreshOptions {
  reason?: string;
  warmSessions?: boolean;
  forceSessions?: boolean;
  clearSenderKeyMemory?: boolean;
  failOnWarmupError?: boolean;
  markFailedDevicesAsSenderKeySent?: boolean;
}

interface SendFailureDetails {
  failureClass: WhatsAppSendFailureClass;
  rawJid: string;
  normalizedJid: string;
  isGroup: boolean;
  groupSubject?: string;
  participantCount?: number;
  attempts: number;
  elapsedMs: number;
  causeMessage: string;
  actionable: string;
  repair?: GroupSessionRefreshResult;
}

interface ImmediateSendFailure {
  failureClass: WhatsAppSendFailureClass;
  code?: string;
  message: string;
}

class TtlCache implements CacheStore {
  private entries = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number
  ) {}

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    if (this.entries.size >= this.maxEntries) {
      const firstKey = this.entries.keys().next().value;
      if (firstKey) this.entries.delete(firstKey);
    }
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  del(key: string): void {
    this.entries.delete(key);
  }

  flushAll(): void {
    this.entries.clear();
  }
}

export class WhatsAppSendError extends Error {
  failureClass: WhatsAppSendFailureClass;
  details: SendFailureDetails;
  cause?: unknown;

  constructor(message: string, details: SendFailureDetails, cause?: unknown) {
    super(message);
    this.name = 'WhatsAppSendError';
    this.failureClass = details.failureClass;
    this.details = details;
    this.cause = cause;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

export function classifyWhatsAppSendFailure(error: unknown): WhatsAppSendFailureClass {
  const err = error as { name?: string; failureClass?: WhatsAppSendFailureClass };
  if (err?.failureClass) return err.failureClass;

  const name = String(err?.name || '').toLowerCase();
  const text = `${name} ${errorMessage(error)}`.toLowerCase();
  if (
    text.includes('sessionerror') ||
    text.includes('no sessions') ||
    text.includes('no open session') ||
    text.includes('no session record') ||
    text.includes('not-acceptable')
  ) {
    return 'missing_session';
  }
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout';
  if (text.includes('not authenticated')) return 'auth';
  if (
    text.includes('not connected') ||
    text.includes('connection closed') ||
    text.includes('connection lost')
  )
    return 'disconnected';
  if (
    text.includes('463') ||
    text.includes('tctoken') ||
    text.includes('trusted contact') ||
    text.includes('reachout') ||
    text.includes('account restricted')
  )
    return 'account_restricted';
  if (text.includes('not on whatsapp') || text.includes('invalid recipient'))
    return 'invalid_recipient';
  if (text.includes('group metadata') || text.includes('not a group jid')) return 'group_metadata';
  return 'unknown';
}

/** HTTP status of a send failure class outside the controller (group errors). */
function statusOfFailureClass(failureClass: WhatsAppSendFailureClass): number {
  if (failureClass === 'timeout') return 504;
  if (failureClass === 'disconnected') return 503;
  return 500;
}

function actionableForFailure(failureClass: WhatsAppSendFailureClass, isGroup: boolean): string {
  if (failureClass === 'timeout') {
    return isGroup
      ? 'WhatsApp did not acknowledge the group send before the timeout. The connector refreshed group metadata, repaired group sender-key state, and retried once; if this persists, open the group on the linked phone or re-link WhatsApp.'
      : 'WhatsApp did not acknowledge the send before the timeout. Check connector connectivity and try again.';
  }
  if (failureClass === 'missing_session') {
    return 'Baileys has no usable Signal session for at least one group participant. The connector forced a session refresh and retried once; if this persists, open the group on the linked phone, wait for participant state to sync, or re-link WhatsApp.';
  }
  if (failureClass === 'group_metadata') {
    return 'The connector could not refresh group metadata. Confirm the linked WhatsApp account is still a member of the group and that the group JID is correct.';
  }
  if (failureClass === 'account_restricted') {
    return 'WhatsApp rejected a 1:1 reachout because the linked device has no usable trusted-contact token for that contact, or the account is under a new-chat/reachout restriction. Use an existing conversation, have the customer message the business first, or send first contact through an official approved channel.';
  }
  if (failureClass === 'invalid_recipient') {
    return 'The target phone/JID could not be resolved as a WhatsApp contact.';
  }
  if (failureClass === 'disconnected') {
    return 'WhatsApp is disconnected. Check social_validate_account and use social_manage_session action=renewQr if needed.';
  }
  if (failureClass === 'auth') {
    return 'WhatsApp rejected the authenticated send path. Reconnect the WhatsApp session.';
  }
  return isGroup
    ? 'The group send failed after metadata/session repair. Check connector logs for the raw Baileys error and group participant sync state.'
    : 'The direct send failed. Check connector logs for the raw Baileys error.';
}

// LRU-ish cache mapping our exported waMessageId → full WAMessageKey (+ owning
// chat) so we can react/forward/delete/download without keeping every message
// in memory.
const KEY_CACHE_MAX = 2000;

/**
 * How long our own edit/revoke/delete-for-me keeps the echo WhatsApp sends
 * back (messages.update / messages.delete) away from the inbound path: the
 * explicit call persists it, after WhatsApp accepted it.
 */
const OWN_MUTATION_ECHO_MS = 30_000;

/** Options of the outbound edit/delete calls. */
export interface MessageMutationRequest {
  /** Who asked (dgx-messages user, MCP caller); recorded in metadata. */
  actor?: string;
}

/** POST /groups/create (fase 3 / PR-6). */
export interface GroupCreateResult {
  groupId: string;
  /** conversations.id written (ingest only), else null. */
  conversationId: string | null;
  subject: string;
  persisted: boolean;
  participants: GroupParticipantResult[];
  succeeded: number;
  failed: number;
  group: GroupStateView;
}

/** POST /groups/update. */
export interface GroupUpdateResult {
  groupId: string;
  /** What went to WhatsApp, in order (subject, description, announce, restrict). */
  changed: string[];
  /** Asked for but already so: not sent. */
  unchanged: string[];
  /** The new subject was written on the canonical conversation. */
  persisted: boolean;
  group: GroupStateView | null;
}

/** POST /groups/participants. */
export interface GroupParticipantsResult {
  action: GroupParticipantAction;
  groupId: string;
  results: GroupParticipantResult[];
  succeeded: number;
  failed: number;
  partial: boolean;
  persisted: boolean;
  group: GroupStateView | null;
}

/**
 * Chat-level actions of POST /chats/modify (fase 3 / PR-5, the NAS fork's
 * modifyChat adapted). Starring is not here: WhatsApp stars messages, not
 * chats — the console's "destacar" is its own conversations.flagged.
 */
export type ChatModifyAction =
  'archive' | 'unarchive' | 'pin' | 'unpin' | 'mute' | 'unmute' | 'markRead' | 'markUnread';

const CHAT_MODIFY_ALIASES: Record<string, ChatModifyAction> = {
  archive: 'archive',
  unarchive: 'unarchive',
  pin: 'pin',
  unpin: 'unpin',
  mute: 'mute',
  unmute: 'unmute',
  markread: 'markRead',
  read: 'markRead',
  markunread: 'markUnread',
  unread: 'markUnread',
};

/** `markRead`, `mark-read`, `mark_read`, `read`… → the action; null if unknown. */
export function normalizeChatModifyAction(value: unknown): ChatModifyAction | null {
  if (typeof value !== 'string') return null;
  return (
    CHAT_MODIFY_ALIASES[
      value
        .trim()
        .toLowerCase()
        .replace(/[-_\s]/g, '')
    ] ?? null
  );
}

/** Actions whose app-state patch carries a message range (Baileys `lastMessages`). */
export function chatModifyNeedsLastMessage(action: ChatModifyAction): boolean {
  return (
    action === 'archive' ||
    action === 'unarchive' ||
    action === 'markRead' ||
    action === 'markUnread'
  );
}

/**
 * The documented Baileys chatModify shapes. archive / markRead need
 * `lastMessages` — the newest message of the chat, key + timestamp in
 * seconds (Baileys takes the LAST entry as lastMessageTimestamp, so one
 * entry, the newest). Mute takes WhatsApp's muteEndTimestamp (see
 * muteEndTimestamp), unmute null.
 */
export function buildChatModification(
  action: ChatModifyAction,
  options: {
    lastMessages?: Array<{ key: WAMessageKey; messageTimestamp: number }>;
    mute?: MuteState;
  } = {}
): ChatModification {
  const lastMessages = options.lastMessages || [];
  if (chatModifyNeedsLastMessage(action) && !lastMessages.length) {
    throw new MessageUnavailableError(
      `${action} needs the newest message of the chat (key + timestamp) and none is known`,
      404,
      'message_unavailable'
    );
  }
  switch (action) {
    case 'archive':
    case 'unarchive':
      return { archive: action === 'archive', lastMessages };
    case 'markRead':
    case 'markUnread':
      return { markRead: action === 'markRead', lastMessages };
    case 'pin':
    case 'unpin':
      return { pin: action === 'pin' };
    case 'mute':
      return { mute: muteEndTimestamp(options.mute || { until: null }) };
    case 'unmute':
      return { mute: null };
  }
}

/** What an accepted action writes on the canonical conversation. */
function chatStatePatchFor(action: ChatModifyAction, mute?: MuteState): ChatStatePatch {
  switch (action) {
    case 'archive':
    case 'unarchive':
      return { archived: action === 'archive' };
    case 'pin':
      return { pinnedAt: new Date() };
    case 'unpin':
      return { pinnedAt: null };
    case 'mute':
      return { mute: mute || { until: null } };
    case 'unmute':
      return { mute: null };
    case 'markRead':
      return { unread: 'read' };
    case 'markUnread':
      return { unread: 'unread' };
  }
}

/** Options of POST /chats/modify. */
export interface ChatModifyRequest {
  /** For `mute`: until when (null / absent = forever). */
  mute?: MuteState;
  /** Who asked (dgx-messages user, MCP caller); logged, never auth. */
  actor?: string;
}

export interface ChatModifyResult {
  action: ChatModifyAction;
  /** Normalised jid the change went to (the one WhatsApp used last). */
  chatId: string;
  /** conversations.id of the canonical conversation; null when not ingesting. */
  conversationId: string | null;
  /** The row was written (false: pairing pool, or pin / mute without migration 012). */
  persisted: boolean;
  /** The canonical row after the change, when persisted. */
  state: ChatState | null;
}

/** A message we can edit or delete: its real WhatsApp key and what we stored of it. */
interface MutationTarget {
  /** Bare WhatsApp id. */
  id: string;
  key: WAMessageKey;
  chatJid: string;
  timestampSeconds?: number;
  /** true/false when known from the row or the payload, undefined when unknown. */
  isText?: boolean;
  stored?: StoredMessage;
}

// ---------------------------------------------------------------------------
// LID → phone-number (PN) extraction
//
// WhatsApp's privacy migration re-addresses 1:1 chats with LID jids
// (`<lid>@lid`). The LID is an opaque privacy id — it is NOT a phone number, so
// the legacy "digits before @" extraction yields garbage for downstream
// consumers that need the real MSISDN (skirmshop-labels' opt-in poller keys on
// the phone). Baileys exposes the real phone-number jid alongside the LID, but
// the EXACT field name has moved across releases, so we probe every known
// carrier defensively rather than pin one:
//
//   - Baileys 7.x (decode-wa-message.js): the decoded key carries the alternate
//     (PN) address as `key.remoteJidAlt` for 1:1 chats and `key.participantAlt`
//     for groups. These are fed from the stanza attrs
//     `participant_pn || sender_pn || peer_recipient_pn` when addressingMode is
//     'lid' — i.e. the real `…@s.whatsapp.net`.
//   - 6.17.x / messages.upsert variants the field has also appeared as
//     `key.senderPn` / `key.participantPn` and (on the upsert payload itself)
//     `msg.senderPn`. We read those too so the feature lights up the moment the
//     connector runs on a Baileys build that surfaces the PN, without inventing
//     anything on builds that don't (origin/main currently resolves 6.17.16,
//     which does NOT surface a per-message PN — the helper correctly returns
//     undefined there).
//
// The function is pure and side-effect free so it is unit-testable without a
// live socket. It returns nothing unless the chat/sender is genuinely `@lid`
// AND a plausible PN jid is found — we never fabricate a number.
// ---------------------------------------------------------------------------

/** A `@lid` jid is the privacy id; anything else is already phone-addressable. */
function isLidJid(jid: string | null | undefined): boolean {
  return typeof jid === 'string' && jid.endsWith('@lid');
}

/**
 * Derive an E.164 string (with leading '+') from a phone-number jid such as
 * `34659695630@s.whatsapp.net` or `34659695630:3@s.whatsapp.net`. Returns
 * undefined if the user part is not a plausible run of digits (so a LID jid,
 * a group jid, or anything non-numeric never produces a fake number).
 */
export function pnJidToE164(pnJid: string | null | undefined): string | undefined {
  if (!pnJid || typeof pnJid !== 'string') return undefined;
  // Only phone-number jids carry a real MSISDN. A `@lid` user part is opaque.
  if (!pnJid.endsWith('@s.whatsapp.net') && !pnJid.endsWith('@c.us')) return undefined;
  const at = pnJid.indexOf('@');
  let user = at > 0 ? pnJid.slice(0, at) : pnJid;
  const colon = user.indexOf(':'); // strip device suffix like ":3"
  if (colon > 0) user = user.slice(0, colon);
  if (!/^\d{6,15}$/.test(user)) return undefined; // E.164 is 6–15 digits
  return `+${user}`;
}

export interface LidPnInfo {
  /** Bare phone-number jid, e.g. `34659695630@s.whatsapp.net`. */
  pnJid: string;
  /** E.164 with '+', e.g. `+34659695630`. */
  e164: string;
}

/**
 * If (and only if) the message's chat/sender is LID-addressed and Baileys
 * provided the alternate phone-number jid, return that PN jid + its E.164 form.
 * Returns undefined otherwise (normal `@c.us`/`@s.whatsapp.net` chats, or a LID
 * chat where no PN was attached). Pure — safe to call from tests with a plain
 * object that mimics the relevant `WAMessage` fields.
 */
export function pnFromLidMessage(msg: WAMessage | undefined | null): LidPnInfo | undefined {
  const key = msg?.key;
  if (!key) return undefined;

  // Only act when the chat or the sender is genuinely LID-addressed; a normal
  // phone-addressed chat already carries the number in remoteJid/participant and
  // needs no side-channel.
  const lidAddressed = isLidJid(key.remoteJid) || isLidJid(key.participant);
  if (!lidAddressed) return undefined;

  // Probe every known PN-carrying field, in priority order, across Baileys
  // versions. Cast through a loose shape because the older type defs do not
  // declare the newer `*Alt` / `*Pn` fields.
  const k = key as unknown as Record<string, unknown>;
  const m = msg as unknown as Record<string, unknown>;
  const candidates = [
    k.remoteJidAlt, // Baileys 7.x — 1:1 alternate (PN) address
    k.participantAlt, // Baileys 7.x — group alternate (PN) address
    k.senderPn, // 6.17.x / variant naming on the key
    k.participantPn, // 6.17.x / variant naming on the key
    m.senderPn, // messages.upsert payload-level fallback
    m.participantPn,
  ];

  for (const c of candidates) {
    if (typeof c !== 'string' || !c) continue;
    if (isLidJid(c)) continue; // an alt that is itself a LID is not a PN
    const e164 = pnJidToE164(c);
    if (e164) return { pnJid: c, e164 };
  }
  return undefined;
}

/**
 * INFRA-288 (P1 of INFRA-112): limits for the reconnect history backfill.
 *
 * When a Baileys socket drops, WhatsApp keeps the messages that arrived while
 * offline only in the phone; the reconnect itself replays nothing. So on every
 * `connection.update: open` we ask for the dropped window — bounded, never
 * unbounded history. Pure function of env so the constructor and the tests
 * share one reading of the flags:
 *
 * - WA_RECONNECT_BACKFILL_WINDOW_HOURS (default 6): how far back the dropped
 *   window reaches. Hard defensive ceiling 24h.
 * - WA_RECONNECT_BACKFILL_MAX_MESSAGES (default 500): total messages asked for
 *   per burst. Hard defensive ceiling 1000.
 *
 * `0` or negative on either flag disables the feature entirely (zero fetches).
 * Batch per chat is 50 — the maximum the Postgres-side history machinery
 * (backfillHistory / messaging-history.set) handles per request.
 */
export function reconnectBackfillLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): { windowMs: number; maxMessages: number; batchSize: number } | null {
  const rawHours = parseInt(env.WA_RECONNECT_BACKFILL_WINDOW_HOURS ?? '', 10);
  const rawMax = parseInt(env.WA_RECONNECT_BACKFILL_MAX_MESSAGES ?? '', 10);
  const hours = Number.isNaN(rawHours) ? 6 : rawHours;
  const max = Number.isNaN(rawMax) ? 500 : rawMax;
  if (hours <= 0 || max <= 0) return null;
  return {
    windowMs: Math.min(hours, 24) * 60 * 60 * 1000,
    maxMessages: Math.min(max, 1000),
    batchSize: 50,
  };
}

/**
 * SC-1225: per-instance options. Both default to the legacy behaviour, so a
 * `new BaileysClient(path, key)` (the house connectors) is unchanged.
 */
export interface BaileysClientOptions {
  /**
   * When true the QR never leaves memory: no terminal render on stdout and no
   * `<sessionPath>/qr.png` on disk. The per-sub pairing pool sets it — a QR is
   * a login credential for someone else's WhatsApp account and must only
   * reach its owner through the signed pairing API.
   */
  quietQr?: boolean;
  /**
   * When false the socket only pairs and keeps credentials fresh: no message
   * or history ingest, no chat/presence handlers, no media-bucket or history
   * table checks. v1 of the pairing pool does not ingest (SC-1197 D1).
   */
  ingest?: boolean;
}

export class BaileysClient extends EventEmitter {
  private sock: WASocket | null = null;
  private readonly quietQr: boolean;
  private readonly ingest: boolean;
  private sessionPath: string;
  // kept for backward compat with the old constructor signature; unused.
  private encryptionKey: Buffer;
  // SC-705 credential-store hooks (see setCredsSavedHook / setSessionInvalidatedHook).
  private credsSavedHook: (() => void) | null = null;
  private sessionInvalidatedHook: (() => Promise<void> | void) | null = null;
  private logger: pino.Logger;

  // State exposed via getStatus()/getCachedState()/isConnected()
  private ready = false;
  private lastState: string | null = null;
  private connecting = false;
  private intentionalDisconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private connectedAt: Date | null = null;
  private lastQrAt: Date | null = null;
  private lastDisconnectedAt: Date | null = null;
  private lastReconnectAt: Date | null = null;
  private initializeStartedAt: Date | null = null;
  private lastQrReminderAt = 0;
  private reconnectAttempts = 0;
  private readonly watchdogIntervalMs = parseInt(
    process.env.WA_WATCHDOG_INTERVAL_MS || '60000',
    10
  );
  private readonly initializeMaxMs = parseInt(process.env.WA_INITIALIZE_MAX_MS || '180000', 10);
  private readonly retryMessageCacheTtlMs = parseInt(
    process.env.WA_RETRY_MESSAGE_CACHE_TTL_MS || String(24 * 60 * 60 * 1000),
    10
  );
  private readonly retryMessageCacheMax = parseInt(
    process.env.WA_RETRY_MESSAGE_CACHE_MAX || '5000',
    10
  );
  // Off by default. For iPhone history, ChatStorage.sqlite remains the primary
  // import source; this flag lets Baileys fill whatever WhatsApp sends during
  // a fresh device link without treating those messages as live events.
  private readonly historySyncOnLogin = process.env.WA_HISTORY_SYNC_ON_LOGIN === 'true';
  // INFRA-288: bounded backfill of the window dropped between a disconnect and
  // the reconnect. null = feature off (a 0/negative flag). Read once at
  // construction like the other WA_* knobs.
  private readonly reconnectBackfillLimits = reconnectBackfillLimitsFromEnv();
  private lastReconnectBackfillAt = 0;
  private reconnectBackfillInFlight = false;
  // F1.7 honest voice — OFF by default. Enabled (with S3_PUBLIC_ENDPOINT) only
  // on the professional deployment: awaits the voice-note upload before the
  // NATS emit so the event carries a presigned audio URL synapse can
  // transcribe. Personal stays on the historical fire-and-forget path.
  private readonly emitAudioAttachments = process.env.WA_EMIT_AUDIO_ATTACHMENTS === 'true';
  private readonly audioPreEmitTimeoutMs = parseInt(
    process.env.WA_AUDIO_PREEMIT_TIMEOUT_MS || '15000',
    10
  );

  // me — populated on `connection.update { connection: 'open' }`
  private meJid: string | null = null;
  private meName: string | null = null;

  // In-memory mirrors. Baileys removed makeInMemoryStore, so we keep the
  // minimum we need for the existing API contract.
  private chatStore = new Map<string, CachedChat>(); // by normalised JID
  // Display names indexed by raw participant JID — populated when we ingest
  // a message; used by the presence.update handler to label "X is typing…".
  private contactNames = new Map<string, string>();
  // Track which JIDs we've already presenceSubscribed to so we don't spam.
  private presenceSubscribed = new Set<string>();
  private groupMetaCache = new Map<string, GroupMetadata>(); // by raw JID
  private keyCache = new Map<string, { key: WAMessageKey; chatJid: string }>(); // by waMessageId
  // `<kind>:<bare id>` of our own edits/revokes/deletes-for-me whose echo the
  // inbound handlers must leave alone (see OWN_MUTATION_ECHO_MS).
  private ownMutations = new Map<string, ReturnType<typeof setTimeout> | null>();
  private immediateSendFailureWaiters = new Map<string, (failure: ImmediateSendFailure) => void>();
  private recentImmediateSendFailures = new Map<
    string,
    { failure: ImmediateSendFailure; expiresAt: number }
  >();
  private retryMessageCache: CacheStore;
  private msgRetryCounterCache: CacheStore;
  private userDevicesCache: CacheStore;
  private placeholderResendCache: CacheStore;
  private historyBackfillRequestedUntil = 0;

  constructor(sessionPath: string, encryptionKey: string, options: BaileysClientOptions = {}) {
    super();
    this.sessionPath = sessionPath;
    this.quietQr = options.quietQr === true;
    this.ingest = options.ingest !== false;
    this.encryptionKey = Buffer.from(encryptionKey, 'utf-8');
    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
    this.retryMessageCache = new TtlCache(this.retryMessageCacheTtlMs, this.retryMessageCacheMax);
    this.msgRetryCounterCache = new TtlCache(60 * 60 * 1000, 10000);
    this.userDevicesCache = new TtlCache(5 * 60 * 1000, 10000);
    this.placeholderResendCache = new TtlCache(60 * 60 * 1000, 10000);
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.connecting) {
      this.logger.warn('WhatsApp connect requested while another connect is already in progress');
      return;
    }

    this.connecting = true;
    this.ready = false;
    this.lastState = 'INITIALIZING';
    this.initializeStartedAt = new Date();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopWatchdog();

    try {
      await this.destroyCurrentSocket('before connect');

      if (this.ingest) {
        try {
          await ensureMediaBucket();
        } catch (e: any) {
          this.logger.warn(
            `MinIO bucket check failed (auto-download may not work): ${e?.message || e}`
          );
        }
        await ensureHistoryTables();
      }

      const authDir = this.authDir();
      await fsp.mkdir(authDir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({
        version: [2, 3000, 1015901307] as [number, number, number],
        isLatest: false,
      }));
      this.logger.info(`Baileys WA version=${version.join('.')} latest=${isLatest}`);
      const baileysLogger = pino({ level: 'warn' }) as any;

      this.sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
        },
        printQRInTerminal: false,
        browser: this.historySyncOnLogin
          ? Browsers.macOS('Desktop')
          : ['mcp-socialmedia', 'Chrome', '1.0.0'],
        // Use a dedicated pino logger silencing inner noise; bumping to info
        // is too chatty.
        logger: baileysLogger,
        syncFullHistory: this.historySyncOnLogin,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        msgRetryCounterCache: this.msgRetryCounterCache,
        userDevicesCache: this.userDevicesCache,
        placeholderResendCache: this.placeholderResendCache,
        cachedGroupMetadata: async (jid: string) => this.groupMetaCache.get(this.toRawJid(jid)),
        getMessage: key => this.getMessageForRetry(key),
      });

      this.bindSocketEvents(saveCreds);
      this.startWatchdog();
    } finally {
      this.connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopWatchdog();
    await this.destroyCurrentSocket('manual disconnect');
    this.lastState = 'DISCONNECTED';
    this.lastDisconnectedAt = new Date();
    this.ready = false;
    this.intentionalDisconnect = false;
  }

  async renewQR(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  private authDir(): string {
    // Keep wwebjs `session/` untouched so we can revert by reverting the code.
    return join(this.sessionPath, 'baileys-auth');
  }

  /** Public view of the auth dir (SC-705 credential-store wiring in main.ts). */
  getAuthDir(): string {
    return this.authDir();
  }

  /**
   * SC-705: called after every baileys `saveCreds()` completes. The per-sub
   * connector sets this to the credential-store write-back; the house
   * connectors leave it unset and behave exactly as before.
   */
  setCredsSavedHook(hook: () => void): void {
    this.credsSavedHook = hook;
  }

  /**
   * SC-705: called when the session is irrecoverably dead (WhatsApp
   * `loggedOut` — the user unlinked this device). The per-sub connector uses
   * it to delete its credential-store row so a restart cannot resurrect a
   * dead session.
   */
  setSessionInvalidatedHook(hook: () => Promise<void> | void): void {
    this.sessionInvalidatedHook = hook;
  }

  private async destroyCurrentSocket(reason: string): Promise<void> {
    const sock = this.sock;
    this.sock = null;
    if (!sock) return;
    try {
      this.logger.info(`Closing WhatsApp socket (${reason})`);
      sock.end(undefined as any);
    } catch (e: any) {
      this.logger.warn(`Failed to close socket cleanly (${reason}): ${e?.message || e}`);
    }
  }

  private bindSocketEvents(saveCreds: () => Promise<void>): void {
    const sock = this.sock;
    if (!sock) return;

    sock.ev.on('creds.update', () => {
      // SC-705: after the on-disk save completes, let the per-sub connector
      // mirror the auth dir into the credential store (no-op for the house).
      void saveCreds()
        .then(() => this.credsSavedHook?.())
        .catch((e: any) => this.logger.warn(`saveCreds failed: ${e?.message || e}`));
    });

    sock.ev.on('connection.update', update => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.handleQR(qr);
      }

      if (connection === 'connecting') {
        this.lastState = 'CONNECTING';
        return;
      }

      if (connection === 'open') {
        this.meJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
        this.meName = sock.user?.name || null;
        this.markConnected('connection.update open');
        // SC-1225: a pairing-only socket (ingest off) touches no DB state.
        if (!this.ingest) return;
        // Pull current unread/archived/pin state from WhatsApp app-state. This
        // emits chats.update events whose handler persists unread_count +
        // archived to the DB, so the dashboard shows the real badges without
        // waiting for new traffic. Fire-and-forget; safe if it fails.
        void this.resyncChatState('connection-open');
        // Subscribe to presence for the most-recently-active chats so we
        // receive "composing"/"recording" updates and can forward typing
        // indicators to the dashboard. baileys auto-renews subscriptions
        // while the socket stays open.
        void this.subscribePresenceForActiveChats(200);
        // INFRA-288: messages that arrived while the socket was down live only
        // on the phone until we ask for them — pull the dropped window, bounded.
        // Skipped when WA_HISTORY_SYNC_ON_LOGIN is on: Baileys already syncs
        // history there. Fire-and-forget; must never break this handler.
        void this.backfillReconnectWindow().catch(e =>
          this.logger.warn(`reconnect backfill failed: ${e?.message || e}`)
        );
        return;
      }

      if (connection === 'close') {
        this.ready = false;
        this.lastDisconnectedAt = new Date();
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || `close (${statusCode || 'unknown'})`;
        this.lastState = `CLOSED:${statusCode || 'unknown'}`;
        this.logger.warn(`WhatsApp socket closed: ${reason}`);
        this.emit('disconnected');

        if (this.intentionalDisconnect) {
          return;
        }

        // 401 / loggedOut → session is gone, no point retrying without rescan.
        if (statusCode === DisconnectReason.loggedOut) {
          this.lastState = 'LOGGED_OUT';
          this.logger.error('WhatsApp session was logged out — rescan QR required');
          // Wipe local creds so next connect() emits a fresh QR.
          void fsp.rm(this.authDir(), { recursive: true, force: true }).catch(() => {});
          // SC-705: the stored row is dead too — without this the next pod
          // restart would re-apply it and loop on loggedOut (no-op for the
          // house connectors, which have no hook).
          if (this.sessionInvalidatedHook) {
            void Promise.resolve(this.sessionInvalidatedHook()).catch((e: any) =>
              this.logger.warn(`session-invalidated hook failed: ${e?.message || e}`)
            );
          }
          this.scheduleReconnect('logged out');
          return;
        }

        this.scheduleReconnect(reason);
      }
    });

    // SC-1225: pairing-only sockets stop here — no message/history/chat
    // handlers, so nothing is ingested for a per-sub session in v1.
    if (!this.ingest) return;

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      const isLive = type === 'notify';
      for (const msg of messages) {
        if (!msg.message) continue;
        try {
          await this.ingestMessage(msg, {
            source: isLive ? 'live' : 'baileys_history_sync',
            publishEvent: isLive,
          });
        } catch (e: any) {
          this.logger.error(`Error processing message ${msg.key?.id}: ${e?.message || e}`);
        }
      }
    });

    sock.ev.on('messaging-history.set', async ({ chats, messages, isLatest }) => {
      // chats: Chat[] (Baileys type). Refresh in-memory chat store.
      for (const c of chats) {
        if (!c.id) continue;
        const isGroup = !!isJidGroup(c.id);
        const norm = this.normalizeJid(c.id);
        this.chatStore.set(norm, {
          id: norm,
          rawJid: c.id,
          name: c.name || c.id,
          isGroup,
          unreadCount: c.unreadCount || 0,
          timestamp: Number(c.conversationTimestamp || 0),
        });
        // Persist real unread + archived from the history snapshot.
        void setConversationState(norm, c.unreadCount || 0, !!(c as any).archived).catch(() => {});
        // Pin / mute (fase 3 / PR-5): only what the snapshot says.
        void recordInboundChatState(norm, {
          pinnedAt: pinFromBaileys(c),
          mute: muteFromBaileys(c, 'snapshot'),
        });
      }
      if (!this.historySyncOnLogin && Date.now() > this.historyBackfillRequestedUntil) return;
      this.logger.info(
        `history.set received chats=${chats.length} messages=${messages.length} isLatest=${isLatest}`
      );
      const byChat = new Map<
        string,
        { inserted: number; oldest?: WhatsAppMessage; newest?: WhatsAppMessage }
      >();
      for (const m of messages) {
        try {
          const result = await this.ingestMessage(m, {
            source: 'baileys_history_sync',
            publishEvent: false,
            isLatest,
          });
          if (!result.waMessage) continue;
          const entry = byChat.get(result.waMessage.conversationId) || { inserted: 0 };
          if (result.inserted) entry.inserted += 1;
          if (!entry.oldest || result.waMessage.waTimestamp < entry.oldest.waTimestamp)
            entry.oldest = result.waMessage;
          if (!entry.newest || result.waMessage.waTimestamp > entry.newest.waTimestamp)
            entry.newest = result.waMessage;
          byChat.set(result.waMessage.conversationId, entry);
        } catch (e: any) {
          this.logger.warn(`history ingest failed for ${m.key?.id}: ${e?.message || e}`);
        }
      }
      for (const [conversationId, state] of Array.from(byChat.entries())) {
        await recordHistorySyncProgress({
          conversationId,
          oldestMessageId: state.oldest?.waMessageId,
          oldestTimestamp: state.oldest?.waTimestamp,
          newestTimestamp: state.newest?.waTimestamp,
          insertedCount: state.inserted,
          status: state.inserted > 0 ? 'pending' : 'requested',
        }).catch(e =>
          this.logger.warn(`history state update failed for ${conversationId}: ${e?.message || e}`)
        );
      }
    });

    sock.ev.on('chats.update', updates => {
      for (const u of updates) {
        if (!u.id) continue;
        const norm = this.normalizeJid(u.id);
        const prev = this.chatStore.get(norm);
        if (prev) {
          if (typeof u.unreadCount === 'number') {
            // -1 = marked as unread on the phone: a dot, at least one unread.
            prev.unreadCount = u.unreadCount < 0 ? Math.max(prev.unreadCount, 1) : u.unreadCount;
          }
          if (u.conversationTimestamp) prev.timestamp = Number(u.conversationTimestamp);
          if ((u as any).name) prev.name = (u as any).name;
          this.emit('chat-update', {
            waChatId: prev.id,
            updateType: 'NAME_CHANGED',
            metadata: { name: prev.name },
          });
        }
        // chats.update may carry only a delta — persist whichever fields are
        // present (an archive-only delta for a chat not cached here leaves the
        // badge alone instead of zeroing it).
        const uc = typeof u.unreadCount === 'number' ? u.unreadCount : prev?.unreadCount;
        const arch = typeof (u as any).archived === 'boolean' ? (u as any).archived : undefined;
        void setConversationState(norm, uc, arch).catch(() => {});
        // Pin / mute from app-state sync (the phone, or the echo of our own
        // POST /chats/modify — same values), on the canonical conversation.
        void recordInboundChatState(norm, {
          pinnedAt: pinFromBaileys(u),
          mute: muteFromBaileys(u, 'sync-action'),
        });
      }
    });

    sock.ev.on('chats.upsert', upserts => {
      for (const c of upserts) {
        if (!c.id) continue;
        const norm = this.normalizeJid(c.id);
        this.chatStore.set(norm, {
          id: norm,
          rawJid: c.id,
          name: c.name || c.id,
          isGroup: !!isJidGroup(c.id),
          unreadCount: c.unreadCount || 0,
          timestamp: Number(c.conversationTimestamp || 0),
        });
        // Persist real unread badge + archived flag (fire-and-forget).
        void setConversationState(norm, c.unreadCount || 0, !!(c as any).archived).catch(() => {});
        void recordInboundChatState(norm, {
          pinnedAt: pinFromBaileys(c),
          mute: muteFromBaileys(c, 'snapshot'),
        });
        // Subscribe to presence so we get typing updates for this chat.
        void this.presenceSubscribeSilent(c.id);
      }
    });

    // Presence updates → typing indicator. Payload shape:
    //   { id: chatJid, presences: { [participantJid]: { lastKnownPresence, lastSeen? } } }
    // We forward only "composing"/"recording" — paused/available means stop.
    sock.ev.on('presence.update' as any, (evt: any) => {
      try {
        const chatJid: string = evt?.id;
        const presences: Record<string, any> = evt?.presences || {};
        if (!chatJid || !presences) return;
        const convId = this.normalizeJid(chatJid);
        for (const [participantJid, p] of Object.entries(presences)) {
          const status = p?.lastKnownPresence;
          if (status !== 'composing' && status !== 'recording') continue;
          // Lookup display name from the participants we've seen
          const name =
            this.contactNames.get(participantJid) ||
            this.contactNames.get(this.normalizeJid(participantJid)) ||
            null;
          void dashboardNotify('/_connector/typing', {
            conversation_id: convId,
            sender_id: participantJid,
            sender_name: name,
            status: 'composing',
            ttl_ms: 8000, // baileys re-emits every ~5s; 8s TTL keeps it lit
          });
        }
      } catch (e) {
        this.logger.warn(`presence.update handler failed: ${(e as Error).message}`);
      }
    });

    sock.ev.on('messages.update', updates => {
      for (const u of updates) {
        if (!u.key?.id) continue;
        const waMessageId = u.key.id;
        const stubParams = (u.update as any)?.messageStubParameters;
        const ackErrorCode = Array.isArray(stubParams) ? String(stubParams[0] || '') : undefined;
        // Revokes and edits (fase 3 / PR-3).
        void this.handleInboundMutation(u);
        // Track delivery state from WhatsApp servers (the green ticks).
        const st: number | undefined = (u.update as any)?.status;
        if (typeof st === 'number') {
          const mapped = mapWaStatus(st);
          if (mapped) {
            void setMessageStatus(waMessageId, mapped).catch(() => {});
            if (mapped === 'failed') {
              const failureClass: WhatsAppSendFailureClass =
                ackErrorCode === '463' ? 'account_restricted' : 'unknown';
              this.resolveImmediateSendFailure(waMessageId, {
                failureClass,
                code: ackErrorCode,
                message:
                  ackErrorCode === '463'
                    ? 'WhatsApp rejected this 1:1 send with 463: account restricted or missing trusted-contact token.'
                    : `WhatsApp rejected this send${ackErrorCode ? ` with ack error ${ackErrorCode}` : ''}.`,
              });
            }
          }
        }
      }
    });

    // "Delete for me" done on our phone (or another linked device) arrives as
    // an app-state sync action. Same flag as deleteMessageForMe; no bus event.
    sock.ev.on('messages.delete', item => {
      void this.handleDeleteForMeSync(item);
    });

    // Receipts from individual recipients (group "✓✓ for everyone" or read).
    sock.ev.on('message-receipt.update' as any, (updates: any[]) => {
      for (const u of updates || []) {
        const waMessageId = u?.key?.id;
        const t: 'read' | 'delivered' | null = u?.receipt?.readTimestamp
          ? 'read'
          : u?.receipt?.receiptTimestamp
            ? 'delivered'
            : null;
        if (waMessageId && t) {
          void setMessageStatus(waMessageId, t).catch(() => {});
        }
      }
    });

    sock.ev.on('group-participants.update', evt => {
      const { id, participants, action } = evt;
      const norm = this.normalizeJid(id);
      const updateType =
        action === 'add'
          ? 'PARTICIPANT_ADDED'
          : action === 'remove'
            ? 'PARTICIPANT_REMOVED'
            : 'NAME_CHANGED';
      this.emit('chat-update', {
        waChatId: norm,
        updateType,
        metadata: {
          participants: participants.map(p => this.normalizeJid(typeof p === 'string' ? p : p.id)),
          action,
        },
      });
      this.groupMetaCache.delete(id);
    });

    // A group created (by us or with us in it): its conversation row, so it
    // is listed before its first message. A new subject: on the canonical row.
    sock.ev.on('groups.upsert', groups => {
      for (const meta of groups) {
        if (!meta?.id) continue;
        this.cacheGroupMetadata(meta);
        void recordInboundGroup('upsert', meta);
      }
    });

    sock.ev.on('groups.update', updates => {
      for (const update of updates) {
        if (!update?.id) continue;
        this.groupMetaCache.delete(update.id);
        const chat = this.chatStore.get(this.normalizeJid(update.id));
        if (chat && update.subject) chat.name = update.subject;
        void recordInboundGroup('update', update);
      }
    });
  }

  private handleQR(qr: string): void {
    this.ready = false;
    this.lastState = 'QR';
    this.lastQrAt = new Date();
    if (this.quietQr) {
      // SC-1225: the QR stays in memory; only the 'qr' event carries it.
      this.emit('qr', qr);
      return;
    }
    qrcodeTerminal.generate(qr, { small: true });
    QRCode.toFile(join(this.sessionPath, 'qr.png'), qr, { width: 400 }).catch(() => {});
    this.logger.warn(
      `WhatsApp requires QR scan at ${process.env.WA_QR_PUBLIC_URL || 'https://whatsapp.e-dani.com/'}`
    );
    this.emit('qr', qr);
  }

  private markConnected(source: string): void {
    const wasReady = this.ready;
    this.ready = true;
    this.lastState = 'CONNECTED';
    this.connectedAt = this.connectedAt || new Date();
    this.initializeStartedAt = null;
    this.reconnectAttempts = 0;
    if (!wasReady) {
      this.logger.info(`WhatsApp marked connected via ${source}`);
      this.emit('connected');
    }
  }

  // ---------------------------------------------------------------------------
  // Watchdog / reconnect
  // ---------------------------------------------------------------------------

  private startWatchdog(): void {
    if (!this.watchdogIntervalMs || this.watchdogIntervalMs < 10000 || this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      void this.runWatchdog().catch(e =>
        this.logger.warn(`WhatsApp watchdog failed: ${e?.message || e}`)
      );
    }, this.watchdogIntervalMs);
    (this.watchdogTimer as any).unref?.();
  }

  private stopWatchdog(): void {
    if (!this.watchdogTimer) return;
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private async runWatchdog(): Promise<void> {
    if (this.connecting) return;
    const now = Date.now();

    if (this.ready) return;

    if (
      this.lastState === 'QR' ||
      this.lastState === 'LOGGED_OUT' ||
      this.lastState?.startsWith('CLOSED:401')
    ) {
      if (now - this.lastQrReminderAt > 10 * 60 * 1000) {
        this.lastQrReminderAt = now;
        this.logger.warn(
          `WhatsApp is waiting for manual QR scan: ${process.env.WA_QR_PUBLIC_URL || 'https://whatsapp.e-dani.com/'}`
        );
      }
      return;
    }

    if (
      this.initializeStartedAt &&
      now - this.initializeStartedAt.getTime() > this.initializeMaxMs
    ) {
      this.logger.warn(`Watchdog restarting stuck WhatsApp socket state=${this.lastState}`);
      await this.reconnectNow(`stuck in ${this.lastState || 'unknown'}`);
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.reconnectTimer || this.connecting) return;
    const delayMs = Math.min(60000, 5000 * Math.max(1, this.reconnectAttempts + 1));
    this.logger.warn(`Scheduling WhatsApp reconnect in ${delayMs}ms (${reason})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectNow(reason).catch(e =>
        this.logger.error(`Reconnect failed: ${e?.message || e}`)
      );
    }, delayMs);
    (this.reconnectTimer as any).unref?.();
  }

  private async reconnectNow(reason: string): Promise<void> {
    if (this.connecting) return;
    this.reconnectAttempts += 1;
    this.lastReconnectAt = new Date();
    this.ready = false;
    this.lastState = 'RECONNECTING';
    await this.destroyCurrentSocket(reason);
    await this.connect();
  }

  // ---------------------------------------------------------------------------
  // Message ingest (live events + history-on-login)
  // ---------------------------------------------------------------------------

  private async ingestMessage(msg: WAMessage, options: IngestOptions = {}): Promise<IngestResult> {
    if (msg.key?.id && msg.message) {
      this.rememberMessageForRetry(msg.key, msg.message);
    }

    const waMessage = this.convertMessage(msg);
    if (!waMessage) return { inserted: false };

    this.rememberKey(waMessage.waMessageId, msg.key, msg.key.remoteJid || '');

    const rawChatJid = msg.key.remoteJid || '';
    const isGroup = !!isJidGroup(rawChatJid);

    const chatName = this.chatStore.get(waMessage.conversationId)?.name || waMessage.conversationId;
    let participantCount = 2;
    if (isGroup) {
      const meta = await this.fetchGroupMetadata(rawChatJid).catch(() => null);
      participantCount = meta?.participants?.length || 0;
    }

    await ensureConversation({
      id: waMessage.conversationId,
      name: chatName,
      isGroup,
      participantCount,
    });

    // WhatsApp privacy migration: when the chat/sender is LID-addressed
    // (`…@lid`), the LID is NOT a phone number, so neither the conversation id
    // nor `phoneFromJid(senderRaw)` yields the real MSISDN that downstream
    // consumers (skirmshop-labels opt-in poller) require. If Baileys attached
    // the alternate phone-number jid, capture it here ONCE and (a) ride it into
    // the message metadata as `senderPnE164`, (b) backfill the long-empty
    // `conversations.wa_chat_id` with the PN jid. Both are best-effort and must
    // never block or abort the message persist. The conversation PK stays the
    // LID (namespaced) — we do not re-key anything.
    const lidPn = pnFromLidMessage(msg);
    // Ride the LID→PN mapping and the Baileys ownership flag on the in-memory
    // message so the NATS event (main.ts) carries them WITHOUT re-querying the
    // DB. `senderPnE164` is only set when real (never fabricated); `fromMe` is
    // always an explicit boolean — it is the same signal that drives
    // direction=OUTBOUND below and lets the synapse bridge forward operator
    // replies flagged as team touches (F0.5) instead of guessing by JID.
    waMessage.fromMe = !!msg.key.fromMe;
    if (lidPn) {
      waMessage.senderPnE164 = lidPn.e164;
      // (b) wa_chat_id backfill — fire-and-forget; a failure here must never
      // drop the message (the metadata field is the load-bearing path).
      void setConversationWaChatId(waMessage.conversationId, lidPn.pnJid).catch(e =>
        this.logger.warn(
          `wa_chat_id backfill failed for conversation=${waMessage.conversationId}: ${
            e?.message || e
          }`
        )
      );
    }

    const senderRaw = msg.key.fromMe
      ? this.meJid || waMessage.senderWaId
      : msg.key.participant || rawChatJid;
    const pushName = msg.pushName || undefined;
    // Cache the display name keyed by the raw participant JID so the
    // presence.update handler can label "Manu está escribiendo…".
    if (pushName) {
      this.contactNames.set(senderRaw, pushName);
      this.contactNames.set(waMessage.senderWaId, pushName);
    }
    await ensureParticipant({
      id: waMessage.senderWaId,
      name: pushName,
      pushName,
      phone: this.phoneFromJid(senderRaw),
    });
    // Best-effort: the conversation<->participant link is a convenience join,
    // NOT a prerequisite for messages (which FK only conversations+participants,
    // already upserted above). A link failure must never abort the ingest and
    // drop the message — the opt-in poller reads `messages`, so losing it is the
    // actual outage. Log with full context instead of swallowing silently.
    await linkParticipantToConversation(waMessage.conversationId, waMessage.senderWaId).catch(e =>
      this.logger.error(
        `participant link persist failed for conversation=${waMessage.conversationId} ` +
          `participant=${waMessage.senderWaId}: ${e?.message || e}`
      )
    );

    // Lazy avatar pulls. Don't await — fire-and-forget so a slow profile
    // picture fetch never delays the message persist.
    void this.ensureConversationAvatarIfMissing(waMessage.conversationId, rawChatJid);
    void this.ensureParticipantAvatarIfMissing(waMessage.senderWaId, senderRaw);

    const data: MessageData = {
      waMessageId: waMessage.waMessageId,
      conversationId: waMessage.conversationId,
      senderWaId: waMessage.senderWaId,
      waTimestamp: waMessage.waTimestamp,
      direction: msg.key.fromMe ? 'OUTBOUND' : 'INBOUND',
      content: waMessage.content,
      messageType: waMessage.messageType,
      isForwarded: waMessage.isForwarded,
      replyToWaId: waMessage.replyToWaId,
      metadata: {
        source: options.source || 'live',
        history_source:
          options.source === 'baileys_history_sync' ? 'baileys_history_sync' : undefined,
        is_latest_history_sync: options.isLatest,
        sync_type: options.syncType,
        // (a) Real sender phone in E.164 (with '+'), ONLY when the chat is LID
        // and Baileys surfaced the PN. Omitted entirely otherwise — never an
        // invented value. Consumer contract: messages.metadata->>'senderPnE164'.
        senderPnE164: lidPn?.e164,
      },
    };
    const msgId = await storeMessage(data);
    await storeMessageKey({
      waMessageId: waMessage.waMessageId,
      conversationId: waMessage.conversationId,
      remoteJid: rawChatJid,
      fromMe: !!msg.key.fromMe,
      participantJid: msg.key.participant || undefined,
      messageTimestampMs: waMessage.waTimestamp.getTime(),
    }).catch(e =>
      this.logger.warn(
        `message key persist failed for ${waMessage.waMessageId}: ${e?.message || e}`
      )
    );
    // Also for an already-stored row (msgId null): a history replay after a
    // relink backfills the payloads of the recent window.
    await this.persistDurablePayload(
      msg,
      waMessage.conversationId,
      options.source === 'baileys_history_sync' ? 'history' : 'live'
    );
    // Before the msgId check: prod folds REACTION inserts into the target's
    // messages.reactions and skips the row, so msgId is always null for them.
    if (waMessage.messageType === 'REACTION') await this.persistReaction(msg, waMessage);

    if (!msgId) return { inserted: false, waMessage };

    this.logger.info(`Stored message ${waMessage.waMessageId} from ${waMessage.senderWaId}`);

    const isLiveMedia =
      (options.source || 'live') === 'live' &&
      waMessage.messageType !== 'TEXT' &&
      waMessage.messageType !== 'REACTION';
    if (isLiveMedia && waMessage.messageType === 'AUDIO' && this.emitAudioAttachments) {
      // F1.7 honest voice: for voice notes the media upload historically ran
      // fire-and-forget AFTER the event emit, so the NATS event never carried
      // attachments and synapse's transcription raised "no downloadable audio
      // attachment" for EVERY voice note (blind handoff). Await the upload
      // (bounded) and ride a presigned out-of-cluster URL on the event. Any
      // timeout/failure degrades to today's behavior: emit without
      // attachments while the persist continues in the background. Only THIS
      // message's emit waits; other upsert events are independent handlers.
      waMessage.attachments = await buildAudioAttachmentsBeforeEmit({
        store: () => this.downloadAndStoreMedia(msg, msgId, waMessage.messageType, undefined),
        presign: key => presignMediaUrl(key),
        timeoutMs: this.audioPreEmitTimeoutMs,
        seconds: Number(msg.message?.audioMessage?.seconds || 0) || undefined,
        presignExpirySeconds: presignExpirySeconds(),
        logger: this.logger,
        logRef: waMessage.waMessageId,
      });
    } else if (isLiveMedia) {
      // Non-audio media (images/docs/stickers/video): unchanged fire-and-forget.
      this.downloadAndStoreMedia(
        msg,
        msgId,
        waMessage.messageType,
        waMessage.content || undefined
      ).catch(err =>
        this.logger.warn(
          `Media download failed for ${waMessage.waMessageId}: ${err?.message || err}`
        )
      );
    }

    if (options.publishEvent !== false) {
      this.emit('message', waMessage);
    }
    return { inserted: true, waMessage };
  }

  private convertMessage(msg: WAMessage): WhatsAppMessage | null {
    if (!msg.key?.id || !msg.key.remoteJid) return null;

    const content = msg.message;
    if (!content) return null;

    // Determine type + body
    let messageType = 'TEXT';
    let body: string | null = null;
    let isForwarded = false;
    let replyToWaId: string | undefined;

    const text = content.conversation;
    const ext = content.extendedTextMessage;
    if (text) {
      body = text;
    } else if (ext) {
      body = ext.text || null;
      const ctx = ext.contextInfo;
      if (ctx) {
        isForwarded = !!ctx.isForwarded || (ctx.forwardingScore || 0) > 0;
        if (ctx.stanzaId) replyToWaId = ctx.stanzaId;
      }
    } else if (content.imageMessage) {
      messageType = 'IMAGE';
      body = content.imageMessage.caption || null;
    } else if (content.videoMessage) {
      messageType = 'VIDEO';
      body = content.videoMessage.caption || null;
    } else if (content.audioMessage) {
      messageType = content.audioMessage.ptt ? 'AUDIO' : 'AUDIO';
      body = null;
    } else if (content.documentMessage) {
      messageType = 'DOCUMENT';
      body = content.documentMessage.caption || content.documentMessage.fileName || null;
    } else if (content.stickerMessage) {
      messageType = 'STICKER';
    } else if (content.reactionMessage) {
      messageType = 'REACTION';
      body = content.reactionMessage.text || null;
      if (content.reactionMessage.key?.id) replyToWaId = content.reactionMessage.key.id;
    } else if (content.locationMessage) {
      messageType = 'LOCATION';
      const loc = content.locationMessage;
      body = `${loc.degreesLatitude},${loc.degreesLongitude}`;
    } else if (content.contactMessage) {
      messageType = 'CONTACT';
      body = content.contactMessage.displayName || null;
    } else if (content.contactsArrayMessage) {
      messageType = 'CONTACT';
      body = content.contactsArrayMessage.displayName || null;
    } else if (content.protocolMessage) {
      // ignore key updates etc.
      return null;
    } else {
      const k = Object.keys(content).find(k => !!(content as any)[k]);
      messageType = (k || 'UNKNOWN').toUpperCase();
    }

    const senderRaw = msg.key.fromMe
      ? this.meJid || msg.key.remoteJid
      : msg.key.participant || msg.key.remoteJid;

    return {
      waMessageId: msg.key.id,
      waTimestamp: new Date(Number(msg.messageTimestamp || 0) * 1000),
      conversationId: this.normalizeJid(msg.key.remoteJid),
      senderWaId: this.normalizeJid(senderRaw),
      content: body,
      messageType,
      isForwarded,
      replyToWaId,
      // Sender display name (attacker-controlled + PII; do NOT log).
      // Omitted when absent (e.g. history sync).
      pushName: msg.pushName || undefined,
    };
  }

  /**
   * Download media from WhatsApp, upload to MinIO and persist the attachment
   * row. Returns the stored object info (F1.7: the audio pre-emit path rides
   * it on the NATS event) or null when the download failed/was empty — the
   * historical fire-and-forget callers simply ignore the return value.
   */
  private async downloadAndStoreMedia(
    msg: WAMessage,
    messageId: bigint,
    messageType: string,
    caption?: string
  ): Promise<StoredMediaInfo | null> {
    const timeoutMs = parseInt(process.env.WA_MEDIA_DOWNLOAD_TIMEOUT_MS || '30000', 10);

    let buffer: Buffer;
    try {
      buffer = await Promise.race([
        downloadMediaMessage(
          msg,
          'buffer',
          {},
          { logger: this.logger as any, reuploadRequest: this.sock!.updateMediaMessage }
        ),
        new Promise<Buffer>((_, rej) =>
          setTimeout(() => rej(new Error('downloadMedia timeout')), timeoutMs)
        ),
      ]);
    } catch (e: any) {
      this.logger.warn(`downloadMedia failed for ${msg.key?.id}: ${e?.message || e}`);
      return null;
    }
    if (!buffer || !buffer.length) {
      this.logger.warn(`downloadMedia returned empty for ${msg.key?.id}`);
      return null;
    }

    const { mimeType, fileName } = this.mediaMetaFromMessage(msg);

    const { storageKey, fileSize } = await uploadMedia(messageId, buffer, mimeType, fileName);

    await storeAttachment(messageId, {
      fileType: messageType,
      mimeType,
      fileName,
      fileSize,
      fileUrl: storageKey,
      caption,
    });

    this.logger.info(`Stored media ${storageKey} (${fileSize} bytes) for msg ${messageId}`);
    return { storageKey, fileSize, mimeType, fileName };
  }

  private mediaMetaFromMessage(msg: WAMessage): { mimeType?: string; fileName?: string } {
    const c = msg.message;
    if (!c) return {};
    if (c.imageMessage)
      return { mimeType: c.imageMessage.mimetype || 'image/jpeg', fileName: undefined };
    if (c.videoMessage)
      return { mimeType: c.videoMessage.mimetype || 'video/mp4', fileName: undefined };
    if (c.audioMessage)
      return { mimeType: c.audioMessage.mimetype || 'audio/ogg', fileName: undefined };
    if (c.documentMessage)
      return {
        mimeType: c.documentMessage.mimetype || undefined,
        fileName: c.documentMessage.fileName || undefined,
      };
    if (c.stickerMessage)
      return { mimeType: c.stickerMessage.mimetype || 'image/webp', fileName: undefined };
    return {};
  }

  // ---------------------------------------------------------------------------
  // Public surface used by the HTTP controller
  // ---------------------------------------------------------------------------

  /**
   * Build a baileys-compatible "quoted" message from a wa_message_id we've
   * seen before: process memory first, then the durable copy (survives
   * restarts). Returns undefined if we don't have the original — a text reply
   * still sends, just without the quote bubble.
   */
  private async buildQuotedFromId(
    replyToMessageId: string | undefined,
    chatJid: string
  ): Promise<WAMessage | undefined> {
    if (!replyToMessageId) return undefined;
    const id = stripAccountKey(replyToMessageId);
    const original = this.memoryMessage(id) || (await this.durableMessage(id));
    if (!original?.message) return undefined;
    return {
      ...original,
      key: { ...original.key, id, remoteJid: chatJid },
    } as WAMessage;
  }

  /** Full WAMessage (key + content) from the in-memory caches. */
  private memoryMessage(messageId: string): WAMessage | undefined {
    const cachedKey = this.keyCache.get(messageId);
    const messageProto =
      this.retryMessageCache.get<proto.IMessage>(messageId) ||
      (cachedKey
        ? this.retryMessageCache.get<proto.IMessage>(
            this.retryMessageCacheKey(cachedKey.chatJid, messageId)
          )
        : undefined);
    if (!cachedKey || !messageProto) return undefined;
    return { key: { ...cachedKey.key, id: messageId }, message: messageProto } as WAMessage;
  }

  /** Durable copy of a message; never consulted by a pairing-only socket. */
  private async durableMessage(messageId: string): Promise<WAMessage | undefined> {
    if (!this.ingest) return undefined;
    return getRawWAMessage(messageId);
  }

  /**
   * Persist the raw message for quote/forward/retry after a restart. SC-1225:
   * a pairing-only socket (ingest off) writes nothing.
   */
  private async persistDurablePayload(
    msg: WAMessage | undefined,
    conversationId: string,
    source: DurablePayloadSource
  ): Promise<void> {
    if (!this.ingest || !msg?.key?.id) return;
    // Hourly, in the background: purge expired payloads and send attempts.
    void maybeRunRetention();
    await storeRawWAMessage(msg, conversationId, source);
  }

  /**
   * A reaction seen on the socket (a contact, our phone, the echo of our own
   * react) → whatsapp_message_reactions. The reactor is the message sender:
   * our own jid when fromMe. SC-1225: a pairing-only socket writes nothing.
   */
  private async persistReaction(msg: WAMessage, waMessage: WhatsAppMessage): Promise<void> {
    const reaction = msg.message?.reactionMessage;
    const target = reaction?.key?.id;
    if (!this.ingest || !target) return;
    await storeMessageReaction({
      targetMessageId: target,
      conversationId: waMessage.conversationId,
      reactorJid: waMessage.senderWaId,
      emoji: reaction.text || '',
      // Raw: a key that never said stays unknown instead of reading as a contact.
      fromMe: msg.key.fromMe ?? null,
      reactionMessageId: msg.key.id || undefined,
      reactedAt: reactionTime(reaction.senderTimestampMs, unixSeconds(msg.messageTimestamp)),
    });
  }

  /**
   * Whether this client owns DB state (live ingest, durable payloads, send
   * idempotency). false for the per-sub pairing pool (SC-1225).
   */
  isIngestEnabled(): boolean {
    return this.ingest;
  }

  /**
   * `messageId` overrides Baileys' random id (idempotent sends) and is reused
   * by the group repair retry; `beforeSend` runs once, after every preflight
   * and right before the message goes to the network (the idempotency claim).
   */
  async sendMessage(
    chatId: string,
    content: string,
    options?: { replyToMessageId?: string; messageId?: string; beforeSend?: () => Promise<void> }
  ): Promise<string | undefined> {
    if (!this.sock) throw new Error('Client not initialized');
    if (!this.isConnected())
      throw new Error(`Client not connected (state=${this.lastState || 'unknown'})`);

    const timeoutMs = parseInt(process.env.WA_SEND_TIMEOUT_MS || '45000', 10);
    const started = Date.now();
    const raw = this.toRawJid(chatId);
    const normalized = this.normalizeJid(raw);
    const isGroup = this.isGroupJid(raw);
    let groupRepair: GroupSessionRefreshResult | undefined;

    if (isGroup) {
      groupRepair = await this.refreshGroupSession(raw, {
        reason: 'send-preflight',
        warmSessions: process.env.WA_GROUP_SEND_PREFLIGHT_SESSIONS !== 'false',
        forceSessions: process.env.WA_GROUP_SEND_FORCE_SESSIONS === 'true',
        clearSenderKeyMemory: process.env.WA_GROUP_SEND_CLEAR_SENDER_KEY !== 'false',
        failOnWarmupError: false,
      }).catch(e => {
        const failureClass =
          classifyWhatsAppSendFailure(e) === 'timeout' ? 'timeout' : 'group_metadata';
        throw this.buildSendError(failureClass, raw, normalized, true, started, 1, e);
      });
    }

    this.logger.info(
      `Sending WhatsApp message rawJid=${raw} normalizedJid=${normalized} type=${isGroup ? 'group' : 'direct'}${groupRepair?.groupSubject ? ` groupSubject="${groupRepair.groupSubject}" participants=${groupRepair.participantCount}` : ''}`
    );
    if (!isGroup && this.isDirectUserJid(raw)) {
      await this.prepareDirectPrivacyToken(raw, normalized, started).catch(e => {
        throw this.buildSendError(
          classifyWhatsAppSendFailure(e),
          raw,
          normalized,
          false,
          started,
          0,
          e
        );
      });
    }
    const quoted = await this.buildQuotedFromId(options?.replyToMessageId, raw);
    await options?.beforeSend?.();
    try {
      const sent = await this.sendTextWithTimeout(raw, content, timeoutMs, {
        useCachedGroupMetadata: isGroup ? false : undefined,
        useUserDevicesCache: isGroup ? false : undefined,
        quoted,
        messageId: options?.messageId,
      });
      const messageId = sent?.key?.id;
      this.logger.info(
        `WhatsApp message sent rawJid=${raw} normalizedJid=${normalized} elapsedMs=${Date.now() - started}${messageId ? ` id=${messageId}` : ''}`
      );
      const immediateFailure = messageId
        ? await this.waitForImmediateSendFailure(messageId)
        : undefined;
      if (immediateFailure) {
        throw this.buildSendError(
          immediateFailure.failureClass,
          raw,
          normalized,
          false,
          started,
          1,
          new Error(immediateFailure.message)
        );
      }
      if (sent?.key) {
        this.rememberKey(messageId || '', sent.key, raw);
        this.rememberMessageForRetry(sent.key, sent.message);
        await this.persistDurablePayload(
          sent,
          this.normalizeJid(sent.key.remoteJid || raw),
          'sent'
        );
      }
      return messageId || undefined;
    } catch (e: any) {
      const failureClass = classifyWhatsAppSendFailure(e);
      this.logger.warn(
        `WhatsApp send attempt failed failureClass=${failureClass} rawJid=${raw} normalizedJid=${normalized} attempt=1 elapsedMs=${Date.now() - started}${groupRepair?.groupSubject ? ` groupSubject="${groupRepair.groupSubject}"` : ''}: ${e?.message || e}`
      );

      if (isGroup && this.shouldRetryGroupSend(failureClass)) {
        let repair: GroupSessionRefreshResult | undefined;
        try {
          repair = await this.refreshGroupSession(raw, {
            reason: `send-retry-after-${failureClass}`,
            warmSessions: true,
            forceSessions: true,
            clearSenderKeyMemory: true,
            failOnWarmupError: true,
          });
          this.logger.info(
            `Retrying WhatsApp group send after repair rawJid=${raw} normalizedJid=${normalized} groupSubject="${repair.groupSubject}" participants=${repair.participantCount} devices=${repair.deviceCount}`
          );
          // Same id as the first attempt: if that one did go out, WhatsApp
          // already holds this message id and the retry is not a new message.
          const retried = await this.sendTextWithTimeout(raw, content, timeoutMs, {
            useCachedGroupMetadata: false,
            useUserDevicesCache: false,
            quoted,
            messageId: options?.messageId,
          });
          const messageId = retried?.key?.id;
          this.logger.info(
            `WhatsApp group message sent after repair rawJid=${raw} normalizedJid=${normalized} elapsedMs=${Date.now() - started}${messageId ? ` id=${messageId}` : ''}`
          );
          if (retried?.key) {
            this.rememberKey(messageId || '', retried.key, raw);
            this.rememberMessageForRetry(retried.key, retried.message);
            await this.persistDurablePayload(
              retried,
              this.normalizeJid(retried.key.remoteJid || raw),
              'sent'
            );
          }
          return messageId || undefined;
        } catch (retryError: any) {
          const retryFailureClass = classifyWhatsAppSendFailure(retryError);
          this.logger.error(
            `WhatsApp group send failed after repair failureClass=${retryFailureClass} rawJid=${raw} normalizedJid=${normalized} attempt=2 elapsedMs=${Date.now() - started}${repair?.groupSubject ? ` groupSubject="${repair.groupSubject}"` : ''}: ${retryError?.message || retryError}`
          );
          throw this.buildSendError(
            retryFailureClass,
            raw,
            normalized,
            true,
            started,
            2,
            retryError,
            repair || groupRepair
          );
        }
      }

      this.logger.error(
        `Failed to send WhatsApp message failureClass=${failureClass} rawJid=${raw} normalizedJid=${normalized} elapsedMs=${Date.now() - started}: ${e?.message || e}`
      );
      throw this.buildSendError(failureClass, raw, normalized, isGroup, started, 1, e, groupRepair);
    }
  }

  async seedContactAndProbe(input: WhatsAppContactSeedInput): Promise<WhatsAppContactSeedResult> {
    if (!this.sock) throw new Error('Client not initialized');
    if (!this.isConnected())
      throw new Error(`Client not connected (state=${this.lastState || 'unknown'})`);

    const phone = normalizePhoneForWhatsApp(input.phone);
    if (!phone) {
      throw new Error(`Invalid WhatsApp phone: ${String(input.phone || '')}`);
    }

    const started = Date.now();
    const sock = this.sock as any;
    const displayName = appendCompanyToDisplayName(
      displayNameOrPhone(input.displayName, phone.phoneE164),
      input.company
    );

    const contactResults = await sock.onWhatsApp(phone.rawJid);
    const contact = Array.isArray(contactResults) ? contactResults[0] : undefined;
    if (!contact || contact.exists === false) {
      return {
        phoneE164: phone.phoneE164,
        waJid: phone.waJid,
        rawJid: phone.rawJid,
        existsOnWhatsApp: false,
        contactSeeded: false,
        status: 'not_on_whatsapp',
        tokenStatus: 'not_on_whatsapp',
        elapsedMs: Date.now() - started,
        actionable: actionableForFailure('invalid_recipient', false),
      };
    }

    await sock.addOrEditContact(phone.rawJid, {
      fullName: displayName,
      firstName: displayName,
      pnJid: phone.rawJid,
      saveOnPrimaryAddressbook: true,
    } satisfies proto.SyncActionValue.IContactAction);
    this.contactNames.set(phone.rawJid, displayName);
    this.contactNames.set(phone.waJid, displayName);

    let tokenStatus: WhatsAppCustomerTokenStatus = 'missing_token';
    let actionable: string | undefined;
    try {
      await this.prepareDirectPrivacyToken(phone.rawJid, phone.waJid, started);
      tokenStatus = (await this.readDirectPrivacyTokenState(phone.rawJid))?.ok
        ? 'has_token'
        : 'missing_token';
    } catch (error) {
      const failureClass = classifyWhatsAppSendFailure(error);
      if (failureClass === 'account_restricted') {
        tokenStatus = 'missing_token';
        actionable = actionableForFailure('account_restricted', false);
      } else if (failureClass === 'invalid_recipient') {
        return {
          phoneE164: phone.phoneE164,
          waJid: phone.waJid,
          rawJid: phone.rawJid,
          existsOnWhatsApp: false,
          contactSeeded: true,
          status: 'not_on_whatsapp',
          tokenStatus: 'not_on_whatsapp',
          elapsedMs: Date.now() - started,
          error: errorMessage(error),
          actionable: actionableForFailure('invalid_recipient', false),
        };
      } else {
        throw error;
      }
    }

    return {
      phoneE164: phone.phoneE164,
      waJid: phone.waJid,
      rawJid: phone.rawJid,
      existsOnWhatsApp: true,
      contactSeeded: true,
      status: tokenStatus === 'has_token' ? 'ready' : 'seeded_missing_token',
      tokenStatus,
      elapsedMs: Date.now() - started,
      actionable,
    };
  }

  async sendFile(
    chatId: string,
    fileUrl: string,
    caption?: string,
    options?: {
      asSticker?: boolean;
      replyToMessageId?: string;
      /** Same contract as sendMessage's messageId / beforeSend. */
      messageId?: string;
      beforeSend?: () => Promise<void>;
    }
  ): Promise<string | undefined> {
    if (!this.sock) throw new Error('Client not initialized');
    const raw = this.toRawJid(chatId);
    // A media reply whose quoted message is unknown is rejected (before the
    // file is fetched) instead of going out as an unrelated, unquoted media.
    const quoted = await this.buildQuotedFromId(options?.replyToMessageId, raw);
    if (options?.replyToMessageId && !quoted) {
      throw new MessageUnavailableError(
        `Quoted message ${options.replyToMessageId} is unavailable (not in memory nor in the durable store); send the media without replyTo`,
        422,
        'quoted_message_unavailable'
      );
    }
    let buf: Buffer;
    let contentType = '';
    try {
      const res = await fetch(fileUrl);
      if (!res.ok) throw new Error(`Failed to fetch file from ${fileUrl}: ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
      contentType = res.headers.get('content-type') || '';
    } catch (e: any) {
      throw new Error(`Failed to fetch file from ${fileUrl}: ${e?.message || e}`);
    }
    const fileName = fileUrl.split('/').pop() || 'attachment';

    let payload: AnyMessageContent;
    // Stickers: WhatsApp expects webp; baileys handles conversion when the
    // payload is `{ sticker: buf }` and the bytes are a static webp/animated.
    if (options?.asSticker || contentType === 'image/webp') {
      payload = { sticker: buf };
    } else if (contentType.startsWith('image/')) payload = { image: buf, caption };
    else if (contentType.startsWith('video/')) payload = { video: buf, caption };
    else if (contentType.startsWith('audio/'))
      payload = { audio: buf, mimetype: contentType, ptt: false };
    else
      payload = {
        document: buf,
        fileName,
        mimetype: contentType || 'application/octet-stream',
        caption,
      };

    await options?.beforeSend?.();
    const sendOptions =
      quoted || options?.messageId
        ? {
            ...(quoted ? { quoted } : {}),
            ...(options?.messageId ? { messageId: options.messageId } : {}),
          }
        : undefined;
    const sent = await this.sock.sendMessage(raw, payload, sendOptions);
    if (sent?.key?.id) {
      this.rememberKey(sent.key.id, sent.key, raw);
      this.rememberMessageForRetry(sent.key, sent.message);
      await this.persistDurablePayload(sent, this.normalizeJid(sent.key.remoteJid || raw), 'sent');
    }
    return sent?.key?.id || undefined;
  }

  /** Send an Ogg/Opus clip as a WhatsApp voice note (PTT). */
  async sendVoice(
    chatId: string,
    audio: Buffer,
    mimetype = 'audio/ogg; codecs=opus',
    /** Same contract as sendMessage's messageId / beforeSend. */
    options?: { messageId?: string; beforeSend?: () => Promise<void> }
  ): Promise<string | undefined> {
    if (!this.sock) throw new Error('Client not initialized');
    if (!this.isConnected())
      throw new Error(`Client not connected (state=${this.lastState || 'unknown'})`);
    const raw = this.toRawJid(chatId);
    const payload: AnyMessageContent = { audio, mimetype, ptt: true };
    await options?.beforeSend?.();
    const sent = options?.messageId
      ? await this.sock.sendMessage(raw, payload, { messageId: options.messageId })
      : await this.sock.sendMessage(raw, payload);
    const messageId = sent?.key?.id;
    if (sent?.key) {
      this.rememberKey(messageId || '', sent.key, raw);
      this.rememberMessageForRetry(sent.key, sent.message);
      await this.persistDurablePayload(sent, this.normalizeJid(sent.key.remoteJid || raw), 'sent');
    }
    return messageId || undefined;
  }

  /**
   * React to a message ('' removes our reaction). The key comes from memory,
   * the durable payload, whatsapp_message_keys or the messages row (so it
   * survives restarts); an unknown message is a 404 message_unavailable, never
   * a silent success. The reaction is recorded (ingest only) once WhatsApp has
   * it; its echo later lands on the same row.
   */
  async reactToMessage(
    chatId: string,
    messageId: string,
    emoji: string
  ): Promise<{ messageId: string; reactionId?: string; emoji: string; reactedAt: string }> {
    const sock = this.connectedSocket();
    const text = typeof emoji === 'string' ? emoji.trim() : '';
    const target = await this.resolveMutationTarget(chatId, messageId, 'reactToMessage');
    const sent = await sock.sendMessage(target.chatJid, { react: { text, key: target.key } });
    const reactedAt = reactionTime(sent?.message?.reactionMessage?.senderTimestampMs) || new Date();
    if (this.ingest && this.meJid) {
      await storeMessageReaction({
        targetMessageId: target.id,
        conversationId: this.normalizeJid(target.chatJid),
        reactorJid: this.normalizeJid(this.meJid),
        emoji: text,
        fromMe: true,
        reactionMessageId: sent?.key?.id || undefined,
        reactedAt,
      });
    }
    this.logger.info(`Reacted with ${text || '(removed)'} to ${target.id}`);
    return {
      messageId: target.id,
      reactionId: sent?.key?.id || undefined,
      emoji: text,
      reactedAt: reactedAt.toISOString(),
    };
  }

  /**
   * Real WhatsApp forward: `sendMessage(to, { forward: original })` with the
   * original WAMessage from memory or the durable store. The source is found
   * by its (account-scoped) message id; `chatId` only names it in errors.
   * Returns the id of the new message.
   */
  async forwardMessage(
    chatId: string,
    messageId: string,
    toChatId: string
  ): Promise<string | undefined> {
    if (!this.sock) throw new Error('Client not initialized');
    if (!this.isConnected())
      throw new Error(`Client not connected (state=${this.lastState || 'unknown'})`);
    const id = stripAccountKey(messageId);
    const original = this.memoryMessage(id) || (await this.durableMessage(id));
    if (!original?.message) {
      throw new MessageUnavailableError(
        `forwardMessage: message ${id} of ${chatId} is unavailable (not in memory nor in the durable store)`,
        404,
        'message_unavailable'
      );
    }
    const rawTarget = this.toRawJid(toChatId);
    const sent = await this.sock.sendMessage(rawTarget, { forward: original });
    const sentId = sent?.key?.id;
    if (sent?.key) {
      this.rememberKey(sentId || '', sent.key, rawTarget);
      this.rememberMessageForRetry(sent.key, sent.message);
      await this.persistDurablePayload(
        sent,
        this.normalizeJid(sent.key.remoteJid || rawTarget),
        'sent'
      );
    }
    this.logger.info(`Forwarded ${id} to ${rawTarget}${sentId ? ` id=${sentId}` : ''}`);
    return sentId || undefined;
  }

  // ---------------------------------------------------------------------------
  // Edit / delete (fase 3 / PR-3). Persistence: message-mutations.ts.
  // ---------------------------------------------------------------------------

  /**
   * Edit one of our own text messages. WhatsApp's time window is WhatsApp's:
   * an edit it refuses comes back as a MessageMutationError
   * (`rejected_by_whatsapp`) and nothing is written.
   */
  async editMessage(
    chatId: string,
    messageId: string,
    content: string,
    request: MessageMutationRequest = {}
  ): Promise<{ messageId: string; editId?: string; editedAt: string }> {
    const sock = this.connectedSocket();
    if (typeof content !== 'string' || !content.trim()) {
      throw new MessageMutationError('editMessage: content is required', 400, 'invalid_request');
    }
    const target = await this.resolveMutationTarget(chatId, messageId, 'editMessage');
    if (!target.key.fromMe) {
      throw new MessageMutationError(
        `editMessage: ${target.id} was not sent by this account; WhatsApp only lets the author edit`,
        422,
        'not_own_message'
      );
    }
    if (target.stored?.isDeleted) {
      throw new MessageMutationError(`editMessage: ${target.id} was deleted`, 422, 'not_editable');
    }
    if (target.isText !== true) {
      throw new MessageMutationError(
        `editMessage: ${target.id} is not a text message (only text can be edited here)`,
        422,
        'not_editable'
      );
    }
    return this.withOwnMutation('edit', target.id, async () => {
      const sent = await sock.sendMessage(target.chatJid, { text: content, edit: target.key });
      await this.throwIfMutationRejected(sent?.key?.id, 'edit', target.id);
      const editedAt = new Date();
      if (this.ingest) {
        await this.persistMutation('edit', target.id, () =>
          markMessageEdited(target.id, content, {
            source: 'connector',
            actor: request.actor,
            at: editedAt,
          })
        );
      }
      this.emit('message-update', {
        waMessageId: target.id,
        updateType: 'EDITED',
        newContent: content,
      });
      this.logger.info(`Edited ${target.id} in ${target.chatJid}`);
      return {
        messageId: target.id,
        editId: sent?.key?.id || undefined,
        editedAt: editedAt.toISOString(),
      };
    });
  }

  /**
   * Delete for everyone (revoke). Our own messages, or someone else's in a
   * group (WhatsApp checks we are admin). The row keeps its content.
   */
  async deleteMessage(
    chatId: string,
    messageId: string,
    request: MessageMutationRequest = {}
  ): Promise<{ messageId: string; deletedAt: string }> {
    const sock = this.connectedSocket();
    const target = await this.resolveMutationTarget(chatId, messageId, 'deleteMessage');
    if (!target.key.fromMe && !isJidGroup(target.chatJid)) {
      throw new MessageMutationError(
        `deleteMessage: ${target.id} was not sent by this account; only the author can delete it for everyone`,
        422,
        'not_own_message'
      );
    }
    return this.withOwnMutation('revoke', target.id, async () => {
      const sent = await sock.sendMessage(target.chatJid, { delete: target.key });
      await this.throwIfMutationRejected(sent?.key?.id, 'delete', target.id);
      const deletedAt = new Date();
      if (this.ingest) {
        await this.persistMutation('delete', target.id, () =>
          markMessageRevoked(target.id, {
            source: 'connector',
            actor: request.actor,
            at: deletedAt,
          })
        );
      }
      this.emit('message-update', { waMessageId: target.id, updateType: 'DELETED' });
      this.logger.info(`Deleted ${target.id} for everyone in ${target.chatJid}`);
      return { messageId: target.id, deletedAt: deletedAt.toISOString() };
    });
  }

  /**
   * Delete for me: an app-state patch keyed by the message key AND its
   * timestamp, both rebuilt from the durable copies after a restart. Media on
   * the phone is left alone (deleteMedia: false). Local to this account: no
   * MessageUpdated event (see MessageUpdatedEvent).
   */
  async deleteMessageForMe(
    chatId: string,
    messageId: string,
    request: MessageMutationRequest = {}
  ): Promise<{ messageId: string; deletedAt: string }> {
    const sock = this.connectedSocket();
    const target = await this.resolveMutationTarget(chatId, messageId, 'deleteMessageForMe');
    if (!target.timestampSeconds) {
      throw new MessageUnavailableError(
        `deleteMessageForMe: the timestamp of ${target.id} is unknown (WhatsApp needs it)`,
        404,
        'message_unavailable'
      );
    }
    return this.withOwnMutation('forme', target.id, async () => {
      await sock.chatModify(
        {
          deleteForMe: {
            deleteMedia: false,
            key: target.key,
            timestamp: target.timestampSeconds!,
          },
        },
        target.chatJid
      );
      const deletedAt = new Date();
      if (this.ingest) {
        await this.persistMutation('delete-for-me', target.id, () =>
          markMessageDeletedForMe(target.id, {
            source: 'connector',
            actor: request.actor,
            at: deletedAt,
          })
        );
      }
      this.logger.info(`Deleted ${target.id} for me in ${target.chatJid}`);
      return { messageId: target.id, deletedAt: deletedAt.toISOString() };
    });
  }

  // ---------------------------------------------------------------------------
  // Chat state (fase 3 / PR-5). Persistence: chat-state.ts.
  // ---------------------------------------------------------------------------

  /**
   * Archive / pin / mute / read-unread a chat as the phone does (an app-state
   * patch). `chatId` is resolved to the canonical conversation (tombstones
   * and contact aliases followed); the patch goes to the jid of its newest
   * message's key — memory, whatsapp_message_payloads, whatsapp_message_keys
   * or the messages row, so it survives restarts — which is also the
   * `lastMessages` entry archive and read need. The result is written on the
   * canonical row once WhatsApp accepted it (ingest only); the echo that
   * chats.update brings back carries the same values.
   */
  async modifyChat(
    chatId: string,
    action: ChatModifyAction,
    request: ChatModifyRequest = {}
  ): Promise<ChatModifyResult> {
    const sock = this.connectedSocket();
    const requested = stripAccountKey(String(chatId || '').trim());
    if (!requested) {
      throw new MessageMutationError(
        'modifyChat: conversationId is required',
        400,
        'invalid_request'
      );
    }
    const conversation = this.ingest ? await resolveCanonicalConversation(requested) : undefined;
    if (this.ingest && !conversation) {
      throw new MessageMutationError(
        `modifyChat: conversation ${requested} is unavailable (unknown to this account)`,
        404,
        'conversation_unavailable'
      );
    }
    const externalId = conversation?.externalId || this.normalizeJid(this.toRawJid(requested));
    const last = conversation
      ? await this.newestMessageTarget(conversation.id, externalId)
      : undefined;
    const chatJid = last?.chatJid || this.toRawJid(externalId);
    const lastMessages =
      last && last.timestampSeconds
        ? [{ key: last.key, messageTimestamp: last.timestampSeconds }]
        : [];

    // markRead: read receipts for what is pending (the /messages/read path),
    // then the app-state mark, which is what clears a "marked unread" dot.
    // Without a known newest message the receipts are all there is to do.
    const receipts = action === 'markRead' && this.ingest;
    if (receipts) await this.markAsRead(externalId);
    if (!receipts || lastMessages.length) {
      const modification = buildChatModification(action, { lastMessages, mute: request.mute });
      await this.applyChatModification(sock, modification, chatJid, action);
    }

    const chat = this.chatStore.get(this.normalizeJid(chatJid));
    if (chat && action === 'markRead') chat.unreadCount = 0;
    if (chat && action === 'markUnread') chat.unreadCount = Math.max(chat.unreadCount, 1);

    let state: ChatState | undefined;
    if (this.ingest && conversation) {
      const patch = chatStatePatchFor(action, request.mute);
      try {
        state = await writeChatState(conversation.id, patch);
      } catch (e: any) {
        throw new Error(
          `${action} of ${conversation.id} reached WhatsApp but was not saved: ${e?.message || e}`
        );
      }
    }
    this.logger.info(
      `Chat ${action} ${chatJid}${request.actor ? ` by ${request.actor}` : ''}${state ? '' : ' (not recorded)'}`
    );
    return {
      action,
      chatId: this.normalizeJid(chatJid),
      conversationId: conversation?.id ?? null,
      persisted: !!state,
      state: state ?? null,
    };
  }

  /** Key + timestamp of the newest message of a conversation (undefined if none is usable). */
  private async newestMessageTarget(
    conversationId: string,
    externalId: string
  ): Promise<MutationTarget | undefined> {
    const id = await latestMessageId(conversationId);
    if (!id) return undefined;
    let target: MutationTarget;
    try {
      target = await this.resolveMutationTarget(externalId, id, 'modifyChat');
    } catch (e) {
      if (e instanceof MessageUnavailableError) return undefined;
      throw e;
    }
    // Baileys refuses a group message of someone else without its participant.
    if (isJidGroup(target.chatJid) && !target.key.fromMe && !target.key.participant) {
      return undefined;
    }
    return target;
  }

  /** chatModify, with WhatsApp's own refusals as 422 rejected_by_whatsapp. */
  private async applyChatModification(
    sock: WASocket,
    modification: ChatModification,
    chatJid: string,
    action: ChatModifyAction
  ): Promise<void> {
    try {
      await sock.chatModify(modification, chatJid);
    } catch (e: any) {
      const status = Number(e?.output?.statusCode ?? e?.data?.statusCode);
      const connectionStatus = [401, 408, 428, 440].includes(status);
      if (e?.isBoom && status >= 400 && status < 500 && !connectionStatus) {
        throw new MessageMutationError(
          `WhatsApp rejected ${action} of ${chatJid}: ${e?.message || e}`,
          422,
          'rejected_by_whatsapp',
          String(status)
        );
      }
      throw e;
    }
  }

  private connectedSocket(): WASocket {
    if (!this.sock) throw new Error('Client not initialized');
    if (!this.isConnected())
      throw new Error(`Client not connected (state=${this.lastState || 'unknown'})`);
    return this.sock;
  }

  /**
   * The real WhatsApp key of a message we have seen (bare or namespaced id):
   * memory, then the durable payload (PR-1), then whatsapp_message_keys, then
   * the messages row — so it survives restarts. The chat comes from the key,
   * not from the request: a merged conversation keeps the jid WhatsApp used.
   * A pairing-only socket (ingest off) only has its memory. Unknown → 404.
   */
  private async resolveMutationTarget(
    chatId: string,
    messageId: string,
    action: string
  ): Promise<MutationTarget> {
    const id = stripAccountKey(String(messageId || '').trim());
    if (!id)
      throw new MessageMutationError(`${action}: messageId is required`, 400, 'invalid_request');
    const cached = this.keyCache.get(id);
    const memory = this.memoryMessage(id);
    const stored = this.ingest ? await loadStoredMessage(id) : undefined;
    const durable = memory ? undefined : await this.durableMessage(id);
    const fallbackJid = chatId ? this.toRawJid(stripAccountKey(chatId)) : '';

    let key: WAMessageKey | undefined = cached?.key || durable?.key;
    if (!key && stored?.key) {
      key = {
        remoteJid: stored.key.remoteJid,
        fromMe: stored.key.fromMe,
        participant: stored.key.participant,
      };
    }
    if (!key && stored) {
      const remoteJid =
        (stored.conversationId && this.toRawJid(stripAccountKey(stored.conversationId))) ||
        fallbackJid;
      key = {
        remoteJid,
        fromMe: stored.direction === 'OUTBOUND',
        participant:
          isJidGroup(remoteJid) && stored.senderWaId
            ? this.toRawJid(stripAccountKey(stored.senderWaId))
            : undefined,
      };
    }
    const chatJid = key?.remoteJid || cached?.chatJid || fallbackJid;
    if (!key || !chatJid) {
      throw new MessageUnavailableError(
        `${action}: message ${id} of ${chatId || 'an unknown chat'} is unavailable (not in memory nor in the database)`,
        404,
        'message_unavailable'
      );
    }

    const content = (memory || durable)?.message;
    let isText: boolean | undefined;
    if (stored) isText = stored.messageType === 'TEXT';
    else if (content) isText = !!(content.conversation || content.extendedTextMessage);

    return {
      id,
      key: { ...key, id, remoteJid: key.remoteJid || chatJid },
      chatJid,
      timestampSeconds:
        unixSeconds(durable?.messageTimestamp) ||
        stored?.key?.timestampSeconds ||
        stored?.waTimestampSeconds,
      isText,
      stored,
    };
  }

  /**
   * Keep the echo of our own mutation away from the inbound handlers while it
   * is in flight and for OWN_MUTATION_ECHO_MS after (Baileys may flush it late).
   */
  private async withOwnMutation<T>(
    kind: 'edit' | 'revoke' | 'forme',
    id: string,
    run: () => Promise<T>
  ): Promise<T> {
    const flag = `${kind}:${id}`;
    const previous = this.ownMutations.get(flag);
    if (previous) clearTimeout(previous);
    this.ownMutations.set(flag, null);
    try {
      return await run();
    } finally {
      const timer = setTimeout(() => this.ownMutations.delete(flag), OWN_MUTATION_ECHO_MS);
      timer.unref?.();
      this.ownMutations.set(flag, timer);
    }
  }

  private isOwnMutation(kind: 'edit' | 'revoke' | 'forme', id: string): boolean {
    return this.ownMutations.has(`${kind}:${id}`);
  }

  /** WhatsApp answered the edit/revoke stanza with an error ack (time window, not allowed…). */
  private async throwIfMutationRejected(
    stanzaId: string | null | undefined,
    what: 'edit' | 'delete',
    id: string
  ): Promise<void> {
    const failure = stanzaId ? await this.waitForImmediateSendFailure(stanzaId) : undefined;
    if (!failure) return;
    throw new MessageMutationError(
      `WhatsApp rejected the ${what} of ${id}${failure.code ? ` (ack error ${failure.code})` : ''}`,
      422,
      'rejected_by_whatsapp',
      failure.code
    );
  }

  /** WhatsApp already has it: a DB failure is reported as such, never as a send failure. */
  private async persistMutation(
    what: string,
    id: string,
    write: () => Promise<boolean>
  ): Promise<void> {
    try {
      await write();
    } catch (e: any) {
      throw new Error(`${what} of ${id} reached WhatsApp but was not saved: ${e?.message || e}`);
    }
  }

  /**
   * messages.update: a revoke or an edit made by a contact or on our phone.
   * The echo of our own mutation is skipped — the explicit call persists it
   * once WhatsApp accepted it.
   */
  private async handleInboundMutation(u: WAMessageUpdate): Promise<void> {
    const waMessageId = u.key?.id;
    if (!this.ingest || !waMessageId) return;
    const stub = u.update?.messageStubType;
    const isRevoke = stub === proto.WebMessageInfo.StubType.REVOKE || u.update?.message === null;
    if (isRevoke && !this.isOwnMutation('revoke', waMessageId)) {
      await this.recordInboundRevoke(waMessageId);
    }
    // Baileys unwraps MESSAGE_EDIT protocol messages into this shape.
    const editedPayload = (u.update as any)?.message?.editedMessage?.message as
      proto.IMessage | undefined;
    if (editedPayload && !this.isOwnMutation('edit', waMessageId)) {
      await this.recordInboundEdit(u.key, editedPayload);
    }
  }

  /** messages.delete with keys = "delete for me" synced from our phone. */
  private async handleDeleteForMeSync(
    item: { keys: WAMessageKey[] } | { jid: string; all: true }
  ): Promise<void> {
    if (!this.ingest || !('keys' in item)) return;
    for (const key of item.keys || []) {
      if (!key?.id || this.isOwnMutation('forme', key.id)) continue;
      await markMessageDeletedForMe(key.id, { source: 'whatsapp' }).catch(e =>
        this.logger.warn(`delete-for-me persist failed for ${key.id}: ${e?.message || e}`)
      );
    }
  }

  /** A contact (or our phone) revoked a message: flag the row, keep its content. */
  private async recordInboundRevoke(waMessageId: string): Promise<void> {
    await markMessageRevoked(waMessageId, { source: 'whatsapp' }).catch(e =>
      this.logger.warn(`revoke persist failed for ${waMessageId}: ${e?.message || e}`)
    );
    this.emit('message-update', { waMessageId, updateType: 'DELETED' });
  }

  /** A contact (or our phone) edited a message: new text, the old one to edit_history. */
  private async recordInboundEdit(key: WAMessageKey, editedPayload: proto.IMessage): Promise<void> {
    const waMessageId = key.id || '';
    const edited = this.convertMessage({ key, message: editedPayload } as WAMessage);
    const content = edited?.content;
    if (!waMessageId || typeof content !== 'string') {
      this.logger.warn(`edit of ${waMessageId} carries no text; row left as is`);
      return;
    }
    let changed: boolean;
    try {
      changed = await markMessageEdited(waMessageId, content, { source: 'whatsapp' });
    } catch (e: any) {
      this.logger.warn(`edit persist failed for ${waMessageId}: ${e?.message || e}`);
      return;
    }
    // A replay (history re-delivery, a late echo) changes nothing and is not re-published.
    if (changed) {
      this.emit('message-update', { waMessageId, updateType: 'EDITED', newContent: content });
    }
  }

  async markAsRead(chatId: string): Promise<void> {
    if (!this.sock) throw new Error('Client not initialized');
    const raw = this.toRawJid(chatId);
    // Read receipts for every unread inbound message of the chat (bounded by
    // the read watermark, see getUnreadMessageKeysForChat), so each sender
    // sees their message read — not only the author of the latest one.
    const unread = await getUnreadMessageKeysForChat(chatId);
    if (unread.length) {
      await this.sock.readMessages(
        unread.map(k => ({
          id: k.id,
          remoteJid: k.remoteJid,
          fromMe: k.fromMe,
          participant: k.participant,
        }))
      );
      await markMessagesRead(unread.map(k => k.id)).catch(e =>
        this.logger.warn(`markAsRead: read status persist failed: ${e?.message || e}`)
      );
    } else {
      // Nothing pending: read the latest known key for that chat, as before.
      const pool = getPool();
      // messages.conversation_id is stored namespaced (see accountKey); the caller
      // hands us a bare chatId, so namespace it or professional reads zero rows.
      const r = await pool.query(
        `SELECT wa_message_id FROM messages WHERE conversation_id = $1 ORDER BY wa_timestamp DESC LIMIT 1`,
        [accountKey(chatId)]
      );
      const stored = r.rows[0]?.wa_message_id as string | undefined;
      if (!stored) return;
      // wa_message_id is stored namespaced; the keyCache and the WhatsApp message
      // key both speak the BARE id, so strip the prefix back off before use.
      const lastId = stripAccountKey(stored);
      const cached = this.keyCache.get(lastId);
      const key = cached?.key ||
        (await this.reconstructKeyFromDb(lastId, chatId)) || {
          remoteJid: raw,
          id: lastId,
          fromMe: false,
        };
      await this.sock.readMessages([key]);
    }
    const norm = this.normalizeJid(raw);
    const chat = this.chatStore.get(norm);
    if (chat) chat.unreadCount = 0;
    await setConversationState(norm, 0);
  }

  // ---------------------------------------------------------------------------
  // Chat / metadata
  // ---------------------------------------------------------------------------

  async getChats(): Promise<any[]> {
    // Mirror the wwebjs Chat[] shape just enough for the existing callers.
    return Array.from(this.chatStore.values()).map(c => ({
      id: { _serialized: c.id },
      name: c.name,
      isGroup: c.isGroup,
      unreadCount: c.unreadCount,
      timestamp: c.timestamp,
    }));
  }

  async getMe(): Promise<any> {
    if (!this.sock || !this.sock.user) throw new Error('Client not initialized');
    const id = this.normalizeJid(this.sock.user.id || '');
    return {
      id,
      name: this.sock.user.name || null,
      phone: this.phoneFromJid(this.sock.user.id || ''),
      platform: 'whatsapp',
    };
  }

  async getGroupInfo(groupId: string): Promise<any> {
    const raw = this.toRawJid(groupId);
    const meta = await this.fetchGroupMetadata(raw);
    return {
      id: this.normalizeJid(meta.id),
      name: meta.subject,
      description: meta.desc || '',
      participantCount: meta.participants.length,
      createdAt: meta.creation,
    };
  }

  async getGroupParticipants(groupId: string): Promise<any[]> {
    const raw = this.toRawJid(groupId);
    const meta = await this.fetchGroupMetadata(raw);
    return meta.participants.map(p => ({
      id: this.normalizeJid(p.id),
      isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
      isSuperAdmin: p.admin === 'superadmin',
    }));
  }

  // ---------------------------------------------------------------------------
  // Group management (fase 3 / PR-6; the helpers live in group-management.ts)
  // ---------------------------------------------------------------------------

  /** Our own ids (PN and LID), to find this account among a group's participants. */
  private async ownIds(): Promise<string[]> {
    const user = this.sock?.user as { id?: string; lid?: string } | undefined;
    const pn = user?.id ? jidNormalizedUser(user.id) : null;
    let lid = user?.lid ? jidNormalizedUser(user.lid) : null;
    if (!lid && pn) {
      lid = await Promise.resolve(this.sock?.signalRepository?.lidMapping?.getLIDForPN?.(pn))
        .then(found => (found ? jidNormalizedUser(found) : null))
        .catch(() => null);
    }
    return [pn, lid].filter((id): id is string => !!id);
  }

  /** The other id (PN ↔ LID) Baileys knows for a user jid, if any. */
  private async jidAliases(jid: string): Promise<string[]> {
    const mapping = this.sock?.signalRepository?.lidMapping;
    const other = await Promise.resolve(
      jid.endsWith('@lid') ? mapping?.getPNForLID?.(jid) : mapping?.getLIDForPN?.(jid)
    ).catch(() => null);
    return [jid, other ? jidNormalizedUser(other) : null].filter((id): id is string => !!id);
  }

  /**
   * A group call to WhatsApp. Its refusals come back as Boom with the IQ
   * error code: 403 → 403 not_group_admin (WhatsApp says we may not), 404 →
   * 404 group_unavailable, other 4xx → 422 rejected_by_whatsapp; connection
   * statuses (401, 408, 428, 440) and the rest go on as send failures.
   */
  private async groupCall<T>(what: string, raw: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (e: any) {
      const status = Number(e?.output?.statusCode ?? e?.data?.statusCode);
      const connectionStatus = [401, 408, 428, 440].includes(status);
      if (!e?.isBoom || !(status >= 400 && status < 500) || connectionStatus) throw e;
      const reason = `WhatsApp rejected ${what} of ${raw}: ${e?.message || e}`;
      if (status === 403) {
        throw new GroupActionError(reason, 403, 'not_group_admin', { code: '403' });
      }
      if (status === 404) {
        throw new GroupActionError(reason, 404, 'group_unavailable', { code: '404' });
      }
      throw new GroupActionError(reason, 422, 'rejected_by_whatsapp', { code: String(status) });
    }
  }

  /**
   * Fresh metadata of a group we are about to act on (the cache may predate
   * an admin change). 403 from WhatsApp here = we are not in the group.
   */
  private async groupMetadataForAction(raw: string): Promise<GroupMetadata> {
    try {
      return await this.groupCall('reading the group', raw, () =>
        this.fetchGroupMetadata(raw, true)
      );
    } catch (e) {
      if (e instanceof GroupActionError && e.failureClass === 'not_group_admin') {
        throw new GroupActionError(
          `This account is not a participant of ${raw}`,
          403,
          'not_group_member',
          { code: e.code }
        );
      }
      throw e;
    }
  }

  private groupView(meta: GroupMetadata, ownIds: string[]): GroupStateView {
    const view = groupStateView(meta, ownParticipant(meta, ownIds), p => {
      for (const id of [p.id, p.phoneNumber, p.lid]) {
        const name = id ? this.contactNames.get(id) : undefined;
        if (name) return name;
      }
      return null;
    });
    return { ...view, groupId: this.normalizeJid(view.groupId) };
  }

  /**
   * Metadata + what this account may do there (POST /groups/state): our
   * participant row (PN or LID) decides — admin, superadmin, or a member of a
   * group that lets members edit info / add people.
   */
  async getGroupState(groupId: string): Promise<GroupStateView> {
    const raw = parseGroupJid(groupId);
    this.connectedSocket();
    const meta = await this.groupMetadataForAction(raw);
    return this.groupView(meta, await this.ownIds());
  }

  /**
   * Create a group with `subject` and `participants` (phone numbers or PN /
   * LID jids). WhatsApp answers with the group's metadata; Baileys drops the
   * per-participant errors of the create answer, so each requested person is
   * reported as added when they are in that metadata and `not_added`
   * otherwise (typically their privacy settings: they need an invite). The
   * conversation row is written here (ingest only) — the same upsert as the
   * groups.upsert notification, which may or may not reach its creator.
   */
  async createGroup(
    subject: unknown,
    participants: unknown,
    request: MessageMutationRequest = {}
  ): Promise<GroupCreateResult> {
    const cleanSubject = parseGroupSubject(subject);
    const members = parseGroupParticipants(participants);
    const sock = this.connectedSocket();
    const own = await this.ownIds();
    if (members.some(m => own.includes(m.jid))) {
      throw new GroupActionError(
        'Do not list this account among the participants: the creator is always in the group',
        422,
        'self_participant'
      );
    }
    const meta = await this.groupCall('the group creation', '@g.us', () =>
      sock.groupCreate(
        cleanSubject,
        members.map(m => m.jid)
      )
    );
    this.cacheGroupMetadata(meta);
    const results: GroupParticipantResult[] = [];
    for (const member of members) {
      let found = findParticipant(meta, member.jid);
      if (!found) {
        for (const alias of await this.jidAliases(member.jid)) {
          found = findParticipant(meta, alias);
          if (found) break;
        }
      }
      results.push({
        participant: member.input,
        jid: participantApiJid(member.jid),
        status: null,
        ok: !!found,
        reason: found ? 'added' : 'not_added',
      });
    }
    let conversationId: string | null = null;
    if (this.ingest) {
      conversationId =
        (await recordGroupConversation(meta).catch((e: any) => {
          this.logger.warn(`group ${meta.id} created but not recorded: ${e?.message || e}`);
          return undefined;
        })) ?? null;
    }
    const counts = countResults(results);
    this.logger.info(
      `Group created ${meta.id} participants=${members.length} added=${counts.succeeded}${request.actor ? ` by ${request.actor}` : ''}`
    );
    return {
      groupId: this.normalizeJid(meta.id),
      conversationId,
      subject: meta.subject || cleanSubject,
      persisted: !!conversationId,
      participants: results,
      ...counts,
      group: this.groupView(meta, own),
    };
  }

  /**
   * Subject, description and settings of a group. Checked against fresh
   * metadata first: a member of the group; subject / description need admin
   * unless the group is not `restrict`ed; settings always need admin. What
   * already has the asked value is not sent (each change notifies every
   * member). A failure after an earlier change went out says what was
   * applied. A new subject is written on the canonical conversation.
   */
  async updateGroup(
    groupId: string,
    update: GroupUpdate | Record<string, unknown>,
    request: MessageMutationRequest = {}
  ): Promise<GroupUpdateResult> {
    const raw = parseGroupJid(groupId);
    const wanted = parseGroupUpdate(update as Record<string, unknown>);
    const sock = this.connectedSocket();
    const meta = await this.groupMetadataForAction(raw);
    const own = await this.ownIds();
    const capabilities = this.checkGroupAccess(meta, own, raw);
    const editsInfo = wanted.subject !== undefined || wanted.description !== undefined;
    if (editsInfo && !capabilities.editInfo) {
      throw new GroupActionError(
        `Only admins can change the subject or description of ${raw}`,
        403,
        'not_group_admin'
      );
    }
    if (wanted.settings && !capabilities.changeSettings) {
      throw new GroupActionError(
        `Only admins can change the settings of ${raw}`,
        403,
        'not_group_admin'
      );
    }

    const steps: Array<{ name: string; run: () => Promise<void> }> = [];
    const unchanged: string[] = [];
    const plan = (name: string, same: boolean, run: () => Promise<void>): void => {
      if (same) unchanged.push(name);
      else steps.push({ name, run });
    };
    if (wanted.subject !== undefined) {
      const subject = wanted.subject;
      plan('subject', subject === meta.subject, () => sock.groupUpdateSubject(raw, subject));
    }
    if (wanted.description !== undefined) {
      const description = wanted.description;
      plan('description', description === (meta.desc || '').trim(), () =>
        sock.groupUpdateDescription(raw, description || undefined)
      );
    }
    const { announce, restrict } = wanted.settings || {};
    if (announce !== undefined) {
      plan('announce', announce === (meta.announce === true), () =>
        sock.groupSettingUpdate(raw, announce ? 'announcement' : 'not_announcement')
      );
    }
    if (restrict !== undefined) {
      plan('restrict', restrict === (meta.restrict === true), () =>
        sock.groupSettingUpdate(raw, restrict ? 'locked' : 'unlocked')
      );
    }

    const applied: string[] = [];
    for (const step of steps) {
      try {
        await this.groupCall(`the ${step.name} change`, raw, step.run);
        applied.push(step.name);
      } catch (e: any) {
        if (!applied.length) throw e;
        this.groupMetaCache.delete(raw);
        const details = { applied, failed: step.name };
        const message = `${e?.message || e} (already applied: ${applied.join(', ')})`;
        if (e instanceof MessageMutationError) {
          throw new GroupActionError(message, e.status, e.failureClass, { code: e.code, details });
        }
        const failureClass = classifyWhatsAppSendFailure(e);
        throw new GroupActionError(message, statusOfFailureClass(failureClass), failureClass, {
          details,
        });
      }
    }

    let group: GroupStateView | null = null;
    let persisted = false;
    if (applied.length) {
      this.groupMetaCache.delete(raw);
      const refreshed = await this.fetchGroupMetadata(raw, true).catch(() => undefined);
      if (refreshed) group = this.groupView(refreshed, own);
      if (this.ingest && applied.includes('subject')) {
        persisted = await recordGroupChange(raw, { subject: wanted.subject }).catch((e: any) => {
          this.logger.warn(`subject of ${raw} changed but not recorded: ${e?.message || e}`);
          return false;
        });
      }
    } else {
      group = this.groupView(meta, own);
    }
    this.logger.info(
      `Group ${raw} updated changed=${applied.join(',') || '-'}${request.actor ? ` by ${request.actor}` : ''}`
    );
    return { groupId: this.normalizeJid(raw), changed: applied, unchanged, persisted, group };
  }

  /**
   * Add / remove / promote / demote participants (phone numbers or PN / LID
   * jids). Checked against fresh metadata: add needs admin (or member-add
   * mode on), the rest admin. A member is addressed by the jid the group
   * knows them by (a PN given for a LID group goes as its LID). WhatsApp
   * answers per participant; each answer is reported (200 done, 403 invite
   * required, 408 recently left, 409 already in…). Nobody done → 422 with
   * the results; some done → 200 with `partial`.
   */
  async updateGroupParticipants(
    groupId: string,
    action: string,
    participants: unknown,
    request: MessageMutationRequest = {}
  ): Promise<GroupParticipantsResult> {
    const raw = parseGroupJid(groupId);
    const verb = normalizeGroupParticipantAction(action);
    if (!verb) {
      throw new GroupActionError(
        'action must be one of add, remove, promote, demote',
        400,
        'invalid_request'
      );
    }
    const members = parseGroupParticipants(participants);
    const sock = this.connectedSocket();
    const meta = await this.groupMetadataForAction(raw);
    const own = await this.ownIds();
    const capabilities = this.checkGroupAccess(meta, own, raw);
    if (!allowsParticipantAction(capabilities, verb)) {
      throw new GroupActionError(
        verb === 'add'
          ? `Only admins can add participants to ${raw}`
          : `Only admins can ${verb} participants of ${raw}`,
        403,
        'not_group_admin'
      );
    }
    const self = ownParticipant(meta, own);
    const targets: Array<{ input: string; sent: string; aliases: string[] }> = [];
    for (const member of members) {
      const found = findParticipant(meta, member.jid);
      if (own.includes(member.jid) || (found && found === self)) {
        throw new GroupActionError(
          `This account cannot ${verb} itself here`,
          422,
          'self_participant'
        );
      }
      const sent = found ? jidNormalizedUser(found.id) : member.jid;
      if (targets.some(t => t.sent === sent)) continue;
      const aliases = found ? participantIds(found) : await this.jidAliases(member.jid);
      targets.push({ input: member.input, sent, aliases: Array.from(new Set([sent, ...aliases])) });
    }

    const answer = await this.groupCall(`the ${verb} of participants`, raw, () =>
      sock.groupParticipantsUpdate(
        raw,
        targets.map(t => t.sent),
        verb
      )
    );
    this.groupMetaCache.delete(raw);
    const entries = (answer || []).map(entry => ({
      status: entry?.status === undefined || entry?.status === null ? null : String(entry.status),
      jid: entry?.jid ? jidNormalizedUser(entry.jid) : '',
      used: false,
    }));
    const matched = targets.map(target => {
      const entry = entries.find(e => !e.used && !!e.jid && target.aliases.includes(e.jid));
      if (entry) entry.used = true;
      return entry;
    });
    // An answer under an id we did not know (a PN WhatsApp maps to a LID):
    // pair the leftovers in order, as WhatsApp answers in request order.
    const leftovers = entries.filter(e => !e.used);
    const results: GroupParticipantResult[] = targets.map((target, index) => {
      const entry = matched[index] ?? leftovers.shift();
      const status = entry?.status ?? null;
      return {
        participant: target.input,
        jid: participantApiJid(target.sent),
        status,
        ...participantOutcome(verb, status),
      };
    });
    const counts = countResults(results);
    this.logger.info(
      `Group ${raw} ${verb} participants=${targets.length} done=${counts.succeeded}${request.actor ? ` by ${request.actor}` : ''}`
    );
    if (!counts.succeeded) {
      throw new GroupActionError(
        `WhatsApp did not ${verb} any of the ${targets.length} participant(s) of ${raw}`,
        422,
        'rejected_by_whatsapp',
        { details: { action: verb, results, ...counts } }
      );
    }
    const refreshed = await this.fetchGroupMetadata(raw, true).catch(() => undefined);
    let persisted = false;
    if (this.ingest && refreshed) {
      persisted = await recordGroupChange(raw, {
        participantCount: refreshed.participants?.length,
      }).catch((e: any) => {
        this.logger.warn(`participants of ${raw} changed but not recorded: ${e?.message || e}`);
        return false;
      });
    }
    return {
      action: verb,
      groupId: this.normalizeJid(raw),
      results,
      ...counts,
      partial: counts.failed > 0,
      persisted,
      group: refreshed ? this.groupView(refreshed, own) : null,
    };
  }

  /** Member of a non-community group, or 403 / 422; the capabilities otherwise. */
  private checkGroupAccess(meta: GroupMetadata, own: string[], raw: string) {
    if (isCommunityGroup(meta)) {
      throw new GroupActionError(
        `${raw} is a community (or its announcement group): manage it from WhatsApp`,
        422,
        'community_unsupported'
      );
    }
    const capabilities = groupCapabilities(meta, ownParticipant(meta, own));
    if (!capabilities.isMember) {
      throw new GroupActionError(
        `This account is not a participant of ${raw}`,
        403,
        'not_group_member'
      );
    }
    return capabilities;
  }

  /**
   * Idempotent presenceSubscribe: silently no-ops if already subscribed or
   * if the socket is down. baileys auto-renews subscriptions while the
   * socket stays open, so we just need to subscribe once per chat.
   */
  private async presenceSubscribeSilent(rawJid: string | null | undefined): Promise<void> {
    if (!rawJid || !this.sock) return;
    if (this.presenceSubscribed.has(rawJid)) return;
    try {
      await this.sock.presenceSubscribe(rawJid);
      this.presenceSubscribed.add(rawJid);
    } catch {
      // server may reject (rate-limited, unknown chat, etc.) — swallow
    }
  }

  /**
   * Subscribe to presence for the N most-recently-active chats so we get
   * typing updates for them. Called once after connection.update→open. We
   * cap N to avoid spamming the WhatsApp server with hundreds of subscribes.
   */
  private async subscribePresenceForActiveChats(limit: number): Promise<void> {
    const chats = Array.from(this.chatStore.values())
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, limit);
    let n = 0;
    for (const c of chats) {
      if (!c.rawJid) continue;
      await this.presenceSubscribeSilent(c.rawJid);
      n++;
      // Tiny pacing so we don't burst the upstream all at once.
      if (n % 25 === 0) await new Promise(r => setTimeout(r, 50));
    }
    this.logger.info(`Subscribed to presence for ${n} active chats`);
  }

  /**
   * Lazy fetcher: if the conversation has no avatar_url yet, download from
   * WhatsApp and persist into MinIO + DB. Swallows all errors — never blocks.
   */
  private async ensureConversationAvatarIfMissing(
    conversationId: string,
    rawJid: string
  ): Promise<void> {
    try {
      const existing = await getConversationAvatar(conversationId);
      if (existing) return;
      const bytes = await this.getProfilePictureBytes(rawJid);
      if (!bytes) return;
      const key = await uploadAvatar('conversations', conversationId, bytes);
      await setConversationAvatar(conversationId, key);
    } catch (e) {
      // intentionally swallowed — avatar download must not break message ingest
    }
  }

  private async ensureParticipantAvatarIfMissing(
    participantId: string,
    rawJid: string
  ): Promise<void> {
    try {
      const existing = await getParticipantAvatar(participantId);
      if (existing) return;
      const bytes = await this.getProfilePictureBytes(rawJid);
      if (!bytes) return;
      const key = await uploadAvatar('participants', participantId, bytes);
      await setParticipantAvatar(participantId, key);
    } catch (e) {
      // swallow
    }
  }

  /**
   * Fetch a contact/group's profile picture as raw JPEG bytes.
   * Returns null if the JID has no picture or the lookup fails (privacy).
   */
  async getProfilePictureBytes(jid: string): Promise<Buffer | null> {
    if (!this.sock) return null;
    const raw = this.toRawJid(jid);
    let url: string | undefined;
    try {
      url = await this.sock.profilePictureUrl(raw, 'image');
    } catch (e) {
      // 'item-not-found' / 'forbidden' — not all JIDs have pics or are visible
      return null;
    }
    if (!url) return null;
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const ab = await r.arrayBuffer();
      return Buffer.from(ab);
    } catch (e) {
      return null;
    }
  }

  async refreshGroupSession(
    groupId: string,
    options: GroupSessionRefreshOptions = {}
  ): Promise<GroupSessionRefreshResult> {
    if (!this.sock) throw new Error('Client not initialized');
    if (!this.isConnected())
      throw new Error(`Client not connected (state=${this.lastState || 'unknown'})`);

    const raw = this.toRawJid(groupId);
    if (!this.isGroupJid(raw)) throw new Error(`Not a group JID: ${groupId}`);

    const normalized = this.normalizeJid(raw);
    const timeoutMs = parseInt(process.env.WA_GROUP_SESSION_REFRESH_TIMEOUT_MS || '45000', 10);
    const sessionTimeoutMs = parseInt(
      process.env.WA_GROUP_SESSION_ASSERT_TIMEOUT_MS || '12000',
      10
    );
    const batchSize = Math.max(
      1,
      Math.min(parseInt(process.env.WA_GROUP_SESSION_BATCH_SIZE || '25', 10), 100)
    );
    const sessionBatchSize = Math.max(
      1,
      Math.min(parseInt(process.env.WA_GROUP_SESSION_ASSERT_BATCH_SIZE || '1', 10), 25)
    );
    const warmSessions = options.warmSessions !== false;
    const warnings: string[] = [];

    this.logger.info(
      `Refreshing WhatsApp group session reason=${options.reason || 'manual'} rawJid=${raw} normalizedJid=${normalized} warmSessions=${warmSessions} forceSessions=${!!options.forceSessions} clearSenderKeyMemory=${!!options.clearSenderKeyMemory}`
    );

    const meta = await this.race(
      this.fetchGroupMetadata(raw, true),
      timeoutMs,
      `group metadata timeout after ${timeoutMs}ms`
    );
    this.cacheGroupMetadata(meta);

    let senderKeyMemoryCleared = false;
    if (options.clearSenderKeyMemory) {
      await this.sock.authState.keys.set({ 'sender-key-memory': { [raw]: null } });
      senderKeyMemoryCleared = true;
    }

    let deviceCount = 0;
    const skippedSenderKeyJids: string[] = [];
    let sessionFetchAttempted = false;
    if (warmSessions) {
      try {
        const participantJids = Array.from(
          new Set(meta.participants.map(p => p.id).filter(Boolean))
        );
        const devices = [];
        const participantBatches = this.chunk(participantJids, batchSize);
        for (let i = 0; i < participantBatches.length; i += 1) {
          const batch = participantBatches[i];
          const batchDevices = batch.length
            ? await this.race(
                this.sock.getUSyncDevices(batch, false, false),
                timeoutMs,
                `group device sync timeout after ${timeoutMs}ms batch=${i + 1}/${participantBatches.length}`
              )
            : [];
          devices.push(...batchDevices);
        }
        const deviceJids = Array.from(
          new Set(
            devices
              .filter(d => d.user !== undefined && d.user !== null)
              .map(
                d =>
                  (d as any).jid ||
                  jidEncode(d.user, (d as any).server || 's.whatsapp.net', d.device)
              )
          )
        );
        deviceCount = deviceJids.length;
        if (deviceJids.length) {
          sessionFetchAttempted = true;
          const sessionBatches = this.chunk(deviceJids, sessionBatchSize);
          for (let i = 0; i < sessionBatches.length; i += 1) {
            try {
              await this.race(
                this.sock.assertSessions(sessionBatches[i], !!options.forceSessions),
                sessionTimeoutMs,
                `group session refresh timeout after ${sessionTimeoutMs}ms batch=${i + 1}/${sessionBatches.length}`
              );
            } catch (e: any) {
              const warning = `session refresh batch ${i + 1}/${sessionBatches.length} failed for ${sessionBatches[i].join(',')}: ${e?.message || e}`;
              warnings.push(warning);
              if (options.markFailedDevicesAsSenderKeySent) {
                skippedSenderKeyJids.push(...sessionBatches[i]);
                continue;
              }
              if (options.failOnWarmupError) throw e;
            }
          }
        }
      } catch (e: any) {
        const warning = `session warm-up failed: ${e?.message || e}`;
        warnings.push(warning);
        if (options.failOnWarmupError) throw e;
        this.logger.warn(
          `WhatsApp group session warm-up warning rawJid=${raw} normalizedJid=${normalized}: ${warning}`
        );
      }
    }
    if (skippedSenderKeyJids.length) {
      await this.markSenderKeyDevicesAsSent(raw, skippedSenderKeyJids);
      this.logger.warn(
        `WhatsApp group repair marked failed sender-key devices as already sent rawJid=${raw} normalizedJid=${normalized} skippedDevices=${skippedSenderKeyJids.length}`
      );
    }

    const result: GroupSessionRefreshResult = {
      rawJid: raw,
      normalizedJid: normalized,
      groupSubject: meta.subject || raw,
      participantCount: meta.participants.length,
      lidParticipantCount: meta.participants.filter(p => p.id.endsWith('@lid')).length,
      deviceCount,
      skippedSenderKeyDevices: skippedSenderKeyJids.length,
      sessionFetchAttempted,
      forceSessions: !!options.forceSessions,
      senderKeyMemoryCleared,
      warnings,
    };
    this.logger.info(
      `WhatsApp group session refreshed rawJid=${raw} normalizedJid=${normalized} groupSubject="${result.groupSubject}" participants=${result.participantCount} lidParticipants=${result.lidParticipantCount} devices=${deviceCount} skippedSenderKeyDevices=${result.skippedSenderKeyDevices} warnings=${warnings.length}`
    );
    return result;
  }

  async getUnreadChats(): Promise<any[]> {
    return Array.from(this.chatStore.values())
      .filter(c => c.unreadCount > 0)
      .map(c => ({
        id: c.id,
        name: c.name,
        unreadCount: c.unreadCount,
        isGroup: c.isGroup,
        timestamp: c.timestamp,
      }));
  }

  /**
   * Force an app-state resync to pull current unread/archived/pin state from
   * WhatsApp. baileys emits chats.update events for each mutation, which the
   * chats.update handler persists to the DB. Returns once the sync completes.
   */
  async resyncChatState(reason = 'manual'): Promise<{ ok: boolean; error?: string }> {
    if (!this.sock) return { ok: false, error: 'not connected' };
    try {
      this.logger.info(`resyncAppState (${reason})`);
      await (this.sock as any).resyncAppState(
        ['critical_unblock_low', 'regular_high', 'regular_low', 'regular'],
        false
      );
      return { ok: true };
    } catch (e: any) {
      this.logger.warn(`resyncAppState failed: ${e?.message || e}`);
      return { ok: false, error: String(e?.message || e) };
    }
  }

  private async fetchGroupMetadata(rawJid: string, force = false): Promise<GroupMetadata> {
    const cached = this.groupMetaCache.get(rawJid);
    if (cached && !force) return cached;
    if (!this.sock) throw new Error('Client not initialized');
    const meta = await this.sock.groupMetadata(rawJid);
    this.cacheGroupMetadata(meta);
    return meta;
  }

  // ---------------------------------------------------------------------------
  // History endpoints (read-from-BD; live messages are written to BD anyway).
  // ---------------------------------------------------------------------------

  async fetchChatHistory(chatId: string, limit: number = 500): Promise<any[]> {
    const pool = getPool();
    // messages.conversation_id is stored namespaced (see accountKey); the caller
    // hands us a bare chatId, so namespace it or professional reads zero rows.
    const r = await pool.query(
      `SELECT wa_message_id, sender_wa_id, content, wa_timestamp, is_forwarded, message_type
       FROM messages
       WHERE conversation_id = $1 AND platform = 'whatsapp'
       ORDER BY wa_timestamp DESC LIMIT $2`,
      [accountKey(chatId), limit]
    );
    return r.rows.map(row => ({
      // ids are stored namespaced; the sync service speaks bare WhatsApp ids, so
      // strip the prefix back off on the way out to keep the wire shape stable.
      id: stripAccountKey(row.wa_message_id),
      from: stripAccountKey(row.sender_wa_id),
      author: stripAccountKey(row.sender_wa_id),
      body: row.content,
      timestamp: Math.floor(new Date(row.wa_timestamp).getTime() / 1000),
      fromMe: false, // direction info not exposed cheap here
      hasMedia: row.message_type !== 'TEXT',
      type: row.message_type.toLowerCase(),
      isForwarded: row.is_forwarded,
      isStatus: false,
    }));
  }

  async getAllChatsWithHistory(
    messagesPerChat: number = 500
  ): Promise<{ chat: string; name: string; isGroup: boolean; messages: any[] }[]> {
    const chats = await this.getChats();
    const results = [];
    for (const c of chats) {
      const id = c.id._serialized;
      if (id === 'status@broadcast') continue;
      const messages = await this.fetchChatHistory(id, messagesPerChat);
      results.push({ chat: id, name: c.name, isGroup: c.isGroup, messages });
    }
    return results;
  }

  async backfillHistory(
    options: {
      chatId?: string;
      maxChats?: number;
      maxBatchesPerChat?: number;
      batchSize?: number;
      dryRun?: boolean;
    } = {}
  ): Promise<{
    requested: number;
    candidates: Array<{ chatId: string; oldestMessageId: string; oldestTimestamp: string }>;
  }> {
    if (!this.sock) throw new Error('Client not initialized');
    if (!this.isConnected())
      throw new Error(`Client not connected (state=${this.lastState || 'unknown'})`);
    await ensureHistoryTables();

    const maxChats = Math.max(1, Math.min(options.maxChats || 20, 200));
    const maxBatchesPerChat = Math.max(1, Math.min(options.maxBatchesPerChat || 1, 20));
    const batchSize = Math.max(1, Math.min(options.batchSize || 50, 50));
    const candidates: Array<{ chatId: string; oldestMessageId: string; oldestTimestamp: string }> =
      [];
    let requested = 0;

    const pool = getPool();
    const loadOldest = async () => {
      const params: any[] = [];
      const where = options.chatId ? 'WHERE k.conversation_id = $1' : '';
      // whatsapp_message_keys.conversation_id is stored namespaced (see accountKey
      // in storeMessageKey); the caller filters by a bare chatId, so namespace it
      // or professional matches zero rows.
      if (options.chatId) params.push(accountKey(options.chatId));
      params.push(maxChats);
      const limitParam = `$${params.length}`;
      return pool.query(
        `SELECT DISTINCT ON (k.conversation_id)
            k.conversation_id, k.wa_message_id, k.remote_jid, k.from_me,
            k.participant_jid, k.message_timestamp_ms
         FROM whatsapp_message_keys k
         ${where}
         ORDER BY k.conversation_id, k.message_timestamp_ms ASC
         LIMIT ${limitParam}`,
        params
      );
    };

    for (let batch = 0; batch < maxBatchesPerChat; batch++) {
      const rows = (await loadOldest()).rows;
      if (!rows.length) break;

      for (const row of rows) {
        const oldestTimestamp = new Date(Number(row.message_timestamp_ms));
        // Rows come back namespaced (conversation_id / wa_message_id). The wire
        // contract + the Baileys WAMessageKey both speak the bare id, so strip the
        // prefix once here and use the bare values everywhere downstream.
        const bareConversationId = stripAccountKey(row.conversation_id);
        const bareWaMessageId = stripAccountKey(row.wa_message_id);
        if (batch === 0) {
          candidates.push({
            chatId: bareConversationId,
            oldestMessageId: bareWaMessageId,
            oldestTimestamp: oldestTimestamp.toISOString(),
          });
        }

        if (options.dryRun) continue;

        const key: WAMessageKey = {
          remoteJid: row.remote_jid,
          id: bareWaMessageId,
          fromMe: row.from_me,
          participant: row.participant_jid || undefined,
        };
        this.historyBackfillRequestedUntil = Date.now() + 5 * 60 * 1000;
        await (this.sock as any).fetchMessageHistory(
          batchSize,
          key,
          Math.floor(Number(row.message_timestamp_ms) / 1000)
        );
        requested += 1;
        await recordHistorySyncProgress({
          conversationId: bareConversationId,
          oldestMessageId: bareWaMessageId,
          oldestTimestamp,
          insertedCount: 0,
          status: 'requested',
        });
      }

      if (options.dryRun || maxBatchesPerChat === 1) break;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    return { requested, candidates };
  }

  /**
   * INFRA-288 (P1 INFRA-112): backfill the window dropped while the socket was
   * down, triggered from the `connection.update: open` branch.
   *
   * Newer-first with a volume cap: for each chat the anchor is the NEWEST known
   * message at or before the window start (`now - windowHours`); asking
   * Baileys from that anchor replays the gap forward into
   * `messaging-history.set`, which ingests it as `baileys_history_sync` while
   * `historyBackfillRequestedUntil` is armed. Requests stop as soon as the
   * total asked reaches WA_RECONNECT_BACKFILL_MAX_MESSAGES — never unbounded.
   *
   * Chain-reconnect safety: a 60s cooldown between bursts plus an in-flight
   * flag, so flapping sockets ask for history once, not once per `open`.
   */
  async backfillReconnectWindow(): Promise<{ requested: number; chats: number }> {
    // historySyncOnLogin ON means Baileys already syncs history on login —
    // asking again would double-fetch the same window.
    if (!this.sock || this.historySyncOnLogin || !this.reconnectBackfillLimits)
      return { requested: 0, chats: 0 };
    if (this.reconnectBackfillInFlight) return { requested: 0, chats: 0 };
    const now = Date.now();
    if (now - this.lastReconnectBackfillAt < 60_000) return { requested: 0, chats: 0 };
    this.reconnectBackfillInFlight = true;
    this.lastReconnectBackfillAt = now;

    try {
      const { windowMs, maxMessages, batchSize } = this.reconnectBackfillLimits;
      const windowStart = now - windowMs;
      await ensureHistoryTables();

      // whatsapp_message_keys.conversation_id is stored namespaced (see
      // accountKey); the wire contract speaks bare ids, stripped below. The
      // table has no account column, so anchors are scoped through messages
      // (m.account = this connector's account) — same pattern as the unread
      // keys query in db-writer. Without it the MAX_MESSAGES budget would be
      // spent on OTHER accounts' chats in the shared DB and this account's
      // dropped window would stay unfilled.
      const anchors = (
        await getPool().query(
          `SELECT DISTINCT ON (k.conversation_id)
              k.conversation_id, k.wa_message_id, k.remote_jid, k.from_me,
              k.participant_jid, k.message_timestamp_ms
           FROM whatsapp_message_keys k
           JOIN messages m ON m.wa_message_id = k.wa_message_id
           WHERE k.message_timestamp_ms <= $1
             AND m.account = $2
           ORDER BY k.conversation_id, k.message_timestamp_ms DESC
           LIMIT $3`,
          [windowStart, connectorAccount(), 200]
        )
      ).rows;

      let requested = 0;
      let chats = 0;
      for (const row of anchors) {
        const remaining = maxMessages - requested;
        if (remaining <= 0) break;
        const bareConversationId = stripAccountKey(row.conversation_id);
        const bareWaMessageId = stripAccountKey(row.wa_message_id);
        const key: WAMessageKey = {
          remoteJid: row.remote_jid,
          id: bareWaMessageId,
          fromMe: row.from_me,
          participant: row.participant_jid || undefined,
        };
        // Arm the ingest window so messaging-history.set accepts the replay
        // (same pattern as backfillHistory).
        this.historyBackfillRequestedUntil = Date.now() + 5 * 60 * 1000;
        await (this.sock as any).fetchMessageHistory(
          Math.min(batchSize, remaining),
          key,
          Math.floor(Number(row.message_timestamp_ms) / 1000)
        );
        requested += Math.min(batchSize, remaining);
        chats += 1;
        await recordHistorySyncProgress({
          conversationId: bareConversationId,
          oldestMessageId: bareWaMessageId,
          oldestTimestamp: new Date(Number(row.message_timestamp_ms)),
          insertedCount: 0,
          status: 'requested',
        });
      }
      if (requested > 0)
        this.logger.info(`reconnect backfill requested=${requested} chats=${chats}`);
      return { requested, chats };
    } finally {
      this.reconnectBackfillInFlight = false;
    }
  }

  async getHistorySyncStatus(limit: number = 200): Promise<HistorySyncState[]> {
    await ensureHistoryTables();
    return getHistorySyncStatus(limit);
  }

  // ---------------------------------------------------------------------------
  // Media download
  // ---------------------------------------------------------------------------

  async downloadMedia(
    chatId: string,
    messageId: string
  ): Promise<{ data: string; mimetype: string; filename: string } | null> {
    // Incoming media is persisted to MinIO on receipt; map the wa_message_id to
    // its stored object (attachments.file_url) and stream it back as base64.
    try {
      const pool = getPool();
      // The caller may hand us either the WhatsApp message id or the numeric
      // messages.id (social_list_messages exposes both `waMessageId` and `id`).
      // messages.wa_message_id is stored namespaced, so namespace the wa id ($1) or
      // professional finds no attachment row; messages.id is the global numeric PK
      // and is never namespaced, so match it raw ($2). Mirrors the dual lookup the
      // MCP server already does for get_messages (wa_message_id OR id::text).
      // Scope to this connector's account ($3) so the numeric-id branch cannot
      // cross the personal/professional boundary in the shared DB.
      const r = await pool.query(
        `SELECT a.file_url, a.mime_type, a.file_name
           FROM attachments a JOIN messages m ON m.id = a.message_id
          WHERE (m.wa_message_id = $1 OR m.id::text = $2) AND m.account = $3
          ORDER BY a.id DESC LIMIT 1`,
        [accountKey(messageId), messageId, connectorAccount()]
      );
      const row = r.rows[0];
      if (!row?.file_url) {
        this.logger.warn(`downloadMedia: no stored attachment for ${messageId}`);
        return null;
      }
      const buf = await fetchMedia(row.file_url as string);
      return {
        data: buf.toString('base64'),
        mimetype: (row.mime_type as string) || 'application/octet-stream',
        filename: (row.file_name as string) || 'media',
      };
    } catch (e: any) {
      this.logger.error(`downloadMedia failed for ${messageId}: ${e?.message || e}`);
      return null;
    }
  }

  async backfillRecentMedia(
    _daysBack: number = 7,
    _limit: number = 100
  ): Promise<{ ok: number; unavailable: number; total: number }> {
    // Live re-download by id isn't reliable with Baileys without keeping the
    // full WAMessage. The history-on-login sync already retrieves recent media
    // and pipes it through ingestMessage(). Surface a no-op so legacy callers
    // don't crash.
    this.logger.warn('backfillRecentMedia: noop (Baileys handles this via history-on-login)');
    return { ok: 0, unavailable: 0, total: 0 };
  }

  // ---------------------------------------------------------------------------
  // Public state helpers (unchanged surface)
  // ---------------------------------------------------------------------------

  getCachedState(): string | null {
    return this.lastState;
  }

  getStatus(): Record<string, unknown> {
    return {
      connected: this.ready,
      state: this.lastState,
      connectedAt: this.connectedAt?.toISOString() || null,
      lastQrAt: this.lastQrAt?.toISOString() || null,
      lastDisconnectedAt: this.lastDisconnectedAt?.toISOString() || null,
      lastReconnectAt: this.lastReconnectAt?.toISOString() || null,
      reconnectAttempts: this.reconnectAttempts,
      watchdogIntervalMs: this.watchdogIntervalMs,
      initializeMaxMs: this.initializeMaxMs,
      historySyncOnLogin: this.historySyncOnLogin,
      qrUrl: process.env.WA_QR_PUBLIC_URL || 'https://whatsapp.e-dani.com/',
      backend: 'baileys',
    };
  }

  async getState(_timeoutMs?: number): Promise<string | null> {
    // wwebjs exposed a network round-trip state; Baileys keeps everything in
    // memory via connection.update events, so we just surface our cached one.
    return this.lastState;
  }

  isConnected(): boolean {
    return this.ready;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Convert Baileys JID to the legacy `@c.us`/`@g.us` format used in DB. */
  private normalizeJid(jid: string): string {
    if (!jid) return jid;
    if (jid.endsWith('@s.whatsapp.net')) return jid.replace('@s.whatsapp.net', '@c.us');
    if (jid.endsWith('@lid')) return jid; // keep as-is; downstream code already tolerates
    return jid;
  }

  /** Convert our legacy `@c.us` JID back to Baileys' `@s.whatsapp.net`. */
  private toRawJid(jid: string): string {
    if (!jid) return jid;
    if (jid.endsWith('@c.us')) return jid.replace('@c.us', '@s.whatsapp.net');
    return jid; // groups stay `@g.us`, broadcasts stay `@broadcast`
  }

  private isGroupJid(jid: string): boolean {
    return !!isJidGroup(jid) || jid.endsWith('@g.us');
  }

  private isDirectUserJid(jid: string): boolean {
    return (
      jid.endsWith('@s.whatsapp.net') ||
      jid.endsWith('@lid') ||
      jid.endsWith('@hosted') ||
      jid.endsWith('@hosted.lid')
    );
  }

  private cacheGroupMetadata(meta: GroupMetadata): void {
    const raw = meta.id;
    const normalized = this.normalizeJid(raw);
    this.groupMetaCache.set(raw, meta);
    const previous = this.chatStore.get(normalized);
    this.chatStore.set(normalized, {
      id: normalized,
      rawJid: raw,
      name: meta.subject || previous?.name || raw,
      isGroup: true,
      unreadCount: previous?.unreadCount || 0,
      timestamp: previous?.timestamp || Number(meta.creation || 0),
    });
  }

  private async markSenderKeyDevicesAsSent(rawJid: string, deviceJids: string[]): Promise<void> {
    if (!this.sock || !deviceJids.length) return;
    const current = await this.sock.authState.keys.get('sender-key-memory', [rawJid]);
    const senderKeyMap = { ...(current[rawJid] || {}) } as Record<string, boolean>;
    for (const jid of deviceJids) {
      senderKeyMap[jid] = true;
    }
    await this.sock.authState.keys.set({ 'sender-key-memory': { [rawJid]: senderKeyMap } });
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size));
    }
    return chunks;
  }

  private phoneFromJid(jid: string): string | undefined {
    if (!jid) return undefined;
    const at = jid.indexOf('@');
    const user = at > 0 ? jid.slice(0, at) : jid;
    // strip any device suffix like ":1"
    const colon = user.indexOf(':');
    return colon > 0 ? user.slice(0, colon) : user;
  }

  private rememberKey(waMessageId: string, key: WAMessageKey, chatJid: string): void {
    if (!waMessageId) return;
    if (this.keyCache.size >= KEY_CACHE_MAX) {
      const firstKey = this.keyCache.keys().next().value;
      if (firstKey) this.keyCache.delete(firstKey);
    }
    this.keyCache.set(waMessageId, { key, chatJid });
  }

  private rememberMessageForRetry(
    key: WAMessageKey | undefined,
    message: proto.IMessage | null | undefined
  ): void {
    if (!key?.id || !message) return;
    this.retryMessageCache.set(key.id, message);
    if (key.remoteJid) {
      this.retryMessageCache.set(this.retryMessageCacheKey(key.remoteJid, key.id), message);
    }
  }

  private retryMessageCacheKey(remoteJid: string, messageId: string): string {
    return `${remoteJid}:${messageId}`;
  }

  private async getMessageForRetry(key: proto.IMessageKey): Promise<proto.IMessage | undefined> {
    const messageId = key.id || '';
    if (!messageId) return undefined;

    const remoteJid = key.remoteJid || '';
    const cached =
      (remoteJid
        ? this.retryMessageCache.get<proto.IMessage>(
            this.retryMessageCacheKey(remoteJid, messageId)
          )
        : undefined) || this.retryMessageCache.get<proto.IMessage>(messageId);
    if (cached) {
      this.logger.debug(
        `WhatsApp retry message cache hit remoteJid=${remoteJid || 'unknown'} messageId=${messageId}`
      );
      return cached;
    }

    // Durable copy: the exact content we sent/received, even after a restart.
    const durable = await this.durableMessage(messageId);
    if (durable?.message) {
      this.logger.debug(
        `WhatsApp retry message durable hit remoteJid=${remoteJid || 'unknown'} messageId=${messageId}`
      );
      this.retryMessageCache.set(messageId, durable.message);
      if (remoteJid) {
        this.retryMessageCache.set(
          this.retryMessageCacheKey(remoteJid, messageId),
          durable.message
        );
      }
      return durable.message;
    }

    const reconstructed = await this.reconstructMessageForRetryFromDb(messageId);
    if (reconstructed) {
      this.logger.debug(`WhatsApp retry message reconstructed from DB messageId=${messageId}`);
      this.retryMessageCache.set(messageId, reconstructed);
      if (remoteJid) {
        this.retryMessageCache.set(this.retryMessageCacheKey(remoteJid, messageId), reconstructed);
      }
      return reconstructed;
    }

    this.logger.warn(
      `WhatsApp retry requested but message content is unavailable remoteJid=${remoteJid || 'unknown'} messageId=${messageId}`
    );
    return undefined;
  }

  private async reconstructMessageForRetryFromDb(
    messageId: string
  ): Promise<proto.IMessage | undefined> {
    try {
      const pool = getPool();
      const r = await pool.query(
        `SELECT content, message_type
         FROM messages
         WHERE wa_message_id = $1 AND platform = 'whatsapp'
         LIMIT 1`,
        // wa_message_id is stored namespaced (accountKey) by storeMessage;
        // Baileys hands us the bare WhatsApp id on getMessage retries.
        [accountKey(messageId)]
      );
      const row = r.rows[0] as { content: string | null; message_type: string | null } | undefined;
      if (!row || row.message_type !== 'TEXT' || !row.content) return undefined;
      return { conversation: row.content };
    } catch (e: any) {
      this.logger.warn(
        `WhatsApp retry DB lookup failed messageId=${messageId}: ${e?.message || e}`
      );
      return undefined;
    }
  }

  private async reconstructKeyFromDb(
    waMessageId: string,
    chatId: string
  ): Promise<WAMessageKey | null> {
    const pool = getPool();
    // messages.wa_message_id is stored namespaced; the caller hands us the bare
    // WhatsApp id, so namespace it for the lookup or professional finds nothing.
    const r = await pool.query(
      `SELECT direction, sender_wa_id FROM messages WHERE wa_message_id = $1 LIMIT 1`,
      [accountKey(waMessageId)]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    const fromMe = row.direction === 'OUTBOUND';
    const remoteJid = this.toRawJid(chatId);
    let participant: string | undefined;
    if (isJidGroup(remoteJid)) {
      // sender_wa_id is stored namespaced; strip back to the bare JID before
      // building a raw WhatsApp JID for the message key.
      participant = this.toRawJid(stripAccountKey(row.sender_wa_id));
    }
    // The returned key.id must stay bare — it is the real WhatsApp message id.
    return { id: waMessageId, remoteJid, fromMe, participant };
  }

  private shouldRetryGroupSend(failureClass: WhatsAppSendFailureClass): boolean {
    return (
      failureClass === 'missing_session' || failureClass === 'timeout' || failureClass === 'unknown'
    );
  }

  private async sendTextWithTimeout(
    rawJid: string,
    content: string,
    timeoutMs: number,
    options?: {
      useCachedGroupMetadata?: boolean;
      useUserDevicesCache?: boolean;
      quoted?: WAMessage;
      messageId?: string;
    }
  ): Promise<WAMessage | undefined> {
    if (!this.sock) throw new Error('Client not initialized');
    const sendOpts: any = {};
    if (options?.useCachedGroupMetadata !== undefined) {
      sendOpts.useCachedGroupMetadata = options.useCachedGroupMetadata;
    }
    if (options?.useUserDevicesCache !== undefined) {
      sendOpts.useUserDevicesCache = options.useUserDevicesCache;
    }
    if (options?.quoted) sendOpts.quoted = options.quoted;
    if (options?.messageId) sendOpts.messageId = options.messageId;
    return this.race(
      this.sock.sendMessage(rawJid, { text: content }, sendOpts),
      timeoutMs,
      `sendMessage timeout after ${timeoutMs}ms`
    );
  }

  private async readDirectPrivacyTokenState(
    rawJid: string
  ): Promise<{ ok: boolean; storageJid: string } | null> {
    if (!this.sock) return null;
    const sock = this.sock as any;
    const lidMapping = sock.signalRepository?.lidMapping;
    const getLIDForPN =
      lidMapping?.getLIDForPN?.bind(lidMapping) || (async () => null as string | null);
    const keys = sock.authState?.keys;
    if (!keys) return null;

    const storageJid = await resolveTcTokenJid(rawJid, getLIDForPN);
    const tokenData = await keys.get('tctoken', [storageJid]);
    const entry = tokenData?.[storageJid];
    const token = entry?.token;
    const tokenLength = typeof token?.length === 'number' ? token.length : 0;
    return {
      ok: tokenLength > 0 && !isTcTokenExpired(entry?.timestamp),
      storageJid,
    };
  }

  private async prepareDirectPrivacyToken(
    rawJid: string,
    normalizedJid: string,
    started: number
  ): Promise<void> {
    if (!this.sock) throw new Error('Client not initialized');
    if (process.env.WA_DIRECT_PRIVACY_PREFLIGHT === 'false') return;

    const sock = this.sock as any;
    const lidMapping = sock.signalRepository?.lidMapping;
    const getLIDForPN =
      lidMapping?.getLIDForPN?.bind(lidMapping) || (async () => null as string | null);
    const getPNForLID = lidMapping?.getPNForLID?.bind(lidMapping);
    const keys = sock.authState?.keys;
    if (!keys) return;

    const hasValidToken = async (): Promise<{ ok: boolean; storageJid: string }> => {
      const storageJid = await resolveTcTokenJid(rawJid, getLIDForPN);
      const tokenData = await keys.get('tctoken', [storageJid]);
      const entry = tokenData?.[storageJid];
      const token = entry?.token;
      const tokenLength = typeof token?.length === 'number' ? token.length : 0;
      return {
        ok: tokenLength > 0 && !isTcTokenExpired(entry?.timestamp),
        storageJid,
      };
    };

    let tokenState = await hasValidToken();
    if (tokenState.ok) return;

    const contactResults = await sock.onWhatsApp(rawJid).catch((err: Error) => {
      this.logger.warn(
        `WhatsApp direct preflight onWhatsApp failed rawJid=${rawJid} normalizedJid=${normalizedJid}: ${err.message}`
      );
      return undefined;
    });
    const contact = Array.isArray(contactResults) ? contactResults[0] : undefined;
    if (contact && contact.exists === false) {
      throw new WhatsAppSendError(
        `WhatsApp direct preflight failed: ${normalizedJid} is not on WhatsApp`,
        {
          failureClass: 'invalid_recipient',
          rawJid,
          normalizedJid,
          isGroup: false,
          attempts: 0,
          elapsedMs: Date.now() - started,
          causeMessage: 'target is not on WhatsApp',
          actionable: actionableForFailure('invalid_recipient', false),
        }
      );
    }

    await sock.getUSyncDevices([rawJid], false, false).catch((err: Error) => {
      this.logger.warn(
        `WhatsApp direct preflight device sync failed rawJid=${rawJid} normalizedJid=${normalizedJid}: ${err.message}`
      );
    });

    const issueTimestamp = Math.floor(Date.now() / 1000);
    const issueToLid = Boolean(sock.serverProps?.lidTrustedTokenIssueToLid);
    const issueJid = await resolveIssuanceJid(rawJid, issueToLid, getLIDForPN, getPNForLID);
    const result = await sock.issuePrivacyTokens([issueJid], issueTimestamp);
    tokenState = await hasValidToken();
    await storeTcTokensFromIqResult({
      result,
      fallbackJid: tokenState.storageJid,
      keys,
      getLIDForPN,
    });

    tokenState = await hasValidToken();
    if (tokenState.ok) {
      this.logger.info(
        `WhatsApp direct preflight stored trusted-contact token rawJid=${rawJid} normalizedJid=${normalizedJid}`
      );
      return;
    }

    if (sock.serverProps?.privacyTokenOn1to1) {
      throw new WhatsAppSendError(
        'WhatsApp direct preflight could not obtain a trusted-contact token for this 1:1 target',
        {
          failureClass: 'account_restricted',
          rawJid,
          normalizedJid,
          isGroup: false,
          attempts: 0,
          elapsedMs: Date.now() - started,
          causeMessage: 'missing trusted-contact token after preflight',
          actionable: actionableForFailure('account_restricted', false),
        }
      );
    }
  }

  private resolveImmediateSendFailure(waMessageId: string, failure: ImmediateSendFailure): void {
    const waiter = this.immediateSendFailureWaiters.get(waMessageId);
    if (!waiter) {
      this.recentImmediateSendFailures.set(waMessageId, {
        failure,
        expiresAt: Date.now() + 15000,
      });
      return;
    }
    this.immediateSendFailureWaiters.delete(waMessageId);
    waiter(failure);
  }

  private async waitForImmediateSendFailure(
    waMessageId: string
  ): Promise<ImmediateSendFailure | undefined> {
    const waitMs = parseInt(process.env.WA_SEND_ERROR_ACK_WAIT_MS || '5000', 10);
    if (!waMessageId || waitMs <= 0) return undefined;
    const now = Date.now();
    for (const [id, entry] of this.recentImmediateSendFailures.entries()) {
      if (entry.expiresAt <= now) this.recentImmediateSendFailures.delete(id);
    }
    const recent = this.recentImmediateSendFailures.get(waMessageId);
    if (recent) {
      this.recentImmediateSendFailures.delete(waMessageId);
      return recent.failure;
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.immediateSendFailureWaiters.delete(waMessageId);
        resolve(undefined);
      }, waitMs);
      this.immediateSendFailureWaiters.set(waMessageId, failure => {
        clearTimeout(timer);
        resolve(failure);
      });
    });
  }

  private buildSendError(
    failureClass: WhatsAppSendFailureClass,
    rawJid: string,
    normalizedJid: string,
    isGroup: boolean,
    started: number,
    attempts: number,
    cause: unknown,
    repair?: GroupSessionRefreshResult
  ): WhatsAppSendError {
    const causeMessage = errorMessage(cause);
    const details: SendFailureDetails = {
      failureClass,
      rawJid,
      normalizedJid,
      isGroup,
      groupSubject: repair?.groupSubject,
      participantCount: repair?.participantCount,
      attempts,
      elapsedMs: Date.now() - started,
      causeMessage,
      actionable: actionableForFailure(failureClass, isGroup),
      repair,
    };
    return new WhatsAppSendError(
      `WhatsApp send failed (${failureClass}): ${causeMessage}`,
      details,
      cause
    );
  }

  private race<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(msg)), ms);
      p.then(
        v => {
          clearTimeout(t);
          resolve(v);
        },
        e => {
          clearTimeout(t);
          reject(e);
        }
      );
    });
  }
}
