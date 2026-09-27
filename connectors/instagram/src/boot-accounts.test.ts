/**
 * SC-1258 — P0 para C10: tolerar cero cuentas de env con el store ON.
 *
 * Criterio C1:
 *  - flag ON + env de cuentas vacío → loadAccounts NO aborta (0 cuentas
 *    legacy, log claro), el conector arranca, /health responde 200 y la ruta
 *    por actor servida por el store funciona con filas fake del store.
 *  - flag OFF + env vacío → se conserva el `exit(1)` histórico. El spy de
 *    `onFatal` es exactamente el camino que en producción ejecuta
 *    `logger.error + process.exit(1)` (ver main.ts `die` por defecto).
 *
 * Criterio C2 (no regresión): con cuentas presentes el resultado es idéntico
 * con el flag ON o OFF — mismas claves, mismos tokens, sin abort.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type {
  CredentialChannel,
  CredentialStore,
  StoredCredential,
} from '@mcp-socialmedia/shared';
import { createInstagramApp, loadAccounts } from './main';

/** Env without a single account field — the exact state C10 leaves behind. */
const EMPTY_ACCOUNTS_ENV = {
  INSTAGRAM_ACCOUNTS: '',
  INSTAGRAM_ACCESS_TOKEN: '',
} as NodeJS.ProcessEnv;

class FakeStore implements CredentialStore {
  rows = new Map<string, StoredCredential>();
  reads = 0;

  seed(key: string, payload: Record<string, unknown>): void {
    this.rows.set(`${key}/instagram`, {
      sessionKey: key,
      channel: 'instagram',
      payload: payload as StoredCredential['payload'],
      updatedAt: new Date(),
    });
  }
  async get(sessionKey: string, channel: CredentialChannel): Promise<StoredCredential | null> {
    this.reads++;
    return this.rows.get(`${sessionKey}/${channel}`) ?? null;
  }
  async put(
    sessionKey: string,
    channel: CredentialChannel,
    payload: Record<string, unknown>
  ): Promise<void> {
    this.rows.set(`${sessionKey}/${channel}`, {
      sessionKey,
      channel,
      payload: payload as StoredCredential['payload'],
      updatedAt: new Date(),
    });
  }
  async delete(sessionKey: string, channel: CredentialChannel): Promise<void> {
    this.rows.delete(`${sessionKey}/${channel}`);
  }
}

