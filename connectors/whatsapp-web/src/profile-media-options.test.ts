/**
 * Own profile routes and the view-once / quality media options (fase 3,
 * Jordi gap #6 / #14 / #15). profile-service.test.ts (ported from the NAS
 * fork) covers the provider rules; this file covers what this repository adds
 * around them: the HTTP surface (signed body, confirm: true, sending gate,
 * 503, error shape with failureClass, photo by fileUrl) and the additive
 * viewOnce / quality options on /messages/media/send and BaileysClient.sendFile
 * (payload shape, refusals before the socket and before the idempotency
 * claim, an unchanged hash for a plain send).
 *
 * No socket and no DB: a fake sock records what would go to WhatsApp and
 * pg.Pool#query is stubbed (same harness as sticker-gif.test.ts).
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import express from 'express';
import pg from 'pg';
import sharp from 'sharp';
import { BaileysClient } from './baileys-client';
import { MessageMutationError } from './message-mutations';
import {
  checkMediaOptions,
  parseMediaQuality,
  parseViewOnce,
  prepareImageQuality,
} from './media-quality';
import {
  fetchProfilePhoto,
  parseProfilePhotoRequest,
  parseProfileUpdateRequest,
  ProfileError,
} from './profile-service';
import { mediaRequestHash } from './send-idempotency';
import { resetChatStateForTests } from './chat-state';
import { resetDurableStoreStateForTests } from './durable-message-store';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';

function stubPool(): () => void {
  const original = pg.Pool.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = () => Promise.resolve({ rows: [], rowCount: 0 });
  return () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pg.Pool.prototype as any).query = original;
  };
}

function useAccount(account: string): void {
  process.env.CONNECTOR_ACCOUNT = account;
  resetDurableStoreStateForTests();
  resetChatStateForTests();
}

const LID = '111@lid';

async function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .jpeg()
    .toBuffer();
}

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
}

function mp4(): Buffer {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.write('ftyp', 4, 'ascii');
  bytes.write('mp42', 8, 'ascii');
  return bytes;
}

const dataUrl = (mime: string, bytes: Buffer): string =>
  `data:${mime};base64,${bytes.toString('base64')}`;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

test('media options: quality source|standard|hd, viewOnce boolean; absent = source / false', () => {
  assert.equal(parseMediaQuality(undefined), 'source');
  assert.equal(parseMediaQuality('hd'), 'hd');
  assert.equal(parseViewOnce(undefined), false);
  assert.equal(parseViewOnce(true), true);
  for (const bad of [() => parseMediaQuality('HD'), () => parseViewOnce('true')]) {
    assert.throws(bad, (e: unknown) => e instanceof MessageMutationError && e.status === 400);
  }
});

test('media options: viewOnce only for JPEG/PNG photos and MP4 videos; quality only for still images', () => {
  const off = { viewOnce: false, quality: 'source' as const, asSticker: false };
  for (const mime of ['image/jpeg', 'image/png; charset=binary', 'video/mp4']) {
    checkMediaOptions(mime, { ...off, viewOnce: true });
  }
  for (const [mime, asSticker] of [
    ['application/pdf', false],
    ['audio/ogg', false],
    ['image/gif', false],
    ['image/webp', true],
  ] as const) {
    assert.throws(
      () => checkMediaOptions(mime, { ...off, viewOnce: true, asSticker }),
      (e: unknown) => e instanceof MessageMutationError && e.code === 'view_once_unsupported',
      mime
    );
  }
  checkMediaOptions('image/jpeg', { ...off, quality: 'standard' });
  for (const mime of ['video/mp4', 'image/gif', 'application/pdf']) {
    assert.throws(
      () => checkMediaOptions(mime, { ...off, quality: 'hd' }),
      (e: unknown) => e instanceof MessageMutationError && e.code === 'quality_unsupported',
      mime
    );
  }
  // A plain send stays exactly what it was: nothing to check.
  checkMediaOptions('application/pdf', off);
});

test('quality: hd caps the long edge at 2560, standard at 1600, never enlarges; alpha stays PNG', async () => {
  const big = await jpeg(4000, 3000);
  const hd = await prepareImageQuality(big, 'image/jpeg', 'hd');
  const hdMeta = await sharp(hd.bytes).metadata();
  assert.equal(hd.mimeType, 'image/jpeg');
  assert.deepEqual([hdMeta.width, hdMeta.height], [2560, 1920]);
  const std = await sharp(
    (await prepareImageQuality(big, 'image/jpeg', 'standard')).bytes
  ).metadata();
  assert.deepEqual([std.width, std.height], [1600, 1200]);
  const small = await sharp(
    (await prepareImageQuality(await jpeg(800, 600), 'image/jpeg', 'hd')).bytes
  ).metadata();
  assert.deepEqual([small.width, small.height], [800, 600]);
  const alpha = await prepareImageQuality(await png(3000, 100), 'image/png', 'standard');
  assert.equal(alpha.mimeType, 'image/png');
  assert.equal((await sharp(alpha.bytes).metadata()).width, 1600);
  const source = await prepareImageQuality(big, 'image/jpeg', 'source');
  assert.equal(source.bytes, big, 'source = the fetched bytes, untouched');
  await assert.rejects(
    prepareImageQuality(Buffer.from('not an image'), 'image/jpeg', 'hd'),
    (e: unknown) => e instanceof MessageMutationError && e.code === 'image_unprocessable'
  );
});

test('idempotency hash: a plain media send hashes as before; viewOnce / quality change it', () => {
  const base = { conversationId: LID, fileUrl: 'https://x/y.jpg', asSticker: false };
  const plain = mediaRequestHash(base);
  assert.equal(plain, mediaRequestHash({ ...base, viewOnce: false, quality: 'source' }));
  assert.notEqual(plain, mediaRequestHash({ ...base, viewOnce: true }));
  assert.notEqual(plain, mediaRequestHash({ ...base, quality: 'hd' }));
  assert.notEqual(
    mediaRequestHash({ ...base, quality: 'hd' }),
    mediaRequestHash({ ...base, quality: 'standard' })
  );
});

test('profile requests: name ≤ 25 / about ≤ 139, one field at least, confirm: true last', () => {
  assert.deepEqual(parseProfileUpdateRequest({ name: '  Dani  ', confirm: true }), {
    name: 'Dani',
  });
  assert.deepEqual(parseProfileUpdateRequest({ about: '', confirm: true }), { about: '' });
  const code = (fn: () => unknown): unknown => {
    try {
      fn();
    } catch (e) {
      assert.ok(e instanceof ProfileError);
      return (e.details as { code?: string } | undefined)?.code || e.code;
    }
    return 'no error';
  };
  assert.equal(
    code(() => parseProfileUpdateRequest({ confirm: true })),
    'INVALID_PROFILE_INPUT'
  );
  assert.equal(
    code(() => parseProfileUpdateRequest({ name: 'x'.repeat(26), confirm: true })),
    'INVALID_PROFILE_INPUT'
  );
  assert.equal(
    code(() => parseProfileUpdateRequest({ name: 'Dani' })),
    'confirm_required'
  );
  assert.equal(
    code(() => parseProfilePhotoRequest({ fileUrl: 'https://x/a.jpg', imageBase64: 'AA==' })),
    'INVALID_PROFILE_INPUT'
  );
  assert.equal(
    code(() => parseProfilePhotoRequest({ fileUrl: 'file:///etc/passwd', confirm: true })),
    'INVALID_PROFILE_INPUT'
  );
  assert.equal(
    code(() => parseProfilePhotoRequest({ fileUrl: 'https://x/a.jpg' })),
    'confirm_required'
  );
  assert.deepEqual(parseProfilePhotoRequest({ fileUrl: 'https://x/a.jpg', confirm: true }), {
    kind: 'url',
    fileUrl: 'https://x/a.jpg',
  });
});

test('photo by URL: fetched bounded (8 MB, streamed and Content-Length), bad status is 400', async () => {
  const photo = await jpeg(64, 64);
  const server: Server = createServer((req, res) => {
    if (req.url === '/ok.jpg') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(photo);
    } else if (req.url === '/huge') {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(9 << 20) });
      res.end();
    } else if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      const chunk = Buffer.alloc(1 << 20);
      for (let i = 0; i < 9; i++) res.write(chunk);
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const got = await fetchProfilePhoto(`${base}/ok.jpg`);
    assert.equal(got.mimeType, 'image/jpeg');
    assert.deepEqual(Buffer.from(got.imageBase64, 'base64'), photo);
    for (const [path, code] of [
      ['/huge', 'PHOTO_TOO_LARGE'],
      ['/stream', 'PHOTO_TOO_LARGE'],
      ['/missing', 'INVALID_PROFILE_INPUT'],
    ] as const) {
      await assert.rejects(
        fetchProfilePhoto(`${base}${path}`),
        (e: unknown) => e instanceof ProfileError && e.code === code,
        path
      );
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// BaileysClient.sendFile
// ---------------------------------------------------------------------------

function makeClient(): {
  client: BaileysClient;
  sent: Array<[string, Record<string, unknown>, unknown]>;
} {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16));
  const sent: Array<[string, Record<string, unknown>, unknown]> = [];
  const internals = client as unknown as { sock: unknown; ready: boolean };
  internals.sock = {
    ev: { on: () => {} },
    user: { id: '34600111222:5@s.whatsapp.net' },
    sendMessage: async (jid: string, content: Record<string, unknown>, opts: unknown) => {
      sent.push([jid, content, opts]);
      return { key: { id: 'MF1', remoteJid: jid, fromMe: true }, message: {} };
    },
    end: () => {},
  };
  internals.ready = true;
  return { client, sent };
}

test('sendFile: viewOnce photo / video carry viewOnce; hd re-encodes; a plain send is unchanged', async () => {
  useAccount('personal');
  const restore = stubPool();
  const { client, sent } = makeClient();
  try {
    const photo = await jpeg(3000, 2000);
    await client.sendFile(LID, dataUrl('image/jpeg', photo), 'una', { viewOnce: true });
    assert.deepEqual(sent[0][1], { image: photo, caption: 'una', viewOnce: true });
    await client.sendFile(LID, dataUrl('video/mp4', mp4()), undefined, { viewOnce: true });
    assert.deepEqual(sent[1][1], { video: mp4(), caption: undefined, viewOnce: true });
    await client.sendFile(LID, dataUrl('image/jpeg', photo), 'hd', { quality: 'hd' });
    const hd = sent[2][1];
    assert.equal(hd.mimetype, 'image/jpeg');
    assert.equal((await sharp(hd.image as Buffer).metadata()).width, 2560);
    assert.equal(hd.viewOnce, undefined);
    await client.sendFile(LID, dataUrl('image/jpeg', photo), 'plain');
    assert.deepEqual(sent[3][1], { image: photo, caption: 'plain' });
  } finally {
    restore();
  }
});

test('sendFile: a refused option never reaches the idempotency claim nor the socket', async () => {
  useAccount('personal');
  const restore = stubPool();
  const { client, sent } = makeClient();
  try {
    let claimed = 0;
    const beforeSend = async () => void claimed++;
    for (const [url, options, code] of [
      [
        dataUrl('application/pdf', Buffer.from('%PDF-1.4')),
        { viewOnce: true },
        'view_once_unsupported',
      ],
      [dataUrl('image/webp', Buffer.from('RIFF')), { viewOnce: true }, 'view_once_unsupported'],
      [dataUrl('video/mp4', mp4()), { quality: 'hd' as const }, 'quality_unsupported'],
    ] as const) {
      await assert.rejects(
        client.sendFile(LID, url, undefined, { ...options, beforeSend }),
        (e: unknown) => e instanceof MessageMutationError && e.code === code,
        url.slice(0, 30)
      );
    }
    assert.equal(claimed, 0);
    assert.equal(sent.length, 0);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type Call = (method: string, path: string, body?: unknown) => Promise<globalThis.Response>;

async function withRouter(
  client: Partial<BaileysClient>,
  env: Record<string, string | undefined>,
  run: (call: Call) => Promise<void>
): Promise<void> {
  const secret = 'test-secret';
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(
    '/api/v1',
    createRouter(client as BaileysClient, { getCurrentQR: () => null } as never, secret)
  );
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const call: Call = (method, path, body) => {
    const ts = Math.floor(Date.now() / 1000);
    return fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-connector-timestamp': String(ts),
        'x-connector-signature': generateHMACSignature(body ?? {}, ts, secret),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await run(call);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise(resolve => server.close(resolve));
  }
}

function recordingClient(connected = true): { client: Partial<BaileysClient>; seen: unknown[] } {
  const seen: unknown[] = [];
  const photo = { available: true, accepted: true, confirmed: true, reason: 'IDENTITY_CHANGED' };
  const client = {
    isConnected: () => connected,
    getCachedState: () => (connected ? 'CONNECTED' : 'CLOSED:428'),
    getOwnProfile: async () => {
      seen.push('read');
      return { jid: '34600111222@c.us', name: 'Dani' } as never;
    },
    updateOwnProfile: async (input: unknown) => {
      seen.push({ update: input });
      return { applied: Object.keys(input as object), failed: [], partial: false } as never;
    },
    setOwnProfilePhoto: async (input: { imageBase64?: unknown; mimeType?: unknown }) => {
      seen.push({ photo: input.mimeType, bytes: String(input.imageBase64).length });
      return { photo, mimeType: input.mimeType, bytes: 1 } as never;
    },
    removeOwnProfilePhoto: async () => {
      seen.push('remove');
      return { photo: { ...photo, available: false, reason: 'READBACK_REMOVED' } } as never;
    },
    sendFile: async (...args: unknown[]) => {
      seen.push({ sendFile: args });
      return undefined;
    },
  };
  return { client: client as unknown as Partial<BaileysClient>, seen };
}

const ON = { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: undefined };

test('HTTP: the sending gate blocks profile changes, not the read; 400s come first', async () => {
  const { client, seen } = recordingClient();
  for (const env of [
    { ENABLE_SENDING: 'false', EMERGENCY_DISABLE_SENDING: undefined },
    { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: 'true' },
  ]) {
    await withRouter(client, env, async call => {
      for (const [path, body] of [
        ['/profile/me', { name: 'Dani', confirm: true }],
        ['/profile/me/photo', { fileUrl: 'https://x/a.jpg', confirm: true }],
        ['/profile/me/photo/remove', { confirm: true }],
      ] as const) {
        const res = await call('POST', path, body);
        assert.equal(res.status, 403, path);
        assert.equal(
          ((await res.json()) as { failureClass: string }).failureClass,
          'disabled_sending'
        );
      }
      for (const [path, body] of [
        ['/profile/me', { name: 'Dani' }],
        ['/profile/me', { about: 'x'.repeat(140), confirm: true }],
        ['/profile/me/photo', { confirm: true }],
        ['/profile/me/photo/remove', {}],
      ] as const) {
        const res = await call('POST', path, body);
        assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`);
        assert.equal(
          ((await res.json()) as { failureClass: string }).failureClass,
          'invalid_request'
        );
      }
      assert.equal((await call('GET', '/profile/me')).status, 200);
    });
  }
  assert.deepEqual(seen, ['read', 'read']);
});

test('HTTP: confirm missing is 400 confirm_required; 200 shapes; photo inline and by URL', async () => {
  const { client, seen } = recordingClient();
  const photo = await jpeg(32, 32);
  await withRouter(client, ON, async call => {
    const refused = await call('POST', '/profile/me', { about: 'hola', confirm: 'true' });
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), {
      error: 'The profile is visible to every contact: pass confirm: true',
      failureClass: 'invalid_request',
      code: 'confirm_required',
    });
    assert.deepEqual(await (await call('GET', '/profile/me')).json(), {
      profile: { jid: '34600111222@c.us', name: 'Dani' },
    });
    assert.deepEqual(
      await (
        await call('POST', '/profile/me', { name: 'Dani', about: '', confirm: true, actor: 'mcp' })
      ).json(),
      { updated: true, applied: ['name', 'about'], failed: [], partial: false }
    );
    const inline = await call('POST', '/profile/me/photo', {
      imageBase64: photo.toString('base64'),
      mimeType: 'image/jpeg',
      confirm: true,
    });
    assert.equal(inline.status, 200);
    assert.equal(((await inline.json()) as { updated: boolean }).updated, true);
    const files = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(photo);
    });
    await new Promise<void>(resolve => files.listen(0, '127.0.0.1', resolve));
    try {
      const byUrl = await call('POST', '/profile/me/photo', {
        fileUrl: `http://127.0.0.1:${(files.address() as AddressInfo).port}/me.jpg`,
        confirm: true,
      });
      assert.equal(byUrl.status, 200);
    } finally {
      await new Promise(resolve => files.close(resolve));
    }
    const dataPhoto = await call('POST', '/profile/me/photo', {
      fileUrl: dataUrl('image/jpeg', photo),
      confirm: true,
    });
    assert.equal(dataPhoto.status, 400, 'only http(s) URLs');
    const removed = await call('POST', '/profile/me/photo/remove', { confirm: true });
    assert.deepEqual(await removed.json(), {
      updated: true,
      photo: { available: false, accepted: true, confirmed: true, reason: 'READBACK_REMOVED' },
    });
  });
  const b64 = photo.toString('base64').length;
  assert.deepEqual(seen, [
    'read',
    { update: { name: 'Dani', about: '' } },
    { photo: 'image/jpeg', bytes: b64 },
    { photo: 'image/jpeg', bytes: b64 },
    'remove',
  ]);
});

test('HTTP: offline is 503 disconnected; a ProfileError keeps its status, failureClass and code', async () => {
  const offline = recordingClient(false);
  await withRouter(offline.client, ON, async call => {
    for (const [method, path, body] of [
      ['GET', '/profile/me', undefined],
      ['POST', '/profile/me', { name: 'Dani', confirm: true }],
      ['POST', '/profile/me/photo/remove', { confirm: true }],
    ] as const) {
      const res = await call(method, path, body);
      assert.equal(res.status, 503, path);
      assert.equal(((await res.json()) as { failureClass: string }).failureClass, 'disconnected');
    }
  });
  assert.deepEqual(offline.seen, []);

  const { client } = recordingClient();
  (client as Record<string, unknown>).updateOwnProfile = async () => {
    throw new ProfileError('PROFILE_APP_STATE_UNAVAILABLE', 'app-state key missing');
  };
  (client as Record<string, unknown>).removeOwnProfilePhoto = async () => {
    throw new ProfileError('PROFILE_UPSTREAM_TIMEOUT', 'WhatsApp profile photo removal timed out', {
      timeoutMs: 20000,
    });
  };
  await withRouter(client, ON, async call => {
    const name = await call('POST', '/profile/me', { name: 'Dani', confirm: true });
    assert.equal(name.status, 409);
    assert.deepEqual(await name.json(), {
      error: 'app-state key missing',
      failureClass: 'app_state_unavailable',
      code: 'PROFILE_APP_STATE_UNAVAILABLE',
    });
    const remove = await call('POST', '/profile/me/photo/remove', { confirm: true });
    assert.equal(remove.status, 504);
    assert.deepEqual(await remove.json(), {
      error: 'WhatsApp profile photo removal timed out',
      failureClass: 'timeout',
      code: 'PROFILE_UPSTREAM_TIMEOUT',
      details: { timeoutMs: 20000 },
    });
  });
});

test('HTTP media send: viewOnce / quality are passed through; invalid values 400 before the client', async () => {
  const { client, seen } = recordingClient();
  await withRouter(client, ON, async call => {
    const ok = await call('POST', '/messages/media/send', {
      conversationId: LID,
      fileUrl: 'https://x/a.jpg',
      viewOnce: true,
      quality: 'hd',
    });
    assert.equal(ok.status, 200);
    const plain = await call('POST', '/messages/media/send', {
      conversationId: LID,
      fileUrl: 'https://x/a.jpg',
    });
    assert.equal(plain.status, 200);
    for (const body of [
      { conversationId: LID, fileUrl: 'https://x/a.jpg', viewOnce: 'yes' },
      { conversationId: LID, fileUrl: 'https://x/a.jpg', quality: 'ultra' },
    ]) {
      const res = await call('POST', '/messages/media/send', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(
        ((await res.json()) as { failureClass: string }).failureClass,
        'invalid_request'
      );
    }
  });
  assert.deepEqual(seen, [
    {
      sendFile: [
        LID,
        'https://x/a.jpg',
        undefined,
        { asSticker: false, replyToMessageId: undefined, viewOnce: true, quality: 'hd' },
      ],
    },
    {
      sendFile: [
        LID,
        'https://x/a.jpg',
        undefined,
        { asSticker: false, replyToMessageId: undefined },
      ],
    },
  ]);
});
