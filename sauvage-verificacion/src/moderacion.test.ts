import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configModeracionDesdeEntorno,
  crearApiModeracion,
  ejecutarModeracion,
  type ConfigModeracion,
  type ModerationApi,
  type ResultadoModeracion,
} from './moderacion';
import { fetchTelegram } from './test-harness';
import type { EstadoDb } from './estado';
import type { Veredicto } from './vision';

/**
 * Vara de la parte B (INFRA-746), contra los criterios del 00-spec:
 *  - C3: cada expulsion con su dm previo; un ban sin dm es un fallo.
 *  - C4: readmision unban → add (o link si la privacidad bloquea el add) y
 *    confirmado SOLO por la lista de participantes.
 *  - C7: la anulacion manual del dueño produce un unico `omitido ID=...
 *    motivo=anulacion_manual` y ningun ban, tampoco en la pasada siguiente.
 *  - Bandera fail-closed: SAUVAGE_MODERATION != "on" no toca a nadie.
 */

interface FilaAccion {
  user_id: string;
  action: string;
  at: string;
  confirmed: boolean;
  motivo: string | null;
}

function fakeDb(opts: {
  veredictos: Array<[string, Veredicto]>;
  acciones?: FilaAccion[];
  /** Reloj determinista para el `at` de las filas nuevas (sin reloj real). */
  reloj?: () => string;
}) {
  const acciones: FilaAccion[] = (opts.acciones ?? []).map(a => ({ ...a }));
  const veredictos: Array<[string, Veredicto]> = [...opts.veredictos];
  const db: EstadoDb = {
    query: async (sql, params) => {
      if (sql.includes('INSERT INTO savage_actions')) {
        acciones.push({
          user_id: String(params?.[0]),
          action: String(params?.[1]),
          at: (opts.reloj ?? (() => new Date().toISOString()))(),
          confirmed: Boolean(params?.[2]),
          motivo: (params?.[3] as string | undefined) ?? null,
        });
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO savage_verdicts')) {
        veredictos.push([String(params?.[1]), params?.[2] as Veredicto]);
        return { rows: [] };
      }
      if (sql.includes('FROM savage_actions')) {
        return { rows: acciones.map(a => ({ ...a })) };
      }
      if (sql.includes('FROM savage_verdicts')) {
        return { rows: veredictos.map(([u, v]) => ({ user_id: u, verdict: v })) };
      }
      throw new Error(`sql no esperado: ${sql}`);
    },
  };
  return { db, acciones, veredictos };
}

interface OpcionesApi {
  enGrupo: string[];
  reauditoria?: Record<string, Veredicto>;
  addMissing?: boolean;
  dentroTrasAdd?: boolean;
  link?: string;
  videoFalla?: boolean;
  /** El dm a estos miembros les responde no-200 (falla el aviso). */
  dmFalla?: string[];
  /** El ban a estos miembros les responde no-200 (falla la expulsión). */
  banFalla?: string[];
}

function fakeApi(o: OpcionesApi) {
  const ops: string[] = [];
  const dms: Array<{ userId: string; texto: string }> = [];
  const api: ModerationApi = {
    participantes: async () => new Set(o.enGrupo),
    async reauditar(userId) {
      ops.push(`reauditar:${userId}`);
      const v = o.reauditoria?.[userId] ?? 'no_auditar';
      return { verdict: v, rawText: `reaudita=${v}` };
    },
    async dm(userId, texto) {
      ops.push(`dm:${userId}`);
      if (o.dmFalla?.includes(userId)) throw new Error(`dm fallo status=500 ID=${userId}`);
      dms.push({ userId, texto });
    },
    async video(userId) {
      ops.push(`video:${userId}`);
      if (o.videoFalla) throw new Error('media/send status=500');
    },
    async ban(userId) {
      ops.push(`ban:${userId}`);
      if (o.banFalla?.includes(userId)) throw new Error(`ban fallo status=503 ID=${userId}`);
    },
    async unban(userId) {
      ops.push(`unban:${userId}`);
    },
    async add(userId) {
      ops.push(`add:${userId}`);
      return { missing: o.addMissing === true };
    },
    async inviteLink() {
      ops.push('invite-export');
      return o.link ?? 'https://t.me/+TEST';
    },
    async esParticipante(userId) {
      ops.push(`participants:${userId}`);
      return o.dentroTrasAdd === true;
    },
  };
  return { api, ops, dms };
}

