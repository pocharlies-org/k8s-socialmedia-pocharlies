/**
 * SC-552 channel adapter — Telegram / mtcute.
 *
 * The telegram connector (connectors/telegram/src/telegram-client.ts) signs
 * in with a single session string fed through the
 * TELEGRAM_SESSION_STRING[_PROFESSIONAL] env Secrets and an in-memory
 * `MemoryStorage`. The channel format is that string as-is; this adapter only
 * wraps/unwraps it for the store's opaque jsonb payload.
 *
 * Phase-1 note: no production flow writes this row yet — moving session
 * strings out of the Secrets is the CTO's secrets-posture call (adopt rows
 * only ever come from the legacy env under CREDENTIAL_STORE_ENABLED, default
 * OFF).
 */
export interface MtcuteSessionPayload {
  sessionString: string;
}

export function serializeMtcuteSession(sessionString: string): MtcuteSessionPayload {
  if (typeof sessionString !== 'string' || sessionString.trim() === '') {
    throw new Error('invalid mtcute session: empty session string');
  }
  return { sessionString };
}

export function deserializeMtcuteSession(payload: unknown): MtcuteSessionPayload {
  const value = (payload as MtcuteSessionPayload | undefined)?.sessionString;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('invalid mtcute session payload: missing `sessionString`');
  }
  return { sessionString: value };
}
