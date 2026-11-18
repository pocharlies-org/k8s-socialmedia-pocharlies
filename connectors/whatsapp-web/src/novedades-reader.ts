/**
 * Read-only HTTP view over the persisted Novedades store (channels + statuses).
 *
 * Rules this module must never break:
 *  - No WhatsApp writes at all on the read paths: no read receipt, no presence,
 *    no publish, no subscription change. Every catalog call is a store SELECT
 *    scoped to the process account (`connectorAccount()` inside the store), so
 *    polling is invisible to WhatsApp.
 *  - JSON never carries a raw payload, a `mediaKey`, a `directPath`, an
 *    encrypted CDN URL, an invite code, or a credential. Only whitelisted,
 *    already-normalized fields leave this module.
 *  - Media bytes come from the injected ports (connector downloader and avatar
 *    fetcher) after the exact row scope is resolved (account + channel JID, or
 *    account + author JID + message id). A port that cannot answer must say so;
 *    bytes are never invented.
 *  - Paging is keyset based (`timestamp + id`, tie-break on id), so a page
 *    always advances even when hundreds of items share one exact timestamp, and
 *    nothing is dropped or repeated silently.
 *  - Coverage is declared, not implied: rc13 exposes no newsletter subscription
 *    listing here and no history backfill has run, so the absence of a channel,
 *    an author, or a post is never proof that WhatsApp has none.
 */
import type { Readable } from 'node:stream';
import {
  getContentType,
  jidNormalizedUser,
  normalizeMessageContent,
} from '@whiskeysockets/baileys';
import { connectorAccount } from './db-writer';
import {
  NovedadesStoreError,
  getNovedadesChannel,
  getNovedadesMessage,
  getNovedadesStatus,
  listNovedadesChannels,
  listNovedadesMessages,
  listNovedadesStatus,
  listNovedadesStatusAuthors,
  type NovedadesStatusQuery,
  type StoredNovedadesChannel,
  type StoredNovedadesMessage,
  type StoredNovedadesStatus,
} from './novedades-store';

export class NovedadesReaderError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = 'NovedadesReaderError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Honest HTTP envelope for any reader or store failure. */
export function novedadesErrorBody(error: unknown): {
  status: number;
  body: { ok: false; error: { code: string; message: string } };
} {
  if (error instanceof NovedadesReaderError)
    return {
      status: error.status,
      body: { ok: false, error: { code: error.code, message: error.message } },
    };
  if (error instanceof NovedadesStoreError)
    return {
      status: error.status,
      body: { ok: false, error: { code: error.code, message: error.message } },
    };
  return {
    status: 500,
    body: {
      ok: false,
      error: {
        code: 'NOVEDADES_READER_ERROR',
        message: 'Novedades could not complete the request',
      },
    },
  };
}

export type NovedadesContentKind =
  'text' | 'image' | 'video' | 'audio' | 'sticker' | 'document' | 'poll' | 'event' | 'unknown';

export const NOVEDADES_PAGE_DEFAULT = 50;
export const NOVEDADES_PAGE_MAX = 100;
export const NOVEDADES_AUTHOR_ITEMS_CAP = 20;
/** The store caps one read at 2000 rows; reaching it is reported, not hidden. */
export const NOVEDADES_STORE_WINDOW = 2000;
/** Base64 responses stay bounded: bigger media needs a streaming seam. */
export const NOVEDADES_MEDIA_MAX_BYTES = 25 * 1024 * 1024;

