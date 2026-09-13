/**
 * SC-552: credential resolution with hard no-regression.
 *
 * Precedence (CTO ruling 13-09-2026, SC-552):
 *  1. flag ON + actor `sub` present + row in the store   → the row wins.
 *  2. no actor `sub` (or flag OFF)                       → exact legacy path,
 *     ZERO store reads and ZERO store writes. The current single-user
 *     deployment (no gateway header, or flag off) is bit-for-bit today's
 *     behaviour.
 *  3. flag ON + `sub` + no row yet                       → adopt-on-first-use:
 *     read the legacy credential, write it as the row for this `sub`, and
 *     still SERVE the legacy value. Serving stays on legacy; only the store
 *     gains a row.
 */
import { CredentialChannel, CredentialStore, credentialStoreEnabled } from './credential-store';
import { RequestActor } from './request-context';

export interface ResolvedCredential {
  /** The credential to serve (opaque channel payload), or null if none exists. */
  payload: Record<string, unknown> | null;
  /** 'store' = the per-user row won; 'legacy' = the pre-multi-user source. */
  source: 'store' | 'legacy';
  /** True when this call created the row from the legacy credential (case 3). */
  adopted: boolean;
}

export interface ResolveCredentialOptions {
  store: CredentialStore;
  /** Actor from getRequestActor() — {} when the request carried no headers. */
  actor: RequestActor;
  channel: CredentialChannel;
  /**
   * Loads the legacy credential for this channel (connector env/PVC session,
   * env-indexed Instagram token, …), serialized to a channel payload, or null
   * when there is none. Never called when the resolution is store-first.
   */
  loadLegacy: () => Promise<Record<string, unknown> | null>;
  /** Test seam; defaults to credentialStoreEnabled(). */
  enabled?: boolean;
}

export async function resolveCredential(
  options: ResolveCredentialOptions
): Promise<ResolvedCredential> {
  const enabled = options.enabled ?? credentialStoreEnabled();

  // Cases 2 (no sub) and flag-off: exact legacy path, store untouched.
  if (!enabled || !options.actor.sub) {
    return { payload: await options.loadLegacy(), source: 'legacy', adopted: false };
  }

  // Case 1: header + row → the row wins.
  const row = await options.store.get(options.actor.sub, options.channel);
  if (row) {
    return { payload: row.payload, source: 'store', adopted: false };
  }

  // Case 3: header, no row → adopt-on-first-use, serve legacy.
  const legacy = await options.loadLegacy();
  if (legacy !== null) {
    await options.store.put(options.actor.sub, options.channel, legacy);
    return { payload: legacy, source: 'legacy', adopted: true };
  }
  return { payload: null, source: 'legacy', adopted: false };
}
