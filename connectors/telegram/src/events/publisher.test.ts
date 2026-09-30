import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import pino from 'pino';

/**
 * INFRA-291 (P4) — regression tests for the Telegram NATS publisher's
 * reconnect loop.
 *
 * Bug (fixed here): connect() re-threw on failure and main.ts awaited it at
 * startup, so a telegram-connector pod that started while NATS was down died
 * (CrashLoop) instead of re-attaching when NATS came back.
 *
 * Pattern follows connectors/whatsapp-web/src/events/publisher.test.ts: real
 * TCP sockets, no mocking of the nats module. "NATS inexistente" is a closed
 * loopback port; "levantar NATS después" is a minimal NATS-protocol stub
 * server bound to that same port mid-test. The whole scenario runs in ONE
 * process and asserts the process never exits — the criterion is that a
 * missing NATS can no longer kill main.ts.
 */

// Fast retries so the reconnect lands quickly and deterministically.
// Read by TelegramEventPublisher at construction time.
process.env.NATS_RECONNECT_BASE_MS = '50';
process.env.NATS_RECONNECT_MAX_MS = '100';

import {
  TELEGRAM_MESSAGE_EDITED_SUBJECT,
  TelegramEventPublisher,
  TelegramMessageReceivedEvent,
  toMessageEditedEvent,
} from './publisher';

type PublisherInternals = {
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  connecting: boolean;
};

/** Minimal NATS server: INFO on connect, +OK for CONNECT, PING→PONG, absorbs PUB. */
class NatsStub {
  server: net.Server;
  port = 0;
  received: Buffer[] = [];

  constructor() {
    this.server = net.createServer(sock => {
      sock.write(
        'INFO {"server_name":"nats-stub","version":"2.10.0","proto":1,' +
          '"max_payload":1048576,"headers":false,"client_id":1}\r\n'
      );
      let buf = '';
      let pendingPayload = 0;
      sock.on('data', chunk => {
        this.received.push(Buffer.from(chunk));
        if (pendingPayload > 0) {
          const take = Math.min(pendingPayload, chunk.length);
          pendingPayload -= take;
          chunk = chunk.subarray(take);
          if (chunk.length === 0) return;
        }
        buf += chunk.toString('latin1');
        for (;;) {
          if (pendingPayload > 0) {
            // Payload of a PUB started in an earlier line but not fully in
            // `buf` yet: drop what we have and wait for the rest.
            const take = Math.min(pendingPayload, buf.length);
            buf = buf.slice(take);
            pendingPayload -= take;
            if (buf.length === 0) break;
          }
          const nl = buf.indexOf('\r\n');
          if (nl < 0) break;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const parts = line.split(' ');
          const verb = (parts[0] || '').toUpperCase();
          if (verb === 'CONNECT') sock.write('+OK\r\n');
          else if (verb === 'PING') sock.write('PONG\r\n');
          else if (verb === 'PUB') {
            // PUB <subject> [reply-to] <#bytes>\r\n<payload>\r\n
            const bytes = parseInt(parts[parts.length - 1], 10);
            if (Number.isFinite(bytes) && bytes >= 0) {
              const need = bytes + 2; // payload + trailing CRLF
              if (buf.length >= need) buf = buf.slice(need);
              else {
                pendingPayload = need - buf.length;
                buf = '';
                break;
              }
            }
          }
        }
      });
      sock.on('error', () => undefined);
    });
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        const addr = this.server.address() as net.AddressInfo;
        this.port = addr.port;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise(resolve => this.server.close(() => resolve()));
  }

  /** All bytes ever received, as text (for asserting a PUB frame landed). */
  text(): string {
    return Buffer.concat(this.received).toString('latin1');
  }
}

/** Ask the OS for a free port, then leave it closed until we bind it later. */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

function sampleEvent(id: string): TelegramMessageReceivedEvent {
  return {
    eventType: 'TelegramMessageReceived',
    account: 'personal',
    conversationId: 'chat-1',
    telegramMessageId: id,
    telegramTimestamp: new Date().toISOString(),
    senderTelegramId: 'user-1',
    content: 'hola',
    messageType: 'text',
    isForwarded: false,
    isOutbound: false,
    chatType: 'private',
  };
}

const openPublishers: TelegramEventPublisher[] = [];
const openStubs: NatsStub[] = [];

afterEach(async () => {
  for (const p of openPublishers.splice(0)) await p.disconnect();
  for (const s of openStubs.splice(0)) await s.close();
});

