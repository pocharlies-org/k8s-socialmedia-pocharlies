/**
 * SC-705 phase 1.5: PostgresCredentialStore encryption behavior, exercised
 * against a fake Pool that captures exactly what WOULD go to the INSERT —
 * the hard SC-552/SC-705 rule is "the DB never sees plaintext", so the
 * assertion belongs on the query parameters, not on the returned object.
 */
import { randomBytes } from 'node:crypto';
import {
  PostgresCredentialStore,
  encryptCredentialPayload,
  isEncryptedPayloadEnvelope,
} from '@mcp-socialmedia/shared';

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

function fakePool(handler: (sql: string, params: unknown[]) => { rows: unknown[] }) {
  const captured: CapturedQuery[] = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      captured.push({ sql, params });
      return handler(sql, params);
    },
  } as never;
  return { pool, captured };
}

const SECRET_SESSION = {
  files: { 'creds.json': Buffer.from('PRIVATE-SIGNAL-MATERIAL').toString('base64') },
};

describe('SC-705 PostgresCredentialStore encryption', () => {
  const masterKey = randomBytes(32);

  test('put() sends an envelope to the INSERT and never the plaintext', async () => {
    const { pool, captured } = fakePool(() => ({ rows: [] }));
    const store = new PostgresCredentialStore(pool, { masterKey });

    await store.put('sub-1', 'whatsapp', SECRET_SESSION);

    const insert = captured.find(q => q.sql.includes('INSERT INTO user_channel_credentials'));
    expect(insert).toBeDefined();
    const [, , payloadJson] = insert!.params as [string, string, string];
    expect(insert!.params[0]).toBe('sub-1');
    expect(insert!.params[1]).toBe('whatsapp');
    const stored = JSON.parse(payloadJson);
    expect(isEncryptedPayloadEnvelope(stored)).toBe(true);
    expect(payloadJson).not.toContain('PRIVATE-SIGNAL-MATERIAL');
    expect(payloadJson).not.toContain(Buffer.from('PRIVATE-SIGNAL-MATERIAL').toString('base64'));
  });

  test('get() decrypts the stored envelope back to the channel payload', async () => {
    const envelope = encryptCredentialPayload(SECRET_SESSION, masterKey);
    const { pool } = fakePool(sql =>
      sql.includes('SELECT')
        ? {
            rows: [
              {
                session_key: 'sub-1',
                channel: 'whatsapp',
                payload: envelope,
                updated_at: new Date(),
              },
            ],
          }
        : { rows: [] }
    );
    const store = new PostgresCredentialStore(pool, { masterKey });

    const row = await store.get('sub-1', 'whatsapp');
    expect(row?.payload).toEqual(SECRET_SESSION);
    expect(row?.sessionKey).toBe('sub-1');
  });

  test('put() without a master key throws before touching the pool (fail closed)', async () => {
    const { pool, captured } = fakePool(() => ({ rows: [] }));
    const store = new PostgresCredentialStore(pool, { masterKey: null });

    await expect(store.put('sub-1', 'whatsapp', SECRET_SESSION)).rejects.toThrow(
      /CREDENTIAL_STORE_MASTER_KEY/
    );
    expect(captured.length).toBe(0);
  });

  test('get() of an envelope without a master key throws', async () => {
    const envelope = encryptCredentialPayload(SECRET_SESSION, masterKey);
    const { pool } = fakePool(() => ({
      rows: [{ session_key: 'sub-1', channel: 'whatsapp', payload: envelope, updated_at: new Date() }],
    }));
    const store = new PostgresCredentialStore(pool, { masterKey: null });

    await expect(store.get('sub-1', 'whatsapp')).rejects.toThrow(/CREDENTIAL_STORE_MASTER_KEY/);
  });

  test('get() of a plaintext row is refused, never served', async () => {
    const { pool } = fakePool(() => ({
      rows: [
        {
          session_key: 'sub-1',
          channel: 'whatsapp',
          payload: SECRET_SESSION,
          updated_at: new Date(),
        },
      ],
    }));
    const store = new PostgresCredentialStore(pool, { masterKey });

    await expect(store.get('sub-1', 'whatsapp')).rejects.toThrow(/refusing plaintext/);
  });

  test('delete() removes the row (loggedOut lifecycle)', async () => {
    const { pool, captured } = fakePool(() => ({ rows: [] }));
    const store = new PostgresCredentialStore(pool, { masterKey });

    await store.delete('sub-1', 'whatsapp');
    const del = captured.find(q => q.sql.includes('DELETE FROM user_channel_credentials'));
    expect(del).toBeDefined();
    expect(del!.params).toEqual(['sub-1', 'whatsapp']);
  });
});
