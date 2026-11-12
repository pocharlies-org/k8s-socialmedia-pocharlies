import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config';

const BASE: Record<string, string> = {
  WA_CONNECTOR_URL: 'http://whatsapp-connector-professional:3001',
  TG_CONNECTOR_URL: 'http://telegram-connector-professional:3002',
  CONNECTOR_SHARED_SECRET: 'fixture-connector-shared-secret',
  CORE_URL: 'http://correo-machine.correo.svc.cluster.local',
  CORREO_PRODUCTOR_WA_ID: 'correo-bridge-wa',
  CORREO_PRODUCTOR_WA_SECRET: 'p'.repeat(32),
  CORREO_PRODUCTOR_TG_ID: 'correo-bridge-tg',
  CORREO_PRODUCTOR_TG_SECRET: 'q'.repeat(32),
  CORREO_CONECTOR_WA_ID: 'wa-professional',
  CORREO_CONECTOR_WA_SECRET: 'w'.repeat(32),
  CORREO_CONECTOR_TG_ID: 'tg-professional',
  CORREO_CONECTOR_TG_SECRET: 't'.repeat(32),
};
const OPCIONALES = ['NATS_URL', 'NATS_QUEUE_GROUP', 'PORT', 'ENABLE_OUTBOUND', 'HERMES_WAKE_ENABLED', 'SYNAPSE_EVENTOS_URL', 'SYNAPSE_EVENTOS_SECRET', 'WAKE_STALE_MAX_MIN', 'WAKE_DEBOUNCE_MIN'];

function con(env: Record<string, string | undefined>, fn: () => void): void {
  const keys = [...Object.keys(BASE), ...OPCIONALES];
  const previous = keys.map(k => process.env[k]);
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
    fn();
  } finally {
    keys.forEach((k, i) => (previous[i] === undefined ? delete process.env[k] : (process.env[k] = previous[i])));
  }
}

test('fail-fast: every required variable is required', () => {
  for (const falta of Object.keys(BASE)) {
    con({ ...BASE, [falta]: undefined }, () => assert.throws(loadConfig, new RegExp(falta)));
  }
});

test('defaults: own queue group, port 8080', () => {
  con(BASE, () => {
    const c = loadConfig();
    assert.equal(c.natsQueueGroup, 'correo-bridge');
    assert.equal(c.port, 8080);
    assert.equal(c.eventosUrl, null);
    assert.equal(c.eventosSecreto, null);
    assert.equal(c.wakeStaleMaxMs, 30 * 60_000);
    assert.equal(c.wakeDebounceMs, 5 * 60_000);
    assert.deepEqual([...c.secretosConector.keys()].sort(), ['tg-professional', 'wa-professional']);
    assert.equal(c.conectorPorCanal.whatsapp, 'wa-professional');
    assert.equal(c.conectorPorCanal.telegram, 'tg-professional');
    assert.deepEqual(c.productores.get('wa-professional'), { id: 'correo-bridge-wa', secreto: 'p'.repeat(32) });
    assert.deepEqual(c.productores.get('tg-professional'), { id: 'correo-bridge-tg', secreto: 'q'.repeat(32) });
  });
});

test('the queue group can never be synapse-bridge (it would steal its messages)', () => {
  con({ ...BASE, NATS_QUEUE_GROUP: 'synapse-bridge' }, () => assert.throws(loadConfig, /NATS_QUEUE_GROUP/));
});

test('key ids follow correo.connector.v1 and each channel has its prefix', () => {
  for (const [k, v] of [['CORREO_CONECTOR_WA_ID', 'tg-professional'], ['CORREO_CONECTOR_TG_ID', 'wa-professional'], ['CORREO_CONECTOR_WA_ID', 'wa-PRO'], ['CORREO_PRODUCTOR_WA_ID', 'Correo Bridge'], ['CORREO_PRODUCTOR_TG_ID', 'correo-bridge-wa']]) {
    con({ ...BASE, [k]: v }, () => assert.throws(loadConfig, new RegExp(k)));
  }
});

test('the keys are all distinct and long enough (security condition 4), checked at start', () => {
  con({ ...BASE, CORREO_CONECTOR_TG_SECRET: BASE.CORREO_CONECTOR_WA_SECRET }, () => assert.throws(loadConfig, /distinct/));
  con({ ...BASE, CORREO_PRODUCTOR_WA_SECRET: BASE.CORREO_CONECTOR_WA_SECRET }, () => assert.throws(loadConfig, /distinct/));
  con({ ...BASE, CORREO_PRODUCTOR_TG_SECRET: BASE.CORREO_PRODUCTOR_WA_SECRET }, () => assert.throws(loadConfig, /distinct/));
  con({ ...BASE, CORREO_PRODUCTOR_TG_SECRET: BASE.CONNECTOR_SHARED_SECRET.padEnd(32, 'x'), CONNECTOR_SHARED_SECRET: BASE.CONNECTOR_SHARED_SECRET.padEnd(32, 'x') }, () => assert.throws(loadConfig, /distinct/));
  con({ ...BASE, CORREO_CONECTOR_WA_SECRET: 'corto' }, () => assert.throws(loadConfig, /CORREO_CONECTOR_WA_SECRET/));
});