const cfg: ConfigModeracion = {
  moderation: true,
  group: '-1003365295248',
  account: 'professional',
  connectorProUrl: 'http://connector.invalid/api/v1',
  connectorSecret: 's',
  litellmUrl: 'http://litellm.invalid/v1/chat/completions',
  litellmKey: 'k',
  visionModel: 'm',
  promptVision: 'p',
  guiaTexto: 'GUIA FORMAL DE PASOS',
  guiaVideoUrl: '',
};

/** Captura el log de la pasada (los criterios se verifican con grep del log). */
async function conLogs(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return logs;
}

// ————— Bandera fail-closed —————

test('SAUVAGE_MODERATION off (o cualquier valor que no sea "on") → ninguna accion', async () => {
  for (const valor of [undefined, 'off', 'true', 'ON', '1', '']) {
    const env: NodeJS.ProcessEnv = {
      CONNECTOR_SHARED_SECRET: 's',
      DATABASE_URL: 'postgres://x',
      ...(valor === undefined ? {} : { SAUVAGE_MODERATION: valor }),
    };
    const c = configModeracionDesdeEntorno(env);
    assert.equal(c.moderation, false, `SAUVAGE_MODERATION=${JSON.stringify(valor)}`);
    const { db, acciones } = fakeDb({ veredictos: [['100', 'sin_cara']] });
    const { api, ops } = fakeApi({ enGrupo: ['100'] });
    const logs = await conLogs(async () => {
      const r = await ejecutarModeracion({ ...c, moderation: false }, db, api);
      assert.equal(r.off, true);
    });
    assert.deepEqual(logs, ['moderacion off: ninguna accion']);
    assert.deepEqual(ops, []);
    assert.deepEqual(acciones, []);
  }
});

test('con la bandera on pero sin guia legible, la moderacion no arranca (sin aviso no hay expulsion)', () => {
  assert.throws(
    () =>
      configModeracionDesdeEntorno({
        SAUVAGE_MODERATION: 'on',
        CONNECTOR_SHARED_SECRET: 's',
        DATABASE_URL: 'postgres://x',
        OPENAI_API_KEY: 'k',
        SAUVAGE_GUIA_FILE: join(mkdtempSync(join(tmpdir(), 'sin-guia-')), 'no-existe.md'),
      }),
    /guia de aviso vacia/
  );
  const dir = mkdtempSync(join(tmpdir(), 'guia-'));
  const guia = join(dir, 'guia-dm.md');
  writeFileSync(guia, 'Pasos para poner una foto valida.');
  const c = configModeracionDesdeEntorno({
    SAUVAGE_MODERATION: 'on',
    CONNECTOR_SHARED_SECRET: 's',
    DATABASE_URL: 'postgres://x',
    OPENAI_API_KEY: 'k',
    SAUVAGE_GUIA_FILE: guia,
  });
  assert.equal(c.moderation, true);
  assert.match(c.guiaTexto, /Pasos para poner una foto valida/);
});

// ————— C3: expulsion con aviso —————

test('C3: cada expulsion lleva su dm previo y en este orden (dm antes que ban)', async () => {
  const { db, acciones } = fakeDb({ veredictos: [['100', 'sin_cara']] });
  const { api, ops, dms } = fakeApi({ enGrupo: ['100'] });
  const logs = await conLogs(() => ejecutarModeracion(cfg, db, api).then(() => undefined));
  assert.deepEqual(ops, ['dm:100', 'ban:100']);
  assert.deepEqual(dms[0], { userId: '100', texto: 'GUIA FORMAL DE PASOS' });
  const iDm = logs.findIndex(l => l === 'dm ID=100');
  const iBan = logs.findIndex(l => l === 'ban ID=100');
  assert.ok(iDm >= 0 && iBan >= 0 && iDm < iBan, 'la linea dm va antes que la de ban');
  assert.deepEqual(
    acciones.map(a => [a.user_id, a.action]),
    [['100', 'dm'], ['100', 'ban']]
  );
});

