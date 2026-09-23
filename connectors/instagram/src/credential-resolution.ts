/**
 * SC-1194 P1 (SC-1143) criterion 3/4: per-sub credential resolution inside the
 * instagram connector.
 *
 * The mcp-server forwards the gateway-verified actor on every connector call
 * (`x-user-sub`, the SC-705 pattern). Resolution rules, in order:
 *
 *  1. store disabled (flag OFF) or no `sub` on the request → EXACT legacy
 *     path: the env-indexed account (`INSTAGRAM_<NAME>_*`). Zero store reads,
 *     zero writes — the no-regression rule for every current consumer.
 *  2. flag ON + `sub` + a row under `<sub>:<account>` or `<sub>` → that row
 *     is served. Never another sub's row: the lookup is keyed by the caller's
 *     own sub, so listing someone else's accounts is structurally impossible.
 *  3. flag ON + `sub` + no row → explicit `no instagram credential for this
 *     user` error (epic criterion 4). NO adopt-on-first-use of the house
 *     tokens here: the env credentials belong to the house accounts
 *     (skirmshop/barbelpapis), and adopting them for the first sub that asks
 *     would hand one user another's business token — the SC-705 ruling that
 *     house accounts are inadoptables applies to Instagram too.
 *
 * `resolveCredential` (shared) implements the precedence; we hand it a store
 * view that understands the `<sub>:<account>` suffix and a `loadLegacy` that
 * only serves the env credential when the request has no sub. Refresh-on-use
 * (criterion 3): an Instagram Login token nears its 60-day expiry → refresh
 * via graph.instagram.com and write the row back, so a paired account keeps
 * working without a human. Meta only allows refreshing tokens at least 24 h
 * old; younger rows are served untouched.
 */
import { Pool } from 'pg';
import {
  CredentialStore,
  PostgresCredentialStore,
  actorFromHeaders,
  credentialStoreEnabled,
  deserializeInstagramToken,
  resolveCredential,
  serializeInstagramToken,
} from '@mcp-socialmedia/shared';
import { InstagramAPI, InstagramConfig } from './instagram-api';
import {
  IG_REFRESH_AHEAD_MS,
  IG_REFRESH_MIN_AGE_MS,
  PairingFetch,
  refreshInstagramToken,
} from './oauth-pairing';

/** What the routes need: a ready API client plus its (non-secret) label. */
export interface ResolvedInstagramEntry {
  name: string;
  api: InstagramAPI;
}

export type InstagramResolution =
  | { entry: ResolvedInstagramEntry }
  | { error: { code: string; message: string } };

/**
 * Bootstrap the store from env. Returns null when the flag is off — the
 * connector then behaves exactly like before this story. DATABASE_URL is
 * required by the store's Postgres pool (the deployment sets it; see
 * k8s/base/manifest.yaml).
 */
export function createInstagramCredentialStore(
  env: NodeJS.ProcessEnv = process.env
): CredentialStore | null {
  if (!credentialStoreEnabled(env)) return null;
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'CREDENTIAL_STORE_ENABLED=true but DATABASE_URL is unset: refusing to start the instagram connector without its credential store'
    );
  }
  return new PostgresCredentialStore(new Pool({ connectionString, max: 2 }), undefined);
}

/** Legacy env account → store payload shape (used only for the no-sub path). */
export function legacyPayloadFromConfig(config: InstagramConfig): Record<string, unknown> {
  return {
    ...serializeInstagramToken({
      accessToken: config.accessToken,
      businessAccountId: config.businessAccountId,
      appId: config.appId,
      appSecret: config.appSecret,
      fbAccessToken: config.fbAccessToken,
      instagramUserId: config.instagramUserId,
    }),
  };
}

export function instagramApiFromPayload(payload: Record<string, unknown>): InstagramAPI {
  const value = deserializeInstagramToken(payload);
  const config: InstagramConfig = {
    accessToken: value.accessToken,
    businessAccountId: value.businessAccountId,
    appId: value.appId,
    appSecret: value.appSecret,
    fbAccessToken: value.fbAccessToken,
    instagramUserId: value.instagramUserId,
    primaryApi: 'instagram-login',
  };
  return new InstagramAPI(config);
}

export interface ResolveInstagramEntryOptions {
  /** The raw request headers (express). */
  headers: Record<string, string | string[] | undefined>;
  /** Account label from the route (`/api/v1/:account/...`). */
  accountName: string;
  /** Null while the store is disabled — the whole feature is flag-gated. */
  store: CredentialStore | null;
  /** Legacy env-indexed lookup (main.ts `getAccount`). */
  legacyLookup: (name: string) => { name: string; api: InstagramAPI; config: InstagramConfig } | undefined;
  /** Injected for tests; production uses global fetch. */
  fetchImpl?: PairingFetch;
  now?: number;
  log?: (msg: string) => void;
}

