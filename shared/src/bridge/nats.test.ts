import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { NatsSubscriber } from './nats';

// The moved scaffolding keeps its fail-soft contract: a NATS that is down never
// throws out of start(); it schedules reconnects with growing delay until stop().
test('NATS down: start() does not throw, retries with growing delay, stop() ends the retries', async () => {
  const delays: number[] = [];
  const logger = pino({ level: 'silent' });
  logger.warn = ((obj: { delayMs?: number }) => {
    if (typeof obj?.delayMs === 'number') delays.push(obj.delayMs);
  }) as typeof logger.warn;
  const sub = new NatsSubscriber({
    natsUrl: 'nats://127.0.0.1:1',
    queue: 'q',
    subjects: ['s'],
    logger,
    onMessage: async () => undefined,
    reconnectBaseMs: 10,
    reconnectMaxMs: 40,
  });
  await sub.start();
  assert.equal(sub.isConnected(), false);
  const until = Date.now() + 5000;
  while (delays.length < 4 && Date.now() < until) await new Promise(r => setTimeout(r, 20));
  await sub.stop();
  assert.deepEqual(delays.slice(0, 4), [10, 20, 40, 40]);
  const n = delays.length;
  await new Promise(r => setTimeout(r, 150));
  assert.equal(delays.length, n, 'no retry after stop()');
});