test('C3: el ban no se intenta sin dm registrado (guia ya enviada no se repite)', async () => {
  // Pasada interrumpida entre dm y ban: la siguiente pasa banea sin reenviar la guia.
  const { db, acciones } = fakeDb({
    veredictos: [['100', 'sin_cara']],
    acciones: [{ user_id: '100', action: 'dm', at: '2026-11-01T06:30:00Z', confirmed: false, motivo: null }],
  });
  const { api, ops } = fakeApi({ enGrupo: ['100'] });
  await conLogs(() => ejecutarModeracion(cfg, db, api).then(() => undefined));
  assert.deepEqual(ops, ['ban:100'], 'una guia por usuario mientras no cumpla');
  assert.equal(acciones.filter(a => a.action === 'dm').length, 1);
});

test('dudoso y no_auditar nunca se expulsan (van al informe de Dani)', async () => {
  const { db, acciones } = fakeDb({
    veredictos: [
      ['1', 'dudoso'],
      ['2', 'no_auditar'],
      ['3', 'cara'],
    ],
  });
  const { api, ops } = fakeApi({ enGrupo: ['1', '2', '3'] });
  await conLogs(() => ejecutarModeracion(cfg, db, api).then(() => undefined));
  assert.deepEqual(ops, []);
  assert.deepEqual(acciones, []);
});

test('el video de la guia viaja como media nueva y su fallo no corta el aviso ni el ban', async () => {
  const { db, acciones } = fakeDb({ veredictos: [['100', 'sin_cara']] });
  const { api, ops } = fakeApi({ enGrupo: ['100'], videoFalla: true });
  const logs = await conLogs(() =>
    ejecutarModeracion({ ...cfg, guiaVideoUrl: 'https://files.invalid/guia.mp4' }, db, api).then(
      () => undefined
    )
  );
  // CHAT_FORWARDS_RESTRICTED: media/send con la URL (el conector la descarga
  // y la sube), nunca forward. Su fallo se loggea aparte y el dm cuenta igual.
  assert.deepEqual(ops, ['dm:100', 'video:100', 'ban:100']);
  assert.ok(logs.some(l => l.startsWith('dm_video_fallo ID=100')));
  assert.ok(logs.includes('dm ID=100'));
  assert.ok(logs.includes('ban ID=100'));
  assert.equal(acciones.filter(a => a.action === 'dm').length, 1);
});

// ————— C4: readmision —————

test('C4: readmision unban → add → confirmado=true por la lista de participantes', async () => {
  const { db, acciones, veredictos } = fakeDb({
    veredictos: [],
    acciones: [{ user_id: '200', action: 'ban', at: '2026-10-01T06:30:00Z', confirmed: false, motivo: null }],
  });
  const { api, ops } = fakeApi({ enGrupo: [], reauditoria: { '200': 'cara' }, dentroTrasAdd: true });
  const logs = await conLogs(() => ejecutarModeracion(cfg, db, api).then(() => undefined));
  assert.deepEqual(ops, ['reauditar:200', 'unban:200', 'add:200', 'participants:200']);
  const orden = logs.filter(l => /^(unban|add|link|confirmado) ID=200/.test(l));
  assert.deepEqual(orden, ['unban ID=200', 'add ID=200', 'confirmado ID=200 true']);
  assert.deepEqual(
    acciones.map(a => [a.user_id, a.action, a.confirmed]),
    [
      ['200', 'ban', false],
      ['200', 'unban', false],
      ['200', 'add', false],
      ['200', 'confirmado', true],
    ]
  );
  // La re-auditoria del expulsado queda en savage_verdicts (estado actual).
  assert.deepEqual(veredictos, [['200', 'cara']]);
});

