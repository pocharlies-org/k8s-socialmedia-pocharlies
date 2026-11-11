/**
 * SKIRM-103 (F3, C2/C3): the QR of the connector, v1 and v2.
 *
 * v1 — http.whatsapp-connector.auth-qr, deprecated but still served: GET
 * /api/v1/auth/qr answers through connector access (Basic or HMAC), 200 {qrCode, expiresAt} or
 * 404 {"error":"No QR code available"}. That half was written before the v2
 * route existed and must stay green through the change.
 *
 * v2 — http.whatsapp-connector.auth-qr.v2: GET /api/v2/auth/qr, same payload,
 * behind the connector HMAC (signed over "{}" like every GET).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import '../test-env';
import type { BaileysClient } from '../baileys-client';
import { generateHMACSignature } from '@mcp-socialmedia/shared';
import { QRHandler } from '../qr-handler';
import { createAuthQrV2Router } from './auth-qr';
import { createRouter } from './controller';
import { createConnectorAccess } from './access';

const SECRET = 'test-connector-secret';

async function serve(qrHandler: QRHandler) {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  // The client is never reached by /auth/qr: the route only reads the QRHandler.
  app.use('/api/v1', createRouter({} as BaileysClient, qrHandler, SECRET));
  app.use('/api/v2', createAuthQrV2Router(qrHandler, SECRET));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>(resolve => server.close(() => resolve()));
  return { base, close };
}

function v1Signed(ts = Math.floor(Date.now() / 1000)): Record<string, string> {
  return {
    'x-connector-timestamp': String(ts),
    'x-connector-signature': generateHMACSignature({}, ts, SECRET),
  };
}

test('v1 /api/v1/auth/qr sin QR → 404 {error} con firma del conector', async () => {
  const { base, close } = await serve(new QRHandler());
  try {
    const r = await fetch(`${base}/api/v1/auth/qr`, { headers: v1Signed() });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'No QR code available' });
  } finally {
    await close();
  }
});

test('v1 /api/v1/auth/qr con QR → 200 {qrCode, expiresAt} con firma del conector', async () => {
  const qr = new QRHandler();
  await qr.generateQR('2@characterisation-qr-string');
  const { base, close } = await serve(qr);
  try {
    const r = await fetch(`${base}/api/v1/auth/qr`, { headers: v1Signed() });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { qrCode: string; expiresAt: string };
    assert.deepEqual(Object.keys(body).sort(), ['expiresAt', 'qrCode']);
    assert.match(body.qrCode, /^data:image\/png;base64,/);
    assert.equal(new Date(body.expiresAt).toISOString(), body.expiresAt);
    const current = qr.getCurrentQR();
    assert.ok(current);
    assert.equal(body.qrCode, current.qrCode);
    assert.equal(body.expiresAt, current.expiresAt.toISOString());
  } finally {
    await close();
  }
});

// --- v2 ---------------------------------------------------------------------

function signed(ts = Math.floor(Date.now() / 1000), secret = SECRET): Record<string, string> {
  return {
    'x-connector-timestamp': String(ts),
    'x-connector-signature': generateHMACSignature({}, ts, secret),
  };
}

test('v2 /api/v2/auth/qr sin firma → 401, con QR o sin él', async () => {
  const qr = new QRHandler();
  await qr.generateQR('2@v2-qr-string');
  for (const handler of [new QRHandler(), qr]) {
    const { base, close } = await serve(handler);
    try {
      const r = await fetch(`${base}/api/v2/auth/qr`);
      assert.equal(r.status, 401);
      assert.deepEqual(await r.json(), { error: 'Missing authentication headers' });
    } finally {
      await close();
    }
  }
});

test('v2 con firma de otra clave o fuera de ventana → 401', async () => {
  const qr = new QRHandler();
  await qr.generateQR('2@v2-qr-string');
  const { base, close } = await serve(qr);
  try {
    const wrongKey = await fetch(`${base}/api/v2/auth/qr`, {
      headers: signed(undefined, 'dev-secret-change-in-production'),
    });
    assert.equal(wrongKey.status, 401);
    const stale = await fetch(`${base}/api/v2/auth/qr`, {
      headers: signed(Math.floor(Date.now() / 1000) - 330),
    });
    assert.equal(stale.status, 401);
  } finally {
    await close();
  }
});

test('v2 firmado → exactamente la carga útil de v1 (200 con QR, 404 sin QR)', async () => {
  const empty = new QRHandler();
  const withQr = new QRHandler();
  await withQr.generateQR('2@v2-qr-string');
  for (const handler of [empty, withQr]) {
    const { base, close } = await serve(handler);
    try {
      const v1 = await fetch(`${base}/api/v1/auth/qr`, { headers: v1Signed() });
      const v2 = await fetch(`${base}/api/v2/auth/qr`, { headers: signed() });
      assert.equal(v2.status, v1.status);
      assert.deepEqual(await v2.json(), await v1.json());
    } finally {
      await close();
    }
  }
});

// QA #29 asked whether the release opens an unauthenticated pairing QR in-cluster.
// The route in controller.ts carries no middleware of its own; the protection is the
// app-level gate (main.ts). Nothing composed both until now — this is that composition.
test('compuesta como main.ts: la puerta global deja /api/v1/auth/qr anónima en 401 con reto Basic', async () => {
  const qr = new QRHandler();
  await qr.generateQR('2@access-gate-qr-string');
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use(createConnectorAccess(SECRET));
  app.use('/api/v1', createRouter({} as BaileysClient, qr, SECRET));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const anonymous = await fetch(`${base}/api/v1/auth/qr`);
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('www-authenticate') || '', /^Basic realm=/);
    assert.deepEqual(await anonymous.json(), { error: 'Authentication required' });
    const ok = await fetch(`${base}/api/v1/auth/qr`, { headers: v1Signed() });
    assert.equal(ok.status, 200);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
