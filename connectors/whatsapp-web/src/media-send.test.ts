import test from 'node:test';
import assert from 'node:assert/strict';
import { BaileysClient } from './baileys-client.js';
import pg from 'pg';

test('an existing video attachment gains provider duration without redownloading', async () => {
  const client = Object.create(BaileysClient.prototype) as any;
  client.mediaPersistenceLocks = new Map();
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const original = pg.Pool.prototype.query;
  (pg.Pool.prototype as any).query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    return {
      rows: [
        { file_url: 'stored-key', file_size: 42, mime_type: 'video/mp4', file_name: 'clip.mp4' },
      ],
    };
  };
  try {
    const result = await client.downloadAndStoreMedia(
      { key: { id: 'message' }, message: { videoMessage: { seconds: 97 } } },
      'message',
      'VIDEO'
    );
    assert.equal(result.storageKey, 'stored-key');
    assert.match(queries[1].sql, /SET duration_seconds=COALESCE\(duration_seconds, \$2\)/);
    assert.deepEqual(queries[1].params, ['message', 97]);
    queries.length = 0;
    await client.downloadAndStoreMedia(
      { key: { id: 'message' }, message: { videoMessage: { seconds: 0 } } },
      'message',
      'VIDEO'
    );
    assert.equal(queries.length, 1, 'unknown duration must not overwrite stored metadata');
  } finally {
    (pg.Pool.prototype as any).query = original;
  }
});

test('channel media persists original payload outside chats and keeps receipt on store failure', async () => {
  const client = Object.create(BaileysClient.prototype) as any;
  const accepted = {
    key: { remoteJid: '123@newsletter', id: 'post', fromMe: true },
    message: { imageMessage: { caption: 'picture' } },
  };
  const stored: any[] = [];
  const errors: string[] = [];
  client.logger = { error: (value: string) => errors.push(value) };
  client.sock = { user: { id: 'owner@s.whatsapp.net' }, sendMessage: async () => accepted };
  client.toRawJid = (jid: string) => jid;
  client.buildQuotedFromId = async () => undefined;
  client.novedadesIngestStore = () => ({
    post: async (value: any) => {
      stored.push(value);
    },
  });
  client.persistSentMedia = () => {
    throw new Error('Must not create a chat attachment');
  };
  client.rememberKey = () => {
    throw new Error('Must not enter chat retry cache');
  };
  assert.equal(await client.sendFile('123@newsletter', 'data:image/png;base64,YQ=='), 'post');
  assert.equal(stored[0].key, accepted.key);
  assert.equal(stored[0].message, accepted.message);
  assert.equal(stored[0].identityKind, 'client');
  client.novedadesIngestStore = () => ({
    post: async () => {
      throw new Error('DB unavailable');
    },
  });
  assert.equal(await client.sendFile('123@newsletter', 'data:image/png;base64,YQ=='), 'post');
  assert.match(errors[0], /NOVEDADES_PERSIST_PENDING/);
});

test('sent status keeps captured owner identity when connection changes during send', async () => {
  const client = Object.create(BaileysClient.prototype) as any;
  let saved: any;
  client.sock = {
    user: { id: 'owner@s.whatsapp.net' },
    sendMessage: async () => {
      client.sock = undefined;
      return {
        key: { remoteJid: 'status@broadcast', id: 'story', fromMe: true },
        message: { audioMessage: {} },
        messageTimestamp: 1790500000,
      };
    },
  };
  client.isConnected = () => true;
  client.toRawJid = (jid: string) => jid;
  client.novedadesIngestStore = () => ({
    status: async (input: any) => {
      saved = input;
    },
  });
  assert.equal(await client.sendVoice('status@broadcast', Buffer.from('voice')), 'story');
  assert.equal(saved.authorJid, 'owner@s.whatsapp.net');
  assert.equal(saved.key.participant, undefined);
  assert.equal(saved.messageTimestampMs, 1790500000000);
});

