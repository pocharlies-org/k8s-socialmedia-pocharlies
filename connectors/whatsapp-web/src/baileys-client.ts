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
  MiscMessageGenerationOptions,
  Chat,
  ChatModification,
  WAPatchCreate,
  GroupMetadata,
  GroupParticipant,
  Browsers,
  generateMessageIDV2,
  generateWAMessageFromContent,
  normalizeMessageContent,
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
  setMessageStatus,
  setConversationWaChatId,
  getUnreadMessageKeysForChat,
  markMessagesRead,
  participantDisplayName,
} from './db-writer';
import {
  appendMediaEligible,
  documentFileName,
  isOfficialWhatsAppJid,
  linksSenderToChat,
  OFFICIAL_WHATSAPP_NAME,
  quotedReply,
} from './ingest-extras';
import {
  DurablePayloadSource,
  getRawWAMessage,
  MessageUnavailableError,
  storeRawWAMessage,
  unixSeconds,
} from './durable-message-store';
import {
  loadEditedContent,
  loadStoredMessage,
  markMessageDeletedForMe,
  markMessageEdited,
  markMessageRevoked,
  MessageMutationError,
  StoredMessage,
  withEditedText,
} from './message-mutations';
import { reactionTime, storeMessageReaction } from './message-reactions';
import {
  isPinAction,
  listPinnedMessages,
  listStarredMessages,
  MAX_PINS_PER_CHAT,
  pinActionOf,
  pinContent,
  PinnedMessage,
  PinRequest,
  recordMessagePin,
  recordMessageStar,
  StarredList,
  StarredQuery,
  starPatch,
} from './message-stars-pins';
import {
  channelPostMessageId,
  contactAuthorIds,
  ChannelPostList,
  ChannelPostsQuery,
  isChannelJid,
  isStatusJid,
  listChannelPosts,
  listStatuses,
  noteRevokeBeforePost,
  recordStatus,
  STATUS_IMAGE_MAX_BYTES,
  STATUS_IMAGE_MIME_TYPES,
  STATUS_JID,
  STATUS_MESSAGE_TYPES,
  StatusList,
  StatusListQuery,
  statusPublishEnabled,
  StatusPublishRequest,
  statusRecipientJid,
  STATUS_TTL_MS,
  takeRevokeBeforePost,
} from './statuses';
import {
  buildPollContent,
  buildPollVoteContent,
  cryptoUserJid,
  decryptPollVoteWith,
  int64Ms,
  keyAuthorCandidates,
  messageSecretOf,
  optionHash,
  OwnIdentity,
  parsePollDefinition,
  PollEventInputError,
  pollSigningPair,
  selectedOptionNames,
  validatePollSelection,
  ValidatedPoll,
} from './poll-votes';
import {
  buildEventContent,
  buildEventResponseContent,
  decryptEventResponseWith,
  EventResponse,
  parseEventDefinition,
  ValidatedEvent,
} from './event-responses';
import {
  aggregateEventResults,
  aggregatePollResults,
  EventResults,
  loadStructuredMetadata,
  PollResults,
  readEventResponses,
  readPollVotes,
  storeEventResponse,
  storePollVote,
} from './poll-event-store';
import {
  CanonicalConversation,
  ChatState,
  ChatStatePatch,
  externalIdCandidates,
  latestMessageId,
  muteEndTimestamp,
  muteFromBaileys,
  MuteState,
  hasInboundHistory,
  hasOutboundHistory,
  pinFromBaileys,
  resolveCanonicalConversation,
  setCanonicalChatState,
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
  isAdminRole,
  isCommunityGroup,
  normalizeGroupJid,
  normalizeGroupParticipantAction,
  ownParticipant,
  parseGroupJid,
  parseGroupParticipants,
  parseGroupSubject,
  parseGroupUpdate,
  participantApiJid,
  participantIds,
  participantOutcome,
  participantsIncludeOwn,
  addRequestOf,
  AddRequest,
  GroupInviteResult,
  InviteRequiredEntry,
  LINK_INVITE_TTL_SECONDS,
  parseGroupInviteParticipants,
  parseGroupInviteText,
  recordGroupChange,
  recordGroupConversation,
  recordInboundGroup,
  toParticipantJid,
} from './group-management';
import {
  CommunityActionError,
  communityCapabilities,
  CommunityGroupAction,
  communityView,
  CommunityView,
  isCommunityParent,
  isLinkedTo,
  LinkedGroupEntry,
  parseCommunityDescription,
  parseCommunityGroupRequest,
  parseCommunityJid,
  parseCommunitySubject,
} from './communities';
import {
  ChannelActionError,
  CHANNELS_LIST_MAX,
  channelStateMatches,
  ChannelSubscriptionAction,
  channelView,
  ChannelView,
  forgetChannel,
  KeyedSerializer,
  knownChannelConversations,
  normalizeChannelJid,
  parseChannelJid,
  parseChannelQuery,
  parseChannelSubscriptionAction,
  rememberChannel,
  rememberedChannels,
} from './channels';
import { maybeRunRetention } from './retention';
import {
  availablePresenceAllowed,
  ChatPresenceState,
  isChatPresenceState,
  OutgoingPresenceState,
  PresenceCache,
  PresenceSendThrottle,
  PresenceView,
} from './presence';
import { createHash } from 'crypto';
import {
  audioMessagePayload,
  checkMediaOptions,
  MediaQuality,
  parseMediaQuality,
  parseViewOnce,
  prepareImageQuality,
} from './media-quality';
import {
  applyProfileUpdates,
  OwnProfilePhotoProvider,
  ProfileIo,
  ProfileUpdateInput,
  ProfileUpdateResult,
  readOwnProfile,
  readOwnProfilePhotoBytes,
  removeOwnProfilePhoto,
  setOwnProfilePhoto,
} from './profile-service';
import {
  buildPrivacyUpdate,
  currentPrivacyValue,
  PrivacyView,
  privacyView,
} from './privacy-settings';
import {
  disappearingLabel,
  ephemeralFromBaileys,
  groupEphemeral,
  parseDisappearingExpiration,
  readConversationEphemeral,
  recordInboundEphemeral,
  withEphemeralExpiration,
  writeConversationEphemeral,
} from './disappearing';
import {
  buildContactShareContent,
  ContactCard,
  ContactListEntry,
  conversationName,
  CreatedContact,
  insertStartedConversation,
  listAccountContacts,
  recordContactName,
  sharedContactsFromMessage,
  StartedChat,
} from './contacts';
import {
  fetchLimited,
  GIF_MAX_BYTES,
  STICKER_MAX_BYTES,
  stickerGifContent,
  StickerGifKind,
  StickerGifRequest,
} from './sticker-gif';
import {
  ContactBlockError,
  ContactBlockOutcome,
  ContactBlockRequest,
  readBlocklist,
  setContactBlocked,
  signalAlias,
} from './contact-block';
import {
  accountAliasPairs,
  BlockedContactEntry,
  BlocklistCache,
  describeBlockedPeople,
  groupBlockedPeople,
  personId,
  phoneOfJid,
} from './blocked-contacts';
import {
  appendCompanyToDisplayName,
  displayNameOrPhone,
  NormalizedWhatsAppPhone,
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
  /**
   * Structured data of a POLL / EVENT row (fase 3 / PR-7): `{poll}` or
   * `{event}`, merged into messages.metadata. Never key material.
   */
  structured?: Record<string, unknown>;
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
  /**
   * Download the media to MinIO + `attachments`. Default: only `live`. A recent
   * `append` (our own send echoed by Baileys, or a message delivered while
   * offline) is new too — before 02-10 its media was never stored.
   */
  storeMedia?: boolean;
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

/** POST /messages/star. */
export interface StarResult {
  starred: boolean;
  messageId: string;
  conversationId: string;
  starredAt: string;
  /** Recorded in whatsapp_message_stars (ingest on, migration 018 applied). */
  persisted: boolean;
}

/** POST /messages/pin. */
export interface PinResult {
  pinned: boolean;
  /** Id of the pin / unpin message (what an Idempotency-Key replays). */
  messageId: string;
  pinnedMessageId: string;
  conversationId: string;
  /** A pin: when, until when and for how long. */
  pinnedAt?: string;
  expiresAt?: string;
  durationSeconds?: number;
  persisted: boolean;
}

/** POST /messages/pins. */
export interface PinnedList {
  conversationId: string;
  pinned: PinnedMessage[];
  /** WhatsApp shows at most this many per chat, the newest. */
  limit: number;
  persisted: boolean;
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
  /** add only: the people WhatsApp refused with 403 (privacy: invite only). */
  inviteRequired?: InviteRequiredEntry[];
}

/** POST /groups/invite. */
export interface GroupInvitesResult {
  groupId: string;
  results: GroupInviteResult[];
  succeeded: number;
  failed: number;
  partial: boolean;
}

/** POST /communities/groups. */
export interface CommunityGroupResult {
  action: CommunityGroupAction;
  communityId: string;
  groupId: string;
  /** false = it already was so: nothing went to WhatsApp. */
  changed: boolean;
  /** A fresh read shows the asked state. */
  confirmed: true;
  community: CommunityView | null;
}

/** POST /communities/leave. */
export interface CommunityLeaveResult {
  communityId: string;
  changed: true;
  confirmed: true;
}

/** GET /channels. */
export interface ChannelListResult {
  channels: ChannelView[];
  coverage: {
    /** Always false: rc13 cannot ask WhatsApp for the followed list. */
    complete: false;
    source: 'known-channels';
    /** Channels this connector has seen (chats, ingested posts, lookups, follows). */
    candidates: number;
    /** Of those, read now (at most CHANNELS_LIST_MAX). */
    checked: number;
    /** Read but not answered (left out). */
    unreadable: number;
  };
}

/** POST /channels/subscription. */
export interface ChannelSubscriptionResult {
  action: ChannelSubscriptionAction;
  channelId: string;
  /** false = it already was so: nothing went to WhatsApp. */
  changed: boolean;
  /** The channel's own metadata (viewer role / mute) shows the asked state. */
  confirmed: true;
  channel: ChannelView;
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

/** The chat a presence / disappearing request is about (fase 3 / PR-8). */
interface ChatTarget {
  /** Baileys jid WhatsApp gets (`…@s.whatsapp.net`, `…@lid`, `…@g.us`). */
  raw: string;
  /** Legacy jid of the API (`…@c.us`, `…@lid`, `…@g.us`). */
  chatId: string;
  /** conversations.id of the canonical conversation; null when not ingesting. */
  conversationId: string | null;
  isGroup: boolean;
}

export interface PresenceSendResult {
  state: OutgoingPresenceState;
  /** 'chat' = a chat-state in chatId; 'account' = every chat sees it. */
  scope: 'chat' | 'account';
  chatId: string | null;
  conversationId: string | null;
  /** It went to WhatsApp (false: the same state went to this chat moments ago). */
  sent: boolean;
  throttled: boolean;
}

export interface PresenceReadResult {
  chatId: string;
  conversationId: string | null;
  isGroup: boolean;
  /** Freshest presence (typing wins); status 'unknown' when nothing fresh is known. */
  presence: PresenceView;
  /** Every fresh participant (groups: who is typing / online). */
  participants: PresenceView[];
  /** Nothing fresh: the chat was re-subscribed, ask again in a few seconds. */
  refreshing: boolean;
}

export interface PrivacyUpdateResult {
  setting: string;
  value: string | number;
  /** Value before the call; null when WhatsApp did not report it. */
  previous: string | number | null;
  /** The call went to WhatsApp (false: it already had that value). */
  changed: boolean;
  /** Settings read back after the change (null if the read-back failed). */
  privacy: PrivacyView | null;
}

export interface DisappearingView {
  chatId: string;
  conversationId: string | null;
  isGroup: boolean;
  /** Seconds (0 = off); null = unknown. */
  expiration: number | null;
  /** 'off' | '24h' | '7d' | '90d' (or `<n>s`); null = unknown. */
  label: string | null;
  known: boolean;
  /** ISO, when WhatsApp said when it was set. */
  setAt: string | null;
  source: 'group_metadata' | 'conversation' | 'unknown';
  /** Whether this account may change it (groups: admin, or members when not restricted). */
  canChange: boolean;
  /**
   * Direct chats: the contact's DEFAULT timer for new chats (USync
   * disappearing_mode) — not this chat's timer. null when not shared / not read.
   */
  contactDefault: { expiration: number; label: string | null; setAt: string | null } | null;
}

export interface DisappearingUpdateResult {
  chatId: string;
  conversationId: string | null;
  isGroup: boolean;
  expiration: number;
  label: string | null;
  /** Timer before, when known. */
  previous: number | null;
  /** It went to WhatsApp (false: the chat already had it). */
  changed: boolean;
  /** Recorded on the canonical conversation (false: pairing pool, or migration 014 missing). */
  persisted: boolean;
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
// Polls and events (fase 3 / PR-7)
// ---------------------------------------------------------------------------

/** A poll vote or an event response: state of another message, never a chat row. */
export function isPollOrEventResponse(msg: WAMessage): boolean {
  const content = normalizeMessageContent(msg.message);
  return !!(content?.pollUpdateMessage || content?.encEventResponseMessage);
}

/**
 * Votes / responses after everything else of a batch: a history batch can
 * carry a poll and its votes, and a vote is only decryptable once its poll
 * (and its secret) is known.
 */
export function responsesLast<T extends WAMessage>(messages: T[]): T[] {
  const responses = messages.filter(isPollOrEventResponse);
  if (!responses.length) return messages;
  return [...messages.filter(m => !isPollOrEventResponse(m)), ...responses];
}

/** Types an old row of a poll may have (whatsapp-web.js era, Baileys before PR-7). */
const POLL_ROW_TYPES = /^(POLL|POLL_CREATION|POLLCREATIONMESSAGE(V\d)?|MESSAGECONTEXTINFO)$/;
const EVENT_ROW_TYPES = /^(EVENT|EVENTMESSAGE|MESSAGECONTEXTINFO)$/;

/** Chats a poll / event can go to: a group, a phone-number or a LID chat. */
const STRUCTURED_CHAT_JID = /^(?:\d+(?:-\d+)?@g\.us|\d+@(?:c\.us|s\.whatsapp\.net|lid))$/;
/** A presence read that finds nothing re-subscribes the chat at most this often. */
const PRESENCE_REFRESH_MS = 30_000;

export interface StructuredSendOptions {
  /** Idempotent sends: the id derived from the Idempotency-Key. */
  messageId?: string;
  /** Runs right before the network send (the idempotency claim). */
  beforeSend?: () => Promise<void>;
  actor?: string;
}

export interface StructuredSendResult {
  messageId: string;
  conversationId: string;
  sentAt: string;
}

export interface PollVoteResult {
  messageId: string;
  pollMessageId: string;
  conversationId: string;
  options: string[];
  retracted: boolean;
  votedAt: string;
  persisted: boolean;
}

export interface EventResponseResult {
  messageId: string;
  eventMessageId: string;
  conversationId: string;
  response: EventResponse;
  extraGuestCount: number;
  respondedAt: string;
  persisted: boolean;
}

export type PollResultsView = PollResults & {
  messageId: string;
  conversationId: string;
  /** false when the votes table is missing (013 not applied): counts are then empty. */
  persisted: boolean;
};

export type EventResultsView = EventResults & {
  messageId: string;
  conversationId: string;
  name: string;
  description: string | null;
  startTime: number | null;
  endTime: number | null;
  location: unknown;
  joinLink: string | null;
  isCanceled: boolean;
  extraGuestsAllowed: boolean;
  persisted: boolean;
};

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

/**
 * Baileys' profile-picture iq can go unanswered (it waits its whole query
 * timeout); cap it so /chats/:jid/photo answers 504 instead of hanging, and
 * keep a provider 408 as the same timeout rather than a "no photo".
 */
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

/** 403 (private) and 404 (none) are WhatsApp's answers for "no visible picture". */
/**
 * WhatsApp answers "no visible picture": none (404 item-not-found) or hidden by
 * the contact's privacy (403, or 401 not-authorized — Baileys raises that one
 * as a Boom 500 with `data: 401`, which used to leak as a 500 and blanked half
 * of the professional avatars in the console, QA 02-10).
 */
export function isUnavailableProfilePicture(error: unknown): boolean {
  if (!(error instanceof Boom)) return false;
  const codes = [error.output.statusCode, Number(error.data)];
  return (
    codes.some(code => [401, 403, 404].includes(code)) ||
    /^(not-authorized|item-not-found|forbidden)$/.test(error.message)
  );
}

/**
 * Whether the patched Baileys will attach a <cstoken> to a 1:1 send that has
 * no tctoken: same guard as its messages-send (own account LID-addressed, NCT
 * salt provisioned, recipient resolved to a LID). WA Web genCsTokenBody,
 * whatsmeow cstoken.go.
 */
export function canAttachCsToken(
  creds: { me?: { lid?: string | null } | null; nctSalt?: Uint8Array | null } | undefined,
  storageJid: string
): boolean {
  return Boolean(creds?.me?.lid && creds?.nctSalt?.length && storageJid.endsWith('@lid'));
}

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
  // Subscriptions belong to a socket: cleared on every open / close.
  private presenceSubscribed = new Set<string>();
  // Fase 3 / PR-8: what presence.update told us (60 s, typing 8 s), never
  // stored; cleared with the socket so a reader gets `unknown`, not stale.
  private presenceCache = new PresenceCache();
  private presenceThrottle = new PresenceSendThrottle();
  // The account's blocklist as last read (60 s), patched by blocklist.update;
  // it belongs to a socket: cleared on every open / close. Never stored.
  private blocklistCache = new BlocklistCache();
  // Last forced re-subscribe per chat (a read refreshes an expired presence).
  private presenceRefreshedAt = new Map<string, number>();
  private groupMetaCache = new Map<string, GroupMetadata>(); // by raw JID
  /**
   * Private invites WhatsApp handed back with a refused add (403), by
   * `<raw group>|<participant jid>` (every alias of the person): what POST
   * /groups/invite sends them. In memory only — after a restart the invite
   * falls back to the group link.
   */
  private pendingGroupInvites = new Map<string, AddRequest>();
  // One community / channel write at a time per id (WhatsApp gives these
  // mutations no idempotency token: a concurrent twin must see the first).
  private communityWrites = new KeyedSerializer();
  private channelWrites = new KeyedSerializer();
  /** Channels this process looked up or followed: candidates of GET /channels. */
  private seenChannels = new Set<string>();
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
    this.intentionalDisconnect = false;
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
    // SC-1394: stays true until the next connect(). Baileys emits the
    // socket's `close` after sock.end() returns; lowering the flag here made
    // that late event look unintentional and revived a client the owner (the
    // pairing pool) had closed, ~40 sockets/h forever.
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

    sock.ev.on('creds.update', update => {
      // The Baileys logger runs at warn, so the patch's own info line about
      // the NCT salt never reaches the pod log: say it here.
      if (update?.nctSalt?.length) {
        this.logger.info('NCT salt stored in creds: first messages can carry a cstoken');
      }
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
        // Presence subscriptions and snapshots belong to the old socket: a
        // reconnect resubscribes and never shows a stale "online".
        this.resetPresence();
        this.blocklistCache.clear();
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
        this.resetPresence();
        this.blocklistCache.clear();
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
      for (const msg of responsesLast(messages)) {
        if (!msg.message) continue;
        try {
          await this.ingestMessage(msg, {
            source: isLive ? 'live' : 'baileys_history_sync',
            publishEvent: isLive,
            storeMedia: isLive || appendMediaEligible(msg),
          });
        } catch (e: any) {
          this.logger.error(`Error processing message ${msg.key?.id}: ${e?.message || e}`);
        }
      }
    });

    sock.ev.on('messaging-history.set', async update => {
      const { chats, messages, isLatest, syncType } = update;
      // The patched Baileys carries HistorySync field 19 (NCT salt) here. It is
      // logged before the ingest gate: the INITIAL_BOOTSTRAP of a pairing
      // brings it even when message history is not ingested.
      const nctSalt = (update as { nctSalt?: Uint8Array }).nctSalt;
      if (nctSalt?.length) {
        this.logger.info(`NCT salt received in history sync (syncType=${syncType})`);
      }
      // chats: Chat[] (Baileys type). Refresh in-memory chat store.
      for (const c of chats) {
        if (!c.id) continue;
        this.rememberChatSnapshot(c);
      }
      if (!this.historySyncOnLogin && Date.now() > this.historyBackfillRequestedUntil) return;
      this.logger.info(
        `history.set received chats=${chats.length} messages=${messages.length} isLatest=${isLatest}`
      );
      const byChat = new Map<
        string,
        { inserted: number; oldest?: WhatsAppMessage; newest?: WhatsAppMessage }
      >();
      for (const m of responsesLast(messages)) {
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
        // Pin / mute from app-state sync (the phone, or the echo of our own
        // POST /chats/modify — same values), with the rest, on the canonical conversation.
        void setCanonicalChatState(norm, {
          unreadCount: uc,
          archived: arch,
          pinnedAt: pinFromBaileys(u),
          mute: muteFromBaileys(u, 'sync-action'),
        });
        // A timer change of either side (EPHEMERAL_SETTING, also the echo of
        // our own POST /chats/disappearing) arrives as this delta.
        void recordInboundEphemeral(norm, ephemeralFromBaileys(u, 'change'));
      }
    });

    sock.ev.on('chats.upsert', upserts => {
      for (const c of upserts) {
        if (!c.id) continue;
        this.rememberChatSnapshot(c);
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
          // Fase 3 / PR-8: kept in memory for POST /chats/presence/read.
          this.presenceCache.record(
            convId,
            this.normalizeJid(jidNormalizedUser(participantJid) || participantJid),
            p
          );
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

    // The blocklist changed on another device (the phone): patch the cache so
    // a read within its TTL is not stale. rc13 types blocklist.set but never
    // emits it; handled anyway (a full replacement).
    sock.ev.on('blocklist.update', evt => {
      this.blocklistCache.apply(evt);
      this.logger.info(
        `Blocklist ${String(evt?.type)} (${Array.isArray(evt?.blocklist) ? evt.blocklist.length : 0}) from WhatsApp`
      );
    });
    sock.ev.on('blocklist.set', evt => {
      this.blocklistCache.apply(evt, true);
    });

    sock.ev.on('messages.update', updates => {
      for (const u of updates) {
        if (!u.key?.id) continue;
        const waMessageId = u.key.id;
        const stubParams = (u.update as any)?.messageStubParameters;
        const ackErrorCode = Array.isArray(stubParams) ? String(stubParams[0] || '') : undefined;
        // Revokes and edits (fase 3 / PR-3).
        void this.handleInboundMutation(u);
        // A star / unstar from our phone (app-state sync).
        void this.handleInboundStar(u);
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
      // Added to a group that already existed: WhatsApp sends no groups.upsert
      // for that, only this "add" naming us.
      if (action === 'add') void this.recordGroupJoined(id, participants);
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
    if (this.connecting || this.intentionalDisconnect) return;
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
    if (this.reconnectTimer || this.connecting || this.intentionalDisconnect) return;
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
    if (this.connecting || this.intentionalDisconnect) return;
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

    // A pin / unpin is state of the pinned message, not a chat message (it
    // used to land as an empty MESSAGECONTEXTINFO / PININCHATMESSAGE row):
    // recorded in whatsapp_message_pins, no messages row.
    if (isPinAction(msg)) {
      await this.ingestPinAction(msg, options);
      return { inserted: false };
    }

    // Fase 3 / PR-7: a poll vote or an event response is state of the poll /
    // event, not a chat message (WhatsApp does not list it either): it is
    // decrypted into whatsapp_poll_votes / whatsapp_event_responses and no
    // messages row is written (before, an empty POLLUPDATEMESSAGE row).
    if (isPollOrEventResponse(msg)) {
      await this.ingestPollOrEventResponse(msg, options);
      return { inserted: false };
    }

    const waMessage = this.convertMessage(msg);
    if (!waMessage) return { inserted: false };
    if (isChannelJid(msg.key.remoteJid)) {
      waMessage.waMessageId = await channelPostMessageId(
        waMessage.conversationId,
        waMessage.waMessageId
      );
    }

    this.rememberKey(waMessage.waMessageId, msg.key, msg.key.remoteJid || '');

    const rawChatJid = msg.key.remoteJid || '';
    const isGroup = !!isJidGroup(rawChatJid);

    const chatName = isOfficialWhatsAppJid(rawChatJid)
      ? OFFICIAL_WHATSAPP_NAME
      : this.chatStore.get(waMessage.conversationId)?.name || waMessage.conversationId;
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
    const pushName =
      msg.pushName || (isOfficialWhatsAppJid(senderRaw) ? OFFICIAL_WHATSAPP_NAME : undefined);
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
    // A 1:1 chat links only the other side: our own participant there named
    // the chat after the account itself in the console (QA 02-10).
    if (linksSenderToChat({ isGroup, fromMe: !!msg.key.fromMe, chatJid: rawChatJid })) {
      await linkParticipantToConversation(waMessage.conversationId, waMessage.senderWaId).catch(e =>
        this.logger.error(
          `participant link persist failed for conversation=${waMessage.conversationId} ` +
            `participant=${waMessage.senderWaId}: ${e?.message || e}`
        )
      );
    }

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
        // POLL / EVENT (fase 3 / PR-7): {poll} or {event}, what dgx-messages renders.
        ...waMessage.structured,
        // The quote of a reply (QA 02-10): what dgx-messages shows above the
        // bubble, also when the quoted message is not in the DB.
        ...(await this.replyMetadata(msg)),
      },
    };
    const msgId = await storeMessage(data);
    // A revoke of this channel post or status arrived before it: the row is stored
    // (the content stays, like any revoke) and marked deleted at once.
    if (
      msgId &&
      msg.key.id &&
      (isChannelJid(rawChatJid) || isStatusJid(rawChatJid)) &&
      takeRevokeBeforePost(waMessage.conversationId, msg.key.id)
    ) {
      this.logger.info(
        `Revoke of ${waMessage.conversationId} ${msg.key.id} arrived before its post: applied`
      );
      await this.recordInboundRevoke(waMessage.waMessageId);
    }
    // Not for a REACTION: prod folds it into the target's messages.reactions
    // and never writes its row, so the key's FK to messages.wa_message_id can
    // only fail (a warning per reaction). Nothing reads a reaction's key: it
    // cannot be quoted, edited nor reacted to.
    if (waMessage.messageType !== 'REACTION') {
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
    }
    // Also for an already-stored row (msgId null): a history replay after a
    // relink backfills the payloads of the recent window. A poll / event is
    // kept whatever its age: its secret is what decrypts the votes / responses.
    // Not a channel post stored under a composed id: the copy is one per id and
    // would replace the first channel's, and its key.id is not the composed one.
    if (waMessage.waMessageId === msg.key.id) {
      await this.persistDurablePayload(
        msg,
        waMessage.conversationId,
        options.source === 'baileys_history_sync' && !waMessage.structured ? 'history' : 'live'
      );
    }
    // Before the msgId check: prod folds REACTION inserts into the target's
    // messages.reactions and skips the row, so msgId is always null for them.
    if (waMessage.messageType === 'REACTION') await this.persistReaction(msg, waMessage);
    // History sync carries each message's current reactions on the message
    // itself (no REACTION message of their own): same table, same rules.
    await this.persistCarriedReactions(msg, waMessage);
    // A history-sync message says whether it is starred: only fills a message
    // whose star we never saw (the app-state sync is newer).
    if (msg.starred === true) {
      await recordMessageStar({
        messageId: waMessage.waMessageId,
        chatId: waMessage.conversationId,
        fromMe: !!msg.key.fromMe,
        starred: true,
        source: 'history',
      });
    }

    // A status (a message of status@broadcast) stays in messages like before
    // and is also indexed in whatsapp_statuses (author, posted / expires at).
    // Also for an already-stored row: a history replay fills the index. A
    // status without its WhatsApp time is not indexed (it would never expire).
    if (
      isStatusJid(rawChatJid) &&
      STATUS_MESSAGE_TYPES.has(waMessage.messageType) &&
      waMessage.waTimestamp.getTime() > 0
    ) {
      await recordStatus({
        messageId: waMessage.waMessageId,
        authorId: waMessage.senderWaId,
        fromMe: !!msg.key.fromMe,
        messageType: waMessage.messageType,
        postedAt: waMessage.waTimestamp,
        source: options.source === 'baileys_history_sync' ? 'history' : 'live',
      });
    }

    if (!msgId) return { inserted: false, waMessage };

    this.logger.info(`Stored message ${waMessage.waMessageId} from ${waMessage.senderWaId}`);

    const isLiveMedia =
      (options.storeMedia ?? (options.source || 'live') === 'live') &&
      waMessage.messageType !== 'TEXT' &&
      waMessage.messageType !== 'REACTION';
    if (
      isLiveMedia &&
      waMessage.messageType === 'AUDIO' &&
      this.emitAudioAttachments &&
      options.publishEvent !== false
    ) {
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

  /**
   * `metadata.reply_preview` (the quoted text, or a label of its kind),
   * `reply_type` (its message type), `reply_from_id` (its author as a
   * participant id, like messages.sender_wa_id) and `reply_from` (the
   * author's name when known: "Tú" for ourselves). Nothing for a message
   * that is not a reply.
   */
  // CONTRACT: schema.whatsapp-connector.messages-metadata-reply.v1 — metadata reply_preview, reply_type, reply_from_id, reply_from
  private async replyMetadata(msg: WAMessage): Promise<Record<string, string>> {
    const quote = quotedReply(msg.message);
    if (!quote) return {};
    const out: Record<string, string> = {};
    if (quote.preview) {
      out.reply_preview = quote.preview.text;
      out.reply_type = quote.preview.type;
    }
    if (quote.participant) {
      const authorId = this.normalizeJid(quote.participant);
      out.reply_from_id = accountKey(authorId);
      const own = new Set(
        [this.meJid, (this.sock?.user as { lid?: string } | undefined)?.lid]
          .filter((jid): jid is string => !!jid)
          .map(jid => this.normalizeJid(jidNormalizedUser(jid)))
      );
      const name = own.has(authorId)
        ? 'Tú'
        : this.contactNames.get(quote.participant) ||
          this.contactNames.get(authorId) ||
          (this.ingest ? await participantDisplayName(out.reply_from_id).catch(() => null) : null);
      if (name) out.reply_from = name;
    }
    return out;
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
    let poll: ReturnType<typeof parsePollDefinition> = null;
    let event: ReturnType<typeof parseEventDefinition> = null;
    let structured: Record<string, unknown> | undefined;

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
      // A WhatsApp GIF is a looping muted video (fase 3 / PR-9).
      if (content.videoMessage.gifPlayback) structured = { gifPlayback: true };
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
    } else if (content.contactMessage || content.contactsArrayMessage) {
      // Fase 3 / PR-9: the cards' names and numbers ride as metadata.contact
      // (what dgx-messages renders as a card with "Abrir chat"), never the raw vCard.
      messageType = 'CONTACT';
      const shared = sharedContactsFromMessage(content);
      body = shared?.displayName || null;
      if (shared) structured = { contact: shared };
    } else if ((poll = parsePollDefinition(content))) {
      // Fase 3 / PR-7: a proper POLL row (was MESSAGECONTEXTINFO or
      // POLLCREATIONMESSAGEV3 with no content). The secret stays in the payload.
      messageType = 'POLL';
      body = poll.question || null;
      structured = { poll };
    } else if ((event = parseEventDefinition(content))) {
      messageType = 'EVENT';
      body = event.name || null;
      structured = { event };
    } else if (content.protocolMessage) {
      // ignore key updates etc.
      return null;
    } else {
      const k = Object.keys(content).find(k => !!(content as any)[k]);
      messageType = (k || 'UNKNOWN').toUpperCase();
    }

    // A reply quoted from a photo, document, sticker… (not only a text) keeps
    // its quoted id too.
    if (!replyToWaId) replyToWaId = quotedReply(content)?.stanzaId || undefined;

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
      ...(structured ? { structured } : {}),
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
    const original = await this.currentMessage(id);
    if (!original?.message) return undefined;
    return {
      ...original,
      key: { ...original.key, id, remoteJid: chatJid },
    } as WAMessage;
  }

  /**
   * A message to quote or forward: memory, else the durable copy — with the
   * CURRENT text when it was edited since: both copies are the original (an
   * edit only rewrites the messages row: content, is_edited, edit_history).
   * The row is read only with ingest; unreadable → the copy as it is.
   */
  private async currentMessage(id: string): Promise<WAMessage | undefined> {
    const original = this.memoryMessage(id) || (await this.durableMessage(id));
    if (!original?.message || !this.ingest) return original;
    const edited = await loadEditedContent(id).catch((e: any) => {
      this.logger.warn(
        `current text of ${id} unreadable, using its stored copy: ${e?.message || e}`
      );
      return undefined;
    });
    const message = edited === undefined ? undefined : withEditedText(original.message, edited);
    return message ? ({ ...original, message } as WAMessage) : original;
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
   * Disappearing timer (seconds) an outgoing message to `raw` must carry, when
   * known and on: a group's cached metadata (what Baileys itself puts on the
   * stanza), else the canonical conversation row (014) — `conversationId`
   * when the caller already resolved it. Unknown, off, ingest off or any
   * failure → undefined: the message goes as before, never blocked by this.
   */
  private async outgoingEphemeral(
    raw: string,
    conversationId?: string | null
  ): Promise<number | undefined> {
    try {
      if (this.isGroupJid(raw)) {
        const meta = this.groupMetaCache.get(raw);
        if (meta) return groupEphemeral(meta) || undefined;
      }
      if (!this.ingest) return undefined;
      const id = conversationId || (await resolveCanonicalConversation(raw))?.id;
      if (!id) return undefined;
      const stored = await readConversationEphemeral(id);
      return stored && stored.expiration > 0 ? stored.expiration : undefined;
    } catch (e: any) {
      this.logger.warn(`disappearing timer of ${raw} unreadable, sent without: ${e?.message || e}`);
      return undefined;
    }
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
   * The reactions a message carries (WebMessageInfo.reactions — what a
   * history sync brings: the current reaction of each person, no REACTION
   * message) → whatsapp_message_reactions, with the rules of a live one: the
   * reactor from the reaction's own key (ours when fromMe; a group needs its
   * participant, else skipped), an empty text a removal, and an older one
   * never replacing a newer one (reacted_at = its senderTimestampMs).
   * SC-1225: a pairing-only socket writes nothing.
   */
  private async persistCarriedReactions(msg: WAMessage, waMessage: WhatsAppMessage): Promise<void> {
    const reactions = (msg as { reactions?: proto.IReaction[] | null }).reactions;
    if (!this.ingest || !Array.isArray(reactions) || !reactions.length) return;
    const chatRaw = msg.key.remoteJid || '';
    const isGroup = !!isJidGroup(chatRaw);
    for (const item of reactions) {
      const key = item?.key;
      if (!key) continue;
      const reactorRaw = key.fromMe
        ? this.meJid
        : key.participant || (isGroup ? null : key.remoteJid || chatRaw);
      if (!reactorRaw || isJidGroup(reactorRaw)) continue;
      await storeMessageReaction({
        targetMessageId: waMessage.waMessageId,
        conversationId: waMessage.conversationId,
        reactorJid: this.normalizeJid(reactorRaw),
        emoji: item.text || '',
        fromMe: key.fromMe ?? null,
        reactionMessageId: key.id || undefined,
        reactedAt: reactionTime(item.senderTimestampMs),
      });
    }
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
    await this.guardDirectSend(raw, started);
    const quoted = await this.buildQuotedFromId(options?.replyToMessageId, raw);
    const ephemeralExpiration = await this.outgoingEphemeral(raw);
    await options?.beforeSend?.();
    try {
      const sent = await this.sendTextWithTimeout(raw, content, timeoutMs, {
        useCachedGroupMetadata: isGroup ? false : undefined,
        useUserDevicesCache: isGroup ? false : undefined,
        quoted,
        messageId: options?.messageId,
        ephemeralExpiration,
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
            ephemeralExpiration,
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
      /** Play-once photo/video (media-quality.ts); refused for other kinds. */
      viewOnce?: boolean;
      /** Re-encode a still image (media-quality.ts); default source = untouched. */
      quality?: MediaQuality;
      /** A document's name; default = the URL's last path segment, no query. */
      fileName?: string;
    }
  ): Promise<string | undefined> {
    if (!this.sock) throw new Error('Client not initialized');
    const viewOnce = parseViewOnce(options?.viewOnce);
    const quality = parseMediaQuality(options?.quality);
    const raw = this.toRawJid(chatId);
    await this.guardDirectSend(raw);
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
    const fileName = documentFileName(fileUrl, options?.fileName);
    const asSticker = !!options?.asSticker || contentType === 'image/webp';
    // Refused before anything goes out: play-once only for photos/videos,
    // a quality only for still images.
    checkMediaOptions(contentType, { viewOnce, quality, asSticker });
    const once = viewOnce ? { viewOnce: true } : {};

    let payload: AnyMessageContent;
    // Stickers: WhatsApp expects webp; baileys handles conversion when the
    // payload is `{ sticker: buf }` and the bytes are a static webp/animated.
    if (asSticker) {
      payload = { sticker: buf };
    } else if (contentType.startsWith('image/')) {
      if (quality !== 'source') {
        const prepared = await prepareImageQuality(buf, contentType, quality);
        payload = { image: prepared.bytes, mimetype: prepared.mimeType, caption, ...once };
      } else payload = { image: buf, caption, ...once };
    } else if (contentType.startsWith('video/')) payload = { video: buf, caption, ...once };
    else if (contentType.startsWith('audio/'))
      // INFRA-592: OGG/Opus goes out as the native voice note (ptt:true);
      // sent as a plain audio message WhatsApp never delivers it.
      payload = audioMessagePayload(contentType, buf);
    else
      payload = {
        document: buf,
        fileName,
        mimetype: contentType || 'application/octet-stream',
        caption,
      };

    const ephemeralExpiration = await this.outgoingEphemeral(raw);
    await options?.beforeSend?.();
    const sendOptions = withEphemeralExpiration(
      quoted || options?.messageId
        ? {
            ...(quoted ? { quoted } : {}),
            ...(options?.messageId ? { messageId: options.messageId } : {}),
          }
        : undefined,
      ephemeralExpiration
    );
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
    await this.guardDirectSend(raw);
    const payload: AnyMessageContent = { audio, mimetype, ptt: true };
    const sendOptions = withEphemeralExpiration(
      options?.messageId ? { messageId: options.messageId } : undefined,
      await this.outgoingEphemeral(raw)
    );
    await options?.beforeSend?.();
    const sent = sendOptions
      ? await this.sock.sendMessage(raw, payload, sendOptions)
      : await this.sock.sendMessage(raw, payload);
    const messageId = sent?.key?.id;
    if (sent?.key) {
      this.rememberKey(messageId || '', sent.key, raw);
      this.rememberMessageForRetry(sent.key, sent.message);
      await this.persistDurablePayload(sent, this.normalizeJid(sent.key.remoteJid || raw), 'sent');
    }
    return messageId || undefined;
  }

  // ---------------------------------------------------------------------------
  // Start chat, stickers / GIFs, contacts (fase 3 / PR-9; the helpers live in
  // contacts.ts and sticker-gif.ts)
  // ---------------------------------------------------------------------------

  /**
   * The chat of a phone number — never a twin. First what this account already
   * has for it (the phone jid or, through 008's aliases, its LID conversation,
   * merged tombstones followed): then WhatsApp is not even asked. Otherwise
   * onWhatsApp (not on WhatsApp → 422 not_on_whatsapp) and the LID WhatsApp
   * gives for the number, which is looked up again (a LID conversation may
   * exist without an alias). Only when nothing exists is a row inserted, under
   * the LID when known (the jid replies arrive on), with the phone in
   * wa_chat_id so 008 records the alias — and only with ingest on.
   */
  async startChat(
    phone: NormalizedWhatsAppPhone,
    options: { actor?: string } = {}
  ): Promise<StartedChat> {
    const sock = this.connectedSocket();
    const known = this.ingest ? await resolveCanonicalConversation(phone.rawJid) : undefined;
    if (known) return this.startedChatView(known, phone, { created: false });

    const results = await sock.onWhatsApp(phone.rawJid);
    const found = (results || []).find(item => item?.exists && typeof item.jid === 'string');
    if (!found) {
      throw new MessageMutationError(
        `${phone.phoneE164} is not on WhatsApp`,
        422,
        'not_on_whatsapp'
      );
    }
    const pnJid = jidNormalizedUser(found.jid) || phone.rawJid;
    const lidFound = await Promise.resolve(
      sock.signalRepository?.lidMapping?.getLIDForPN?.(pnJid)
    ).catch(() => null);
    const lid = lidFound ? jidNormalizedUser(lidFound) : null;
    if (this.ingest) {
      const twin =
        (lid ? await resolveCanonicalConversation(lid) : undefined) ||
        (pnJid !== phone.rawJid ? await resolveCanonicalConversation(pnJid) : undefined);
      if (twin) return this.startedChatView(twin, phone, { created: false, lid });
    }

    const chatJid = lid || this.normalizeJid(pnJid);
    const name =
      this.contactNames.get(pnJid) ||
      (lid ? this.contactNames.get(lid) : undefined) ||
      this.contactNames.get(this.normalizeJid(pnJid)) ||
      phone.phoneE164;
    let conversationId: string | null = null;
    let created = false;
    if (this.ingest) {
      const row = await insertStartedConversation({ jid: chatJid, name, pnJid });
      conversationId = row.id;
      created = row.created;
    }
    this.logger.info(
      `Chat started with ${chatJid}${created ? ' (new conversation)' : ''}${options.actor ? ` by ${options.actor}` : ''}`
    );
    return {
      conversationId,
      chatId: chatJid,
      phone: phone.phoneE164,
      lid,
      name,
      created,
      existing: false,
      persisted: !!conversationId,
    };
  }

  private async startedChatView(
    conversation: CanonicalConversation,
    phone: NormalizedWhatsAppPhone,
    extra: { created: boolean; lid?: string | null }
  ): Promise<StartedChat> {
    const name = await conversationName(conversation.id).catch(() => null);
    const chatId = stripAccountKey(conversation.externalId);
    return {
      conversationId: conversation.id,
      chatId,
      phone: phone.phoneE164,
      lid: chatId.endsWith('@lid') ? chatId : extra.lid || null,
      name: name || phone.phoneE164,
      created: extra.created,
      existing: true,
      persisted: true,
    };
  }

  /**
   * A sticker (WebP) or a GIF (MP4 with gifPlayback) to a chat's canonical jid.
   * The file is fetched with its ceiling and checked by its bytes before the
   * idempotency claim (`beforeSend`): a refused file never burns a key.
   */
  async sendStickerOrGif(
    kind: StickerGifKind,
    request: StickerGifRequest,
    options: StructuredSendOptions = {}
  ): Promise<StructuredSendResult & { kind: StickerGifKind; animated?: boolean }> {
    const sock = this.connectedSocket();
    const target = await this.structuredSendTarget(
      request.conversationId,
      kind === 'sticker' ? 'sendSticker' : 'sendGif'
    );
    await this.guardDirectSend(target.raw);
    const quoted = request.replyToMessageId
      ? await this.buildQuotedFromId(request.replyToMessageId, target.raw)
      : undefined;
    if (request.replyToMessageId && !quoted) {
      throw new MessageUnavailableError(
        `Quoted message ${request.replyToMessageId} is unavailable (not in memory nor in the durable store); send without replyTo`,
        422,
        'quoted_message_unavailable'
      );
    }
    const file = await fetchLimited(
      request.fileUrl,
      kind === 'sticker' ? STICKER_MAX_BYTES : GIF_MAX_BYTES
    );
    const content = stickerGifContent(kind, file.bytes, file.contentType, request.caption);
    const ephemeralExpiration = await this.outgoingEphemeral(target.raw, target.canonicalId);
    await options.beforeSend?.();
    const sendOptions = withEphemeralExpiration(
      quoted || options.messageId
        ? {
            ...(quoted ? { quoted } : {}),
            ...(options.messageId ? { messageId: options.messageId } : {}),
          }
        : undefined,
      ephemeralExpiration
    );
    const sent = await sock.sendMessage(target.raw, content, sendOptions);
    const messageId = sent?.key?.id;
    if (!sent || !messageId) throw new Error(`WhatsApp returned no message id for the ${kind}`);
    this.rememberKey(messageId, sent.key, target.raw);
    this.rememberMessageForRetry(sent.key, sent.message);
    await this.persistDurablePayload(sent, target.conversationId, 'sent');
    this.logger.info(
      `${kind} ${messageId} sent to ${target.raw}${options.actor ? ` by ${options.actor}` : ''}`
    );
    return {
      messageId,
      conversationId: target.conversationId,
      sentAt: new Date().toISOString(),
      kind,
      ...('sticker' in content ? { animated: content.isAnimated } : {}),
    };
  }

  /** One or several contact cards (vCard) to a chat's canonical jid. */
  async shareContacts(
    chatId: string,
    cards: ContactCard[],
    options: StructuredSendOptions = {}
  ): Promise<StructuredSendResult & { contacts: number }> {
    const sock = this.connectedSocket();
    const target = await this.structuredSendTarget(chatId, 'shareContact');
    await this.guardDirectSend(target.raw);
    const content = buildContactShareContent(cards);
    const sendOptions = withEphemeralExpiration(
      options.messageId ? { messageId: options.messageId } : undefined,
      await this.outgoingEphemeral(target.raw, target.canonicalId)
    );
    await options.beforeSend?.();
    const sent = await sock.sendMessage(target.raw, content, sendOptions);
    const messageId = sent?.key?.id;
    if (!sent || !messageId) throw new Error('WhatsApp returned no message id for the contact');
    this.rememberKey(messageId, sent.key, target.raw);
    this.rememberMessageForRetry(sent.key, sent.message);
    await this.persistDurablePayload(sent, target.conversationId, 'sent');
    this.logger.info(
      `Contact card ${messageId} (${cards.length}) sent to ${target.raw}${options.actor ? ` by ${options.actor}` : ''}`
    );
    return {
      messageId,
      conversationId: target.conversationId,
      sentAt: new Date().toISOString(),
      contacts: cards.length,
    };
  }

  /**
   * The people this account knows (read only; one entry per person, PN and
   * LID collapsed). A pairing-only client keeps no DB state: an empty list.
   */
  async listContacts(
    options: { query?: string; limit?: number } = {}
  ): Promise<ContactListEntry[]> {
    if (!this.ingest) return [];
    const own = this.sock ? await this.ownIds().catch(() => [] as string[]) : [];
    const me = this.meJid ? [jidNormalizedUser(this.meJid)] : [];
    return listAccountContacts({
      ...options,
      ownJids: [...own, ...me].map(jid => this.normalizeJid(jid)),
    });
  }

  /**
   * Save a contact in the account's address book: WhatsApp's own app-state
   * mutation (contactAction on the `critical_unblock_low` collection, the one
   * WhatsApp Web's "New contact" writes and /contacts/seed already uses), keyed
   * by the phone jid with the LID when WhatsApp gives one and
   * saveOnPrimaryAddressbook so the phone keeps it too. The number must be on
   * WhatsApp (422 not_on_whatsapp). With ingest, the name also lands on the
   * rows that already exist for that person (no row is created).
   */
  async createContact(
    input: { phone: NormalizedWhatsAppPhone; name: string; firstName?: string },
    options: { actor?: string } = {}
  ): Promise<CreatedContact> {
    const sock = this.connectedSocket();
    const results = await sock.onWhatsApp(input.phone.rawJid);
    const found = (results || []).find(item => item?.exists && typeof item.jid === 'string');
    if (!found) {
      throw new MessageMutationError(
        `${input.phone.phoneE164} is not on WhatsApp`,
        422,
        'not_on_whatsapp'
      );
    }
    const pnJid = jidNormalizedUser(found.jid) || input.phone.rawJid;
    const lidFound = await Promise.resolve(
      sock.signalRepository?.lidMapping?.getLIDForPN?.(pnJid)
    ).catch(() => null);
    const lid = lidFound ? jidNormalizedUser(lidFound) : null;
    try {
      await sock.addOrEditContact(pnJid, {
        fullName: input.name,
        firstName: input.firstName || input.name,
        pnJid,
        ...(lid ? { lidJid: lid } : {}),
        saveOnPrimaryAddressbook: true,
      } satisfies proto.SyncActionValue.IContactAction);
    } catch (e: any) {
      const status = Number(e?.output?.statusCode ?? e?.data?.statusCode);
      if (e?.isBoom && status >= 400 && status < 500 && ![401, 408, 428, 440].includes(status)) {
        throw new MessageMutationError(
          `WhatsApp rejected the contact: ${e?.message || e}`,
          422,
          'rejected_by_whatsapp',
          String(status)
        );
      }
      throw e;
    }
    for (const jid of [pnJid, this.normalizeJid(pnJid), ...(lid ? [lid] : [])]) {
      this.contactNames.set(jid, input.name);
    }
    let persisted = false;
    if (this.ingest) {
      try {
        persisted = (await recordContactName([pnJid, ...(lid ? [lid] : [])], input.name)) > 0;
      } catch (error: any) {
        this.logger.warn(`contact name persist failed: ${error?.message || error}`);
      }
    }
    this.logger.info(
      `Contact saved for ${lid || pnJid}${options.actor ? ` by ${options.actor}` : ''}`
    );
    return {
      phone: input.phone.phoneE164,
      jid: this.normalizeJid(pnJid),
      lid,
      name: input.name,
      addressBookSync: true,
      persisted,
    };
  }

  // ---------------------------------------------------------------------------
  // Contact block / blocklist (helpers in contact-block.ts, blocked-contacts.ts)
  // ---------------------------------------------------------------------------

  /**
   * The direct contact a block request is about, as the jid WhatsApp knows
   * the chat by: a conversation resolved to its canonical row (merged
   * tombstones followed; a group is 400), a phone to the conversation this
   * account already has for it (its LID one through 008's aliases) and only
   * otherwise its phone jid. Baileys itself maps PN ↔ LID when it writes.
   */
  private async blockTarget(
    request: ContactBlockRequest
  ): Promise<{ jid: string; conversationId: string | null }> {
    if (request.conversationId) {
      const target = await this.chatTarget(request.conversationId, 'block', false);
      if (target.isGroup) {
        throw new ContactBlockError(
          'A group cannot be blocked: block one of its members instead',
          400,
          'invalid_request'
        );
      }
      return { jid: target.raw, conversationId: target.conversationId };
    }
    const phone = request.phone!;
    const known = this.ingest ? await resolveCanonicalConversation(phone.rawJid) : undefined;
    return {
      jid: known ? this.toRawJid(stripAccountKey(known.externalId)) : phone.rawJid,
      conversationId: known?.id ?? null,
    };
  }

  /**
   * Block or unblock one contact (WhatsApp's own blocklist IQ via Baileys),
   * proven by re-reading the provider's blocklist. The caller (POST
   * /contacts/block) already required confirm: true and the sending gate.
   */
  async setContactBlock(
    request: ContactBlockRequest,
    options: { actor?: string } = {}
  ): Promise<
    Omit<ContactBlockOutcome, 'blocklist'> & {
      action: ContactBlockRequest['action'];
      conversationId: string | null;
    }
  > {
    const sock = this.connectedSocket();
    const target = await this.blockTarget(request);
    const { blocklist, ...outcome } = await setContactBlocked(
      sock,
      target.jid,
      request.action === 'block'
    );
    this.blocklistCache.set(blocklist);
    this.logger.info(
      `Contact ${outcome.jid} ${request.action}${outcome.changed ? '' : ' (already)'}${options.actor ? ` by ${options.actor}` : ''}`
    );
    return { action: request.action, ...outcome, conversationId: target.conversationId };
  }

  /**
   * The account's blocked contacts, one entry per person (PN + LID through
   * Baileys' mapping and 008's aliases), named from participants /
   * conversations. The provider is read unless the cached list is fresh (or
   * `fresh` is asked). A pairing-only client (ingest off) never touches the DB.
   */
  async listBlockedContacts(
    options: { fresh?: boolean } = {}
  ): Promise<{ blocked: BlockedContactEntry[]; readAt: string; cached: boolean }> {
    const sock = this.connectedSocket();
    const cached = options.fresh ? null : this.blocklistCache.fresh();
    const entries = cached || this.blocklistCache.set(await readBlocklist(sock));
    const readAt = this.blocklistCache.last()?.readAt || new Date().toISOString();
    const pairs = this.ingest ? await accountAliasPairs(entries) : [];
    const groups = await groupBlockedPeople(entries, async jid => {
      const fromDb = pairs.flatMap(([a, b]) => (a === jid ? [b] : b === jid ? [a] : []));
      const fromSignal = await signalAlias(sock, jid);
      return [...fromDb, ...(fromSignal ? [fromSignal] : [])];
    });
    const blocked = this.ingest
      ? await describeBlockedPeople(groups)
      : groups.map(group => ({
          id: personId(group.jids),
          jids: group.jids,
          blockedJids: group.blocked,
          phone: group.jids.map(phoneOfJid).find((value): value is string => !!value) || null,
          name: null,
          pushName: null,
          conversationId: null,
        }));
    return { blocked, readAt, cached: !!cached };
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

  // ---------------------------------------------------------------------------
  // Polls and events (fase 3 / PR-7)
  // ---------------------------------------------------------------------------

  /** Our own user jids for the vote / response crypto (meJid when the socket has no user: a PN or a LID). */
  private async ownIdentity(): Promise<OwnIdentity> {
    const ids = [...(await this.ownIds()), cryptoUserJid(this.meJid)];
    return {
      pn: ids.find(id => id?.endsWith('@s.whatsapp.net')) ?? null,
      lid: ids.find(id => id?.endsWith('@lid')) ?? null,
    };
  }

  /** Candidates plus their PN ↔ LID alternates from Baileys' mapping. */
  private async withAliases(jids: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const jid of jids) {
      for (const alias of await this.jidAliases(jid)) {
        const user = cryptoUserJid(alias);
        if (user && !out.includes(user)) out.push(user);
      }
    }
    return out;
  }

  /** Poll / event creation message by id: memory, then the durable payload (PR-1). */
  private async structuredOriginal(id: string): Promise<WAMessage | undefined> {
    return this.memoryMessage(id) || (await this.durableMessage(id));
  }

  /**
   * A vote or a response seen on the socket (a contact, our phone) → its
   * table. The poll / event must be known with its secret, else the update is
   * logged and skipped (never a crash): a poll received before the durable
   * payloads (PR-1) cannot be decrypted. The raw update is kept as a payload.
   */
  private async ingestPollOrEventResponse(msg: WAMessage, options: IngestOptions): Promise<void> {
    if (!this.ingest || !msg.key?.id || !msg.key.remoteJid) return;
    const content = normalizeMessageContent(msg.message);
    const conversationId = this.normalizeJid(msg.key.remoteJid);
    await this.persistDurablePayload(
      msg,
      conversationId,
      options.source === 'baileys_history_sync' ? 'history' : 'live'
    );
    const fromMe = !!msg.key.fromMe;
    const person = this.normalizeJid(
      fromMe ? this.meJid || msg.key.remoteJid : msg.key.participant || msg.key.remoteJid
    );
    const own = await this.ownIdentity();
    const at = (ms: number | undefined) =>
      new Date(ms || (unixSeconds(msg.messageTimestamp) || 0) * 1000 || Date.now());

    const update = content?.pollUpdateMessage;
    if (update) {
      const pollId = update.pollCreationMessageKey?.id || '';
      const poll = pollId ? await this.structuredOriginal(pollId) : undefined;
      const definition = parsePollDefinition(poll?.message);
      const secret = messageSecretOf(poll?.message);
      if (!poll || !definition || !secret) {
        this.logger.info(
          `Poll vote ${msg.key.id} for ${pollId || 'an unknown poll'} skipped: ${
            !poll ? 'poll unknown' : !definition ? 'not a poll' : 'poll secret unavailable'
          }`
        );
        return;
      }
      const decrypted = decryptPollVoteWith(update.vote, {
        pollId,
        secret,
        creators: await this.withAliases([
          ...keyAuthorCandidates(poll.key, own),
          ...keyAuthorCandidates(update.pollCreationMessageKey as WAMessageKey, own),
        ]),
        voters: await this.withAliases(keyAuthorCandidates(msg.key, own)),
      });
      if (!decrypted) {
        this.logger.warn(`Poll vote ${msg.key.id} for ${pollId} could not be decrypted: skipped`);
        return;
      }
      const { names } = selectedOptionNames(definition, decrypted.hashes);
      await storePollVote({
        pollMessageId: pollId,
        conversationId,
        voterJid: person,
        selectedOptions: names,
        selectedHashes: decrypted.hashes,
        fromMe,
        voteMessageId: msg.key.id,
        votedAt: at(int64Ms(update.senderTimestampMs)),
      });
      return;
    }

    const enc = content?.encEventResponseMessage;
    const eventId = enc?.eventCreationMessageKey?.id || '';
    const event = eventId ? await this.structuredOriginal(eventId) : undefined;
    const secret = messageSecretOf(event?.message);
    if (!enc || !event || !parseEventDefinition(event.message) || !secret) {
      this.logger.info(
        `Event response ${msg.key.id} for ${eventId || 'an unknown event'} skipped: ${
          !event ? 'event unknown' : !secret ? 'event secret unavailable' : 'not an event'
        }`
      );
      return;
    }
    const decrypted = decryptEventResponseWith(enc, {
      eventId,
      secret,
      creators: await this.withAliases([
        ...keyAuthorCandidates(event.key, own),
        ...keyAuthorCandidates(enc.eventCreationMessageKey as WAMessageKey, own),
      ]),
      responders: await this.withAliases(keyAuthorCandidates(msg.key, own)),
    });
    if (!decrypted) {
      this.logger.warn(
        `Event response ${msg.key.id} for ${eventId} could not be decrypted: skipped`
      );
      return;
    }
    await storeEventResponse({
      eventMessageId: eventId,
      conversationId,
      responderJid: person,
      response: decrypted.response,
      extraGuestCount: decrypted.extraGuestCount,
      fromMe,
      responseMessageId: msg.key.id,
      respondedAt: at(decrypted.timestampMs),
    });
  }

  /**
   * The chat a new poll / event goes to: the canonical conversation's jid
   * (a merged PN twin sends to its @lid), else the id as given. Only groups,
   * phone-number and LID chats (a broadcast, newsletter or another account's
   * prefix is 400).
   */
  private async structuredSendTarget(
    chatId: string,
    what: string
  ): Promise<{ raw: string; conversationId: string; canonicalId: string | null }> {
    const requested = stripAccountKey(String(chatId || '').trim());
    if (!STRUCTURED_CHAT_JID.test(requested)) {
      throw new MessageMutationError(
        `${what}: ${requested || 'conversationId'} is not a WhatsApp group, phone or LID chat`,
        400,
        'invalid_request'
      );
    }
    const conversation = this.ingest ? await resolveCanonicalConversation(requested) : undefined;
    const raw = this.toRawJid(conversation?.externalId || requested);
    return { raw, conversationId: this.normalizeJid(raw), canonicalId: conversation?.id ?? null };
  }

  /** The poll / event behind a vote / response, or the precise reason it cannot be used. */
  private async structuredTarget(
    chatId: string,
    messageId: string,
    kind: 'poll' | 'event'
  ): Promise<{ target: MutationTarget; original: WAMessage; secret: Uint8Array }> {
    const target = await this.resolveMutationTarget(
      chatId,
      messageId,
      kind === 'poll' ? 'vote' : 'respond'
    );
    const original = await this.structuredOriginal(target.id);
    const parsed =
      kind === 'poll'
        ? parsePollDefinition(original?.message)
        : parseEventDefinition(original?.message);
    if (!original || !parsed) {
      const rowType = target.stored?.messageType || '';
      const maybe = (kind === 'poll' ? POLL_ROW_TYPES : EVENT_ROW_TYPES).test(rowType);
      if (original || (target.stored && !maybe)) {
        throw new MessageMutationError(
          `Message ${target.id} is not a${kind === 'poll' ? ' poll' : 'n event'}`,
          422,
          kind === 'poll' ? 'not_a_poll' : 'not_an_event'
        );
      }
      throw new MessageMutationError(
        `The ${kind} ${target.id} is not stored with its content (received before the connector kept payloads): answer it from the phone`,
        422,
        `${kind}_secret_unavailable`
      );
    }
    const secret = messageSecretOf(original.message);
    if (!secret) {
      throw new MessageMutationError(
        `The ${kind} ${target.id} has no encryption secret: answer it from the phone`,
        422,
        `${kind}_secret_unavailable`
      );
    }
    const key = { ...original.key, ...target.key, id: target.id };
    return { target: { ...target, key }, original: { ...original, key }, secret };
  }

  /** A relayed control message (vote / response): kept for retries and restarts. */
  private async relayStructured(
    sock: WASocket,
    chatJid: string,
    content: proto.IMessage,
    options: StructuredSendOptions,
    userJid: string
  ): Promise<string> {
    const messageId = options.messageId || generateMessageIDV2(sock.user?.id);
    const full = generateWAMessageFromContent(chatJid, content, { messageId, userJid });
    await options.beforeSend?.();
    await sock.relayMessage(chatJid, full.message as proto.IMessage, { messageId });
    this.rememberKey(messageId, full.key, chatJid);
    this.rememberMessageForRetry(full.key, full.message);
    await this.persistDurablePayload(full, this.normalizeJid(chatJid), 'sent');
    return messageId;
  }

  /**
   * Send a poll. Its POLL row comes from the echo Baileys emits (like every
   * send); the payload with the secret is stored now, so votes can be read
   * and cast after a restart.
   */
  async sendPoll(
    chatId: string,
    poll: ValidatedPoll,
    options: StructuredSendOptions = {}
  ): Promise<StructuredSendResult> {
    const sock = this.connectedSocket();
    const target = await this.structuredSendTarget(chatId, 'sendPoll');
    await this.guardDirectSend(target.raw);
    const sendOptions = withEphemeralExpiration(
      options.messageId ? { messageId: options.messageId } : undefined,
      await this.outgoingEphemeral(target.raw, target.canonicalId)
    );
    await options.beforeSend?.();
    const sent = await sock.sendMessage(target.raw, buildPollContent(poll), sendOptions);
    return this.afterStructuredSend(sent, target, 'Poll', options.actor);
  }

  async sendEvent(
    chatId: string,
    event: ValidatedEvent,
    options: StructuredSendOptions = {}
  ): Promise<StructuredSendResult> {
    const sock = this.connectedSocket();
    const target = await this.structuredSendTarget(chatId, 'sendEvent');
    await this.guardDirectSend(target.raw);
    const sendOptions = withEphemeralExpiration(
      options.messageId ? { messageId: options.messageId } : undefined,
      await this.outgoingEphemeral(target.raw, target.canonicalId)
    );
    await options.beforeSend?.();
    const sent = await sock.sendMessage(target.raw, buildEventContent(event), sendOptions);
    return this.afterStructuredSend(sent, target, 'Event', options.actor);
  }

  private async afterStructuredSend(
    sent: WAMessage | undefined,
    target: { raw: string; conversationId: string },
    what: 'Poll' | 'Event',
    actor?: string
  ): Promise<StructuredSendResult> {
    const messageId = sent?.key?.id;
    if (!sent || !messageId)
      throw new Error(`WhatsApp returned no message id for the ${what.toLowerCase()}`);
    this.rememberKey(messageId, sent.key, target.raw);
    this.rememberMessageForRetry(sent.key, sent.message);
    await this.persistDurablePayload(sent, target.conversationId, 'sent');
    this.logger.info(`${what} ${messageId} sent to ${target.raw}${actor ? ` by ${actor}` : ''}`);
    return { messageId, conversationId: target.conversationId, sentAt: new Date().toISOString() };
  }

  /**
   * Vote on a poll (the complete selection; [] retracts). The poll comes from
   * memory or its durable payload (needs its secret); the vote is signed with
   * the identities the chat is addressed with (poll-votes.ts) and recorded
   * as ours once WhatsApp has it.
   */
  async sendPollVote(
    chatId: string,
    messageId: string,
    options: unknown,
    sendOptions: StructuredSendOptions = {}
  ): Promise<PollVoteResult> {
    const sock = this.connectedSocket();
    const { target, original, secret } = await this.structuredTarget(chatId, messageId, 'poll');
    const definition = parsePollDefinition(original.message)!;
    const selection = validatePollSelection(definition, options);
    const own = await this.ownIdentity();
    const lidAddressed = isJidGroup(target.chatJid)
      ? (await this.fetchGroupMetadata(target.chatJid).catch(() => undefined))?.addressingMode ===
        'lid'
      : target.chatJid.endsWith('@lid');
    const pair = pollSigningPair(target.key, own, lidAddressed);
    if (!pair) {
      throw new MessageMutationError(
        `Cannot tell which identity signs a vote on ${target.id}`,
        422,
        'identity_unavailable'
      );
    }
    const votedAtMs = Date.now();
    const content = buildPollVoteContent({
      creationKey: { ...target.key, remoteJid: target.chatJid },
      secret,
      creator: pair.creator,
      voter: pair.voter,
      options: selection,
      senderTimestampMs: votedAtMs,
    });
    const voteId = await this.relayStructured(
      sock,
      target.chatJid,
      content,
      sendOptions,
      pair.voter
    );
    const conversationId = this.normalizeJid(target.chatJid);
    const persisted =
      this.ingest && !!this.meJid
        ? await storePollVote({
            pollMessageId: target.id,
            conversationId,
            voterJid: this.normalizeJid(this.meJid),
            selectedOptions: selection,
            selectedHashes: selection.map(optionHash),
            fromMe: true,
            voteMessageId: voteId,
            votedAt: new Date(votedAtMs),
          })
        : false;
    this.logger.info(
      `Poll vote ${voteId} on ${target.id} (${selection.length ? `${selection.length} option(s)` : 'retracted'})${
        sendOptions.actor ? ` by ${sendOptions.actor}` : ''
      }`
    );
    return {
      messageId: voteId,
      pollMessageId: target.id,
      conversationId,
      options: selection,
      retracted: selection.length === 0,
      votedAt: new Date(votedAtMs).toISOString(),
      persisted,
    };
  }

  /**
   * Answer an event (going / not_going / maybe). Signed with phone jids (see
   * event-responses.ts); recorded as ours once WhatsApp has it.
   */
  async respondToEvent(
    chatId: string,
    messageId: string,
    answer: { response: EventResponse; extraGuestCount: number },
    sendOptions: StructuredSendOptions = {}
  ): Promise<EventResponseResult> {
    const sock = this.connectedSocket();
    const { target, original, secret } = await this.structuredTarget(chatId, messageId, 'event');
    const definition = parseEventDefinition(original.message)!;
    if (definition.isCanceled) {
      throw new MessageMutationError(
        `The event ${target.id} was cancelled`,
        422,
        'event_cancelled'
      );
    }
    if (answer.extraGuestCount > 0 && !definition.extraGuestsAllowed) {
      throw new PollEventInputError('This event does not allow extra guests', {
        field: 'extraGuestCount',
      });
    }
    const own = await this.ownIdentity();
    // An event response is signed with phone numbers: ours comes from the LID when that is all we know.
    const ownPn =
      (await this.withAliases([own.pn, own.lid].filter((jid): jid is string => !!jid))).find(jid =>
        jid.endsWith('@s.whatsapp.net')
      ) ?? null;
    const creator = target.key.fromMe
      ? ownPn
      : (await this.withAliases(keyAuthorCandidates(target.key, own))).find(jid =>
          jid.endsWith('@s.whatsapp.net')
        ) || null;
    if (!ownPn || !creator) {
      throw new MessageMutationError(
        `Cannot resolve the phone identities that sign a response to ${target.id}`,
        422,
        'identity_unavailable'
      );
    }
    const respondedAtMs = Date.now();
    const content = buildEventResponseContent({
      eventKey: { ...target.key, remoteJid: target.chatJid },
      secret,
      creator,
      responder: ownPn,
      response: answer.response,
      extraGuestCount: answer.extraGuestCount,
      timestampMs: respondedAtMs,
    });
    const responseId = await this.relayStructured(
      sock,
      target.chatJid,
      content,
      sendOptions,
      ownPn
    );
    const conversationId = this.normalizeJid(target.chatJid);
    const persisted =
      this.ingest && !!this.meJid
        ? await storeEventResponse({
            eventMessageId: target.id,
            conversationId,
            responderJid: this.normalizeJid(this.meJid),
            response: answer.response,
            extraGuestCount: answer.extraGuestCount,
            fromMe: true,
            responseMessageId: responseId,
            respondedAt: new Date(respondedAtMs),
          })
        : false;
    this.logger.info(
      `Event response ${responseId} on ${target.id} (${answer.response})${
        sendOptions.actor ? ` by ${sendOptions.actor}` : ''
      }`
    );
    return {
      messageId: responseId,
      eventMessageId: target.id,
      conversationId,
      response: answer.response,
      extraGuestCount: answer.response === 'going' ? answer.extraGuestCount : 0,
      respondedAt: new Date(respondedAtMs).toISOString(),
      persisted,
    };
  }

  /** Definition of a poll / event for its results: memory, payload, then metadata of its row. */
  private async structuredDefinition<K extends 'poll' | 'event'>(
    messageId: string,
    kind: K
  ): Promise<{
    id: string;
    conversationId: string;
    definition: K extends 'poll'
      ? NonNullable<ReturnType<typeof parsePollDefinition>>
      : NonNullable<ReturnType<typeof parseEventDefinition>>;
  }> {
    const id = stripAccountKey(String(messageId || '').trim());
    if (!id) throw new MessageMutationError('messageId is required', 400, 'invalid_request');
    const original = await this.structuredOriginal(id);
    const meta = this.ingest ? await loadStructuredMetadata(id) : undefined;
    const parsed =
      kind === 'poll'
        ? parsePollDefinition(original?.message) || meta?.poll
        : parseEventDefinition(original?.message) || meta?.event;
    if (!parsed) {
      if (!original && !meta) {
        throw new MessageUnavailableError(
          `Message ${id} is unavailable`,
          404,
          'message_unavailable'
        );
      }
      throw new MessageMutationError(
        `Message ${id} is not a${kind === 'poll' ? ' poll' : 'n event'}`,
        422,
        kind === 'poll' ? 'not_a_poll' : 'not_an_event'
      );
    }
    const conversationId =
      meta?.conversationId ||
      (original?.key.remoteJid ? this.normalizeJid(original.key.remoteJid) : '');
    return { id, conversationId, definition: parsed as never };
  }

  /** Current results of a poll: its definition + the stored votes (read-only). */
  async getPollResults(chatId: string, messageId: string): Promise<PollResultsView> {
    const { id, conversationId, definition } = await this.structuredDefinition(messageId, 'poll');
    const votes = this.ingest ? await readPollVotes(id) : { available: false, votes: [] };
    return {
      messageId: id,
      conversationId: conversationId || this.normalizeJid(this.toRawJid(stripAccountKey(chatId))),
      ...aggregatePollResults(definition, votes.votes),
      persisted: votes.available,
    };
  }

  /** Current responses of an event: its definition + the stored responses (read-only). */
  async getEventResults(chatId: string, messageId: string): Promise<EventResultsView> {
    const { id, conversationId, definition } = await this.structuredDefinition(messageId, 'event');
    const stored = this.ingest ? await readEventResponses(id) : { available: false, responses: [] };
    return {
      messageId: id,
      conversationId: conversationId || this.normalizeJid(this.toRawJid(stripAccountKey(chatId))),
      ...definition,
      ...aggregateEventResults(stored.responses),
      persisted: stored.available,
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
    const original = await this.currentMessage(id);
    if (!original?.message) {
      throw new MessageUnavailableError(
        `forwardMessage: message ${id} of ${chatId} is unavailable (not in memory nor in the durable store)`,
        404,
        'message_unavailable'
      );
    }
    const rawTarget = this.toRawJid(toChatId);
    await this.guardDirectSend(rawTarget);
    const sendOptions = withEphemeralExpiration(undefined, await this.outgoingEphemeral(rawTarget));
    const sent = sendOptions
      ? await this.sock.sendMessage(rawTarget, { forward: original }, sendOptions)
      : await this.sock.sendMessage(rawTarget, { forward: original });
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
  // Starred and pinned messages. Persistence: message-stars-pins.ts.
  // ---------------------------------------------------------------------------

  /**
   * Star / unstar a message as the phone does: an app-state patch keyed by the
   * message key (memory, durable payload, whatsapp_message_keys or the messages
   * row, so it survives restarts). Only this account sees it. Recorded once
   * WhatsApp accepted it (ingest only); the echo Baileys replays is skipped.
   */
  async starMessage(
    chatId: string | undefined,
    messageId: string,
    star: boolean,
    request: MessageMutationRequest = {}
  ): Promise<StarResult> {
    // 01-10-2026: un star/unstar real (Skirmshop) acabó en stream:error 401
    // conflict device_removed 3 s después — WhatsApp desvinculó el dispositivo.
    // El parche de app-state propio queda apagado hasta validarlo; solo se activa
    // a propósito con WA_STAR_ENABLED=true (no está en ningún overlay).
    if (process.env.WA_STAR_ENABLED !== 'true') {
      throw new MessageMutationError(
        'Starring messages is disabled on this connector (WA_STAR_ENABLED): a real star patch got the linked device removed by WhatsApp',
        403,
        'star_disabled'
      );
    }
    const sock = this.connectedSocket();
    const target = await this.resolveMutationTarget(chatId || '', messageId, 'starMessage');
    if (isJidGroup(target.chatJid) && !target.key.fromMe && !target.key.participant) {
      throw new MessageUnavailableError(
        `starMessage: the author of ${target.id} is unknown (WhatsApp needs it in a group)`,
        404,
        'message_unavailable'
      );
    }
    const starredAt = new Date();
    await this.withOwnMutation('star', target.id, () =>
      this.applyAppPatch(
        sock,
        starPatch(
          {
            remoteJid: target.chatJid,
            id: target.id,
            fromMe: !!target.key.fromMe,
            participant: target.key.participant,
          },
          star
        ),
        star ? 'star' : 'unstar',
        target.id
      )
    );
    const conversationId = this.normalizeJid(target.chatJid);
    const persisted = this.ingest
      ? await recordMessageStar({
          messageId: target.id,
          chatId: conversationId,
          fromMe: !!target.key.fromMe,
          starred: star,
          at: starredAt,
          source: 'connector',
          actor: request.actor,
        })
      : false;
    this.logger.info(`${star ? 'Starred' : 'Unstarred'} ${target.id} in ${target.chatJid}`);
    return {
      starred: star,
      messageId: target.id,
      conversationId,
      starredAt: starredAt.toISOString(),
      persisted,
    };
  }

  /**
   * Pin / unpin a message for everyone in its chat (24 h, 7 d or 30 d). In a
   * group whose info only admins may edit, only admins pin (fresh metadata).
   * The key comes from the durable copies like any mutation; the action is
   * recorded once WhatsApp has it (ingest only), at the time the pin message
   * carries, so its echo changes nothing.
   */
  async pinMessage(request: PinRequest, options: StructuredSendOptions = {}): Promise<PinResult> {
    const sock = this.connectedSocket();
    const target = await this.resolveMutationTarget(
      request.chatId || '',
      request.messageId,
      'pinMessage'
    );
    if (isJidGroup(target.chatJid)) {
      if (!target.key.fromMe && !target.key.participant) {
        throw new MessageUnavailableError(
          `pinMessage: the author of ${target.id} is unknown (WhatsApp needs it in a group)`,
          404,
          'message_unavailable'
        );
      }
      await this.checkGroupPinAllowed(target.chatJid);
    }
    const content = pinContent(target.key, request.pin, request.durationSeconds);
    // Our own id, so the echo Baileys emits during the send is recognised.
    const actionId = options.messageId || generateMessageIDV2(sock.user?.id);
    const sent = await this.withOwnMutation('pin', actionId, async () => {
      await options.beforeSend?.();
      return sock.sendMessage(target.chatJid, content as AnyMessageContent, {
        messageId: actionId,
      });
    });
    const conversationId = this.normalizeJid(target.chatJid);
    if (sent?.key?.id && sent.message) {
      this.rememberMessageForRetry(sent.key, sent.message);
      await this.persistDurablePayload(sent, conversationId, 'sent');
    }
    const at = (sent && pinActionOf(sent)?.at) || new Date();
    const duration = request.pin ? request.durationSeconds : undefined;
    const persisted =
      this.ingest && !!this.meJid
        ? await recordMessagePin({
            messageId: target.id,
            chatId: conversationId,
            pinned: request.pin,
            at,
            durationSeconds: duration,
            byJid: this.normalizeJid(this.meJid),
            actionId,
            source: 'connector',
            actor: options.actor,
          })
        : false;
    this.logger.info(
      `${request.pin ? 'Pinned' : 'Unpinned'} ${target.id} in ${target.chatJid}${
        duration ? ` for ${duration}s` : ''
      }${options.actor ? ` by ${options.actor}` : ''}`
    );
    return {
      pinned: request.pin,
      messageId: actionId,
      pinnedMessageId: target.id,
      conversationId,
      ...(duration
        ? {
            pinnedAt: at.toISOString(),
            expiresAt: new Date(at.getTime() + duration * 1000).toISOString(),
            durationSeconds: duration,
          }
        : {}),
      persisted,
    };
  }

  /** Active pins of a chat (what WhatsApp shows: the newest 3), from the DB. */
  async listPinnedMessages(chatId: string): Promise<PinnedList> {
    const { conversationId, ids } = await this.markChat(chatId, 'listPinnedMessages');
    const found = this.ingest ? await listPinnedMessages(ids) : { pinned: [], persisted: false };
    return { conversationId, ...found, limit: MAX_PINS_PER_CHAT };
  }

  /** Starred messages of this account (or of one chat), newest star first, from the DB. */
  async listStarredMessages(
    query: StarredQuery
  ): Promise<StarredList & { conversationId?: string }> {
    if (!this.ingest) return { starred: [], nextCursor: null, persisted: false };
    const chat = query.chatId ? await this.markChat(query.chatId, 'listStarredMessages') : null;
    const found = await listStarredMessages({
      chatIds: chat?.ids,
      limit: query.limit,
      cursor: query.cursor,
    });
    return chat ? { conversationId: chat.conversationId, ...found } : found;
  }

  /**
   * Statuses of the account's contacts (and our own), newest first: the
   * whatsapp_statuses index + their messages rows. `contact` (phone or user
   * jid) narrows to one person, its PN and LID ids together. Reads the DB:
   * answers while disconnected; a pairing-only client has none.
   */
  async listStatuses(query: StatusListQuery): Promise<StatusList & { contact?: string }> {
    if (!this.ingest) return { statuses: [], nextCursor: null, persisted: false };
    let contact: string | undefined;
    let authorIds: string[] | undefined;
    if (query.contact) {
      try {
        contact = this.normalizeJid(statusRecipientJid(query.contact));
      } catch {
        throw new MessageMutationError(
          'contact must be a phone number or a WhatsApp user jid',
          400,
          'invalid_request'
        );
      }
      authorIds = await contactAuthorIds(contact);
    }
    const found = await listStatuses({
      authorIds,
      includeExpired: query.includeExpired,
      includeOwn: query.includeOwn,
      limit: query.limit,
      cursor: query.cursor,
    });
    return contact ? { contact, ...found } : found;
  }

  /** Posts of the channels this account receives (or of one), from messages. */
  async listChannelPosts(query: ChannelPostsQuery): Promise<ChannelPostList> {
    if (!this.ingest) return { posts: [], nextCursor: null, channels: 0 };
    return listChannelPosts(query);
  }

  /**
   * Publish a text or image status to an explicit list of contacts
   * (`statusJidList`: WhatsApp relays it to exactly those people, whatever the
   * phone's status privacy says). Off unless WA_STATUS_PUBLISH_ENABLED=true;
   * the route adds the send gate and confirm: true. One socket call, no
   * retry: a status cannot be taken back from those who saw it.
   */
  async publishStatus(
    request: StatusPublishRequest,
    options: { messageId?: string; beforeSend?: () => Promise<void>; actor?: string } = {}
  ): Promise<{
    published: true;
    messageId: string;
    conversationId: typeof STATUS_JID;
    type: StatusPublishRequest['type'];
    audienceSize: number;
    postedAt: string;
    expiresAt: string;
    persisted: boolean;
  }> {
    if (!statusPublishEnabled()) {
      throw new MessageMutationError(
        'Publishing statuses is disabled on this connector (WA_STATUS_PUBLISH_ENABLED)',
        403,
        'status_publish_disabled'
      );
    }
    const sock = this.connectedSocket();
    const own = new Set(await this.ownIds().catch(() => [] as string[]));
    if (this.meJid) own.add(jidNormalizedUser(this.meJid));
    const recipients = request.recipients.filter(jid => !own.has(jid));
    if (!recipients.length) {
      throw new MessageMutationError(
        'recipients must name someone other than this account',
        400,
        'invalid_request'
      );
    }
    let payload: AnyMessageContent;
    if (request.type === 'text') {
      payload = { text: request.text || '' };
    } else {
      payload = await this.statusImage(request.url || '', request.text);
    }
    const sendOptions = {
      statusJidList: recipients,
      broadcast: true,
      ...(options.messageId ? { messageId: options.messageId } : {}),
      ...(request.backgroundColor ? { backgroundColor: request.backgroundColor } : {}),
      ...(request.font ? { font: request.font } : {}),
    };
    await options.beforeSend?.();
    const sent = await sock.sendMessage(STATUS_JID, payload, sendOptions as any);
    const messageId = sent?.key?.id;
    if (!sent?.key || !messageId) {
      throw new MessageMutationError(
        'WhatsApp did not answer the status with an id: it may or may not have gone out',
        502,
        'send_outcome_uncertain'
      );
    }
    this.rememberKey(messageId, sent.key, STATUS_JID);
    this.rememberMessageForRetry(sent.key, sent.message);
    await this.persistDurablePayload(sent, STATUS_JID, 'sent');
    const seconds = Number(sent.messageTimestamp || 0);
    const postedAt = seconds > 0 ? new Date(seconds * 1000) : new Date();
    const self = this.meJid || sock.user?.id || '';
    const persisted =
      this.ingest && self
        ? await recordStatus({
            messageId,
            authorId: this.normalizeJid(jidNormalizedUser(self) || self),
            fromMe: true,
            messageType: request.type === 'text' ? 'TEXT' : 'IMAGE',
            postedAt,
            source: 'connector',
            audienceSize: recipients.length,
            actor: options.actor,
          })
        : false;
    this.logger.info(
      `Status ${messageId} (${request.type}) published to ${recipients.length} contacts${options.actor ? ` by ${options.actor}` : ''}`
    );
    return {
      published: true,
      messageId,
      conversationId: STATUS_JID,
      type: request.type,
      audienceSize: recipients.length,
      postedAt: postedAt.toISOString(),
      expiresAt: new Date(postedAt.getTime() + STATUS_TTL_MS).toISOString(),
      persisted,
    };
  }

  /** The image of a status: fetched server-side, JPEG / PNG up to 10 MB. */
  private async statusImage(url: string, caption?: string): Promise<AnyMessageContent> {
    let buffer: Buffer;
    let mimeType: string;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      mimeType = (res.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
      buffer = Buffer.from(await res.arrayBuffer());
    } catch (e: any) {
      throw new MessageMutationError(
        `Failed to fetch the status image from ${url}: ${e?.message || e}`,
        422,
        'media_unavailable'
      );
    }
    if (!STATUS_IMAGE_MIME_TYPES.has(mimeType)) {
      throw new MessageMutationError(
        `The status image must be ${[...STATUS_IMAGE_MIME_TYPES].join(' or ')}, got ${mimeType || 'no content-type'}`,
        400,
        'invalid_request'
      );
    }
    if (!buffer.length || buffer.length > STATUS_IMAGE_MAX_BYTES) {
      throw new MessageMutationError(
        `The status image must be 1 byte to ${STATUS_IMAGE_MAX_BYTES} bytes`,
        400,
        'invalid_request'
      );
    }
    return { image: buffer, mimetype: mimeType, ...(caption ? { caption } : {}) };
  }

  /**
   * The ids a chat's stars / pins may be filed under (namespaced): its
   * canonical conversation (tombstones and contact aliases followed) and the
   * chat's own external ids, for a message never ingested.
   */
  private async markChat(
    chatId: string,
    action: string
  ): Promise<{ conversationId: string; ids: string[] }> {
    const requested = stripAccountKey(String(chatId || '').trim());
    if (!requested) {
      throw new MessageMutationError(
        `${action}: conversationId is required`,
        400,
        'invalid_request'
      );
    }
    const normalized = this.normalizeJid(this.toRawJid(requested));
    const canonical = this.ingest ? await resolveCanonicalConversation(normalized) : undefined;
    const ids = new Set<string>(canonical ? [canonical.id] : []);
    for (const candidate of externalIdCandidates(normalized)) ids.add(accountKey(candidate));
    return {
      conversationId: canonical ? stripAccountKey(canonical.id) : normalized,
      ids: [...ids],
    };
  }

  /**
   * Who may pin in a group: every member, or only admins when the group's
   * info is admin-only (`restrict`, what WhatsApp calls "Edit group settings").
   */
  private async checkGroupPinAllowed(raw: string): Promise<void> {
    const meta = await this.groupMetadataForAction(raw);
    const self = ownParticipant(meta, await this.ownIds());
    if (!self) {
      throw new GroupActionError(
        `This account is not a participant of ${raw}`,
        403,
        'not_group_member'
      );
    }
    if (meta.restrict === true && !isAdminRole(self.admin)) {
      throw new GroupActionError(`Only admins can pin messages in ${raw}`, 403, 'not_group_admin');
    }
  }

  /** appPatch, with WhatsApp's own refusals as 422 rejected_by_whatsapp. */
  private async applyAppPatch(
    sock: WASocket,
    patch: WAPatchCreate,
    what: string,
    id: string
  ): Promise<void> {
    try {
      await sock.appPatch(patch);
    } catch (e: any) {
      const status = Number(e?.output?.statusCode ?? e?.data?.statusCode);
      const connectionStatus = [401, 408, 428, 440].includes(status);
      if (e?.isBoom && status >= 400 && status < 500 && !connectionStatus) {
        throw new MessageMutationError(
          `WhatsApp rejected the ${what} of ${id}: ${e?.message || e}`,
          422,
          'rejected_by_whatsapp',
          String(status)
        );
      }
      throw e;
    }
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
    kind: 'edit' | 'revoke' | 'forme' | 'star' | 'pin',
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

  private isOwnMutation(kind: 'edit' | 'revoke' | 'forme' | 'star' | 'pin', id: string): boolean {
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
    // Baileys unwraps MESSAGE_EDIT protocol messages into this shape.
    const editedPayload = (u.update as any)?.message?.editedMessage?.message as
      proto.IMessage | undefined;
    if (!isRevoke && !editedPayload) return;
    // A channel's ids are only unique inside it: the row is the one of THIS channel's post.
    const rowId = isChannelJid(u.key.remoteJid)
      ? await channelPostMessageId(this.normalizeJid(String(u.key.remoteJid)), waMessageId)
      : waMessageId;
    if (isRevoke && !this.isOwnMutation('revoke', waMessageId)) {
      const flagged = await this.recordInboundRevoke(rowId);
      // No row to flag: for a channel post or a status its post may still be on its way.
      if (!flagged && (isChannelJid(u.key.remoteJid) || isStatusJid(u.key.remoteJid))) {
        const chat = this.normalizeJid(String(u.key.remoteJid));
        noteRevokeBeforePost(chat, waMessageId);
        this.logger.info(`Revoke of ${chat} ${waMessageId} found no post: remembered`);
      }
    }
    if (editedPayload && !this.isOwnMutation('edit', waMessageId)) {
      await this.recordInboundEdit({ ...u.key, id: rowId }, editedPayload);
    }
  }

  /**
   * messages.update with `starred`: a star / unstar from our phone or another
   * linked device (Baileys turns the app-state star action into this). The
   * echo of our own star is left to starMessage.
   */
  private async handleInboundStar(u: WAMessageUpdate): Promise<void> {
    const starred = (u.update as { starred?: unknown } | undefined)?.starred;
    const id = u.key?.id;
    if (!this.ingest || !id || !u.key.remoteJid || typeof starred !== 'boolean') return;
    if (this.isOwnMutation('star', id)) return;
    await recordMessageStar({
      messageId: id,
      chatId: this.normalizeJid(u.key.remoteJid),
      fromMe: typeof u.key.fromMe === 'boolean' ? u.key.fromMe : null,
      starred,
      source: 'whatsapp',
    });
  }

  /**
   * A pin / unpin seen on the socket (anyone in the chat, our phone, the echo
   * of ours) → whatsapp_message_pins; the raw action is kept as a payload. One
   * we cannot apply (unknown type or duration) is logged and dropped.
   */
  private async ingestPinAction(msg: WAMessage, options: IngestOptions): Promise<void> {
    if (!this.ingest || !msg.key?.remoteJid) return;
    // The echo of our own pin: pinMessage records it.
    if (msg.key.fromMe && msg.key.id && this.isOwnMutation('pin', msg.key.id)) return;
    const history = options.source === 'baileys_history_sync';
    await this.persistDurablePayload(
      msg,
      this.normalizeJid(msg.key.remoteJid),
      history ? 'history' : 'live'
    );
    const action = pinActionOf(msg);
    if (!action) {
      this.logger.warn(`Pin action ${msg.key.id || '?'} not applied: unknown type or duration`);
      return;
    }
    const by = msg.key.fromMe ? this.meJid : msg.key.participant || msg.key.remoteJid;
    await recordMessagePin({
      messageId: action.targetId,
      chatId: this.normalizeJid(action.chatJid),
      pinned: action.pinned,
      at: action.at,
      durationSeconds: action.durationSeconds,
      byJid: by ? this.normalizeJid(jidNormalizedUser(by)) : undefined,
      actionId: action.actionId,
      source: history ? 'history' : 'whatsapp',
    });
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
  private async recordInboundRevoke(waMessageId: string): Promise<boolean> {
    const flagged = await markMessageRevoked(waMessageId, { source: 'whatsapp' }).catch(e =>
      this.logger.warn(`revoke persist failed for ${waMessageId}: ${e?.message || e}`)
    );
    this.emit('message-update', { waMessageId, updateType: 'DELETED' });
    return flagged === true;
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
    await setCanonicalChatState(norm, { unreadCount: 0 });
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

  /**
   * A group-participants.update "add": when it names this account (PN or
   * LID), someone added us to a group — fresh metadata, then its conversation
   * row (recordGroupConversation: namespaced, account_id, external_id, a live
   * row only refreshed), active as of now. Anyone else's add changes nothing
   * here. Never throws (a socket handler); ingest only (bound after the gate).
   */
  private async recordGroupJoined(
    groupJid: string,
    participants: ReadonlyArray<string | Partial<GroupParticipant>>
  ): Promise<void> {
    try {
      if (!this.ingest || !isJidGroup(groupJid)) return;
      if (!participantsIncludeOwn(participants, await this.ownIds())) return;
      const meta = await this.fetchGroupMetadata(groupJid, true).catch((e: any) => {
        this.logger.warn(`metadata of joined group ${groupJid} unavailable: ${e?.message || e}`);
        return { id: groupJid } as GroupMetadata;
      });
      const id = await recordGroupConversation(meta, { activityAt: new Date() });
      this.logger.info(`Added to group ${groupJid}${id ? ` (conversation ${id})` : ''}`);
    } catch (e: any) {
      this.logger.warn(`joined group ${groupJid} not recorded: ${e?.message || e}`);
    }
  }

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
   * statuses (401, 408, 428, 440) and the rest go on as send failures. A
   * community call names its own 403 / 404 classes.
   */
  private async groupCall<T>(
    what: string,
    raw: string,
    call: () => Promise<T>,
    classes: { forbidden: string; unavailable: string } = {
      forbidden: 'not_group_admin',
      unavailable: 'group_unavailable',
    }
  ): Promise<T> {
    try {
      return await call();
    } catch (e: any) {
      const status = Number(e?.output?.statusCode ?? e?.data?.statusCode);
      const connectionStatus = [401, 408, 428, 440].includes(status);
      if (!e?.isBoom || !(status >= 400 && status < 500) || connectionStatus) throw e;
      const reason = `WhatsApp rejected ${what} of ${raw}: ${e?.message || e}`;
      if (status === 403) {
        throw new GroupActionError(reason, 403, classes.forbidden, { code: '403' });
      }
      if (status === 404) {
        throw new GroupActionError(reason, 404, classes.unavailable, { code: '404' });
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
        // What already went out is recorded before the error is answered.
        if (this.ingest && applied.includes('subject')) {
          await recordGroupChange(raw, { subject: wanted.subject }).catch((err: any) => {
            this.logger.warn(`subject of ${raw} changed but not recorded: ${err?.message || err}`);
            return false;
          });
        }
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
      request: verb === 'add' ? addRequestOf((entry as { content?: unknown })?.content) : null,
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
    const paired = targets.map((target, index) => matched[index] ?? leftovers.shift());
    const results: GroupParticipantResult[] = targets.map((target, index) => {
      const status = paired[index]?.status ?? null;
      return {
        participant: target.input,
        jid: participantApiJid(target.sent),
        status,
        ...participantOutcome(verb, status),
      };
    });
    // 403 on add: their privacy only allows an invite. WhatsApp's private
    // code (when it sent one) is kept for POST /groups/invite, never returned.
    const inviteRequired: InviteRequiredEntry[] | undefined =
      verb === 'add'
        ? targets.flatMap((target, index) => {
            if (results[index].status !== '403') return [];
            const request = paired[index]?.request || null;
            if (request) {
              for (const alias of target.aliases) {
                this.pendingGroupInvites.set(`${raw}|${alias}`, request);
              }
            }
            return [
              {
                participant: target.input,
                jid: participantApiJid(target.sent),
                privateInvite: !!request,
                inviteExpiresAt: request?.expiration
                  ? new Date(request.expiration * 1000).toISOString()
                  : null,
              },
            ];
          })
        : undefined;
    const counts = countResults(results);
    this.logger.info(
      `Group ${raw} ${verb} participants=${targets.length} done=${counts.succeeded}${request.actor ? ` by ${request.actor}` : ''}`
    );
    if (!counts.succeeded) {
      throw new GroupActionError(
        `WhatsApp did not ${verb} any of the ${targets.length} participant(s) of ${raw}`,
        422,
        'rejected_by_whatsapp',
        {
          details: {
            action: verb,
            results,
            ...counts,
            ...(inviteRequired ? { inviteRequired } : {}),
          },
        }
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
      ...(inviteRequired ? { inviteRequired } : {}),
    };
  }

  /**
   * Invite people to a group by private message (the card WhatsApp shows with
   * "Join group"): for those an add was refused with 403 — their privacy only
   * lets them be invited. Admins only, against fresh metadata. Each person
   * gets WhatsApp's private code from that refused add when this process
   * still has it and it has not expired, else the group's invite link code.
   * The card goes to the person's canonical chat (a merged phone chat → its
   * LID), with the chat's disappearing timer. Someone already in the group is
   * reported, not messaged. Nobody invited → 422 with the results; some → 200
   * with `partial`.
   */
  async sendGroupInvites(
    groupId: string,
    participants: unknown,
    request: MessageMutationRequest & { text?: unknown } = {}
  ): Promise<GroupInvitesResult> {
    const raw = parseGroupJid(groupId);
    const members = parseGroupInviteParticipants(participants);
    const text = parseGroupInviteText(request.text);
    const sock = this.connectedSocket();
    const meta = await this.groupMetadataForAction(raw);
    const own = await this.ownIds();
    const capabilities = this.checkGroupAccess(meta, own, raw);
    if (!capabilities.isAdmin) {
      throw new GroupActionError(`Only admins can invite people to ${raw}`, 403, 'not_group_admin');
    }
    for (const member of members) {
      if (own.includes(member.jid)) {
        throw new GroupActionError('This account cannot invite itself', 422, 'self_participant');
      }
    }
    let linkCode: string | null | undefined;
    const results: GroupInviteResult[] = [];
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const member of members) {
      const base = { participant: member.input, jid: participantApiJid(member.jid) };
      if (findParticipant(meta, member.jid)) {
        results.push({
          ...base,
          ok: false,
          reason: 'already_participant',
          invite: null,
          messageId: null,
        });
        continue;
      }
      const aliases = await this.jidAliases(member.jid);
      const pending = aliases
        .map(alias => this.pendingGroupInvites.get(`${raw}|${alias}`))
        .find(item => !!item && (!item.expiration || item.expiration > nowSeconds + 60));
      let invite: 'private' | 'link' = 'private';
      let inviteCode = pending?.code;
      let inviteExpiration = pending?.expiration || nowSeconds + LINK_INVITE_TTL_SECONDS;
      if (!inviteCode) {
        invite = 'link';
        if (linkCode === undefined) {
          // A refusal here must not lose the invites already sent above.
          linkCode =
            (await this.groupCall('the invite link', raw, () => sock.groupInviteCode(raw)).catch(
              (e: any) => {
                this.logger.warn(`invite link of ${raw} unavailable: ${e?.message || e}`);
                return null;
              }
            )) || null;
        }
        if (!linkCode) {
          results.push({
            ...base,
            ok: false,
            reason: 'invite_link_unavailable',
            invite: null,
            messageId: null,
          });
          continue;
        }
        inviteCode = linkCode;
        inviteExpiration = nowSeconds + LINK_INVITE_TTL_SECONDS;
      }
      const conversation = this.ingest
        ? await resolveCanonicalConversation(member.jid).catch(() => undefined)
        : undefined;
      const chatJid = this.toRawJid(conversation?.externalId || member.jid);
      try {
        await this.guardDirectSend(chatJid);
        // Baileys fetches the group's picture for the card's thumbnail and a
        // group without one answers 404, which would fail the whole send:
        // no picture → a card without thumbnail.
        const sendOptions = {
          ...withEphemeralExpiration({}, await this.outgoingEphemeral(chatJid, conversation?.id)),
          getProfilePicUrl: (jid: string, type: 'preview' | 'image') =>
            sock.profilePictureUrl(jid, type).catch(() => undefined),
        } as MiscMessageGenerationOptions;
        const content: AnyMessageContent = {
          groupInvite: {
            inviteCode,
            inviteExpiration,
            text: text || '',
            jid: raw,
            subject: meta.subject || '',
          },
        };
        const sent = await sock.sendMessage(chatJid, content, sendOptions);
        const messageId = sent?.key?.id || null;
        if (sent?.key && messageId) {
          this.rememberKey(messageId, sent.key, chatJid);
          this.rememberMessageForRetry(sent.key, sent.message);
          await this.persistDurablePayload(sent, this.normalizeJid(chatJid), 'sent').catch(
            (e: any) =>
              this.logger.warn(`invite ${messageId} payload not stored: ${e?.message || e}`)
          );
        }
        if (invite === 'private') {
          for (const alias of aliases) this.pendingGroupInvites.delete(`${raw}|${alias}`);
        }
        results.push({
          ...base,
          jid: participantApiJid(chatJid),
          ok: true,
          reason: 'invited',
          invite,
          messageId,
        });
      } catch (e: any) {
        this.logger.warn(`Invite to ${raw} for ${chatJid} failed: ${e?.message || e}`);
        results.push({
          ...base,
          jid: participantApiJid(chatJid),
          ok: false,
          reason: 'send_failed',
          invite,
          messageId: null,
        });
      }
    }
    const succeeded = results.filter(r => r.ok).length;
    const failed = results.length - succeeded;
    this.logger.info(
      `Group ${raw} invites=${results.length} sent=${succeeded}${request.actor ? ` by ${request.actor}` : ''}`
    );
    if (!succeeded) {
      throw new GroupActionError(
        `No invite to ${raw} was sent (${results.length} requested)`,
        422,
        'invite_not_sent',
        { details: { results, succeeded, failed } }
      );
    }
    return {
      groupId: this.normalizeJid(raw),
      results,
      succeeded,
      failed,
      partial: failed > 0,
    };
  }

  /** Member of a non-community group, or 403 / 422; the capabilities otherwise. */
  private checkGroupAccess(meta: GroupMetadata, own: string[], raw: string) {
    if (isCommunityGroup(meta)) {
      throw new GroupActionError(
        `${raw} is a community (or its announcement group): its groups are linked, unlinked ` +
          'and left with /communities/groups and /communities/leave; the rest from WhatsApp',
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

  // ---------------------------------------------------------------------------
  // Communities (the helpers live in communities.ts)
  // ---------------------------------------------------------------------------

  private static readonly COMMUNITY_CLASSES = {
    forbidden: 'not_community_admin',
    unavailable: 'community_unavailable',
  };

  /**
   * A write whose answer proves nothing (community link / unlink / leave,
   * channel follow / mute…). A refusal WhatsApp spells out (already a
   * MessageMutationError) is thrown as it is; the success and any other
   * failure (a timeout, a lost answer — the write may have landed) go to
   * `confirm`, a fresh read. Not shown there → 409 change_not_confirmed:
   * never retried here, the caller reads before trying again.
   */
  private async confirmedWrite(
    what: string,
    write: () => Promise<unknown>,
    confirm: () => Promise<boolean>
  ): Promise<void> {
    let failure: unknown;
    try {
      await write();
    } catch (e) {
      if (e instanceof MessageMutationError) throw e;
      failure = e;
    }
    const confirmed = await confirm().catch((e: any) => {
      this.logger.warn(`read-back of ${what} failed: ${e?.message || e}`);
      return false;
    });
    if (confirmed) return;
    throw new MessageMutationError(
      failure
        ? `${what} failed (${errorMessage(failure)}) and a fresh read does not show it done; it may still have reached WhatsApp — read it again before retrying`
        : `WhatsApp accepted ${what} but a fresh read does not show it; read it again before retrying`,
      409,
      'change_not_confirmed'
    );
  }

  /** Every group this account is in — communities, their announcement and linked groups too. */
  private async participatingGroups(): Promise<GroupMetadata[]> {
    const sock = this.connectedSocket();
    // rc13's communityFetchAllParticipating parses <communities>, which
    // WhatsApp never sends: the same IQ read through the group parser.
    const all = await this.groupCall('reading the groups', '@g.us', () =>
      sock.groupFetchAllParticipating()
    );
    if (!all || typeof all !== 'object' || Array.isArray(all)) {
      throw new CommunityActionError(
        'WhatsApp returned an unusable group list',
        502,
        'provider_invalid_response'
      );
    }
    return Object.values(all).filter(
      (meta): meta is GroupMetadata => !!meta && typeof meta.id === 'string'
    );
  }

  /**
   * Fresh metadata of a community (its parent group), read through the group
   * parser (rc13's communityMetadata expects a <community> node WhatsApp does
   * not send). Not cached: the parent has no chat. 403 = not a member; a
   * linked or ordinary group → 422 not_a_community.
   */
  private async communityMetadataForAction(raw: string): Promise<GroupMetadata> {
    const sock = this.connectedSocket();
    let meta: GroupMetadata;
    try {
      meta = await this.groupCall(
        'reading the community',
        raw,
        () => sock.groupMetadata(raw),
        BaileysClient.COMMUNITY_CLASSES
      );
    } catch (e) {
      if (e instanceof GroupActionError && e.failureClass === 'not_community_admin') {
        throw new CommunityActionError(
          `This account is not a member of ${raw}`,
          403,
          'not_community_member',
          { code: e.code }
        );
      }
      throw e;
    }
    if (!isCommunityParent(meta)) {
      throw new CommunityActionError(
        meta?.linkedParent
          ? `${raw} is a group of the community ${meta.linkedParent}, not a community`
          : `${raw} is not a community`,
        422,
        'not_a_community',
        meta?.linkedParent ? { details: { communityId: meta.linkedParent } } : {}
      );
    }
    return meta;
  }

  /** Every group of a community (`<sub_groups>`); null when WhatsApp did not answer it. */
  private async linkedGroupsOf(raw: string): Promise<LinkedGroupEntry[] | null> {
    try {
      const answer = await this.connectedSocket().communityFetchLinkedGroups(raw);
      if (!answer || answer.communityJid !== raw || !Array.isArray(answer.linkedGroups)) {
        return null;
      }
      return answer.linkedGroups;
    } catch (e: any) {
      this.logger.warn(`linked groups of ${raw} unavailable: ${e?.message || e}`);
      return null;
    }
  }

  private async describeCommunity(
    meta: GroupMetadata,
    participating: GroupMetadata[],
    own: string[]
  ): Promise<CommunityView> {
    const linked = await this.linkedGroupsOf(meta.id);
    return communityView(meta, participating, linked, group => ownParticipant(group, own));
  }

  /**
   * GET /communities: every community this account is in, with its
   * announcement group and its groups (WhatsApp's full list, also those this
   * account is not in; `joined` says which). A community only reached
   * through one of its groups (its parent not among the participating
   * groups) is read on its own.
   */
  async listCommunities(): Promise<{ communities: CommunityView[] }> {
    const sock = this.connectedSocket();
    const participating = await this.participatingGroups();
    const own = await this.ownIds();
    const parents = new Map<string, GroupMetadata>();
    for (const meta of participating) {
      if (isCommunityParent(meta)) parents.set(meta.id, meta);
    }
    for (const meta of participating) {
      const parent = normalizeGroupJid(meta.linkedParent);
      if (!parent || parents.has(parent)) continue;
      const read = await sock.groupMetadata(parent).catch((e: any) => {
        this.logger.warn(`community ${parent} of ${meta.id} unreadable: ${e?.message || e}`);
        return null;
      });
      if (isCommunityParent(read)) parents.set(parent, read as GroupMetadata);
    }
    const communities: CommunityView[] = [];
    for (const meta of parents.values()) {
      communities.push(await this.describeCommunity(meta, participating, own));
    }
    communities.sort((a, b) => a.subject.localeCompare(b.subject));
    return { communities };
  }

  /** POST /communities/state: one community, its groups and what this account may do there. */
  async getCommunityState(communityId: unknown): Promise<CommunityView> {
    const raw = parseCommunityJid(communityId);
    const meta = await this.communityMetadataForAction(raw);
    const participating = await this.participatingGroups().catch((e: any) => {
      this.logger.warn(`participating groups unavailable: ${e?.message || e}`);
      return [] as GroupMetadata[];
    });
    return this.describeCommunity(meta, participating, await this.ownIds());
  }

  /**
   * POST /communities/create: a new community with this account as its owner
   * (WhatsApp creates its announcement group with it; members ask to join).
   * rc13 answers null when its own re-read failed: then the community is
   * looked for among the participating groups (ours, same subject, created
   * just now) before saying it is unconfirmed — never created twice here.
   */
  async createCommunity(
    subject: unknown,
    description: unknown,
    request: MessageMutationRequest = {}
  ): Promise<{ communityId: string; community: CommunityView }> {
    const cleanSubject = parseCommunitySubject(subject);
    const cleanDescription = parseCommunityDescription(description);
    const sock = this.connectedSocket();
    const own = await this.ownIds();
    const startedAt = Math.floor(Date.now() / 1000) - 120;
    let meta: GroupMetadata | null = null;
    let failure: unknown;
    try {
      meta = await this.groupCall(
        'the community creation',
        '@g.us',
        () => sock.communityCreate(cleanSubject, cleanDescription),
        BaileysClient.COMMUNITY_CLASSES
      );
    } catch (e) {
      if (e instanceof MessageMutationError) throw e;
      failure = e;
    }
    let participating: GroupMetadata[] | null = null;
    if (!isCommunityParent(meta)) {
      participating = await this.participatingGroups().catch(() => [] as GroupMetadata[]);
      meta =
        participating
          .filter(
            group =>
              isCommunityParent(group) &&
              group.subject === cleanSubject &&
              Number(group.creation) >= startedAt &&
              (!group.owner || own.includes(jidNormalizedUser(group.owner)))
          )
          .sort((a, b) => Number(b.creation) - Number(a.creation))[0] || null;
    }
    if (!meta) {
      throw new CommunityActionError(
        `The creation of the community ${cleanSubject} was not confirmed${failure ? ` (${errorMessage(failure)})` : ''}; list the communities before retrying`,
        409,
        'change_not_confirmed'
      );
    }
    participating ??= await this.participatingGroups().catch(() => [] as GroupMetadata[]);
    const community = await this.describeCommunity(meta, participating, own);
    this.logger.info(`Community created ${meta.id}${request.actor ? ` by ${request.actor}` : ''}`);
    return { communityId: meta.id, community };
  }

  /**
   * POST /communities/groups: link a group to a community or unlink it.
   * Fresh metadata first: community admins only; linking also needs admin of
   * the group, which must be an ordinary group not linked elsewhere; the
   * announcement group is never unlinked. Already so → changed: false,
   * nothing sent. The result is read back (the group's linkedParent, or the
   * community's list when we are not in the group).
   */
  async updateCommunityGroup(
    communityId: unknown,
    groupId: unknown,
    action: unknown,
    request: MessageMutationRequest = {}
  ): Promise<CommunityGroupResult> {
    const wanted = parseCommunityGroupRequest({ communityId, groupId, action });
    const sock = this.connectedSocket();
    return this.communityWrites.run(wanted.communityId, async () => {
      const raw = wanted.communityId;
      const target = wanted.groupId;
      const meta = await this.communityMetadataForAction(raw);
      const own = await this.ownIds();
      const capabilities = communityCapabilities(ownParticipant(meta, own));
      if (!capabilities.isMember) {
        throw new CommunityActionError(
          `This account is not a member of ${raw}`,
          403,
          'not_community_member'
        );
      }
      if (!capabilities.isAdmin) {
        throw new CommunityActionError(
          `Only community admins can ${wanted.action} groups of ${raw}`,
          403,
          'not_community_admin'
        );
      }
      const done = async (changed: boolean): Promise<CommunityGroupResult> => {
        this.groupMetaCache.delete(target);
        const participating = await this.participatingGroups().catch(() => [] as GroupMetadata[]);
        const community = await this.describeCommunity(meta, participating, own).catch(() => null);
        this.logger.info(
          `Community ${raw} ${wanted.action} ${target}${changed ? '' : ' (already)'}${request.actor ? ` by ${request.actor}` : ''}`
        );
        return {
          action: wanted.action,
          communityId: raw,
          groupId: target,
          changed,
          confirmed: true,
          community,
        };
      };

      if (wanted.action === 'link') {
        const group = await this.groupMetadataForAction(target);
        if (isCommunityGroup(group)) {
          throw new CommunityActionError(
            `${target} is a community or an announcement group: only ordinary groups are linked`,
            422,
            'not_linkable_group'
          );
        }
        if (group.linkedParent === raw) return done(false);
        if (group.linkedParent) {
          throw new CommunityActionError(
            `${target} already belongs to the community ${group.linkedParent}: unlink it there first`,
            409,
            'linked_elsewhere',
            { details: { linkedTo: group.linkedParent } }
          );
        }
        if (!isAdminRole(ownParticipant(group, own)?.admin)) {
          throw new CommunityActionError(
            `Only admins of ${target} can link it to a community`,
            403,
            'not_group_admin'
          );
        }
        await this.confirmedWrite(
          `the link of ${target} to ${raw}`,
          () =>
            this.groupCall(
              'the group link',
              raw,
              () => sock.communityLinkGroup(target, raw),
              BaileysClient.COMMUNITY_CLASSES
            ),
          async () => (await this.fetchGroupMetadata(target, true)).linkedParent === raw
        );
        return done(true);
      }

      // Unlink: we need not be in the group; its metadata when we are, else
      // the community's own list of groups.
      const group = await this.fetchGroupMetadata(target, true).catch(() => null);
      if (group?.isCommunityAnnounce && group.linkedParent === raw) {
        throw new CommunityActionError(
          `${target} is the announcement group of ${raw}: it cannot be unlinked`,
          422,
          'announcement_group'
        );
      }
      const linked = group ? null : await this.linkedGroupsOf(raw);
      const before = isLinkedTo(raw, target, { group, linked });
      if (before === false) return done(false);
      if (before === null) {
        throw new CommunityActionError(
          `Could not read whether ${target} belongs to ${raw}; nothing was sent`,
          502,
          'provider_invalid_response'
        );
      }
      await this.confirmedWrite(
        `the unlink of ${target} from ${raw}`,
        () =>
          this.groupCall(
            'the group unlink',
            raw,
            () => sock.communityUnlinkGroup(target, raw),
            BaileysClient.COMMUNITY_CLASSES
          ),
        async () => {
          const after = group ? await this.fetchGroupMetadata(target, true) : null;
          const list = group ? null : await this.linkedGroupsOf(raw);
          return isLinkedTo(raw, target, { group: after, linked: list }) === false;
        }
      );
      return done(true);
    });
  }

  /**
   * POST /communities/leave: this account leaves a community (and, as
   * WhatsApp does, its announcement group). Members only; proven by the
   * participating groups no longer listing us in it.
   */
  async leaveCommunity(
    communityId: unknown,
    request: MessageMutationRequest = {}
  ): Promise<CommunityLeaveResult> {
    const raw = parseCommunityJid(communityId);
    const sock = this.connectedSocket();
    return this.communityWrites.run(raw, async () => {
      const meta = await this.communityMetadataForAction(raw);
      const own = await this.ownIds();
      if (!communityCapabilities(ownParticipant(meta, own)).isMember) {
        throw new CommunityActionError(
          `This account is not a member of ${raw}`,
          403,
          'not_community_member'
        );
      }
      await this.confirmedWrite(
        `leaving ${raw}`,
        () =>
          this.groupCall(
            'leaving the community',
            raw,
            () => sock.communityLeave(raw),
            BaileysClient.COMMUNITY_CLASSES
          ),
        async () => {
          const participating = await this.participatingGroups();
          const still = participating.find(group => group.id === raw);
          return !still || !ownParticipant(still, own);
        }
      );
      this.groupMetaCache.delete(raw);
      this.logger.info(`Left community ${raw}${request.actor ? ` by ${request.actor}` : ''}`);
      return { communityId: raw, changed: true, confirmed: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Channels / newsletters (the helpers live in channels.ts)
  // ---------------------------------------------------------------------------

  /**
   * A newsletter WMex call. A GraphQL refusal (Boom "GraphQL server error",
   * with the error's code): 404 → 404 channel_unavailable, 401 / 403 → 403
   * not_allowed, any other → 422 rejected_by_whatsapp. Anything else (no
   * answer, a connection status) goes on as it is.
   */
  private async channelCall<T>(what: string, key: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (e: any) {
      const message = String(e?.message || e);
      if (!e?.isBoom || !message.startsWith('GraphQL server error')) throw e;
      const status = Number(e?.output?.statusCode ?? e?.data?.extensions?.error_code);
      const code = Number.isFinite(status) ? String(status) : undefined;
      const reason = `WhatsApp rejected ${what} of ${key}: ${message}`;
      if (status === 404) throw new ChannelActionError(reason, 404, 'channel_unavailable', code);
      if (status === 401 || status === 403) {
        throw new ChannelActionError(reason, 403, 'not_allowed', code);
      }
      throw new ChannelActionError(reason, 422, 'rejected_by_whatsapp', code);
    }
  }

  /** One channel's metadata by jid, proven to be about that channel (404 when there is none). */
  private async readChannel(jid: string): Promise<ChannelView> {
    const sock = this.connectedSocket();
    const answer = await this.channelCall('reading the channel', jid, () =>
      sock.newsletterMetadata('jid', jid)
    );
    if (!answer) {
      throw new ChannelActionError(`WhatsApp has no channel ${jid}`, 404, 'channel_unavailable');
    }
    const view = channelView(answer);
    if (view.channelId !== jid) {
      throw new ChannelActionError(
        `WhatsApp answered ${view.channelId} for ${jid}`,
        502,
        'provider_invalid_response'
      );
    }
    return view;
  }

  /**
   * POST /channels/lookup: one channel by its jid, share link or invite code
   * (rc13 has no channel search or directory). Its public metadata and this
   * account's relation to it (role, following, muted).
   */
  async lookupChannel(channel: unknown): Promise<ChannelView> {
    const query = parseChannelQuery(channel);
    if (query.type === 'jid') {
      const view = await this.readChannel(query.key);
      if (view.following) await this.noteFollowed(view.channelId);
      return view;
    }
    const sock = this.connectedSocket();
    const answer = await this.channelCall('the channel lookup', 'an invite', () =>
      sock.newsletterMetadata('invite', query.key)
    );
    if (!answer) {
      throw new ChannelActionError(
        'WhatsApp has no channel for that link or invite code',
        404,
        'channel_unavailable'
      );
    }
    const view = channelView(answer);
    if (view.following) await this.noteFollowed(view.channelId);
    return view;
  }

  /** A channel confirmed as followed: this process remembers it and, with ingest, so does the directory. */
  private async noteFollowed(jid: string): Promise<void> {
    this.seenChannels.add(jid);
    if (this.ingest) await rememberChannel(jid);
  }

  /**
   * GET /channels: the channels this account follows among those this
   * connector has seen — chats of the history sync, conversations with
   * ingested posts (ingest only), lookups and follows of this process and the
   * followed channels it remembered (ingest only) — each confirmed by its own
   * metadata. rc13 cannot ask WhatsApp for the followed list, so
   * coverage.complete is always false.
   */
  async listChannels(): Promise<ChannelListResult> {
    this.connectedSocket();
    const candidates = new Set<string>();
    for (const chat of this.chatStore.values()) {
      const jid = normalizeChannelJid(chat.rawJid || chat.id);
      if (jid) candidates.add(jid);
    }
    for (const jid of this.seenChannels) candidates.add(jid);
    const remembered = new Set<string>();
    if (this.ingest) {
      for (const jid of await knownChannelConversations().catch((e: any) => {
        this.logger.warn(`known channel conversations unavailable: ${e?.message || e}`);
        return [] as string[];
      })) {
        candidates.add(jid);
      }
      for (const jid of await rememberedChannels()) {
        remembered.add(jid);
        candidates.add(jid);
      }
    }
    const checked = Array.from(candidates).slice(0, CHANNELS_LIST_MAX);
    const channels: ChannelView[] = [];
    let unreadable = 0;
    for (let index = 0; index < checked.length; index += 4) {
      const batch = await Promise.all(
        checked.slice(index, index + 4).map(jid =>
          this.readChannel(jid).catch((e: any) => {
            this.logger.warn(`channel ${jid} unreadable: ${e?.message || e}`);
            return null;
          })
        )
      );
      for (const view of batch) {
        if (!view) {
          unreadable += 1;
        } else if (view.following) {
          channels.push(view);
        } else {
          this.seenChannels.delete(view.channelId);
          // Only a row that exists is deleted: a channel seen but never followed has none.
          if (view.following === false && remembered.has(view.channelId)) {
            await forgetChannel(view.channelId);
          }
        }
      }
    }
    channels.sort((a, b) => a.name.localeCompare(b.name));
    return {
      channels,
      coverage: {
        complete: false,
        source: 'known-channels',
        candidates: candidates.size,
        checked: checked.length,
        unreadable,
      },
    };
  }

  /**
   * POST /channels/subscription: follow / unfollow, mute / unmute a channel.
   * Read first (already so → changed: false, nothing sent; mute needs a
   * followed channel), then the mutation, then the channel's own viewer
   * metadata must show it. One write per channel at a time.
   */
  async setChannelSubscription(
    channelId: unknown,
    action: unknown,
    request: MessageMutationRequest = {}
  ): Promise<ChannelSubscriptionResult> {
    const jid = parseChannelJid(channelId);
    const verb = parseChannelSubscriptionAction(action);
    const sock = this.connectedSocket();
    return this.channelWrites.run(jid, async () => {
      const before = await this.readChannel(jid);
      if ((verb === 'mute' || verb === 'unmute') && before.following === false) {
        throw new ChannelActionError(
          `This account does not follow ${jid}: follow it before muting or unmuting it`,
          422,
          'not_following'
        );
      }
      const result = async (
        changed: boolean,
        channel: ChannelView
      ): Promise<ChannelSubscriptionResult> => {
        if (channel.following) await this.noteFollowed(jid);
        else if (channel.following === false) {
          this.seenChannels.delete(jid);
          if (this.ingest) await forgetChannel(jid);
        }
        this.logger.info(
          `Channel ${jid} ${verb}${changed ? '' : ' (already)'}${request.actor ? ` by ${request.actor}` : ''}`
        );
        return { action: verb, channelId: jid, changed, confirmed: true, channel };
      };
      if (channelStateMatches(before, verb) === true) return result(false, before);
      const mutate: Record<ChannelSubscriptionAction, () => Promise<unknown>> = {
        follow: () => sock.newsletterFollow(jid),
        unfollow: () => sock.newsletterUnfollow(jid),
        mute: () => sock.newsletterMute(jid),
        unmute: () => sock.newsletterUnmute(jid),
      };
      let after: ChannelView = before;
      await this.confirmedWrite(
        `the ${verb} of ${jid}`,
        () => this.channelCall(`the ${verb}`, jid, mutate[verb]),
        async () => {
          after = await this.readChannel(jid);
          return channelStateMatches(after, verb) === true;
        }
      );
      return result(true, after);
    });
  }

  // ---------------------------------------------------------------------------
  // Presence, privacy and disappearing messages (fase 3 / PR-8)
  // ---------------------------------------------------------------------------

  /** Forget everything presence of the current socket (on open / close). */
  private resetPresence(): void {
    this.presenceSubscribed.clear();
    this.presenceCache.clear();
    this.presenceThrottle.clear();
    this.presenceRefreshedAt.clear();
  }

  /**
   * The chat a presence / timer request is about: a group, phone or LID chat
   * (400 otherwise). With ingest it is resolved to its canonical conversation
   * (a merged alias acts on the canonical's jid); `requireKnown` → a chat this
   * account has no conversation for is 404 conversation_unavailable.
   */
  private async chatTarget(
    chatId: unknown,
    what: string,
    requireKnown: boolean
  ): Promise<ChatTarget> {
    const requested = stripAccountKey(String(chatId ?? '').trim());
    if (!STRUCTURED_CHAT_JID.test(requested)) {
      throw new MessageMutationError(
        `${what}: ${requested.slice(0, 80) || 'conversationId'} is not a WhatsApp group, phone or LID chat`,
        400,
        'invalid_request'
      );
    }
    const conversation = this.ingest ? await resolveCanonicalConversation(requested) : undefined;
    if (this.ingest && requireKnown && !conversation) {
      throw new MessageMutationError(
        `${what}: conversation ${requested} is unavailable (unknown to this account)`,
        404,
        'conversation_unavailable'
      );
    }
    const raw = this.toRawJid(conversation?.externalId || requested);
    return {
      raw,
      chatId: this.normalizeJid(raw),
      conversationId: conversation?.id ?? null,
      isGroup: this.isGroupJid(raw),
    };
  }

  /** WhatsApp's own refusals (Boom 4xx, not a connection status) as 422 rejected_by_whatsapp. */
  private async whatsappCall<T>(what: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (e: any) {
      const status = Number(e?.output?.statusCode ?? e?.data?.statusCode);
      const connectionStatus = [401, 408, 428, 440].includes(status);
      if (e?.isBoom && status >= 400 && status < 500 && !connectionStatus) {
        throw new MessageMutationError(
          `WhatsApp rejected ${what}: ${e?.message || e}`,
          422,
          'rejected_by_whatsapp',
          String(status)
        );
      }
      throw e;
    }
  }

  /** The ids presence of a chat may arrive under: its jid, and PN <-> LID for a person. */
  private async presenceKeys(raw: string): Promise<string[]> {
    if (this.isGroupJid(raw)) return [this.normalizeJid(raw)];
    const user = jidNormalizedUser(raw) || raw;
    return (await this.jidAliases(user)).map(jid => this.normalizeJid(jid));
  }

  /**
   * Send our presence. composing / recording / paused go to ONE chat as a
   * chat-state (the typing indicator; the account's availability does not
   * change). unavailable / available are account-wide; `available` only with
   * WA_PRESENCE_ALLOW_AVAILABLE=true (it silences the phone's notifications)
   * — nothing in the connector ever sends it on its own. The same chat-state
   * to the same chat within a few seconds is not re-sent.
   */
  async sendPresence(
    state: OutgoingPresenceState,
    chatId?: string,
    request: MessageMutationRequest = {}
  ): Promise<PresenceSendResult> {
    if (state === 'available' && !availablePresenceAllowed()) {
      throw new MessageMutationError(
        'Presence available is disabled on this connector (WA_PRESENCE_ALLOW_AVAILABLE): being online on a linked device silences the phone',
        403,
        'presence_available_disabled'
      );
    }
    const sock = this.connectedSocket();
    if (isChatPresenceState(state)) {
      const target = await this.chatTarget(chatId, 'presence', true);
      const base = {
        state,
        scope: 'chat' as const,
        chatId: target.chatId,
        conversationId: target.conversationId,
      };
      if (!this.presenceThrottle.shouldSend(target.raw, state)) {
        return { ...base, sent: false, throttled: true };
      }
      await this.whatsappCall(`presence ${state} in ${target.raw}`, () =>
        sock.sendPresenceUpdate(state as ChatPresenceState, target.raw)
      );
      this.presenceThrottle.sent(target.raw, state);
      this.logger.debug(
        `Presence ${state} in ${target.raw}${request.actor ? ` by ${request.actor}` : ''}`
      );
      return { ...base, sent: true, throttled: false };
    }
    // Baileys drops available / unavailable silently when the account has no
    // push name: say so instead of answering a success that did not happen.
    const me = (sock as { authState?: { creds?: { me?: { name?: string } } } }).authState?.creds
      ?.me;
    if (me && !me.name) {
      throw new MessageMutationError(
        `Presence ${state} cannot be sent: the account has no push name`,
        422,
        'presence_unsupported'
      );
    }
    await this.whatsappCall(`presence ${state}`, () => sock.sendPresenceUpdate(state));
    this.logger.info(
      `Presence ${state} (account-wide)${request.actor ? ` by ${request.actor}` : ''}`
    );
    return {
      state,
      scope: 'account',
      chatId: null,
      conversationId: null,
      sent: true,
      throttled: false,
    };
  }

  /**
   * What WhatsApp last told us about a chat's presence, if still fresh (60 s,
   * typing 8 s): otherwise `unknown`, never an old "online". A read that
   * finds nothing re-subscribes the chat (at most every 30 s) so WhatsApp
   * sends its current presence — `refreshing: true`, ask again shortly.
   * Subscribing reveals nothing about us.
   */
  async getPresence(chatId: unknown, participant?: unknown): Promise<PresenceReadResult> {
    const sock = this.connectedSocket();
    const target = await this.chatTarget(chatId, 'presence', false);
    const chatKeys = await this.presenceKeys(target.raw);
    let participantKeys: string[] = [];
    if (participant !== undefined && participant !== null && participant !== '') {
      const who = toParticipantJid(participant);
      if (!who) {
        throw new MessageMutationError(
          'participant must be a phone number or a user jid (…@c.us, …@s.whatsapp.net, …@lid)',
          400,
          'invalid_request'
        );
      }
      participantKeys = (await this.jidAliases(who)).map(jid => this.normalizeJid(jid));
    }
    const { presence, participants } = this.presenceCache.read(chatKeys, participantKeys);
    let refreshing = false;
    if (presence.status === 'unknown') {
      const now = Date.now();
      const last = this.presenceRefreshedAt.get(target.raw) || 0;
      if (now - last >= PRESENCE_REFRESH_MS) {
        this.presenceRefreshedAt.set(target.raw, now);
        refreshing = true;
        void Promise.resolve(sock.presenceSubscribe(target.raw))
          .then(() => this.presenceSubscribed.add(target.raw))
          .catch(() => {});
      }
    }
    return {
      chatId: target.chatId,
      conversationId: target.conversationId,
      isGroup: target.isGroup,
      presence: {
        ...presence,
        participantId:
          presence.status === 'unknown' && !target.isGroup ? target.chatId : presence.participantId,
      },
      participants: target.isGroup ? participants : [],
      refreshing,
    };
  }

  /** Default timer of new chats as the account last told us (account_sync), null if unknown. */
  private defaultDisappearingSeconds(sock: WASocket): number | null {
    const mode = (
      sock as {
        authState?: {
          creds?: {
            accountSettings?: { defaultDisappearingMode?: { ephemeralExpiration?: unknown } };
          };
        };
      }
    ).authState?.creds?.accountSettings?.defaultDisappearingMode;
    const seconds = Number(mode?.ephemeralExpiration);
    return mode && Number.isFinite(seconds) ? seconds : null;
  }

  /** The account's privacy settings, fresh from WhatsApp (never Baileys' cache). */
  async getPrivacySettings(): Promise<PrivacyView> {
    const sock = this.connectedSocket();
    const raw = await this.whatsappCall('the privacy settings read', () =>
      sock.fetchPrivacySettings(true)
    );
    return privacyView(raw, this.defaultDisappearingSeconds(sock));
  }

  /**
   * Change ONE privacy setting of the account (every contact sees it). Values
   * are re-validated here; the current value is read first and an equal one
   * is not sent. The caller (POST /privacy) already required confirm: true
   * and the sending gate.
   */
  async updatePrivacySetting(
    setting: unknown,
    value: unknown,
    request: MessageMutationRequest = {}
  ): Promise<PrivacyUpdateResult> {
    const update = buildPrivacyUpdate(setting, value);
    const sock = this.connectedSocket();
    const before = await this.getPrivacySettings();
    const previous = currentPrivacyValue(before, update.setting);
    if (previous === update.value) {
      return {
        setting: update.setting,
        value: update.value,
        previous,
        changed: false,
        privacy: before,
      };
    }
    await this.whatsappCall(`the ${update.setting} privacy change`, () =>
      update.method === 'updateDefaultDisappearingMode'
        ? sock.updateDefaultDisappearingMode(update.value)
        : (sock[update.method] as (v: string) => Promise<void>)(update.value)
    );
    this.logger.info(
      `Privacy ${update.setting} ${String(previous)} -> ${String(update.value)}${request.actor ? ` by ${request.actor}` : ''}`
    );
    const privacy = await this.getPrivacySettings().catch(() => null);
    return { setting: update.setting, value: update.value, previous, changed: true, privacy };
  }

  /** A contact's default timer for new chats (USync disappearing_mode), best effort. */
  private async contactDefaultDisappearing(
    raw: string
  ): Promise<DisappearingView['contactDefault']> {
    const sock = this.sock;
    if (!sock || !this.isConnected() || typeof sock.fetchDisappearingDuration !== 'function') {
      return null;
    }
    const timeout = new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 3000));
    const list = await Promise.race([
      sock.fetchDisappearingDuration(jidNormalizedUser(raw) || raw).catch(() => undefined),
      timeout,
    ]);
    const first = (Array.isArray(list) ? list[0] : undefined) as Record<string, any> | undefined;
    // Baileys' USync protocol answers `disappearing_mode: {duration, setAt}`.
    const mode = first?.disappearing_mode || first?.disappearingMode;
    const seconds = Number(mode?.duration ?? mode?.ephemeralExpiration);
    if (!mode || !Number.isFinite(seconds) || seconds < 0) return null;
    const setAt =
      mode.setAt instanceof Date && mode.setAt.getTime() > 0 ? mode.setAt.toISOString() : null;
    return { expiration: seconds, label: disappearingLabel(seconds), setAt };
  }

  /**
   * The disappearing timer of a chat. A group: its fresh metadata (and
   * whether we may change it). A direct chat: what the connector learnt and
   * stored (014) — unknown until a change or a snapshot went through the
   * socket — plus the contact's default for new chats, apart.
   */
  async getDisappearing(chatId: unknown): Promise<DisappearingView> {
    const target = await this.chatTarget(chatId, 'disappearing', false);
    const base = {
      chatId: target.chatId,
      conversationId: target.conversationId,
      isGroup: target.isGroup,
    };
    if (target.isGroup) {
      this.connectedSocket();
      const meta = await this.groupMetadataForAction(target.raw);
      const capabilities = groupCapabilities(meta, ownParticipant(meta, await this.ownIds()));
      const expiration = groupEphemeral(meta);
      return {
        ...base,
        expiration,
        label: disappearingLabel(expiration),
        known: true,
        setAt: null,
        source: 'group_metadata',
        canChange: capabilities.editInfo,
        contactDefault: null,
      };
    }
    const stored =
      this.ingest && target.conversationId
        ? await readConversationEphemeral(target.conversationId)
        : undefined;
    const expiration = stored ? stored.expiration : null;
    return {
      ...base,
      expiration,
      label: disappearingLabel(expiration),
      known: !!stored,
      setAt: stored?.setAt ? stored.setAt.toISOString() : null,
      source: stored ? 'conversation' : 'unknown',
      canChange: true,
      contactDefault: await this.contactDefaultDisappearing(target.raw),
    };
  }

  /**
   * Set the disappearing timer of a chat (0 / 24 h / 7 d / 90 d). A group:
   * checked against fresh metadata — a member, and admin when the group
   * restricts its settings (the "edit group info" rule of PR-6) — then
   * groupToggleEphemeral. A direct chat: the timer message WhatsApp's own
   * clients send (the contact sees "X turned on disappearing messages"). A
   * known equal timer is not re-sent. Recorded on the canonical conversation.
   */
  async setDisappearing(
    chatId: unknown,
    expiration: unknown,
    request: MessageMutationRequest = {}
  ): Promise<DisappearingUpdateResult> {
    const seconds = parseDisappearingExpiration(expiration);
    const sock = this.connectedSocket();
    const target = await this.chatTarget(chatId, 'disappearing', true);
    let previous: number | null = null;
    if (target.isGroup) {
      const meta = await this.groupMetadataForAction(target.raw);
      const capabilities = this.checkGroupAccess(meta, await this.ownIds(), target.raw);
      if (!capabilities.editInfo) {
        throw new GroupActionError(
          `Only admins can change the disappearing timer of ${target.raw}: its settings are restricted to admins`,
          403,
          'not_group_admin'
        );
      }
      previous = groupEphemeral(meta);
    } else if (this.ingest && target.conversationId) {
      previous = (await readConversationEphemeral(target.conversationId))?.expiration ?? null;
    }
    const base = {
      chatId: target.chatId,
      conversationId: target.conversationId,
      isGroup: target.isGroup,
      expiration: seconds,
      label: disappearingLabel(seconds),
      previous,
    };
    if (previous === seconds) return { ...base, changed: false, persisted: false };

    if (target.isGroup) {
      await this.groupCall('the disappearing timer change', target.raw, () =>
        sock.groupToggleEphemeral(target.raw, seconds)
      );
      this.groupMetaCache.delete(target.raw);
    } else {
      await this.whatsappCall(`the disappearing timer of ${target.raw}`, () =>
        sock.sendMessage(target.raw, { disappearingMessagesInChat: seconds })
      );
    }
    let persisted = false;
    if (this.ingest && target.conversationId) {
      persisted = await writeConversationEphemeral(target.conversationId, {
        expiration: seconds,
        setAt: new Date(),
      }).catch((e: any) => {
        this.logger.warn(`timer of ${target.raw} changed but not recorded: ${e?.message || e}`);
        return false;
      });
    }
    this.logger.info(
      `Disappearing ${target.raw} ${String(previous)} -> ${seconds}${request.actor ? ` by ${request.actor}` : ''}`
    );
    return { ...base, changed: true, persisted };
  }

  /**
   * A chat as WhatsApp reports it whole (history snapshot, chats.upsert): the in-memory store, and
   * the real unread badge, archive flag, pin / mute (fase 3 / PR-5: only what the snapshot says) and
   * disappearing timer (PR-8: never over a newer one) on its canonical conversation. Fire-and-forget.
   */
  private rememberChatSnapshot(c: Chat): void {
    const norm = this.normalizeJid(c.id as string);
    this.chatStore.set(norm, {
      id: norm,
      rawJid: c.id as string,
      name: c.name || (c.id as string),
      isGroup: !!isJidGroup(c.id as string),
      unreadCount: c.unreadCount || 0,
      timestamp: Number(c.conversationTimestamp || 0),
    });
    void setCanonicalChatState(norm, {
      unreadCount: c.unreadCount || 0,
      archived: !!(c as any).archived,
      pinnedAt: pinFromBaileys(c),
      mute: muteFromBaileys(c, 'snapshot'),
    });
    void recordInboundEphemeral(norm, ephemeralFromBaileys(c, 'snapshot'));
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
   * Returns null only when WhatsApp reports no visible picture (403/404);
   * a timeout or a failed CDN download throws instead of passing for "no photo".
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

  // ---------------------------------------------------------------------------
  // Own profile: name, about, photo (ported from the NAS fork; the rules live
  // in profile-service.ts, provider-agnostic)
  // ---------------------------------------------------------------------------

  /**
   * Provider surface for `profile-service`, rebuilt from the live socket on
   * every call. A writer is advertised only when the installed Baileys really
   * exposes it, so a provider upgrade degrades to `capability: false` and a
   * 501 instead of a TypeError on a signature assumed from the `.d.ts` files.
   */
  ownProfileProvider(): OwnProfilePhotoProvider {
    const socket = this.sock as unknown as
      | (Record<string, unknown> & {
          user?: { id?: string; name?: string; lid?: string };
          authState?: { creds?: { me?: { id?: string; name?: string } } };
        })
      | null;
    const method = <A extends unknown[], R>(name: string) => {
      const candidate = socket?.[name];
      if (typeof candidate !== 'function') return undefined;
      return (...args: A): Promise<R> => (candidate as (...a: A) => Promise<R>).apply(socket, args);
    };
    const ownRawJid = (): string | null => {
      // `creds.me.id` carries the paired device suffix; the profile IQs and the
      // USync lookup both need the bare user JID.
      const candidate = socket?.user?.id || socket?.authState?.creds?.me?.id;
      if (!candidate) return null;
      try {
        return jidNormalizedUser(candidate);
      } catch {
        return null;
      }
    };
    return {
      isConnected: () => this.isConnected(),
      ownJid: ownRawJid,
      accountName: () => {
        const name = socket?.user?.name || socket?.authState?.creds?.me?.name;
        return typeof name === 'string' && name.trim() ? name.trim() : null;
      },
      updateProfileName: method<[string], unknown>('updateProfileName'),
      updateProfileStatus: method<[string], unknown>('updateProfileStatus'),
      updateProfilePicture: method<[string, Buffer], unknown>('updateProfilePicture'),
      removeProfilePicture: method<[string], unknown>('removeProfilePicture'),
      fetchStatus: method<[string], unknown>('fetchStatus'),
      // The CDN path identifies the stored picture; the query string is a
      // rotating access token, so it must not look like a new picture. Hashed
      // to keep the provider URL out of the API. Unlike contact avatars, a 403
      // for our own account is a refused lookup, not a proven absence: only a
      // 404 says "no picture", so a removal is never "confirmed" by an error.
      profilePictureIdentity: async (jid: string) => {
        const sock = this.sock;
        if (!sock) throw new Error('Client not connected');
        const raw = this.toRawJid(jid);
        let url: string | undefined;
        try {
          url = await boundedProfilePictureUrl(timeoutMs =>
            sock.profilePictureUrl(raw, 'preview', timeoutMs)
          );
        } catch (error) {
          if (error instanceof Boom && error.output.statusCode === 404) return null;
          throw error;
        }
        if (!url) throw new ProfilePictureDownloadError('WhatsApp returned no profile picture URL');
        return createHash('sha256').update(url.split('?')[0]).digest('hex');
      },
      downloadProfilePhoto: async (jid: string) => this.getProfilePictureBytes(this.toRawJid(jid)),
    };
  }

  /** Own profile with the `@c.us` JID shape the rest of this API returns. */
  async getOwnProfile(io: ProfileIo = {}) {
    const profile = await readOwnProfile(this.ownProfileProvider(), io);
    return { ...profile, jid: this.normalizeJid(profile.jid) };
  }

  async updateOwnProfile(
    input: ProfileUpdateInput,
    io: ProfileIo = {}
  ): Promise<ProfileUpdateResult> {
    return applyProfileUpdates(this.ownProfileProvider(), input, io);
  }

  async setOwnProfilePhoto(
    input: { imageBase64?: unknown; mimeType?: unknown },
    io: ProfileIo = {}
  ) {
    return setOwnProfilePhoto(this.ownProfileProvider(), input, io);
  }

  async removeOwnProfilePhoto(io: ProfileIo = {}) {
    return removeOwnProfilePhoto(this.ownProfileProvider(), io);
  }

  async getOwnProfilePhotoBytes(io: ProfileIo = {}): Promise<Buffer | null> {
    return readOwnProfilePhotoBytes(this.ownProfileProvider(), io);
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
  /**
   * The NCT salt behind cstoken arrives in the `regular_high` app-state
   * collection (index `nct_salt_sync`). Baileys rc13 could not decode it, so a
   * session paired before the patch has already applied that mutation and
   * dropped the salt. Once per session, forget the stored regular_high version
   * so the next resync asks for a full snapshot and the salt is read again.
   * The marker in creds keeps an account that has no salt from re-snapshotting
   * on every reconnect. WA_NCT_SALT_BOOTSTRAP=false turns it off.
   */
  private async prepareNctSaltBootstrap(): Promise<void> {
    if (process.env.WA_NCT_SALT_BOOTSTRAP === 'false') return;
    const sock = this.sock as any;
    const creds = sock?.authState?.creds;
    const keys = sock?.authState?.keys;
    if (!creds || !keys || creds.nctSalt?.length || creds.nctSaltBootstrapAt) return;
    // cstoken is only sent from a LID-addressed account: no LID, nothing to fetch.
    if (!creds.me?.lid) return;
    sock.ev.emit('creds.update', { nctSaltBootstrapAt: Date.now() });
    await keys.set({ 'app-state-sync-version': { regular_high: null } });
    this.logger.info('no NCT salt stored: re-snapshotting regular_high once to read it');
  }

  async resyncChatState(reason = 'manual'): Promise<{ ok: boolean; error?: string }> {
    if (!this.sock) return { ok: false, error: 'not connected' };
    try {
      if (reason === 'connection-open') await this.prepareNctSaltBootstrap();
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
      ephemeralExpiration?: number;
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
    if (options?.ephemeralExpiration) sendOpts.ephemeralExpiration = options.ephemeralExpiration;
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

  /**
   * The one policy for every new 1:1 send (text, file, voice, sticker/GIF,
   * contact cards, poll, event, forward, group-invite card). Someone who
   * already talks to this account, or whose chat the owner already opened
   * (typed from the main phone), always gets it: Baileys attaches their
   * tctoken when fresh, else a cstoken when the NCT salt exists, else
   * nothing — as WA Web and whatsmeow, which never hold a send back for a
   * missing or expired tctoken. Only a true first contact (no token record,
   * no INBOUND and no non-failed OUTBOUND message) goes through the token
   * preflight, which refuses (account_restricted) when no token can be
   * attached: a token-less first message counts as a reach-out.
   */
  private async guardDirectSend(rawJid: string, started = Date.now()): Promise<void> {
    if (this.isGroupJid(rawJid) || !this.isDirectUserJid(rawJid)) return;
    if (process.env.WA_DIRECT_PRIVACY_PREFLIGHT === 'false') return;
    if (!(this.sock as any)?.authState?.keys) return;
    const normalized = this.normalizeJid(rawJid);
    const evidence = await this.knownDirectContactEvidence(rawJid);
    if (evidence) {
      if (evidence !== 'tctoken') {
        this.logger.info(
          `WhatsApp direct send to a known contact without a fresh trusted-contact token evidence=${evidence} rawJid=${rawJid} normalizedJid=${normalized}`
        );
      }
      return;
    }
    await this.prepareDirectPrivacyToken(rawJid, normalized, started).catch(e => {
      throw this.buildSendError(
        classifyWhatsAppSendFailure(e),
        rawJid,
        normalized,
        false,
        started,
        0,
        e
      );
    });
  }

  /**
   * Why a 1:1 target is not a first contact, or null when it is: a fresh
   * tctoken; any tctoken record (theirs, expired or emptied by Baileys'
   * cleanup, or ours issued after an earlier send to them); an INBOUND
   * message on the canonical conversation of their PN or LID; or an OUTBOUND
   * one that did not fail — typed by the owner on the main phone, or sent by
   * the connector after it passed this guard (history is ingest only —
   * tctokens expire in 4 weekly buckets and Baileys prunes the records).
   */
  private async knownDirectContactEvidence(
    rawJid: string
  ): Promise<'tctoken' | 'token_record' | 'inbound_history' | 'outbound_history' | null> {
    const sock = this.sock as any;
    const keys = sock?.authState?.keys;
    const lidMapping = sock?.signalRepository?.lidMapping;
    const getLIDForPN =
      lidMapping?.getLIDForPN?.bind(lidMapping) || (async () => null as string | null);
    const getPNForLID =
      lidMapping?.getPNForLID?.bind(lidMapping) || (async () => null as string | null);
    if (keys) {
      const storageJid = await resolveTcTokenJid(rawJid, getLIDForPN);
      const entry = (await keys.get('tctoken', [storageJid]))?.[storageJid];
      if (entry) {
        const tokenLength = typeof entry.token?.length === 'number' ? entry.token.length : 0;
        if (tokenLength > 0 && !isTcTokenExpired(entry.timestamp)) return 'tctoken';
        if (tokenLength > 0 || entry.timestamp !== undefined || entry.senderTimestamp !== undefined)
          return 'token_record';
      }
    }
    if (!this.ingest) return null;
    try {
      const twin = isLidJid(rawJid)
        ? await getPNForLID(rawJid).catch(() => null)
        : await getLIDForPN(rawJid).catch(() => null);
      const ids = [rawJid, ...(twin ? [jidNormalizedUser(twin)] : [])];
      if (await this.directInboundHistory(ids)) return 'inbound_history';
      return (await this.directOutboundHistory(ids)) ? 'outbound_history' : null;
    } catch (error) {
      this.logger.warn(
        `WhatsApp direct send: history lookup failed rawJid=${rawJid}: ${errorMessage(error)}`
      );
      return null;
    }
  }

  /** Seam for tests (no DB): see hasInboundHistory. */
  private directInboundHistory(chatIds: string[]): Promise<boolean> {
    return hasInboundHistory(chatIds);
  }

  /** Seam for tests (no DB): see hasOutboundHistory. */
  private directOutboundHistory(chatIds: string[]): Promise<boolean> {
    return hasOutboundHistory(chatIds);
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

    // Never null here: the socket and its key store were checked above.
    const hasValidToken = async () => (await this.readDirectPrivacyTokenState(rawJid))!;

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

    // A first message never has the recipient's tctoken: they issue it once
    // they talk to us. WA Web and whatsmeow then send a self-computed
    // <cstoken>, which the patched Baileys attaches when this holds. Without
    // it the send would go out token-less and count as a reach-out, so stop.
    if (canAttachCsToken(sock.authState?.creds, tokenState.storageJid)) {
      this.logger.info(
        `WhatsApp direct preflight: no trusted-contact token, sending with cstoken rawJid=${rawJid} normalizedJid=${normalizedJid}`
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
          causeMessage: sock.authState?.creds?.nctSalt?.length
            ? 'missing trusted-contact token after preflight (recipient has no LID for a cstoken)'
            : 'missing trusted-contact token after preflight and no NCT salt for a cstoken',
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
