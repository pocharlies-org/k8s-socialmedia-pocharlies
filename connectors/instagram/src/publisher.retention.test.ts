import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

/**
 * INFRA-290 (P3 of INFRA-112): bounded NATS retention in the instagram
 * publisher.
 *
 * The old behaviour threw events away while NATS was unreachable ("NATS not
 * connected, skipping event"). These tests pin the replacement: a bounded
 * retainer (entry cap + age window) that republishes FIFO on reconnect without
 * duplicating an event id, with the subject and payload left exactly as the
 * mcp-server consumer expects.
 *
 * The stub is a real TCP server speaking just enough NATS for the official
 * client, so `connect()` and the drain run for real. It lives in this file on
 * purpose: the whatsapp-web package is out of INFRA-290's import reach for the
 * instagram connector.
 */

// Fast, deterministic reconnects. Read at construction time.
process.env.NATS_RECONNECT_BASE_MS = '50';
process.env.NATS_RECONNECT_MAX_MS = '200';

import { BoundedEventRetainer, InstagramEventPublisher } from './publisher';
import type { WebhookEvent } from './webhook';

const STUB_PORT = 14224;

interface StubMessage {
  subject: string;
  payload: string;
}

interface StubNats {
  messages: StubMessage[];
  listen(): Promise<void>;
  kill(): Promise<void>;
}

function makeStubNats(port: number): StubNats {
  const messages: StubMessage[] = [];
  let server: net.Server | null = null;
  const sockets = new Set<net.Socket>();

  const INFO = JSON.stringify({
    server_id: 'infra290-stub-ig',
    server_name: 'infra290-stub-ig',
    version: '2.10.0',
    proto: 1,
    host: '127.0.0.1',
    port,
    headers: false,
    max_payload: 1048576,
    ping_interval: 120000,
  });

  function attach(socket: net.Socket): void {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    socket.write(`INFO ${INFO}\r\n`);

    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd < 0) return;
        const line = buffer.subarray(0, lineEnd).toString('utf8');
        const op = line.slice(0, 3).toUpperCase();

        if (op === 'PUB') {
          const parts = line.split(' ');
          const byteLen = Number.parseInt(parts[parts.length - 1], 10);
          const needed = lineEnd + 2 + byteLen + 2;
          if (buffer.length < needed) return;
          const payload = buffer.subarray(lineEnd + 2, lineEnd + 2 + byteLen).toString('utf8');
          messages.push({ subject: parts[1], payload });
          buffer = buffer.subarray(needed);
          continue;
        }

        buffer = buffer.subarray(lineEnd + 2);
        if (op === 'CON') socket.write('+OK\r\n');
        else if (op === 'PIN') socket.write('PONG\r\n');
      }
    });
  }

  return {
    messages,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server = net.createServer(attach);
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server?.removeAllListeners('error');
          resolve();
        });
      }),
    kill: () =>
      new Promise<void>(resolve => {
        const current = server;
        server = null;
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        if (!current) return resolve();
        current.close(() => resolve());
      }),
  };
}

function dmEvent(index: number): WebhookEvent {
  return {
    type: 'dm',
    senderId: `ig-sender-${index % 10}`,
    senderUsername: 'probe',
    conversationId: `ig-sender-${index % 10}-ig-page`,
    messageId: `INFRA290-IG-${String(index).padStart(4, '0')}`,
    text: `retention probe ${index}`,
    timestamp: new Date(1_790_600_000_000 + index * 1000).toISOString(),
    raw: { probe: index },
  };
}

