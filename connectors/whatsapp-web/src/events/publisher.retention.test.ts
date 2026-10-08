import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { setImmediate as nextTurn } from 'node:timers/promises';

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
 *
 * SKIRM-115: nothing here waits on a wall-clock deadline. Every wait is a
 * condition re-checked when the publisher or the stub says something changed
 * (`until`), and "emit at a steady pace" is one event per event-loop turn
 * (`nextTurn`), not a sleep. A loaded runner makes the spec slower, never red.
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

/**
 * A port nobody holds right now. The stub is down at the start of most specs, so
 * the publisher's URL has to be known before the stub listens; reserving a free
 * port (instead of a fixed one) keeps two runs on the same host from colliding.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** A fixed instant for the retainer's pure unit specs: no wall clock. */
const NOW = Date.parse('2026-10-08T00:00:00Z');

interface StubMessage {
  subject: string;
  payload: string;
}

interface StubNats {
  messages: StubMessage[];
  listen(): Promise<void>;
  kill(): Promise<void>;
  reset(): void;
  /** Fires after every PUB the stub records. Returns the unsubscribe. */
  onChange(listener: () => void): () => void;
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
  const listeners = new Set<() => void>();

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
          for (const listener of [...listeners]) listener();
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
    onChange: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** A stub and a publisher pointed at it, on a port nobody else holds. */
async function harness(): Promise<{ stub: StubNats; publisher: EventPublisher }> {
  const port = await freePort();
  return { stub: makeStubNats(port), publisher: new EventPublisher(`nats://127.0.0.1:${port}`) };
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

/**
 * Resolve as soon as `condition` holds. It is checked now and again every time
 * one of the `sources` (the publisher, the stub) reports a change, so there is
 * no polling interval and no deadline to be missed on a loaded runner.
 */
function until(
  condition: () => boolean,
  ...sources: Array<{ onChange(listener: () => void): () => void }>
): Promise<void> {
  return new Promise(resolve => {
    const unsubscribe: Array<() => void> = [];
    const check = (): void => {
      if (!condition()) return;
      for (const off of unsubscribe) off();
      resolve();
    };
    for (const source of sources) unsubscribe.push(source.onChange(check));
    check();
  });
}

test('retainer: entry cap evicts the oldest events (FIFO)', () => {
  const retainer = new BoundedEventRetainer({ maxEvents: 3, windowHours: 6 });
  const now = NOW;
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
  const now = NOW;
  retainer.enqueue({ key: 'old', subject: 's', payload: Buffer.from('1'), enqueuedAtMs: now });
  retainer.enqueue({ key: 'new', subject: 's', payload: Buffer.from('2'), enqueuedAtMs: now });
  // Age the first entry past the window, then enqueue again: expiry is swept
  // on enqueue and on drain, exactly like a TTL queue.
  assert.equal(retainer.ageItem('old', 2 * 3_600_000, now), true);
  retainer.enqueue({ key: 'newer', subject: 's', payload: Buffer.from('3'), enqueuedAtMs: now });

  const stats = retainer.stats();
  assert.equal(stats.expiredDropped, 1, 'the stale entry was dropped for age');
  assert.deepEqual(retainer.peek().map(item => item.key), ['new', 'newer']);
});

test('retainer: the same event id is never queued twice', () => {
  const retainer = new BoundedEventRetainer({ maxEvents: 10, windowHours: 6 });
  const now = NOW;
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
  const now = NOW;
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

test('publisher: 100 events at a steady pace survive a NATS outage with zero loss and zero duplicates', async () => {
  const { stub, publisher } = await harness();
  try {
    // NATS is down when the connector starts: the initial connect fails and
    // the publisher enters the retained state (this is the prod window that
    // used to log "skipping message event" and drop the event).
    await publisher.connect();
    assert.equal(publisher.isConnected(), false, 'stub must be down at start');

    const TOTAL = 100;
    const OUTAGE = 60; // events 0..59 are produced while NATS is unreachable
    let i = 0;
    for (; i < 30; i++) {
      publisher.publishMessageReceived(messageEvent(i));
      await nextTurn();
    }
    // The server comes back mid-stream, like a restarted pod; the publisher's
    // own reconnect loop finds it on its own schedule.
    await stub.listen();
    for (; i < OUTAGE; i++) {
      publisher.publishMessageReceived(messageEvent(i));
      await nextTurn();
    }
    // Wait for the reconnect itself, not for a number of milliseconds. From
    // here the retained events are being drained, and the rest of the stream
    // is published live on top of that drain: the interleaving the criterion
    // is about, now guaranteed rather than left to a sleep's luck.
    await until(() => publisher.isConnected(), publisher);
    for (; i < TOTAL; i++) {
      publisher.publishMessageReceived(messageEvent(i));
      await nextTurn();
    }

    await until(
      () => {
        const stats = publisher.retentionStats();
        return (
          stub.messages.length === TOTAL &&
          publisher.pendingRetention() === 0 &&
          stats.published + stats.republished === TOTAL
        );
      },
      publisher,
      stub
    );

    const ids = stub.messages.map(m => (JSON.parse(m.payload) as MessageReceivedEvent).waMessageId);
    assert.equal(ids.length, TOTAL, 'criterion A: nothing lost across the outage');
    assert.equal(new Set(ids).size, TOTAL, 'criterion C: no duplicated event id');
    assert.deepEqual(
      ids,
      Array.from({ length: TOTAL }, (_, n) => `INFRA290-${String(n).padStart(4, '0')}`),
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
  const { stub, publisher } = await harness();
  try {
    await stub.listen();
    await publisher.connect(); // resolves once the connection is established
    assert.equal(publisher.isConnected(), true, 'publisher to connect');

    publisher.publishMessageReceived(messageEvent(1));
    publisher.publishMessageReceived(messageEvent(2));

    await until(() => stub.messages.length === 2, stub);
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
  const { stub, publisher } = await harness();
  try {
    await publisher.connect(); // down -> retained
    const event = messageEvent(7);
    publisher.publishMessageReceived(event);
    await stub.listen();
    await until(() => stub.messages.length === 1, stub);

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
  const { stub, publisher } = await harness();
  try {
    await stub.listen();
    await publisher.connect();
    assert.equal(publisher.isConnected(), true, 'initial connection');

    publisher.publishMessageReceived(messageEvent(0));
    await until(() => stub.messages.length === 1, stub);

    // NATS dies with the connection open.
    await stub.kill();
    await until(() => !publisher.isConnected(), publisher);

    const TOTAL = 40;
    for (let i = 1; i <= TOTAL; i++) {
      publisher.publishMessageReceived(messageEvent(i));
      await nextTurn();
    }
    const pending = publisher.pendingRetention();
    assert.ok(pending > 0, 'events produced during the outage must be retained');

    await stub.listen();
    await until(
      () =>
        publisher.isConnected() &&
        publisher.pendingRetention() === 0 &&
        stub.messages.length === TOTAL + 1,
      publisher,
      stub
    );

    const ids = stub.messages.map(m => (JSON.parse(m.payload) as MessageReceivedEvent).waMessageId);
    assert.equal(new Set(ids).size, TOTAL + 1, 'no duplicated event id across the warm outage');
  } finally {
    await publisher.disconnect();
    await stub.kill();
  }
});

test('publisher: MessageUpdated and ChatUpdated are retained too', async () => {
  const { stub, publisher } = await harness();
  try {
    await publisher.connect(); // down -> retained
    publisher.publishMessageUpdated({
      eventType: EventType.MESSAGE_UPDATED,
      waMessageId: 'INFRA290-EDIT-1',
      updateType: 'EDITED',
      newContent: 'edited while NATS was down',
      updatedAt: new Date(NOW).toISOString(),
    });
    publisher.publishChatUpdated({
      eventType: EventType.CHAT_UPDATED,
      waChatId: '34600000000@s.whatsapp.net',
      updateType: 'NAME_CHANGED',
      metadata: { name: 'retention' },
    });
    await stub.listen();
    // The stub sees the bytes before the publisher has counted the flush that
    // confirms them, so the counter is its own condition (SKIRM-115: asserting
    // it right after the stub's count was the `0 !== 2` flake).
    await until(
      () => stub.messages.length === 2 && publisher.retentionStats().republished === 2,
      publisher,
      stub
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
  const { publisher } = await harness();
  await publisher.connect(); // down -> retained
  publisher.publishMessageReceived(messageEvent(1));
  assert.equal(publisher.pendingRetention(), 1);
  await publisher.disconnect();
  assert.equal(publisher.pendingRetention(), 0, 'shutdown must not keep or send retained events');
});