async function listen(app: Awaited<ReturnType<typeof createInstagramApp>>): Promise<{
  server: Server;
  base: string;
}> {
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

test('flag ON + env de cuentas vacío → arranca con 0 legacy y log claro (C1)', () => {
  const infos: string[] = [];
  let fatalCalls = 0;
  const accounts = loadAccounts({
    env: EMPTY_ACCOUNTS_ENV,
    storeEnabled: true,
    onFatal: () => {
      fatalCalls++;
    },
    info: msg => infos.push(msg),
  });
  assert.equal(fatalCalls, 0, 'con el store ON cero cuentas NO es fatal');
  assert.equal(accounts.size, 0);
  assert.ok(
    infos.some(m => m.includes('0 legacy account(s), credential-store ENABLED')),
    `log claro ausente: ${JSON.stringify(infos)}`
  );
});

test('flag OFF + env vacío → se conserva el abort histórico (C1)', () => {
  // Sin onFatal inyectado, loadAccounts ejecuta el default: logger.error +
  // process.exit(1). El spy prueba que ESE camino se toma (es el mismo que
  // aborta el proceso en producción).
  const fatal: string[] = [];
  const accounts = loadAccounts({
    env: EMPTY_ACCOUNTS_ENV,
    storeEnabled: false,
    onFatal: msg => fatal.push(msg),
  });
  assert.equal(fatal.length, 1);
  assert.match(fatal[0], /No accounts configured\. Set INSTAGRAM_ACCOUNTS or INSTAGRAM_ACCESS_TOKEN\./);
  assert.equal(accounts.size, 0);

  // INSTAGRAM_ACCOUNTS malformado (enumera cuentas sin token) cae bajo la
  // misma regla: fatal con flag OFF, válido con flag ON.
  const malformed = { INSTAGRAM_ACCOUNTS: 'skirmshop,barbelpapis' } as NodeJS.ProcessEnv;
  const fatalOff: string[] = [];
  loadAccounts({ env: malformed, storeEnabled: false, onFatal: msg => fatalOff.push(msg) });
  assert.equal(fatalOff.length, 1);
  assert.match(fatalOff[0], /No valid accounts configured\./);
  const infos: string[] = [];
  const on = loadAccounts({ env: malformed, storeEnabled: true, onFatal: () => {}, info: m => infos.push(m) });
  assert.equal(on.size, 0);
  assert.ok(infos.some(m => m.includes('credential-store ENABLED')));
});

test('C2 no regresión: con cuentas presentes, flag ON y OFF dan el mismo mapa', () => {
  const env = {
    INSTAGRAM_ACCOUNTS: 'skirmshop, barbelpapis',
    INSTAGRAM_SKIRMSHOP_ACCESS_TOKEN: 'tok-a',
    INSTAGRAM_SKIRMSHOP_BUSINESS_ACCOUNT_ID: 'biz-a',
    INSTAGRAM_BARBELPAPIS_ACCESS_TOKEN: 'tok-b',
    INSTAGRAM_BARBELPAPIS_BUSINESS_ACCOUNT_ID: 'biz-b',
  } as NodeJS.ProcessEnv;
  let fatal = 0;
  const off = loadAccounts({ env, storeEnabled: false, onFatal: () => fatal++ });
  const on = loadAccounts({ env, storeEnabled: true, onFatal: () => fatal++ });
  assert.equal(fatal, 0);
  for (const accounts of [off, on]) {
    assert.deepEqual([...accounts.keys()], ['skirmshop', 'barbelpapis']);
    assert.equal(accounts.get('skirmshop')?.config.accessToken, 'tok-a');
    assert.equal(accounts.get('barbelpapis')?.config.businessAccountId, 'biz-b');
  }
});

test('boot con store ON y 0 cuentas: /health 200 y ruta por actor sirve desde el store (C1)', async () => {
  const originalFetch = globalThis.fetch;
  const profileCalls: string[] = [];
  try {
    // Instagram Graph stub: getProfile responde con el token que resolvió el store.
    // Sólo interceptamos las URLs de Meta — el test sigue llamando a /health y
    // a las rutas del conector con el fetch real.
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (!u.includes('graph.instagram.com') && !u.includes('graph.facebook.com')) {
        return originalFetch(url as never, init as never);
      }
      profileCalls.push(u);
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: '17841444094675941', username: 'mi_cuenta', followers_count: 7 }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;

    const store = new FakeStore();
    store.seed('u-123:mi_cuenta', {
      accessToken: 'EAAL-store-token',
      businessAccountId: '17841444094675941',
      username: 'mi_cuenta',
      issuedAt: Date.now() - 3 * 24 * 3600 * 1000,
      expiresAt: Date.now() + 57 * 24 * 3600 * 1000,
    });

    const accounts = loadAccounts({
      env: EMPTY_ACCOUNTS_ENV,
      storeEnabled: true,
      onFatal: () => assert.fail('no debía abortar con el store ON'),
      info: () => {},
    });
    assert.equal(accounts.size, 0);

    const app = await createInstagramApp({
      env: { ...EMPTY_ACCOUNTS_ENV, CREDENTIAL_STORE_ENABLED: 'true' },
      accounts,
      credentialStore: store,
      publisher: { publish: () => {} },
    });
    const { server, base } = await listen(app);
    try {
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);
      const body = (await health.json()) as Record<string, unknown>;
      assert.equal(body.status, 'ok');
      assert.deepEqual(body.accounts, {}, '/health con 0 cuentas legacy debe ser un objeto vacío');

      // Ruta por actor: sin filas legacy, sólo el store puede servirla.
      const profile = await fetch(`${base}/api/v1/mi_cuenta/profile`, {
        headers: { 'x-user-sub': 'u-123' },
      });
      const profileText = await profile.text();
      assert.equal(profile.status, 200, profileText);
      const prof = JSON.parse(profileText) as { username: string };
      assert.equal(prof.username, 'mi_cuenta');
      assert.equal(store.reads, 1, 'la petición debe haber leído exactamente la fila del store');
      assert.ok(
        profileCalls.some(u => u.includes('access_token=EAAL-store-token')),
        `el perfil debe servirse con el token de la fila del store: ${JSON.stringify(profileCalls)}`
      );

      // Un sub sin fila sigue recibiendo el error explícito (SC-1194 criterio 4).
      const denied = await fetch(`${base}/api/v1/mi_cuenta/profile`, {
        headers: { 'x-user-sub': 'pm-test-sin-fila' },
      });
      assert.equal(denied.status, 400);
      const deniedBody = (await denied.json()) as { error: { code: string } };
      assert.equal(deniedBody.error.code, 'no_instagram_credential');
    } finally {
      server.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
