import { qrPageUrl, whatsappSocketOptions } from './url-config';
import { SendAlreadyClaimedError } from './send-idempotency';
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
  proto,
  isJidGroup,
  jidEncode,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  AnyMessageContent,
  CacheStore,
  GroupMetadata,
  Browsers,
  generateWAMessageFromContent,
} from '@whiskeysockets/baileys';
import { normalizeMessageContent } from '@whiskeysockets/baileys/lib/Utils/messages.js';
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
  canonicalConversationId,
  stripAccountKey,
  connectorAccount,
  storeMessage,
  ensureConversation,
  ensureEmptyConversation,
  ensureParticipant,
  linkParticipantToConversation,
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
  applyArchiveSnapshot,
  setMessageStatus,
  setConversationWaChatId,
  setConversationName,
  setParticipantName,
} from './db-writer';
import {
  ensureDurableTables,
  getMessageKeysForChat,
  getRawWAMessage,
  getRawWAMessagesByIds,
  listCapturedPollUpdates,
  listStoredContacts,
  markMessageDeleted,
  markMessageDeletedForMe,
  markMessageEdited,
  storeMessageReaction,
  storeContact,
  storeRawWAMessage,
  upsertChatState,
} from './durable-message-store';
import {
  buildChatModification,
  buildContactMessage,
  buildEventMessage,
  buildPollMessage,
  buildPresenceSnapshot,
  buildPrivacyUpdate,
  CapabilityError,
  type EventMessageInput,
  type PollMessageInput,
} from './whatsapp-capabilities';
import {
  aggregateCapturedPollVotes,
  buildPollVoteContent,
  decryptCapturedPollVotes,
  generateMessageIDV2,
  parsePollCreationContent,
  pollEncKeyFromStoredMessage,
  validatePollVoteSelection,
  type PollResultsEntry,
  type StoredPollUpdate,
} from './poll-votes';
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
import { readArchiveSnapshot, readCurrentArchiveSnapshot } from './archive-snapshot';
import { enrichArchiveGroupNames } from './archive-group-names';

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
  /** Structured provider data for polls, events, and received reactions. */
  metadata?: Record<string, unknown>;
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
  archived?: boolean;
  pinned?: boolean;
  muteUntil?: number | null;
  starred?: boolean;
}

type IngestSource = 'live' | 'baileys_history_sync';

interface IngestOptions {
  source?: IngestSource;
  publishEvent?: boolean;
  skipMediaDownload?: boolean;
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

function numericProviderValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { toNumber?: unknown }).toNumber === 'function'
  ) {
    const numberValue = Number((value as { toNumber: () => number }).toNumber());
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }
  return undefined;
}

function unescapeVCardValue(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\([\\;,])/g, '$1')
    .trim();
}

function parseVCardFields(vcard: unknown): {
  phone?: string;
  organization?: string;
  email?: string;
} {
  if (typeof vcard !== 'string') return {};
  const fields: { phone?: string; organization?: string; email?: string } = {};
  for (const line of vcard.replace(/\\n/gi, '\n').split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const property = line.slice(0, separator).toUpperCase();
    const value = unescapeVCardValue(line.slice(separator + 1));
    if (!value) continue;
    if (property.startsWith('TEL')) fields.phone ||= value;
    else if (property === 'ORG') fields.organization ||= value;
    else if (property.startsWith('EMAIL')) fields.email ||= value;
  }
  return fields;
}

// LRU-ish cache mapping our exported waMessageId → full WAMessageKey (+ owning
// chat) so we can react/forward/delete/download without keeping every message
// in memory.
const KEY_CACHE_MAX = 2000;

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

/** Return true when a value is an identifier fallback rather than a name. */
export function isWhatsAppJidLikeName(
  value: string | null | undefined,
  id?: string | null
): boolean {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return true;
  const bareId = typeof id === 'string' ? id.replace(/^[^:]+:/, '') : '';
  return (
    name === id ||
    (!!bareId && name === bareId) ||
    /@(lid|c\.us|s\.whatsapp\.net|g\.us|broadcast|newsletter)$/.test(name)
  );
}

export interface WhatsAppContactIdentity {
  ids: string[];
  /** Address-book/business name when Baileys provides one. */
  name?: string;
  /** Remote user's profile/push name (`notify` in Baileys contacts). */
  pushName?: string;
}

export type WhatsAppContactNameSource = 'saved' | 'push';

export interface WhatsAppContactNameRecord {
  name: string;
  source: WhatsAppContactNameSource;
}

/** Saved/address-book names outrank the remote profile name. */
export function preferWhatsAppContactName(
  current: WhatsAppContactNameRecord | undefined,
  incoming: WhatsAppContactNameRecord
): WhatsAppContactNameRecord {
  if (current?.source === 'saved' && incoming.source === 'push') return current;
  return incoming;
}

/** Extract contact aliases and names without logging or exposing their values. */
export function whatsappContactIdentity(contact: unknown): WhatsAppContactIdentity {
  const value = (contact && typeof contact === 'object' ? contact : {}) as Record<string, unknown>;
  const ids = Array.from(
    new Set(
      ['id', 'jid', 'lid', 'phoneNumber']
        .filter(key => typeof value[key] === 'string')
        .map(key => String(value[key]).trim())
        .filter(Boolean)
    )
  );
  const id = ids[0];
  const candidate = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate !== 'string') continue;
      const clean = candidate.trim();
      if (clean && !isWhatsAppJidLikeName(clean, id)) return clean;
    }
    return undefined;
  };
  const pushCandidate = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate !== 'string') continue;
      const clean = candidate.trim();
      if (clean && !isWhatsAppJidLikeName(clean, id)) return clean;
    }
    return undefined;
  };
  return {
    ids,
    name: candidate('name', 'verifiedName'),
    pushName: pushCandidate('notify', 'pushName', 'push_name'),
  };
}

/** Pick a chat title while keeping group subjects separate from participant names. */
export function chooseWhatsAppConversationName(options: {
  id: string;
  isGroup: boolean;
  existingName?: string | null;
  contactName?: string | null;
  pushName?: string | null;
  groupSubject?: string | null;
}): string {
  const candidates = options.isGroup
    ? [options.groupSubject, options.existingName, options.id]
    : [options.existingName, options.contactName, options.pushName, options.id];
  return candidates.find(value => !isWhatsAppJidLikeName(value, options.id))?.trim() || options.id;
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

/** Baileys 7's alternate direct-chat address can identify a PN echo as LID. */
export function lidFromPnMessage(msg: WAMessage | undefined | null): string | undefined {
  if (!pnJidToE164(msg?.key?.remoteJid)) return undefined;
  const alternate = msg?.key?.remoteJidAlt;
  if (typeof alternate !== 'string' || !/^\d+(?::\d+)?@lid$/.test(alternate)) return undefined;
  return jidNormalizedUser(alternate);
}

export class ProfilePictureTimeoutError extends Error {
  constructor() {
    super('WhatsApp profile picture lookup timed out');
    this.name = 'ProfilePictureTimeoutError';
  }
}

export class ProfilePictureDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfilePictureDownloadError';
  }
}

const PROFILE_PICTURE_LOOKUP_TIMEOUT_MS = 8_000;

