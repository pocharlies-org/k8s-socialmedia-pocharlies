/**
 * SC-1500: an unknown/invalid peer must not abort the whole fetch cycle.
 *
 * The conversation autopilot starved (CRIT-7625) because one peer Telegram
 * rejects (PEER_ID_INVALID) or that is missing from mtcute's input cache
 * ("Peer <id> is not found in local cache") took the ENTIRE dialog enumeration
 * down with it: telegram-sync's backfill cycle then imported zero chats.
 *
 * What must be true: getDialogs skips + logs the bad dialog and still returns
 * the rest; getMessages reindexes the input cache (client.getPeer resolves it
 * from the API) and retries instead of failing the chat permanently.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramClientWrapper } from './telegram-client';

const cacheMiss = (id: number) => new Error(`Peer ${id} is not found in local cache`);

type FakeWrapper = TelegramClientWrapper & { warnings: string[] };

function wrapperWithDialogs(iterDialogs: () => AsyncGenerator<unknown>): FakeWrapper {
  const warnings: string[] = [];
  const client: Record<string, unknown> = { iterDialogs };
  return Object.assign(Object.create(TelegramClientWrapper.prototype), {
    client,
    connected: true,
    logger: { warn: (m: string) => warnings.push(m), error: (m: string) => warnings.push(m) },
    warnings,
  }) as FakeWrapper;
}

function goodDialog(id: number, name: string) {
  return {
    peer: { id: { toString: () => String(id) }, type: 'user', firstName: name },
    unreadCount: 0,
  };
}

test('getDialogs skips a dialog whose peer is missing from the local cache and returns the rest', async () => {
  async function* iterDialogs() {
    yield goodDialog(1, 'Ana');
    yield {
      get peer() {
        throw cacheMiss(267072779);
      },
      unreadCount: 0,
    };
    yield goodDialog(2, 'Luis');
  }
  const wrapper = wrapperWithDialogs(iterDialogs);
  const dialogs = await wrapper.getDialogs();
  assert.deepEqual(
    dialogs.map(d => d.id),
    ['1', '2']
  );
  assert.ok(
    wrapper.warnings.some(w => w.includes('267072779')),
    'the skipped peer must be logged'
  );
});

test('getDialogs returns the dialogs read so far when Telegram rejects a peer mid-enumeration (PEER_ID_INVALID)', async () => {
  async function* iterDialogs() {
    yield goodDialog(1, 'Ana');
    throw new Error('Telegram API error 400: PEER_ID_INVALID');
  }
  const wrapper = wrapperWithDialogs(iterDialogs);
  const dialogs = await wrapper.getDialogs();
  assert.deepEqual(
    dialogs.map(d => d.id),
    ['1']
  );
  assert.ok(wrapper.warnings.length > 0, 'the early stop must be logged');
});

test('getMessages reindexes the input cache (getPeer) and retries when the peer is not in the local cache', async () => {
  const resolved: unknown[] = [];
  let attempts = 0;
  const client: Record<string, unknown> = {
    getPeer: async (peer: unknown) => {
      resolved.push(peer);
      return { type: 'user', id: 1817033353 };
    },
    iterHistory: async function* () {
      attempts += 1;
      if (attempts === 1) throw cacheMiss(1817033353);
      yield { id: 42 };
    },
  };
  Object.assign(client, { withParams: () => client });
  const wrapper = Object.assign(Object.create(TelegramClientWrapper.prototype), {
    client,
    connected: true,
    logger: { warn: () => {}, error: () => {} },
    parseMessage: async (m: { id: number }) => ({ telegramMessageId: String(m.id) }),
  }) as TelegramClientWrapper;

  const out = await wrapper.getMessages('1817033353', 10);
  assert.deepEqual(
    out.map(m => m.telegramMessageId),
    ['42']
  );
  assert.equal(resolved.length, 1, 'the peer must be resolved once via the API');
});

test('getMessages still propagates a peer Telegram truly rejects (PEER_ID_INVALID) — the caller skips that chat', async () => {
  const client: Record<string, unknown> = {
    getPeer: async () => {
      throw new Error('Telegram API error 400: PEER_ID_INVALID');
    },
    iterHistory: async function* () {
      throw new Error('Telegram API error 400: PEER_ID_INVALID');
    },
  };
  Object.assign(client, { withParams: () => client });
  const wrapper = Object.assign(Object.create(TelegramClientWrapper.prototype), {
    client,
    connected: true,
    logger: { warn: () => {}, error: () => {} },
  }) as TelegramClientWrapper;

  await assert.rejects(() => wrapper.getMessages('5820052734', 10), /PEER_ID_INVALID/);
});
