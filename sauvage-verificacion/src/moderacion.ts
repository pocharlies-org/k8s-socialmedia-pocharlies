import { readFileSync } from 'node:fs';
import { ConnectorClient, descargarFoto, listarParticipantes, type FetchFn } from './connector-client';
import {
  accionesPorUsuario,
  guardarVeredicto,
  registrarAccion,
  veredictosActuales,
  type Accion,
  type EstadoDb,
} from './estado';
import { veredictoDeVision, type Veredicto } from './vision';

/**
 * Moderacion del bot Sauvage (INFRA-746, parte B de INFRA-125).
 *
 * Detras de la bandera `SAUVAGE_MODERATION` (fail-closed, patron
 * ENABLE_OUTBOUND de la casa): cualquier valor que no sea exactamente `on` no
 * toca a nadie. La activacion es el flip a `on` en k8s/overlays/prod, paso del
 * runbook (docs/sauvage-verificacion.md); `suspend` del CronJob pausa la pasada
 * entera y `EMERGENCY_DISABLE_SENDING` corta los envios del conector.
 *
 * Todo pasa por las rutas HTTP del conector `professional` (el bot no abre
 * clientes MTProto: lo afirma sin-mtproto.test.ts):
 *   aviso DM        POST /messages/:chatId        (texto) + POST /messages/media/send (video)
 *   expulsion       POST /chats/:id/ban            (nueva, chats-ban.v1)
 *   readmision      POST /chats/:id/unban (nueva) → POST /chats/:id/members
 *                   (chats-members.v1, la existente) → si `missing` (privacidad
 *                   del objetivo) POST /chats/:id/invite-export (nueva) y el
 *                   enlace por DM. La confirmacion es SIEMPRE la lista de
 *                   participantes (GET /chats/:id/participants), nunca el
 *                   retorno del add.
 *
 * Reglas del spec:
 *  - Solo se expulsa a quien el veredicto actual marca `sin_cara`; `dudoso` y
 *    `no_auditar` nunca se expulsan (van al informe de Dani).
 *  - Cada expulsion lleva su DM previo (C3): el ban no se intenta si no hay
 *    una accion `dm` registrada para el miembro. Una guia por usuario mientras
 *    no cumpla (no se repite el aviso entre pasadas).
 *  - El grupo tiene CHAT_FORWARDS_RESTRICTED: el video de la guia viaja como
 *    media nueva (media/send con la URL; el conector la descarga y la sube),
 *    nunca como forward.
 *  - Anulacion manual del dueño (C7): cancelacion registrada, o ultimo `ban`
 *    del bot y el miembro esta otra vez dentro → `omitido ... motivo=
 *    anulacion_manual` y NUNCA se repite el ban.
 *
 * Formas de log exigidas por los criterios (grep del 00-spec):
 *   dm ID= | ban ID= | unban ID= | add ID= | link ID= | confirmado ID= |
 *   omitido ID=... motivo=...
 */

export interface ConfigModeracion {
  moderation: boolean;
  group: string;
  account: string;
  connectorProUrl: string;
  connectorSecret: string;
  litellmUrl: string;
  litellmKey: string;
  visionModel: string;
  promptVision: string;
  guiaTexto: string;
  /** URL del video explicativo ('' = guia solo texto). */
  guiaVideoUrl: string;
}