async function boundedProfilePictureUrl(
  lookup: (timeoutMs: number) => Promise<string | undefined>
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(PROFILE_PICTURE_LOOKUP_TIMEOUT_MS),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ProfilePictureTimeoutError()),
          PROFILE_PICTURE_LOOKUP_TIMEOUT_MS
        );
      }),
    ]);
  } catch (error) {
    if (
      error instanceof ProfilePictureTimeoutError ||
      (error instanceof Boom && error.output.statusCode === 408)
    ) {
      throw new ProfilePictureTimeoutError();
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isUnavailableProfilePicture(error: unknown): boolean {
  return error instanceof Boom && [403, 404].includes(error.output.statusCode);
}

export class BaileysClient extends EventEmitter {
  private sock: WASocket | null = null;
  private archiveSnapshotSync: {
    socket: WASocket;
    promise: Promise<{
      version: number;
      records: number;
      chats: number;
      archived: number;
      created: number;
    }>;
  } | null = null;
  private sessionPath: string;
  // kept for backward compat with the old constructor signature; unused.
  private encryptionKey: Buffer;
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
  // F1.7 honest voice — OFF by default. Enabled (with S3_PUBLIC_ENDPOINT) only
  // on the professional deployment: awaits the voice-note upload before the
  // NATS emit so the event carries a presigned audio URL synapse can
  // transcribe. Personal stays on the historical fire-and-forget path.
  private readonly emitAudioAttachments = process.env.WA_EMIT_AUDIO_ATTACHMENTS === 'true';
  private readonly audioPreEmitTimeoutMs = parseInt(
    process.env.WA_AUDIO_PREEMIT_TIMEOUT_MS || '15000',
    10
  );
  private mediaPersistenceLocks = new Map<string, Promise<void>>();

  // me — populated on `connection.update { connection: 'open' }`
  private meJid: string | null = null;
  private meName: string | null = null;

  // In-memory mirrors. Baileys removed makeInMemoryStore, so we keep the
  // minimum we need for the existing API contract.
  private chatStore = new Map<string, CachedChat>(); // by normalised JID
  // Display names indexed by raw participant JID — populated when we ingest
  // a message; used by the presence.update handler to label "X is typing…".
  private contactNames = new Map<string, WhatsAppContactNameRecord>();
  private contactAliasGroups = new Map<string, Set<string>>();
  // Track which JIDs we've already presenceSubscribed to so we don't spam.
  private presenceSubscribed = new Set<string>();
  private presenceState = new Map<
    string,
    { status: string; lastSeen?: number; participantId?: string; observedAt: number }
  >();
  private groupMetaCache = new Map<string, GroupMetadata>(); // by raw JID
  private keyCache = new Map<string, { key: WAMessageKey; chatJid: string }>(); // by waMessageId
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

  constructor(sessionPath: string, encryptionKey: string) {
    super();
    this.sessionPath = sessionPath;
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

      try {
        await ensureMediaBucket();
      } catch (e: any) {
        this.logger.warn(
          `MinIO bucket check failed (auto-download may not work): ${e?.message || e}`
        );
      }
      await ensureHistoryTables();
      await ensureDurableTables();

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
        ...whatsappSocketOptions(),
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
        },
        printQRInTerminal: false,
        browser:
          this.historySyncOnLogin && !state.creds.me
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
      void saveCreds();
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
        // Presence subscriptions and snapshots belong to the old socket. A
        // reconnect must resubscribe and must not expose stale availability.
        this.presenceSubscribed.clear();
        this.presenceState.clear();
        this.markConnected('connection.update open');
        // Pull current unread/archived/pin state from WhatsApp app-state. This
        // emits chats.update events whose handler persists unread_count +
        // archived to the DB, so the dashboard shows the real badges without
        // waiting for new traffic. Fire-and-forget; safe if it fails.
        void this.resyncChatState('connection-open')
          .then(() => this.syncArchiveSnapshot())
          .catch(error => {
            this.logger.warn(
              `Archive snapshot sync failed: ${error instanceof Error ? error.message : String(error)}`
            );
          });
        // Subscribe to presence for the most-recently-active chats so we
        // receive "composing"/"recording" updates and can forward typing
        // indicators to the dashboard. baileys auto-renews subscriptions
        // while the socket stays open.
        void this.subscribePresenceForActiveChats(200);
        return;
      }

      if (connection === 'close') {
        this.ready = false;
        this.presenceSubscribed.clear();
        this.presenceState.clear();
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
          this.scheduleReconnect('logged out');
          return;
        }

        this.scheduleReconnect(reason);
      }
    });

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
          archived: typeof (c as any).archived === 'boolean' ? (c as any).archived : undefined,
        });
        if (c.name && !isWhatsAppJidLikeName(c.name, norm)) {
          void setConversationName(norm, c.name).catch(() => {});
        }
        // Persist real unread + archived from the history snapshot.
        const archived = typeof (c as any).archived === 'boolean' ? (c as any).archived : undefined;
        void setConversationState(norm, c.unreadCount || 0, archived).catch(() => {});
        void upsertChatState(norm, {
          ...(archived === undefined ? {} : { archived }),
          unreadCount: c.unreadCount || 0,
        }).catch(() => {});
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
          if (typeof u.unreadCount === 'number') prev.unreadCount = u.unreadCount;
          if (u.conversationTimestamp) prev.timestamp = Number(u.conversationTimestamp);
          if (typeof (u as any).archived === 'boolean') prev.archived = (u as any).archived;
          if (typeof (u as any).pinned === 'boolean') prev.pinned = (u as any).pinned;
          if (typeof (u as any).mute === 'number') prev.muteUntil = Number((u as any).mute);
          if ((u as any).name) {
            prev.name = (u as any).name;
            if (!isWhatsAppJidLikeName(prev.name, norm)) {
              void setConversationName(norm, prev.name).catch(() => {});
            }
          }
          this.emit('chat-update', {
            waChatId: prev.id,
            updateType: 'NAME_CHANGED',
            metadata: { name: prev.name },
          });
        }
        // chats.update may carry only a delta — persist whichever fields are present.
        const uc = typeof u.unreadCount === 'number' ? u.unreadCount : prev?.unreadCount || 0;
        const arch = typeof (u as any).archived === 'boolean' ? (u as any).archived : undefined;
        void setConversationState(norm, uc, arch).catch(() => {});
        void upsertChatState(norm, {
          ...(arch === undefined ? {} : { archived: arch }),
          ...(typeof u.unreadCount === 'number' ? { unreadCount: uc } : {}),
          ...(typeof (u as any).pinned === 'boolean' ? { pinned: (u as any).pinned } : {}),
          ...(typeof (u as any).mute === 'number' ? { muteUntil: Number((u as any).mute) } : {}),
        }).catch(() => {});
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
          archived: typeof (c as any).archived === 'boolean' ? (c as any).archived : undefined,
        });
        if (c.name && !isWhatsAppJidLikeName(c.name, norm)) {
          void setConversationName(norm, c.name).catch(() => {});
        }
        // Persist real unread badge + archived flag (fire-and-forget).
        const archived = typeof (c as any).archived === 'boolean' ? (c as any).archived : undefined;
        void setConversationState(norm, c.unreadCount || 0, archived).catch(() => {});
        void upsertChatState(norm, {
          ...(archived === undefined ? {} : { archived }),
          unreadCount: c.unreadCount || 0,
        }).catch(() => {});
        // Subscribe to presence so we get typing updates for this chat.
        void this.presenceSubscribeSilent(c.id);
      }
    });

    // Baileys may deliver an address-book name as `name`, but many versions
    // only provide `notify` (the contact's push name). Keep both aliases so a
    // LID-addressed message can still resolve a PN contact, and persist the
    // best name per account without mixing the two connector instances.
    sock.ev.on('contacts.upsert' as any, (contacts: unknown[]) => {
      for (const contact of contacts || []) this.applyContactIdentity(contact);
    });
    sock.ev.on('contacts.update' as any, (contacts: unknown[]) => {
      for (const contact of contacts || []) this.applyContactIdentity(contact);
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
          const participantId = this.normalizeJid(participantJid);
          const presenceKey = `${convId}:${participantId}`;
          this.presenceState.set(presenceKey, {
            status: typeof status === 'string' ? status : 'unknown',
            ...(typeof p?.lastSeen === 'number' ? { lastSeen: p.lastSeen } : {}),
            participantId,
            observedAt: Date.now(),
          });
          this.emit('presence-update', buildPresenceSnapshot(convId, p, participantId));
          if (status !== 'composing' && status !== 'recording') continue;
          // Lookup display name from the participants we've seen
          const name =
            this.contactNameFor(participantJid, this.normalizeJid(participantJid)) || null;
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
        // Detect deletions
        const stub = u.update?.messageStubType;
        const isDeleted =
          stub === proto.WebMessageInfo.StubType.REVOKE || u.update?.message === null;
        if (isDeleted) {
          this.emit('message-update', { waMessageId, updateType: 'DELETED' });
          void Promise.all([
            markMessageDeleted(waMessageId),
            setMessageStatus(waMessageId, 'deleted'),
          ]).catch(() => {});
        }

        // Baileys unwraps MESSAGE_EDIT protocol messages into this update
        // shape. Persist the new body and keep the edited marker separate from
        // delivery status so the app can render the correct state.
        const editedPayload = (u.update as any)?.message?.editedMessage?.message;
        if (editedPayload) {
          const edited = this.convertMessage({
            key: u.key,
            message: editedPayload,
            messageTimestamp: (u.update as any)?.messageTimestamp || undefined,
          } as WAMessage);
          void (async () => {
            await markMessageEdited(waMessageId, edited?.content || null, edited?.messageType);
            await storeRawWAMessage({
              key: u.key,
              message: editedPayload,
              messageTimestamp: (u.update as any)?.messageTimestamp,
            } as WAMessage).catch(() => {});
            this.emit('message-update', {
              waMessageId,
              updateType: 'EDITED',
              content: edited?.content || null,
              messageType: edited?.messageType,
            });
          })().catch(error =>
            this.logger.warn(
              `edited WhatsApp message persistence failed for ${waMessageId}: ${error?.message || error}`
            )
          );
        }
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
  }

  private mergeContactAliases(ids: string[]): Set<string> {
    const aliases = new Set(ids.filter(Boolean));
    for (const id of Array.from(aliases)) {
      const existing = this.contactAliasGroups.get(id);
      if (!existing) continue;
      for (const alias of existing) aliases.add(alias);
    }
    for (const alias of aliases) this.contactAliasGroups.set(alias, aliases);
    return aliases;
  }

  private rememberContactName(
    ids: string[],
    name: string,
    source: WhatsAppContactNameSource
  ): WhatsAppContactNameRecord | undefined {
    const cleanName = name.trim();
    if (!cleanName || !ids.length) return undefined;
    const aliases = this.mergeContactAliases(ids);
    const incoming = { name: cleanName, source } satisfies WhatsAppContactNameRecord;
    let effective = incoming;
    if (source === 'push') {
      effective =
        Array.from(aliases)
          .map(alias => this.contactNames.get(alias))
          .find(record => record?.source === 'saved') || incoming;
    }
    for (const alias of aliases) {
      const current = this.contactNames.get(alias);
      this.contactNames.set(alias, preferWhatsAppContactName(current, effective));
    }
    const effectiveName = this.contactNameFor(...Array.from(aliases));
    if (!effectiveName) return undefined;
    const saved = Array.from(aliases).some(
      alias => this.contactNames.get(alias)?.source === 'saved'
    );
    return { name: effectiveName, source: saved ? 'saved' : 'push' };
  }

  private contactNameFor(...ids: string[]): string | undefined {
    const aliases = this.mergeContactAliases(ids);
    const records = Array.from(aliases)
      .map(alias => this.contactNames.get(alias))
      .filter((record): record is WhatsAppContactNameRecord => !!record);
    return records.find(record => record.source === 'saved')?.name || records[0]?.name;
  }

  private applyContactIdentity(contact: unknown): void {
    const identity = whatsappContactIdentity(contact);
    const displayName = identity.name || identity.pushName;
    if (!displayName || !identity.ids.length) return;

    const source: WhatsAppContactNameSource = identity.name ? 'saved' : 'push';
    const prepared = identity.ids.map(originalId =>
      /^\d{6,15}$/.test(originalId) ? `${originalId}@s.whatsapp.net` : originalId
    );
    const normalizedIds = prepared.map(id => this.normalizeJid(id));
    const effective = this.rememberContactName(
      [...prepared, ...normalizedIds],
      displayName,
      source
    );
    if (!effective) return;

    for (let index = 0; index < prepared.length; index += 1) {
      const rawId = prepared[index];
      const normalizedId = normalizedIds[index];
      const effectiveName = effective.name;

      const chat = this.chatStore.get(normalizedId);
      if (!isJidGroup(normalizedId)) {
        // Contact events can arrive before the chat snapshot after a restart.
        // Persist the candidate independently so an authoritative rename is
        // not lost when the in-memory chat store is still empty.
        void setConversationName(normalizedId, displayName, {
          authoritative: source === 'saved',
        }).catch(() => {});
      }
      if (chat && !chat.isGroup) {
        if (source === 'saved' || isWhatsAppJidLikeName(chat.name, normalizedId)) {
          chat.name = effectiveName;
        }
      }

      void ensureParticipant({
        id: normalizedId,
        name: effectiveName,
        pushName: identity.pushName,
        phone: this.phoneFromJid(rawId),
      })
        .then(() =>
          source === 'saved'
            ? setParticipantName(normalizedId, effectiveName, identity.pushName)
            : undefined
        )
        .catch(error => {
          this.logger.debug?.(`contact name persist failed: ${error?.message || error}`);
        });
      void storeContact({
        jid: rawId,
        phone: this.phoneFromJid(rawId),
        name: identity.name,
        pushName: identity.pushName,
      }).catch(error => {
        this.logger.debug?.(`contact durable persist failed: ${error?.message || error}`);
      });
    }
  }

  private handleQR(qr: string): void {
    this.ready = false;
    this.lastState = 'QR';
    this.lastQrAt = new Date();
    qrcodeTerminal.generate(qr, { small: true });
    QRCode.toFile(join(this.sessionPath, 'qr.png'), qr, { width: 400 }).catch(() => {});
    this.logger.warn(`WhatsApp requires QR scan at ${qrPageUrl()}`);
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
        this.logger.warn(`WhatsApp is waiting for manual QR scan: ${qrPageUrl()}`);
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
    const normalizedChatId = waMessage.conversationId;
    waMessage.conversationId = await canonicalConversationId(normalizedChatId);
    // Some PN echoes race the DB alias commit. Baileys may carry the paired
    // LID directly or in its mapping store; without either, keep the PN.
    if (waMessage.conversationId === normalizedChatId && pnJidToE164(msg.key.remoteJid)) {
      let lid = lidFromPnMessage(msg);
      if (!lid) {
        try {
          const mapped = await this.sock?.signalRepository?.lidMapping?.getLIDForPN?.(
            msg.key.remoteJid || ''
          );
          if (typeof mapped === 'string' && /^\d+(?::\d+)?@lid$/.test(mapped))
            lid = jidNormalizedUser(mapped);
        } catch {
          /* An unavailable Baileys mapping leaves the PN unchanged. */
        }
      }
      if (lid) waMessage.conversationId = lid;
    }

    this.rememberKey(waMessage.waMessageId, msg.key, msg.key.remoteJid || '');

    const rawChatJid = msg.key.remoteJid || '';
    const isGroup = !!isJidGroup(rawChatJid);
    let groupSubject: string | undefined;
    let participantCount = 2;
    if (isGroup) {
      const meta = await this.fetchGroupMetadata(rawChatJid).catch(() => null);
      participantCount = meta?.participants?.length || 0;
      groupSubject = meta?.subject || undefined;
    }

    const cachedChat = this.chatStore.get(waMessage.conversationId);
    const contactName = this.contactNameFor(rawChatJid, waMessage.conversationId);
    const chatName = chooseWhatsAppConversationName({
      id: waMessage.conversationId,
      isGroup,
      existingName: cachedChat?.name,
      contactName,
      pushName: !msg.key.fromMe ? msg.pushName : undefined,
      groupSubject,
    });

    await ensureConversation({
      id: waMessage.conversationId,
      name: chatName,
      isGroup,
      participantCount,
    });

    // WhatsApp privacy migration: when a direct chat is LID-addressed
    // (`…@lid`), the LID is NOT a phone number, so neither the conversation id
    // nor `phoneFromJid(senderRaw)` yields the real MSISDN that downstream
    // consumers (skirmshop-labels opt-in poller) require. If Baileys attached
    // the alternate phone-number jid, capture it here ONCE and (a) ride it into
    // the message metadata as `senderPnE164`, (b) backfill the long-empty
    // `conversations.wa_chat_id` with the PN jid. Group participant PN belongs
    // to the sender, never to the group conversation. Both are best-effort and must
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
      // Establish the PN alias before a subsequent PN-addressed echo arrives.
      // A mapping failure must not drop the message.
      if (!isGroup && waMessage.conversationId.endsWith('@lid')) {
        await setConversationWaChatId(waMessage.conversationId, lidPn.pnJid).catch(e =>
          this.logger.warn(
            `wa_chat_id backfill failed for conversation=${waMessage.conversationId}: ${
              e?.message || e
            }`
          )
        );
      }
    }
    if (!isGroup && pnJidToE164(rawChatJid) && waMessage.conversationId.endsWith('@lid')) {
      await setConversationWaChatId(waMessage.conversationId, rawChatJid).catch(e =>
        this.logger.warn(
          `wa_chat_id backfill failed for conversation=${waMessage.conversationId}: ${e?.message || e}`
        )
      );
    }

    // Keep the original Baileys key for replies while indexing its payload
    // under the same canonical conversation used by messages.
    if (msg.key?.id && msg.message) {
      await storeRawWAMessage(msg, waMessage.conversationId).catch(e =>
        this.logger.warn(
          `durable WhatsApp message store failed for ${msg.key.id}: ${e?.message || e}`
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
      this.rememberContactName([senderRaw, waMessage.senderWaId], pushName, 'push');
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
        ...(waMessage.metadata || {}),
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

    if (waMessage.messageType === 'REACTION' && waMessage.replyToWaId) {
      await storeMessageReaction({
        targetMessageId: waMessage.replyToWaId,
        reactorJid: waMessage.senderWaId,
        reactionMessageId: waMessage.waMessageId,
        emoji: String(waMessage.metadata?.emoji || waMessage.content || ''),
      }).catch(error =>
        this.logger.warn(
          `reaction persistence failed for ${waMessage.waMessageId}: ${error?.message || error}`
        )
      );
    }

    if (!msgId) return { inserted: false, waMessage };

    this.logger.info(`Stored message ${waMessage.waMessageId} from ${waMessage.senderWaId}`);

    const isLiveMedia =
      !options.skipMediaDownload &&
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
      if (waMessage.messageType === 'REACTION' || waMessage.messageType === 'POLL_VOTE') {
        this.emit('reaction', waMessage);
      }
    }
    return { inserted: true, waMessage };
  }

  private convertMessage(msg: WAMessage): WhatsAppMessage | null {
    if (!msg.key?.id || !msg.key.remoteJid) return null;

    const content = normalizeMessageContent(msg.message);
    if (!content) return null;

    // Determine type + body
    let messageType = 'TEXT';
    let body: string | null = null;
    let isForwarded = false;
    let replyToWaId: string | undefined;
    let metadata: Record<string, unknown> | undefined;

    const text = content.conversation;
    const ext = content.extendedTextMessage;
    if (text) {
      body = text;
    } else if (ext) {
      body = ext.text || null;
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
      metadata = {
        kind: 'sticker',
        isAnimated: !!content.stickerMessage.isAnimated,
        mimetype: content.stickerMessage.mimetype || 'image/webp',
      };
    } else if (content.reactionMessage) {
      messageType = 'REACTION';
      body = content.reactionMessage.text || null;
      if (content.reactionMessage.key?.id) replyToWaId = content.reactionMessage.key.id;
      metadata = {
        kind: 'reaction',
        emoji: content.reactionMessage.text || '',
        targetMessageId: content.reactionMessage.key?.id || null,
      };
    } else if (
      content.pollCreationMessage ||
      (content as any).pollCreationMessageV2 ||
      (content as any).pollCreationMessageV3 ||
      (content as any).pollCreationMessageV5
    ) {
      const poll =
        content.pollCreationMessage ||
        (content as any).pollCreationMessageV2 ||
        (content as any).pollCreationMessageV3 ||
        (content as any).pollCreationMessageV5;
      messageType = 'POLL';
      body = poll?.name || null;
      metadata = {
        kind: 'poll',
        options: Array.isArray(poll?.options)
          ? poll.options.map((option: any) => option?.optionName || option?.name).filter(Boolean)
          : [],
        selectableCount: poll?.selectableOptionsCount ?? poll?.selectableCount ?? null,
      };
    } else if (content.pollUpdateMessage) {
      messageType = 'POLL_VOTE';
      metadata = {
        kind: 'poll_vote',
        pollMessageId: content.pollUpdateMessage.pollCreationMessageKey?.id || null,
      };
    } else if ((content as any).pollResultSnapshotMessage) {
      messageType = 'POLL_RESULT';
      metadata = { kind: 'poll_result' };
    } else if ((content as any).eventMessage) {
      const event = (content as any).eventMessage;
      messageType = 'EVENT';
      body = event?.name || null;
      const startTime = numericProviderValue(event?.startTime);
      const endTime = numericProviderValue(event?.endTime);
      const location =
        event?.location && typeof event.location === 'object'
          ? {
              ...(numericProviderValue(event.location.degreesLatitude) === undefined
                ? {}
                : { degreesLatitude: numericProviderValue(event.location.degreesLatitude) }),
              ...(numericProviderValue(event.location.degreesLongitude) === undefined
                ? {}
                : { degreesLongitude: numericProviderValue(event.location.degreesLongitude) }),
              ...(typeof event.location.name === 'string' && event.location.name.trim()
                ? { name: event.location.name.trim() }
                : {}),
            }
          : undefined;
      metadata = {
        kind: 'event',
        description: event?.description || null,
        startTime: startTime ?? null,
        endTime: endTime ?? null,
        location: location && Object.keys(location).length ? location : null,
        isCancelled: !!(event?.isCanceled ?? event?.isCancelled),
      };
    } else if (content.locationMessage) {
      messageType = 'LOCATION';
      const loc = content.locationMessage;
      body = `${loc.degreesLatitude},${loc.degreesLongitude}`;
    } else if (content.contactMessage) {
      messageType = 'CONTACT';
      body = content.contactMessage.displayName || null;
      metadata = {
        kind: 'contact',
        contacts: [
          {
            displayName: content.contactMessage.displayName || null,
            ...parseVCardFields(content.contactMessage.vcard),
          },
        ],
      };
    } else if (content.contactsArrayMessage) {
      messageType = 'CONTACT';
      body = content.contactsArrayMessage.displayName || null;
      metadata = {
        kind: 'contact',
        contacts: (content.contactsArrayMessage.contacts || []).map(contact => ({
          displayName: contact.displayName || null,
          ...parseVCardFields(contact.vcard),
        })),
      };
    } else if (content.protocolMessage) {
      // ignore key updates etc.
      return null;
    } else {
      const k = Object.keys(content).find(
        k =>
          k !== 'messageContextInfo' &&
          k !== 'senderKeyDistributionMessage' &&
          !!(content as any)[k]
      );
      if (!k) return null;
      messageType = k.toUpperCase();
    }

    const context = [
      ext,
      content.imageMessage,
      content.videoMessage,
      content.audioMessage,
      content.documentMessage,
      content.stickerMessage,
      content.locationMessage,
      content.contactMessage,
    ]
      .map(item => item?.contextInfo)
      .find(Boolean);
    if (context) {
      isForwarded = !!context.isForwarded || (context.forwardingScore || 0) > 0;
      if (!replyToWaId && context.stanzaId) replyToWaId = context.stanzaId;
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
      metadata,
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
  private async withMediaPersistenceLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    this.mediaPersistenceLocks ??= new Map();
    const previous = this.mediaPersistenceLocks.get(key);
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    this.mediaPersistenceLocks.set(key, current);
    if (previous) await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.mediaPersistenceLocks.get(key) === current) this.mediaPersistenceLocks.delete(key);
    }
  }

  private async storeMediaBytesOnce(
    messageId: string,
    bytes: Buffer,
    fileType: string,
    mimeType?: string,
    fileName?: string,
    caption?: string
  ): Promise<StoredMediaInfo> {
    const db = await getPool().connect();
    try {
      await db.query('BEGIN');
      const message = await db.query(
        `SELECT id FROM messages WHERE id=$1 AND account=$2 AND platform='whatsapp' FOR UPDATE`,
        [messageId, connectorAccount()]
      );
      if (!message.rows.length) throw new Error('Sent media message row unavailable');
      const existing = await db.query(
        `SELECT file_url, file_size, mime_type, file_name FROM attachments
          WHERE message_id=$1 ORDER BY id DESC LIMIT 1`,
        [messageId]
      );
      if (existing.rows[0]?.file_url) {
        await db.query('COMMIT');
        return {
          storageKey: existing.rows[0].file_url,
          fileSize: Number(existing.rows[0].file_size || 0),
          mimeType: existing.rows[0].mime_type,
          fileName: existing.rows[0].file_name,
        };
      }
      const stored = await uploadMedia(messageId, bytes, mimeType, fileName);
      await db.query(
        `INSERT INTO attachments (message_id, file_type, mime_type, file_name, file_size, file_url, caption)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [messageId, fileType, mimeType, fileName, stored.fileSize, stored.storageKey, caption]
      );
      await db.query('COMMIT');
      return { ...stored, mimeType, fileName };
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }

  private async downloadAndStoreMedia(
    msg: WAMessage,
    messageId: string,
    messageType: string,
    caption?: string
  ): Promise<StoredMediaInfo | null> {
    return this.withMediaPersistenceLock(msg.key?.id || messageId, async () => {
      const existing = await getPool().query(
        `SELECT file_url, file_size, mime_type, file_name FROM attachments
          WHERE message_id=$1 ORDER BY id DESC LIMIT 1`,
        [messageId]
      );
      if (existing.rows[0]?.file_url)
        return {
          storageKey: existing.rows[0].file_url,
          fileSize: Number(existing.rows[0].file_size || 0),
          mimeType: existing.rows[0].mime_type,
          fileName: existing.rows[0].file_name,
        };
      return this.downloadAndStoreMediaUnlocked(msg, messageId, messageType, caption);
    });
  }

  private async downloadAndStoreMediaUnlocked(
    msg: WAMessage,
    messageId: string,
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

    const stored = await this.storeMediaBytesOnce(
      messageId,
      buffer,
      messageType,
      mimeType,
      fileName,
      caption
    );
    this.logger.info(
      `Stored media ${stored.storageKey} (${stored.fileSize} bytes) for msg ${messageId}`
    );
    return stored;
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
   * seen before (cached at ingest time). Returns undefined if we don't have
   * the original — baileys will still send, just without the quote bubble.
   */
  private async buildQuotedFromId(
    replyToMessageId: string | undefined,
    chatJid: string
  ): Promise<WAMessage | undefined> {
    if (!replyToMessageId) return undefined;
    const durable = await getRawWAMessage(replyToMessageId, chatJid).catch(() => undefined);
    if (durable?.message) {
      return {
        ...durable,
        key: { ...durable.key, id: replyToMessageId, remoteJid: chatJid },
      } as WAMessage;
    }
    const cachedKey = this.keyCache.get(replyToMessageId);
    const messageProto =
      this.retryMessageCache.get<proto.IMessage>(replyToMessageId) ||
      (cachedKey
        ? this.retryMessageCache.get<proto.IMessage>(
            this.retryMessageCacheKey(cachedKey.chatJid, replyToMessageId)
          )
        : undefined);
    if (!cachedKey || !messageProto) return undefined;
    return {
      key: { ...cachedKey.key, id: replyToMessageId, remoteJid: chatJid },
      message: messageProto,
    } as WAMessage;
  }

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
    const raw = this.toRawJid(await canonicalConversationId(chatId));
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
    try {
      const sent = await this.sendTextWithTimeout(raw, content, timeoutMs, {
        useCachedGroupMetadata: isGroup ? false : undefined,
        useUserDevicesCache: isGroup ? false : undefined,
        quoted,
        messageId: options?.messageId,
        beforeSend: options?.beforeSend,
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
        await storeRawWAMessage(sent).catch(error =>
          this.logger.warn(
            `durable sent-message store failed for ${messageId}: ${error?.message || error}`
          )
        );
      }
      return messageId || undefined;
    } catch (e: any) {
      if (e instanceof SendAlreadyClaimedError) throw e;
      const failureClass = classifyWhatsAppSendFailure(e);
      this.logger.warn(
        `WhatsApp send attempt failed failureClass=${failureClass} rawJid=${raw} normalizedJid=${normalized} attempt=1 elapsedMs=${Date.now() - started}${groupRepair?.groupSubject ? ` groupSubject="${groupRepair.groupSubject}"` : ''}: ${e?.message || e}`
      );

      if (isGroup && !options?.messageId && this.shouldRetryGroupSend(failureClass)) {
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
          const retried = await this.sendTextWithTimeout(raw, content, timeoutMs, {
            useCachedGroupMetadata: false,
            useUserDevicesCache: false,
            quoted,
          });
          const messageId = retried?.key?.id;
          this.logger.info(
            `WhatsApp group message sent after repair rawJid=${raw} normalizedJid=${normalized} elapsedMs=${Date.now() - started}${messageId ? ` id=${messageId}` : ''}`
          );
          if (retried?.key) {
            this.rememberKey(messageId || '', retried.key, raw);
            this.rememberMessageForRetry(retried.key, retried.message);
            await storeRawWAMessage(retried).catch(error =>
              this.logger.warn(
                `durable retried-message store failed for ${messageId}: ${error?.message || error}`
              )
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
    this.rememberContactName([phone.rawJid, phone.waJid], displayName, 'saved');

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
      asGif?: boolean;
      replyToMessageId?: string;
      fileName?: string;
      messageId?: string;
      beforeSend?: () => Promise<void>;
    }
  ): Promise<string | undefined> {
    if (!this.sock) throw new Error('Client not initialized');
    const raw = this.toRawJid(chatId);
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
    const fileName =
      (
        options?.fileName ||
        (fileUrl.startsWith('data:') ? 'attachment' : fileUrl.split('/').pop()) ||
        'attachment'
      )
        .split(/[\\/]/)
        .pop()!
        // Control characters must not reach the attachment filename.
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, '')
        .slice(0, 240) || 'attachment';

    let payload: AnyMessageContent;
    // Stickers: WhatsApp expects webp; baileys handles conversion when the
    // payload is `{ sticker: buf }` and the bytes are a static webp/animated.
    if (options?.asSticker) {
      if (contentType !== 'image/webp') {
        throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'Sticker payload must be image/webp');
      }
      payload = { sticker: buf };
    } else if (options?.asGif || contentType === 'image/gif') {
      payload = { video: buf, mimetype: contentType || 'image/gif', gifPlayback: true, caption };
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

    const quoted = await this.buildQuotedFromId(options?.replyToMessageId, raw);
    if (options?.replyToMessageId && !quoted) {
      throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'Quoted message is unavailable');
    }
    await options?.beforeSend?.();
    const sent = await this.sock.sendMessage(raw, payload, {
      ...(quoted ? { quoted } : {}),
      ...(options?.messageId ? { messageId: options.messageId } : {}),
    });
    if (sent?.key?.id) {
      try {
        this.rememberKey(sent.key.id, sent.key, raw);
        this.rememberMessageForRetry(sent.key, sent.message);
      } catch (error: any) {
        this.logger.warn(`sent media cache failed for ${sent.key.id}: ${error?.code || 'unknown'}`);
      }
      await storeRawWAMessage(sent).catch(error =>
        this.logger.warn(
          `durable media-message store failed for ${sent.key?.id}: ${error?.message || error}`
        )
      );
      const fileType =
        'image' in payload
          ? 'IMAGE'
          : 'video' in payload
            ? 'VIDEO'
            : 'audio' in payload
              ? 'AUDIO'
              : 'sticker' in payload
                ? 'STICKER'
                : 'DOCUMENT';
      if (sent.message) {
        try {
          await this.persistSentMedia(sent, buf, contentType, fileName, fileType, caption);
        } catch (error: any) {
          // WhatsApp already accepted the message. Keep its receipt so a UI retry cannot send it twice.
          this.logger.error(
            `MEDIA_PERSIST_PENDING provider_message_id=${sent.key.id} error=${error?.code || error?.name || 'unknown'}`
          );
        }
      } else {
        this.logger.error(
          `MEDIA_PERSIST_PENDING provider_message_id=${sent.key.id} error=missing_payload`
        );
      }
    }
    return sent?.key?.id || undefined;
  }

  private async persistSentMedia(
    sent: WAMessage,
    bytes: Buffer,
    mimeType: string,
    fileName: string,
    fileType: string,
    caption?: string
  ): Promise<void> {
    const providerId = sent.key?.id;
    if (!providerId) return;
    await this.ingestMessage(sent, {
      source: 'live',
      publishEvent: false,
      skipMediaDownload: true,
    });
    await this.withMediaPersistenceLock(providerId, async () => {
      const result = await getPool().query(
        `SELECT m.id
           FROM messages m WHERE m.wa_message_id=$1 AND m.account=$2 AND m.platform='whatsapp'`,
        [accountKey(providerId), connectorAccount()]
      );
      const row = result.rows[0];
      if (!row?.id) throw new Error('Sent media could not be persisted');
      await this.storeMediaBytesOnce(row.id, bytes, fileType, mimeType, fileName, caption);
    });
  }

  /** Send an Ogg/Opus clip as a WhatsApp voice note (PTT). */
  async sendVoice(
    chatId: string,
    audio: Buffer,
    mimetype = 'audio/ogg; codecs=opus',
    requestedMessageId?: string,
    beforeSend?: () => Promise<void>
  ): Promise<string | undefined> {
    if (!this.sock) throw new Error('Client not initialized');
    if (!this.isConnected())
      throw new Error(`Client not connected (state=${this.lastState || 'unknown'})`);
    const raw = this.toRawJid(chatId);
    const payload: AnyMessageContent = { audio, mimetype, ptt: true };
    await beforeSend?.();
    const sent = await this.sock.sendMessage(
      raw,
      payload,
      requestedMessageId ? { messageId: requestedMessageId } : undefined
    );
    const messageId = sent?.key?.id;
    if (sent?.key) {
      this.rememberKey(messageId || '', sent.key, raw);
      this.rememberMessageForRetry(sent.key, sent.message);
      await storeRawWAMessage(sent).catch(error =>
        this.logger.warn(
          `durable voice-message store failed for ${messageId}: ${error?.message || error}`
        )
      );
    }
    return messageId || undefined;
  }

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.sock) throw new Error('Client not initialized');
    const cached = this.keyCache.get(messageId);
    let key: WAMessageKey | null = cached?.key || null;
    if (!key) {
      // Reconstruct from BD: we need fromMe / participant. Best effort.
      const fallback = await this.reconstructKeyFromDb(messageId, chatId).catch(() => null);
      if (!fallback) {
        throw new CapabilityError(
          'CAPABILITY_UNSUPPORTED',
          `reactToMessage: message ${messageId} is unavailable`,
          { messageId }
        );
      }
      key = fallback;
    }
    const sent = await this.sock.sendMessage(this.toRawJid(chatId), {
      react: { text: emoji, key },
    });
    await this.persistSentMessage(sent, this.toRawJid(chatId));
    await storeMessageReaction({
      targetMessageId: messageId,
      reactorJid: this.meJid || 'me',
      reactionMessageId: sent?.key?.id || undefined,
      emoji,
    }).catch(error =>
      this.logger.warn(
        `outgoing reaction persistence failed for ${messageId}: ${error?.message || error}`
      )
    );
    this.logger.info(`Reacted with ${emoji} to ${messageId}`);
  }

  async forwardMessage(
    chatId: string,
    messageId: string,
    toChatId: string
  ): Promise<string | undefined> {
    if (!this.sock) throw new Error('Client not initialized');
    const cached = this.keyCache.get(messageId);
    const original =
      (await getRawWAMessage(messageId, cached?.chatJid || this.toRawJid(chatId)).catch(
        () => undefined
      )) || (await getRawWAMessage(messageId).catch(() => undefined));
    if (!original?.message) {
      throw new CapabilityError(
        'CAPABILITY_UNSUPPORTED',
        `forwardMessage: durable message ${messageId} is unavailable`,
        { messageId }
      );
    }
    const forwardable = { ...original, key: { ...original.key, id: messageId } } as WAMessage;
    const rawTarget = this.toRawJid(toChatId);
    const sent = await this.sock.sendMessage(rawTarget, { forward: forwardable });
    await this.persistSentMessage(sent, rawTarget);
    return sent?.key?.id || undefined;
  }

  async editMessage(
    chatId: string,
    messageId: string,
    content: string
  ): Promise<string | undefined> {
    if (!this.sock) throw new Error('Client not initialized');
    if (!content?.trim())
      throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'Edited message content is required');
    const cached = this.keyCache.get(messageId);
    const original = await getRawWAMessage(
      messageId,
      cached?.chatJid || this.toRawJid(chatId)
    ).catch(() => undefined);
    const key =
      original?.key ||
      cached?.key ||
      (await this.reconstructKeyFromDb(messageId, chatId).catch(() => null));
    if (!key)
      throw new CapabilityError(
        'CAPABILITY_UNSUPPORTED',
        `editMessage: message ${messageId} is unavailable`,
        { messageId }
      );
    const raw = this.toRawJid(chatId);
    const sent = await this.sock.sendMessage(raw, { text: content, edit: key });
    await markMessageEdited(messageId, content, 'TEXT');
    await this.persistSentMessage(sent, raw);
    this.emit('message-update', {
      waMessageId: messageId,
      updateType: 'EDITED',
      content,
      messageType: 'TEXT',
    });
    return sent?.key?.id || messageId;
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    if (!this.sock) throw new Error('Client not initialized');
    const cached = this.keyCache.get(messageId);
    let key: WAMessageKey | null = cached?.key || null;
    if (!key) {
      const fallback = await this.reconstructKeyFromDb(messageId, chatId).catch(() => null);
      if (!fallback) throw new Error(`deleteMessage: ${messageId} not found`);
      key = fallback;
    }
    await this.sock.sendMessage(this.toRawJid(chatId), { delete: key });
    await markMessageDeleted(messageId);
    this.emit('message-update', { waMessageId: messageId, updateType: 'DELETED' });
  }

  async deleteMessageForMe(chatId: string, messageId: string): Promise<void> {
    if (!this.sock) throw new Error('Client not initialized');
    const entries = await getMessageKeysForChat(chatId);
    const entry = entries.find(item => item.key.id === messageId);
    if (!entry?.messageTimestamp) {
      throw new CapabilityError(
        'CAPABILITY_UNSUPPORTED',
        `deleteMessageForMe: message ${messageId} has no durable key and timestamp`
      );
    }
    await this.sock.chatModify(
      {
        deleteForMe: { deleteMedia: true, key: entry.key, timestamp: entry.messageTimestamp },
      },
      this.toRawJid(chatId)
    );
    await markMessageDeletedForMe(messageId, chatId);
    this.emit('message-update', { waMessageId: messageId, updateType: 'DELETED_FOR_ME' });
  }

  async markAsRead(chatId: string): Promise<void> {
    if (!this.sock) throw new Error('Client not initialized');
    const raw = this.toRawJid(chatId);
    const entries = await getMessageKeysForChat(chatId, { unreadOnly: true });
    const keys = entries.map(entry => entry.key);
    if (keys.length) await this.sock.readMessages(keys);
    const norm = this.normalizeJid(raw);
    const chat = this.chatStore.get(norm);
    if (chat) chat.unreadCount = 0;
    await setConversationState(norm, 0);
    await upsertChatState(norm, { unreadCount: 0 });
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
      archived: c.archived,
      pinned: c.pinned,
      muteUntil: c.muteUntil,
      starred: c.starred,
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

  async startChat(phone: string): Promise<{ id: string; name: string; phone: string }> {
    if (!this.sock || !this.isConnected()) throw new Error('Client not connected');
    const normalized = normalizePhoneForWhatsApp(phone);
    if (!normalized)
      throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'A valid phone number is required');
    const results = await this.sock.onWhatsApp(normalized.rawJid);
    const found = results?.find(item => item.exists && item.jid);
    if (!found)
      throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'Recipient is not on WhatsApp');
    const id = this.normalizeJid(found.jid);
    const name = this.contactNameFor(found.jid, id) || normalized.phoneE164;
    await ensureEmptyConversation(id, name);
    return { id, name, phone: normalized.phoneE164 };
  }

  async getGroupInfo(groupId: string): Promise<any> {
    const raw = this.toRawJid(groupId);
    const meta = await this.fetchGroupMetadata(raw);
    const ownPn = this.sock?.user?.id ? jidNormalizedUser(this.sock.user.id) : null;
    const ownLid =
      (this.sock?.user as { lid?: string } | undefined)?.lid ||
      (ownPn ? await this.sock?.signalRepository?.lidMapping?.getLIDForPN?.(ownPn) : null);
    const ownIds = new Set(
      [ownPn, ownLid].filter((id): id is string => !!id).map(jidNormalizedUser)
    );
    const self = meta.participants.find(p =>
      [p.id, p.phoneNumber].some(id => !!id && ownIds.has(jidNormalizedUser(id)))
    );
    const isAdmin = self?.admin === 'admin' || self?.admin === 'superadmin';
    const stored = await listStoredContacts(5000);
    const names = new Map<string, string>();
    for (const contact of stored) {
      if (!contact.name) continue;
      names.set(contact.jid, contact.name);
      names.set(this.normalizeJid(contact.jid), contact.name);
      names.set(this.toRawJid(contact.jid), contact.name);
    }
    const participants = meta.participants.map(p => ({
      id: this.normalizeJid(p.id),
      name:
        this.contactNameFor(p.id, p.phoneNumber || '') ||
        names.get(p.id) ||
        names.get(p.phoneNumber || '') ||
        p.name ||
        p.notify ||
        p.verifiedName ||
        this.normalizeJid(p.id),
      pushName: p.notify || null,
      isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
      isSuperAdmin: p.admin === 'superadmin',
      hasPhoto: !!p.imgUrl,
    }));
    for (const participant of meta.participants) {
      void storeContact({
        jid: participant.id,
        phone: this.phoneFromJid(participant.phoneNumber || participant.id),
        name: participant.name || participant.verifiedName,
        pushName: participant.notify,
        avatarUrl: participant.imgUrl || null,
      }).catch(() => {});
    }
    const photoUrl = await this.profilePictureUrlIfAvailable(raw).catch(() => null);
    return {
      id: this.normalizeJid(meta.id),
      name: meta.subject,
      description: meta.desc || '',
      participantCount: meta.participants.length,
      createdAt: meta.creation,
      owner: meta.owner ? this.normalizeJid(meta.owner) : null,
      participants,
      capabilities: {
        manageMembers: isAdmin,
        editInfo: !!self && (isAdmin || meta.restrict === false),
      },
      hasPhoto: photoUrl === null ? null : !!photoUrl,
      photoLookupStatus: photoUrl === null ? 'unavailable' : 'confirmed',
    };
  }

  async getGroupParticipants(groupId: string): Promise<any[]> {
    const raw = this.toRawJid(groupId);
    const meta = await this.fetchGroupMetadata(raw);
    return meta.participants.map(p => ({
      id: this.normalizeJid(p.id),
      name: p.name || p.notify || p.verifiedName || this.normalizeJid(p.id),
      pushName: p.notify || null,
      phone: p.phoneNumber || this.phoneFromJid(p.id) || null,
      hasPhoto: !!p.imgUrl,
      isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
      isSuperAdmin: p.admin === 'superadmin',
    }));
  }

  async createGroup(subject: string, participants: string[]): Promise<any> {
    if (!this.sock) throw new Error('Client not initialized');
    if (!this.isConnected())
      throw new Error(`Client not connected (state=${this.lastState || 'unknown'})`);
    const cleanSubject = subject.trim();
    const members = Array.from(
      new Set(participants.map(p => this.toParticipantJid(p)).filter(Boolean))
    );
    if (!cleanSubject || !members.length) {
      throw new CapabilityError(
        'INVALID_CAPABILITY_INPUT',
        'Group subject and at least one participant are required'
      );
    }
    const meta = await this.sock.groupCreate(cleanSubject, members);
    this.cacheGroupMetadata(meta);
    return this.getGroupInfo(meta.id);
  }

  async updateGroup(
    groupId: string,
    updates: {
      subject?: string;
      description?: string;
      setting?: 'announcement' | 'not_announcement' | 'locked' | 'unlocked';
    }
  ): Promise<any> {
    if (!this.sock) throw new Error('Client not initialized');
    const raw = this.toRawJid(groupId);
    let changed = false;
    if (updates.subject !== undefined) {
      await this.sock.groupUpdateSubject(raw, updates.subject.trim());
      changed = true;
    }
    if (updates.description !== undefined) {
      await this.sock.groupUpdateDescription(raw, updates.description);
      changed = true;
    }
    if (updates.setting !== undefined) {
      await this.sock.groupSettingUpdate(raw, updates.setting);
      changed = true;
    }
    if (!changed)
      throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'No group update was provided');
    this.groupMetaCache.delete(raw);
    return this.getGroupInfo(raw);
  }

  async updateGroupParticipants(
    groupId: string,
    participants: string[],
    action: 'add' | 'remove' | 'promote' | 'demote'
  ): Promise<unknown> {
    if (!this.sock) throw new Error('Client not initialized');
    if (!['add', 'remove', 'promote', 'demote'].includes(action)) {
      throw new CapabilityError(
        'CAPABILITY_UNSUPPORTED',
        `Unsupported group participant action: ${action}`,
        { action }
      );
    }
    const raw = this.toRawJid(groupId);
    const members = Array.from(
      new Set(participants.map(p => this.toParticipantJid(p)).filter(Boolean))
    );
    if (!members.length)
      throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'At least one participant is required');
    const result = await this.sock.groupParticipantsUpdate(raw, members, action);
    this.groupMetaCache.delete(raw);
    return result.map(entry => ({
      ...entry,
      jid: entry.jid ? this.normalizeJid(entry.jid) : entry.jid,
    }));
  }

  async listContacts(limit = 500): Promise<unknown[]> {
    return listStoredContacts(limit);
  }

  async createContact(input: {
    jid?: string;
    phone?: string;
    name: string;
    organization?: string;
    email?: string;
  }): Promise<unknown> {
    if (!this.sock) throw new Error('Client not initialized');
    const jid = this.toParticipantJid(input.jid || input.phone || '');
    if (!jid || !input.name?.trim()) {
      throw new CapabilityError(
        'INVALID_CAPABILITY_INPUT',
        'Contact name and jid/phone are required'
      );
    }
    const existing = await (this.sock as any).onWhatsApp(jid).catch(() => []);
    if (Array.isArray(existing) && existing[0]?.exists === false) {
      throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'Contact is not on WhatsApp', {
        jid: this.normalizeJid(jid),
      });
    }
    await this.sock.addOrEditContact(jid, {
      fullName: input.name.trim(),
      firstName: input.name.trim(),
      pnJid: jid,
      saveOnPrimaryAddressbook: true,
    } as any);
    const contact = {
      jid: this.normalizeJid(jid),
      phone: this.phoneFromJid(jid),
      name: input.name.trim(),
      organization: input.organization || null,
      email: input.email || null,
    };
    await storeContact(contact);
    this.rememberContactName([jid, this.normalizeJid(jid)], input.name, 'saved');
    return contact;
  }

  async shareContact(
    chatId: string,
    input: { displayName: string; phone: string; organization?: string; email?: string }
  ): Promise<string | undefined> {
    if (!this.sock) throw new Error('Client not initialized');
    const sent = await this.sock.sendMessage(this.toRawJid(chatId), buildContactMessage(input));
    await this.persistSentMessage(sent, this.toRawJid(chatId));
    return sent?.key?.id || undefined;
  }

  async sendPoll(chatId: string, input: PollMessageInput): Promise<string | undefined> {
    if (!this.sock) throw new Error('Client not initialized');
    const raw = this.toRawJid(chatId);
    const sent = await this.sock.sendMessage(raw, buildPollMessage(input));
    await this.persistSentMessage(sent, raw);
    return sent?.key?.id || undefined;
  }

  /**
   * Send a poll vote. rc13's `sendMessage` cannot build `pollUpdateMessage`
   * content (it falls through to `prepareWAMessageMedia` and throws), so the
   * proto message is built here with the vote encrypted against the stored
   * poll encKey and relayed directly, the same way Baileys sends its own
   * control messages.
   */
  async sendPollVote(
    chatId: string,
    input: { pollMessageId: string; options: unknown }
  ): Promise<string | undefined> {
    if (!this.sock) throw new Error('Client not initialized');
    if (!this.isConnected()) throw new Error('Client not connected');
    const pollMessageId = typeof input.pollMessageId === 'string' ? input.pollMessageId.trim() : '';
    if (!pollMessageId)
      throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'pollMessageId is required');
    const stored = await getRawWAMessage(pollMessageId, chatId);
    if (!stored?.key?.id)
      throw new CapabilityError(
        'POLL_NOT_FOUND',
        'Poll creation message is not in durable storage',
        {
          pollMessageId,
        }
      );
    const details = parsePollCreationContent(stored.message);
    if (!details)
      throw new CapabilityError('POLL_NOT_FOUND', 'Stored message is not a poll creation message', {
        pollMessageId,
      });
    const pollEncKey = pollEncKeyFromStoredMessage(stored.message);
    if (!pollEncKey)
      throw new CapabilityError(
        'POLL_ENCRYPTION_KEY_UNAVAILABLE',
        'The poll encKey (messageSecret) was never captured for this poll, so a compatible vote cannot be built',
        { pollMessageId }
      );
    const optionNames = validatePollVoteSelection(details, input.options);
    const meId = this.meJid || (this.sock.user?.id ? jidNormalizedUser(this.sock.user.id) : null);
    if (!meId) throw new Error('Client not connected');
    const content = buildPollVoteContent({
      pollCreationKey: stored.key,
      pollEncKey,
      optionNames,
      meJid: meId,
    });
    const raw = this.toRawJid(chatId);
    const messageId = generateMessageIDV2(this.sock.user?.id);
    const fullMsg = generateWAMessageFromContent(raw, content, { messageId, userJid: meId });
    await this.sock.relayMessage(raw, fullMsg.message as proto.IMessage, { messageId });
    await this.persistSentMessage(fullMsg, raw);
    return fullMsg.key.id || messageId;
  }

  /**
   * Poll results from locally captured votes only. Counts are a real lower
   * bound (what this connector stored), never extrapolated; `availability`
   * tells the app how much to trust them. Ids are echoed exactly as sent.
   */
  async getPollResults(chatId: string, pollMessageIds: string[]): Promise<PollResultsEntry[]> {
    const unique = Array.from(new Set(pollMessageIds));
    const [creations, updates] = await Promise.all([
      getRawWAMessagesByIds(unique, chatId),
      listCapturedPollUpdates(unique, chatId),
    ]);
    const creationById = new Map(creations.map(row => [row.waMessageId, row]));
    const updatesByPoll = new Map<string, StoredPollUpdate[]>();
    for (const row of updates) {
      const normalized = normalizeMessageContent(
        row.content && typeof row.content === 'object'
          ? (row.content as Parameters<typeof normalizeMessageContent>[0])
          : undefined
      );
      const pollId = normalized?.pollUpdateMessage?.pollCreationMessageKey?.id;
      if (!pollId || !unique.includes(pollId)) continue;
      const list = updatesByPoll.get(pollId) || [];
      list.push({ key: row.key, content: row.content });
      updatesByPoll.set(pollId, list);
    }
    const meId = this.meJid;
    const entries: PollResultsEntry[] = [];
    for (const pollMessageId of unique) {
      const base: PollResultsEntry = {
        pollMessageId,
        question: null,
        selectableCount: null,
        available: false,
        availability: 'unavailable',
        reason: 'NO_LOCAL_DATA',
        totalVoters: 0,
        capturedVotes: 0,
        decryptionFailures: 0,
        options: [],
      };
      const row = creationById.get(pollMessageId);
      if (!row) {
        entries.push(base);
        continue;
      }
      const details = parsePollCreationContent(row.content);
      if (!details) {
        entries.push({ ...base, reason: 'NOT_A_POLL' });
        continue;
      }
      base.question = details.question || null;
      base.selectableCount = details.selectableCount;
      base.options = details.options.map(name => ({ name, count: 0, selectedByMe: false }));
      const pollEncKey = pollEncKeyFromStoredMessage(row.content);
      if (!pollEncKey) {
        entries.push({ ...base, reason: 'ENCRYPTION_KEY_UNAVAILABLE' });
        continue;
      }
      const decrypted = decryptCapturedPollVotes(updatesByPoll.get(pollMessageId) || [], {
        pollMsgId: pollMessageId,
        pollEncKey,
        meJid: meId,
      });
      const aggregate = aggregateCapturedPollVotes(details, decrypted.votes);
      entries.push({
        ...base,
        available: true,
        // Votes can be missed while this connector was offline, so counts are
        // always a lower bound: never claim a complete ("full") snapshot.
        availability: 'local_partial',
        reason: null,
        totalVoters: aggregate.totalVoters,
        capturedVotes: aggregate.capturedVotes,
        decryptionFailures: decrypted.undecryptable,
        options: aggregate.options,
      });
    }
    return entries;
  }

  async sendEvent(chatId: string, input: EventMessageInput): Promise<string | undefined> {
    if (!this.sock) throw new Error('Client not initialized');
    const raw = this.toRawJid(chatId);
    const sent = await this.sock.sendMessage(raw, buildEventMessage(input));
    await this.persistSentMessage(sent, raw);
    return sent?.key?.id || undefined;
  }

  async modifyChat(
    chatId: string,
    action: string,
    value?: unknown,
    messageIds: Array<{ id: string; fromMe?: boolean }> = []
  ): Promise<{ action: string; applied: boolean }> {
    if (!this.sock) throw new Error('Client not initialized');
    const normalized = action.trim().toLowerCase().replace(/_/g, '-');
    if (normalized === 'read' || normalized === 'mark-read') {
      await this.markAsRead(chatId);
      return { action: 'read', applied: true };
    }
    const keys = await getMessageKeysForChat(chatId);
    const lastMessages = keys.map(entry => ({
      key: entry.key,
      messageTimestamp: entry.messageTimestamp,
    })) as any;
    const modification = buildChatModification(action, value, lastMessages, messageIds);
    await this.sock.chatModify(modification, this.toRawJid(chatId));
    const patch =
      normalized === 'archive' || normalized === 'unarchive'
        ? { archived: normalized === 'archive' }
        : normalized === 'pin' || normalized === 'unpin'
          ? { pinned: normalized === 'pin' }
          : normalized === 'mute'
            ? { muteUntil: Number(value) }
            : normalized === 'unmute'
              ? { muteUntil: null }
              : normalized === 'star' || normalized === 'unstar'
                ? { starred: normalized === 'star' }
                : {};
    await upsertChatState(chatId, patch);
    const chat = this.chatStore.get(this.normalizeJid(this.toRawJid(chatId)));
    if (chat) Object.assign(chat, patch);
    return { action: normalized, applied: true };
  }

  async subscribePresence(chatId: string): Promise<{ subscribed: boolean; chatId: string }> {
    if (!this.sock) throw new Error('Client not initialized');
    const raw = this.toRawJid(chatId);
    await this.sock.presenceSubscribe(raw);
    this.presenceSubscribed.add(raw);
    return { subscribed: true, chatId: this.normalizeJid(raw) };
  }

  async updatePresence(
    chatId: string | undefined,
    status: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused'
  ): Promise<{ status: string; chatId?: string }> {
    if (!this.sock) throw new Error('Client not initialized');
    if (!['available', 'unavailable', 'composing', 'recording', 'paused'].includes(status)) {
      throw new CapabilityError(
        'INVALID_CAPABILITY_INPUT',
        `Unsupported presence state: ${status}`
      );
    }
    const raw = chatId ? this.toRawJid(chatId) : undefined;
    await this.sock.sendPresenceUpdate(status, raw);
    return { status, ...(raw ? { chatId: this.normalizeJid(raw) } : {}) };
  }

  async getPresence(
    chatId: string,
    participantId?: string
  ): Promise<ReturnType<typeof buildPresenceSnapshot>> {
    const normalizedChat = this.normalizeJid(this.toRawJid(chatId));
    const normalizedParticipant = participantId
      ? this.normalizeJid(this.toRawJid(participantId))
      : undefined;
    const fresh = (key: string) => {
      const value = this.presenceState.get(key);
      if (value && Date.now() - value.observedAt > 60_000) {
        this.presenceState.delete(key);
        return undefined;
      }
      return value;
    };
    let state = fresh(`${normalizedChat}:${normalizedParticipant || normalizedChat}`);
    if (!state && !normalizedParticipant) {
      const prefix = `${normalizedChat}:`;
      for (const key of this.presenceState.keys()) {
        if (!key.startsWith(prefix)) continue;
        state = fresh(key);
        if (state) break;
      }
    }
    return buildPresenceSnapshot(
      normalizedChat,
      state
        ? {
            lastKnownPresence: state.status as any,
            ...(state.lastSeen === undefined ? {} : { lastSeen: state.lastSeen }),
          }
        : undefined,
      normalizedParticipant || state?.participantId
    );
  }

  async getPrivacySettings(): Promise<Record<string, string>> {
    if (!this.sock) throw new Error('Client not initialized');
    return this.sock.fetchPrivacySettings(true);
  }

  async updatePrivacy(field: string, value: string): Promise<{ field: string; value: string }> {
    if (!this.sock) throw new Error('Client not initialized');
    const update = buildPrivacyUpdate(field, value);
    await (this.sock as any)[update.method](update.value);
    return { field, value };
  }

  async setDefaultDisappearing(expiration: number): Promise<{ field: string; value: number }> {
    if (!this.sock) throw new Error('Client not initialized');
    if (!Number.isInteger(expiration) || expiration < 0) {
      throw new CapabilityError(
        'INVALID_CAPABILITY_INPUT',
        'Default disappearing expiration must be a non-negative integer'
      );
    }
    await this.sock.updateDefaultDisappearingMode(expiration);
    return { field: 'defaultDisappearing', value: expiration };
  }

  async setDisappearing(
    chatId: string,
    expiration: number | boolean
  ): Promise<{ chatId: string; expiration: number | boolean }> {
    if (!this.sock) throw new Error('Client not initialized');
    if (typeof expiration !== 'boolean' && (!Number.isInteger(expiration) || expiration < 0)) {
      throw new CapabilityError(
        'INVALID_CAPABILITY_INPUT',
        'Disappearing expiration must be a non-negative integer or false'
      );
    }
    const raw = this.toRawJid(chatId);
    if (this.isGroupJid(raw))
      await this.sock.groupToggleEphemeral(raw, expiration === false ? 0 : Number(expiration));
    else await this.sock.sendMessage(raw, { disappearingMessagesInChat: expiration });
    return { chatId: this.normalizeJid(raw), expiration };
  }

  async getDisappearing(
    chatId: string
  ): Promise<{ chatId: string; expiration?: number; known: boolean }> {
    if (!this.sock) throw new Error('Client not initialized');
    const raw = this.toRawJid(chatId);
    const results = await this.sock.fetchDisappearingDuration(raw).catch(() => undefined);
    const first: any = Array.isArray(results) ? results[0] : undefined;
    // Baileys' USync protocol is exposed as `disappearing_mode: { duration }`;
    // retain fallbacks for older socket shapes used by deployed versions.
    const mode = first?.disappearing_mode || first?.disappearingMode;
    const expiration = mode?.duration ?? mode?.ephemeralExpiration ?? first?.ephemeralExpiration;
    return {
      chatId: this.normalizeJid(raw),
      ...(typeof expiration === 'number' ? { expiration } : {}),
      known: typeof expiration === 'number',
    };
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
   * Returns null only when WhatsApp explicitly reports no visible picture.
   */
  async getProfilePictureBytes(jid: string): Promise<Buffer | null> {
    if (!this.sock) return null;
    const raw = this.toRawJid(jid);
    let url: string | undefined;
    try {
      url = await boundedProfilePictureUrl(timeoutMs =>
        this.sock!.profilePictureUrl(raw, 'image', timeoutMs)
      );
    } catch (e) {
      if (isUnavailableProfilePicture(e)) return null;
      throw e;
    }
    if (!url) return null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !this.isAllowedWhatsAppMediaHost(parsed.hostname)) {
        throw new ProfilePictureDownloadError('WhatsApp returned an invalid profile picture URL');
      }
      const signal = AbortSignal.timeout(10_000);
      const r = await fetch(url, { redirect: 'manual', signal });
      if (!r.ok || !r.body)
        throw new ProfilePictureDownloadError(
          `WhatsApp profile picture download failed (${r.status})`
        );
      const length = Number(r.headers.get('content-length') || 0);
      const maxBytes = 10 * 1024 * 1024;
      if (length > maxBytes)
        throw new ProfilePictureDownloadError('WhatsApp profile picture exceeds 10 MB');
      const reader = r.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes)
            throw new ProfilePictureDownloadError('WhatsApp profile picture exceeds 10 MB');
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
        if (size > maxBytes) await r.body.cancel().catch(() => {});
      }
      return Buffer.concat(chunks, size);
    } catch (e) {
      if (e instanceof ProfilePictureDownloadError) throw e;
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw new ProfilePictureTimeoutError();
      }
      throw new ProfilePictureDownloadError('WhatsApp profile picture download failed');
    }
  }

  private async profilePictureUrlIfAvailable(rawJid: string): Promise<string | undefined> {
    if (!this.sock) return undefined;
    try {
      return await boundedProfilePictureUrl(timeoutMs =>
        this.sock!.profilePictureUrl(rawJid, 'preview', timeoutMs)
      );
    } catch (error) {
      if (isUnavailableProfilePicture(error)) return undefined;
      throw error;
    }
  }

  private isAllowedWhatsAppMediaHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/\.$/, '');
    return (
      host === 'whatsapp.net' ||
      host.endsWith('.whatsapp.net') ||
      host === 'fbcdn.net' ||
      host.endsWith('.fbcdn.net')
    );
  }

  private async persistSentMessage(sent: WAMessage | undefined, rawJid: string): Promise<void> {
    if (!sent?.key?.id) return;
    this.rememberKey(sent.key.id, sent.key, rawJid);
    this.rememberMessageForRetry(sent.key, sent.message);
    await storeRawWAMessage(sent).catch(error =>
      this.logger.warn(
        `durable sent-message store failed for ${sent.key?.id}: ${error?.message || error}`
      )
    );
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
        archived: c.archived,
        pinned: c.pinned,
        muteUntil: c.muteUntil,
        starred: c.starred,
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

  async previewArchiveSnapshot(): Promise<{
    version: number;
    records: number;
    chats: number;
    archived: number;
  }> {
    if (!this.sock || !this.isConnected()) throw new Error('Client not connected');
    const snapshot = await readArchiveSnapshot(this.sock);
    return {
      version: snapshot.version,
      records: snapshot.records,
      chats: snapshot.states.size,
      archived: [...snapshot.states.values()].filter(Boolean).length,
    };
  }

  syncArchiveSnapshot(): Promise<{
    version: number;
    records: number;
    chats: number;
    archived: number;
    created: number;
  }> {
    const socket = this.sock;
    if (!socket || !this.isConnected()) return Promise.reject(new Error('Client not connected'));
    if (this.archiveSnapshotSync?.socket === socket) return this.archiveSnapshotSync.promise;
    if (this.archiveSnapshotSync) {
      return this.archiveSnapshotSync.promise
        .catch(() => undefined)
        .then(() => this.syncArchiveSnapshot());
    }
    const run = this.performArchiveSnapshotSync();
    this.archiveSnapshotSync = { socket, promise: run };
    void run.then(
      () => {
        if (this.archiveSnapshotSync?.promise === run) this.archiveSnapshotSync = null;
      },
      () => {
        if (this.archiveSnapshotSync?.promise === run) this.archiveSnapshotSync = null;
      }
    );
    return run;
  }

  private async performArchiveSnapshotSync(): Promise<{
    version: number;
    records: number;
    chats: number;
    archived: number;
    created: number;
  }> {
    const socket = this.sock;
    if (!socket || !this.isConnected()) throw new Error('Client not connected');
    const startedAt = new Date();
    const snapshot = await readCurrentArchiveSnapshot(socket, () => this.sock);
    if (!this.isConnected()) throw new Error('Client disconnected during archive snapshot');
    const chats = [...snapshot.states].map(([jid, archived]) => {
      const normalized = this.normalizeJid(jid);
      const aliases = [
        ...(this.contactAliasGroups.get(jid) || this.contactAliasGroups.get(normalized) || []),
      ];
      const cached = this.chatStore.get(normalized);
      const name = this.contactNameFor(jid, normalized) || cached?.name;
      return { jid: normalized, aliases, name, archived };
    });
    await enrichArchiveGroupNames(
      chats,
      async jid => {
        const cached = this.groupMetaCache.get(jid);
        if (cached?.subject) return cached.subject;
        const meta = await socket.groupMetadata(jid);
        if (this.sock === socket) this.cacheGroupMetadata(meta);
        return meta.subject;
      },
      { isCurrent: () => this.sock === socket && this.isConnected() }
    );
    if (this.sock !== socket || !this.isConnected()) {
      throw new Error('WhatsApp socket changed during archive name lookup');
    }
    const applied = await applyArchiveSnapshot(chats, startedAt);
    for (const chat of chats) {
      const cached = this.chatStore.get(chat.jid);
      if (cached) cached.archived = chat.archived;
    }
    return {
      version: snapshot.version,
      records: snapshot.records,
      chats: chats.length,
      archived: applied.archived,
      created: applied.created,
    };
  }

  private async fetchGroupMetadata(rawJid: string, force = false): Promise<GroupMetadata> {
    if (!this.isGroupJid(rawJid)) {
      throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'A group JID is required');
    }
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
    const requestedCursors = new Set<string>();
    const cursorKey = (row: { conversation_id: string; wa_message_id: string }) =>
      JSON.stringify([row.conversation_id, row.wa_message_id]);

    const pool = getPool();
    const loadOldest = async () => {
      const params: any[] = [connectorAccount()];
      const where = `WHERE m.account = $1 AND m.platform = 'whatsapp'${
        options.chatId ? ' AND k.conversation_id = $2' : ''
      }`;
      // whatsapp_message_keys.conversation_id is stored namespaced (see accountKey
      // in storeMessageKey); the caller filters by a bare chatId, so namespace it
      // or professional matches zero rows.
      // Preserve the caller's stored conversation identity here. Historical
      // key rows may use the native @s.whatsapp.net form even though newer
      // ingest rows use @c.us; the account namespace is the only required
      // transformation for this cursor query.
      if (options.chatId) params.push(accountKey(options.chatId));
      params.push(maxChats);
      const limitParam = `$${params.length}`;
      return pool.query(
        `SELECT DISTINCT ON (k.conversation_id)
            k.conversation_id, k.wa_message_id, k.remote_jid, k.from_me,
            k.participant_jid, k.message_timestamp_ms
         FROM whatsapp_message_keys k
         JOIN messages m ON m.wa_message_id = k.wa_message_id
         ${where}
         ORDER BY k.conversation_id, k.message_timestamp_ms ASC
         LIMIT ${limitParam}`,
        params
      );
    };

    for (let batch = 0; batch < maxBatchesPerChat; batch++) {
      let rows = (await loadOldest()).rows;
      // History arrives asynchronously. Wait briefly for older keys, and never
      // spend another request on a cursor already sent during this run.
      if (batch > 0) {
        for (let poll = 0; poll < 10; poll++) {
          if (rows.some(row => !requestedCursors.has(cursorKey(row)))) break;
          await new Promise(resolve => setTimeout(resolve, 1500));
          rows = (await loadOldest()).rows;
        }
        rows = rows.filter(row => !requestedCursors.has(cursorKey(row)));
      }
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
          Number(row.message_timestamp_ms)
        );
        requested += 1;
        requestedCursors.add(cursorKey(row));
        await recordHistorySyncProgress({
          conversationId: bareConversationId,
          oldestMessageId: bareWaMessageId,
          oldestTimestamp,
          insertedCount: 0,
          status: 'requested',
        });
      }

      if (options.dryRun || maxBatchesPerChat === 1) break;
    }

    return { requested, candidates };
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
      // The caller may hand us either the WhatsApp message id or the UUID
      // messages.id (social_list_messages exposes both `waMessageId` and `id`).
      // messages.wa_message_id is stored namespaced, so namespace the wa id ($1) or
      // professional finds no attachment row; messages.id is the global UUID PK
      // and is never namespaced, so match it raw ($2). Mirrors the dual lookup the
      // MCP server already does for get_messages (wa_message_id OR id::text).
      // Scope both lookup branches to this connector's account and channel.
      // Account names can also exist on Instagram in the shared database.
      const r = await pool.query(
        `SELECT a.file_url, a.mime_type, a.file_name
           FROM attachments a JOIN messages m ON m.id = a.message_id
          WHERE (m.wa_message_id = $1 OR m.id::text = $2) AND m.account = $3
            AND m.platform = 'whatsapp'
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
      qrUrl: qrPageUrl(),
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
    const bare = stripAccountKey(jid);
    if (bare.endsWith('@c.us')) return bare.replace('@c.us', '@s.whatsapp.net');
    return bare; // groups stay `@g.us`, broadcasts stay `@broadcast`
  }

  private toParticipantJid(value: string): string {
    const trimmed = value.trim();
    if (/^\+?\d{6,18}$/.test(trimmed)) {
      return `${trimmed.replace(/^\+/, '')}@s.whatsapp.net`;
    }
    return this.toRawJid(trimmed);
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
    if (meta.subject && !isWhatsAppJidLikeName(meta.subject, normalized)) {
      void setConversationName(normalized, meta.subject).catch(() => {});
    }
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

    const durable = await getRawWAMessage(messageId, remoteJid || undefined).catch(() => undefined);
    if (durable?.message) {
      this.logger.debug(
        `WhatsApp durable retry message hit remoteJid=${remoteJid || 'unknown'} messageId=${messageId}`
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
      beforeSend?: () => Promise<void>;
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
    await options?.beforeSend?.();
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