test('C4: add bloqueado por privacidad (missing) cae al enlace de invitacion por DM', async () => {
  const { db, acciones } = fakeDb({
    veredictos: [],
    acciones: [{ user_id: '200', action: 'ban', at: '2026-10-01T06:30:00Z', confirmed: false, motivo: null }],
  });
  const { api, ops, dms } = fakeApi({
    enGrupo: [],
    reauditoria: { '200': 'cara' },
    addMissing: true,
    dentroTrasAdd: true,
    link: 'https://t.me/+ABCdef',
  });
  const logs = await conLogs(() => ejecutarModeracion(cfg, db, api).then(() => undefined));
  assert.deepEqual(ops, ['reauditar:200', 'unban:200', 'add:200', 'invite-export', 'dm:200', 'participants:200']);
  const orden = logs.filter(l => /^(unban|add|link|confirmado) ID=200/.test(l));
  assert.deepEqual(orden, ['unban ID=200', 'add ID=200 missing=true', 'link ID=200', 'confirmado ID=200 true']);
  assert.match(dms[0].texto, /https:\/\/t\.me\/\+ABCdef/);
  assert.ok(acciones.some(a => a.action === 'link'));
});

test('C4: confirmado sale false si la lista de participantes no lo incluye, aunque el add respondiera bien', async () => {
  const { db, acciones } = fakeDb({
    veredictos: [],
    acciones: [{ user_id: '200', action: 'ban', at: '2026-10-01T06:30:00Z', confirmed: false, motivo: null }],
  });
  // add sin missing pero la lista dice que no esta: NUNCA se da por bueno el retorno del add.
  const { api } = fakeApi({ enGrupo: [], reauditoria: { '200': 'cara' }, dentroTrasAdd: false });
  const logs = await conLogs(() => ejecutarModeracion(cfg, db, api).then(() => undefined));
  assert.ok(logs.includes('confirmado ID=200 false'));
  const conf = acciones.find(a => a.action === 'confirmado');
  assert.equal(conf?.confirmed, false);
});

test('expulsado que sigue sin cara (o no auditable) no se readmite', async () => {
  const { db, acciones } = fakeDb({
    veredictos: [],
    acciones: [
      { user_id: '300', action: 'ban', at: '2026-10-01T06:30:00Z', confirmed: false, motivo: null },
      { user_id: '301', action: 'ban', at: '2026-10-01T06:30:00Z', confirmed: false, motivo: null },
    ],
  });
  const { api, ops } = fakeApi({ enGrupo: [], reauditoria: { '300': 'sin_cara', '301': 'dudoso' } });
  const logs = await conLogs(() => ejecutarModeracion(cfg, db, api).then(() => undefined));
  assert.deepEqual(ops, ['reauditar:300', 'reauditar:301']);
  assert.ok(logs.includes('omitido ID=300 motivo=sigue_sin_cara'));
  assert.ok(logs.includes('omitido ID=301 motivo=no_auditable'));
  assert.ok(!acciones.some(a => a.action === 'unban' || a.action === 'add'));
});

// ————— C7: anulacion manual del dueño —————

test('C7: cancelacion registrada → unico omitido motivo=anulacion_manual y ningun ban, ni en la pasada siguiente', async () => {
  const { db, acciones } = fakeDb({
    veredictos: [['400', 'sin_cara']],
    acciones: [
      { user_id: '400', action: 'dm', at: '2026-10-01T06:30:00Z', confirmed: false, motivo: null },
      { user_id: '400', action: 'ban', at: '2026-10-01T06:30:01Z', confirmed: false, motivo: null },
      { user_id: '400', action: 'cancelacion', at: '2026-10-02T10:00:00Z', confirmed: false, motivo: 'dueno' },
    ],
  });
  const { api, ops } = fakeApi({ enGrupo: ['400'] });
  const logs1 = await conLogs(() => ejecutarModeracion(cfg, db, api).then(() => undefined));
  assert.ok(logs1.includes('omitido ID=400 motivo=anulacion_manual'));
  // Pasada siguiente (mismo estado, con el omitido ya registrado): se repite
  // el omitido y sigue sin haber ban (C7).
  const logs2 = await conLogs(() => ejecutarModeracion(cfg, db, api).then(() => undefined));
  assert.ok(logs2.includes('omitido ID=400 motivo=anulacion_manual'));
  assert.deepEqual(ops, []);
  assert.ok(!logs1.concat(logs2).some(l => /^ban ID=400/.test(l)));
  assert.ok(!acciones.some(a => a.user_id === '400' && a.action === 'ban' && a.at > '2026-10-02'));
});