/** Bound retained bytes and caller wait. rc13 cannot abort its hidden HTTP fetch. */
export async function readNovedadesMediaStream(
  open: () => Promise<Readable>,
  timeoutMs: number,
  maxBytes = NOVEDADES_MEDIA_MAX_BYTES
): Promise<Buffer> {
  let stream: Readable | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const download = async () => {
    stream = await open();
    // A fetch may finish after our deadline; never leave its returned stream alive.
    if (expired) {
      stream.destroy();
      return Buffer.alloc(0);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > maxBytes)
          throw new NovedadesReaderError(
            'NOVEDADES_MEDIA_TOO_LARGE',
            'Media exceeds the download size cap',
            413
          );
        chunks.push(bytes);
      }
      return Buffer.concat(chunks, size);
    } finally {
      stream.destroy();
    }
  };
  try {
    return await Promise.race([
      download(),
      new Promise<Buffer>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          stream?.destroy();
          reject(
            new NovedadesReaderError('NOVEDADES_MEDIA_TIMEOUT', 'Media download timed out', 504)
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const AVATAR_HOST_SUFFIXES = [
  'whatsapp.net',
  'wa.me',
  'whatsapp.com',
  'fbcdn.net',
  'fbsbx.com',
  'facebook.net',
];

export interface NovedadesCoverage {
  source: 'local-store';
  remoteListing: false;
  backfilled: false;
  syncedAt: null;
  /** Author names need the contact directory, which this view does not join. */
  authorNames: false;
  /** Per-channel latest-post time is not materialized in the channel row. */
  channelLatestPost: false;
  mediaDownloadsWired: boolean;
  avatarDownloadsWired: boolean;
  reasons: string[];
}

export interface NovedadesPageFields {
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
  overlapPossible: false;
  truncated: boolean;
}

export interface NovedadesStatusItem {
  id: string;
  author: string;
  text: string | null;
  kind: NovedadesContentKind;
  timestamp: string | null;
  timestampMs: number | null;
  expiresAt: string | null;
  remainingMs: number;
  active: boolean;
  freshnessUnknown: boolean;
  seenAt: string | null;
  mimeType: string | null;
  mediaUrl: string | null;
  mediaKind: 'image' | 'video' | 'audio' | 'sticker' | 'document' | null;
  mediaSizeBytes: number | null;
  mediaFileName: string | null;
  mediaDurationSeconds: number | null;
}

export interface NovedadesAuthorSummary {
  id: string;
  name: string | null;
  own: boolean;
  count: number;
  total: number;
  unseen: number;
  latestTimestamp: string | null;
  /**
   * Identity of the newest status behind `latestTimestamp`, plus when that row
   * first reached the store (microsecond UTC string). Together with
   * `latestTimestamp` they form a tuple a client can compare as strings: it
   * grows exactly when a newer status arrived, even when two statuses share a
   * posting second and the provider ids sort backwards. Null for a store that
   * predates the columns.
   */
  latestStatusId: string | null;
  latestReceivedAt: string | null;
}

export interface NovedadesChannelItem {
  id: string;
  name: string;
  description: string | null;
  role: string | null;
  subscribed: boolean | null;
  verification: string | null;
  subscribers: number | null;
  createdAt: string | null;
  muted: boolean | null;
  avatarAvailable: boolean;
  avatarUrl: string | null;
  latestTimestamp: null;
}

export interface NovedadesPostItem {
  id: string;
  text: string | null;
  kind: NovedadesContentKind;
  timestamp: string | null;
  timestampMs: number | null;
  mimeType: string | null;
  mediaUrl: string | null;
  mediaKind: 'image' | 'video' | 'audio' | 'sticker' | 'document' | null;
  mediaSizeBytes: number | null;
  mediaFileName: string | null;
  deleted: boolean;
}

export interface NovedadesMediaPayload {
  bytes: Buffer;
  mimeType: string;
  fileName: string | null;
}

const MEDIA_FIELDS: Array<{ field: string; kind: NonNullable<NovedadesPostItem['mediaKind']> }> = [
  { field: 'imageMessage', kind: 'image' },
  { field: 'videoMessage', kind: 'video' },
  { field: 'audioMessage', kind: 'audio' },
  { field: 'stickerMessage', kind: 'sticker' },
  { field: 'documentMessage', kind: 'document' },
];

function mediaFieldOf(content: Record<string, unknown>): {
  field: string;
  kind: NonNullable<NovedadesPostItem['mediaKind']>;
} | null {
  for (const entry of MEDIA_FIELDS) if (content[entry.field]) return entry;
  return null;
}

function sizeBytesOf(media: Record<string, unknown>): number | null {
  const raw = media.fileLength;
  if (raw === undefined || raw === null) return null;
  // JSONB preserves Long's words but not its prototype/toString method.
  const words = raw as { low?: number; high?: number; unsigned?: boolean };
  const num =
    typeof raw === 'object' && Number.isInteger(words.low) && Number.isInteger(words.high)
      ? (words.unsigned ? words.high! >>> 0 : words.high!) * 0x100000000 + (words.low! >>> 0)
      : Number(raw);
  return Number.isSafeInteger(num) && num >= 0 ? num : null;
}

function secondsOf(media: Record<string, unknown>): number | null {
  const raw = media.seconds ?? media.secondsIndicator;
  const num = typeof raw === 'string' ? Number(raw) : Number(raw);
  return Number.isFinite(num) && num >= 0 && num < 86_400_000 ? Math.round(num) : null;
}

function contentOf(payload: unknown): { content: Record<string, unknown>; type: string | null } {
  if (!payload || typeof payload !== 'object') return { content: {}, type: null };
  let normalized: unknown = payload;
  try {
    normalized =
      normalizeMessageContent(payload as Parameters<typeof normalizeMessageContent>[0]) ?? payload;
  } catch {
    normalized = payload;
  }
  const content = (normalized && typeof normalized === 'object' ? normalized : payload) as Record<
    string,
    unknown
  >;
  let type: string | null = null;
  try {
    type = getContentType(content as Parameters<typeof getContentType>[0]) ?? null;
  } catch {
    type = null;
  }
  return { content, type };
}

function kindOf(type: string | null, content: Record<string, unknown>): NovedadesContentKind {
  const media = mediaFieldOf(content);
  if (type === 'pollCreationMessage' || type === 'pollCreationMessageV3') return 'poll';
  if (type === 'conversation' || type === 'extendedTextMessage') return 'text';
  if (
    type === 'protocolMessage' ||
    type === 'reactionMessage' ||
    type === 'senderKeyDistributionMessage' ||
    type === 'groupSnapshotUpdateMessage' ||
    type === 'groupInviteMessage'
  )
    return 'event';
  if (media) return media.kind;
  return 'unknown';
}

function textOf(content: Record<string, unknown>): string | null {
  if (typeof content.conversation === 'string') return content.conversation.slice(0, 4000);
  const extended = content.extendedTextMessage as Record<string, unknown> | undefined;
  if (extended && typeof extended.text === 'string') return extended.text.slice(0, 4000);
  const media = mediaFieldOf(content);
  const caption = media
    ? (content[media.field] as Record<string, unknown> | undefined)?.caption
    : undefined;
  return typeof caption === 'string' && caption.trim() ? caption.slice(0, 4000) : null;
}

function mediaFieldsOf(content: Record<string, unknown>): {
  mimeType: string | null;
  mediaKind: NovedadesPostItem['mediaKind'];
  mediaSizeBytes: number | null;
  mediaFileName: string | null;
  mediaDurationSeconds: number | null;
} {
  const media = mediaFieldOf(content);
  if (!media)
    return {
      mimeType: null,
      mediaKind: null,
      mediaSizeBytes: null,
      mediaFileName: null,
      mediaDurationSeconds: null,
    };
  const body = (content[media.field] || {}) as Record<string, unknown>;
  return {
    mimeType: typeof body.mimetype === 'string' ? body.mimetype.slice(0, 160) : null,
    mediaKind: media.kind,
    mediaSizeBytes: sizeBytesOf(body),
    mediaFileName:
      media.kind === 'document' && typeof body.fileName === 'string' && body.fileName.trim()
        ? body.fileName.trim().slice(0, 240)
        : null,
    mediaDurationSeconds: media.kind === 'audio' || media.kind === 'video' ? secondsOf(body) : null,
  };
}

function iso(ms: number | null): string | null {
  return ms === null || !Number.isSafeInteger(ms) ? null : new Date(ms).toISOString();
}

function mediaUrlFor(kind: 'channel' | 'status', jid: string, messageId: string): string {
  return `/api/v1/novedades/media?kind=${kind}&jid=${encodeURIComponent(jid)}&messageId=${encodeURIComponent(messageId)}`;
}

function avatarUrlFor(jid: string): string {
  return `/api/v1/novedades/media?kind=avatar&jid=${encodeURIComponent(jid)}`;
}

/**
 * A newsletter role of owner or admin implies a membership, so it must count as
 * subscribed; guest and eligible are explicit non-memberships. Anything else
 * (including the metadata this build has not normalized yet) stays null rather
 * than guessing.
 */
export function subscribedFromRole(role: string | null): boolean | null {
  const value = (role || '').trim().toLowerCase();
  if (value === 'owner' || value === 'admin' || value === 'subscriber') return true;
  if (value === 'guest' || value === 'eligible') return false;
  return null;
}

function channelItem(row: StoredNovedadesChannel): NovedadesChannelItem {
  return {
    id: row.jid,
    name: row.name,
    description: row.description ?? null,
    role: row.role ?? null,
    subscribed: subscribedFromRole(row.role ?? null),
    verification: row.verification ?? null,
    subscribers:
      row.subscriberCount == null || !Number.isSafeInteger(row.subscriberCount)
        ? null
        : row.subscriberCount,
    createdAt: iso(row.creationTimestampMs ?? null),
    muted: row.muteState == null ? null : row.muteState !== 'none',
    avatarAvailable: Boolean(row.avatarUrl),
    avatarUrl: row.avatarUrl ? avatarUrlFor(row.jid) : null,
    latestTimestamp: null,
  };
}

function statusItem(row: StoredNovedadesStatus): NovedadesStatusItem {
  const { content } = contentOf(row.payload);
  const media = mediaFieldsOf(content);
  return {
    id: row.messageId,
    author: row.authorJid,
    text: textOf(content),
    kind: kindOf(row.messageType, content),
    timestamp: row.postedAt,
    timestampMs: row.timestampMs,
    expiresAt: row.expiresAt,
    remainingMs: row.ttlRemainingMs,
    active: row.active,
    freshnessUnknown: row.freshnessUnknown,
    seenAt: row.seenAt,
    mimeType: media.mimeType,
    mediaUrl: media.mediaKind ? mediaUrlFor('status', row.authorJid, row.messageId) : null,
    mediaKind: media.mediaKind,
    mediaSizeBytes: media.mediaSizeBytes,
    mediaFileName: media.mediaFileName,
    mediaDurationSeconds: media.mediaDurationSeconds,
  };
}

export function novedadesPostItem(
  row: Pick<
    StoredNovedadesMessage,
    'payload' | 'messageType' | 'messageId' | 'timestampMs' | 'channelJid' | 'isDeleted'
  >
): NovedadesPostItem {
  const { content } = contentOf(row.payload);
  const media = mediaFieldsOf(content);
  return {
    id: row.messageId,
    text: textOf(content),
    kind: kindOf(row.messageType, content),
    timestamp: iso(row.timestampMs),
    timestampMs: row.timestampMs,
    mimeType: media.mimeType,
    mediaUrl: media.mediaKind ? mediaUrlFor('channel', row.channelJid, row.messageId) : null,
    mediaKind: media.mediaKind,
    mediaSizeBytes: media.mediaSizeBytes,
    mediaFileName: media.mediaFileName,
    deleted: row.isDeleted,
  };
}

/* --------------------------------------------------------------------------
 * Opaque keyset cursors
 * ------------------------------------------------------------------------ */

type CursorKind = 'p' | 's' | 'c';

interface CursorPayload {
  /** Listing kind: p=posts, s=statuses, c=channels. */
  k: CursorKind;
  /** Scope the cursor was issued for: channel or author JID, '' when unscoped. */
  s: string;
  /** Previous page's last keyset timestamp in epoch ms; null is the no-timestamp tail. */
  t: string | null;
  /** Previous page's last id, which breaks ties inside one exact timestamp. */
  i: string;
  /** Sort-key name, channels only (that listing is ordered by name, then jid). */
  n?: string;
}

const CURSOR_MAX_LENGTH = 8192;
const CURSOR_ID_MAX = 512;
const CURSOR_SCOPE_MAX = 256;
const CURSOR_NAME_MAX = 1024;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

export function encodeNovedadesCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function invalidCursor(): NovedadesReaderError {
  return new NovedadesReaderError(
    'NOVEDADES_CURSOR_INVALID',
    'Paging cursor is malformed or belongs to another listing; start again without a cursor',
    400
  );
}

/**
 * Cursors are opaque and must never be trusted: a caller can hand one back to
 * the wrong endpoint, to another channel or author, or after editing the
 * base64. Every field is re-validated here, and the recorded scope has to
 * match the scope of the request, so a mismatch is an honest 400 instead of a
 * page silently skipping or repeating items.
 */
function decodeNovedadesCursor(
  value: unknown,
  kind: CursorKind,
  scope: string
): CursorPayload | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (!text || text.length > CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(text))
    throw invalidCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const cursor = parsed as Partial<CursorPayload> | null;
  if (!cursor || typeof cursor !== 'object' || cursor.k !== kind) throw invalidCursor();
  if (typeof cursor.s !== 'string' || cursor.s.length > CURSOR_SCOPE_MAX || cursor.s !== scope)
    throw invalidCursor();
  if (
    typeof cursor.i !== 'string' ||
    !cursor.i ||
    cursor.i.length > CURSOR_ID_MAX ||
    /\s/.test(cursor.i)
  )
    throw invalidCursor();
  if (
    cursor.t !== null &&
    !(
      typeof cursor.t === 'string' &&
      /^\d{1,16}$/.test(cursor.t) &&
      Number(cursor.t) <= MAX_TIMESTAMP_MS
    )
  )
    throw invalidCursor();
  if (kind === 'c' && (typeof cursor.n !== 'string' || cursor.n.length > CURSOR_NAME_MAX))
    throw invalidCursor();
  return cursor as CursorPayload;
}

function cursorTimestampMs(cursor: CursorPayload): number | null {
  if (cursor.t === null) return null;
  const value = Number(cursor.t);
  if (!Number.isSafeInteger(value) || value > MAX_TIMESTAMP_MS) throw invalidCursor();
  return value;
}

/** The keyset timestamp of an item, in the same unit the store pages on. */
function cursorTimeOf(timestampMs: number | null): string | null {
  return timestampMs === null || !Number.isSafeInteger(timestampMs) ? null : String(timestampMs);
}

/**
 * Paging metadata under a probe-row contract: every listing asks the store for
 * `limit + 1` rows, so `hasMore` is true only when a real row exists beyond
 * the page and `nextCursor` exists exactly when `hasMore` does. A final page
 * that is exactly full reports `hasMore: false` with no cursor, so a caller
 * never pays for an empty follow-up request. `truncated` says when the window
 * itself capped the answer instead of the page.
 */
function pageFields(
  rows: number,
  limit: number,
  lastCursor: CursorPayload | undefined,
  window = NOVEDADES_STORE_WINDOW
): NovedadesPageFields {
  const hasMore = rows > limit;
  const items = hasMore ? rows - 1 : rows;
  return {
    limit,
    hasMore,
    nextCursor: hasMore && lastCursor ? encodeNovedadesCursor(lastCursor) : null,
    overlapPossible: false,
    truncated: items >= window,
  };
}

/* --------------------------------------------------------------------------
 * Ports (the only places this module can touch the outside world)
 * ------------------------------------------------------------------------ */

export interface NovedadesMediaRequest {
  kind: 'channel' | 'status';
  jid: string;
  messageId: string;
  key: unknown;
  message: unknown;
}

export interface NovedadesPorts {
  /** Downloads one stored item's media through the connector's own session. */
  downloadMedia?: (
    request: NovedadesMediaRequest
  ) => Promise<{ buffer: Buffer; mimeType?: string | null; fileName?: string | null } | null>;
  /** Fetches a stored channel avatar URL (https, provider hosts only). */
  fetchAvatar?: (url: string) => Promise<Buffer | null>;
  /** Own JID of this session, used to flag the account's own statuses. */
  ownJid?: () => string | null | undefined;
}

export interface NovedadesStoreReads {
  statusAuthors: () => Promise<Awaited<ReturnType<typeof listNovedadesStatusAuthors>>>;
  statuses: (options?: NovedadesStatusQuery) => Promise<StoredNovedadesStatus[]>;
  /** Exact single-status read (active, visible, not deleted). */
  status: (authorJid: string, messageId: string) => Promise<StoredNovedadesStatus | undefined>;
  channels: (options?: {
    limit?: number;
    after?: { name: string; jid: string } | null;
  }) => Promise<StoredNovedadesChannel[]>;
  /** Exact single-channel read. */
  channel: (channelJid: string) => Promise<StoredNovedadesChannel | undefined>;
  messages: (
    channelJid: string,
    options?: Parameters<typeof listNovedadesMessages>[1]
  ) => Promise<StoredNovedadesMessage[]>;
  message: (
    channelJid: string,
    messageId: string,
    options?: { includeSuperseded?: boolean }
  ) => Promise<StoredNovedadesMessage | undefined>;
}

const defaultReads: NovedadesStoreReads = {
  statusAuthors: () => listNovedadesStatusAuthors(),
  statuses: options => listNovedadesStatus(options),
  status: (authorJid, messageId) => getNovedadesStatus(authorJid, messageId),
  channels: options => listNovedadesChannels(options),
  channel: channelJid => getNovedadesChannel(channelJid),
  messages: (channelJid, options) => listNovedadesMessages(channelJid, options),
  message: (channelJid, messageId, options) => getNovedadesMessage(channelJid, messageId, options),
};

function flag(value: unknown, name: string): boolean {
  if (value === undefined || value === null || value === '') return false;
  const text = String(value).trim().toLowerCase();
  if (text === '0' || text === 'false' || text === 'no') return false;
  if (text === '1' || text === 'true' || text === 'yes') return true;
  throw new NovedadesReaderError('NOVEDADES_FLAG_INVALID', `Unexpected value for ${name}`, 400);
}

function limitOf(value: unknown): number {
  if (value === undefined || value === null || value === '') return NOVEDADES_PAGE_DEFAULT;
  const num = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isSafeInteger(num) || num < 1 || num > NOVEDADES_PAGE_MAX)
    throw new NovedadesReaderError(
      'NOVEDADES_LIMIT_INVALID',
      `limit must be an integer between 1 and ${NOVEDADES_PAGE_MAX}`,
      400
    );
  return num;
}

function visibilityOf(value: unknown): 'visible' | 'event' | 'unknown' | 'all' {
  if (value === undefined || value === null || value === '') return 'visible';
  const text = String(value).trim();
  if (text === 'visible' || text === 'event' || text === 'unknown' || text === 'all') return text;
  throw new NovedadesReaderError(
    'NOVEDADES_VISIBILITY_INVALID',
    `Unknown visibility filter '${text}'`,
    400
  );
}

function idText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 512 || /\s/.test(text))
    throw new NovedadesReaderError('NOVEDADES_ID_INVALID', `${field} must be a non-empty id`, 400);
  return text;
}

