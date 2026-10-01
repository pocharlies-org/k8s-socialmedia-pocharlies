/**
 * Own WhatsApp account profile: display name, "about" text and profile photo.
 *
 * Verified against the installed `@whiskeysockets/baileys@7.0.0-rc13` runtime
 * (not the `.d.ts` files, which already lied once about the community parser):
 *   - `updateProfileName(name)` -> `chatModify({ pushNameSetting }, '')` ->
 *     `appPatch()`, i.e. an encrypted app-state patch. It needs
 *     `creds.myAppStateKeyId` and it does NOT refresh `creds.me.name` locally,
 *     so a successful call means "accepted", not "confirmed".
 *   - `updateProfileStatus(text)` -> IQ `type=set xmlns=status`. Readable back
 *     with `fetchStatus(jid)` (USync), which answers `{ status, setAt }`.
 *   - `updateProfilePicture(jid, buffer)` / `removeProfilePicture(jid)` -> IQ
 *     `w:profile:picture`. Setting one resizes/re-encodes through
 *     `generateProfilePicture()`, which needs `sharp` or `jimp` at runtime and
 *     throws Boom('No image processing library available') without them.
 *   - `profilePictureUrl(jid, type)` reads a picture; the repository patch keeps
 *     it working for the account's own JID (no tctoken for self).
 *
 * Confirmation discipline: a mutation is `accepted` when the provider took the
 * write and `confirmed` only when a readback proves the requested end state.
 * For a photo that proof is the picture identity (the CDN path of the stored
 * picture, without its rotating access token): "a photo exists" is not proof
 * that the new one is live, because an unchanged account also has a photo.
 *
 * WhatsApp limits (checked against published WhatsApp profile limits): display
 * name 25 characters, about 139 characters.
 *
 * This module is deliberately provider-agnostic: `BaileysClient` supplies the
 * socket-backed `OwnProfileProvider`, and every capability is discovered from
 * the methods that actually exist at runtime instead of being assumed.
 */

export const PROFILE_NAME_MAX_CHARS = 25;
export const PROFILE_ABOUT_MAX_CHARS = 139;
/** Decoded photo ceiling, kept equal to the app's `/api/upload` body limit. */
export const PROFILE_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
/** Base64 string ceiling, kept equal to the app's `/api/upload` limit. */
export const PROFILE_PHOTO_MAX_BASE64_CHARS = 16 * 1024 * 1024;
export const PROFILE_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

const PROVIDER_READ_TIMEOUT_MS = 9_000;
const PROVIDER_WRITE_TIMEOUT_MS = 20_000;
const NAME_READBACK_ATTEMPTS = 4;
const NAME_READBACK_INTERVAL_MS = 400;

export type ProfileErrorCode =
  | 'INVALID_PROFILE_INPUT'
  | 'PHOTO_TOO_LARGE'
  | 'PROFILE_DISCONNECTED'
  | 'PROFILE_PROVIDER_UNAVAILABLE'
  | 'PROFILE_APP_STATE_UNAVAILABLE'
  | 'PROFILE_PICTURE_PROCESSING_UNAVAILABLE'
  | 'PROFILE_UPSTREAM_REJECTED'
  | 'PROFILE_UPSTREAM_TIMEOUT';

export class ProfileError extends Error {
  readonly status: number;

  constructor(
    readonly code: ProfileErrorCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ProfileError';
    this.status =
      code === 'INVALID_PROFILE_INPUT'
        ? 400
        : code === 'PHOTO_TOO_LARGE'
          ? 413
          : code === 'PROFILE_APP_STATE_UNAVAILABLE'
            ? 409
            : code === 'PROFILE_UPSTREAM_TIMEOUT'
              ? 504
              : code === 'PROFILE_UPSTREAM_REJECTED'
                ? 502
                : code === 'PROFILE_PROVIDER_UNAVAILABLE' ||
                    code === 'PROFILE_PICTURE_PROCESSING_UNAVAILABLE'
                  ? 501
                  : 503;
  }
}

/**
 * The socket-backed surface `BaileysClient` provides. Every writer is optional
 * on purpose: a missing method means the installed provider cannot do it, and
 * the API must answer 501 rather than crash on an assumed API.
 */