test('C7: el dueño desbaneo y readmitio a mano (ultimo ban del bot y esta dentro) → omitido y ningun ban', async () => {
  const { db, acciones } = fakeDb({
    veredictos: [['401', 'sin_cara']],
    acciones: [{ user_id: '401', action: 'ban', at: '2026-10-01T06:30:00Z', confirmed: false, motivo: null }],
  });
  const { api, ops } = fakeApi({ enGrupo: ['401'] });
  const logs1 = await conLogs(() => ejecutarModeracion(cfg, db, api).then(() => undefined));
  assert.ok(logs1.includes('omitido ID=401 motivo=anulacion_manual'));
  // Y no se repite el ban en la pasada siguiente (el omitido queda registrado).
  const logs2 = await conLogs(() => ejecutarModeracion(cfg, db, api).then(() => undefined));
  assert.ok(logs2.includes('omitido ID=401 motivo=anulacion_manual'));
  assert.deepEqual(ops, []);
  assert.ok(!logs1.concat(logs2).some(l => /^ban ID=401/.test(l)));
  assert.equal(acciones.filter(a => a.action === 'omitido' && a.motivo === 'anulacion_manual').length, 2);
});

// ————— Regresión INFRA-125 (70-qa.md 24-11): fixtures de la pasada medida —————
//
// Las filas que qa midió en producción son los fixtures: los doce expulsados
// del 23-11 con su dm estrictamente anterior, y los tres readmitidos a mano
// por el dueño que el 24-11 salieron `omitido motivo=anulacion_manual`. La
// cadena de readmisión (C4) no tiene caso vivo todavía, así que su garantía
// vive aquí, en CI. Deterministas: reloj falso, cero red.

/** Los doce `user_id` de la tabla C3 de 70-qa.md (pasada del 23-11). */
const DOCE_EXPULSADOS = [
  '1238363311', '1472300639', '1604472888', '1659914741', '1793344338', '5039238512',
  '5052174956', '5364398817', '5526148316', '5757156540', '5803749534', '6036824365',
];

/** Reloj que avanza `pasoMs` en cada llamada: el `at` de las filas es fijo. */
function relojFijo(desde: string, pasoMs: number): () => string {
  let t = Date.parse(desde);
  return () => new Date((t += pasoMs)).toISOString();
}

async function correr(
  cfgUsar: ConfigModeracion,
  db: EstadoDb,
  api: ModerationApi
): Promise<{ r: ResultadoModeracion; logs: string[] }> {
  let r!: ResultadoModeracion;
  const logs = await conLogs(async () => {
    r = await ejecutarModeracion(cfgUsar, db, api);
  });
  return { r, logs };
}

test('C3/C7 (los 12 medidos el 23-11): cada ban con su dm estrictamente anterior para el mismo miembro y CERO bans sin dm', async () => {
  const { db, acciones } = fakeDb({
    veredictos: DOCE_EXPULSADOS.map(id => [id, 'sin_cara'] as [string, Veredicto]),
    reloj: relojFijo('2026-11-23T06:20:17.000Z', 150),
  });
  const { api, ops } = fakeApi({ enGrupo: DOCE_EXPULSADOS });
  const { r } = await correr(cfg, db, api);
  assert.equal(r.dm, 12);
  assert.equal(r.ban, 12);
  for (const id of DOCE_EXPULSADOS) {
    const acts = acciones.filter(a => a.user_id === id);
    assert.deepEqual(
      acts.map(a => a.action),
      ['dm', 'ban'],
      `una sola guia y un solo ban para ${id}`
    );
    assert.ok(
      Date.parse(acts[0].at) < Date.parse(acts[1].at),
      `el dm de ${id} es estrictamente anterior a su ban`
    );
    assert.ok(
      ops.indexOf(`dm:${id}`) < ops.indexOf(`ban:${id}`),
      `el aviso se manda antes que la expulsion de ${id}`
    );
  }
  // La consulta de 70-qa.md «bans SIN dm previo (debe ser 0)»: 0 filas.
  const bansSinDm = DOCE_EXPULSADOS.filter(id => {
    const acts = acciones.filter(a => a.user_id === id);
    const iBan = acts.findIndex(a => a.action === 'ban');
    return iBan !== -1 && !acts.slice(0, iBan).some(a => a.action === 'dm');
  });
  assert.deepEqual(bansSinDm, []);
});

