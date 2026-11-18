import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { generateHMACSignature } from '@mcp-socialmedia/shared';
import { MtArgumentError, MtTimeoutError, networkMiddlewares, tl, TelegramClient, FileLocation, Long } from '@mtcute/node';
import { TelegramClientWrapper } from './telegram-client';
import { createRouter } from './api/controller';

function wrapper(client: object): TelegramClientWrapper {
  Object.assign(client, { withParams: () => client });
  return Object.assign(Object.create(TelegramClientWrapper.prototype), { client, connected: true });
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('hung media download aborts the mtcute request after 120 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  const client = wrapper({
    getMessages: async () => [{ media: { fileId: 'file' } }],
    downloadAsBuffer: (_file: unknown, params: { abortSignal: AbortSignal }) => {
      signal = params?.abortSignal;
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal?.reason)));
    },
  });
  const result = client.downloadMedia('123', 1);
  const rejection = assert.rejects(result, { name: 'TelegramDownloadTimeoutError' });
  await flush();
  assert.ok(signal);
  t.mock.timers.tick(120_000);
  await rejection;
  assert.equal(signal.aborted, true);
});

test('avatar candidates share one deadline and stop after cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals: AbortSignal[] = [];
  const candidates: unknown[] = [];
  const client = wrapper({
    getPeer: async () => ({ photo: { big: 'big', small: 'small', fileId: 'fallback' } }),
    downloadAsBuffer: (candidate: unknown, params: { abortSignal: AbortSignal }) => {
      candidates.push(candidate);
      signals.push(params?.abortSignal);
      return new Promise((_resolve, reject) => {
        if (candidate === 'big') setTimeout(() => reject(new MtArgumentError('Unsupported candidate')), 15_000);
        params?.abortSignal.addEventListener('abort', () => reject(params.abortSignal.reason));
      });
    },
  });
  const result = client.downloadPeerPhoto('123');
  const rejection = assert.rejects(result, { name: 'TelegramDownloadTimeoutError' });
  await flush();
  t.mock.timers.tick(15_000);
  await flush();
  assert.deepEqual(candidates, ['big', 'small']);
  t.mock.timers.tick(5_000);
  await rejection;
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[1].aborted, true);
  assert.deepEqual(candidates, ['big', 'small']);
});

test('hung message and peer lookups receive the operation abort signal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const method of ['downloadMedia', 'downloadPeerPhoto'] as const) {
    let signal: AbortSignal | undefined;
    let downloadCalls = 0;
    const hungLookup = () => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal?.reason));
    });
    const fake = {
      getMessages: hungLookup,
      getPeer: hungLookup,
      downloadAsBuffer: async () => { downloadCalls++; return new Uint8Array(); },
    };
    const client = wrapper(fake);
    Object.assign(fake, { withParams: (params: { abortSignal: AbortSignal }) => {
      signal = params.abortSignal;
      return fake;
    } });
    const result = method === 'downloadMedia' ? client.downloadMedia('123', 1) : client.downloadPeerPhoto('123');
    const rejection = assert.rejects(result, { name: 'TelegramDownloadTimeoutError' });
    await flush();
    assert.ok(signal);
    t.mock.timers.tick(method === 'downloadMedia' ? 120_000 : 20_000);
    await rejection;
    assert.equal(signal.aborted, true);
    assert.equal(downloadCalls, 0);
  }
});

test('peer lookup and download upstream failures propagate without falling back to absence', async () => {
  const error = new Error('Upstream unavailable');
  await assert.rejects(wrapper({ getPeer: async () => { throw error; } }).downloadPeerPhoto('123'), error);
  let calls = 0;
  const client = wrapper({
    getPeer: async () => ({ photo: { big: 'big', small: 'small' } }),
    downloadAsBuffer: async () => { calls++; throw error; },
  });
  await assert.rejects(client.downloadPeerPhoto('123'), error);
  assert.equal(calls, 1);
});

test('media and photo downloads preserve successful data and genuine absence', async () => {
  const client = wrapper({
    getMessages: async () => [{ media: { fileId: 'file' } }],
    getPeer: async () => ({ photo: { big: 'big' } }),
    downloadAsBuffer: async (_file: unknown, params: { abortSignal: AbortSignal }) => {
      assert.equal(params.abortSignal.aborted, false);
      return Uint8Array.from([1, 2, 3]);
    },
  });
  assert.deepEqual(await client.downloadMedia('123', 1), Buffer.from([1, 2, 3]));
  assert.deepEqual(await client.downloadPeerPhoto('123'), Buffer.from([1, 2, 3]));
  const empty = wrapper({ getMessages: async () => [], getPeer: async () => ({}) });
  assert.equal(await empty.downloadMedia('123', 1), null);
  assert.equal(await empty.downloadPeerPhoto('123'), null);
});

