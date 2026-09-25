/**
 * SC-1229 (SC-1197 P4b): the real mtcute client the telegram-pairing pool
 * drives — the implementation of the `PairingTelegramClient` seam
 * (./session-pool.ts), the counterpart of the whatsapp pool's BaileysClient.
 *
 * Deliberately NOT the house connector's TelegramClientWrapper: that class
 * wires message handlers, NATS publishing and dashboard notifications into
 * `connect()` (ingest), and the pairing pool must not ingest anything in v1
 * (design D1 "sin ingesta en v1", applied to Telegram by analogy). This is a
 * bare @mtcute client over MemoryStorage — the same storage class the house
 * connector uses, without the SC-1145 persist hook: the pool owns its row
 * writes (after authorization and after the lazy load), not a live socket.
 *
 * Login is `signInQr` — present in the pinned @mtcute/node 0.29.7
 * (highlevel/methods/auth/sign-in-qr): the QR flow with Telegram's own URL
 * rotation and 2FA (the password callback is resolved lazily, and a rejected
 * password re-invokes it — the pool maps that to its `password` state).
 *
 * The QR URL never touches stdout: signInQr only hands it to onUrlUpdated
 * (verified against the installed package — no log call in sign-in-qr.js),
 * and this file logs nothing.
 */
import { MemoryStorage, TelegramClient } from '@mtcute/node';
import type { User } from '@mtcute/node';
import type {
  PairingTelegramClient,
  TelegramAuthHandlers,
  TelegramPairingMe,
} from './session-pool';

export interface PairingTelegramClientConfig {
  apiId: number;
  apiHash: string;
}

/** mtcute User → the public identity shape. */
export function telegramPairingMe(user: User): TelegramPairingMe {
  return { id: String(user.id), username: user.username || null };
}

export class PairingTelegramClientImpl implements PairingTelegramClient {
  private readonly client: TelegramClient;

  constructor(config: PairingTelegramClientConfig) {
    this.client = new TelegramClient({
      apiId: config.apiId,
      apiHash: config.apiHash,
      storage: new MemoryStorage(),
    });
  }

  async startPairing(handlers: TelegramAuthHandlers): Promise<TelegramPairingMe> {
    const user = await this.client.signInQr({
      onUrlUpdated: (url, expires) => handlers.onQr(url, expires),
      onQrScanned: () => handlers.onQrScanned(),
      // A function (not a constant): mtcute calls it when the flow hits
      // SESSION_PASSWORD_NEEDED, and again after a rejected password.
      password: () => handlers.password(),
      invalidPasswordCallback: () => handlers.onPasswordInvalid(),
      abortSignal: handlers.signal,
    });
    return telegramPairingMe(user);
  }

  async loadSession(sessionString: string): Promise<TelegramPairingMe> {
    await this.client.importSession(sessionString);
    // Throws an RpcError (AUTH_KEY_UNREGISTERED / SESSION_REVOKED / ...) on
    // a session the server no longer accepts — the pool classifies it with
    // isSessionInvalidatedError (SC-1145) and deletes the row.
    const me = await this.client.getMe();
    return telegramPairingMe(me);
  }

  async exportSessionString(): Promise<string> {
    return this.client.exportSession();
  }

  async disconnect(): Promise<void> {
    await this.client.destroy();
  }
}

/** Factory matching PairingTelegramClientFactory. */
export function createPairingTelegramClient(
  config: PairingTelegramClientConfig
): (sessionKey: string) => PairingTelegramClient {
  return () => new PairingTelegramClientImpl(config);
}
