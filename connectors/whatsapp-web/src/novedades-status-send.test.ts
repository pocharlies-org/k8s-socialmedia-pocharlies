import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BaileysClient,
  StatusSendUncertainError,
  NOVEDADES_STATUS_MEDIA_MAX_BYTES,
} from './baileys-client.js';

/** The exact receipt a connected socket returns for a status@broadcast send. */
function sentReceipt(id: string, message: Record<string, unknown>) {
  return {
    key: { remoteJid: 'status@broadcast', id, fromMe: true },
    message,
    messageTimestamp: 1790500000,
  };
}

function stubClient(receipt: unknown) {
  const client = Object.create(BaileysClient.prototype) as any;
  const calls: Array<{ jid: string; payload: any; options: any }> = [];
  client.sock = {
    user: { id: 'owner@s.whatsapp.net' },
    sendMessage: async (jid: string, payload: unknown, options: unknown) => {
      calls.push({ jid, payload, options });
      return receipt;
    },
  };
  client.isConnected = () => true;
  client.lastState = 'CONNECTED';
  const errors: string[] = [];
  client.logger = {
    info: () => undefined,
    warn: () => undefined,
    error: (value: string) => errors.push(value),
  };
  const statuses: any[] = [];
  client.novedadesIngestStore = () => ({
    post: async () => undefined,
    deletePost: async () => undefined,
    deleteStatus: async () => undefined,
    status: async (input: any) => {
      statuses.push(input);
    },
  });
  return { client, calls, statuses, errors };
}

const INVALID_INPUT = (error: unknown) =>
  (error as any)?.name === 'CapabilityError' && (error as any)?.code === 'INVALID_CAPABILITY_INPUT';

test('text status relays the exact audience and text style to the socket once', async () => {
  const receipt = sentReceipt('story-1', { extendedTextMessage: { text: 'hola' } });
  const { client, calls, statuses } = stubClient(receipt);
  const messageId = await client.publishNovedadesStatus({
    type: 'text',
    text: 'hola',
    recipients: ['34600111222@s.whatsapp.net', '34600333444@c.us'],
    backgroundColor: '#008000',
    font: 3,
  });
  assert.equal(messageId, 'story-1');
  assert.equal(calls.length, 1, 'the socket is called exactly once');
  assert.equal(calls[0].jid, 'status@broadcast');
  assert.deepEqual(calls[0].payload, { text: 'hola' });
  assert.equal(calls[0].options.broadcast, true);
  assert.deepEqual(
    calls[0].options.statusJidList,
    ['34600111222@s.whatsapp.net', '34600333444@s.whatsapp.net'],
    'recipients pass through in order, normalized to raw JIDs and untouched otherwise'
  );
  assert.equal(calls[0].options.backgroundColor, '#008000');
  assert.equal(calls[0].options.font, 3);
  assert.equal(statuses.length, 1, 'the sent status is persisted as a novedad');
  assert.equal(statuses[0].key, receipt.key);
  assert.equal(statuses[0].authorJid, 'owner@s.whatsapp.net');
  assert.equal(statuses[0].messageTimestampMs, 1790500000000);
});

test('image and video statuses send decoded bytes with caption and matching MIME only', async () => {
  const image = Buffer.from('imagen');
  const { client, calls } = stubClient(sentReceipt('story-2', { imageMessage: {} }));
  const imageId = await client.publishNovedadesStatus({
    type: 'image',
    data: image,
    mimeType: 'image/png',
    text: 'pie de foto',
    recipients: ['34600111222@s.whatsapp.net'],
    backgroundColor: '#008000',
    font: 4,
  });
  assert.equal(imageId, 'story-2');
  assert.equal(calls[0].jid, 'status@broadcast');
  assert.equal(calls[0].payload.image, image);
  assert.equal(calls[0].payload.mimetype, 'image/png');
  assert.equal(calls[0].payload.caption, 'pie de foto');
  assert.deepEqual(calls[0].options, {
    broadcast: true,
    statusJidList: ['34600111222@s.whatsapp.net'],
  });

  const clip = Buffer.from('clip');
  const video = stubClient(sentReceipt('story-3', { videoMessage: {} }));
  const videoId = await video.client.publishNovedadesStatus({
    type: 'video',
    data: clip,
    mimeType: 'video/mp4;codecs=avc1',
    recipients: ['34600333444@s.whatsapp.net'],
  });
  assert.equal(videoId, 'story-3');
  assert.equal(video.calls[0].payload.video, clip);
  assert.equal(video.calls[0].payload.mimetype, 'video/mp4', 'MIME parameters are stripped');
  assert.equal(video.calls[0].payload.caption, undefined);
});

