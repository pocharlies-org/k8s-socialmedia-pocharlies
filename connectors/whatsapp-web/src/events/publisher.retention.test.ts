import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

/**
 * INFRA-290 (P3 of INFRA-112): bounded NATS retention in the whatsapp-web
 * publisher.
 *
 * Before this change an event that arrived while NATS was unreachable was
 * logged as "skipping message event" and thrown away. These tests pin the new
 * contract: nothing is discarded inside the declared window, everything is
 * republished in order on reconnect, and republishing never duplicates an
 * event id.
 *
 * The stub NATS server is a real TCP server speaking enough of the protocol
 * for the official nats client (INFO / +OK / PING-PONG / PUB accounting), so
 * the publisher runs its genuine connect + drain path with no mocking.
 */

// Fast, deterministic reconnects. Read by EventPublisher/BoundedEventRetainer
// at construction time, so they must be set before the first `new`.
process.env.NATS_RECONNECT_BASE_MS = '50';
process.env.NATS_RECONNECT_MAX_MS = '200';

import {
  EventPublisher,
  BoundedEventRetainer,
  RetainedEvent,
} from './publisher';
import { EventType, MessageReceivedEvent } from '@mcp-socialmedia/shared';

const STUB_PORT = 14223;

interface StubMessage {
  subject: string;
  payload: string;
}

interface StubNats {
  messages: StubMessage[];
  listen(): Promise<void>;
  kill(): Promise<void>;
  reset(): void;
}

/**
 * Minimal NATS server: answers the handshake and records every PUB it receives.
 * `kill()` stops accepting AND drops established sockets, which is what a
 * deleted NATS pod looks like from the client side.
 */
function makeStubNats(port: number): StubNats {
  const messages: StubMessage[] = [];
  let server: net.Server | null = null;
  const sockets = new Set<net.Socket>();

  const INFO = JSON.stringify({
    server_id: 'infra290-stub',
    server_name: 'infra290-stub',
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
          // PUB <subject> [reply] <#bytes>
          const parts = line.split(' ');
          const byteLen = Number.parseInt(parts[parts.length - 1], 10);
          const needed = lineEnd + 2 + byteLen + 2;
          if (buffer.length < needed) return; // payload still arriving
          const payload = buffer.subarray(lineEnd + 2, lineEnd + 2 + byteLen).toString('utf8');
          messages.push({ subject: parts[1], payload });
          buffer = buffer.subarray(needed);
          continue;
        }

        buffer = buffer.subarray(lineEnd + 2);
        if (op === 'CON') {
          socket.write('+OK\r\n');
        } else if (op === 'PIN') {
          // NATS echoes any PING payload back on PONG; flush() waits for it.
          const payload = line.slice(4).trim();
          socket.write(payload ? `PONG ${payload}\r\n` : 'PONG\r\n');
        }
        // SUB / UNSUB / DISCONNECT need no reply for these tests.
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
    reset: () => {
      messages.length = 0;
    },
  };
}

