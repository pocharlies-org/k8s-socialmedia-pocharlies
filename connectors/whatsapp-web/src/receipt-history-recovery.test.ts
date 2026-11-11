import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import { ReceiptHistoryRecovery, type ReceiptRecoveryTarget } from './receipt-history-recovery';
import { BaileysClient } from './baileys-client';
import { receiptRecoveryAnchor } from './message-receipts';

const target: ReceiptRecoveryTarget = {
  account: 'professional',
  chatId: '1@g.us',
  messageId: 'M1',
  aliases: ['1@g.us'],
};
const anchor = {
  key: { id: 'NEXT', remoteJid: '1@g.us', fromMe: false },
  timestampMs: 1_790_000_001_000,
};
const message = (chatId = '1@g.us', id = 'M1', fromMe = true, receipts = true): WAMessage => ({
  key: { remoteJid: chatId, id, fromMe },
  message: { conversation: 'unchanged' },
  userReceipt: receipts ? [{ userJid: '123@s.whatsapp.net', readTimestamp: 1_790_000_000 }] : [],
});
const update = (session = 'SESSION', messages = [message()]) => ({
  syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
  peerDataRequestSessionId: session,
  messages,
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('one bounded request coalesces polls, correlates session/chat/message/fromMe, and completes even without receipts', async () => {
  const requests: any[] = [];
  const captured: any[] = [];
  const recovery = new ReceiptHistoryRecovery({
    anchor: async () => anchor,
    fetch: async (...args) => {
      requests.push(args);
      return 'SESSION';
    },
    persist: async (...args) => {
      captured.push(args);
    },
  });
  try {
    assert.deepEqual(recovery.request(target), { state: 'pending', retryAfterMs: 5000 });
    for (let n = 0; n < 3; n++) recovery.request(target);
    await tick();
    assert.deepEqual(requests, [[10, anchor.key, anchor.timestampMs]]);
    assert.equal(await recovery.consume(update('OTHER')), false);
    assert.equal(
      await recovery.consume(
        update('SESSION', [
          message('2@g.us'),
          message('1@g.us', 'OTHER'),
          message('1@g.us', 'M1', false),
        ])
      ),
      true
    );
    assert.equal(captured.length, 0);
    assert.equal(recovery.current(target)?.state, 'pending');
    assert.equal(
      await recovery.consume(update('SESSION', [message('1@g.us', 'M1', true, false)])),
      true
    );
    assert.equal(captured.length, 1);
    assert.equal(recovery.current(target)?.state, 'complete');
    assert.deepEqual(recovery.request(target), { state: 'complete' });
    assert.equal(requests.length, 1);
    const foreign = { ...target, account: 'personal' };
    recovery.request(foreign);
    await tick();
    assert.equal(requests.length, 2);
  } finally {
    recovery.stop();
  }
});
test('no successor is unsupported; errors fail; timeout is bounded and matching late evidence survives cooldown', async () => {
  let requests = 0;
  let captured = 0;
  const unsupported = new ReceiptHistoryRecovery({
    anchor: async () => null,
    fetch: async () => {
      requests++;
      return 'S';
    },
    persist: async () => {},
  });
  unsupported.request(target);
  await tick();
  assert.equal(unsupported.current(target)?.state, 'unsupported');
  assert.equal(requests, 0);
  const failed = new ReceiptHistoryRecovery({
    anchor: async () => anchor,
    fetch: async () => {
      throw new Error('phone offline');
    },
    persist: async () => {},
  });
  failed.request(target);
  await tick();
  assert.equal(failed.current(target)?.state, 'failed');
  failed.request(target);
  assert.equal(failed.current(target)?.state, 'failed');
  const slow = new ReceiptHistoryRecovery({
    anchor: async () => anchor,
    fetch: async () => {
      requests++;
      return 'SESSION';
    },
    persist: async () => {
      captured++;
    },
    timeoutMs: 10,
    cooldownMs: 100,
  });
  try {
    slow.request(target);
    await new Promise(r => setTimeout(r, 15));
    assert.equal(slow.current(target)?.state, 'timeout');
    slow.request(target);
    assert.equal(requests, 1);
    await slow.consume(update());
    assert.equal(captured, 1);
    assert.equal(slow.current(target)?.state, 'complete');
  } finally {
    unsupported.stop();
    failed.stop();
    slow.stop();
  }
});
test('history response arriving before fetch resolves is persisted only after matching returned session', async () => {
  let resolve!: (id: string) => void;
  let captured = 0;
  const recovery = new ReceiptHistoryRecovery({
    anchor: async () => anchor,
    fetch: () => new Promise<string>(r => (resolve = r)),
    persist: async () => {
      captured++;
    },
  });
  try {
    recovery.request(target);
    await tick();
    const early = recovery.consume(update());
    const foreign = recovery.consume(update('FOREIGN'));
    assert.equal(captured, 0);
    resolve('SESSION');
    assert.equal(await early, true);
    assert.equal(await foreign, false);
    assert.equal(captured, 1);
    assert.equal(recovery.current(target)?.state, 'complete');
  } finally {
    recovery.stop();
  }
});
test('bounded pending requests and stopped socket cannot trigger delayed network work', async () => {
  let release!: (value: typeof anchor) => void;
  let requests = 0;
  const recovery = new ReceiptHistoryRecovery({
    anchor: () => new Promise(r => (release = r)),
    fetch: async () => {
      requests++;
      return 'SESSION';
    },
    persist: async () => {},
    maxPending: 1,
  });
  recovery.request(target);
  assert.equal(recovery.request({ ...target, messageId: 'M2' }).state, 'unsupported');
  recovery.stop();
  release(anchor);
  await tick();
  assert.equal(requests, 0);
  assert.equal(recovery.current(target)?.state, 'failed');
});
test('bounded cache preserves a recent completed message cooldown instead of evicting it', async () => {
  let requests = 0;
  const recovery = new ReceiptHistoryRecovery({
    anchor: async () => anchor,
    fetch: async () => {
      requests++;
      return 'SESSION';
    },
    persist: async () => {},
    maxEntries: 1,
  });
  try {
    recovery.request(target);
    await tick();
    await recovery.consume(update());
    assert.equal(recovery.request({ ...target, messageId: 'OTHER' }).state, 'unsupported');
    assert.equal(recovery.request(target).state, 'complete');
    assert.equal(requests, 1);
  } finally {
    recovery.stop();
  }
});
test('four unresolved provider requests time out and release capacity at the hard cooldown deadline', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let requests = 0;
  const recovery = new ReceiptHistoryRecovery({
    anchor: async () => anchor,
    fetch: () => {
      requests++;
      return new Promise(() => {});
    },
    persist: async () => {},
    maxPending: 4,
    maxEntries: 4,
  });
  try {
    for (let n = 0; n < 4; n++) recovery.request({ ...target, messageId: `M${n}` });
    await tick();
    context.mock.timers.tick(15_000);
    assert.equal(requests, 4);
    assert.equal(recovery.current(target)?.state, 'timeout');
    assert.equal(recovery.request({ ...target, messageId: 'NEW' }).state, 'unsupported');
    context.mock.timers.tick(45_000);
    await tick();
    assert.equal(recovery.request({ ...target, messageId: 'NEW' }).state, 'pending');
    await tick();
    assert.equal(requests, 5);
  } finally {
    recovery.stop();
  }
});
test('early own chunks without target stay isolated; a target arriving before delayed request ID survives timeout', async () => {
  let resolve!: (id: string) => void;
  let captured = 0;
  const recovery = new ReceiptHistoryRecovery({
    anchor: async () => anchor,
    fetch: () => new Promise<string>(r => (resolve = r)),
    persist: async () => {
      captured++;
    },
    timeoutMs: 5,
    cooldownMs: 100,
  });
  try {
    recovery.request(target);
    await tick();
    const empty = recovery.consume(update('SESSION', [message('2@g.us')]));
    await new Promise(r => setTimeout(r, 10));
    assert.equal(recovery.current(target)?.state, 'timeout');
    const late = recovery.consume(update());
    const foreign = recovery.consume(update('FOREIGN'));
    resolve('SESSION');
    assert.equal(await empty, true);
    assert.equal(await late, true);
    assert.equal(await foreign, false);
    assert.equal(captured, 1);
    assert.equal(recovery.current(target)?.state, 'complete');
  } finally {
    recovery.stop();
  }
});
test('real successor anchor query scopes both rows to account/chat and rejects a mismatched returned provider JID', async () => {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const original = pg.Pool.prototype.query;
  const calls: any[] = [];
  let row: any = {
    wa_message_id: 'professional:NEXT',
    remote_jid: '1@g.us',
    from_me: false,
    message_timestamp_ms: String(anchor.timestampMs),
  };
  (pg.Pool.prototype as any).query = async (sql: string, params: any[]) => {
    calls.push({ sql, params });
    return { rows: [row] };
  };
  try {
    const result = await receiptRecoveryAnchor(target);
    assert.equal(result?.key.id, 'NEXT');
    assert.equal(result?.timestampMs, anchor.timestampMs);
    assert.deepEqual(calls[0].params, ['professional', ['professional:1@g.us'], 'professional:M1']);
    assert.match(calls[0].sql, /original_message.account=\$1/);
    assert.match(calls[0].sql, /k.message_timestamp_ms>original.message_timestamp_ms/);
    row = { ...row, remote_jid: '2@g.us' };
    assert.equal(await receiptRecoveryAnchor(target), null);
  } finally {
    pg.Pool.prototype.query = original;
  }
});
test('real history socket handler claims receipt recovery before closed generic gate or enabled full history; offline read makes no request', async () => {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const original = pg.Pool.prototype.query;
  (pg.Pool.prototype as any).query = async (sql: string) => ({
    rows: sql.includes('SELECT status,direction')
      ? [{ status: 'sent', direction: 'OUTBOUND' }]
      : [],
  });
  const client: any = new BaileysClient('/tmp/unused', 'key');
  const handlers: Record<string, (update: any) => Promise<void>> = {};
  let requests = 0;
  client.ready = true;
  client.sock = {
    ev: {
      on: (event: string, fn: any) => {
        handlers[event] = fn;
      },
    },
    fetchMessageHistory: async () => {
      requests++;
      return 'SESSION';
    },
  };
  const captured: any[] = [];
  client.receiptHistoryRecovery = new ReceiptHistoryRecovery({
    anchor: async () => anchor,
    fetch: (...args) => client.sock.fetchMessageHistory(...args),
    persist: async (_target, msg) => {
      captured.push(msg.userReceipt);
    },
  });
  client.ingestMessage = async () => {
    throw new Error('Generic message ingest must not run');
  };
  client.applyHistoryContacts = async () => {
    throw new Error('Contact mutation must not run');
  };
  client.bindSocketEvents(async () => {});
  try {
    const response = await client.getMessageInfo('1@g.us', 'M1');
    assert.equal(response.recovery.state, 'pending');
    await tick();
    assert.equal(requests, 1);
    await handlers['messaging-history.set']({ ...update(), chats: [], contacts: [] });
    assert.equal(captured.length, 1);
    assert.equal(client.historyBackfillRequestedUntil, 0);
    client.historySyncOnLogin = true;
    await handlers['messaging-history.set']({
      ...update('SESSION', [message(), message('2@g.us')]),
      chats: [{ id: '2@g.us', name: 'foreign' }],
      contacts: [{ id: 'foreign' }],
    });
    assert.equal(client.chatStore.size, 0);
    client.ready = false;
    const offline = await client.getMessageInfo('1@g.us', 'M2');
    assert.equal(offline.recovery.state, 'unsupported');
    assert.equal(offline.status, 'sent');
    assert.equal(requests, 1);
    assert.equal(
      (await client.getMessageInfo('1@g.us', 'M2', { refresh: true })).recovery.state,
      'unsupported'
    );
  } finally {
    client.receiptHistoryRecovery.stop();
    pg.Pool.prototype.query = original;
  }
});
test('recovery completing after the initial info read returns fresh receipts with complete', async () => {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  const original = pg.Pool.prototype.query;
  let receiptRows: any[] = [];
  let reads = 0;
  (pg.Pool.prototype as any).query = async (sql: string) => {
    if (sql.includes('SELECT status,direction'))
      return { rows: [{ status: 'sent', direction: 'OUTBOUND' }] };
    if (sql.includes('SELECT * FROM whatsapp_message_receipts')) {
      reads++;
      return { rows: receiptRows };
    }
    return { rows: [] };
  };
  const client: any = new BaileysClient('/tmp/unused', 'key');
  client.ready = true;
  client.sock = {};
  client.receiptHistoryRecovery = {
    current: () => {
      receiptRows = [
        {
          participant_id: '123@s.whatsapp.net',
          aliases: ['123@s.whatsapp.net'],
          name: 'Ada',
          delivered_at: null,
          read_at: new Date(1790000000000),
          played_at: null,
          observed_at: new Date(1790000000000),
        },
      ];
      return { state: 'complete' };
    },
    request: () => ({ state: 'complete' }),
  };
  try {
    const response = await client.getMessageInfo('1@g.us', 'M1', { refresh: true });
    assert.equal(response.recovery.state, 'complete');
    assert.equal(reads, 2);
    assert.equal(response.receipts.length, 1);
    assert.equal(response.receipts[0].readAt, '2026-09-21T14:13:20.000Z');
  } finally {
    pg.Pool.prototype.query = original;
  }
});
