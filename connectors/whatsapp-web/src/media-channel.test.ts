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
