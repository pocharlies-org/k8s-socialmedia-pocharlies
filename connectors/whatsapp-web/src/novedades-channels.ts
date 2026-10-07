/**
 * Channel (newsletter) lookup and follow/unfollow for the Novedades panel.
 *
 * Provider ground truth, verified against the installed Baileys 7.0.0-rc13
 * (`lib/Socket/newsletter.js`):
 *  - `newsletterMetadata(type, key)` resolves exactly one channel, addressed
 *    either by bare `@newsletter` JID or by invite code. rc13 has no global
 *    channel directory and no search, so an unknown address must answer 404 —
 *    absence here is "this one channel was not found", never "no more
 *    channels exist".
 *  - `newsletterFollow`/`newsletterUnfollow` return `unknown`: the WMex body
 *    proves nothing by itself. The only honest confirmation of a state change
 *    is the viewer-role read-back from `newsletterMetadata`, so every write
 *    is checked that way and an unconfirmed read-back is reported as an
 *    uncertain outcome, never retried automatically.
 *  - rc13 answers metadata with nested `thread_metadata`/`viewer_metadata`
 *    shapes; the invite code and picture mediaKey/directPath in it are
 *    private handles, so only the whitelisted public fields leave here.
 *
 * Account isolation is structural: the service is bound to one live socket,
 * the viewer role is that socket's own relation to the channel, and nothing
 * is cached across sockets or accounts.
 */
import { NovedadesReaderError } from './novedades-reader';
import { connectorAccount } from './db-writer';

/** Bare channel address accepted by `newsletterMetadata('jid', …)`. */
const CHANNEL_JID = /^\d{1,20}@newsletter$/;
/** Official share links; the path segment is the invite code. */
const CHANNEL_LINK =
  /^https?:\/\/(?:www\.)?(?:whatsapp\.com|wa\.me)\/channel\/([A-Za-z0-9_-]{1,128})\/?$/i;

export class ChannelLookupError extends NovedadesReaderError {
  /** A lookup fault or refusal is settled knowledge, never an uncertain write. */
  readonly outcomeUncertain?: undefined;
}

/** The follow/unfollow was dispatched but its landing cannot be proven. */
export class ChannelSubscriptionUncertainError extends Error {
  readonly outcomeUncertain = true;
  constructor() {
    super(
      'WhatsApp did not confirm the channel subscription change; the outcome is uncertain and will not be retried automatically'
    );
    this.name = 'ChannelSubscriptionUncertainError';
  }
}

export interface ChannelQueryKey {
  type: 'jid' | 'invite';
  key: string;
}

export interface PublicNovedadesChannel {
  id: string;
  name: string;
  description: string | null;
  role: string | null;
  subscribed: boolean | null;
  verification: string | null;
  subscribers: number | null;
  createdAt: string | null;
  muted: boolean | null;
  /** Avatars need the private directPath; the viewer shows initials instead. */
  avatarAvailable: false;
  avatarUrl: null;
}

/** Provider surface actually used; methods may be absent on older installs. */
export interface ChannelSocketLike {
  newsletterMetadata?: (type: 'invite' | 'jid', key: string) => Promise<unknown>;
  newsletterFollow?: (jid: string) => Promise<unknown>;
  newsletterUnfollow?: (jid: string) => Promise<unknown>;
}

/**
 * A socket, or a factory that resolves the socket of the moment. The
 * controller keeps one service per account session, so the factory keeps a
 * reconnect from leaving a dead socket behind.
 */
export type ChannelSocketSource =
  ChannelSocketLike | null | undefined | (() => ChannelSocketLike | null | undefined);

export function parseChannelQuery(value: unknown): ChannelQueryKey {
  if (typeof value !== 'string') throw invalidChannelInput();
  const text = value.trim();
  if (!text || text.length > 2048) throw invalidChannelInput();
  if (CHANNEL_JID.test(text)) return { type: 'jid', key: text };
  const link = CHANNEL_LINK.exec(text);
  if (link) return { type: 'invite', key: link[1] };
  throw invalidChannelInput();
}

function invalidChannelInput(): ChannelLookupError {
  return new ChannelLookupError(
    'NOVEDADES_CHANNEL_INPUT_INVALID',
    'A bare @newsletter JID or a whatsapp.com/channel link is required',
    400
  );
}

function providerFault(message: string): ChannelLookupError {
  return new ChannelLookupError('INVALID_PROVIDER_RESPONSE', message, 502);
}

function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, 4096) : null;
}

function lower(value: unknown): string | null {
  const text = optionalText(value);
  return text ? text.toLowerCase() : null;
}

function verification(value: unknown): string | null {
  const text = lower(value);
  if (text === 'verified') return 'verified';
  if (text === 'unverified') return 'unverified';
  return null;
}

/**
 * Maps the two shapes the provider can answer with: the nested rc13 WMex
 * payload (`thread_metadata.name.text`, `subscribers_count` as string) and
 * the nominal flat `NewsletterMetadata` from Mex.d.ts. Anything else is an
 * incomplete answer, not a channel with missing fields.
 */
