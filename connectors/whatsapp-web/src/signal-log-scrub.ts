/**
 * F0.8 — libsignal privKey log scrub (docs/48 in synapse).
 *
 * ROOT CAUSE: libsignal's SessionRecord logs WHOLE SessionEntry objects to
 * stdout (`console.info("Closing session:", session)`, `"Opening session:"`,
 * `console.warn("Session already closed", session)` and
 * `"Removing old closed session:"` in libsignal/src/session_record.js).
 * SessionEntry defines the LEGACY `inspect()` redaction hook, but Node >= 12
 * only honors `Symbol.for('nodejs.util.inspect.custom')`, so console.* renders
 * the full object graph — including `currentRatchet.ephemeralKeyPair.privKey`,
 * `rootKey`, `chainKey.key` and per-message `messageKeys` Buffers — into the
 * pod logs (and from there into Loki).
 *
 * FIX: restore the author's intended redaction by attaching the MODERN inspect
 * symbol to SessionEntry.prototype, delegating to the existing safe
 * `toString()` (`<SessionEntry [baseKey=...]>` — baseKey is a PUBLIC key).
 * Display-only: session storage, ratcheting and crypto behavior are untouched.
 *
 * MUST run before any Baileys socket is created (main.ts calls it at startup)
 * so no session open/close can dump secrets first. `libsignal` is declared as
 * a direct dependency pinned to the same range Baileys uses; pnpm dedupes both
 * to one package instance, so we patch the exact prototype Baileys logs.
 */

import { SessionRecord } from 'libsignal';

const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

interface SessionEntryLike {
  toString(): string;
}

/**
 * Idempotent. Returns true when the redaction hook is in place (installed now
 * or already present), false when libsignal's shape changed and we could not
 * patch — callers must LOUDLY log that case, never swallow it, because it
 * means private key material may reach stdout again.
 */
export function scrubSignalSessionLogs(): boolean {
  const record = SessionRecord as unknown as {
    createEntry?: () => SessionEntryLike;
  };
  if (typeof record.createEntry !== 'function') {
    return false;
  }
  // createEntry() only allocates `{ _chains: {} }` — no I/O, no key material.
  const proto = Object.getPrototypeOf(record.createEntry()) as Record<PropertyKey, unknown>;
  if (typeof proto[INSPECT_CUSTOM] === 'function') {
    return true; // already patched (or upstream fixed it)
  }
  if (typeof proto.toString !== 'function') {
    return false;
  }
  Object.defineProperty(proto, INSPECT_CUSTOM, {
    value(this: SessionEntryLike): string {
      return this.toString();
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return typeof proto[INSPECT_CUSTOM] === 'function';
}