test('invalid status input is rejected before the socket is touched', async () => {
  const { client, calls } = stubClient(sentReceipt('never', {}));
  const direct = '34600111222@s.whatsapp.net';
  const oversizedAudience = Array.from(
    { length: 257 },
    (_unused, index) => `${34600000000 + index}@s.whatsapp.net`
  );
  const invalid: unknown[] = [
    { type: 'audio', text: 'x', recipients: [direct] },
    { type: 'text', text: 'hola' },
    { type: 'text', text: 'hola', recipients: [] },
    { type: 'text', text: 'hola', recipients: '34600111222@s.whatsapp.net' },
    { type: 'text', text: 'hola', recipients: ['123@g.us'] },
    { type: 'text', text: 'hola', recipients: ['12@newsletter'] },
    { type: 'text', text: 'hola', recipients: ['status@broadcast'] },
    { type: 'text', text: 'hola', recipients: ['no-es-un-jid'] },
    { type: 'text', text: 'hola', recipients: oversizedAudience },
    { type: 'text', recipients: [direct] },
    { type: 'text', text: '   ', recipients: [direct] },
    { type: 'text', text: 'hola', recipients: [direct], data: Buffer.from('x') },
    { type: 'text', text: 'hola', recipients: [direct], mimeType: 'text/plain' },
    { type: 'text', text: 'hola', recipients: [direct], backgroundColor: 'green' },
    { type: 'text', text: 'hola', recipients: [direct], font: 7 },
    { type: 'text', text: 'hola', recipients: [direct], font: 1.5 },
    { type: 'image', recipients: [direct] },
    { type: 'image', data: Buffer.alloc(0), mimeType: 'image/png', recipients: [direct] },
    { type: 'image', data: Buffer.from('x'), recipients: [direct] },
    { type: 'image', data: Buffer.from('x'), mimeType: 'video/mp4', recipients: [direct] },
    { type: 'image', data: Buffer.from('x'), mimeType: 'application/pdf', recipients: [direct] },
    { type: 'video', data: Buffer.from('x'), mimeType: 'image/png', recipients: [direct] },
    {
      type: 'image',
      data: Buffer.from('x'),
      mimeType: 'image/jpeg',
      text: 'x'.repeat(1025),
      recipients: [direct],
    },
    {
      type: 'image',
      data: Buffer.alloc(NOVEDADES_STATUS_MEDIA_MAX_BYTES + 1),
      mimeType: 'image/jpeg',
      recipients: [direct],
    },
  ];
  for (const input of invalid)
    await assert.rejects(() => client.publishNovedadesStatus(input as any), INVALID_INPUT);
  assert.equal(calls.length, 0, 'no invalid input may reach the socket');

  const offline = stubClient(sentReceipt('never', {}));
  offline.client.isConnected = () => false;
  await assert.rejects(
    () =>
      offline.client.publishNovedadesStatus({ type: 'text', text: 'hola', recipients: [direct] }),
    /not connected/
  );
  assert.equal(offline.calls.length, 0);
});

test('a send without a provider id is uncertain, never retried and never persisted', async () => {
  const { client, calls, statuses } = stubClient({
    key: { remoteJid: 'status@broadcast', fromMe: true },
    message: {},
    messageTimestamp: 1790500000,
  });
  await assert.rejects(
    () =>
      client.publishNovedadesStatus({
        type: 'text',
        text: 'hola',
        recipients: ['34600111222@s.whatsapp.net'],
      }),
    (error: unknown) => error instanceof StatusSendUncertainError
  );
  assert.equal(calls.length, 1, 'an uncertain outcome must not trigger an automatic retry');
  assert.equal(statuses.length, 0, 'without an id there is no success to persist');
});

test('a persistence failure keeps the provider receipt and logs it as pending', async () => {
  const { client, calls, errors } = stubClient(sentReceipt('story-4', { imageMessage: {} }));
  client.novedadesIngestStore = () => ({
    post: async () => undefined,
    deletePost: async () => undefined,
    deleteStatus: async () => undefined,
    status: async () => {
      throw new Error('db unavailable');
    },
  });
  const messageId = await client.publishNovedadesStatus({
    type: 'image',
    data: Buffer.from('x'),
    mimeType: 'image/jpeg',
    recipients: ['34600111222@s.whatsapp.net'],
  });
  assert.equal(messageId, 'story-4', 'the provider receipt remains the ground truth');
  assert.equal(calls.length, 1);
  assert.match(errors.join('\n'), /NOVEDADES_PERSIST_PENDING provider_message_id=story-4/);
});

test('device-suffixed and repeated recipients reach the socket as canonical bare user JIDs', async () => {
  const { client, calls } = stubClient(
    sentReceipt('story-5', { extendedTextMessage: { text: 'hola' } })
  );
  await client.publishNovedadesStatus({
    type: 'text',
    text: 'hola',
    recipients: [
      '34600111222:8@s.whatsapp.net',
      '34600111222@s.whatsapp.net',
      '34600333444@c.us',
      '34600555666:1@lid',
    ],
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0].options.statusJidList,
    ['34600111222@s.whatsapp.net', '34600333444@s.whatsapp.net', '34600555666@lid'],
    'the audience names people: device suffixes are stripped, @c.us is mapped, duplicates collapse in order'
  );
});

test('media captions honor the same 1024 character cap as the app composer', async () => {
  const { client, calls } = stubClient(sentReceipt('story-6', { imageMessage: {} }));
  const direct = ['34600111222@s.whatsapp.net'];
  await assert.rejects(
    () =>
      client.publishNovedadesStatus({
        type: 'image',
        data: Buffer.from('x'),
        mimeType: 'image/jpeg',
        text: 'x'.repeat(1025),
        recipients: direct,
      }),
    INVALID_INPUT
  );
  assert.equal(calls.length, 0, 'an over-long caption must not reach the socket');
  const messageId = await client.publishNovedadesStatus({
    type: 'image',
    data: Buffer.from('x'),
    mimeType: 'image/jpeg',
    text: 'x'.repeat(1024),
    recipients: direct,
  });
  assert.equal(messageId, 'story-6', 'exactly 1024 caption characters is the accepted limit');
  assert.equal(calls[0].payload.caption.length, 1024);
});