export function publicChannelFromMetadata(metadata: unknown): PublicNovedadesChannel {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw providerFault('WhatsApp returned no channel metadata');
  const meta = metadata as Record<string, unknown>;
  if (typeof meta.id !== 'string' || !CHANNEL_JID.test(meta.id))
    throw providerFault('WhatsApp returned metadata for a non-channel address');
  const thread =
    meta.thread_metadata && typeof meta.thread_metadata === 'object'
      ? (meta.thread_metadata as Record<string, unknown>)
      : {};
  if (
    meta.thread_metadata !== undefined &&
    (typeof meta.thread_metadata !== 'object' || meta.thread_metadata === null)
  )
    throw providerFault('WhatsApp returned incomplete channel metadata');
  if (thread.name !== undefined) {
    if (!thread.name || typeof thread.name !== 'object' || !('text' in thread.name))
      throw providerFault('WhatsApp returned incomplete channel metadata');
  }
  const name =
    (thread.name && typeof thread.name === 'object'
      ? optionalText((thread.name as Record<string, unknown>).text)
      : null) ??
    optionalText(meta.name) ??
    '';
  const description =
    (thread.description && typeof thread.description === 'object'
      ? optionalText((thread.description as Record<string, unknown>).text)
      : null) ?? optionalText(meta.description);
  const rawCount = thread.subscribers_count ?? meta.subscribers;
  const subscribers =
    typeof rawCount === 'number' && Number.isSafeInteger(rawCount) && rawCount >= 0
      ? rawCount
      : typeof rawCount === 'string' && /^\d+$/.test(rawCount)
        ? Number(rawCount)
        : null;
  const creationSeconds = thread.creation_time ?? meta.creation_time;
  const creationMs =
    (typeof creationSeconds === 'number' || typeof creationSeconds === 'string') &&
    /^\d{1,12}$/.test(String(creationSeconds))
      ? Number(creationSeconds) * 1000
      : null;
  const viewer =
    meta.viewer_metadata && typeof meta.viewer_metadata === 'object'
      ? (meta.viewer_metadata as Record<string, unknown>)
      : null;
  const role = lower(viewer?.role);
  const subscribed =
    role === null
      ? null
      : ['owner', 'admin', 'subscriber'].includes(role)
        ? true
        : role === 'guest'
          ? false
          : null;
  const mute = lower(viewer?.mute ?? meta.mute_state);
  return {
    id: meta.id,
    name,
    description,
    role,
    subscribed,
    verification: verification(thread.verification ?? meta.verification),
    subscribers,
    createdAt: creationMs === null ? null : new Date(creationMs).toISOString(),
    muted: mute === 'on' ? true : mute === 'off' ? false : null,
    avatarAvailable: false,
    avatarUrl: null,
  };
}

/** The only trustworthy verdict after a follow/unfollow: the viewer's own role. */
export function subscriptionRoleConfirmed(
  action: 'follow' | 'unfollow',
  metadata: unknown
): 'confirmed' | 'uncertain' {
  const meta =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const viewer =
    meta.viewer_metadata && typeof meta.viewer_metadata === 'object'
      ? (meta.viewer_metadata as Record<string, unknown>)
      : null;
  const role = lower(viewer?.role);
  if (action === 'follow')
    return role === 'owner' || role === 'admin' || role === 'subscriber'
      ? 'confirmed'
      : 'uncertain';
  return role === 'guest' ? 'confirmed' : 'uncertain';
}

export interface ChannelLookupResult {
  account: string;
  channel: PublicNovedadesChannel;
  hasMore: false;
  nextCursor: null;
  coverage: {
    source: 'provider-metadata';
    remoteListing: false;
    backfilled: false;
    syncedAt: null;
    reasons: string[];
  };
}

export interface ChannelSubscriptionResult extends ChannelLookupResult {
  action: 'follow' | 'unfollow';
  confirmed: true;
  /** True when the account was already in that state, so nothing was written. */
  unchanged: boolean;
}

/**
 * Bound to one account session; nothing here is shared across accounts. The
 * socket is resolved per call so a reconnect cannot leave a dead handle
 * behind, and subscriptions for one channel are serialized inside the
 * session: two concurrent follow requests must not both pass the pre-read and
 * mutate twice, because the provider gives no idempotency token to lean on.
 */
