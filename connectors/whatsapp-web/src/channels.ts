/**
 * WhatsApp channels (newsletters, fase 3 follow-up): look one up by its jid,
 * share link or invite code; list the channels this account follows; follow /
 * unfollow and mute / unmute one. Ported from the NAS fork
 * (novedades-channels.ts: the address parser, the two metadata shapes, the
 * viewer-role read-back as the only proof of a write, one write per channel
 * at a time) and adapted to prod: ids in the signed body, the sending gate on
 * writes, `{error, failureClass}`. The channel's posts are not read or stored
 * here (a later PR).
 *
 * What Baileys 7.0.0-rc13 does (Socket/newsletter.js, Socket/mex.js):
 *  - `newsletterMetadata(type: 'jid' | 'invite', key)`: one WMex query for
 *    one channel; the answer is the raw `{id, state, thread_metadata:
 *    {name: {text}, description: {text}, subscribers_count, verification,
 *    creation_time, invite, picture…}, viewer_metadata: {role, mute}}`, or null.
 *  - `newsletterFollow` / `newsletterUnfollow` / `newsletterMute` /
 *    `newsletterUnmute(jid)`: WMex mutations whose answer proves nothing; a
 *    GraphQL refusal throws a Boom with the error's code.
 *  - There is NO query for the channels the account follows (WA Web's
 *    "subscribed newsletters" query is not in rc13's QueryIds), no directory
 *    and no search. So the list is built from the channels this connector has
 *    seen — chats of the history sync, conversations with channel posts,
 *    lookups and follows of this process — each confirmed by its own metadata
 *    (viewer role): it may miss channels, never lists one not followed.
 *
 * Nothing is persisted.
 */
import { getPool, stripAccountKey } from './db-writer';
import { MessageMutationError, whatsappAccountId } from './message-mutations';

export type ChannelSubscriptionAction = 'follow' | 'unfollow' | 'mute' | 'unmute';

const ACTIONS: ChannelSubscriptionAction[] = ['follow', 'unfollow', 'mute', 'unmute'];

/** A channel request refused or failed, in the house shape (status + failureClass). */
export class ChannelActionError extends MessageMutationError {
  constructor(message: string, status: number, failureClass: string, code?: string) {
    super(message, status, failureClass, code);
    this.name = 'ChannelActionError';
  }
}

function invalid(message: string): ChannelActionError {
  return new ChannelActionError(message, 400, 'invalid_request');
}

/** Bare channel jid (`…@newsletter`). */
const CHANNEL_JID = /^\d{1,24}@newsletter$/;
/** Official share links; the path segment is the invite code. */
const CHANNEL_LINK =
  /^(?:https?:\/\/)?(?:www\.)?(?:whatsapp\.com|wa\.me)\/channel\/([A-Za-z0-9_-]{6,128})\/?(?:[?#].*)?$/i;
/** A bare invite code (what follows /channel/ in the link): letters and digits. */
const INVITE_CODE = /^[A-Za-z0-9_-]{6,128}$/;

/** Raw jid of a channel (`…@newsletter`, account prefix stripped), or null. */
export function normalizeChannelJid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const bare = stripAccountKey(value.trim());
  return CHANNEL_JID.test(bare) ? bare : null;
}

/** The channel jid of a request, or 400. */
export function parseChannelJid(value: unknown, field = 'channelId'): string {
  const raw = normalizeChannelJid(value);
  if (!raw) {
    const given = typeof value === 'string' ? value.trim().slice(0, 80) : '';
    throw invalid(
      `${field} must be a channel jid (…@newsletter)${given ? `; ${given} is not one` : ''}`
    );
  }
  return raw;
}

export interface ChannelQuery {
  type: 'jid' | 'invite';
  key: string;
}

/**
 * What to look up: a channel jid (`…@newsletter`, or only its digits), a
 * share link (`https://whatsapp.com/channel/<code>`) or the bare invite code.
 */
export function parseChannelQuery(value: unknown): ChannelQuery {
  const text = typeof value === 'string' ? stripAccountKey(value.trim()) : '';
  if (!text || text.length > 2048) {
    throw invalid(
      'channel must be a channel jid (…@newsletter), a whatsapp.com/channel link or its code'
    );
  }
  if (CHANNEL_JID.test(text)) return { type: 'jid', key: text };
  if (/^\d{6,24}$/.test(text)) return { type: 'jid', key: `${text}@newsletter` };
  const link = CHANNEL_LINK.exec(text);
  if (link) return { type: 'invite', key: link[1] };
  if (INVITE_CODE.test(text)) return { type: 'invite', key: text };
  throw invalid(
    `Not a channel jid (…@newsletter), a whatsapp.com/channel link or an invite code: ${text.slice(0, 80)}`
  );
}

export function parseChannelSubscriptionAction(value: unknown): ChannelSubscriptionAction {
  const action = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!(ACTIONS as string[]).includes(action)) {
    throw invalid('action must be one of follow, unfollow, mute, unmute');
  }
  return action as ChannelSubscriptionAction;
}

// ---------------------------------------------------------------------------
// What the API returns about a channel
// ---------------------------------------------------------------------------

export type ChannelRole = 'owner' | 'admin' | 'subscriber' | 'guest';