test('URLs are validated', () => {
  for (const k of ['WA_CONNECTOR_URL', 'TG_CONNECTOR_URL', 'CORE_URL']) {
    for (const v of ['file:///x', 'http://user:pw@host', 'http://host/?q=1']) {
      con({ ...BASE, [k]: v }, () => assert.throws(loadConfig, new RegExp(k)));
    }
  }
  con({ ...BASE, CORE_URL: 'http://correo-machine/prefijo' }, () => assert.throws(loadConfig, /CORE_URL/));
});

test('B2: ENABLE_OUTBOUND is off unless it says exactly true; anything else refuses to start', () => {
  con(BASE, () => assert.equal(loadConfig().enableOutbound, false));
  con({ ...BASE, ENABLE_OUTBOUND: 'false' }, () => assert.equal(loadConfig().enableOutbound, false));
  con({ ...BASE, ENABLE_OUTBOUND: 'true' }, () => assert.equal(loadConfig().enableOutbound, true));
  for (const v of ['TRUE', '1', 'yes', 'on']) {
    con({ ...BASE, ENABLE_OUTBOUND: v }, () => assert.throws(loadConfig, /ENABLE_OUTBOUND/));
  }
});

test('SC-5382: the wake is off by default; when on, the gateway base and its producer key are required', () => {
  const WAKE = { SYNAPSE_EVENTOS_URL: 'http://synapse-gateway.synapse.svc.cluster.local:18790', SYNAPSE_EVENTOS_SECRET: 's'.repeat(40) };
  con({ ...BASE, ...WAKE }, () => {
    const c = loadConfig();
    assert.equal(c.eventosUrl, null);
  });
  con({ ...BASE, HERMES_WAKE_ENABLED: 'true' }, () => assert.throws(loadConfig, /SYNAPSE_EVENTOS_URL/));
  con({ ...BASE, HERMES_WAKE_ENABLED: 'true', SYNAPSE_EVENTOS_SECRET: WAKE.SYNAPSE_EVENTOS_SECRET }, () => assert.throws(loadConfig, /SYNAPSE_EVENTOS_URL/));
  con({ ...BASE, HERMES_WAKE_ENABLED: 'true', SYNAPSE_EVENTOS_URL: WAKE.SYNAPSE_EVENTOS_URL }, () => assert.throws(loadConfig, /SYNAPSE_EVENTOS_SECRET/));
  con({ ...BASE, HERMES_WAKE_ENABLED: 'true', ...WAKE }, () => {
    const c = loadConfig();
    assert.equal(c.eventosUrl, WAKE.SYNAPSE_EVENTOS_URL);
    assert.equal(c.eventosSecreto, WAKE.SYNAPSE_EVENTOS_SECRET);
  });
  // The path is the gateway's (/eventos), never config: a base with a path is a wrong URL.
  con({ ...BASE, HERMES_WAKE_ENABLED: 'true', SYNAPSE_EVENTOS_URL: `${WAKE.SYNAPSE_EVENTOS_URL}/eventos`, SYNAPSE_EVENTOS_SECRET: WAKE.SYNAPSE_EVENTOS_SECRET }, () => assert.throws(loadConfig, /SYNAPSE_EVENTOS_URL/));
  con({ ...BASE, HERMES_WAKE_ENABLED: 'true', SYNAPSE_EVENTOS_URL: WAKE.SYNAPSE_EVENTOS_URL, SYNAPSE_EVENTOS_SECRET: 'corta' }, () => assert.throws(loadConfig, /SYNAPSE_EVENTOS_SECRET/));
  // Security condition: the producer key of the bus is its own, never a reused one.
  con({ ...BASE, HERMES_WAKE_ENABLED: 'true', SYNAPSE_EVENTOS_URL: WAKE.SYNAPSE_EVENTOS_URL, SYNAPSE_EVENTOS_SECRET: BASE.CONNECTOR_SHARED_SECRET }, () => assert.throws(loadConfig, /SYNAPSE_EVENTOS_SECRET/));
  con({ ...BASE, HERMES_WAKE_ENABLED: 'si', ...WAKE }, () => assert.throws(loadConfig, /HERMES_WAKE_ENABLED/));
});

test('DGX-1550: the burst window is WAKE_DEBOUNCE_MIN minutes, 5 by default, positive only', () => {
  con({ ...BASE, WAKE_DEBOUNCE_MIN: '2' }, () => assert.equal(loadConfig().wakeDebounceMs, 2 * 60_000));
  for (const v of ['0', '-1', 'cinco']) {
    con({ ...BASE, WAKE_DEBOUNCE_MIN: v }, () => assert.throws(loadConfig, /WAKE_DEBOUNCE_MIN/));
  }
});
