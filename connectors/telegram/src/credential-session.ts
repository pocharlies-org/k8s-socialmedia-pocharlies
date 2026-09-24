/**
 * SC-705 part 4 (SC-1145): wire the Telegram (mtcute) connector to the
 * per-user credential store (shared/session-store). Same pattern as
 * connectors/whatsapp-web/src/credential-session.ts (phase 1.5, SC-1144):
 *
 *  - session_key = <sub> or <sub>:<cuenta> — the tech-lead's convention now
 *    lives in shared/credential-session-key.ts; CREDENTIAL_SESSION_KEY
 *    carries it for THIS connector process (one process per paired session).
 *  - Resolution goes through `resolveCredential` with the existing mtcute
 *    adapter: a row wins over the env; no row + env session → adopt-on-first-
 *    use (row created, env still served); the payload is encrypted by
 *    PostgresCredentialStore (payload-crypto.ts, not duplicated here).
 *  - Hard no-regression: flag OFF or no CREDENTIAL_SESSION_KEY → exact legacy
 *    path (TELEGRAM_SESSION_STRING, zero store reads/writes). The house
 *    accounts (personal/professional) never set the key, so their session is
 *    inadoptable — the same mechanism the WhatsApp adapter uses.
 *  - Write-back is OBLIGATORY (tech-lead ruling on SC-1144): mtcute persists
 *    session state through StorageManager.save() (session import, per-DC auth
 *    key creation, update-state sync — see HookedMemoryStorageDriver in
 *    telegram-client.ts). Every such persist schedules a debounced
 *    export+put, the counterpart of the baileys saveCreds write-back. Without
 *    it the row and the live session diverge and a pod restart loses rotation.
 *  - Logout: a session the server rejects (revoked from the user's app) is
 *    detected at connect; the row is deleted so a restart cannot keep
 *    re-applying a dead credential.
 */
import {
  CredentialStore,
  RequestActor,
  deserializeMtcuteSession,
  resolveCredential,
  serializeMtcuteSession,
} from '@mcp-socialmedia/shared';

export interface ResolvedTelegramSession {
  /** Session string to connect with, or null when there is none yet. */
  sessionString: string | null;
  /** 'store' = the per-sub row won; 'legacy' = env / adoption. */
  source: 'store' | 'legacy';
  /** True when this call created the row from the legacy env session. */
  adopted: boolean;
}

/**
 * Resolve the session string for this per-sub connector process through the
 * resolver (channel 'telegram', session_key as the actor sub). `loadLegacy`
 * is the pre-multi-user source: the TELEGRAM_SESSION_STRING env Secret.
 * `enabled` is the resolver's test seam; production leaves it unset and the
 * resolver reads CREDENTIAL_STORE_ENABLED.
 */
export async function resolveTelegramSession(
  store: CredentialStore,
  sessionKey: string,
  envSessionString: string,
  opts?: { enabled?: boolean; log?: (msg: string) => void }
): Promise<ResolvedTelegramSession> {
  const log = opts?.log ?? ((msg: string) => console.log(msg));
  const actor: RequestActor = { sub: sessionKey };
  const resolved = await resolveCredential({
    store,
    actor,
    channel: 'telegram',
    enabled: opts?.enabled,
    loadLegacy: async () =>
      envSessionString.trim() === ''
        ? null
        : { ...serializeMtcuteSession(envSessionString.trim()) },
  });
  if (resolved.adopted) {
    log(`credential-store: adopted legacy telegram session into row ${sessionKey}/telegram`);
  }
  if (resolved.payload === null) {
    return { sessionString: null, source: resolved.source, adopted: resolved.adopted };
  }
  // deserialize validates the shape and throws on a row that is not an
  // mtcute session payload — fail loud rather than connect with garbage.
  return {
    sessionString: deserializeMtcuteSession(resolved.payload).sessionString,
    source: resolved.source,
    adopted: resolved.adopted,
  };
}

/**
 * RpcError texts (and the mtcute start() fall-through) that mean THIS
 * session credential is dead: revoked from the app, deactivated, or expired.
 * `start({ session })` swallows the AUTH_KEY_* / SESSION_REVOKED RpcError and
 * then demands a phone number (MtArgumentError) — with a session string we
 * already passed in, that fall-through is the observable symptom of a dead
 * credential. A malformed session string throws a DIFFERENT MtArgumentError
 * ('Invalid session string') and must NOT delete the row: the operator fixes
 * the source, the store stays as written.
 */
const DEAD_SESSION_RPC_ERRORS = new Set([
  'AUTH_KEY_UNREGISTERED',
  'AUTH_KEY_INVALID',
  'AUTH_KEY_DUPLICATED',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
  'USER_DEACTIVATED',
  'USER_DEACTIVATED_BAN',
  'UNAUTHORIZED',
]);

export function isSessionInvalidatedError(e: unknown): boolean {
  const err = e as { name?: string; message?: string; text?: string } | null;
  if (!err || typeof err !== 'object') return false;
  if (typeof err.text === 'string' && DEAD_SESSION_RPC_ERRORS.has(err.text)) return true;
  return (
    err.name === 'MtArgumentError' &&
    typeof err.message === 'string' &&
    /Neither phone nor bot token were provided/.test(err.message)
  );
}

export interface TelegramCredentialWriteBack {
  /** Schedule an export+put (debounced; safe to call from library hooks). */
  schedule(): void;
  /** Run any pending write now and wait for the in-flight one (shutdown). */
  flush(): Promise<void>;
  /** Drop a scheduled write (logout: a dead session must not be re-put). */
  cancel(): void;
}

/**
 * mtcute persist → store.put write-back. Same choreography as the baileys
 * one: the debounce coalesces bursts (several DCs' auth keys land in one
 * session export), the in-flight guard keeps puts ordered, a trailing run
 * guarantees the LAST persist always reaches the store, and nothing ever
 * throws into the library hook — a store failure logs loudly; the connector
 * must keep delivering messages. `getSessionString` is
 * `client.exportSession()` behind the wrapper.
 */
export function createTelegramCredentialWriteBack(
  store: CredentialStore,
  sessionKey: string,
  getSessionString: () => Promise<string>,
  logError: (msg: string) => void = msg => console.error(msg),
  debounceMs = 2000
): TelegramCredentialWriteBack {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let pending = false; // a run() was requested while one was in flight
  let due = false; // schedule() fired but the debounce timer has not run yet

  const run = async (): Promise<void> => {
    if (inFlight) {
      pending = true; // trailing run: the last persist must reach the store
      return inFlight;
    }
    inFlight = (async () => {
      try {
        const sessionString = await getSessionString();
        await store.put(sessionKey, 'telegram', { ...serializeMtcuteSession(sessionString) });
      } catch (e: any) {
        // Never throw into the mtcute storage hook; loud log instead.
        logError(`credential-store write-back FAILED for ${sessionKey}: ${e?.message || e}`);
      } finally {
        inFlight = null;
        if (pending) {
          pending = false;
          await run();
        }
      }
    })();
    return inFlight;
  };

  return {
    schedule(): void {
      due = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        due = false;
        void run();
      }, debounceMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    async flush(): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // A scheduled-but-not-yet-fired write, an in-flight put, or a trailing
      // run must all land before the caller exits. run() chains the trailing
      // run inside the in-flight promise, so one await covers the burst.
      if (due || inFlight || pending) {
        due = false;
        await run();
      }
    },
    cancel(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      due = false;
      pending = false;
    },
  };
}