test('C3/C7: en la pasada siguiente los expulsados fuera no reciben guia repetida ni ban repetido', async () => {
  // Pasada 1: dentro del grupo, los doce son expulsados con su aviso.
  const { db, acciones } = fakeDb({
    veredictos: DOCE_EXPULSADOS.map(id => [id, 'sin_cara'] as [string, Veredicto]),
    reloj: relojFijo('2026-11-23T06:20:17.000Z', 150),
  });
  const primera = fakeApi({ enGrupo: DOCE_EXPULSADOS });
  await correr(cfg, db, primera.api);
  // Pasada 2 (24-11): ya fuera, siguen sin foto valida (reauditoria sin_cara).
  const segunda = fakeApi({
    enGrupo: [],
    reauditoria: Object.fromEntries(DOCE_EXPULSADOS.map(id => [id, 'sin_cara'] as [string, Veredicto])),
  });
  const { r } = await correr(cfg, db, segunda.api);
  assert.equal(r.dm, 0, 'una guia por usuario mientras no cumpla: no se reenvia');
  assert.equal(r.ban, 0, 'el ban no se repite: ya estan fuera');
  assert.equal(r.readmitidos, 0);
  assert.ok(segunda.ops.every(o => o.startsWith('reauditar:')));
  assert.equal(
    acciones.filter(a => a.action === 'dm').length,
    12,
    'sigue habiendo exactamente una guia por miembro'
  );
});

test('C3: si el dm falla (no-200) el ban no se intenta: sin aviso registrado no hay expulsion', async () => {
  const { db, acciones } = fakeDb({
    veredictos: [['100', 'sin_cara']],
    reloj: relojFijo('2026-11-23T06:20:17.000Z', 150),
  });
  const { api, ops } = fakeApi({ enGrupo: ['100'], dmFalla: ['100'] });
  await assert.rejects(() => correr(cfg, db, api), /dm fallo status=500/);
  assert.deepEqual(ops, ['dm:100'], 'se intento el aviso y nada mas');
  assert.ok(!acciones.some(a => a.action === 'ban'), 'ni una fila de ban');
  assert.ok(!acciones.some(a => a.action === 'dm'), 'el dm solo se registra si se envio');
});

test('C7 (los 3 del 24-11): readmitidos a mano por el dueno → omitido motivo=anulacion_manual pegajoso y ningun ban repetido', async () => {
  // Filas literales de la tabla C7(b) de 70-qa.md (dm y ban del 23-11, hora UTC).
  const filas23N: FilaAccion[] = [
    { user_id: '1472300639', action: 'dm', at: '2026-11-23T06:20:17.712691Z', confirmed: false, motivo: null },
    { user_id: '1472300639', action: 'ban', at: '2026-11-23T06:20:17.869583Z', confirmed: false, motivo: null },
    { user_id: '5039238512', action: 'dm', at: '2026-11-23T06:20:18.891686Z', confirmed: false, motivo: null },
    { user_id: '5039238512', action: 'ban', at: '2026-11-23T06:20:19.008456Z', confirmed: false, motivo: null },
    { user_id: '6036824365', action: 'dm', at: '2026-11-23T06:20:20.811816Z', confirmed: false, motivo: null },
    { user_id: '6036824365', action: 'ban', at: '2026-11-23T06:20:20.939161Z', confirmed: false, motivo: null },
  ];
  const tres = ['1472300639', '5039238512', '6036824365'];
  const { db, acciones } = fakeDb({
    veredictos: tres.map(id => [id, 'sin_cara'] as [string, Veredicto]),
    acciones: filas23N,
    reloj: relojFijo('2026-11-24T07:19:47.000Z', 70),
  });
  // El dueno los volvio a meter dentro: estan en el grupo sin readmision del bot.
  const { api, ops } = fakeApi({ enGrupo: tres });
  const p1 = await correr(cfg, db, api);
  const p2 = await correr(cfg, db, api); // pasada siguiente: la anulacion es pegajosa
  for (const id of tres) {
    const linea = `omitido ID=${id} motivo=anulacion_manual`;
    assert.equal(p1.logs.filter(l => l === linea).length, 1, `omitido en la pasada del 24-11 para ${id}`);
    assert.equal(p2.logs.filter(l => l === linea).length, 1, `omitido tambien en la siguiente para ${id}`);
  }
  assert.deepEqual(ops, [], 'la anulacion manual no toca a nadie');
  assert.deepEqual(
    acciones.filter(a => a.action === 'ban' && a.at >= '2026-11-24'),
    [],
    'ningun ban nuevo: los tres del 23-11 no se repiten'
  );
  assert.equal(acciones.filter(a => a.motivo === 'anulacion_manual').length, 6);
});

