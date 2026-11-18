import { PoolClient } from 'pg';
import { parseAccounts } from '../domain/account-registry';
import {
  advanceSyncEntry,
  buildSyncEntry,
  destinationKey,
  fetchSyncCandidates,
  messageScope,
  runSyncPass,
  scopeEnabled,
  seedHistoryBatch,
  SyncClient,
  SyncMessage,
  selectionHash,
  syncOptionsFromEnv,
  versionOperationId,
} from './hindsight-sync-lib';

const id = '550e8400-e29b-41d4-a716-446655440000';
const registry = parseAccounts([
  { channel: 'whatsapp', accountId: 'personal', connectorUrl: 'http://wa' },
  { channel: 'instagram', accountId: 'business', namespace: 'personal' },
  { channel: 'instagram', accountId: 'disabled', namespace: 'personal', enabled: false },
]);
const options = syncOptionsFromEnv({});
const message = (patch: Partial<SyncMessage> = {}): SyncMessage => ({
  id,
  platform: 'whatsapp',
  account: 'personal',
  conversation_id: 'personal:chat',
  wa_message_id: 'original-id',
  wa_timestamp: '2026-01-01T12:00:00Z',
  sender_wa_id: 'sender',
  content: 'Original message',
  direction: 'INBOUND',
  message_type: 'TEXT',
  is_deleted: false,
  metadata: {},
  ...patch,
});
const entry = (patch: Partial<SyncMessage> = {}, revision = '1') => {
  const row = message(patch);
  return buildSyncEntry('dest', id, revision, row, messageScope(row), registry, options);
};
function client(): jest.Mocked<SyncClient> {
  return {
    getOperation: jest.fn().mockResolvedValue({ operationId: 'op', status: 'not_found' }),
    retainDocument: jest.fn().mockResolvedValue({ operationId: 'op' }),
    retryOperation: jest.fn().mockResolvedValue({ operationId: 'op' }),
    deleteDocument: jest.fn().mockResolvedValue(undefined),
  };
}

