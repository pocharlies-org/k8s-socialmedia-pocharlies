/**
 * Tests for the F1.7 "honest voice" pre-emit audio attachment builder.
 *
 * Contract under test (buildAudioAttachmentsBeforeEmit):
 *   1. Success: upload finished within the budget + presign available ⇒
 *      returns [{type:'audio', url, metadata:{mimeType,fileName,fileSize,
 *      seconds?,objectKey,urlExpiresInSeconds}}] — the exact shape synapse's
 *      audio.py consumes (att.url http(s), metadata.mimeType/fileName).
 *   2. Timeout: store slower than timeoutMs ⇒ undefined (event degrades to
 *      the historical no-attachment emit), the store promise keeps running
 *      (persist still lands) and a LATE store rejection never surfaces as an
 *      unhandled rejection.
 *   3. Store failure ⇒ undefined.
 *   4. Presign unavailable (null) or throwing ⇒ undefined.
 * The helper must NEVER throw: every failure degrades to pre-F1.7 behavior.
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAudioAttachmentsBeforeEmit,
  StoredMediaInfo,
  BuildAudioAttachmentsOptions,
} from './audio-attachments';

const STORED: StoredMediaInfo = {
  storageKey: 's3://skirmshop-drive/socialmedia/attachments/42/1.ogg',
  fileSize: 12345,
  mimeType: 'audio/ogg; codecs=opus',
  fileName: undefined,
};

function silentLogger(): { info(m: string): void; warn(m: string): void; warns: string[] } {
  const warns: string[] = [];
  return {
    warns,
    info: () => undefined,
    warn: (m: string) => {
      warns.push(m);
    },
  };
}

function baseOpts(over: Partial<BuildAudioAttachmentsOptions> = {}): BuildAudioAttachmentsOptions {
  return {
    store: async () => STORED,
    presign: async () => 'https://skirmshop-s3.lan.e-dani.com/skirmshop-drive/x?X-Amz-Signature=s',
    timeoutMs: 200,
    seconds: 7,
    presignExpirySeconds: 3600,
    logger: silentLogger(),
    logRef: 'WAMSG1',
    ...over,
  };
}

test('success: returns the audio.py-compatible attachment shape', async () => {
  const atts = await buildAudioAttachmentsBeforeEmit(baseOpts());
  assert.ok(atts && atts.length === 1);
  const att = atts[0];
  assert.equal(att.type, 'audio');
  assert.match(att.url, /^https:\/\/skirmshop-s3\.lan\.e-dani\.com\//);
  assert.equal(att.metadata.mimeType, 'audio/ogg; codecs=opus');
  assert.equal(att.metadata.fileSize, 12345);
  assert.equal(att.metadata.seconds, 7);
  assert.equal(att.metadata.objectKey, STORED.storageKey);
  assert.equal(att.metadata.urlExpiresInSeconds, 3600);
});

test('success without duration: seconds key omitted (never invented)', async () => {
  const atts = await buildAudioAttachmentsBeforeEmit(baseOpts({ seconds: undefined }));
  assert.ok(atts);
  assert.equal('seconds' in atts[0].metadata, false);
});

test('timeout: emits without attachments while the store keeps running', async () => {
  let storeFinished = false;
  let finishStore!: (v: StoredMediaInfo) => void;
  const slow = new Promise<StoredMediaInfo>(resolve => {
    finishStore = v => {
      storeFinished = true;
      resolve(v);
    };
  });
  const logger = silentLogger();
  const atts = await buildAudioAttachmentsBeforeEmit(
    baseOpts({ store: () => slow, timeoutMs: 25, logger })
  );
  assert.equal(atts, undefined);
  assert.equal(storeFinished, false); // we gave up waiting, not the upload
  assert.ok(logger.warns.some(w => w.includes('exceeded 25ms')));
  // The abandoned promise resolving later must be inert (no throw/unhandled).
  finishStore(STORED);
  await slow;
  assert.equal(storeFinished, true);
});

test('timeout + late store REJECTION never becomes an unhandled rejection', async () => {
  let rejectStore!: (e: Error) => void;
  const slow = new Promise<StoredMediaInfo>((_, reject) => {
    rejectStore = reject;
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const atts = await buildAudioAttachmentsBeforeEmit(
      baseOpts({ store: () => slow, timeoutMs: 25 })
    );
    assert.equal(atts, undefined);
    rejectStore(new Error('late boom'));
    // Give the event loop a macrotask turn for any unhandledRejection to fire.
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('store failure (rejects in time): undefined, logged, no throw', async () => {
  const logger = silentLogger();
  const atts = await buildAudioAttachmentsBeforeEmit(
    baseOpts({
      store: () => Promise.reject(new Error('download broke')),
      logger,
    })
  );
  assert.equal(atts, undefined);
  assert.ok(logger.warns.some(w => w.includes('download broke')));
});

test('store resolves null (empty download): undefined', async () => {
  const atts = await buildAudioAttachmentsBeforeEmit(baseOpts({ store: async () => null }));
  assert.equal(atts, undefined);
});

test('presign unavailable (null): undefined, logged', async () => {
  const logger = silentLogger();
  const atts = await buildAudioAttachmentsBeforeEmit(
    baseOpts({ presign: async () => null, logger })
  );
  assert.equal(atts, undefined);
  assert.ok(logger.warns.some(w => w.includes('presign unavailable')));
});

test('presign throwing: undefined, logged, no throw', async () => {
  const logger = silentLogger();
  const atts = await buildAudioAttachmentsBeforeEmit(
    baseOpts({
      presign: () => Promise.reject(new Error('signer down')),
      logger,
    })
  );
  assert.equal(atts, undefined);
  assert.ok(logger.warns.some(w => w.includes('signer down')));
});
