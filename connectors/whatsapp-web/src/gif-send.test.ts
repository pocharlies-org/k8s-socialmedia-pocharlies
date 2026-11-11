import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { generateHMACSignature } from './api/auth';
import { createRouter } from './api/controller';
import { BaileysClient } from './baileys-client';

function mp4Fixture(): Buffer {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.write('ftyp', 4, 'ascii');
  bytes.write('mp42', 8, 'ascii');
  return bytes;
}

test('rejects raw GIF uploads with an HTTP failure before calling Baileys', async () => {
  const previousEnabled = process.env.ENABLE_SENDING;
  const sent: unknown[] = [];
  const client = Object.create(BaileysClient.prototype) as any;
  client.sock = {
    sendMessage: async (_jid: string, payload: unknown) => {
      sent.push(payload);
      return {};
    },
  };
  client.toRawJid = (jid: string) => jid;
  client.buildQuotedFromId = async () => undefined;

  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createRouter(client, { getCurrentQR: () => null } as any, 'gif-send-test-secret')
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  process.env.ENABLE_SENDING = 'true';

  try {
    const body = {
      conversationId: 'peer@s.whatsapp.net',
      fileUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
    };
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/messages/media/send`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-connector-timestamp': String(timestamp),
          'x-connector-signature': generateHMACSignature(body, timestamp, 'gif-send-test-secret'),
        },
        body: JSON.stringify(body),
      }
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error:
        'Animated GIFs must be transcoded to MP4 before sending; the connector does not transcode GIF files',
      failureClass: 'invalid_request',
    });
    assert.deepEqual(sent, []);
  } finally {
    if (previousEnabled === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = previousEnabled;
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  }
});

test('sends transcoded MP4 as a GIF playback payload', async () => {
  const bytes = mp4Fixture();
  let payload: any;
  const client = Object.create(BaileysClient.prototype) as any;
  client.sock = {
    sendMessage: async (_jid: string, content: unknown) => {
      payload = content;
      return {};
    },
  };
  client.toRawJid = (jid: string) => jid;
  client.buildQuotedFromId = async () => undefined;

  await client.sendFile(
    'peer@s.whatsapp.net',
    `data:video/mp4;base64,${bytes.toString('base64')}`,
    'animation',
    { asGif: true }
  );

  assert.deepEqual(payload.video, bytes);
  assert.equal(payload.mimetype, 'video/mp4');
  assert.equal(payload.gifPlayback, true);
  assert.equal(payload.caption, 'animation');
});