export function configModeracionDesdeEntorno(env: NodeJS.ProcessEnv): ConfigModeracion {
  const moderation = env.SAUVAGE_MODERATION === 'on';
  const secret = env.CONNECTOR_SHARED_SECRET ?? '';
  if (!secret) throw new Error('CONNECTOR_SHARED_SECRET vacio');
  const guiaFile = env.SAUVAGE_GUIA_FILE ?? '/sauvage-prompt/guia-dm.md';
  let guiaTexto = '';
  try {
    guiaTexto = readFileSync(guiaFile, 'utf8');
  } catch {
    guiaTexto = '';
  }
  if (moderation && !guiaTexto.trim()) {
    // Fail-closed: sin guia no se avisa, y sin aviso no se expulsa (C3).
    throw new Error(`guia de aviso vacia o ilegible en ${guiaFile}: moderacion no arranca`);
  }
  const key = env.OPENAI_API_KEY ?? '';
  if (moderation && !key) throw new Error('OPENAI_API_KEY vacio (re-auditoria de expulsados)');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL vacio');
  return {
    moderation,
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
    promptVision: (() => {
      const f = env.SAUVAGE_PROMPT_FILE ?? '/sauvage-prompt/prompt-vision.md';
      try {
        return readFileSync(f, 'utf8');
      } catch {
        return '';
      }
    })(),
    guiaTexto,
    guiaVideoUrl: env.SAUVAGE_GUIA_VIDEO_URL ?? '',
  };
}

/** Cara del conector que usa la moderacion. Inyectable para los tests. */
export interface ModerationApi {
  /** Ids actuales del grupo (GET /chats/:id/participants). */
  participantes(): Promise<Set<string>>;
  /** Foto + vision de un miembro (tambien de los que ya no estan dentro). */
  reauditar(userId: string): Promise<{ verdict: Veredicto; rawText: string }>;
  dm(userId: string, texto: string): Promise<void>;
  /** Video de la guia como media nueva (el grupo no admite forwards). */
  video(userId: string): Promise<void>;
  ban(userId: string): Promise<void>;
  unban(userId: string): Promise<void>;
  /** `missing: true` = el objetivo lo bloquea su privacidad → hay que mandar enlace. */
  add(userId: string): Promise<{ missing: boolean }>;
  inviteLink(): Promise<string>;
  /** Confirmacion: la lista de participantes, NUNCA el retorno del add. */
  esParticipante(userId: string): Promise<boolean>;
}

export interface ResultadoModeracion {
  off: boolean;
  dm: number;
  ban: number;
  readmitidos: number;
  omitidos: number;
}

function ultimoIndice(acts: Accion[], p: (a: Accion) => boolean): number {
  for (let i = acts.length - 1; i >= 0; i--) if (p(acts[i])) return i;
  return -1;
}

/**
 * Hay guia enviada para el incumplimiento actual? Las acciones posteriores a
 * la ultima readmision confirmada son las que cuentan (un readmitido que
 * vuelve a quedarse sin cara recibe su guia de nuevo).
 */
function guiaYaEnviada(acts: Accion[]): boolean {
  const desde = ultimoIndice(acts, a => a.action === 'confirmado' && a.confirmed);
  return acts.slice(desde + 1).some(a => a.action === 'dm');
}