export class ChannelService {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly socketSource: ChannelSocketSource) {}

  private socket(): ChannelSocketLike | null {
    const source = this.socketSource;
    const resolved = typeof source === 'function' ? source() : source;
    return resolved ?? null;
  }

  /** Chains onto any running mutation of the same channel. */
  private serialize<T>(jid: string, run: () => Promise<T>): Promise<T> {
    const previous = this.inFlight.get(jid);
    const current = previous ? previous.then(run, run) : run();
    const tail = current.then(
      () => undefined,
      () => undefined
    );
    this.inFlight.set(jid, tail);
    void tail.then(() => {
      if (this.inFlight.get(jid) === tail) this.inFlight.delete(jid);
    });
    return current;
  }

  private require(socket: ChannelSocketLike, method: keyof ChannelSocketLike, label: string): void {
    if (typeof socket[method] !== 'function')
      throw new ChannelLookupError(
        'NOVEDADES_CAPABILITY_MISSING',
        `The WhatsApp provider cannot perform this channel ${label} in the installed version`,
        501
      );
  }

  /** Reads one channel and proves the answer is about that channel. */
  private async readChannel(
    socket: ChannelSocketLike,
    jid: string
  ): Promise<{ raw: unknown; result: ChannelLookupResult }> {
    const raw = await socket.newsletterMetadata!('jid', jid);
    const channel = publicChannelFromMetadata(raw);
    if (channel.id !== jid)
      throw providerFault('WhatsApp answered metadata for a different channel');
    return {
      raw,
      result: this.envelope(channel, ['single-channel-lookup', 'viewer-role-readback']),
    };
  }

  private envelope(channel: PublicNovedadesChannel, reasons: string[]): ChannelLookupResult {
    return {
      account: connectorAccount(),
      channel,
      hasMore: false,
      nextCursor: null,
      coverage: {
        source: 'provider-metadata',
        remoteListing: false,
        backfilled: false,
        syncedAt: null,
        reasons,
      },
    };
  }

  async lookup(query: unknown): Promise<ChannelLookupResult> {
    const parsed = parseChannelQuery(query);
    const socket = this.socket();
    if (!socket)
      throw new ChannelLookupError(
        'NOVEDADES_SESSION_DOWN',
        'This WhatsApp session is not connected, so the channel cannot be resolved',
        503
      );
    this.require(socket, 'newsletterMetadata', 'lookup');
    const raw = await socket.newsletterMetadata!(parsed.type, parsed.key);
    if (raw === null || raw === undefined)
      throw new ChannelLookupError(
        'NOVEDADES_CHANNEL_NOT_FOUND',
        'WhatsApp found no channel for this JID or link',
        404
      );
    const channel = publicChannelFromMetadata(raw);
    // An invite code has no id to compare against, but a JID lookup that
    // answers with another channel is a provider fault, never a free result.
    if (parsed.type === 'jid' && channel.id !== parsed.key)
      throw providerFault('WhatsApp answered metadata for a different channel');
    return this.envelope(channel, ['single-channel-lookup', 'no-global-channel-directory-in-rc13']);
  }

  /**
   * One write at most per call: the pre-read skips a redundant mutation only
   * when it proves the account already holds that state, and it must name the
   * requested channel before anything is mutated. After a real write the
   * viewer role must say so, or the outcome stays uncertain and is never
   * retried automatically.
   */
  async subscription(input: unknown): Promise<ChannelSubscriptionResult> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new ChannelLookupError(
        'INVALID_NOVEDADES_INPUT',
        'A subscription object is required',
        400
      );
    const body = input as Record<string, unknown>;
    const jid = typeof body.jid === 'string' ? body.jid.trim() : '';
    if (!CHANNEL_JID.test(jid))
      throw new ChannelLookupError(
        'NOVEDADES_ID_INVALID',
        'A bare @newsletter channel JID is required',
        400
      );
    const action = body.action;
    if (action !== 'follow' && action !== 'unfollow')
      throw new ChannelLookupError(
        'INVALID_NOVEDADES_INPUT',
        'action must be follow or unfollow',
        400
      );
    return this.serialize(jid, () => this.applySubscription(jid, action));
  }

  private async applySubscription(
    jid: string,
    action: 'follow' | 'unfollow'
  ): Promise<ChannelSubscriptionResult> {
    const socket = this.socket();
    if (!socket)
      throw new ChannelLookupError(
        'NOVEDADES_SESSION_DOWN',
        'This WhatsApp session is not connected, so the channel subscription cannot change',
        503
      );
    this.require(socket, 'newsletterMetadata', 'lookup');
    this.require(socket, action === 'follow' ? 'newsletterFollow' : 'newsletterUnfollow', action);

    const before = await this.readChannel(socket, jid);
    if (before.result.channel.subscribed === (action === 'follow'))
      return { ...before.result, action, confirmed: true, unchanged: true };

    try {
      if (action === 'follow') await socket.newsletterFollow!(jid);
      else await socket.newsletterUnfollow!(jid);
    } catch (error) {
      // A thrown WMex error cannot prove the mutation never landed: the
      // request may have reached WhatsApp before the answer was lost.
      if (error instanceof ChannelLookupError) throw error;
      throw new ChannelSubscriptionUncertainError();
    }

    let after: { raw: unknown; result: ChannelLookupResult };
    try {
      after = await this.readChannel(socket, jid);
    } catch {
      // The write may have landed even though the confirmation read failed, so
      // the outcome is uncertain. Reading again would just guess twice.
      throw new ChannelSubscriptionUncertainError();
    }
    if (subscriptionRoleConfirmed(action, after.raw) !== 'confirmed')
      throw new ChannelSubscriptionUncertainError();
    return { ...after.result, action, confirmed: true, unchanged: false };
  }
}
