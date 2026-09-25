/**
 * SC-705 phase 1.5: wire the WhatsApp (baileys) connector to the per-user
 * credential store (shared/session-store).
 *
 * Convention fixed by the tech-lead (nota-tech-lead-almacen-gaps, SC-1144):
 *   session_key = <sub>                     — one session per user+channel
 *   session_key = <sub>:<cuenta>            — when one user has two accounts
 * The PK (session_key, channel) already supports both without a schema
 * change. CREDENTIAL_SESSION_KEY carries that key for THIS connector process
 * (one process per paired session is the CTO's phase-2 posture; phase 1.5
 * wires a single per-sub connector, e.g. Daniel's).
 *
 * Hard no-regression rule (SC-1144 criterion 4): the house accounts
 * (`personal`, `professional`) do NOT set CREDENTIAL_SESSION_KEY, so they
 * keep the exact legacy path — legacy authDir, no store reads, no store
 * writes, no adoption. Adoption here is ONLY for new per-user sessions: with
 * a key set and no row yet, the connector pairs fresh (QR) and the first
 * saveCreds write-back creates the row.
 *
 * Write-back is OBLIGATORY (tech-lead ruling): without it the PVC and the
 * row would diverge and a pod restart would lose creds rotated since pairing.
 * The baileys `creds.update` event is frequent, so the write-back debounces,
 * serializes (one put in flight, one trailing run) and never throws into the
 * socket handler — a store failure logs loudly; the connector must keep
 * delivering messages.
 */
import { join } from 'path';
import {
  CredentialStore,
  applyBaileysAuthDir,
  createCredentialWriteBack as createSharedCredentialWriteBack,
  serializeBaileysAuthDir,
} from '@mcp-socialmedia/shared';

// SC-1145: the session_key convention (regex + env parsing) moved to
// shared/session-store/credential-session-key.ts so the telegram connector
// keys its rows by the identical rule — one source of truth for the
// tech-lead's binding convention. Re-exported here unchanged for this
// connector's callers and specs.
export { CREDENTIAL_SESSION_KEY_RE, credentialSessionKeyFromEnv } from '@mcp-socialmedia/shared';

/** Per-sub sessionPath so two per-sub connectors could share a PVC root. */
export function sessionPathForSub(baseSessionPath: string, sessionKey: string): string {
  return join(baseSessionPath, 'by-sub', sessionKey);
}

/**
 * Load this sub's session into the auth dir before the first connect().
 * 'loaded' = the row was applied; 'fresh' = no row yet → the connector will
 * pair over QR and the write-back creates the row (adopt-on-first-use for
 * NEW user sessions only — the house never takes this path).
 */
export async function loadCredentialSession(
  store: CredentialStore,
  sessionKey: string,
  authDir: string,
  log: (msg: string) => void = msg => console.log(msg)
): Promise<'loaded' | 'fresh'> {
  const row = await store.get(sessionKey, 'whatsapp');
  if (!row) {
    log(`credential-store: no whatsapp row for ${sessionKey} yet — fresh pairing expected`);
    return 'fresh';
  }
  await applyBaileysAuthDir(row.payload, authDir);
  log(
    `credential-store: loaded whatsapp session for ${sessionKey} (${Object.keys((row.payload as { files: object }).files).length} auth files)`
  );
  return 'loaded';
}

export interface CredentialWriteBack {
  /** Schedule a serialize+put (debounced; safe to call from event handlers). */
  schedule(): void;
  /** Run any pending write now and wait for the in-flight one (shutdown). */
  flush(): Promise<void>;
}

/**
 * saveCreds → store.put write-back. The choreography (debounce of
 * `creds.update` bursts, in-flight guard, trailing run, flush) lives in
 * shared/session-store/credential-write-back.ts — the telegram connector
 * shares it (SC-1224 architect ruling: two copies had already drifted).
 * This wrapper only supplies the channel and the auth-dir serializer, and
 * keeps the narrower handle this connector has always exposed: whatsapp does
 * NOT call cancel() yet (wiring it into `loggedOut` changes behaviour and is
 * another story).
 */
export function createCredentialWriteBack(
  store: CredentialStore,
  sessionKey: string,
  authDir: string,
  logError: (msg: string) => void = msg => console.error(msg),
  debounceMs = 2000
): CredentialWriteBack {
  return createSharedCredentialWriteBack({
    store,
    sessionKey,
    channel: 'whatsapp',
    getPayload: async () => ({ ...(await serializeBaileysAuthDir(authDir)) }),
    logError,
    debounceMs,
  });
}
