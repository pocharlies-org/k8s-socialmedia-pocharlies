import {
  CredentialChannel,
  CredentialStore,
  StoredCredential,
} from '@mcp-socialmedia/shared';
import { resolveCredential } from '@mcp-socialmedia/shared';

class FakeStore implements CredentialStore {
  rows = new Map<string, StoredCredential>();
  getCalls = 0;
  putCalls = 0;

  async get(sessionKey: string, channel: CredentialChannel): Promise<StoredCredential | null> {
    this.getCalls += 1;
    return this.rows.get(`${sessionKey}/${channel}`) ?? null;
  }

  async put(
    sessionKey: string,
    channel: CredentialChannel,
    payload: Record<string, unknown>
  ): Promise<void> {
    this.putCalls += 1;
    this.rows.set(`${sessionKey}/${channel}`, {
      sessionKey,
      channel,
      payload,
      updatedAt: new Date(),
    });
  }

  async delete(sessionKey: string, channel: CredentialChannel): Promise<void> {
    this.rows.delete(`${sessionKey}/${channel}`);
  }
}

describe('SC-552 credential resolution (no-regression precedence)', () => {
  test('flag OFF: legacy path even with a header, store never touched', async () => {
    const store = new FakeStore();
    const loadLegacy = jest.fn(async () => ({ sessionString: 'legacy' }));

    const result = await resolveCredential({
      store,
      actor: { sub: 'sub-1' },
      channel: 'telegram',
      loadLegacy,
      enabled: false,
    });

    expect(result).toEqual({ payload: { sessionString: 'legacy' }, source: 'legacy', adopted: false });
    expect(loadLegacy).toHaveBeenCalledTimes(1);
    expect(store.getCalls).toBe(0);
    expect(store.putCalls).toBe(0);
    expect(store.rows.size).toBe(0);
  });

  test('flag defaults to OFF when CREDENTIAL_STORE_ENABLED is unset', async () => {
    delete process.env.CREDENTIAL_STORE_ENABLED;
    const store = new FakeStore();
    const result = await resolveCredential({
      store,
      actor: { sub: 'sub-1' },
      channel: 'whatsapp',
      loadLegacy: async () => ({ files: {} }),
    });
    expect(result.source).toBe('legacy');
    expect(store.getCalls).toBe(0);
    expect(store.putCalls).toBe(0);
  });

  test('header without row → legacy served, nothing written (no sub → exact legacy path)', async () => {
    // "sin cabecera" = empty actor (getRequestActor() outside any request).
    const store = new FakeStore();
    const loadLegacy = jest.fn(async () => ({ files: { 'creds.json': 'e30=' } }));

    const result = await resolveCredential({
      store,
      actor: {},
      channel: 'whatsapp',
      loadLegacy,
      enabled: true,
    });

    expect(result).toEqual({ payload: { files: { 'creds.json': 'e30=' } }, source: 'legacy', adopted: false });
    expect(store.getCalls).toBe(0);
    expect(store.putCalls).toBe(0);
    expect(store.rows.size).toBe(0);
  });

  test('header + no row → adopt-on-first-use: row created from legacy, legacy served', async () => {
    const store = new FakeStore();
    const legacy = { files: { 'creds.json': 'e30=' } };
    const loadLegacy = jest.fn(async () => legacy);

    const result = await resolveCredential({
      store,
      actor: { sub: 'sub-ana' },
      channel: 'whatsapp',
      loadLegacy,
      enabled: true,
    });

    expect(result).toEqual({ payload: legacy, source: 'legacy', adopted: true });
    expect(loadLegacy).toHaveBeenCalledTimes(1);
    expect(store.rows.get('sub-ana/whatsapp')?.payload).toEqual(legacy);
  });

  test('header + row → the row wins, legacy never read', async () => {
    const store = new FakeStore();
    store.rows.set('sub-ana/whatsapp', {
      sessionKey: 'sub-ana',
      channel: 'whatsapp',
      payload: { files: { 'creds.json': 'cm93' } },
      updatedAt: new Date(),
    });
    const loadLegacy = jest.fn(async () => ({ files: { 'creds.json': 'bGVnYWN5' } }));

    const result = await resolveCredential({
      store,
      actor: { sub: 'sub-ana' },
      channel: 'whatsapp',
      loadLegacy,
      enabled: true,
    });

    expect(result).toEqual({ payload: { files: { 'creds.json': 'cm93' } }, source: 'store', adopted: false });
    expect(loadLegacy).not.toHaveBeenCalled();
    expect(store.putCalls).toBe(0);
  });

  test('header + no row + no legacy → null payload, nothing adopted', async () => {
    const store = new FakeStore();
    const result = await resolveCredential({
      store,
      actor: { sub: 'sub-new' },
      channel: 'instagram',
      loadLegacy: async () => null,
      enabled: true,
    });
    expect(result).toEqual({ payload: null, source: 'legacy', adopted: false });
    expect(store.rows.size).toBe(0);
  });
});
