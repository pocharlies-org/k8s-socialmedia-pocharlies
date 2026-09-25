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

/**
 * The slice of BaileysClient the credential-store wiring needs. Kept
 * structural so the pairing pool's specs can drive it with a fake socket.
 */
export interface CredentialSessionClient {
  getAuthDir(): string;
  setCredsSavedHook(hook: () => void): void;
  setSessionInvalidatedHook(hook: () => Promise<void> | void): void;
  once(event: 'connected', listener: () => void): unknown;
}

export interface AttachCredentialSessionOptions {
  /**
   * SC-1225 (pairing pool): no row is written until the socket reaches its
   * first `connection: open` — a QR that is never scanned leaves nothing in
   * the store. Default false = the SC-705 per-sub connector behaviour
   * (every saveCreds is mirrored from the start).
   */
  writeAfterFirstOpen?: boolean;
  /** Called after the row of a logged-out session has been deleted. */
  onInvalidated?: () => void;
  log?: (msg: string) => void;
  logError?: (msg: string) => void;
  debounceMs?: number;
}

export interface AttachedCredentialSession {
  /** 'loaded' = the stored row was applied to the auth dir before connect(). */
  loaded: 'loaded' | 'fresh';
  writeBack: CredentialWriteBack;
}

/**
 * SC-1225: the SC-705 wiring that lived inline in main.ts, extracted so the
 * per-sub connector (main.ts) and the pairing pool share one copy. Call it
 * BEFORE `client.connect()`: it loads the row into the auth dir, installs
 * the saveCreds → store.put write-back and deletes the row on `loggedOut`.
 * With default options it is exactly the previous main.ts code path.
 */
export async function attachCredentialSession(
  client: CredentialSessionClient,
  store: CredentialStore,
  sessionKey: string,
  opts: AttachCredentialSessionOptions = {}
): Promise<AttachedCredentialSession> {
  const authDir = client.getAuthDir();
  const loaded = await loadCredentialSession(store, sessionKey, authDir, opts.log);
  const writeBack = createCredentialWriteBack(
    store,
    sessionKey,
    authDir,
    opts.logError,
    opts.debounceMs
  );

  if (!opts.writeAfterFirstOpen) {
    client.setCredsSavedHook(() => writeBack.schedule());
    client.setSessionInvalidatedHook(async () => {
      await store.delete(sessionKey, 'whatsapp');
      opts.onInvalidated?.();
    });
    return { loaded, writeBack };
  }

  let opened = false;
  let invalidated = false;
  client.once('connected', () => {
    if (invalidated) return;
    opened = true;
    writeBack.schedule(); // the first row lands right after the first open
  });
  client.setCredsSavedHook(() => {
    if (opened && !invalidated) writeBack.schedule();
  });
  client.setSessionInvalidatedHook(async () => {
    invalidated = true;
    // Let an in-flight put land first so it cannot resurrect the row after
    // the delete; no new put can be scheduled once `invalidated` is set.
    await writeBack.flush();
    await store.delete(sessionKey, 'whatsapp');
    opts.onInvalidated?.();
  });
  return { loaded, writeBack };
}