export interface ChannelView {
  /** `…@newsletter`. */
  channelId: string;
  name: string;
  description: string | null;
  subscribers: number | null;
  /** WhatsApp's green check: 'verified' | 'unverified'; null when not given. */
  verification: 'verified' | 'unverified' | null;
  createdAt: string | null;
  /** The public share link (channels are public), null when not given. */
  inviteLink: string | null;
  /** This account's relation: owner, admin, subscriber (follows) or guest. */
  role: ChannelRole | null;
  /** owner / admin / subscriber = true, guest = false, unknown = null. */
  following: boolean | null;
  /** Our notifications for it; null when WhatsApp did not say. */
  muted: boolean | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean ? clean.slice(0, 4096) : null;
}

function nested(value: unknown): string | null {
  return text(record(value)?.text) ?? text(value);
}

function lower(value: unknown): string | null {
  return text(value)?.toLowerCase() ?? null;
}

function roleOf(value: unknown): ChannelRole | null {
  const role = lower(value);
  return role === 'owner' || role === 'admin' || role === 'subscriber' || role === 'guest'
    ? role
    : null;
}

/** The viewer block of a metadata answer (role, mute), whatever its shape. */
function viewerOf(meta: Record<string, unknown>): {
  role: ChannelRole | null;
  muted: boolean | null;
} {
  const viewer = record(meta.viewer_metadata);
  const role = roleOf(viewer?.role ?? meta.role);
  const mute = lower(viewer?.mute ?? meta.mute_state ?? meta.mute);
  return { role, muted: mute === 'on' ? true : mute === 'off' ? false : null };
}

/**
 * The public view of a newsletterMetadata answer: rc13's raw WMex shape
 * (`thread_metadata.name.text`, `subscribers_count` as a string) or the flat
 * NewsletterMetadata of its types. Only these fields leave: the picture's
 * media handles do not. Anything that is not a channel → 502.
 */
export function channelView(metadata: unknown): ChannelView {
  const meta = record(metadata);
  if (!meta || typeof meta.id !== 'string' || !CHANNEL_JID.test(meta.id)) {
    throw new ChannelActionError(
      'WhatsApp returned no usable channel metadata',
      502,
      'provider_invalid_response'
    );
  }
  const thread = record(meta.thread_metadata) || {};
  const count = thread.subscribers_count ?? meta.subscribers;
  const subscribers =
    typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
      ? count
      : typeof count === 'string' && /^\d{1,15}$/.test(count)
        ? Number(count)
        : null;
  const creation = thread.creation_time ?? meta.creation_time;
  const seconds = /^\d{1,12}$/.test(String(creation ?? '')) ? Number(creation) : 0;
  const verification = lower(thread.verification ?? meta.verification);
  const invite = text(thread.invite ?? meta.invite);
  const viewer = viewerOf(meta);
  return {
    channelId: meta.id,
    name: nested(thread.name) ?? text(meta.name) ?? '',
    description: nested(thread.description) ?? text(meta.description),
    subscribers,
    verification:
      verification === 'verified' || verification === 'unverified' ? verification : null,
    createdAt: seconds > 0 ? new Date(seconds * 1000).toISOString() : null,
    inviteLink:
      invite && INVITE_CODE.test(invite) ? `https://whatsapp.com/channel/${invite}` : null,
    role: viewer.role,
    following: viewer.role === null ? null : viewer.role !== 'guest',
    muted: viewer.muted,
  };
}

/** Whether the channel already is in the state an action asks for (null = unknown). */
export function channelStateMatches(
  view: Pick<ChannelView, 'following' | 'muted'>,
  action: ChannelSubscriptionAction
): boolean | null {
  switch (action) {
    case 'follow':
      return view.following;
    case 'unfollow':
      return view.following === null ? null : !view.following;
    case 'mute':
      return view.muted;
    case 'unmute':
      return view.muted === null ? null : !view.muted;
  }
}

/** Channels checked per GET /channels (one metadata query each). */
export const CHANNELS_LIST_MAX = 100;

/**
 * Channel jids this account has a conversation for (channel posts the
 * connector ingested): candidates of the followed list. Ingest only.
 */
export async function knownChannelConversations(): Promise<string[]> {
  const result = await getPool().query(
    `SELECT COALESCE(external_id, id) AS jid
       FROM conversations
      WHERE account_id = $1 AND merged_into IS NULL
        AND (external_id LIKE '%@newsletter' OR id LIKE '%@newsletter')
      ORDER BY last_message_at DESC NULLS LAST
      LIMIT $2`,
    [whatsappAccountId(), CHANNELS_LIST_MAX]
  );
  return result.rows
    .map(row => normalizeChannelJid(String(row.jid ?? '')))
    .filter((jid): jid is string => !!jid);
}

// ---------------------------------------------------------------------------
// One write per channel at a time
// ---------------------------------------------------------------------------

/**
 * Runs the calls of one key one after another: two concurrent follows of a
 * channel must not both pass the pre-read and write twice (WhatsApp gives no
 * idempotency token for these mutations).
 */
export class KeyedSerializer {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key);
    const current = previous ? previous.then(task, task) : task();
    const tail = current.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return current;
  }
}
