/**
 * Baileys parks an app-state collection when a mutation is encrypted with a sync key it
 * does not have, and then waits for the phone to push APP_STATE_SYNC_KEY_SHARE — but it
 * never ASKS for the key. WA Web does ask (AppStateSyncKeyRequest to the primary device),
 * and without that ask a linked device that missed one key share loses every later
 * archive / pin / mute of those collections (dgx-messages showed chats pinned forever:
 * the unpin mutation rode on a collection blocked since v58).
 *
 * The connector fills the gap: when Baileys logs the park, ask the primary device for
 * the missing key once per socket. Baileys resumes the parked collection on its own when
 * the key arrives (creds.update myAppStateKeyId → resync of blockedCollections).
 */
import { proto } from '@whiskeysockets/baileys';

/** Baileys' getKey error: `failed to find key "AAAAAAvU" to decode mutation` (base64 key id).
 * The quotes may arrive escaped — the park line reaches us as a JSON.stringified pino object. */
const MISSING_KEY_RE = /failed to find key ["\\]+([A-Za-z0-9+/=]+)/g;

/** The key ids one pino warn call (the park line carries the error stack) names as missing. */
export function extractMissingKeyIds(args: unknown[]): string[] {
  const text = args
    .map(a => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
  return [...new Set([...text.matchAll(MISSING_KEY_RE)].map(m => m[1]))];
}

export interface AppStateKeyRequestSocket {
  sendMessage(jid: string, content: Record<string, unknown>): Promise<unknown>;
}

/**
 * Ask the primary device for `keyIds`, skipping those already `requested` (the park line
 * repeats every retry cycle; a fresh socket —a reconnect— asks again, the phone may have
 * been offline). A failed request is forgotten so the next park retries it.
 */
export async function requestMissingAppStateKeys(
  sock: AppStateKeyRequestSocket,
  primaryJid: string,
  keyIds: string[],
  requested: Set<string>,
  log: (line: string) => void = console.warn
): Promise<void> {
  for (const id of keyIds) {
    if (requested.has(id)) continue;
    requested.add(id);
    try {
      await sock.sendMessage(primaryJid, {
        message: {
          protocolMessage: {
            type: proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_REQUEST,
            appStateSyncKeyRequest: { keyIds: [Buffer.from(id, 'base64')] },
          },
        },
      });
      log(`app-state key ${id} requested from the primary device`);
    } catch (e) {
      requested.delete(id);
      log(`app-state key request for ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