test('data uploads preserve a safe document filename and provider receipt', async () => {
  const sent: any[] = [];
  const client = Object.create(BaileysClient.prototype) as any;
  client.sock = {
    sendMessage: async (_jid: string, payload: any) => {
      sent.push(payload);
      return { key: { id: 'provider-receipt' }, message: {} };
    },
  };
  client.toRawJid = (jid: string) => jid;
  client.buildQuotedFromId = async () => undefined;
  client.rememberKey = () => undefined;
  client.rememberMessageForRetry = () => undefined;
  client.persistSentMedia = async () => undefined;
  const receipt = await client.sendFile(
    'peer@s.whatsapp.net',
    'data:application/pdf;base64,YQ==',
    undefined,
    { fileName: '../report\n.pdf' }
  );
  assert.equal(receipt, 'provider-receipt');
  assert.equal(sent[0].fileName, 'report.pdf');
  assert.equal(sent[0].document.toString(), 'a');
  await client.sendFile('peer@s.whatsapp.net', 'data:application/pdf;base64,YQ==');
  assert.equal(sent[1].fileName, 'attachment');
});

test('image send forwards caption and preserves provider receipt after storage failure', async () => {
  const client = Object.create(BaileysClient.prototype) as any;
  let payload: any;
  let stored = false;
  let sendCount = 0;
  const errors: string[] = [];
  client.logger = { warn: () => undefined, error: (message: string) => errors.push(message) };
  client.sock = {
    sendMessage: async (_jid: string, content: any) => {
      sendCount += 1;
      payload = content;
      return { key: { id: 'image-receipt' }, message: { imageMessage: {} } };
    },
  };
  client.toRawJid = (jid: string) => jid;
  client.buildQuotedFromId = async () => undefined;
  client.rememberKey = () => undefined;
  client.rememberMessageForRetry = () => undefined;
  client.persistSentMedia = async (
    _sent: any,
    bytes: Buffer,
    mime: string,
    name: string,
    type: string,
    caption: string
  ) => {
    assert.equal(bytes.toString(), 'image');
    assert.equal(mime, 'image/webp');
    assert.equal(name, 'photo.webp');
    assert.equal(type, 'IMAGE');
    assert.equal(caption, 'A caption');
    stored = true;
  };
  assert.equal(
    await client.sendFile('peer@s.whatsapp.net', 'data:image/webp;base64,aW1hZ2U=', 'A caption', {
      fileName: 'photo.webp',
    }),
    'image-receipt'
  );
  assert.equal(stored, true);
  assert.equal(payload.image.toString(), 'image');
  assert.equal(payload.caption, 'A caption');
  client.persistSentMedia = async () => {
    throw new Error('storage unavailable');
  };
  assert.equal(
    await client.sendFile('peer@s.whatsapp.net', 'data:image/png;base64,aW1hZ2U=', 'A caption'),
    'image-receipt'
  );
  assert.equal(sendCount, 2);
  assert.match(errors[0], /MEDIA_PERSIST_PENDING provider_message_id=image-receipt/);
});

test('document and video sends persist the correct media type before receipt', async () => {
  const client = Object.create(BaileysClient.prototype) as any;
  const types: string[] = [];
  client.logger = { warn: () => undefined, error: () => undefined };
  client.sock = {
    sendMessage: async (_jid: string, payload: any) => ({
      key: { id: `receipt-${types.length}` },
      message: payload,
    }),
  };
  client.toRawJid = (jid: string) => jid;
  client.buildQuotedFromId = async () => undefined;
  client.rememberKey = () => undefined;
  client.rememberMessageForRetry = () => undefined;
  client.persistSentMedia = async (
    _sent: any,
    _bytes: Buffer,
    _mime: string,
    _name: string,
    type: string
  ) => {
    types.push(type);
  };
  assert.equal(
    await client.sendFile('peer@s.whatsapp.net', 'data:application/pdf;base64,YQ==', undefined, {
      fileName: 'a.pdf',
    }),
    'receipt-0'
  );
  assert.equal(
    await client.sendFile('peer@s.whatsapp.net', 'data:video/mp4;base64,YQ==', 'clip'),
    'receipt-1'
  );
  assert.deepEqual(types, ['DOCUMENT', 'VIDEO']);
});