describe('Hindsight per-message sync versions and scopes', () => {
  it('defaults to bounded full-history one-shot and validates options', () => {
    expect(options).toEqual({
      batch: 100,
      intervalMs: 30000,
      retryMs: 30000,
      since: '1970-01-01T00:00:00.000Z',
      chatIds: [],
      loop: false,
    });
    expect(
      syncOptionsFromEnv({ HINDSIGHT_SYNC_CHAT_IDS: 'a, b', HINDSIGHT_SYNC_LOOP: 'true' }).chatIds
    ).toEqual(['a', 'b']);
    expect(() => syncOptionsFromEnv({ HINDSIGHT_SYNC_BATCH: '0' })).toThrow();
    expect(() => syncOptionsFromEnv({ HINDSIGHT_SYNC_SINCE: 'invalid' })).toThrow();
  });

  it('keeps original chronology/sender/text, with string metadata and isolated tags', () => {
    const value = entry();
    expect(value.payload.content).toBe('[2026-01-01T12:00:00.000Z] sender: Original message');
    expect(value.payload.documentId).toBe(`socialmedia-${id}`);
    expect(Object.values(value.payload.metadata).every(v => typeof v === 'string')).toBe(true);
    expect(value.payload.tags).toHaveLength(2);
  });

  it('uses Instagram metadata authoritatively and rejects missing/disabled/cross-platform scopes', () => {
    const ig = message({ platform: 'instagram', metadata: { instagram_account: 'business' } });
    expect(scopeEnabled(messageScope(ig), registry)).toBe(true);
    expect(entry({ platform: 'instagram', metadata: {} }).isDeleted).toBe(true);
    expect(
      entry({ platform: 'instagram', metadata: { instagram_account: 'disabled' } }).isDeleted
    ).toBe(true);
    expect(entry({ platform: 'telegram' }).isDeleted).toBe(true);
    expect(entry({ account: 'other' }).isDeleted).toBe(true);
  });

  it('changes version for edits, transcript, source metadata, timestamp and deletes', () => {
    const base = entry();
    for (const patch of [
      { content: 'edited' },
      { content: 'transcript', message_type: 'AUDIO' },
      { metadata: { sender_name: 'New name' } },
      { wa_timestamp: '2026-01-02T12:00:00Z' },
      { is_deleted: true },
      { metadata: { deleted_for_me: true } },
    ]) {
      expect(entry(patch).versionHash).not.toBe(base.versionHash);
    }
  });

  it('ignores retry/claim bookkeeping and metadata key ordering', () => {
    expect(entry({ metadata: { a: 1, b: 2 } }).versionHash).toBe(
      entry({ metadata: { b: 2, a: 1 } }).versionHash
    );
    expect(
      entry({
        metadata: {
          transcription_status: 'pending',
          transcription_attempts: 3,
          transcription_error: 'timeout',
          transcription_claimed_at: 'today',
        },
      }).versionHash
    ).toBe(entry().versionHash);
  });

  it('only keeps whitelisted provenance and unwraps legacy ASR JSON', () => {
    const value = entry({
      content: '{"text":"spoken words","usage":null}',
      metadata: {
        sender_name: 'Speaker',
        raw_payload: { key: 'private' },
        media_key: 'private',
        signed_url: 'private',
      },
    });
    expect(value.payload.content).toContain('spoken words');
    expect(value.payload.content).not.toContain('usage');
    expect(value.payload.metadata.sender_name).toBe('Speaker');
    expect(JSON.stringify(value.payload)).not.toContain('private');
  });

  it('hashes only semantic selection settings rather than loop/retry bookkeeping', () => {
    expect(selectionHash(registry, { ...options, retryMs: 50, loop: true })).toBe(
      selectionHash(registry, options)
    );
    expect(selectionHash(registry, { ...options, chatIds: ['other'] })).not.toBe(
      selectionHash(registry, options)
    );
  });

  it('retains stable operation IDs on retries and creates distinct A -> B -> A IDs and destinations', () => {
    const a = entry({}, '1');
    expect(a.operationId).toBe(entry({}, '1').operationId);
    expect(entry({}, '3').operationId).not.toBe(a.operationId);
    expect(versionOperationId('different', id, '1', a.versionHash)).not.toBe(a.operationId);
    expect(a.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(destinationKey('https://hindsight/', 'bank')).toBe(
      destinationKey('https://hindsight', 'bank')
    );
    expect(destinationKey('https://hindsight', 'other')).not.toBe(
      destinationKey('https://hindsight', 'bank')
    );
  });

  it('applies since/chat filters and creates hard-delete tombstones', () => {
    const row = message();
    expect(
      buildSyncEntry('dest', id, '1', row, messageScope(row), registry, {
        ...options,
        since: '2027-01-01T00:00:00Z',
      }).isDeleted
    ).toBe(true);
    expect(
      buildSyncEntry('dest', id, '1', row, messageScope(row), registry, {
        ...options,
        chatIds: ['other'],
      }).isDeleted
    ).toBe(true);
    expect(
      buildSyncEntry('dest', id, '2', null, messageScope(row), registry, options).isDeleted
    ).toBe(true);
  });

  it('creates a fresh retain UUID when selection excludes and later restores the same source revision', () => {
    const row = message(),
      scope = messageScope(row);
    const first = buildSyncEntry('dest', id, '1', row, scope, registry, options);
    const removed = buildSyncEntry(
      'dest',
      id,
      '1',
      row,
      scope,
      registry,
      { ...options, chatIds: ['other'] },
      first.operationId
    );
    const restored = buildSyncEntry(
      'dest',
      id,
      '1',
      row,
      scope,
      registry,
      options,
      removed.operationId
    );
    expect(restored.versionHash).toBe(first.versionHash);
    expect(restored.operationId).not.toBe(first.operationId);
  });
});

describe('durable asynchronous completion', () => {
  it('marks submission accepted, never completed, until completion is polled', async () => {
    const c = client(),
      save = jest.fn(),
      e = entry();
    expect(await advanceSyncEntry(e, c, save, 100)).toBe('accepted');
    expect(c.retainDocument).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: e.operationId })
    );
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'accepted' }), 100);
    c.getOperation.mockResolvedValue({ operationId: e.operationId, status: 'completed' });
    expect(await advanceSyncEntry(e, c, save, 100)).toBe('completed');
    expect(c.retainDocument).toHaveBeenCalledTimes(1);
  });

  it('recovers lost acknowledgement with same operation ID before resubmitting', async () => {
    const c = client(),
      save = jest.fn(),
      e = entry();
    c.retainDocument.mockRejectedValueOnce(new Error('lost HTTP response'));
    await expect(advanceSyncEntry(e, c, save, 100)).rejects.toThrow();
    expect(e.status).toBe('failed');
    c.getOperation.mockResolvedValue({ operationId: e.operationId, status: 'processing' });
    expect(await advanceSyncEntry(e, c, save, 100)).toBe('accepted');
    expect(c.retainDocument).toHaveBeenCalledTimes(1);
  });

  it.each(['failed', 'cancelled'] as const)(
    'retries remote %s operation without changing ID',
    async status => {
      const c = client(),
        e = entry();
      c.getOperation.mockResolvedValue({ operationId: e.operationId, status });
      expect(await advanceSyncEntry(e, c, jest.fn(), 100)).toBe('accepted');
      expect(c.retryOperation).toHaveBeenCalledWith(e.operationId);
      expect(c.retainDocument).not.toHaveBeenCalled();
    }
  );

  it('keeps pending operation durable when status lookup fails and retries it', async () => {
    const c = client(),
      save = jest.fn(),
      e = entry();
    c.getOperation.mockRejectedValueOnce(new Error('unavailable'));
    await expect(advanceSyncEntry(e, c, save, 100)).rejects.toThrow();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }), 100);
    expect(await advanceSyncEntry(e, c, save, 100)).toBe('accepted');
  });

  it('saves failed deletions and completes only acknowledged deletion', async () => {
    const c = client(),
      save = jest.fn(),
      e = entry({ is_deleted: true });
    c.deleteDocument.mockRejectedValueOnce(new Error('unavailable'));
    await expect(advanceSyncEntry(e, c, save, 100)).rejects.toThrow();
    expect(e.status).toBe('failed');
    expect(await advanceSyncEntry(e, c, save, 100)).toBe('completed');
    expect(c.getOperation).not.toHaveBeenCalled();
    expect(c.retainDocument).not.toHaveBeenCalled();
  });
});