export async function ejecutarModeracion(
  cfg: ConfigModeracion,
  db: EstadoDb,
  api: ModerationApi
): Promise<ResultadoModeracion> {
  const res: ResultadoModeracion = { off: false, dm: 0, ban: 0, readmitidos: 0, omitidos: 0 };

  if (!cfg.moderation) {
    console.log('moderacion off: ninguna accion');
    res.off = true;
    return res;
  }

  const enGrupo = await api.participantes();
  const veredictos = await veredictosActuales(db, cfg.account);
  const acciones = await accionesPorUsuario(db);

  // A) sin_cara dentro del grupo: aviso con guia y expulsion, una vez por usuario.
  for (const [userId, verdict] of veredictos) {
    if (verdict !== 'sin_cara' || !enGrupo.has(userId)) continue;
    const acts = acciones.get(userId) ?? [];
    const idxBan = ultimoIndice(acts, a => a.action === 'ban');
    // Accion posterior al ultimo ban del bot (o sin ban previo).
    const trasElBan = (p: (a: Accion) => boolean): boolean =>
      ultimoIndice(
        acts,
        a => p(a) && (idxBan === -1 || Date.parse(a.at) >= Date.parse(acts[idxBan].at))
      ) !== -1;
    // Anulacion manual (C7), pegajosa: cancelacion registrada, un omitido por
    // anulacion ya emitido (la pasada siguiente vuelve a omitir y NUNCA
    // repite el ban), o el miembro esta otra vez dentro sin que el bot lo
    // hubiera readmitido (el dueno lo desbaneo/readmitio a mano).
    const reingresoDelBot = trasElBan(
      a =>
        a.action === 'unban' ||
        a.action === 'add' ||
        (a.action === 'confirmado' && a.confirmed)
    );
    const duenoReadmitio = idxBan !== -1 && !reingresoDelBot;
    const anulacion =
      trasElBan(a => a.action === 'cancelacion') ||
      trasElBan(a => a.action === 'omitido' && a.motivo === 'anulacion_manual') ||
      duenoReadmitio;
    if (anulacion) {
      console.log(`omitido ID=${userId} motivo=anulacion_manual`);
      await registrarAccion(db, { userId, action: 'omitido', motivo: 'anulacion_manual' });
      res.omitidos++;
      continue;
    }
    // C3: el ban no se intenta sin su dm registrado. Si la guia ya esta enviada
    // (pasada interrumpida entre dm y ban) no se repite: una guia por usuario
    // mientras no cumpla.
    if (!guiaYaEnviada(acts)) {
      await api.dm(userId, cfg.guiaTexto);
      if (cfg.guiaVideoUrl) {
        try {
          await api.video(userId);
        } catch (e) {
          // La guia escrita ya esta enviada: el video es complemento, no corta el aviso.
          console.log(`dm_video_fallo ID=${userId} ${String(e)}`);
        }
      }
      console.log(`dm ID=${userId}`);
      await registrarAccion(db, { userId, action: 'dm' });
      res.dm++;
    }
    await api.ban(userId);
    console.log(`ban ID=${userId}`);
    await registrarAccion(db, { userId, action: 'ban' });
    res.ban++;
  }

  // B) expulsados (ban del bot sin readmision confirmada todavia): re-auditar
  // la foto cada pasada; si ahora es valida, readmitir. Un miembro que el
  // dueno volvio a meter dentro lo registra el caso A como anulacion manual.
  for (const [userId, acts] of acciones) {
    const idxBan = ultimoIndice(acts, a => a.action === 'ban');
    if (idxBan === -1) continue;
    if (enGrupo.has(userId)) continue;
    const trasElBan = (p: (a: Accion) => boolean): boolean =>
      ultimoIndice(
        acts,
        a => p(a) && Date.parse(a.at) >= Date.parse(acts[idxBan].at)
      ) !== -1;
    // Ya readmitido y confirmado, o anulado por el dueño: no se toca.
    if (
      trasElBan(
        a =>
          (a.action === 'confirmado' && a.confirmed) ||
          a.action === 'cancelacion' ||
          (a.action === 'omitido' && a.motivo === 'anulacion_manual')
      )
    ) {
      continue;
    }
    const v = await api.reauditar(userId);
    await guardarVeredicto(db, { account: cfg.account, userId, verdict: v.verdict, rawText: v.rawText });
    if (v.verdict !== 'cara') {
      const motivo = v.verdict === 'sin_cara' ? 'sigue_sin_cara' : 'no_auditable';
      console.log(`omitido ID=${userId} motivo=${motivo}`);
      await registrarAccion(db, { userId, action: 'omitido', motivo });
      res.omitidos++;
      continue;
    }
    await api.unban(userId);
    console.log(`unban ID=${userId}`);
    await registrarAccion(db, { userId, action: 'unban' });
    const { missing } = await api.add(userId);
    console.log(`add ID=${userId}${missing ? ' missing=true' : ''}`);
    await registrarAccion(db, { userId, action: 'add', motivo: missing ? 'missing' : null });
    if (missing) {
      const link = await api.inviteLink();
      await api.dm(
        userId,
        `Tu privacidad impide anadirte al grupo directamente. Entra con este enlace de invitacion: ${link}`
      );
      console.log(`link ID=${userId}`);
      await registrarAccion(db, { userId, action: 'link' });
    }
    // Confirmacion SOLO por la lista de participantes (C4).
    const dentro = await api.esParticipante(userId);
    console.log(`confirmado ID=${userId} ${dentro}`);
    await registrarAccion(db, { userId, action: 'confirmado', confirmed: dentro });
    if (dentro) res.readmitidos++;
  }

  console.log(
    `moderacion dm=${res.dm} ban=${res.ban} readmitidos=${res.readmitidos} omitidos=${res.omitidos}`
  );
  return res;
}

