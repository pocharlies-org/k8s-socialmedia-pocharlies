/**
 * SC-1228 (SC-1197 P2): GET /social/status — the CALLER's own channel states
 * (design D3).
 *
 * One view, three sources, all keyed by `sessionKey = sub` from the verified
 * JWT — nothing is ever listed or enumerated (D4/D5 isolation):
 *   whatsapp  the pool's state route (the pool is the only source of truth
 *             for a baileys session: row → paired, provider-invalidated
 *             during the process's life → expired, no row → unpaired;
 *             pool down / store off → unavailable).
 *   telegram  the telegram pool's state route (SC-1229 / P4b), same shape as
 *             whatsapp: row → paired, provider-invalidated → expired, no row
 *             → unpaired; pool down / store off / no TELEGRAM_PAIRING_URL →
 *             unavailable — an honest unknown, never a fake `unpaired`.
 *   instagram `credentialStore.get(sub, 'instagram')` (design D3): row with
 *             `expiresAt` in the past → expired, row → paired, no row →
 *             unpaired, store off or unreadable → unavailable.
 *   houseAccounts  read-only intersection of the caller's identity binding
 *             (loadIdentityBindings, its own sub only) with the declarative
 *             account registry — no account name is fixed in this code.
 *
 * The response carries NO identifiers (no jid, no username, no sessionKey):
 * a token of A can never leak anything of B, and the whole isolation
 * criterion is structural, not a filter.
 *
 * Unlike /pairing/* and /me/*, this route answers 200 with everything
 * `unavailable` while the store is off (design D7) — the caller must be able
 * to tell "not configured" from "error", and a status view is not a pairing
 * action. The JWT, Origin and identity gates in front of it are the same.
 */
import { RequestHandler } from 'express';
import { deserializeInstagramToken } from '@mcp-socialmedia/shared';
import { getAccounts } from '../../domain/account-registry';
import { loadIdentityBindings } from '../../domain/identity-bindings';
import { IdentityRequest, SocialApiContext } from '../context';
import { RouteSpec } from '../router';
import { PoolUnreachableError } from '../whatsapp-pairing-client';

// CONTRACT: http.social-api.social-status.v1 — the state enum is part of the
// response contract; a new state is a new `.v2` entry, not a value here.
export type ChannelState = 'paired' | 'expired' | 'unpaired' | 'unavailable';

export interface HouseAccount {
  channel: string;
  accountId: string;
  label: string;
}

/** The pool's PairingState → the status contract's ChannelState. */
const POOL_STATE_TO_STATUS: Record<string, ChannelState> = {
  paired: 'paired',
  expired: 'expired',
  unpaired: 'unpaired',
  // A pairing in flight has no row yet (the row is written only after the
  // first `connection: open`): for a status view the account is not paired.
  starting: 'unpaired',
  qr: 'unpaired',
  // telegram-only state (SC-1229): the 2FA step of the QR flow, still in
  // flight → same reading as `qr`.
  password: 'unpaired',
};

async function whatsappState(ctx: SocialApiContext, sub: string): Promise<ChannelState> {
  if (!ctx.storeAvailable || !ctx.whatsappPairing) return 'unavailable';
  try {
    const pool = await ctx.whatsappPairing.post('state', sub);
    if (pool.status !== 200) {
      // 429 (QR budget spent) / 400 / 401 / 503: the pool is the only source
      // for this state and it is not answering for this sub — say so instead
      // of guessing.
      return 'unavailable';
    }
    const raw = pool.json.state;
    return typeof raw === 'string' ? POOL_STATE_TO_STATUS[raw] || 'unavailable' : 'unavailable';
  } catch (err) {
    if (!(err instanceof PoolUnreachableError)) {
      ctx.logError(`social-api: /social/status whatsapp failed: ${(err as Error)?.message || err}`);
    }
    return 'unavailable';
  }
}

async function telegramState(ctx: SocialApiContext, sub: string): Promise<ChannelState> {
  if (!ctx.storeAvailable || !ctx.telegramPairing) return 'unavailable';
  try {
    const pool = await ctx.telegramPairing.post('state', sub);
    if (pool.status !== 200) {
      // Same reading as whatsapp: the pool is the only source for this state
      // and it is not answering for this sub → say so, never guess.
      return 'unavailable';
    }
    const raw = pool.json.state;
    return typeof raw === 'string' ? POOL_STATE_TO_STATUS[raw] || 'unavailable' : 'unavailable';
  } catch (err) {
    if (!(err instanceof PoolUnreachableError)) {
      ctx.logError(`social-api: /social/status telegram failed: ${(err as Error)?.message || err}`);
    }
    return 'unavailable';
  }
}

async function instagramState(ctx: SocialApiContext, sub: string): Promise<ChannelState> {
  if (!ctx.storeAvailable || !ctx.credentialStore) return 'unavailable';
  try {
    const row = await ctx.credentialStore.get(sub, 'instagram');
    if (!row) return 'unpaired';
    // The adapter owns the payload shape; a row it refuses to read is a
    // broken credential, not an unpaired account → unavailable (fail closed).
    const payload = deserializeInstagramToken(row.payload);
    return typeof payload.expiresAt === 'number' && payload.expiresAt <= Date.now()
      ? 'expired'
      : 'paired';
  } catch (err) {
    ctx.logError(`social-api: /social/status instagram failed: ${(err as Error)?.message || err}`);
    return 'unavailable';
  }
}

/**
 * The house accounts bound to THIS sub (design D4: registry and bindings are
 * read only, never listed). The bindings module keeps its own mtime reload
 * and the registry its own SOCIAL_ACCOUNTS_FILE reload — both are the same
 * domain modules the MCP routing uses, so the view cannot drift from the
 * enforcement. Fail-closed: an unreadable bindings table binds nobody.
 */
function houseAccountsFor(ctx: SocialApiContext, sub: string): HouseAccount[] {
  try {
    const entry = loadIdentityBindings(ctx.identityBindingsPath).get(sub);
    if (!entry) return [];
    const bound = new Set(entry.accounts);
    return getAccounts()
      .filter(a => bound.has(a.accountId))
      .map(a => ({ channel: a.channel, accountId: a.accountId, label: a.label }));
  } catch (err) {
    ctx.logError(
      `social-api: /social/status bindings unreadable: ${(err as Error)?.message || err}`
    );
    return [];
  }
}

function handler(ctx: SocialApiContext): RequestHandler {
  return async (req, res) => {
    const sub = (req as IdentityRequest).identity?.sub;
    if (!sub) {
      // unreachable: jwtGuard + identityGuard run first and gate this route
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const [whatsapp, telegram, instagram] = await Promise.all([
      whatsappState(ctx, sub),
      telegramState(ctx, sub),
      instagramState(ctx, sub),
    ]);
    res.json({
      channels: {
        whatsapp: { state: whatsapp },
        telegram: { state: telegram },
        instagram: { state: instagram },
      },
      houseAccounts: houseAccountsFor(ctx, sub),
    });
  };
}

// CONTRACT: http.social-api.social-status.v1
export const socialStatusRoute: RouteSpec = {
  method: 'get',
  path: '/social/status',
  auth: true,
  // The one route that answers with the store off (D7): states become
  // `unavailable` instead of a 503, so this route skips the store gate.
  storeRequired: false,
  make: handler,
};