/**
 * Store view that knows the `<sub>:<account>` suffix convention: a get for
 * `sub` first looks for the account-specific row, then falls back to the
 * user's primary row. The key that actually won is recorded in `matched` so
 * the refresh write-back replaces the SAME row it read (a wrong guess would
 * create a stray duplicate under another key). put/delete stay keyed as
 * given (pairing owns the key choice).
 */
function subAccountStoreView(
  store: CredentialStore,
  accountName: string,
  matched: { key?: string }
): CredentialStore {
  return {
    async get(sessionKey, channel) {
      if (accountName && !sessionKey.includes(':')) {
        const scoped = await store.get(`${sessionKey}:${accountName}`, channel);
        if (scoped) {
          matched.key = `${sessionKey}:${accountName}`;
          return scoped;
        }
      }
      const row = await store.get(sessionKey, channel);
      if (row) matched.key = sessionKey;
      return row;
    },
    put: (key, channel, payload) => store.put(key, channel, payload),
    delete: (key, channel) => store.delete(key, channel),
  };
}

/**
 * Refresh-on-use: near-expiry (≤14 days left) and old enough (≥24 h, Meta's
 * rule) → refresh and write the row back. A refresh failure must never break
 * the request being served; log loudly and keep the current token.
 */
export async function refreshIfExpiring(deps: {
  store: CredentialStore;
  sessionKey: string;
  payload: Record<string, unknown>;
  fetchImpl: PairingFetch;
  now: number;
  log: (msg: string) => void;
}): Promise<Record<string, unknown>> {
  const value = deserializeInstagramToken(deps.payload);
  if (typeof value.expiresAt !== 'number' || typeof value.issuedAt !== 'number') {
    return deps.payload; // legacy-shaped row (adopted env credential): no lifetime to manage
  }
  const ageMs = deps.now - value.issuedAt;
  const remainingMs = value.expiresAt - deps.now;
  if (ageMs < IG_REFRESH_MIN_AGE_MS || remainingMs > IG_REFRESH_AHEAD_MS) {
    return deps.payload;
  }
  try {
    const refreshed = await refreshInstagramToken(value.accessToken, deps.fetchImpl);
    const next = serializeInstagramToken({
      ...value,
      accessToken: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
      issuedAt: deps.now,
    });
    await deps.store.put(deps.sessionKey, 'instagram', { ...next });
    deps.log(
      `credential-store: refreshed instagram token for ${deps.sessionKey} (expires ${new Date(refreshed.expiresAt).toISOString()})`
    );
    return { ...next };
  } catch (error) {
    deps.log(
      `credential-store: instagram refresh FAILED for ${deps.sessionKey}, serving current token: ${String(error)}`
    );
    return deps.payload;
  }
}

/**
 * The single entry point the routes use. Returns either an API client to
 * serve the request with, or an explicit error to answer 400 with.
 */
export async function resolveInstagramEntry(
  opts: ResolveInstagramEntryOptions
): Promise<InstagramResolution> {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const now = opts.now ?? Date.now();
  const fetchImpl = (opts.fetchImpl ?? (globalThis.fetch as unknown as PairingFetch)).bind(globalThis);
  const actor = actorFromHeaders(opts.headers as never);

  // Case 1 — flag off or anonymous caller: exact legacy path, store untouched.
  if (!opts.store || !actor.sub) {
    const legacy = opts.legacyLookup(opts.accountName);
    if (!legacy) {
      return {
        error: {
          code: 'unknown_account',
          message: `Account '${opts.accountName}' not found`,
        },
      };
    }
    return { entry: { name: legacy.name, api: legacy.api } };
  }

  // Cases 2/3 — verified caller with the store on. loadLegacy returns null
  // whenever a sub is present: the house env tokens are inadoptable, so a
  // missing row is an error, never a silent grant of another user's account.
  const matched: { key?: string } = {};
  const resolved = await resolveCredential({
    store: subAccountStoreView(opts.store, opts.accountName, matched),
    actor,
    channel: 'instagram',
    loadLegacy: async () => null,
    // The store's existence IS the flag decision (made once at bootstrap by
    // createInstagramCredentialStore); pass it explicitly instead of letting
    // resolveCredential re-read process.env here.
    enabled: true,
  });

  if (!resolved.payload || !matched.key) {
    return {
      error: {
        code: 'no_instagram_credential',
        message: `no instagram credential for this user (sub ${actor.sub}): pair an account with social_manage_session action=startPairing`,
      },
    };
  }

  const payload = await refreshIfExpiring({
    store: opts.store,
    sessionKey: matched.key,
    payload: resolved.payload,
    fetchImpl,
    now,
    log,
  });

  return { entry: { name: `${actor.sub}`, api: instagramApiFromPayload(payload) } };
}