test('connect() against a dead NATS never throws and schedules retries (process stays alive)', async () => {
  const logs: string[] = [];
  const logger = pino({ level: 'debug' }, { write: (line: string) => logs.push(line) });
  const publisher = new TelegramEventPublisher('nats://127.0.0.1:1', undefined, logger);
  openPublishers.push(publisher);

  // THE regression: before P4 this re-threw and main.ts died at startup.
  await publisher.connect();

  assert.equal(publisher.isConnected(), false, 'must not report connected');
  const internals = publisher as unknown as PublisherInternals;
  assert.notEqual(internals.reconnectTimer, null, 'a reconnect must be scheduled');
  assert.equal(internals.reconnectAttempts, 1);
  assert.equal(internals.connecting, false, 'in-flight guard must be cleared');

  // Publishing while down is a no-op, not a crash (message handler contract).
  publisher.publishMessageReceived(sampleEvent('m1'));
  publisher.publishChatUpdated({
    eventType: 'TelegramChatUpdated',
    telegramChatId: 'c1',
    updateType: 'NAME_CHANGED',
    metadata: {},
  });

  // The retry loop keeps trying while NATS is still absent.
  await new Promise<void>(resolve => {
    const deadline = Date.now() + 5000;
    const poll = setInterval(() => {
      if (internals.reconnectAttempts >= 2 || Date.now() > deadline) {
        clearInterval(poll);
        resolve();
      }
    }, 25);
  });
  assert.ok(
    internals.reconnectAttempts >= 2,
    `retry loop must keep re-attempting (attempts=${internals.reconnectAttempts})`
  );
  assert.equal(publisher.isConnected(), false);

  // Readiness is honest: logs show the refusal, never a fake "Connected".
  assert.ok(logs.some(l => l.includes('NATS unavailable')), 'refusal must be logged');
  assert.ok(!logs.some(l => l.includes('Connected to NATS')), 'must not claim a connection');
});

test('publisher re-attaches when NATS comes up after startup (the CrashLoop scenario)', async () => {
  const logs: string[] = [];
  const logger = pino({ level: 'debug' }, { write: (line: string) => logs.push(line) });

  const port = await freePort();
  const url = `nats://127.0.0.1:${port}`;
  const publisher = new TelegramEventPublisher(url, undefined, logger);
  openPublishers.push(publisher);

  // 1) Start against a NATS that does not exist yet.
  await publisher.connect();
  assert.equal(publisher.isConnected(), false);
  assert.ok(
    logs.some(l => l.includes('NATS unavailable')),
    'initial refusal must be logged as unavailable'
  );

  // 2) Bring NATS up on the same port mid-test (the pod's CrashLoop fix:
  //    the process is still alive and its retry loop is still running).
  const stub = new NatsStub();
  await stub.listen(port);
  openStubs.push(stub);

  // 3) The backoff retry attaches — verified through the log, per the spec.
  const connected = await Promise.race([
    new Promise<boolean>(resolve => {
      const deadline = Date.now() + 10000;
      const poll = setInterval(() => {
        if (logs.some(l => l.includes(`Connected to NATS at ${url}`))) {
          clearInterval(poll);
          resolve(true);
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          resolve(false);
        }
      }, 25);
    }),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 10000)),
  ]);

  assert.ok(
    connected,
    `publisher must re-attach once NATS is reachable (logs:\n${logs.join('\n')})`
  );
  assert.equal(publisher.isConnected(), true, 'readiness must flip to connected');

  // 4) The re-attached connection really publishes.
  publisher.publishMessageReceived(sampleEvent('m-after-reconnect'));
  await new Promise<void>(resolve => setTimeout(resolve, 200));
  assert.ok(
    stub.text().includes('PUB telegram.MessageReceived'),
    'a PUB frame for the event must reach the server after re-attach'
  );

  // Whole test ran in ONE process from a failed startup — nothing exited:
  // the CrashLoop scenario is over, the pod survives a NATS-less boot.
});

test('publishMessageEdited: telegram.MessageEdited con el payload que aplica telegram-sync; sin NATS → false', async () => {
  const logger = pino({ level: 'silent' });
  const event = toMessageEditedEvent('professional', {
    conversationId: '-1001234567890',
    telegramMessageId: '42',
    content: 'texto nuevo ñ',
    editedAt: new Date('2026-09-29T10:00:00Z'),
    isOutbound: true,
    source: 'connector',
    actor: 'dani',
  });
  assert.deepEqual(event, {
    eventType: 'TelegramMessageEdited',
    account: 'professional',
    conversationId: '-1001234567890',
    telegramMessageId: '42',
    content: 'texto nuevo ñ',
    editedAt: '2026-09-29T10:00:00.000Z',
    source: 'connector',
    actor: 'dani',
    isOutbound: true,
  });
  // No actor → no key (telegram-sync records it only when present).
  assert.equal(
    'actor' in
      toMessageEditedEvent('personal', {
        ...event,
        editedAt: new Date(),
        source: 'telegram',
        actor: undefined,
      }),
    false
  );

  const down = new TelegramEventPublisher('nats://127.0.0.1:1', undefined, logger);
  openPublishers.push(down);
  assert.equal(down.publishMessageEdited(event), false, 'NATS down → not published');

  const stub = new NatsStub();
  await stub.listen(0);
  openStubs.push(stub);
  const up = new TelegramEventPublisher(`nats://127.0.0.1:${stub.port}`, undefined, logger);
  openPublishers.push(up);
  await up.connect();
  assert.equal(up.isConnected(), true);
  assert.equal(up.publishMessageEdited(event), true);
  await new Promise<void>(resolve => setTimeout(resolve, 200));
  assert.equal(TELEGRAM_MESSAGE_EDITED_SUBJECT, 'telegram.MessageEdited');
  const wire = Buffer.concat(stub.received).toString('utf8');
  assert.ok(wire.includes('PUB telegram.MessageEdited'), 'PUB frame on telegram.MessageEdited');
  assert.ok(wire.includes(JSON.stringify(event)), 'payload is the event JSON');
});