test('missing quoted media is rejected before WhatsApp send', async () => {
  const client = Object.create(BaileysClient.prototype) as any;
  let sent = false;
  let claimed = false;
  client.sock = {
    sendMessage: async () => {
      sent = true;
      return { key: { id: 'unwanted' } };
    },
  };
  client.toRawJid = (jid: string) => jid;
  client.buildQuotedFromId = async () => undefined;
  await assert.rejects(
    client.sendFile('peer@s.whatsapp.net', 'data:image/png;base64,YQ==', undefined, {
      replyToMessageId: 'missing',
      beforeSend: async () => {
        claimed = true;
      },
    }),
    /Quoted message .* is unavailable/
  );
  assert.equal(sent, false);
  assert.equal(claimed, false);
});

test('media reservation is claimed immediately before provider send with its stable ID', async () => {
  const client = Object.create(BaileysClient.prototype) as any;
  const order: string[] = [];
  client.sock = {
    sendMessage: async (_jid: string, _payload: unknown, options: { messageId: string }) => {
      order.push('provider');
      assert.equal(options.messageId, '3EB0STABLE');
      return { key: { id: options.messageId }, message: {} };
    },
  };
  client.toRawJid = (jid: string) => jid;
  client.buildQuotedFromId = async () => undefined;
  client.rememberKey = () => undefined;
  client.rememberMessageForRetry = () => undefined;
  client.persistSentMedia = async () => undefined;
  const receipt = await client.sendFile(
    'peer@s.whatsapp.net',
    'data:image/png;base64,YQ==',
    undefined,
    {
      messageId: '3EB0STABLE',
      beforeSend: async () => {
        order.push('claim');
      },
    }
  );
  assert.equal(receipt, '3EB0STABLE');
  assert.deepEqual(order, ['claim', 'provider']);
});