test('C4: un add que responde bien pero cuyo miembro no esta en la lista NO cuenta como readmitido (readmitidos=0)', async () => {
  const { db, acciones } = fakeDb({
    veredictos: [],
    acciones: [{ user_id: '200', action: 'ban', at: '2026-10-01T06:30:00Z', confirmed: false, motivo: null }],
    reloj: relojFijo('2026-11-24T07:20:00.000Z', 50),
  });
  // add sin `missing` (responde bien) y la lista de participantes dice que no esta.
  const { api, ops } = fakeApi({ enGrupo: [], reauditoria: { '200': 'cara' }, dentroTrasAdd: false });
  const { r } = await correr(cfg, db, api);
  assert.equal(r.readmitidos, 0, 'el retorno del add nunca da por readmitido a nadie');
  assert.equal(ops.indexOf('participants:200') > ops.indexOf('add:200'), true, 'la confirmacion se pide despues del add');
  const conf = acciones.find(a => a.action === 'confirmado');
  assert.equal(conf?.confirmed, false);
});

test('C4: la confirmacion se lee del GET /chats/:id/participants del conector, paginando igual que Telegram', async () => {
  // Arnes compartido: el paginador con tope real de 200 por pagina.
  const ids = Array.from({ length: 250 }, (_, i) => String(700000 + i));
  const llamadas: string[] = [];
  const api = crearApiModeracion(cfg, fetchTelegram({ ids, llamadas }));
  assert.equal(await api.esParticipante('700240'), true, 'en la pagina 2 tambien se le encuentra');
  assert.equal(await api.esParticipante('999999'), false);
  assert.ok(
    llamadas.every(u => /\/chats\/-1003365295248\/participants\?limit=200&offset=\d+$/.test(u)),
    `la confirmacion es el GET de participantes, no otra ruta: ${llamadas.join(' | ')}`
  );
  assert.ok(llamadas.length >= 2, 'recorre todas las paginas (tope real de 200 por llamada)');
});

// ————— INFRA-1561: cobertura de candidatos y cierre del dm pendiente —————
//
// Forma real medida (nota-developer-cobertura-salvage.md / 70-qa.md 24-11):
// 6468280801 recibió su dm el 23-11 a las 06:20:21 UTC y su ban no llegó a
// ejecutarse nunca; los doce miembros cuyo user_id (TEXT, orden de string) cae
// DETRÁS del suyo no recibieron ni dm ni ban en toda su historia. La causa no
// es de dónde salen los candidatos (veredictosActuales ya toma el último
// veredicto por miembro, sin corte de fecha): es que la excepción del ban del
// 6468280801 abortaba la pasada entera y silenciaba a todos los que venían
// después en el orden de iteración.

/** El dm medido del 6468280801 (23-11 06:20:21 UTC), sin ban detrás. */
const FILA_DM_6468: FilaAccion = {
  user_id: '6468280801',
  action: 'dm',
  at: '2026-11-23T06:20:21.000Z',
  confirmed: false,
  motivo: null,
};

