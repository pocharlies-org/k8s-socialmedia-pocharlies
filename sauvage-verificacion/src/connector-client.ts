import { generateHMACSignature } from '@mcp-socialmedia/shared';

/**
 * Cliente HTTP fino del conector de Telegram (INFRA-745).
 *
 * El bot NO abre clientes MTProto: la sesion es propiedad del proceso del
 * conector (veredicto del architect, INFRA-125). Todo lo que hace con Telegram
 * pasa por las rutas firmadas de `connectors/telegram/src/api/controller.ts`:
 *   GET  /chats/:id/participants  (barrido, http.telegram-connector.chats-participants.v1)
 *   GET  /peers/:id/photo         (foto,     http.telegram-connector.peers-photo.v1)
 *   GET  /me                      (chat de Dani = self-chat de la cuenta personal)
 *   POST /messages/:chatId        (informe,  http.telegram-connector.messages-send.v1)
 *
 * La firma es la de la casa (`generateHMACSignature`, shared/src/crypto/
 * encryption.ts): `sha256=<hex>` de `<ts>:<JSON del cuerpo>` en
 * `x-connector-signature` + `x-connector-timestamp`. Un GET no tiene cuerpo:
 * firma `{}`, igual que `providerGet` del mcp-server (ARCHITECTURE.md §2).
 */

export interface RespuestaConnector {
  status: number;
  /** JSON parseado cuando el conector contesto JSON; `null` si no. */
  json: unknown;
  /** `data` en base64 de una ruta de descarga (peers/photo); `null` si no. */
  dataBase64: string | null;
}

export interface FetchResponse {
  status: number;
  text(): Promise<string>;
}

export type FetchFn = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<FetchResponse>;

export interface ConnectorClientOptions {
  /** Base ya con /api/v1, p. ej. http://telegram-connector.whatsapp-mcp.svc.cluster.local:3002/api/v1 */
  baseUrl: string;
  sharedSecret: string;
  fetchImpl?: FetchFn;
  /** epoch segundos; inyectable para tests. */
  now?: () => number;
}

export class ConnectorClient {
  private readonly baseUrl: string;
  private readonly sharedSecret: string;
  private readonly fetchImpl: FetchFn;
  private readonly now: () => number;

  constructor(opts: ConnectorClientOptions) {
    if (!opts.sharedSecret) {
      throw new Error('CONNECTOR_SHARED_SECRET vacio: el bot no arranca sin la firma');
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.sharedSecret = opts.sharedSecret;
    this.fetchImpl = (opts.fetchImpl ?? ((u, i) => fetch(u, i) as unknown as Promise<FetchResponse>));
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private headers(body: unknown): Record<string, string> {
    const ts = this.now();
    return {
      'x-connector-timestamp': String(ts),
      'x-connector-signature': generateHMACSignature(body, ts, this.sharedSecret),
    };
  }

  private async call(path: string, method: string, body: unknown): Promise<RespuestaConnector> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...this.headers(body),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: unknown = null;
    let dataBase64: string | null = null;
    try {
      json = JSON.parse(text);
      const maybe = json as { data?: unknown };
      if (maybe && typeof maybe === 'object' && typeof maybe.data === 'string') {
        dataBase64 = maybe.data;
      }
    } catch {
      json = null;
    }
    return { status: res.status, json, dataBase64 };
  }

  get(path: string): Promise<RespuestaConnector> {
    return this.call(path, 'GET', {});
  }

  post(path: string, body: unknown): Promise<RespuestaConnector> {
    return this.call(path, 'POST', body);
  }
}

export interface Participante {
  id: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
  isBot: boolean;
}

/**
 * Barrido completo: `?limit=1000` cubre los ~350 miembros del grupo verificado
 * (getParticipants pagina internamente con getChatMembers, telegram-client.ts).
 */
export async function listarParticipantes(
  client: ConnectorClient,
  groupId: string,
  limit = 1000
): Promise<Participante[]> {
  const res = await client.get(`/chats/${encodeURIComponent(groupId)}/participants?limit=${limit}`);
  if (res.status !== 200) {
    throw new Error(`barrido fallo status=${res.status} ${JSON.stringify(res.json ?? '')}`);
  }
  const participants = (res.json as { participants?: unknown })?.participants;
  if (!Array.isArray(participants)) {
    throw new Error('barrido: respuesta sin array participants');
  }
  return participants as Participante[];
}

export type ResultadoFoto =
  | { ok: true; base64: string }
  /** 404 = sin foto visible para la cuenta (o privacidad) → dudoso. */
  | { ok: false; clase: 'sin_foto' }
  /** 504 = corte de 20 s del conector (SKIRM-101) → no_auditar. */
  | { ok: false; clase: 'timeout' }
  | { ok: false; clase: 'error'; status: number };

export async function descargarFoto(client: ConnectorClient, userId: string): Promise<ResultadoFoto> {
  const res = await client.get(`/peers/${encodeURIComponent(userId)}/photo`);
  if (res.status === 200 && res.dataBase64) return { ok: true, base64: res.dataBase64 };
  if (res.status === 404) return { ok: false, clase: 'sin_foto' };
  if (res.status === 504) return { ok: false, clase: 'timeout' };
  return { ok: false, clase: 'error', status: res.status };
}
