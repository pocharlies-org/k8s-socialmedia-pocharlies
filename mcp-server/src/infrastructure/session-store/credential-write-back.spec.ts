/**
 * SC-1224 (architect ruling on PR #67): regression specs for the write-back
 * choreography extracted to shared/session-store/credential-write-back.ts —
 * the debounce, the in-flight guard, the trailing run, flush determinism and
 * cancel(). Both connectors' own suites (tsx --test) keep exercising their
 * one-line wrappers on top of this; the choreography itself is tested here,
 * once, against a fake store.
 */
import {
  CredentialChannel,
  CredentialStore,
  StoredCredential,
  createCredentialWriteBack,
} from '@mcp-socialmedia/shared';

interface PutCall {
  sessionKey: string;
  channel: CredentialChannel;
  payload: Record<string, unknown>;
}

class FakeStore implements CredentialStore {
  puts: PutCall[] = [];
  /** Set to a promise to make put() block until it resolves (in-flight test). */
  gate: Promise<void> | null = null;
  failPut = false;

  async get(): Promise<StoredCredential | null> {
    return null;
  }

  async put(
    sessionKey: string,
    channel: CredentialChannel,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (this.gate) await this.gate;
    if (this.failPut) throw new Error('db down');
    this.puts.push({ sessionKey, channel, payload });
  }

  async delete(): Promise<void> {}
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('SC-1224 credential write-back choreography (shared)', () => {
  test('debounce coalesces a burst into one put carrying the latest payload', async () => {
    const store = new FakeStore();
    let current = 'v1';
    const wb = createCredentialWriteBack({
      store,
      sessionKey: 'sub-1',
      channel: 'telegram',
      getPayload: async () => ({ sessionString: current }),
      logError: () => {},
      debounceMs: 10,
    });

    wb.schedule();
    current = 'v2';
    wb.schedule();
    current = 'v3';
    wb.schedule();
    expect(store.puts).toHaveLength(0); // still debouncing

    await sleep(40);
    expect(store.puts).toHaveLength(1);
    expect(store.puts[0]).toEqual({
      sessionKey: 'sub-1',
      channel: 'telegram',
      payload: { sessionString: 'v3' },
    });
  });

  test('a put scheduled mid-flight runs a trailing put (last persist lands)', async () => {
    const store = new FakeStore();
    let release!: () => void;
    let current = 'S1';
    const wb = createCredentialWriteBack({
      store,
      sessionKey: 'sub-1',
      channel: 'telegram',
      getPayload: async () => ({ sessionString: current }),
      logError: () => {},
      debounceMs: 0,
    });

    store.gate = new Promise<void>(r => (release = r));
    wb.schedule();
    await sleep(5); // timer fired, run() is inside the gated put
    current = 'S2';
    wb.schedule(); // requested while the first put is in flight → pending
    release();
    await wb.flush(); // one await covers the chained trailing run

    expect(store.puts.map(p => p.payload.sessionString)).toEqual(['S1', 'S2']);
  });

  test('flush lands a scheduled-but-not-yet-fired write without waiting for the debounce', async () => {
    const store = new FakeStore();
    const wb = createCredentialWriteBack({
      store,
      sessionKey: 'sub-1',
      channel: 'whatsapp',
      getPayload: async () => ({ files: { 'creds.json': 'eA==' } }),
      logError: () => {},
      debounceMs: 10_000,
    });

    wb.schedule();
    await wb.flush();
    expect(store.puts).toHaveLength(1);
    expect(store.puts[0].channel).toBe('whatsapp');

    await sleep(20); // the cleared timer must NOT fire a second put
    expect(store.puts).toHaveLength(1);
  });

  test('flush with nothing scheduled or in flight writes nothing', async () => {
    const store = new FakeStore();
    const wb = createCredentialWriteBack({
      store,
      sessionKey: 'sub-1',
      channel: 'telegram',
      getPayload: async () => ({ sessionString: 'S1' }),
      logError: () => {},
      debounceMs: 5,
    });

    await wb.flush();
    expect(store.puts).toHaveLength(0);
  });

  test('cancel drops a scheduled write (logout must not re-put a dead session)', async () => {
    const store = new FakeStore();
    const wb = createCredentialWriteBack({
      store,
      sessionKey: 'sub-1',
      channel: 'telegram',
      getPayload: async () => ({ sessionString: 'DEAD' }),
      logError: () => {},
      debounceMs: 5,
    });

    wb.schedule();
    wb.cancel();
    await sleep(30);
    expect(store.puts).toHaveLength(0);

    await wb.flush(); // flush after cancel must not resurrect the write either
    expect(store.puts).toHaveLength(0);
  });

  test('a getPayload or store failure logs loudly and never throws into the hook', async () => {
    const errors: string[] = [];
    const store = new FakeStore();
    store.failPut = true;
    const wb = createCredentialWriteBack({
      store,
      sessionKey: 'sub-1',
      channel: 'telegram',
      getPayload: async () => ({ sessionString: 'S1' }),
      logError: m => errors.push(m),
      debounceMs: 0,
    });

    wb.schedule();
    await expect(wb.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/write-back FAILED.*db down/);

    const throwing = createCredentialWriteBack({
      store,
      sessionKey: 'sub-1',
      channel: 'telegram',
      getPayload: async () => {
        throw new Error('export exploded');
      },
      logError: m => errors.push(m),
      debounceMs: 0,
    });
    throwing.schedule();
    await expect(throwing.flush()).resolves.toBeUndefined();
    expect(errors[1]).toMatch(/write-back FAILED.*export exploded/);
  });
});