export interface OwnProfileProvider {
  isConnected: () => boolean;
  /** Bare user JID of the connected account (`@s.whatsapp.net` or `@lid`). */
  ownJid: () => string | null;
  /** Display name Baileys currently holds locally (`creds.me.name`). */
  accountName: () => string | null;
  updateProfileName?: (name: string) => Promise<unknown>;
  updateProfileStatus?: (status: string) => Promise<unknown>;
  updateProfilePicture?: (jid: string, image: Buffer) => Promise<unknown>;
  removeProfilePicture?: (jid: string) => Promise<unknown>;
  /** Raw USync `status` protocol result: a list of `{ status, setAt }`. */
  fetchStatus?: (jid: string) => Promise<unknown>;
  /**
   * Stable identity of the account's current picture, or `null` when the
   * account has none. Lookups that cannot answer must throw or return
   * something other than a string/null, otherwise an outage reads as "no
   * photo".
   */
  profilePictureIdentity?: (jid: string) => Promise<string | null>;
}

export interface ProfileIo {
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ProfileFieldOutcome {
  requested: string;
  current: string | null;
  /** The provider accepted the write (IQ/app-state patch resolved). */
  accepted: boolean;
  /** The readback proved the requested value. */
  confirmed: boolean;
  /** Why the confirmation is what it is, for honest UI copy. */
  reason: string;
}

export interface ProfilePhotoOutcome {
  available: boolean;
  accepted: boolean;
  confirmed: boolean;
  reason: string;
}

export interface OwnProfile {
  jid: string;
  phone: string | null;
  name: string | null;
  about: string | null;
  aboutSetAt: string | null;
  photo: { available: boolean };
}

export interface ProfileCapabilities {
  name: boolean;
  about: boolean;
  photo: boolean;
  photoRemove: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function withTimeout<T>(task: () => Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ProfileError('PROFILE_UPSTREAM_TIMEOUT', `WhatsApp ${label} timed out`, {
            timeoutMs,
          })
        ),
      timeoutMs
    );
  });
  return Promise.race([(async (): Promise<T> => task())(), guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function providerStatusCode(error: unknown): number | undefined {
  const output = (error as { output?: { statusCode?: unknown } })?.output;
  if (typeof output?.statusCode === 'number') return output.statusCode;
  const direct = (error as { statusCode?: unknown })?.statusCode;
  return typeof direct === 'number' ? direct : undefined;
}

/** Translate provider failures into honest HTTP-facing codes. */
export function mapProfileProviderError(error: unknown, label: string): ProfileError {
  if (error instanceof ProfileError) return error;
  const statusCode = providerStatusCode(error);
  const message = error instanceof Error ? error.message : String(error);
  if (/no image processing library/i.test(message)) {
    return new ProfileError(
      'PROFILE_PICTURE_PROCESSING_UNAVAILABLE',
      'The connector platform has no image processing library, so the profile photo cannot be re-encoded',
      { label, providerMessage: message }
    );
  }
  if (/app state key not present/i.test(message)) {
    return new ProfileError(
      'PROFILE_APP_STATE_UNAVAILABLE',
      'WhatsApp app-state key is unavailable for this session; retry after the session finishes syncing',
      { label }
    );
  }
  if (/timed out|timeout/i.test(message) || statusCode === 408) {
    return new ProfileError('PROFILE_UPSTREAM_TIMEOUT', `WhatsApp ${label} timed out`, {
      label,
      ...(typeof statusCode === 'number' ? { statusCode } : {}),
    });
  }
  return new ProfileError('PROFILE_UPSTREAM_REJECTED', `WhatsApp rejected ${label}`, {
    label,
    ...(typeof statusCode === 'number' ? { statusCode } : {}),
    providerMessage: message,
  });
}

function requireOwnJid(provider: OwnProfileProvider): string {
  if (!provider.isConnected()) {
    throw new ProfileError(
      'PROFILE_DISCONNECTED',
      'WhatsApp account is not connected; the profile was not changed'
    );
  }
  const jid = provider.ownJid();
  if (!jid) {
    throw new ProfileError(
      'PROFILE_DISCONNECTED',
      'WhatsApp account identity is unavailable; the profile was not changed'
    );
  }
  return jid;
}

function requireMethod<K extends keyof OwnProfileProvider>(
  provider: OwnProfileProvider,
  method: K,
  label: string
): NonNullable<OwnProfileProvider[K]> {
  const value = provider[method];
  if (typeof value !== 'function') {
    throw new ProfileError(
      'PROFILE_PROVIDER_UNAVAILABLE',
      `The installed WhatsApp provider cannot ${label}`,
      { method }
    );
  }
  return value as NonNullable<OwnProfileProvider[K]>;
}

export function profileCapabilities(provider: OwnProfileProvider): ProfileCapabilities {
  const photoWriter = typeof provider.updateProfilePicture === 'function';
  return {
    name: typeof provider.updateProfileName === 'function',
    about: typeof provider.updateProfileStatus === 'function',
    photo: photoWriter,
    photoRemove: photoWriter && typeof provider.removeProfilePicture === 'function',
  };
}

/**
 * The phone number of the account, and only when its JID actually is one.
 * A `@lid` address is an alias without a public number, and a device suffix
 * (`34600123456:8@s.whatsapp.net`) must never be folded into the digits.
 */
export function phoneFromProfileJid(jid: string): string | null {
  const raw = (jid || '').trim();
  if (!/@(?:s\.whatsapp\.net|c\.us)$/.test(raw)) return null;
  const user = (raw.split('@')[0] || '').split(':')[0] || '';
  const digits = user.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/** Single-line, trimmed text that fits the WhatsApp profile fields. */
function cleanProfileText(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== 'string') {
    throw new ProfileError('INVALID_PROFILE_INPUT', `${label} must be a string`);
  }
  const text = value
    // Control characters, newlines included, are flattened on purpose: the
    // provider keeps a single-line field, so what is written must be what a
    // readback can find again.
    // eslint-disable-next-line no-control-regex -- stripping them is the point.
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/[\s]{2,}/g, ' ')
    .trim();
  if (text.length > maxChars) {
    throw new ProfileError('INVALID_PROFILE_INPUT', `${label} exceeds ${maxChars} characters`, {
      maxChars,
      received: text.length,
    });
  }
  return text;
}

export function normalizeProfileName(value: unknown): string {
  const text = cleanProfileText(value, 'Profile name', PROFILE_NAME_MAX_CHARS);
  if (!text) {
    throw new ProfileError('INVALID_PROFILE_INPUT', 'Profile name cannot be empty', {
      maxChars: PROFILE_NAME_MAX_CHARS,
    });
  }
  return text;
}

/** An empty about is a real value: it clears the About line. */
export function normalizeProfileAbout(value: unknown): string {
  return cleanProfileText(value, 'Profile about', PROFILE_ABOUT_MAX_CHARS);
}

type PhotoSignature = {
  mime: (typeof PROFILE_PHOTO_MIME_TYPES)[number];
  test: (bytes: Buffer) => boolean;
};

const PHOTO_SIGNATURES: PhotoSignature[] = [
  {
    mime: 'image/jpeg',
    test: bytes => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  {
    mime: 'image/png',
    test: bytes =>
      bytes.length > 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a,
  },
  {
    mime: 'image/webp',
    test: bytes =>
      bytes.length > 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

/**
 * Decode a base64 photo the same way the app's `/api/upload` does, and reject
 * anything the provider could not encode. No URL is ever fetched here, so this
 * endpoint cannot be pointed at an internal address.
 */
export function decodeProfilePhoto(input: { imageBase64?: unknown; mimeType?: unknown }): {
  bytes: Buffer;
  mimeType: string;
} {
  const raw = input.imageBase64;
  if (typeof raw !== 'string' || !raw) {
    throw new ProfileError('INVALID_PROFILE_INPUT', 'imageBase64 is required');
  }
  const base64 = /^data:/i.test(raw) && raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  // Cheap caps first: a megabyte payload must never be scanned twice.
  if (!base64.length) throw new ProfileError('INVALID_PROFILE_INPUT', 'imageBase64 is required');
  if (base64.length > PROFILE_PHOTO_MAX_BASE64_CHARS) {
    throw new ProfileError('PHOTO_TOO_LARGE', 'Profile photo is too large', {
      maxChars: PROFILE_PHOTO_MAX_BASE64_CHARS,
      received: base64.length,
    });
  }
  const padding = base64.length - base64.replace(/=+$/, '').length;
  const body = base64.slice(0, base64.length - padding);
  // A backtracking base64 regex overflows the stack on megabyte payloads, so
  // the shape is checked with linear scans.
  if (
    base64.length % 4 !== 0 ||
    padding > 2 ||
    !body.length ||
    body.length % 4 === 1 ||
    /[^A-Za-z0-9+/]/.test(body)
  ) {
    throw new ProfileError('INVALID_PROFILE_INPUT', 'Profile photo is not valid base64');
  }
  const declared =
    typeof input.mimeType === 'string' ? input.mimeType.split(';')[0].trim().toLowerCase() : '';
  if (!PROFILE_PHOTO_MIME_TYPES.includes(declared as (typeof PROFILE_PHOTO_MIME_TYPES)[number])) {
    throw new ProfileError('INVALID_PROFILE_INPUT', 'Profile photo must be JPEG, PNG or WebP', {
      allowed: PROFILE_PHOTO_MIME_TYPES,
      received: declared || null,
    });
  }
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length) throw new ProfileError('INVALID_PROFILE_INPUT', 'Profile photo is empty');
  if (bytes.length > PROFILE_PHOTO_MAX_BYTES) {
    throw new ProfileError('PHOTO_TOO_LARGE', 'Profile photo exceeds 8 MB', {
      maxBytes: PROFILE_PHOTO_MAX_BYTES,
      received: bytes.length,
    });
  }
  const detected = PHOTO_SIGNATURES.find(entry => entry.test(bytes));
  if (!detected || detected.mime !== declared) {
    throw new ProfileError(
      'INVALID_PROFILE_INPUT',
      'Profile photo content does not match its media type',
      { declared, detected: detected?.mime || null }
    );
  }
  return { bytes, mimeType: declared };
}

export interface StatusReadResult {
  about: string | null;
  setAt: string | null;
  /**
   * True only when a `status` field of a recognised shape was actually read.
   * An unrecognised payload must never be reported as an empty About, or a
   * cleared About would look confirmed after a malformed answer.
   */
  recognized: boolean;
}

/** Baileys returns `setAt` as a Date; older builds used epoch seconds. */
function parseSetAt(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = new Date(value > 1e12 ? value : value * 1000);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

function readStatusField(container: Record<string, unknown>): {
  about: string | null;
  setAt: string | null;
  recognized: boolean;
} | null {
  if (!('status' in container)) return null;
  const value = container.status;
  if (value === null || typeof value === 'string') {
    return {
      about: (typeof value === 'string' ? value.trim() : null) || null,
      setAt: parseSetAt(container.setAt),
      recognized: true,
    };
  }
  if (value && typeof value === 'object') {
    const nested = value as Record<string, unknown>;
    if (!('status' in nested)) return null;
    if (nested.status !== null && typeof nested.status !== 'string') return null;
    const text = typeof nested.status === 'string' ? nested.status.trim() : null;
    return { about: text || null, setAt: parseSetAt(nested.setAt), recognized: true };
  }
  return null;
}

/**
 * Normalise the raw USync `status` result.
 *
 * In the installed 7.0.0-rc13, `fetchStatus` returns `result.list` built by
 * `USyncQuery.parse`, whose entries are `{ [protocolName]: parser(node), id }`,
 * i.e. `{ id, status: { status, setAt } }` with the parser output nested under
 * the protocol name. A flat `{ status, setAt }` entry is also accepted for
 * other builds, but an unrecognised shape is never reported as an empty About.
 */
export function normalizeStatusReadResult(raw: unknown): StatusReadResult {
  const empty: StatusReadResult = { about: null, setAt: null, recognized: false };
  const entries = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const parsed = readStatusField(entry as Record<string, unknown>);
    if (parsed) return parsed;
  }
  return empty;
}

interface AboutRead {
  about: string | null;
  setAt: string | null;
  known: boolean;
  timedOut?: boolean;
}

async function readAbout(
  provider: OwnProfileProvider,
  jid: string,
  timeoutMs: number
): Promise<AboutRead> {
  if (typeof provider.fetchStatus !== 'function') return { about: null, setAt: null, known: false };
  const raw = await withTimeout(
    () => Promise.resolve(provider.fetchStatus!(jid)),
    'about lookup',
    timeoutMs
  );
  const parsed = normalizeStatusReadResult(raw);
  return { about: parsed.about, setAt: parsed.setAt, known: parsed.recognized };
}

async function readAboutQuietly(
  provider: OwnProfileProvider,
  jid: string,
  timeoutMs: number
): Promise<AboutRead> {
  try {
    return await readAbout(provider, jid, timeoutMs);
  } catch (error) {
    const mapped = mapProfileProviderError(error, 'about lookup');
    // A failed about read must not hide the name and photo the caller can use.
    return {
      about: null,
      setAt: null,
      known: false,
      timedOut: mapped.code === 'PROFILE_UPSTREAM_TIMEOUT',
    };
  }
}

interface PhotoState {
  identity: string | null;
  known: boolean;
}

/**
 * Read the current picture identity. An unavailable lookup is `unknown`, never
 * "no photo", so a provider hiccup cannot be mistaken for a removed picture.
 */
async function readPhotoState(provider: OwnProfileProvider, jid: string): Promise<PhotoState> {
  if (typeof provider.profilePictureIdentity !== 'function')
    return { identity: null, known: false };
  try {
    const identity = await provider.profilePictureIdentity(jid);
    // `null` is an answer ("no photo"); anything that is neither a string nor
    // null is not an answer, and must stay unknown.
    if (identity === null) return { identity: null, known: true };
    if (typeof identity === 'string' && identity) return { identity, known: true };
    return { identity: null, known: false };
  } catch {
    return { identity: null, known: false };
  }
}

export interface OwnProfileView extends OwnProfile {
  capabilities: ProfileCapabilities;
  aboutKnown: boolean;
  photoKnown: boolean;
}

export async function readOwnProfile(
  provider: OwnProfileProvider,
  io: ProfileIo = {}
): Promise<OwnProfileView> {
  const timeoutMs = io.timeoutMs || PROVIDER_READ_TIMEOUT_MS;
  const jid = requireOwnJid(provider);
  const [about, photo] = await Promise.all([
    readAboutQuietly(provider, jid, timeoutMs),
    readPhotoState(provider, jid),
  ]);
  const name = typeof provider.accountName === 'function' ? provider.accountName() : null;
  return {
    jid,
    phone: phoneFromProfileJid(jid),
    name: name && name.trim() ? name.trim() : null,
    about: about.about,
    aboutSetAt: about.setAt,
    photo: { available: photo.identity !== null },
    capabilities: profileCapabilities(provider),
    aboutKnown: about.known === true,
    photoKnown: photo.known === true,
  };
}

async function applyName(
  provider: OwnProfileProvider,
  requested: string,
  io: Required<Pick<ProfileIo, 'timeoutMs' | 'sleep'>>
): Promise<ProfileFieldOutcome> {
  const write = requireMethod(provider, 'updateProfileName', 'set the display name');
  try {
    await withTimeout(
      () => Promise.resolve(write.call(provider, requested)),
      'name update',
      io.timeoutMs
    );
  } catch (error) {
    throw mapProfileProviderError(error, 'name update');
  }
  // Baileys applies the name through an app-state patch and never refreshes
  // creds.me locally, so only poll briefly: the absence of a change is
  // reported, not faked.
  let current = provider.accountName();
  for (let attempt = 0; attempt < NAME_READBACK_ATTEMPTS && current !== requested; attempt += 1) {
    await io.sleep(NAME_READBACK_INTERVAL_MS);
    current = provider.accountName();
  }
  const trimmed = current && current.trim() ? current.trim() : null;
  return {
    requested,
    current: trimmed,
    accepted: true,
    confirmed: current === requested,
    reason:
      current === requested
        ? 'READBACK_MATCHED'
        : 'SESSION_NAME_NOT_REFRESHED: WhatsApp accepted the name; this linked session has not reloaded its own copy yet',
  };
}

async function applyAbout(
  provider: OwnProfileProvider,
  requested: string,
  jid: string,
  timeoutMs: number
): Promise<ProfileFieldOutcome> {
  const write = requireMethod(provider, 'updateProfileStatus', 'set the about text');
  try {
    await withTimeout(
      () => Promise.resolve(write.call(provider, requested)),
      'about update',
      timeoutMs
    );
  } catch (error) {
    throw mapProfileProviderError(error, 'about update');
  }
  const readback = await readAboutQuietly(provider, jid, timeoutMs);
  const expected = requested || null;
  const confirmed = readback.known === true && readback.about === expected;
  return {
    requested,
    current: readback.about,
    accepted: true,
    confirmed,
    reason: confirmed
      ? 'READBACK_MATCHED'
      : readback.timedOut
        ? 'READBACK_TIMEOUT: WhatsApp accepted the change but its About lookup timed out'
        : readback.known !== true
          ? 'READBACK_UNAVAILABLE: WhatsApp did not return a readable About, so the change is not confirmed'
          : 'READBACK_DIFFERS: WhatsApp returned a different About',
  };
}

export interface ProfileUpdateInput {
  name?: unknown;
  about?: unknown;
}

export interface ProfileUpdateResult {
  name?: ProfileFieldOutcome;
  about?: ProfileFieldOutcome;
  applied: string[];
  failed: string[];
  partial: boolean;
}

function asProfileError(error: unknown): ProfileError {
  return error instanceof ProfileError
    ? error
    : new ProfileError('PROFILE_UPSTREAM_REJECTED', String(error));
}

/**
 * Apply the requested fields independently: a rejected name must not silently
 * swallow an accepted about, and the other way round. When everything failed,
 * the first error is rethrown so the HTTP layer can answer with a real status.
 */
export async function applyProfileUpdates(
  provider: OwnProfileProvider,
  input: ProfileUpdateInput,
  io: ProfileIo = {}
): Promise<ProfileUpdateResult> {
  const timeoutMs = io.timeoutMs || PROVIDER_WRITE_TIMEOUT_MS;
  const sleep = io.sleep || defaultSleep;
  const jid = requireOwnJid(provider);
  const wantsName = input.name !== undefined && input.name !== null;
  const wantsAbout = typeof input.about === 'string';
  if (!wantsName && !wantsAbout) {
    throw new ProfileError('INVALID_PROFILE_INPUT', 'At least one of name or about is required');
  }

  const result: ProfileUpdateResult = { applied: [], failed: [], partial: false };
  let firstError: ProfileError | null = null;
  const name = wantsName ? normalizeProfileName(input.name) : null;
  const about = wantsAbout ? normalizeProfileAbout(input.about) : null;

  if (name) {
    try {
      result.name = await applyName(provider, name, { timeoutMs, sleep });
      result.applied.push('name');
    } catch (error) {
      firstError = asProfileError(error);
      result.failed.push('name');
    }
  }
  if (about !== null) {
    try {
      result.about = await applyAbout(provider, about, jid, timeoutMs);
      result.applied.push('about');
    } catch (error) {
      firstError = firstError || asProfileError(error);
      result.failed.push('about');
    }
  }

  if (!result.applied.length) {
    throw (
      firstError ||
      new ProfileError('PROFILE_UPSTREAM_REJECTED', 'WhatsApp rejected the profile update')
    );
  }
  result.partial = result.failed.length > 0;
  return result;
}

/**
 * A new picture is only confirmed when its identity differs from the one the
 * account had before. `before === null` (no photo at all) plus a photo now is
 * also a real difference; the same identity after the write is not proof.
 */
function photoConfirmation(
  before: PhotoState,
  after: PhotoState,
  kind: 'set' | 'remove'
): ProfilePhotoOutcome {
  const available = after.identity !== null;
  if (!after.known) {
    return {
      available,
      accepted: true,
      confirmed: false,
      reason:
        'READBACK_UNAVAILABLE: WhatsApp did not answer the photo lookup, so the change is not confirmed',
    };
  }
  if (kind === 'remove') {
    return {
      available,
      accepted: true,
      confirmed: !available,
      reason: available
        ? 'READBACK_DIFFERS: WhatsApp still reports a profile photo'
        : 'READBACK_REMOVED',
    };
  }
  if (!available) {
    return {
      available: false,
      accepted: true,
      confirmed: false,
      reason: 'READBACK_DIFFERS: WhatsApp reports no profile photo after the upload',
    };
  }
  if (!before.known) {
    return {
      available: true,
      accepted: true,
      confirmed: false,
      reason:
        'IDENTITY_UNKNOWN: the previous photo could not be read, so this upload is not confirmed',
    };
  }
  const changed = before.identity !== after.identity;
  return {
    available: true,
    accepted: true,
    confirmed: changed,
    reason: changed
      ? 'IDENTITY_CHANGED'
      : 'IDENTITY_UNCHANGED: WhatsApp still serves the same picture, so the upload is not confirmed',
  };
}

export async function setOwnProfilePhoto(
  provider: OwnProfileProvider,
  input: { imageBase64?: unknown; mimeType?: unknown },
  io: ProfileIo = {}
): Promise<{ photo: ProfilePhotoOutcome; mimeType: string; bytes: number }> {
  const timeoutMs = io.timeoutMs || PROVIDER_WRITE_TIMEOUT_MS;
  const jid = requireOwnJid(provider);
  const { bytes, mimeType } = decodeProfilePhoto(input);
  const write = requireMethod(provider, 'updateProfilePicture', 'set the profile photo');
  const before = await readPhotoState(provider, jid);
  try {
    await withTimeout(
      () => Promise.resolve(write.call(provider, jid, bytes)),
      'profile photo update',
      timeoutMs
    );
  } catch (error) {
    throw mapProfileProviderError(error, 'profile photo update');
  }
  return {
    photo: photoConfirmation(before, await readPhotoState(provider, jid), 'set'),
    mimeType,
    bytes: bytes.length,
  };
}

export async function removeOwnProfilePhoto(
  provider: OwnProfileProvider,
  io: ProfileIo = {}
): Promise<{ photo: ProfilePhotoOutcome }> {
  const timeoutMs = io.timeoutMs || PROVIDER_WRITE_TIMEOUT_MS;
  const jid = requireOwnJid(provider);
  const write = requireMethod(provider, 'removeProfilePicture', 'remove the profile photo');
  try {
    await withTimeout(
      () => Promise.resolve(write.call(provider, jid)),
      'profile photo removal',
      timeoutMs
    );
  } catch (error) {
    throw mapProfileProviderError(error, 'profile photo removal');
  }
  return {
    photo: photoConfirmation(
      { identity: null, known: true },
      await readPhotoState(provider, jid),
      'remove'
    ),
  };
}

export interface OwnProfilePhotoProvider extends OwnProfileProvider {
  /** Bounded, host-allowlisted download owned by `BaileysClient`. */
  downloadProfilePhoto?: (jid: string) => Promise<Buffer | null>;
}

/**
 * Read the account's own photo bytes. The download stays in `BaileysClient`
 * because that is where the URL allowlist and the size bound live.
 */
export async function readOwnProfilePhotoBytes(
  provider: OwnProfilePhotoProvider,
  io: ProfileIo = {}
): Promise<Buffer | null> {
  const timeoutMs = io.timeoutMs || PROVIDER_READ_TIMEOUT_MS;
  const jid = requireOwnJid(provider);
  if (typeof provider.downloadProfilePhoto !== 'function') {
    throw new ProfileError(
      'PROFILE_PROVIDER_UNAVAILABLE',
      'The installed WhatsApp provider cannot read the profile photo'
    );
  }
  try {
    return await withTimeout(
      () => Promise.resolve(provider.downloadProfilePhoto!(jid)),
      'profile photo download',
      timeoutMs
    );
  } catch (error) {
    throw mapProfileProviderError(error, 'profile photo download');
  }
}

// ---------------------------------------------------------------------------
// HTTP surface (this repository): request parsing, URL photos, error mapping
// ---------------------------------------------------------------------------

const PHOTO_FETCH_TIMEOUT_MS = 15_000;

/** ProfileError code → the connector's `failureClass` (same classes as sends). */
export function profileFailureClass(error: ProfileError): string {
  switch (error.code) {
    case 'INVALID_PROFILE_INPUT':
    case 'PHOTO_TOO_LARGE':
      return 'invalid_request';
    case 'PROFILE_DISCONNECTED':
      return 'disconnected';
    case 'PROFILE_UPSTREAM_TIMEOUT':
      return 'timeout';
    case 'PROFILE_UPSTREAM_REJECTED':
      return 'rejected_by_whatsapp';
    case 'PROFILE_APP_STATE_UNAVAILABLE':
      return 'app_state_unavailable';
    default:
      return 'unsupported';
  }
}

function requireConfirm(body: Record<string, unknown>, what: string): void {
  if (body.confirm !== true) {
    throw new ProfileError(
      'INVALID_PROFILE_INPUT',
      `${what} is visible to every contact: pass confirm: true`,
      { code: 'confirm_required' }
    );
  }
}

/**
 * POST /profile/me body: name and/or about (an empty about clears it), plus
 * confirm: true. Checked before the sending gate and before WhatsApp.
 */
export function parseProfileUpdateRequest(body: Record<string, unknown>): ProfileUpdateInput {
  const wantsName = body.name !== undefined && body.name !== null;
  const wantsAbout = body.about !== undefined && body.about !== null;
  if (!wantsName && !wantsAbout) {
    throw new ProfileError('INVALID_PROFILE_INPUT', 'At least one of name or about is required');
  }
  const input: ProfileUpdateInput = {};
  if (wantsName) input.name = normalizeProfileName(body.name);
  if (wantsAbout) input.about = normalizeProfileAbout(body.about);
  requireConfirm(body, 'The profile');
  return input;
}

export type ProfilePhotoRequest =
  { kind: 'base64'; imageBase64: string; mimeType: unknown } | { kind: 'url'; fileUrl: string };

/** POST /profile/me/photo body: exactly one of fileUrl or imageBase64 (+ mimeType), confirm: true. */
export function parseProfilePhotoRequest(body: Record<string, unknown>): ProfilePhotoRequest {
  const fileUrl = typeof body.fileUrl === 'string' ? body.fileUrl.trim() : '';
  const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64 : '';
  if (!!fileUrl === !!imageBase64) {
    throw new ProfileError(
      'INVALID_PROFILE_INPUT',
      'Provide exactly one of fileUrl or imageBase64 (with mimeType)'
    );
  }
  let request: ProfilePhotoRequest;
  if (fileUrl) {
    let url: URL;
    try {
      url = new URL(fileUrl);
    } catch {
      throw new ProfileError('INVALID_PROFILE_INPUT', 'fileUrl must be an http(s) URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ProfileError('INVALID_PROFILE_INPUT', 'fileUrl must be an http(s) URL');
    }
    request = { kind: 'url', fileUrl };
  } else {
    request = { kind: 'base64', imageBase64, mimeType: body.mimeType };
  }
  requireConfirm(body, 'The profile photo');
  return request;
}

export function parseProfilePhotoRemoveRequest(body: Record<string, unknown>): void {
  requireConfirm(body, 'Removing the profile photo');
}

/**
 * Fetch a photo by URL the way /messages/media/send fetches attachments
 * (public https, cluster-internal http, presigned MinIO), bounded in time and
 * size, and hand it to decodeProfilePhoto so the bytes are sniffed exactly as
 * an inline upload is.
 */
export async function fetchProfilePhoto(
  fileUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ imageBase64: string; mimeType: string }> {
  let response: globalThis.Response;
  try {
    response = await fetchImpl(fileUrl, { signal: AbortSignal.timeout(PHOTO_FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new ProfileError('INVALID_PROFILE_INPUT', `Failed to fetch the photo from ${fileUrl}`, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (!response.ok || !response.body) {
    throw new ProfileError(
      'INVALID_PROFILE_INPUT',
      `Failed to fetch the photo from ${fileUrl}: ${response.status}`
    );
  }
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > PROFILE_PHOTO_MAX_BYTES) {
    await response.body.cancel().catch(() => {});
    throw new ProfileError('PHOTO_TOO_LARGE', 'Profile photo exceeds 8 MB', {
      maxBytes: PROFILE_PHOTO_MAX_BYTES,
      received: declared,
    });
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > PROFILE_PHOTO_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ProfileError('PHOTO_TOO_LARGE', 'Profile photo exceeds 8 MB', {
        maxBytes: PROFILE_PHOTO_MAX_BYTES,
      });
    }
    chunks.push(Buffer.from(value));
  }
  return {
    imageBase64: Buffer.concat(chunks, size).toString('base64'),
    mimeType: response.headers.get('content-type') || '',
  };
}
