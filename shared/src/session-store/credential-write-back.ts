/**
 * SC-1224 (architect ruling on PR #67): the debounced write-back choreography
 * the whatsapp-web and telegram connectors each had their own copy of. One
 * implementation here; each connector keeps a one-line wrapper that supplies
 * its channel and its payload serializer — the same reason the session_key
 * convention lives in ./credential-session-key.ts: two copies drift.
 *
 * The choreography (body taken from the telegram version, the one that also
 * has `cancel()`): the debounce coalesces bursts of persist events (several
 * DCs' auth keys, several `creds.update`s land in one export); the in-flight
 * guard keeps puts ordered (no interleaved serialize of a half-written
 * session); a trailing run guarantees the LAST persist always reaches the
 * store; nothing ever throws into the caller's library hook — a store failure
 * logs loudly and the connector keeps delivering messages.
 *
 * Behaviour note (SC-1224 review): `cancel()` is on the handle for every
 * channel, but only telegram calls it today (logout must not re-put a dead
 * session). Wiring cancel into the whatsapp logout flow would change that
 * connector's behaviour and is deliberately left for another story.
 */
import { CredentialChannel, CredentialStore } from './credential-store';

export interface CredentialWriteBack {
  /** Schedule an export+put (debounced; safe to call from library hooks). */
  schedule(): void;
  /** Run any pending write now and wait for the in-flight one (shutdown). */
  flush(): Promise<void>;
  /** Drop a scheduled write (logout: a dead session must not be re-put). */
  cancel(): void;
}

export interface CredentialWriteBackOptions {
  store: CredentialStore;
  sessionKey: string;
  channel: CredentialChannel;
  /**
   * Snapshot the live session into a channel payload. May throw (a broken
   * export is a store failure like any other: logged, never rethrown).
   */
  getPayload: () => Promise<Record<string, unknown>>;
  logError?: (msg: string) => void;
  debounceMs?: number;
}

export function createCredentialWriteBack({
  store,
  sessionKey,
  channel,
  getPayload,
  logError = msg => console.error(msg),
  debounceMs = 2000,
}: CredentialWriteBackOptions): CredentialWriteBack {
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
        const payload = await getPayload();
        await store.put(sessionKey, channel, { ...payload });
      } catch (e: any) {
        // Never throw into the caller's library hook; loud log instead.
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
