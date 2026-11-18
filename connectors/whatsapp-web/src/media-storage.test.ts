import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import * as MinIO from 'minio';
import { fetchMedia, parseStorageRef, uploadMedia } from './media-storage';

for (const fileName of ['qa-ascii.jpg', 'qa-prueba-\u00e1.jpg', 'qa-\ud83d\udcf7.jpg']) {
  test(`media upload uses ASCII headers for ${JSON.stringify(fileName)}`, async (t) => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]);
    let uploaded: { bucket: string; key: string; data: Buffer } | undefined;
    t.mock.method(
      MinIO.Client.prototype,
      'putObject',
      async (bucket: string, key: string, data: Buffer, size: number, meta: Record<string, string>) => {
        assert.equal(size, bytes.length);
        assert.deepEqual(data, bytes);
        assert.deepEqual(meta, { 'Content-Type': 'image/jpeg' });
        for (const value of Object.values(meta)) assert.match(value, /^[\x20-\x7e]*$/);
        uploaded = { bucket, key, data: Buffer.from(data) };
        return { etag: 'test-etag' };
      }
    );
    t.mock.method(MinIO.Client.prototype, 'getObject', async (bucket: string, key: string) => {
      assert.ok(uploaded);
      assert.equal(bucket, uploaded.bucket);
      assert.equal(key, uploaded.key);
      return Readable.from([uploaded.data]);
    });

    const result = await uploadMedia('test-message', bytes, 'image/jpeg', fileName);
    assert.equal(result.fileSize, bytes.length);
    const ref = parseStorageRef(result.storageKey);
    assert.equal(ref.legacy, false);
    assert.match(ref.key, /(?:^|\/)attachments\/test-message\/\d+\.jpg$/);
    assert.deepEqual(await fetchMedia(result.storageKey), bytes);
  });
}

test('media without a filename or MIME type uploads without optional metadata', async (t) => {
  t.mock.method(
    MinIO.Client.prototype,
    'putObject',
    async (_bucket: string, key: string, data: Buffer, size: number, meta: Record<string, string>) => {
      assert.match(key, /\.bin$/);
      assert.equal(size, data.length);
      assert.deepEqual(meta, {});
      return { etag: 'test-etag' };
    }
  );
  await uploadMedia('test-message', Buffer.from('media'), undefined, undefined);
});