function ownUserJid(ports: NovedadesPorts): string | null {
  try {
    const raw = ports.ownJid?.();
    if (typeof raw !== 'string' || !raw.includes('@')) return null;
    // `jidNormalizedUser` is what maps a device JID (`34600123456:7@...`) to
    // the user JID the store uses. Stripping the device part by hand first
    // would drop the realm and never match a stored author.
    return jidNormalizedUser(raw) || null;
  } catch {
    return null;
  }
}

/**
 * Only provider CDN hosts may be fetched for an avatar. The check is
 * dot-bounded on purpose: `evilwhatsapp.net` must not pass as `whatsapp.net`.
 * Plain http is refused even on an allowed host: a provider avatar reference
 * is always https, and an http downgrade would let an on-path attacker strip
 * the TLS the host check assumes. The controller checks every redirect
 * target before fetching it.
 */
export function avatarHostAllowed(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return AVATAR_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}

export interface StatusAuthorsResult {
  account: string;
  authors: NovedadesAuthorSummary[];
  nextCursor: null;
  hasMore: false;
  coverage: NovedadesCoverage;
}

export interface StatusListResult extends NovedadesPageFields {
  account: string;
  serverTime: string;
  items: NovedadesStatusItem[];
  coverage: NovedadesCoverage;
}

