/**
 * Regression tests for the account-namespacing omission on the READ paths and
 * the state/avatar writers (the second batch closed alongside the FK-ordering
 * fix, prod 2026-06-11).
 *
 * Bug class: writers store conversation/participant/message ids namespaced
 * (`professional:<id>`), but several readers and post-hoc UPDATE/SELECT helpers
 * still bound the BARE id into the WHERE clause. On the professional account the
 * bare id never matches the namespaced row, so reads come back empty and UPDATEs
 * silently affect zero rows. The personal account is immune (accountKey is a
 * no-op there).
 *
 * These tests assert the invariant from the read side: a professional read/write
 * queries with the SAME namespaced id that the ingest writers persisted, and any
 * id leaving the connector towards Baileys/the sync service is stripped back to
 * the bare WhatsApp id (so we never hand WhatsApp a `professional:`-prefixed id).
 *
 * They run with no real DB by stubbing pg.Pool#query and capturing SQL + params.
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

/**
 * Stub pg.Pool#query, returning a caller-supplied row set so SELECT-shaped
 * readers get realistic rows back. Captures every (sql, params) pair.
 */
function stubPoolQuery(rows: Record<string, unknown>[] = []): {
  calls: CapturedQuery[];
  restore: () => void;
} {
  const calls: CapturedQuery[] = [];
  const original = pg.Pool.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    return Promise.resolve({ rows });
  };
  return {
    calls,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pg.Pool.prototype as any).query = original;
    },
  };
}

async function loadWriter(account: string): Promise<typeof import('./db-writer.js')> {
  process.env.CONNECTOR_ACCOUNT = account;
  return (await import('./db-writer.ts')) as typeof import('./db-writer.js');
}

async function loadClient(account: string): Promise<typeof import('./baileys-client.js')> {
  process.env.CONNECTOR_ACCOUNT = account;
  return (await import('./baileys-client.ts')) as typeof import('./baileys-client.js');
}

const whereParam = (q: CapturedQuery): unknown => q.params[0];

// ---------------------------------------------------------------------------
// stripAccountKey: inverse of accountKey
// ---------------------------------------------------------------------------

test('stripAccountKey is the inverse of accountKey and round-trips per account', async () => {
  const prof = await loadWriter('professional');
  assert.equal(prof.stripAccountKey('professional:3EB0ABC'), '3EB0ABC');
  assert.equal(prof.stripAccountKey('3EB0ABC'), '3EB0ABC', 'already-bare id is left untouched');
  // round-trip: accountKey then stripAccountKey returns the original bare id.
  assert.equal(prof.stripAccountKey(prof.accountKey('3EB0ABC')), '3EB0ABC');

  const pers = await loadWriter('personal');
  assert.equal(pers.stripAccountKey('professional:3EB0ABC'), 'professional:3EB0ABC');
  assert.equal(pers.stripAccountKey('3EB0ABC'), '3EB0ABC');
});

// ---------------------------------------------------------------------------
// Connector READ path: fetchChatHistory (the main.ts:/api/public/history caller)
// ---------------------------------------------------------------------------

test('professional fetchChatHistory queries with the namespaced conversation id written by ingest', async () => {
  const ingestWroteConvId = 'professional:34600111222@s.whatsapp.net';
  // The DB holds namespaced ids (exactly what storeMessage persisted).
  const { calls, restore } = stubPoolQuery([
    {
      wa_message_id: 'professional:3EB0EABFF068A71576FE7C',
      sender_wa_id: 'professional:34600111222',
      content: 'BAJA',
      wa_timestamp: new Date(),
      is_forwarded: false,
      message_type: 'TEXT',
    },
  ]);
  try {
    const { BaileysClient } = await loadClient('professional');
    const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16));

    // The caller (main.ts) hands the BARE chatId straight off the URL param.
    const out = await client.fetchChatHistory('34600111222@s.whatsapp.net', 50);

    // The SELECT must filter by the SAME namespaced id the ingest stored, or the
    // professional account reads zero rows.
    assert.equal(
      whereParam(calls[0]),
      ingestWroteConvId,
      'fetchChatHistory must namespace the conversation_id it filters on'
    );

    // And the rows handed back to the sync service must speak the BARE WhatsApp
    // id — the prefix is an internal storage detail, never a wire value.
    assert.equal(out[0].id, '3EB0EABFF068A71576FE7C', 'returned message id is stripped to bare');
    assert.equal(out[0].from, '34600111222', 'returned sender is stripped to bare');
  } finally {
    restore();
  }
});

