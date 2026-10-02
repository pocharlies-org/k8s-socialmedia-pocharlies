import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRouter } from './controller';
import { generateHMACSignature } from './auth';
import { StatusSendUncertainError, NOVEDADES_STATUS_MEDIA_MAX_BYTES } from '../baileys-client.js';
import { connectorAccount } from '../db-writer.js';

function harness(publishStatus: (input: any) => Promise<string>) {
  const secret = 'novedades-status-fixture';
  const inputs: any[] = [];
  const client = {
    publishStatus: async (input: any) => {
      inputs.push(input);
      return publishStatus(input);
    },
  };
  const app = express();
  // Mirrors main.ts: a 10 MiB media payload becomes ~13.4 MiB of base64 JSON.
  app.use(express.json({ limit: '15mb' }));
  app.use(createRouter(client as any, { getCurrentQR: () => null } as any, secret));
  return { app, inputs, secret };
}

async function serving(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/novedades/status`,
    close: () => new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve()))),
  };
}

function signedPost(url: string, secret: string, body: unknown, enabled = true) {
  const timestamp = Math.floor(Date.now() / 1000);
  return fetch(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      ...(enabled
        ? {
            'x-connector-timestamp': String(timestamp),
            'x-connector-signature': generateHMACSignature(body, timestamp, secret),
          }
        : {}),
    },
  });
}

const DIRECT = '34600111222@s.whatsapp.net';

test('status publishing is authenticated, sending-gated and validated before any send', async () => {
  const { app, inputs, secret } = harness(async () => 'story-9');
  const site = await serving(app);
  const previousSending = process.env.ENABLE_SENDING;
  const previousEmergency = process.env.EMERGENCY_DISABLE_SENDING;
  try {
    assert.equal((await signedPost(site.url, secret, {}, false)).status, 401);

    process.env.ENABLE_SENDING = 'false';
    delete process.env.EMERGENCY_DISABLE_SENDING;
    const blocked = await signedPost(site.url, secret, {
      type: 'text',
      text: 'hola',
      recipients: [DIRECT],
    });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error.code, 'SENDING_DISABLED');
    process.env.ENABLE_SENDING = 'true';
    process.env.EMERGENCY_DISABLE_SENDING = 'true';
    assert.equal(
      (
        await signedPost(site.url, secret, { type: 'text', text: 'hola', recipients: [DIRECT] })
      ).status,
      403
    );
    delete process.env.EMERGENCY_DISABLE_SENDING;
    assert.deepEqual(inputs, [], 'the sending gate must not reach the client');

    for (const body of [
      {},
      { type: 'audio', text: 'x', recipients: [DIRECT] },
      { type: 'text', text: 'hola' },
      { type: 'text', text: 'hola', recipients: [] },
      { type: 'text', text: 'hola', recipients: DIRECT },
      { type: 'text', text: 'hola', recipients: ['123@g.us'] },
      { type: 'text', text: 'hola', recipients: ['12@newsletter'] },
      { type: 'text', text: 'hola', recipients: ['status@broadcast'] },
      { type: 'text', text: 'hola', recipients: ['no-es-un-jid'] },
      {
        type: 'text',
        text: 'hola',
        recipients: Array.from({ length: 257 }, (_u, i) => `${34600000000 + i}@s.whatsapp.net`),
      },
      { type: 'text', recipients: [DIRECT] },
      { type: 'text', text: '   ', recipients: [DIRECT] },
      { type: 'text', text: 'hola', recipients: [DIRECT], data: 'aGVsbG8=' },
      { type: 'text', text: 'hola', recipients: [DIRECT], backgroundColor: 'green' },
      { type: 'text', text: 'hola', recipients: [DIRECT], font: 9 },
      { type: 'text', text: 'hola', recipients: [DIRECT], font: '3' },
      { type: 'image', recipients: [DIRECT] },
      { type: 'image', data: 'aGVsbG8!', mimeType: 'image/png', recipients: [DIRECT] },
      { type: 'image', data: 'aGVsbG8', mimeType: 'image/png', recipients: [DIRECT] },
      { type: 'image', data: 'AB==', mimeType: 'image/png', recipients: [DIRECT] },
      { type: 'image', data: '', mimeType: 'image/png', recipients: [DIRECT] },
      { type: 'image', data: 'aGVsbG8=', recipients: [DIRECT] },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'video/mp4', recipients: [DIRECT] },
      { type: 'video', data: 'aGVsbG8=', mimeType: 'image/png', recipients: [DIRECT] },
      { type: 'video', data: 'aGVsbG8=', mimeType: 'application/pdf', recipients: [DIRECT] },
      {
        type: 'image',
        data: 'aG9sYQ==',
        mimeType: 'image/png',
        text: 'x'.repeat(1025),
        recipients: [DIRECT],
      },
    ]) {
      const response = await signedPost(site.url, secret, body);
      assert.equal(response.status, 400, `body ${JSON.stringify(body)} must be rejected`);
      assert.equal((await response.json()).error.code, 'INVALID_CAPABILITY_INPUT');
    }
    assert.deepEqual(inputs, [], 'invalid bodies must never reach the client');

    const text = await signedPost(site.url, secret, {
      type: 'text',
      text: 'hola',
      recipients: [DIRECT, '34600333444@c.us'],
      backgroundColor: '#008000',
      font: 3,
    });
    assert.equal(text.status, 200);
    assert.deepEqual(await text.json(), {
      ok: true,
      account: connectorAccount(),
      messageId: 'story-9',
      kind: 'text',
      recipients: 2,
    });
    assert.deepEqual(inputs[0], {
      type: 'text',
      text: 'hola',
      recipients: [DIRECT, '34600333444@s.whatsapp.net'],
      backgroundColor: '#008000',
      font: 3,
    });

    const image = await signedPost(site.url, secret, {
      type: 'image',
      data: 'aG9sYQ==',
      mimeType: 'image/png',
      text: 'pie',
      recipients: [DIRECT],
    });
    assert.equal(image.status, 200);
    assert.equal(inputs[1].type, 'image');
    assert.ok(Buffer.isBuffer(inputs[1].data));
    assert.equal(inputs[1].data.toString('base64'), 'aG9sYQ==', 'data arrives as decoded bytes');
    assert.equal(inputs[1].mimeType, 'image/png');
    assert.equal(inputs[1].text, 'pie');
    assert.deepEqual(inputs[1].recipients, [DIRECT]);
  } finally {
    if (previousSending === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = previousSending;
    if (previousEmergency === undefined) delete process.env.EMERGENCY_DISABLE_SENDING;
    else process.env.EMERGENCY_DISABLE_SENDING = previousEmergency;
    await site.close();
  }
});

test('media over ten megabytes is rejected without reaching the client', async () => {
  const { app, inputs, secret } = harness(async () => 'story-10');
  const site = await serving(app);
  const previous = process.env.ENABLE_SENDING;
  try {
    process.env.ENABLE_SENDING = 'true';
    delete process.env.EMERGENCY_DISABLE_SENDING;
    const oversized = Buffer.alloc(NOVEDADES_STATUS_MEDIA_MAX_BYTES + 1, 0x61).toString('base64');
    const response = await signedPost(site.url, secret, {
      type: 'image',
      data: oversized,
      mimeType: 'image/jpeg',
      recipients: [DIRECT],
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /must not exceed/);
    assert.deepEqual(inputs, []);

    const exact = Buffer.alloc(NOVEDADES_STATUS_MEDIA_MAX_BYTES, 0x61).toString('base64');
    assert.equal(
      (
        await signedPost(site.url, secret, {
          type: 'image',
          data: exact,
          mimeType: 'image/jpeg',
          recipients: [DIRECT],
        })
      ).status,
      200,
      'exactly 10 MiB is the accepted limit'
    );
  } finally {
    if (previous === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = previous;
    await site.close();
  }
});

test('an uncertain or id-less send is reported honestly and never retried', async () => {
  const sites: Array<{ close: () => Promise<void> }> = [];
  const failing = harness(async () => {
    throw new StatusSendUncertainError();
  });
  const first = await serving(failing.app);
  sites.push(first);
  const previous = process.env.ENABLE_SENDING;
  try {
    process.env.ENABLE_SENDING = 'true';
    delete process.env.EMERGENCY_DISABLE_SENDING;
    const response = await signedPost(first.url, failing.secret, {
      type: 'text',
      text: 'hola',
      recipients: [DIRECT],
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'STATUS_SEND_UNCERTAIN');
    assert.equal(body.outcomeUncertain, true);
    assert.equal(failing.inputs.length, 1, 'no automatic retry after an uncertain send');

    const idLess = harness(async () => undefined as unknown as string);
    const second = await serving(idLess.app);
    sites.push(second);
    const loose = await signedPost(second.url, idLess.secret, {
      type: 'text',
      text: 'hola',
      recipients: [DIRECT],
    });
    assert.equal(loose.status, 502);
    assert.equal((await loose.json()).error.code, 'STATUS_SEND_UNCERTAIN');
    assert.equal(idLess.inputs.length, 1, 'success is never claimed without an id');
  } finally {
    if (previous === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = previous;
    for (const site of sites) await site.close();
  }
});

test('a direct connector call arrives with a canonical audience and caption within the shared cap', async () => {
  const { app, inputs, secret } = harness(async () => 'story-11');
  const site = await serving(app);
  const previous = process.env.ENABLE_SENDING;
  try {
    process.env.ENABLE_SENDING = 'true';
    delete process.env.EMERGENCY_DISABLE_SENDING;
    const response = await signedPost(site.url, secret, {
      type: 'image',
      data: 'aG9sYQ==',
      mimeType: 'image/jpeg',
      text: 'x'.repeat(1024),
      recipients: [
        '34600111222:8@s.whatsapp.net',
        '34600111222@s.whatsapp.net',
        '34600333444@c.us',
      ],
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.recipients, 2, ':device spellings and @c.us collapse to one contact each');
    assert.deepEqual(inputs[0].recipients, [
      '34600111222@s.whatsapp.net',
      '34600333444@s.whatsapp.net',
    ]);
    assert.equal(inputs[0].text.length, 1024, 'exactly 1024 caption characters is accepted');
  } finally {
    if (previous === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = previous;
    await site.close();
  }
});
