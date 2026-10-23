import { signConnectorRequest, withTimeout } from '@mcp-socialmedia/shared';

/**
 * The bridge's only HTTP client towards the socialmedia connectors, with a
 * CLOSED list of routes, all GET (DGX-1235 B1.7). Nothing here marks a message
 * as read and nothing sends. CONNECTOR_SHARED_SECRET would open every route of
 * every connector: this list is a restriction of the code, not of the
 * credential (residual risk accepted by security, guarded by
 * sin-lectura.test.ts).
 */
export const RUTAS_CONECTOR: readonly string[] = [
  '/api/v1/me', // MeCache (shared/src/bridge/me-cache.ts): own WhatsApp JID
  '/api/public/history/', // WhatsApp: contract http.whatsapp-connector.public-history.v1
  '/api/public/messages/', // Telegram: contract http.telegram-connector.public-messages.v1
];

export class ConectorNoResponde extends Error {
  constructor(public readonly status?: number) {
    super(status ? `connector answered ${status}` : 'connector did not answer');
    this.name = 'ConectorNoResponde';
  }
}

/** A row of the WhatsApp history route as it comes today (newest first, fromMe always false). */
export interface FilaWhatsapp {
  id?: unknown;
  from?: unknown;
  body?: unknown;
  timestamp?: unknown;
  hasMedia?: unknown;
  type?: unknown;
}

/** The fields of a TelegramMessage the bridge reads. */
export interface FilaTelegram {
  telegramMessageId?: unknown;
  telegramTimestamp?: unknown;
  content?: unknown;
  messageType?: unknown;
  attachments?: Array<{ type?: unknown }>;
  isOutbound?: unknown;
}

export interface ClienteConectoresOptions {
  whatsappUrl: string;
  telegramUrl: string;
  secreto: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export class ClienteConectores {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: ClienteConectoresOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.now = opts.now ?? (() => Date.now());
  }

  async historialWhatsapp(chatId: string, limite: number): Promise<FilaWhatsapp[]> {
    return this.leer(this.opts.whatsappUrl, `${RUTAS_CONECTOR[1]}${encodeURIComponent(chatId)}?limit=${limite}`);
  }

  async mensajesTelegram(chatId: string, limite: number): Promise<FilaTelegram[]> {
    return this.leer(this.opts.telegramUrl, `${RUTAS_CONECTOR[2]}${encodeURIComponent(chatId)}?limit=${limite}`);
  }

  private async leer<T>(base: string, ruta: string): Promise<T[]> {
    if (!RUTAS_CONECTOR.some(r => ruta.startsWith(r))) throw new Error('route outside the closed list');
    const ts = Math.floor(this.now() / 1000);
    // Same as MeCache: a bodyless GET signed over `${ts}:{}`.
    let res: Response;
    try {
      res = await withTimeout(
        this.fetchImpl(`${base.replace(/\/+$/, '')}${ruta}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-Connector-Signature': signConnectorRequest({}, ts, this.opts.secreto),
            'X-Connector-Timestamp': String(ts),
          },
        }),
        this.timeoutMs,
        'connector read'
      );
    } catch {
      throw new ConectorNoResponde();
    }
    if (!res.ok) throw new ConectorNoResponde(res.status);
    const payload = (await res.json().catch(() => null)) as { messages?: unknown } | null;
    if (!payload || !Array.isArray(payload.messages)) throw new ConectorNoResponde(res.status);
    return payload.messages as T[];
  }
}