export interface ChannelListResult extends NovedadesPageFields {
  account: string;
  channels: NovedadesChannelItem[];
  coverage: NovedadesCoverage;
}

export interface PostListResult extends NovedadesPageFields {
  account: string;
  channel: NovedadesChannelItem | null;
  items: NovedadesPostItem[];
  coverage: NovedadesCoverage;
}

export interface NovedadesReader {
  statusAuthors(): Promise<StatusAuthorsResult>;
  statuses(query: {
    author?: unknown;
    limit?: unknown;
    cursor?: unknown;
    includeExpired?: unknown;
    unreadOnly?: unknown;
    includeDeleted?: unknown;
    visibility?: unknown;
  }): Promise<StatusListResult>;
  channels(query: { limit?: unknown; cursor?: unknown }): Promise<ChannelListResult>;
  posts(query: {
    channelJid: unknown;
    limit?: unknown;
    cursor?: unknown;
    includeDeleted?: unknown;
    visibility?: unknown;
  }): Promise<PostListResult>;
  post(query: { channelJid: unknown; messageId: unknown }): Promise<NovedadesPostItem>;
  media(query: {
    kind: unknown;
    jid: unknown;
    messageId?: unknown;
  }): Promise<NovedadesMediaPayload>;
  coverage(): NovedadesCoverage;
}

