import { signConnectorRequest, withTimeout } from '@mcp-socialmedia/shared';

/**
 * The bridge's only HTTP client towards the socialmedia connectors, with two
 * CLOSED lists of routes: the reads, all GET (DGX-1235 B1.7), and the two text
 * sends, POST, that only POST /envios reaches (B2). Nothing here marks a
 * message as read. CONNECTOR_SHARED_SECRET would open every route of every
 * connector: these lists are a restriction of the code, not of the credential
 * (residual risk accepted by security, guarded by sin-lectura.test.ts).
 */
export const RUTAS_CONECTOR: readonly string[] = [
  '/api/v1/me', // MeCache (shared/src/bridge/me-cache.ts): own WhatsApp JID
  '/api/public/history/', // WhatsApp: contract http.whatsapp-connector.public-history.v1
  '/api/public/messages/', // Telegram: contract http.telegram-connector.public-messages.v1
];

export const RUTAS_ENVIO: readonly string[] = [
  '/api/v1/messages/send', // WhatsApp: messages-send + http.whatsapp-connector.send-idempotency.v1
  '/api/v1/messages/', // Telegram: messages-send.v1 + http.telegram-connector.send-idempotency.v1
];

/** What a connector answered to a send: its status and its JSON (null if none). */
export interface RespuestaEnvio {
  status: number;
  cuerpo: Record<string, unknown> | null;
}

// The WhatsApp send route requires a sendToken; it is not the idempotency key
// (send-idempotency.v1 keys only on Idempotency-Key).
const SEND_TOKEN = 'correo-bridge';

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
  /** A send waits longer than a read, but under the core's 20 s for the whole POST /envios. */
  envioTimeoutMs?: number;
  now?: () => number;
}

export class ClienteConectores {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly envioTimeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: ClienteConectoresOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.envioTimeoutMs = opts.envioTimeoutMs ?? 15000;
    this.now = opts.now ?? (() => Date.now());
  }

  async historialWhatsapp(chatId: string, limite: number): Promise<FilaWhatsapp[]> {
    return this.leer(this.opts.whatsappUrl, `${RUTAS_CONECTOR[1]}${encodeURIComponent(chatId)}?limit=${limite}`);
  }

  async mensajesTelegram(chatId: string, limite: number): Promise<FilaTelegram[]> {
    return this.leer(this.opts.telegramUrl, `${RUTAS_CONECTOR[2]}${encodeURIComponent(chatId)}?limit=${limite}`);
  }

  /** WhatsApp takes the canonical id (`…@c.us`, `…@lid`) as its conversationId as is (measured, envios.test.ts). */
  async enviarWhatsapp(conversationId: string, texto: string, clave: string): Promise<RespuestaEnvio> {
    return this.enviar(this.opts.whatsappUrl, RUTAS_ENVIO[0], { sendToken: SEND_TOKEN, conversationId, content: texto }, clave);
  }

  /** Telegram: a private chat's id is the user's id, the canonical identity. */
  async enviarTelegram(chatId: string, texto: string, clave: string): Promise<RespuestaEnvio> {
    return this.enviar(this.opts.telegramUrl, `${RUTAS_ENVIO[1]}${encodeURIComponent(chatId)}`, { text: texto }, clave);
  }

  /** One signed POST with the key as Idempotency-Key. No answer (network, timeout) throws ConectorNoResponde. */
  private async enviar(base: string, ruta: string, cuerpo: Record<string, string>, clave: string): Promise<RespuestaEnvio> {
    if (!RUTAS_ENVIO.some(r => ruta.startsWith(r))) throw new Error('route outside the closed list');
    const res = await this.pedir(base, ruta, 'POST', cuerpo, { 'Idempotency-Key': clave }, this.envioTimeoutMs);
    const json = (await res.json().catch(() => null)) as unknown;
    return { status: res.status, cuerpo: json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null };
  }

  private async leer<T>(base: string, ruta: string): Promise<T[]> {
    if (!RUTAS_CONECTOR.some(r => ruta.startsWith(r))) throw new Error('route outside the closed list');
    const res = await this.pedir(base, ruta, 'GET', null, {}, this.timeoutMs);
    if (!res.ok) throw new ConectorNoResponde(res.status);
    const payload = (await res.json().catch(() => null)) as { messages?: unknown } | null;
    if (!payload || !Array.isArray(payload.messages)) throw new ConectorNoResponde(res.status);
    return payload.messages as T[];
  }

  /**
   * The house connector HMAC over `${ts}:${JSON body}`; a bodyless GET signs
   * `${ts}:{}` like MeCache. Only leer() and enviar() call it, after their list check.
   */
  private async pedir(
    base: string,
    ruta: string,
    method: 'GET' | 'POST',
    cuerpo: Record<string, string> | null,
    extra: Record<string, string>,
    timeoutMs: number
  ): Promise<Response> {
    const ts = Math.floor(this.now() / 1000);
    try {
      return await withTimeout(
        this.fetchImpl(`${base.replace(/\/+$/, '')}${ruta}`, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...extra,
            'X-Connector-Signature': signConnectorRequest(cuerpo ?? {}, ts, this.opts.secreto),
            'X-Connector-Timestamp': String(ts),
          },
          ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
        }),
        timeoutMs,
        `connector ${method}`
      );
    } catch {
      throw new ConectorNoResponde();
    }
  }
}
