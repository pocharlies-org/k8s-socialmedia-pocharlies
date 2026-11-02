import { ConnectorClient } from './connector-client';
import type { EstadoDb } from './estado';
import { auditadosDesde } from './estado';

/**
 * Informe diario a Dani (C5), por la cuenta personal.
 *
 * Cuatro apartados, con esos nombres exactos (los busca el criterio):
 *   incumplidores — sin_cara de hoy: candidatos a expulsion cuando exista B.
 *   reingresos    — cero hasta que exista la parte B (INFRA-746).
 *   pendientes    — no_auditar de hoy: sin veredicto usable (504, modelo, no
 *                   parseable); se reintentan en la proxima pasada.
 *   ambiguedades  — dudoso de hoy: sin foto visible para la cuenta o foto que
 *                   el modelo no pudo decidir.
 * El total del informe es el de miembros auditados hoy y cuadra con la linea
 * `barrido total=...` de la misma pasada (C2/C5).
 */

export interface ApartadosInforme {
  total: number;
  incumplidores: string[];
  reingresos: string[];
  pendientes: string[];
  ambiguedades: string[];
}

export function construirInforme(d: ApartadosInforme): string {
  const lista = (xs: string[]) => (xs.length ? xs.map(x => `  - ${x}`).join('\n') : '  - (ninguno)');
  return [
    `Informe Sauvage · verificacion de cara visible · total=${d.total}`,
    '',
    `incumplidores (${d.incumplidores.length}):`,
    lista(d.incumplidores),
    '',
    `reingresos (${d.reingresos.length}):`,
    lista(d.reingresos),
    '',
    `pendientes (${d.pendientes.length}):`,
    lista(d.pendientes),
    '',
    `ambiguedades (${d.ambiguedades.length}):`,
    lista(d.ambiguedades),
  ].join('\n');
}

/**
 * Reune los apartados desde el estado de hoy. `reingresos` es cero por
 * construccion hasta INFRA-746: no hay expulsiones que readmitir.
 */
export async function reunirInforme(
  db: EstadoDb,
  account: string,
  nombres: Map<string, string>
): Promise<ApartadosInforme> {
  const hoy = await auditadosDesde(db, account);
  const nombre = (id: string) => nombres.get(id) ?? id;
  return {
    total: hoy.length,
    incumplidores: hoy.filter(v => v.verdict === 'sin_cara').map(v => nombre(v.userId)),
    reingresos: [],
    pendientes: hoy.filter(v => v.verdict === 'no_auditar').map(v => nombre(v.userId)),
    ambiguedades: hoy.filter(v => v.verdict === 'dudoso').map(v => nombre(v.userId)),
  };
}

/**
 * Envio por la cuenta personal: POST /api/v1/messages/:chatId (contrato
 * http.telegram-connector.messages-send.v1). `chatId` = el chat de Dani; por
 * defecto el self-chat de la cuenta (GET /me), que es donde Dani se ve sus
 * avisos. SAUVAGE_REPORT_CHAT_ID lo cambia si el operador prefiere otro chat.
 */
export async function chatInforme(
  personal: ConnectorClient,
  chatIdEnv: string | undefined
): Promise<string> {
  if (chatIdEnv && chatIdEnv.trim()) return chatIdEnv.trim();
  const res = await personal.get('/me');
  const me = res.json as { id?: unknown } | null;
  if (res.status !== 200 || !me || me.id === undefined) {
    throw new Error(`no se pudo resolver el chat propio de personal (status=${res.status})`);
  }
  return String(me.id);
}

export async function enviarInforme(
  personal: ConnectorClient,
  chatId: string,
  texto: string
): Promise<void> {
  const res = await personal.post(`/messages/${encodeURIComponent(chatId)}`, { text: texto });
  if (res.status !== 200) {
    throw new Error(`informe no enviado status=${res.status} ${JSON.stringify(res.json ?? '')}`);
  }
  console.log(`informe enviado chat=${chatId} total=${texto.length}`);
}