test('media persistence lock serializes competing echo and local writes', async () => {
  const client = Object.create(BaileysClient.prototype) as any;
  const order: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>(resolve => {
    release = resolve;
  });
  const first = client.withMediaPersistenceLock('provider-id', async () => {
    order.push('first-start');
    await waiting;
    order.push('first-end');
  });
  const second = client.withMediaPersistenceLock('provider-id', async () => {
    order.push('second');
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['first-start']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
});

test('quality changes the bytes actually sent, preserves alpha and source, and never upscales', async () => {
  const { default: sharp } = await import('sharp');
  const input = await sharp({
    create: { width: 3200, height: 1800, channels: 3, background: '#865423' },
  })
    .png()
    .toBuffer();
  const client = Object.create(BaileysClient.prototype) as any;
  let payload: any;
  let claimed = false;
  client.sock = {
    sendMessage: async (_jid: string, value: any) => {
      payload = value;
      return {};
    },
  };
  client.toRawJid = (jid: string) => jid;
  client.buildQuotedFromId = async () => undefined;
  const send = async (bytes: Buffer, quality: string, mime = 'image/png') => {
    await client.sendFile('peer', `data:${mime};base64,${bytes.toString('base64')}`, undefined, {
      quality,
      beforeSend: async () => {
        claimed = true;
      },
    });
    return payload;
  };
  for (const [quality, width] of [
    ['standard', 1600],
    ['hd', 2560],
  ] as const) {
    const sent = await send(input, quality);
    const meta = await sharp(sent.image).metadata();
    assert.equal(meta.width, width);
    assert.equal(meta.format, 'jpeg');
    assert.equal(sent.mimetype, 'image/jpeg');
    assert.notDeepEqual(sent.image, input);
  }
  assert.deepEqual((await send(input, 'source')).image, input);
  const alpha = await sharp({
    create: { width: 20, height: 10, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
  const transparent = await send(alpha, 'hd');
  const meta = await sharp(transparent.image).metadata();
  assert.equal(meta.width, 20);
  assert.equal(meta.height, 10);
  assert.equal(meta.hasAlpha, true);
  assert.equal(meta.format, 'png');
  const oriented = await sharp({
    create: { width: 100, height: 50, channels: 3, background: '#123456' },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const rotated = await sharp((await send(oriented, 'standard', 'image/jpeg')).image).metadata();
  assert.equal(rotated.width, 50);
  assert.equal(rotated.height, 100);
  assert.equal(rotated.orientation, undefined);
  await assert.rejects(
    send(Buffer.from('video'), 'hd', 'video/mp4'),
    (error: any) => error?.code === 'quality_unsupported'
  );
  for (const bytes of [
    Buffer.from('invalid'),
    Buffer.from('<svg width="10000" height="10000" xmlns="http://www.w3.org/2000/svg"></svg>'),
  ]) {
    claimed = false;
    await assert.rejects(send(bytes, 'standard'), (error: any) => error?.code === 'image_unprocessable');
    assert.equal(claimed, false);
  }
  claimed = false;
  await assert.rejects(send(input, 'invalid'), (error: any) => error?.code === 'invalid_quality');
  assert.equal(claimed, false);
});

test('expanded alpha WebP exceeding the inline limit fails before token claim or provider send', async () => {
  const { default: sharp } = await import('sharp');
  const { MAX_TRANSFORMED_IMAGE_BYTES } = await import('./media-quality');
  const pixels = Buffer.alloc(2560 * 2560 * 4);
  let seed = 42;
  for (let index = 0; index < pixels.length; index++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    pixels[index] = seed & 255;
  }
  const input = await sharp(pixels, { raw: { width: 2560, height: 2560, channels: 4 } })
    .webp({ quality: 40 })
    .toBuffer();
  assert(input.length < 10 * 1024 * 1024, `WebP fixture size: ${input.length}`);
  const expanded = await sharp(input).png().toBuffer();
  assert(expanded.length > MAX_TRANSFORMED_IMAGE_BYTES, `PNG fixture size: ${expanded.length}`);
  let claimed = false;
  let sent = false;
  const client = Object.create(BaileysClient.prototype) as any;
  client.sock = {
    sendMessage: async () => {
      sent = true;
      return {};
    },
  };
  client.toRawJid = (jid: string) => jid;
  client.buildQuotedFromId = async () => undefined;
  await assert.rejects(
    client.sendFile('peer', `data:image/webp;base64,${input.toString('base64')}`, undefined, {
      quality: 'hd',
      beforeSend: async () => {
        claimed = true;
      },
    }),
    (error: any) => error?.code === 'image_too_large'
  );
  assert.equal(claimed, false);
  assert.equal(sent, false);
});

function viewOnceStubClient() {
  const sent: any[] = [];
  const client = Object.create(BaileysClient.prototype) as any;
  client.sock = {
    user: { id: 'owner@s.whatsapp.net' },
    sendMessage: async (_jid: string, payload: any) => {
      sent.push(payload);
      return { key: { id: `receipt-${sent.length}` }, message: {} };
    },
  };
  client.toRawJid = (jid: string) => jid;
  client.buildQuotedFromId = async () => undefined;
  client.rememberKey = () => undefined;
  client.rememberMessageForRetry = () => undefined;
  client.persistSentMedia = async () => undefined;
  client.logger = { warn: () => undefined, error: () => undefined };
  return { client, sent };
}

const VIEW_ONCE_REFUSAL = (error: unknown) =>
  (error as any)?.code === 'view_once_unsupported' &&
  /viewOnce/.test((error as any)?.message || '');

test('view-once travels in the Baileys payload for image and video only', async () => {
  const image = viewOnceStubClient();
  assert.equal(
    await image.client.sendFile('peer@s.whatsapp.net', 'data:image/png;base64,YQ==', 'mira', {
      viewOnce: true,
    }),
    'receipt-1'
  );
  assert.equal(image.sent[0].viewOnce, true);
  assert.equal(image.sent[0].caption, 'mira');
  const video = viewOnceStubClient();
  assert.equal(
    await video.client.sendFile('peer@s.whatsapp.net', 'data:video/mp4;base64,YQ==', undefined, {
      viewOnce: true,
    }),
    'receipt-1'
  );
  assert.equal(video.sent[0].viewOnce, true);
  // A plain send keeps the exact payload shape it had before view-once existed.
  const plain = viewOnceStubClient();
  await plain.client.sendFile('peer@s.whatsapp.net', 'data:image/png;base64,YQ==');
  assert.equal('viewOnce' in plain.sent[0], false);
  await plain.client.sendFile('peer@s.whatsapp.net', 'data:image/png;base64,YQ==', undefined, {
    viewOnce: false,
  });
  assert.equal('viewOnce' in plain.sent[1], false);
});

test('view-once is refused for sticker, GIF, audio and document before the socket', async () => {
  const { client, sent } = viewOnceStubClient();
  const mp4ish = Buffer.concat([Buffer.from([0, 0, 1, 0]), Buffer.from('ftypisom')]).toString(
    'base64'
  );
  const refusals: Array<[string, unknown[]]> = [
    ['sticker', ['peer@s.whatsapp.net', 'data:image/webp;base64,YQ==', undefined, { asSticker: true, viewOnce: true }]],
    ['gif by flag', ['peer@s.whatsapp.net', `data:video/mp4;base64,${mp4ish}`, undefined, { asGif: true, viewOnce: true }]],
    ['gif by content', ['peer@s.whatsapp.net', 'data:image/gif;base64,YQ==', undefined, { viewOnce: true }]],
    ['audio', ['peer@s.whatsapp.net', 'data:audio/ogg;base64,YQ==', undefined, { viewOnce: true }]],
    ['document', ['peer@s.whatsapp.net', 'data:application/pdf;base64,YQ==', undefined, { viewOnce: true }]],
  ];
  for (const [, args] of refusals)
    await assert.rejects(() => (client as any).sendFile(...args), VIEW_ONCE_REFUSAL);
  assert.equal(sent.length, 0, 'no refused kind may reach the socket');
  // A non-boolean flag is rejected before anything is fetched or sent.
  await assert.rejects(
    () =>
      (client as any).sendFile('peer@s.whatsapp.net', 'data:image/png;base64,YQ==', undefined, {
        viewOnce: 'true',
      }),
    (error: any) => error?.code === 'invalid_view_once' && /boolean/.test(error?.message)
  );
  assert.equal(sent.length, 0);
});

test('view-once accepts only the proxy-aligned MIME set before the socket', async () => {
  const { client, sent } = viewOnceStubClient();
  for (const fileUrl of [
    'data:image/tiff;base64,YQ==',
    'data:image/heic;base64,YQ==',
    'data:video/x-msvideo;base64,YQ==',
    'data:video/3gpp;base64,YQ==',
    'data:image/webp;base64,YQ==',
    'data:video/webm;base64,YQ==',
    'data:video/quicktime;base64,YQ==',
  ]) {
    await assert.rejects(
      () => (client as any).sendFile('peer@s.whatsapp.net', fileUrl, undefined, { viewOnce: true }),
      (error: any) =>
        error?.code === 'view_once_unsupported' && /viewOnce is only supported/.test(error?.message)
    );
  }
  assert.equal(sent.length, 0, 'an unsupported play-once MIME must not reach the socket');
  // The same bytes without play-once still send: the gate guards viewOnce only.
  assert.equal(await client.sendFile('peer@s.whatsapp.net', 'data:image/tiff;base64,YQ=='), 'receipt-1');
  assert.equal('viewOnce' in sent[0], false);
  // Every proxy-allowed kind reaches the socket with the flag.
  for (const fileUrl of [
    'data:image/jpeg;base64,YQ==',
    'data:image/png;base64,YQ==',
    'data:video/mp4;base64,YQ==',
  ])
    assert.ok(
      await client.sendFile('peer@s.whatsapp.net', fileUrl, undefined, { viewOnce: true })
    );
  assert.equal(sent.filter(payload => payload.viewOnce === true).length, 3);
});