test('download HTTP routes return 504/502 for failures and preserve 200/404', async () => {
  const secret = 'test-download-secret';
  const client = wrapper({});
  const error = Object.assign(new Error('Telegram download timed out'), { name: 'TelegramDownloadTimeoutError' });
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createRouter(client, secret));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  try {
    let sends = 0;
    client.sendFile = async (_chat, audio, options) => {
      sends++;
      assert.deepEqual(audio, Buffer.from([7, 8]));
      assert.equal(options?.voiceNote, true);
    };
    const body = { chatId: '123', audioBase64: Buffer.from([7, 8]).toString('base64') };
    const timestamp = Math.floor(Date.now() / 1000);
    const voiceResponse = await fetch(`${base}/messages/voice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-connector-timestamp': String(timestamp),
        'x-connector-signature': generateHMACSignature(body, timestamp, secret),
      },
      body: JSON.stringify(body),
    });
    assert.equal(voiceResponse.status, 200);
    assert.deepEqual(await voiceResponse.json(), { sent: true, mimeType: 'audio/ogg' });
    assert.equal(sends, 1);
    for (const result of ['timeout', 'upstream', 'absent', 'success'] as const) {
      const download = async () => {
        if (result === 'timeout') throw error;
        if (result === 'upstream') throw new Error('Upstream unavailable');
        return result === 'absent' ? null : Buffer.from([1, 2]);
      };
      client.downloadMedia = download;
      client.downloadPeerPhoto = download;
      for (const route of ['/messages/media/123/1', '/peers/123/photo']) {
        const timestamp = Math.floor(Date.now() / 1000);
        const response = await fetch(`${base}${route}`, { headers: {
          'x-connector-timestamp': String(timestamp),
          'x-connector-signature': generateHMACSignature({}, timestamp, secret),
        } });
        assert.equal(response.status, result === 'timeout' ? 504 : result === 'upstream' ? 502 : result === 'absent' ? 404 : 200);
        if (result === 'success') {
          const body = await response.json() as { data: string };
          assert.equal(body.data, Buffer.from([1, 2]).toString('base64'));
        }
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});


test('media taking longer than 20 seconds succeeds before its deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = wrapper({
    getMessages: async () => [{ media: { fileId: 'file' } }],
    downloadAsBuffer: () => new Promise(resolve => setTimeout(() => resolve(Uint8Array.from([7])), 30_000)),
  });
  const result = client.downloadMedia('123', 1);
  await flush();
  t.mock.timers.tick(30_000);
  assert.deepEqual(await result, Buffer.from([7]));
});

test('configured media deadline cancels stalled downloads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previous = process.env.TELEGRAM_MEDIA_DOWNLOAD_TIMEOUT_SECONDS;
  process.env.TELEGRAM_MEDIA_DOWNLOAD_TIMEOUT_SECONDS = '45';
  try {
    const client = wrapper({ getMessages: () => new Promise(() => {}) });
    const result = client.downloadMedia('123', 1);
    const rejection = assert.rejects(result, /45 second deadline/);
    await flush();
    t.mock.timers.tick(45_000);
    await rejection;
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_MEDIA_DOWNLOAD_TIMEOUT_SECONDS;
    else process.env.TELEGRAM_MEDIA_DOWNLOAD_TIMEOUT_SECONDS = previous;
  }
});

test('single message and flood wait HTTP contracts support durable recovery', async () => {
  const secret = 'test-recovery-secret';
  const client = wrapper({});
  const app = express();
  app.use('/api/v1', createRouter(client, secret));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const get = (route: string) => {
    const timestamp = Math.floor(Date.now() / 1000);
    return fetch(`${base}${route}`, { headers: {
      'x-connector-timestamp': String(timestamp),
      'x-connector-signature': generateHMACSignature({}, timestamp, secret),
    } });
  };
  try {
    client.getMessage = async () => ({ id: 1, type: 'text' } as any);
    assert.equal((await get('/messages/single/123/1')).status, 200);
    assert.equal((await get('/messages/single/123/no')).status, 400);
    client.getMessage = async () => null;
    assert.equal((await get('/messages/single/123/1')).status, 404);
    const flood = async () => { throw tl.RpcError.fromTl({ _: 'rpc_error', errorCode: 420, errorMessage: 'FLOOD_WAIT_18' }); };
    client.getMessages = flood;
    client.getMessage = flood;
    client.downloadMedia = flood;
    client.downloadPeerPhoto = flood;
    for (const route of ['/messages/123', '/messages/single/123/1', '/messages/media/123/1', '/peers/123/photo']) {
      const res = await get(route);
      assert.equal(res.status, 429);
      assert.equal(res.headers.get('Retry-After'), '18');
      assert.deepEqual(await res.json(), { error: 'Telegram rate limit', retryAfter: 18 });
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});


test('real mtcute download workers propagate flood waits instead of sleeping forever', async () => {
  let threshold: unknown;
  const inner = {
    storage: {},
    getPrimaryDcId: async () => 2,
    getPoolSize: async () => 1,
    log: { debug: () => {} },
    call: async (_request: unknown, options: { floodSleepThreshold: number }) => {
      threshold = options.floodSleepThreshold;
      throw tl.RpcError.fromTl({ _: 'rpc_error', errorCode: 420, errorMessage: 'FLOOD_WAIT_420' });
    },
  };
  const location = new FileLocation({ _: 'inputDocumentFileLocation', id: Long.fromInt(1), accessHash: Long.fromInt(1),
    fileReference: new Uint8Array(), thumbSize: '' }, 1, 2);
  const client = wrapper({
    _client: inner,
    getPeer: async () => ({ photo: { big: location } }),
    downloadAsBuffer: TelegramClient.prototype.downloadAsBuffer,
  });
  await assert.rejects(client.downloadPeerPhoto('123'), (error: unknown) =>
    tl.RpcError.is(error, 'FLOOD_WAIT_%d'));
  assert.equal(threshold, 0);
});

test('an existing message with a parse failure is retryable, not deleted', async () => {
  const client = wrapper({ getMessages: async () => [{}] });
  Object.assign(client, { parseMessage: async () => null });
  await assert.rejects(client.getMessage('123', 1), /Failed to parse existing/);
  const absent = wrapper({ getMessages: async () => [] });
  assert.equal(await absent.getMessage('123', 1), null);
});

test('real mtcute media workers stop 503 retry storms and a later download can succeed', async () => {
  let failing = true;
  let calls = 0;
  let warnings = 0;
  const handler = networkMiddlewares.internalErrorsHandler({});
  const manager = { params: {}, _log: { warn: () => warnings++ } };
  const inner = {
    storage: {}, getPrimaryDcId: async () => 2, getPoolSize: async () => 1,
    log: { debug: () => {} },
    call: async (request: unknown, params: { maxRetryCount: number; throw503: boolean }) => {
      assert.equal(params.maxRetryCount, 2);
      assert.equal(params.throw503, true);
      return handler({ request, params, manager } as any, async () => {
        calls++;
        return failing
          ? { _: 'mt_rpc_error', errorCode: -503, errorMessage: 'Timeout' }
          : { _: 'upload.file', type: { _: 'storage.fileUnknown' }, mtime: 0, bytes: Uint8Array.from([7]) };
      });
    },
  };
  const location = new FileLocation({ _: 'inputDocumentFileLocation', id: Long.fromInt(1), accessHash: Long.fromInt(1),
    fileReference: new Uint8Array(), thumbSize: '' }, 1, 2);
  const client = wrapper({ _client: inner, getPeer: async () => ({ photo: { big: location } }),
    downloadAsBuffer: TelegramClient.prototype.downloadAsBuffer });
  await assert.rejects(client.downloadPeerPhoto('123'), MtTimeoutError);
  assert.equal(calls, 1);
  assert.equal(warnings, 0);
  failing = false;
  assert.deepEqual(await client.downloadPeerPhoto('123'), Buffer.from([7]));
  assert.equal(calls, 2);
});

test('media and avatar transient server failures return retryable 503 without marking media absent', async () => {
  const secret = 'test-telegram-media-outage';
  const client = wrapper({});
  const app = express();
  app.use('/api/v1', createRouter(client, secret));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  try {
    for (const error of [new MtTimeoutError(), tl.RpcError.fromTl({ _: 'rpc_error', errorCode: 500, errorMessage: 'INTERNAL' })]) {
      client.downloadMedia = client.downloadPeerPhoto = async () => { throw error; };
      for (const route of ['/messages/media/123/1', '/peers/123/photo']) {
        const timestamp = Math.floor(Date.now() / 1000);
        const response = await fetch(`${base}${route}`, { headers: {
          'x-connector-timestamp': String(timestamp),
          'x-connector-signature': generateHMACSignature({}, timestamp, secret),
        } });
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('Retry-After'), '60');
        assert.deepEqual(await response.json(), { error: 'Telegram media temporarily unavailable', retryAfter: 60 });
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
