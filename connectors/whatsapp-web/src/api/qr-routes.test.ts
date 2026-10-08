/**
 * SKIRM-103 (F3, C4): the pairing pages and the liveness probe answer without
 * any connector credential, as they always did (they sit behind sso-chain on
 * the LAN hosts and dgx-infra probes /status bare). The last test composes the
 * app the way main.ts does and checks the HMAC gates of /api/public and
 * /api/v2 stop at their own prefix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { QRHandler } from '../qr-handler';
import { createAuthQrV2Router } from './auth-qr';
import { createPublicRouter } from './public-routes';
import { createQrRouter } from './qr-routes';

const SECRET = 'test-connector-secret';

function fakes() {
  const renewed: string[] = [];
  const qrHandler = new QRHandler();
  const client = {
    getStatus: () => ({ connected: true, account: 'personal' }) as never,
    renewQR: async () => {
      renewed.push('renewQR');
    },
  };
  const eventPublisher = { isConnected: () => true };
  return { qrHandler, client, eventPublisher, renewed };
}

async function listen(app: express.Express) {
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>(resolve => server.close(() => resolve()));
  return { base, close };
}

async function serve(allowWebRenew: boolean) {
  const f = fakes();
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use(createQrRouter({ ...f, sessionPath: '/data/session', allowWebRenew }));
  return { ...f, ...(await listen(app)) };
}

test('/status sin credenciales → 200 con el estado del cliente, NATS y la ruta de sesión', async () => {
  const { base, close } = await serve(false);
  try {
    const r = await fetch(`${base}/status`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      connected: true,
      account: 'personal',
      natsConnected: true,
      session_path: '/data/session',
    });
  } finally {
    await close();
  }
});

test('/qr sin credenciales → 404 {status: no_qr} sin QR, PNG sin caché con QR', async () => {
  const { base, close, qrHandler } = await serve(false);
  try {
    const none = await fetch(`${base}/qr`);
    assert.equal(none.status, 404);
    assert.deepEqual(await none.json(), {
      status: 'no_qr',
      message: 'No QR available — already connected or waiting for generation',
    });

    await qrHandler.generateQR('2@pairing-page-qr');
    const png = await fetch(`${base}/qr`);
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal(png.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');
    assert.deepEqual([...Buffer.from(await png.arrayBuffer()).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  } finally {
    await close();
  }
});

test('/qr/page sin credenciales → la página, con el botón de renovar solo si ALLOW_WEB_RENEW', async () => {
  for (const allow of [false, true]) {
    const { base, close } = await serve(allow);
    try {
      const r = await fetch(`${base}/qr/page`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') ?? '', /text\/html/);
      const html = await r.text();
      assert.match(html, /Scan with WhatsApp/);
      assert.match(html, /fetch\('\/status'\)/);
      assert.equal(html.includes('Generate new QR'), allow);
    } finally {
      await close();
    }
  }
});

test('POST /qr/renew → 403 con la bandera apagada; con ella limpia el QR y pide uno nuevo', async () => {
  const off = await serve(false);
  try {
    const r = await fetch(`${off.base}/qr/renew`, { method: 'POST' });
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: 'Web renew disabled (set ALLOW_WEB_RENEW=true)' });
    assert.deepEqual(off.renewed, []);
  } finally {
    await off.close();
  }

  const on = await serve(true);
  try {
    await on.qrHandler.generateQR('2@to-be-cleared');
    const r = await fetch(`${on.base}/qr/renew`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, message: 'Renewing — new QR will appear shortly.' });
    assert.deepEqual(on.renewed, ['renewQR']);
    assert.equal(on.qrHandler.getCurrentQR(), null);
  } finally {
    await on.close();
  }
});

test('compuesta como main.ts: las puertas HMAC de /api/public y /api/v2 no tocan /qr, /qr/page ni /status', async () => {
  const f = fakes();
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/v2', createAuthQrV2Router(f.qrHandler, SECRET));
  app.use(createQrRouter({ ...f, sessionPath: '/data/session', allowWebRenew: false }));
  app.use('/api/public', createPublicRouter({} as never, SECRET, { log: () => {} }));
  const { base, close } = await listen(app);
  try {
    for (const path of ['/qr', '/qr/page', '/status']) {
      const r = await fetch(`${base}${path}`);
      assert.notEqual(r.status, 401, path);
    }
    for (const path of ['/api/public/chats', '/api/v2/auth/qr']) {
      assert.equal((await fetch(`${base}${path}`)).status, 401, path);
    }
  } finally {
    await close();
  }
});