async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('instagram publisher: 100 events at a constant rate survive an outage with zero loss and zero duplicates', async () => {
  const stub = makeStubNats(STUB_PORT);
  const publisher = new InstagramEventPublisher(`nats://127.0.0.1:${STUB_PORT}`);
  try {
    // NATS down at connector start: the initial connect fails and the
    // publisher must retain instead of dropping ("skipping event" is gone).
    await publisher.connect();
    assert.equal(publisher.isConnected(), false, 'stub must be down at start');

    const TOTAL = 100;
    for (let i = 0; i < TOTAL; i++) {
      publisher.publish('skirmshop', dmEvent(i));
      if (i === 30) await stub.listen();
      await new Promise(resolve => setTimeout(resolve, 3));
    }

    await waitFor(
      () => stub.messages.length === TOTAL && publisher.pendingRetention() === 0,
      20_000,
      `all ${TOTAL} events delivered (got ${stub.messages.length}, pending ${publisher.pendingRetention()})`
    );

    const ids = stub.messages.map(m => JSON.parse(m.payload).messageId as string);
    assert.equal(ids.length, TOTAL, 'criterion A: nothing lost across the outage');
    assert.equal(new Set(ids).size, TOTAL, 'criterion C: no duplicated event id');
    assert.deepEqual(
      ids,
      Array.from({ length: TOTAL }, (_, i) => `INFRA290-IG-${String(i).padStart(4, '0')}`),
      'retained events are republished in FIFO order'
    );

    const stats = publisher.retentionStats();
    assert.equal(stats.accepted, TOTAL);
    assert.equal(stats.published + stats.republished, TOTAL, 'counters account for the whole run');
    assert.ok(stats.retained > 0, 'the outage window must have been retained, not skipped');
    assert.equal(stats.duplicateSkipped, 0);
    assert.equal(stats.overflowDropped, 0, 'the default cap (500) must not bite at N=100');
    assert.equal(stats.expiredDropped, 0);

    // Criterion C: subject and payload shape unchanged for the consumer.
    // (JSON.stringify drops undefined fields, exactly as before this change.)
    assert.equal(stub.messages[0].subject, 'instagram.skirmshop.dm.received');
    assert.deepEqual(JSON.parse(stub.messages[0].payload), {
      platform: 'instagram',
      account: 'skirmshop',
      eventType: 'dm',
      senderId: 'ig-sender-0',
      senderUsername: 'probe',
      conversationId: 'ig-sender-0-ig-page',
      messageId: 'INFRA290-IG-0000',
      text: 'retention probe 0',
      timestamp: dmEvent(0).timestamp,
    });
  } finally {
    await publisher.disconnect();
    await stub.kill();
  }
});

test('instagram publisher: entry cap keeps the newest events and counts the evictions', async () => {
  process.env.NATS_RETENTION_MAX_EVENTS = '10';
  const publisher = new InstagramEventPublisher(`nats://127.0.0.1:${STUB_PORT}`);
  try {
    await publisher.connect(); // down -> everything is retained
    for (let i = 0; i < 50; i++) publisher.publish('skirmshop', dmEvent(i));
    const stats = publisher.retentionStats();
    assert.equal(stats.overflowDropped, 40, 'only the cap survives the outage');
    assert.equal(publisher.pendingRetention(), 10);
    assert.equal(stats.retained, 50, 'every event was offered to the retainer');
  } finally {
    await publisher.disconnect();
    delete process.env.NATS_RETENTION_MAX_EVENTS;
  }
});

test('instagram publisher: the same messageId is never retained twice', async () => {
  const publisher = new InstagramEventPublisher(`nats://127.0.0.1:${STUB_PORT}`);
  try {
    await publisher.connect(); // down
    publisher.publish('skirmshop', dmEvent(1));
    publisher.publish('skirmshop', dmEvent(1));
    assert.equal(publisher.pendingRetention(), 1, 'dedup by event id while disconnected');
    assert.equal(publisher.retentionStats().duplicateSkipped, 1);
  } finally {
    await publisher.disconnect();
  }
});

test('retainer: age window drops stale events before republishing', () => {
  const retainer = new BoundedEventRetainer({ maxEvents: 100, windowHours: 1 });
  const now = Date.now();
  retainer.enqueue({ key: 'old', subject: 's', payload: Buffer.from('1'), enqueuedAtMs: now });
  retainer.enqueue({ key: 'new', subject: 's', payload: Buffer.from('2'), enqueuedAtMs: now });
  assert.equal(retainer.ageItem('old', 2 * 3_600_000), true);
  retainer.enqueue({ key: 'newer', subject: 's', payload: Buffer.from('3'), enqueuedAtMs: now });
  assert.equal(retainer.stats().expiredDropped, 1);
  assert.deepEqual(retainer.peek().map(item => item.key), ['new', 'newer']);
});
