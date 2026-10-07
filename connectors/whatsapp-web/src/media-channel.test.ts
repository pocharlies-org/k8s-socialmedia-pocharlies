import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

test('attachment lookup scopes both provider ID and UUID to WhatsApp and connector account', async () => {
  const previousAccount = process.env.CONNECTOR_ACCOUNT;
  process.env.CONNECTOR_ACCOUNT = 'personal';
  const original = pg.Pool.prototype.query;
  let captured: { sql: string; params: unknown[] } | undefined;
  (pg.Pool.prototype as any).query = async (sql: string, params: unknown[]) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    const { BaileysClient } = await import('./baileys-client');
    const client = new BaileysClient('/tmp/unused-media-test-session', 'k'.repeat(16));
    assert.equal(await client.downloadMedia('chat', 'same-wa-ig-message'), null);
    assert.ok(captured);
    assert.match(captured.sql, /\(m\.wa_message_id = \$1 OR m\.id::text = \$2\) AND m\.account = \$3\s+AND m\.platform = 'whatsapp'/);
    assert.deepEqual(captured.params, ['same-wa-ig-message', 'same-wa-ig-message', 'personal']);
  } finally {
    pg.Pool.prototype.query = original;
    if (previousAccount === undefined) delete process.env.CONNECTOR_ACCOUNT;
    else process.env.CONNECTOR_ACCOUNT = previousAccount;
  }
});

test('newsletter media uses the isolated account/channel row and keeps the legacy response', async () => {
  const previousAccount = process.env.CONNECTOR_ACCOUNT;
  process.env.CONNECTOR_ACCOUNT = 'personal';
  const original = pg.Pool.prototype.query;
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  (pg.Pool.prototype as any).query = async (sql: string, params: unknown[]) => {
    queries.push({ sql, params });
    return { rows: [{
      account: 'personal', channel_jid: '100@newsletter', message_id: 'same',
      message_key: { id: 'same', remoteJid: '100@newsletter' },
      message_payload: { imageMessage: { mimetype: 'image/jpeg', caption: 'photo' } },
      message_timestamp_ms: 1000, visibility: 'visible', is_deleted: false,
    }] };
  };
  try {
    const { BaileysClient } = await import('./baileys-client');
    const client = new BaileysClient('/tmp/unused-media-test-session', 'k'.repeat(16));
    let downloaded: any;
    client.downloadNovedadesMedia = async message => {
      downloaded = message;
      return { buffer: Buffer.from('image'), mimeType: 'image/jpeg', fileName: 'photo.jpg' };
    };
    assert.deepEqual(await client.downloadMedia('100@newsletter', 'same'), {
      data: Buffer.from('image').toString('base64'), mimetype: 'image/jpeg', filename: 'photo.jpg',
    });
    assert.deepEqual(queries[0].params, ['personal', '100@newsletter', 'same']);
    assert.equal(queries.length, 1);
    assert.equal(downloaded.key.remoteJid, '100@newsletter');
    assert.equal(downloaded.message.imageMessage.caption, 'photo');
    assert.ok(queries.every(query => /^\s*SELECT/i.test(query.sql)), 'download writes nothing');
  } finally {
    pg.Pool.prototype.query = original;
    if (previousAccount === undefined) delete process.env.CONNECTOR_ACCOUNT;
    else process.env.CONNECTOR_ACCOUNT = previousAccount;
  }
});

test('deleted, hidden and superseded newsletter media never falls back to a legacy copy', async () => {
  const previousAccount = process.env.CONNECTOR_ACCOUNT;
  process.env.CONNECTOR_ACCOUNT = 'personal';
  const original = pg.Pool.prototype.query;
  try {
    const { BaileysClient } = await import('./baileys-client');
    const client = new BaileysClient('/tmp/unused-media-test-session', 'k'.repeat(16));
    client.downloadNovedadesMedia = async () => { throw new Error('must not download'); };
    for (const state of [{ is_deleted: true }, { visibility: 'event' }, { superseded_by: 'new' }]) {
      const queries: string[] = [];
      (pg.Pool.prototype as any).query = async (sql: string) => {
        queries.push(sql);
        return { rows: [{
          account: 'personal', channel_jid: '100@newsletter', message_id: 'same',
          message_key: { id: 'same', remoteJid: '100@newsletter' },
          message_payload: { imageMessage: { mimetype: 'image/jpeg' } },
          visibility: 'visible', is_deleted: false, ...state,
        }] };
      };
      assert.equal(await client.downloadMedia('100@newsletter', 'same'), null);
      assert.equal(queries.length, 1);
      assert.ok(queries.every(sql => /whatsapp_novedades_messages/.test(sql)));
    }
  } finally {
    pg.Pool.prototype.query = original;
    if (previousAccount === undefined) delete process.env.CONNECTOR_ACCOUNT;
    else process.env.CONNECTOR_ACCOUNT = previousAccount;
  }
});

test('newsletter legacy fallback scopes identical provider IDs to the requested channel', async () => {
  const previousAccount = process.env.CONNECTOR_ACCOUNT;
  process.env.CONNECTOR_ACCOUNT = 'personal';
  const original = pg.Pool.prototype.query;
  try {
    const { BaileysClient } = await import('./baileys-client');
    const client = new BaileysClient('/tmp/unused-media-test-session', 'k'.repeat(16));
    for (const missingTable of [false, true]) {
      let attachment: { sql: string; params: unknown[] } | undefined;
      (pg.Pool.prototype as any).query = async (sql: string, params: unknown[]) => {
        if (/whatsapp_novedades_messages/.test(sql) && missingTable)
          throw Object.assign(new Error('missing table'), { code: '42P01' });
        if (/FROM attachments/.test(sql)) attachment = { sql, params };
        return { rows: [] };
      };
      assert.equal(await client.downloadMedia('200@newsletter', 'same'), null);
      assert.ok(attachment);
      assert.match(attachment.sql, /m\.conversation_id = \$4/);
      assert.match(attachment.sql, /c\.account = \$3 AND c\.external_id = \$5/);
      assert.deepEqual(attachment.params, ['same', 'same', 'personal', '200@newsletter', '200@newsletter']);
    }
  } finally {
    pg.Pool.prototype.query = original;
    if (previousAccount === undefined) delete process.env.CONNECTOR_ACCOUNT;
    else process.env.CONNECTOR_ACCOUNT = previousAccount;
  }
});