test('C1 (INFRA-1561): el fallo al expulsar a un miembro no deja sin acción a los candidatos que vienen después', async () => {
  // Un candidato de la pasada anterior (721652387: sin_cara, dentro, cero
  // acciones) iterado detrás del miembro cuyo ban falla (6468280801).
  const { db, acciones } = fakeDb({
    veredictos: [
      ['6468280801', 'sin_cara'],
      ['721652387', 'sin_cara'],
    ],
    acciones: [FILA_DM_6468],
    reloj: relojFijo('2026-11-25T06:20:00.000Z', 150),
  });
  const { api } = fakeApi({
    enGrupo: ['6468280801', '721652387'],
    banFalla: ['6468280801'],
  });
  // La pasada reporta el fallo (main-moderacion sale 1) pero NO abandona a los demás.
  await assert.rejects(() => correr(cfg, db, api), /ban fallo status=503 ID=6468280801/);
  assert.deepEqual(
    acciones.filter(a => a.user_id === '721652387').map(a => a.action),
    ['dm', 'ban'],
    'el candidato de la pasada anterior recibe su dm y luego su ban pese al fallo del otro'
  );
  // C2: el aviso enviado sin expulsión queda registrado como pendiente del diseño.
  assert.ok(
    acciones.some(a => a.user_id === '6468280801' && a.action === 'pendiente' && a.motivo === 'ban_fallo'),
    'el dm enviado sin ban queda registrado con el estado pendiente'
  );
  // La guía no se reenvía al pendiente (una guía por usuario mientras no cumpla).
  assert.equal(acciones.filter(a => a.user_id === '6468280801' && a.action === 'dm').length, 1);
});

test('C2 (INFRA-1561): el pendiente se cierra en la pasada siguiente expulsando, sin repetir la guía', async () => {
  const { db, acciones } = fakeDb({
    veredictos: [['6468280801', 'sin_cara']],
    acciones: [FILA_DM_6468],
    reloj: relojFijo('2026-11-25T06:20:00.000Z', 150),
  });
  const primera = fakeApi({ enGrupo: ['6468280801'], banFalla: ['6468280801'] });
  await assert.rejects(() => correr(cfg, db, primera.api), /ban fallo status=503/);
  // Pasada siguiente: el ban ya responde bien → se cierra expulsando.
  const segunda = fakeApi({ enGrupo: ['6468280801'] });
  const { r } = await correr(cfg, db, segunda.api);
  assert.deepEqual(segunda.ops, ['ban:6468280801'], 'solo el ban: la guía no se reenvía');
  assert.equal(r.dm, 0, 'cero guías nuevas en la pasada que cierra el pendiente');
  assert.equal(acciones.filter(a => a.action === 'dm').length, 1, 'sigue habiendo una sola guía');
});

test('C2 (INFRA-1561): el pendiente cuyo último veredicto ya es cara se cierra como cumplido sin tocarle', async () => {
  const { db, acciones } = fakeDb({
    veredictos: [['6468280801', 'cara']],
    acciones: [FILA_DM_6468],
    reloj: relojFijo('2026-11-25T06:20:00.000Z', 150),
  });
  const { api, ops } = fakeApi({ enGrupo: ['6468280801'] });
  const logs = await conLogs(() => ejecutarModeracion(cfg, db, api).then(() => undefined));
  assert.deepEqual(ops, [], 'cumplió: ni guía nueva ni expulsión');
  assert.ok(logs.some(l => /^pendiente-cerrado ID=6468280801/.test(l)));
  assert.ok(
    acciones.some(a => a.user_id === '6468280801' && a.action === 'pendiente' && a.motivo === 'cumplido'),
    'el cierre queda registrado'
  );
});

test('readmitido por el bot que vuelve a quedarse sin cara recibe guia nueva y su ban', async () => {
  const { db, acciones } = fakeDb({
    veredictos: [['500', 'sin_cara']],
    acciones: [
      { user_id: '500', action: 'dm', at: '2026-10-01T06:30:00Z', confirmed: false, motivo: null },
      { user_id: '500', action: 'ban', at: '2026-10-01T06:30:01Z', confirmed: false, motivo: null },
      { user_id: '500', action: 'unban', at: '2026-10-05T06:30:00Z', confirmed: false, motivo: null },
      { user_id: '500', action: 'add', at: '2026-10-05T06:30:01Z', confirmed: false, motivo: null },
      { user_id: '500', action: 'confirmado', at: '2026-10-05T06:30:02Z', confirmed: true, motivo: null },
    ],
  });
  const { api, ops } = fakeApi({ enGrupo: ['500'] });
  await conLogs(() => ejecutarModeracion(cfg, db, api).then(() => undefined));
  // La ultima readmision confirmada reinicia la cuenta de guias: dm nuevo + ban.
  assert.deepEqual(ops, ['dm:500', 'ban:500']);
  assert.equal(acciones.filter(a => a.action === 'dm').length, 2);
});