function messageEvent(index: number): MessageReceivedEvent {
  return {
    eventType: EventType.MESSAGE_RECEIVED,
    conversationId: `3460000000${index % 10}@s.whatsapp.net`,
    waMessageId: `INFRA290-${String(index).padStart(4, '0')}`,
    waTimestamp: new Date(1_790_600_000_000 + index * 1000).toISOString(),
    senderWaId: '34600000000@s.whatsapp.net',
    content: `retention probe ${index}`,
    messageType: 'text',
    isForwarded: false,
    account: 'personal',
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

test('retainer: entry cap evicts the oldest events (FIFO)', () => {
  const retainer = new BoundedEventRetainer({ maxEvents: 3, windowHours: 6 });
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    const item: RetainedEvent = {
      key: `k${i}`,
      subject: 'whatsapp.MessageReceived',
      payload: Buffer.from(`p${i}`),
      enqueuedAtMs: now + i,
    };
    retainer.enqueue(item);
  }
  const stats = retainer.stats();
  assert.equal(stats.retained, 6, 'every enqueue is accounted');
  assert.equal(stats.overflowDropped, 3, 'the three oldest are evicted');
  assert.deepEqual(
    retainer.peek().map(item => item.key),
    ['k3', 'k4', 'k5'],
    'the newest survive, oldest first'
  );
});

test('retainer: items older than the declared window expire', () => {
  const retainer = new BoundedEventRetainer({ maxEvents: 100, windowHours: 1 });
  const now = Date.now();
  retainer.enqueue({ key: 'old', subject: 's', payload: Buffer.from('1'), enqueuedAtMs: now });
  retainer.enqueue({ key: 'new', subject: 's', payload: Buffer.from('2'), enqueuedAtMs: now });
  // Age the first entry past the window, then enqueue again: expiry is swept
  // on enqueue and on drain, exactly like a TTL queue.
  assert.equal(retainer.ageItem('old', 2 * 3_600_000), true);
  retainer.enqueue({ key: 'newer', subject: 's', payload: Buffer.from('3'), enqueuedAtMs: now });

  const stats = retainer.stats();
  assert.equal(stats.expiredDropped, 1, 'the stale entry was dropped for age');
  assert.deepEqual(retainer.peek().map(item => item.key), ['new', 'newer']);
});

test('retainer: the same event id is never queued twice', () => {
  const retainer = new BoundedEventRetainer({ maxEvents: 10, windowHours: 6 });
  const now = Date.now();
  const item: RetainedEvent = {
    key: 'wa:SAME',
    subject: 'whatsapp.MessageReceived',
    payload: Buffer.from('x'),
    enqueuedAtMs: now,
  };
  assert.equal(retainer.enqueue(item), true);
  assert.equal(retainer.enqueue(item), false, 'duplicate must not be held');
  assert.equal(retainer.pendingSize(), 1);
  assert.equal(retainer.stats().duplicateSkipped, 1);
});

test('retainer: a failed drain requeues without duplicating ids', () => {
  const retainer = new BoundedEventRetainer({ maxEvents: 10, windowHours: 6 });
  const now = Date.now();
  for (const key of ['a', 'b', 'c']) {
    retainer.enqueue({ key, subject: 's', payload: Buffer.from(key), enqueuedAtMs: now });
  }
  const batch = retainer.drain();
  assert.equal(batch.length, 3);
  // Only 'a' went out before the connection died: hand the rest back.
  retainer.requeueFront(batch.slice(1));
  assert.deepEqual(retainer.peek().map(item => item.key), ['b', 'c']);
  retainer.requeueFront(batch.slice(1));
  assert.equal(retainer.pendingSize(), 2, 'requeue must not duplicate');
});

test('publisher: 100 events at a constant rate survive a NATS outage with zero loss and zero duplicates', async () => {
  const stub = makeStubNats(STUB_PORT);
  const publisher = new EventPublisher(`nats://127.0.0.1:${STUB_PORT}`);
  try {
    // NATS is down when the connector starts: the initial connect fails and
    // the publisher enters the retained state (this is the prod window that
    // used to log "skipping message event" and drop the event).
    await publisher.connect();
    assert.equal(publisher.isConnected(), false, 'stub must be down at start');

    const TOTAL = 100;
    for (let i = 0; i < TOTAL; i++) {
      publisher.publishMessageReceived(messageEvent(i));
      // Constant rate; the server comes back mid-stream, like a restarted pod.
      if (i === 30) await stub.listen();
      await new Promise(resolve => setTimeout(resolve, 3));
    }

    // SKIRM-114: the stub sees the PUBs, and the retainer's queue empties, before
    // the publisher's flush is confirmed and `republished` is counted. Wait for
    // the counters the assertions below read, not for the stub's side of it.
    await waitFor(
      () =>
        stub.messages.length === TOTAL &&
        publisher.pendingRetention() === 0 &&
        publisher.retentionStats().published + publisher.retentionStats().republished === TOTAL,
      20_000,
      `all ${TOTAL} events republished (got ${stub.messages.length}, pending ${publisher.pendingRetention()})`
    );

    const ids = stub.messages.map(m => (JSON.parse(m.payload) as MessageReceivedEvent).waMessageId);
    assert.equal(ids.length, TOTAL, 'criterion A: nothing lost across the outage');
    assert.equal(new Set(ids).size, TOTAL, 'criterion C: no duplicated event id');
    assert.deepEqual(
      ids,
      Array.from({ length: TOTAL }, (_, i) => `INFRA290-${String(i).padStart(4, '0')}`),
      'retained events are republished in FIFO order'
    );

    const stats = publisher.retentionStats();
    assert.equal(stats.accepted, TOTAL);
    assert.ok(stats.retained > 0, 'the outage window must have been retained, not skipped');
    assert.equal(
      stats.published + stats.republished,
      TOTAL,
      'published + republished must account for the whole run'
    );
    assert.equal(stats.duplicateSkipped, 0);
    assert.equal(stats.overflowDropped, 0, 'the default cap (500) must not bite at N=100');
    assert.equal(stats.expiredDropped, 0, 'the default window (6h) must not bite');
  } finally {
    await publisher.disconnect();
    await stub.kill();
  }
});

test('publisher: events published while connected go straight out and are not retained', async () => {
  const stub = makeStubNats(STUB_PORT);
  const publisher = new EventPublisher(`nats://127.0.0.1:${STUB_PORT}`);
  try {
    await stub.listen();
    await publisher.connect();
    await waitFor(() => publisher.isConnected(), 5_000, 'publisher to connect');

    publisher.publishMessageReceived(messageEvent(1));
    publisher.publishMessageReceived(messageEvent(2));

    await waitFor(() => stub.messages.length === 2, 5_000, 'two live publishes');
    const stats = publisher.retentionStats();
    assert.equal(stats.published, 2);
    assert.equal(stats.republished, 0);
    assert.equal(stats.retained, 0);
    assert.equal(publisher.pendingRetention(), 0);
  } finally {
    await publisher.disconnect();
    await stub.kill();
  }
}
);

test('publisher: subject and payload format are untouched by the retention path', async () => {
  const stub = makeStubNats(STUB_PORT);
  const publisher = new EventPublisher(`nats://127.0.0.1:${STUB_PORT}`);
  try {
    await publisher.connect(); // down -> retained
    const event = messageEvent(7);
    publisher.publishMessageReceived(event);
    await stub.listen();
    await waitFor(() => stub.messages.length === 1, 10_000, 'the retained event');

    const received = stub.messages[0];
    assert.equal(received.subject, 'whatsapp.MessageReceived', 'criterion C: subject unchanged');
    assert.deepEqual(
      JSON.parse(received.payload),
      { ...event, account: event.account ?? 'personal' },
      'criterion C: payload unchanged (same fields, same account tagging)'
    );
  } finally {
    await publisher.disconnect();
    await stub.kill();
  }
});

test('publisher: a warm connection that is killed retains and republishes (status watcher)', async () => {
  // This is the case a live pod deletion produces: the client is already
  // connected when the transport dies. Without the Events.Disconnect watcher
  // the client just buffers outbound writes, `connected` stays true and the
  // retainer never engages (observed in the first live run, 2026-09-28).
  const stub = makeStubNats(STUB_PORT);
  const publisher = new EventPublisher(`nats://127.0.0.1:${STUB_PORT}`);
  try {
    await stub.listen();
    await publisher.connect();
    await waitFor(() => publisher.isConnected(), 5_000, 'initial connection');

    publisher.publishMessageReceived(messageEvent(0));
    await waitFor(() => stub.messages.length === 1, 5_000, 'the first live publish');

    // NATS dies with the connection open.
    await stub.kill();
    await waitFor(() => !publisher.isConnected(), 10_000, 'the disconnect to be observed');

    const TOTAL = 40;
    for (let i = 1; i <= TOTAL; i++) {
      publisher.publishMessageReceived(messageEvent(i));
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    const pending = publisher.pendingRetention();
    assert.ok(pending > 0, 'events produced during the outage must be retained');

    await stub.listen();
    await waitFor(
      () => publisher.isConnected() && publisher.pendingRetention() === 0,
      20_000,
      'reconnect and the retainer to drain'
    );
    await waitFor(() => stub.messages.length === TOTAL + 1, 20_000, 'every event at the stub');

    const ids = stub.messages.map(m => (JSON.parse(m.payload) as MessageReceivedEvent).waMessageId);
    assert.equal(new Set(ids).size, TOTAL + 1, 'no duplicated event id across the warm outage');
  } finally {
    await publisher.disconnect();
    await stub.kill();
  }
});

test('publisher: MessageUpdated and ChatUpdated are retained too', async () => {
  const stub = makeStubNats(STUB_PORT);
  const publisher = new EventPublisher(`nats://127.0.0.1:${STUB_PORT}`);
  try {
    await publisher.connect(); // down -> retained
    publisher.publishMessageUpdated({
      eventType: EventType.MESSAGE_UPDATED,
      waMessageId: 'INFRA290-EDIT-1',
      updateType: 'EDITED',
      newContent: 'edited while NATS was down',
      updatedAt: new Date().toISOString(),
    });
    publisher.publishChatUpdated({
      eventType: EventType.CHAT_UPDATED,
      waChatId: '34600000000@s.whatsapp.net',
      updateType: 'NAME_CHANGED',
      metadata: { name: 'retention' },
    });
    await stub.listen();
    await waitFor(() => stub.messages.length === 2, 10_000, 'both retained events');
    // SKIRM-114: `republished` is counted after the flush is confirmed, which is
    // after the stub has already received both PUBs.
    await waitFor(
      () => publisher.retentionStats().republished === 2,
      10_000,
      'the publisher to count both republished events'
    );

    const subjects = stub.messages.map(m => m.subject).sort();
    assert.deepEqual(subjects, ['whatsapp.ChatUpdated', 'whatsapp.MessageUpdated']);
    assert.equal(publisher.retentionStats().republished, 2);
  } finally {
    await publisher.disconnect();
    await stub.kill();
  }
});

test('publisher: a clean shutdown does not republish and clears the retainer', async () => {
  const publisher = new EventPublisher(`nats://127.0.0.1:${STUB_PORT}`);
  await publisher.connect(); // down -> retained
  publisher.publishMessageReceived(messageEvent(1));
  assert.equal(publisher.pendingRetention(), 1);
  await publisher.disconnect();
  assert.equal(publisher.pendingRetention(), 0, 'shutdown must not keep or send retained events');
});
