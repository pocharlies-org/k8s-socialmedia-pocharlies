/**
 * SC-1394: a client the owner closed with disconnect() (the pairing pool, after
 * the QR budget is spent) must stay closed. Baileys emits `close` after
 * sock.end(); before the fix disconnect() had already lowered
 * intentionalDisconnect, so that late close scheduled a reconnect and the
 * watchdog kept reviving the client (~40 sockets/h).
 */
import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BaileysClient } from './baileys-client';

function setup() {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16), { ingest: false });
  const handlers: Record<string, (u: any) => unknown> = {};
  const sock = {
    ev: { on: (e: string, fn: (u: any) => unknown) => (handlers[e] = fn) },
    end: () => {},
  };
  const c = client as any;
  c.sock = sock;
  c.logger = { info() {}, warn() {}, error() {}, debug() {} };
  let connects = 0;
  c.connect = async () => {
    connects += 1;
  };
  c.bindSocketEvents(async () => {});
  return { c, handlers, connects: () => connects };
}

test('close event arriving after disconnect() does not schedule a reconnect', async () => {
  const { c, handlers } = setup();
  await c.disconnect();
  handlers['connection.update']({ connection: 'close', lastDisconnect: undefined });
  assert.equal(c.reconnectTimer, null);
});

test('scheduleReconnect, reconnectNow and the watchdog are inert after disconnect()', async () => {
  const { c, connects } = setup();
  await c.disconnect();
  c.scheduleReconnect('x');
  assert.equal(c.reconnectTimer, null);
  await c.reconnectNow('x');
  c.lastState = 'INITIALIZING';
  c.initializeStartedAt = new Date(0);
  await c.runWatchdog();
  assert.equal(connects(), 0);
});

test('a later real connect() re-arms reconnection (renewQR / new start keep working)', async () => {
  const client = new BaileysClient('/dev/null/unusable', 'k'.repeat(16), { ingest: false });
  const c = client as any;
  c.logger = { info() {}, warn() {}, error() {}, debug() {} };
  await c.disconnect();
  assert.equal(c.intentionalDisconnect, true);
  // mkdir under /dev/null fails right after connect() lowers the flag: no socket is opened.
  await assert.rejects(c.connect());
  assert.equal(c.intentionalDisconnect, false);
});
