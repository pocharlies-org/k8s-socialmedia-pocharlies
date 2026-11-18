import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configModeracionDesdeEntorno,
  ejecutarModeracion,
  type ConfigModeracion,
  type ModerationApi,
} from './moderacion';
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

function fakeDb(opts: { veredictos: Array<[string, Veredicto]>; acciones?: FilaAccion[] }) {
  const acciones: FilaAccion[] = (opts.acciones ?? []).map(a => ({ ...a }));
  const veredictos: Array<[string, Veredicto]> = [...opts.veredictos];
  const db: EstadoDb = {
    query: async (sql, params) => {
      if (sql.includes('INSERT INTO savage_actions')) {
        acciones.push({
          user_id: String(params?.[0]),
          action: String(params?.[1]),
          at: new Date().toISOString(),
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
      dms.push({ userId, texto });
    },
    async video(userId) {
      ops.push(`video:${userId}`);
      if (o.videoFalla) throw new Error('media/send status=500');
    },
    async ban(userId) {
      ops.push(`ban:${userId}`);
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
