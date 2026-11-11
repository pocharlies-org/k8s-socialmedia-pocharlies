import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import * as MinIO from 'minio';
import { BaileysClient } from './baileys-client.js';

for (const hintFails of [false, true]) {
  test(`committed media refreshes its account without invalidating the upload (hintFails=${hintFails})`, async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const connect = pg.Pool.prototype.connect;
    const query = pg.Pool.prototype.query;
    const put = MinIO.Client.prototype.putObject;
    const client = Object.create(BaileysClient.prototype) as any;
    const warnings: string[] = [];
    client.logger = { warn: (value: string) => warnings.push(value) };
    (pg.Pool.prototype as any).connect = async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (hintFails && sql.includes('pg_notify'))
          throw Object.assign(new Error('notify unavailable'), { code: '53300' });
        return { rows: sql.includes('SELECT id') ? [{ id: 'message-uuid' }] : [] };
      },
      release: () => calls.push({ sql: 'release', params: [] }),
    });
    (pg.Pool.prototype as any).query = async (sql: string, params: unknown[]) => {
      throw new Error('Do not acquire another connection while holding the upload connection');
    };
    (MinIO.Client.prototype as any).putObject = async () => ({ etag: 'stored' });
    try {
      const result = await client.storeMediaBytesOnce(
        'message-uuid', Buffer.from('photo'), 'IMAGE', 'image/jpeg', 'photo-\u00e1.jpg', 'caption-\u00e1'
      );
      assert.equal(result.fileSize, 5);
      const attachment = calls.find(call => call.sql.includes('INSERT INTO attachments'))!;
      assert.equal(attachment.params[3], 'photo-\u00e1.jpg');
      assert.equal(attachment.params[6], 'caption-\u00e1');
      const commit = calls.findIndex(call => call.sql === 'COMMIT');
      const hint = calls.findIndex(call => call.sql.includes('pg_notify'));
      assert.ok(hint > commit, 'readers must see the attachment before receiving the hint');
      assert.deepEqual(calls[hint].params, ['message-uuid', 'personal']);
      assert.match(calls[hint].sql, /account=\$2 AND platform='whatsapp'/);
      assert.match(calls[hint].sql, /'reason', 'attachment'/);
      assert.doesNotMatch(calls[hint].sql, /caption|file_url|content/);
      assert.equal(calls.some(call => call.sql === 'ROLLBACK'), false);
      assert.equal(warnings.length, hintFails ? 1 : 0);
    } finally {
      pg.Pool.prototype.connect = connect;
      pg.Pool.prototype.query = query;
      MinIO.Client.prototype.putObject = put;
    }
  });
}