test('personal fetchChatHistory keeps the conversation id bare', async () => {
  const { calls, restore } = stubPoolQuery([]);
  try {
    const { BaileysClient } = await loadClient('personal');
    const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16));
    await client.fetchChatHistory('34699@s.whatsapp.net', 50);
    assert.equal(whereParam(calls[0]), '34699@s.whatsapp.net');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// db-writer state/avatar helpers: UPDATE/SELECT must target the namespaced row
// ---------------------------------------------------------------------------

test('professional setConversationState UPDATEs the namespaced conversation row', async () => {
  const { calls, restore } = stubPoolQuery();
  try {
    const w = await loadWriter('professional');
    await w.setConversationState('34600111222@s.whatsapp.net', 3, true);
    assert.equal(whereParam(calls[0]), 'professional:34600111222@s.whatsapp.net');
  } finally {
    restore();
  }
});

test('professional setMessageStatus UPDATEs the namespaced message row', async () => {
  const { calls, restore } = stubPoolQuery();
  try {
    const w = await loadWriter('professional');
    await w.setMessageStatus('3EB0EABFF068A71576FE7C', 'read');
    assert.equal(whereParam(calls[0]), 'professional:3EB0EABFF068A71576FE7C');
  } finally {
    restore();
  }
});

test('professional avatar get/set helpers target the namespaced row', async () => {
  const { calls, restore } = stubPoolQuery([{ avatar_url: 'x', profile_pic_url: 'y' }]);
  try {
    const w = await loadWriter('professional');
    await w.getConversationAvatar('34600@s.whatsapp.net');
    await w.setConversationAvatar('34600@s.whatsapp.net', 'minio/key');
    await w.getParticipantAvatar('34600');
    await w.setParticipantAvatar('34600', 'minio/key');
    assert.equal(whereParam(calls[0]), 'professional:34600@s.whatsapp.net');
    assert.equal(whereParam(calls[1]), 'professional:34600@s.whatsapp.net');
    assert.equal(whereParam(calls[2]), 'professional:34600');
    assert.equal(whereParam(calls[3]), 'professional:34600');
  } finally {
    restore();
  }
});

test('professional recordHistorySyncProgress namespaces the sync_state FK (idempotent for namespaced callers)', async () => {
  const { calls, restore } = stubPoolQuery();
  try {
    const w = await loadWriter('professional');
    // Bare caller (history.set path).
    await w.recordHistorySyncProgress({ conversationId: '34600@s.whatsapp.net' });
    assert.equal(whereParam(calls[0]), 'professional:34600@s.whatsapp.net');
    // Already-namespaced caller (backfill loadOldest rows) must NOT double-prefix.
    await w.recordHistorySyncProgress({ conversationId: 'professional:34600@s.whatsapp.net' });
    assert.equal(whereParam(calls[1]), 'professional:34600@s.whatsapp.net');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Connector READ path: reconstructMessageForRetryFromDb (Baileys getMessage
// retry callback — receives the BARE WhatsApp message id from the wire)
// ---------------------------------------------------------------------------

test('professional message-retry reconstruction queries with the namespaced wa_message_id', async () => {
  const { calls, restore } = stubPoolQuery([{ content: 'hola', message_type: 'TEXT' }]);
  try {
    const { BaileysClient } = await loadClient('professional');
    const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16));
    const reconstruct = (
      client as unknown as {
        reconstructMessageForRetryFromDb(id: string): Promise<{ conversation?: string } | undefined>;
      }
    ).reconstructMessageForRetryFromDb.bind(client);

    const out = await reconstruct('3EB0EABFF068A71576FE7C');

    assert.equal(
      whereParam(calls[0]),
      'professional:3EB0EABFF068A71576FE7C',
      'retry reconstruction must namespace the wa_message_id it filters on'
    );
    assert.equal(out?.conversation, 'hola');
  } finally {
    restore();
  }
});

test('personal message-retry reconstruction keeps the wa_message_id bare', async () => {
  const { calls, restore } = stubPoolQuery([{ content: 'hey', message_type: 'TEXT' }]);
  try {
    const { BaileysClient } = await loadClient('personal');
    const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16));
    const reconstruct = (
      client as unknown as {
        reconstructMessageForRetryFromDb(id: string): Promise<{ conversation?: string } | undefined>;
      }
    ).reconstructMessageForRetryFromDb.bind(client);

    await reconstruct('3EB0AAAA');

    assert.equal(whereParam(calls[0]), '3EB0AAAA');
  } finally {
    restore();
  }
});