describe('database queue and pending snapshots', () => {
  function database(candidate?: object) {
    return {
      query: jest.fn(async (sql: string) => {
        if (sql.startsWith('SELECT * FROM hindsight_sync_destinations'))
          return { rows: [{ seeded: true }] };
        if (sql.startsWith('SELECT c.message_id')) return { rows: candidate ? [candidate] : [] };
        return { rows: [] };
      }),
    } as unknown as PoolClient;
  }
  const ledger = (e: ReturnType<typeof entry>) => ({
    destination: e.destination,
    message_id: e.messageId,
    source_revision: e.sourceRevision,
    version_hash: e.versionHash,
    selection_hash: e.selectionHash,
    operation_id: e.operationId,
    payload: e.payload,
    is_deleted: e.isDeleted,
    status: e.status,
    attempts: e.attempts,
  });

  it('completes the earlier async version before applying a later hard delete', async () => {
    const c = client(),
      earlier = entry();
    earlier.status = 'accepted';
    c.getOperation.mockResolvedValue({ operationId: earlier.operationId, status: 'completed' });
    const candidate = {
      message_id: id,
      revision: '2',
      scope: messageScope(message()),
      message: null,
      ledger: ledger(earlier),
    };
    expect((await runSyncPass(database(candidate), c, 'dest', registry, options)).completed).toBe(
      1
    );
    expect(c.deleteDocument).not.toHaveBeenCalled();
    const completed = { ...earlier, status: 'completed' as const };
    await runSyncPass(
      database({ ...candidate, ledger: ledger(completed) }),
      c,
      'dest',
      registry,
      options
    );
    expect(c.deleteDocument).toHaveBeenCalledWith(earlier.payload.documentId);
  });

  it('preserves old snapshot after edit until old operation finishes', async () => {
    const c = client(),
      old = entry();
    old.status = 'accepted';
    await runSyncPass(
      database({
        message_id: id,
        revision: '2',
        scope: messageScope(message()),
        message: message({ content: 'edit' }),
        ledger: ledger(old),
      }),
      c,
      'dest',
      registry,
      options
    );
    expect(c.retainDocument).toHaveBeenCalledWith(
      expect.objectContaining({ content: old.payload.content, operationId: old.operationId })
    );
  });

  it('avoids retain for a revision containing only operational metadata updates', async () => {
    const c = client(),
      old = entry();
    old.status = 'completed';
    await runSyncPass(
      database({
        message_id: id,
        revision: '2',
        scope: messageScope(message()),
        message: message({ metadata: { transcription_attempts: 2 } }),
        ledger: ledger(old),
      }),
      c,
      'dest',
      registry,
      options
    );
    expect(c.retainDocument).not.toHaveBeenCalled();
    expect(c.getOperation).not.toHaveBeenCalled();
  });

  it('purges indexed documents when a chat becomes excluded or provider disabled', async () => {
    for (const [accounts, settings] of [
      [registry, { ...options, chatIds: ['different'] }],
      [registry.map(a => ({ ...a, enabled: false })), options],
    ] as const) {
      const c = client(),
        old = entry();
      old.status = 'completed';
      const candidate = {
        message_id: id,
        revision: '1',
        scope: messageScope(message()),
        message: message(),
        ledger: ledger(old),
      };
      await runSyncPass(database(candidate), c, 'dest', accounts, {
        ...settings,
        chatIds: [...settings.chatIds],
      });
      expect(c.deleteDocument).toHaveBeenCalledWith(old.payload.documentId);
      expect(c.retainDocument).not.toHaveBeenCalled();
    }
  });

  it('binds enabled exact platform/namespace/provider scopes and processes existing ledger outside initial filters', async () => {
    const db = database();
    await fetchSyncCandidates(db, 'dest', registry, { ...options, chatIds: ['selected'] });
    const [sql, params] = (db.query as jest.Mock).mock.calls[0];
    expect(sql).toContain("l.payload->'scope'->>'provider_account'=s.provider_account");
    expect(sql).toContain('l.message_id IS NOT NULL OR');
    expect(JSON.parse(params[1])).toEqual([
      { platform: 'whatsapp', namespace: 'personal', provider_account: 'personal' },
      { platform: 'instagram', namespace: 'personal', provider_account: 'business' },
    ]);
    expect(params[3]).toEqual(['selected']);
  });

  it('rolls back seeding if queue insertion fails, so history is not skipped', async () => {
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.startsWith('SELECT *')) return { rows: [{ seeded: false, seed_last_id: null }] };
        if (sql.startsWith('SELECT id')) return { rows: [{ id }] };
        if (sql.startsWith('INSERT INTO hindsight_sync_changes'))
          throw new Error('database unavailable');
        return { rows: [] };
      }),
    } as unknown as PoolClient;
    await expect(seedHistoryBatch(db, 'dest', 100)).rejects.toThrow();
    expect(db.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(
      (db.query as jest.Mock).mock.calls.some(([sql]) =>
        sql.startsWith('UPDATE hindsight_sync_destinations')
      )
    ).toBe(false);
  });
});