export function createNovedadesReader(
  deps: { store?: Partial<NovedadesStoreReads>; ports?: NovedadesPorts } = {}
): NovedadesReader {
  const store: NovedadesStoreReads = { ...defaultReads, ...(deps.store || {}) };
  const ports: NovedadesPorts = deps.ports || {};

  function coverage(): NovedadesCoverage {
    return {
      source: 'local-store',
      remoteListing: false,
      backfilled: false,
      syncedAt: null,
      authorNames: false,
      channelLatestPost: false,
      mediaDownloadsWired: typeof ports.downloadMedia === 'function',
      avatarDownloadsWired: typeof ports.fetchAvatar === 'function',
      reasons: [
        'session-scoped-history',
        'no-remote-subscription-listing',
        'no-history-backfill',
        'avatar-not-refreshed-on-read',
      ],
    };
  }

  async function statusAuthors(): Promise<StatusAuthorsResult> {
    const summaries = await store.statusAuthors();
    const own = ownUserJid(ports);
    return {
      account: connectorAccount(),
      authors: summaries.map(row => ({
        id: row.authorJid,
        name: null,
        own: Boolean(own && jidNormalizedUser(row.authorJid) === own),
        count: row.active,
        total: row.total,
        unseen: row.unseen,
        latestTimestamp: row.latestPostedAt,
        latestStatusId: row.latestStatusId ?? null,
        latestReceivedAt: row.latestReceivedAt ?? null,
      })),
      nextCursor: null,
      hasMore: false,
      coverage: coverage(),
    };
  }

  async function statuses(query: {
    author?: unknown;
    limit?: unknown;
    cursor?: unknown;
    includeExpired?: unknown;
    unreadOnly?: unknown;
    includeDeleted?: unknown;
    visibility?: unknown;
  }): Promise<StatusListResult> {
    const limit = limitOf(query.limit);
    const author = query.author ? idText(query.author, 'author') : null;
    const cursor = decodeNovedadesCursor(query.cursor, 's', author ?? '');
    const rows = await store.statuses({
      ...(author ? { authorJids: [author] } : {}),
      includeExpired: flag(query.includeExpired, 'includeExpired'),
      unreadOnly: flag(query.unreadOnly, 'unreadOnly'),
      includeDeleted: flag(query.includeDeleted, 'includeDeleted'),
      visibility: visibilityOf(query.visibility),
      limit: Math.min(NOVEDADES_STORE_WINDOW, limit + 1),
      ...(cursor ? { after: { timestampMs: cursorTimestampMs(cursor), id: cursor.i } } : {}),
    });
    // When the caller filtered by author, items report that author verbatim:
    // the store already filtered on the normalized identity, and the caller's
    // own spelling is what its consumer has to recognize.
    const items = rows.slice(0, limit).map(row => ({
      ...statusItem(row),
      author: author ?? row.authorJid,
    }));
    const last = items[items.length - 1];
    return {
      account: connectorAccount(),
      serverTime: new Date().toISOString(),
      items,
      ...pageFields(
        rows.length,
        limit,
        last
          ? { k: 's', s: author ?? '', t: cursorTimeOf(last.timestampMs), i: last.id }
          : undefined
      ),
      coverage: coverage(),
    };
  }

  async function channels(query: {
    limit?: unknown;
    cursor?: unknown;
  }): Promise<ChannelListResult> {
    const limit = limitOf(query.limit);
    const cursor = decodeNovedadesCursor(query.cursor, 'c', '');
    const rows = await store.channels({
      limit: Math.min(NOVEDADES_STORE_WINDOW, limit + 1),
      ...(cursor ? { after: { name: cursor.n ?? cursor.i, jid: cursor.i } } : {}),
    });
    const items = rows.slice(0, limit).map(channelItem);
    const last = items[items.length - 1];
    return {
      account: connectorAccount(),
      channels: items,
      ...pageFields(
        rows.length,
        limit,
        last ? { k: 'c', s: '', t: null, i: last.id, n: last.name } : undefined
      ),
      coverage: coverage(),
    };
  }

  async function posts(query: {
    channelJid: unknown;
    limit?: unknown;
    cursor?: unknown;
    includeDeleted?: unknown;
    visibility?: unknown;
  }): Promise<PostListResult> {
    const channelJid = idText(query.channelJid, 'channel jid');
    if (!channelJid.endsWith('@newsletter'))
      throw new NovedadesReaderError(
        'NOVEDADES_CHANNEL_INVALID',
        'A channel (@newsletter) JID is required',
        400
      );
    const limit = limitOf(query.limit);
    const cursor = decodeNovedadesCursor(query.cursor, 'p', channelJid);
    const rows = await store.messages(channelJid, {
      limit: Math.min(NOVEDADES_STORE_WINDOW, limit + 1),
      includeDeleted: flag(query.includeDeleted, 'includeDeleted'),
      visibility: visibilityOf(query.visibility),
      ...(cursor ? { after: { timestampMs: cursorTimestampMs(cursor), id: cursor.i } } : {}),
    });
    const items = rows.slice(0, limit).map(novedadesPostItem);
    const last = items[items.length - 1];
    // The channel header is an object (the caller validates its id against the
    // requested scope), and it is null when this account never stored that
    // channel's metadata: an absent header is not a claim that the channel
    // does not exist, which is what `coverage` already declares.
    const channelRow = await store.channel(channelJid);
    return {
      account: connectorAccount(),
      channel: channelRow ? channelItem(channelRow) : null,
      items,
      ...pageFields(
        rows.length,
        limit,
        last ? { k: 'p', s: channelJid, t: cursorTimeOf(last.timestampMs), i: last.id } : undefined
      ),
      coverage: coverage(),
    };
  }

  async function post(query: {
    channelJid: unknown;
    messageId: unknown;
  }): Promise<NovedadesPostItem> {
    const channelJid = idText(query.channelJid, 'channel jid');
    const messageId = idText(query.messageId, 'messageId');
    const row = await store.message(channelJid, messageId, { includeSuperseded: true });
    if (!row)
      throw new NovedadesReaderError(
        'NOVEDADES_POST_NOT_FOUND',
        'This account has no stored post with that id in that channel',
        404
      );
    return novedadesPostItem(row);
  }

  async function media(query: {
    kind: unknown;
    jid: unknown;
    messageId?: unknown;
  }): Promise<NovedadesMediaPayload> {
    const kind = String(query.kind || '').trim();
    const jid = idText(query.jid, 'jid');
    if (kind === 'avatar') {
      // Capability before data: when this build has no avatar fetcher, saying
      // so (501) is more honest than a 404 that changes with the row's stored
      // reference, and it is the same answer every caller gets while unwired.
      if (!ports.fetchAvatar)
        throw new NovedadesReaderError(
          'NOVEDADES_AVATAR_UNSUPPORTED',
          'This connector build cannot fetch channel avatars',
          501
        );
      const row = await store.channel(jid);
      if (!row?.avatarUrl)
        throw new NovedadesReaderError(
          'NOVEDADES_AVATAR_UNAVAILABLE',
          'No stored avatar for that channel',
          404
        );
      let url: URL;
      try {
        url = new URL(row.avatarUrl);
      } catch {
        throw new NovedadesReaderError(
          'NOVEDADES_AVATAR_UNAVAILABLE',
          'The stored avatar reference is not a usable URL',
          404
        );
      }
      if (url.protocol !== 'https:' || !avatarHostAllowed(url))
        throw new NovedadesReaderError(
          'NOVEDADES_AVATAR_UNAVAILABLE',
          'The stored avatar host is not allowed',
          404
        );
      const bytes = await ports.fetchAvatar(url.toString());
      if (!bytes?.length)
        throw new NovedadesReaderError(
          'NOVEDADES_AVATAR_UNAVAILABLE',
          'The avatar host returned no bytes',
          404
        );
      if (bytes.length > NOVEDADES_MEDIA_MAX_BYTES)
        throw new NovedadesReaderError(
          'NOVEDADES_MEDIA_TOO_LARGE',
          `Avatar is ${bytes.length} bytes; the cap is ${NOVEDADES_MEDIA_MAX_BYTES}`,
          413
        );
      return { bytes, mimeType: 'image/jpeg', fileName: null };
    }
    if (kind !== 'channel' && kind !== 'status')
      throw new NovedadesReaderError(
        'NOVEDADES_MEDIA_KIND_INVALID',
        "kind must be 'channel', 'status' or 'avatar'",
        400
      );
    const messageId = idText(query.messageId, 'messageId');
    let key: unknown;
    let message: unknown;
    let storedMimetype: string | null = null;
    let storedFileName: string | null = null;
    if (kind === 'channel') {
      const row = await store.message(jid, messageId);
      if (!row || row.isDeleted || row.supersededBy !== null)
        throw new NovedadesReaderError(
          'NOVEDADES_MEDIA_NOT_FOUND',
          'No live stored post with that id in that channel',
          404
        );
      const { content } = contentOf(row.payload);
      const mediaInfo = mediaFieldsOf(content);
      if (!mediaInfo.mediaKind)
        throw new NovedadesReaderError(
          'NOVEDADES_MEDIA_UNAVAILABLE',
          'That post has no downloadable media',
          404
        );
      storedMimetype = mediaInfo.mimeType;
      storedFileName = mediaInfo.mediaFileName;
      key = row.key;
      message = row.payload;
    } else {
      const row = await store.status(jid, messageId);
      if (!row)
        throw new NovedadesReaderError(
          'NOVEDADES_MEDIA_NOT_FOUND',
          'No stored status with that id for that author',
          404
        );
      const { content } = contentOf(row.payload);
      const mediaInfo = mediaFieldsOf(content);
      if (!mediaInfo.mediaKind)
        throw new NovedadesReaderError(
          'NOVEDADES_MEDIA_UNAVAILABLE',
          'That status has no downloadable media',
          404
        );
      storedMimetype = mediaInfo.mimeType;
      storedFileName = mediaInfo.mediaFileName;
      key = row.key;
      message = row.payload;
    }
    if (!ports.downloadMedia)
      throw new NovedadesReaderError(
        'NOVEDADES_MEDIA_UNSUPPORTED',
        'This connector build cannot download Novedades media',
        501
      );
    let result: Awaited<ReturnType<NonNullable<NovedadesPorts['downloadMedia']>>>;
    try {
      result = await ports.downloadMedia({ kind, jid, messageId, key, message });
    } catch (error) {
      if (error instanceof NovedadesReaderError) throw error;
      throw new NovedadesReaderError(
        'NOVEDADES_MEDIA_FAILED',
        'The media download failed; nothing was published to WhatsApp',
        502
      );
    }
    if (!result?.buffer?.length)
      throw new NovedadesReaderError(
        'NOVEDADES_MEDIA_UNAVAILABLE',
        'WhatsApp returned no media bytes',
        404
      );
    if (result.buffer.length > NOVEDADES_MEDIA_MAX_BYTES)
      throw new NovedadesReaderError(
        'NOVEDADES_MEDIA_TOO_LARGE',
        `Media is ${result.buffer.length} bytes; the cap is ${NOVEDADES_MEDIA_MAX_BYTES}`,
        413
      );
    return {
      bytes: result.buffer,
      mimeType: result.mimeType || storedMimetype || 'application/octet-stream',
      fileName: result.fileName || storedFileName,
    };
  }

  return { statusAuthors, statuses, channels, posts, post, media, coverage };
}

/* --------------------------------------------------------------------------
 * Range support for the binary media response
 * ------------------------------------------------------------------------ */

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Single-range parser for `Range: bytes=a-b` (suffix ranges included). Returns
 * undefined for a missing, multi-range, or unparseable header so the caller
 * serves the whole body instead of guessing.
 */
export function parseByteRange(header: unknown, size: number): ByteRange | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size <= 0) return undefined;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return undefined;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined;
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= size) return undefined;
  const end = rawEnd === '' ? size - 1 : Math.min(size - 1, Number(rawEnd));
  if (!Number.isSafeInteger(end) || end < start) return undefined;
  return { start, end };
}
