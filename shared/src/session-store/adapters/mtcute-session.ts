/**
 * SC-552 channel adapter — Telegram / mtcute.
 *
 * The telegram connector (connectors/telegram/src/telegram-client.ts) signs
 * in with a single session string fed through the
 * TELEGRAM_SESSION_STRING[_PROFESSIONAL] env Secrets and an in-memory
 * `MemoryStorage`. The channel format is that string as-is; this adapter only
 * wraps/unwraps it for the store's opaque jsonb payload.
 *
 * SC-705 part 4 (SC-1145): the telegram connector
 * (connectors/telegram/src/credential-session.ts) is the production writer —
 * it resolves this payload through the resolver (adopt rows only ever come
 * from the legacy env under CREDENTIAL_STORE_ENABLED, default OFF) and
 * write-backs the exported mtcute session on every storage persist. The
 * house accounts (personal/professional) never take this path: no
 * CREDENTIAL_SESSION_KEY → legacy env, no row (SC-705 binding decision 2).
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
