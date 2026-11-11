import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectorClient, descargarFoto, listarParticipantes, type FetchFn, type FetchResponse } from './connector-client';
import { cargarEstado, auditadosHoy, guardarVeredicto, type EstadoDb } from './estado';
import { veredictoDeVision, type Veredicto } from './vision';

/**
 * Pasada mecanica del bot Sauvage (INFRA-745), ejecutada por la sesion de
 * opencode del CronJob (el prompt manda ejecutar este script; el agente
 * revisa despues los casos dudosos y lanza `informe.ts`).
 *
 * Solo lectura sobre los miembros: ninguna expulsion, ningun DM a un miembro,
 * ningun cambio de participantes (lo afirma `sin-mtproto.test.ts`). El unico
 * envio del bot es el informe a Dani, en `informe.ts`.
 *
 * Formas de log exigidas por los criterios del spec:
 *   estado cargado: N veredictos previos      (C6)
 *   veredicto ID=<id> verdict=<v>             (C2, una linea por miembro)
 *   barrido total=N auditados=X no_auditados=Y (C2)
 */

export interface ConfigPasada {
  group: string;
  account: string;
  connectorProUrl: string;
  connectorSecret: string;
  litellmUrl: string;
  litellmKey: string;
  visionModel: string;
  promptVision: string;
  fotosDir: string;
}

export function configDesdeEntorno(env: NodeJS.ProcessEnv): ConfigPasada {
  const promptFile = env.SAUVAGE_PROMPT_FILE ?? '/sauvage-prompt/prompt-vision.md';
  let promptVision = '';
  try {
    promptVision = readFileSync(promptFile, 'utf8');
  } catch {
    promptVision = '';
  }
  if (!promptVision.trim()) {
    throw new Error(`criterio de vision vacio o ilegible en ${promptFile}`);
  }
  const secret = env.CONNECTOR_SHARED_SECRET ?? '';
  if (!secret) throw new Error('CONNECTOR_SHARED_SECRET vacio');
  const key = env.OPENAI_API_KEY ?? '';
  if (!key) throw new Error('OPENAI_API_KEY vacio (clave socialmedia de LiteLLM)');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL vacio');
  return {
    group: env.SAUVAGE_GROUP_ID ?? '-1003365295248',
    account: env.SAUVAGE_ACCOUNT ?? 'professional',
    connectorProUrl:
      env.SAUVAGE_CONNECTOR_PRO_URL ??
      'http://telegram-connector-professional.whatsapp-mcp.svc.cluster.local:3002/api/v1',
    connectorSecret: secret,
    litellmUrl:
      env.LITELLM_CHAT_COMPLETIONS_URL ??
      'http://litellm.litellm.svc.cluster.local:4000/v1/chat/completions',
    litellmKey: key,
    visionModel: env.SAUVAGE_VISION_MODEL ?? 'qwen38-flash-next-uncensored',
    promptVision,
    fotosDir: env.SAUVAGE_FOTOS_DIR ?? '/tmp/sauvage-fotos',
  };
}

export interface ResultadoPasada {
  total: number;
  auditados: number;
  noAuditados: number;
}

/**
 * Ejecuta la pasada. `db` inyectable para tests (misma interfaz que pg.Pool).
 */
const fetchNativa: FetchFn = (u, i) => fetch(u, i) as unknown as Promise<FetchResponse>;

export async function ejecutarPasada(
  cfg: ConfigPasada,
  db: EstadoDb,
  fetchImpl: FetchFn = fetchNativa
): Promise<ResultadoPasada> {
  await cargarEstado(db);
  const pro = new ConnectorClient({ baseUrl: cfg.connectorProUrl, sharedSecret: cfg.connectorSecret, fetchImpl });

  const participantes = await listarParticipantes(pro, cfg.group);
  const total = participantes.length;
  const yaHoy = await auditadosHoy(db, cfg.account);
  mkdirSync(cfg.fotosDir, { recursive: true });

  let auditados = 0;
  let noAuditados = 0;

  for (const p of participantes) {
    if (yaHoy.has(p.id)) {
      console.log(`omitido ID=${p.id} motivo=ya_auditado_hoy`);
      continue;
    }
    let verdict: Veredicto;
    let rawText: string;
    const foto = await descargarFoto(pro, p.id);
    if (!foto.ok) {
      if (foto.clase === 'sin_foto') {
        // Sin foto visible para la cuenta (o privacidad) = dudoso (spec).
        verdict = 'dudoso';
        rawText = 'sin foto visible para la cuenta (404)';
      } else if (foto.clase === 'timeout') {
        // Corte de 20 s del conector (SKIRM-101): no auditar hoy, nunca incumplimiento.
        verdict = 'no_auditar';
        rawText = 'descarga de foto cortada a los 20 s (504)';
      } else {
        verdict = 'no_auditar';
        rawText = `descarga de fallo (status=${foto.status})`;
      }
    } else {
      const ruta = join(cfg.fotosDir, `${p.id}.jpg`);
      writeFileSync(ruta, Buffer.from(foto.base64, 'base64'));
      const v = await veredictoDeVision({
        url: cfg.litellmUrl,
        apiKey: cfg.litellmKey,
        model: cfg.visionModel,
        photoBase64: foto.base64,
        prompt: cfg.promptVision,
        fetchImpl,
      });
      verdict = v.verdict;
      rawText = v.fallo ? `${v.fallo} :: ${v.rawText}` : v.rawText;
    }
    await guardarVeredicto(db, { account: cfg.account, userId: p.id, verdict, rawText });
    console.log(`veredicto ID=${p.id} verdict=${verdict}`);
    if (verdict === 'no_auditar') noAuditados++;
    else auditados++;
  }

  console.log(`barrido total=${total} auditados=${auditados} no_auditados=${noAuditados}`);
  return { total, auditados, noAuditados };
}