/** Implementacion de produccion: todo por las rutas firmadas del conector. */
export function crearApiModeracion(
  cfg: ConfigModeracion,
  fetchImpl: FetchFn
): ModerationApi {
  const pro = new ConnectorClient({
    baseUrl: cfg.connectorProUrl,
    sharedSecret: cfg.connectorSecret,
    fetchImpl,
  });
  const chat = encodeURIComponent(cfg.group);
  const ok = (r: { status: number; json: unknown }, que: string): unknown => {
    if (r.status !== 200) throw new Error(`${que} fallo status=${r.status} ${JSON.stringify(r.json ?? '')}`);
    return r.json;
  };
  return {
    async participantes() {
      const ps = await listarParticipantes(pro, cfg.group);
      return new Set(ps.map(p => p.id));
    },
    async reauditar(userId) {
      const foto = await descargarFoto(pro, userId);
      if (!foto.ok) {
        if (foto.clase === 'sin_foto') return { verdict: 'dudoso', rawText: 'sin foto visible para la cuenta (404)' };
        if (foto.clase === 'timeout') return { verdict: 'no_auditar', rawText: 'descarga de foto cortada a los 20 s (504)' };
        return { verdict: 'no_auditar', rawText: `descarga de fallo (status=${foto.status})` };
      }
      const v = await veredictoDeVision({
        url: cfg.litellmUrl,
        apiKey: cfg.litellmKey,
        model: cfg.visionModel,
        photoBase64: foto.base64,
        prompt: cfg.promptVision,
        fetchImpl,
      });
      return { verdict: v.verdict, rawText: v.fallo ? `${v.fallo} :: ${v.rawText}` : v.rawText };
    },
    async dm(userId, texto) {
      ok(await pro.post(`/messages/${encodeURIComponent(userId)}`, { text: texto }), 'dm');
    },
    async video(userId) {
      // filePath admite URL (el conector la descarga y la sube como media
      // nueva): el grupo tiene CHAT_FORWARDS_RESTRICTED y un forward fallaria.
      ok(
        await pro.post('/messages/media/send', { chatId: userId, filePath: cfg.guiaVideoUrl }),
        'video'
      );
    },
    async ban(userId) {
      ok(await pro.post(`/chats/${chat}/ban`, { userId }), 'ban');
    },
    async unban(userId) {
      ok(await pro.post(`/chats/${chat}/unban`, { userId }), 'unban');
    },
    async add(userId) {
      const json = ok(await pro.post(`/chats/${chat}/members`, { members: [userId] }), 'add') as {
        missing?: unknown;
      };
      return { missing: Array.isArray(json?.missing) && json.missing.length > 0 };
    },
    async inviteLink() {
      const json = ok(await pro.post(`/chats/${chat}/invite-export`, {}), 'invite-export') as {
        link?: unknown;
      };
      if (typeof json?.link !== 'string' || !json.link) throw new Error('invite-export sin link');
      return json.link;
    },
    async esParticipante(userId) {
      const ps = await listarParticipantes(pro, cfg.group);
      return ps.some(p => p.id === userId);
    },
  };
}
