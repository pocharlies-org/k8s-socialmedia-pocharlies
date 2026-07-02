import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Regression tests for the EventPublisher initial-connect retry path.
 *
 * Bug (fixed 2026-07-02): connect()'s catch invoked scheduleReconnect() while
 * the `connecting` in-flight guard was still true (`finally` runs after the
 * catch), and scheduleReconnect() no-ops on that guard — so a failed INITIAL
 * connect never scheduled a retry and the connector ran "without event
 * publishing" until manually restarted (observed in prod when a rollout raced
 * a transient NATS connection refusal).
 *
 * These tests hit a real closed TCP port (127.0.0.1) so the nats client fails
 * fast with CONNECTION_REFUSED — no mocking of the nats module needed.
 */

// Fast retries so the second-attempt test stays quick and deterministic.
// Read by EventPublisher at construction time.
process.env.NATS_RECONNECT_BASE_MS = '50';
process.env.NATS_RECONNECT_MAX_MS = '100';

import { EventPublisher } from './publisher';

/** An address that refuses connections immediately: closed port on loopback. */
const REFUSED_URL = 'nats://127.0.0.1:1';

type PublisherInternals = {
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  connecting: boolean;
};

let publisher: EventPublisher;

beforeEach(() => {
  publisher = new EventPublisher(REFUSED_URL);
});

afterEach(async () => {
  // Clears any pending reconnect timer so attempts stop between tests.
  await publisher.disconnect();
});

test('failed initial connect schedules a reconnect (regression: connecting guard swallowed the retry)', async () => {
  await publisher.connect();

  const internals = publisher as unknown as PublisherInternals;
  assert.equal(publisher.isConnected(), false, 'must not report connected');
  assert.notEqual(
    internals.reconnectTimer,
    null,
    'a reconnect must be scheduled after a failed initial connect'
  );
  assert.equal(internals.reconnectAttempts, 1, 'first retry must be accounted');
  assert.equal(internals.connecting, false, 'in-flight guard must be cleared');
});

test('scheduled retry actually re-attempts the connection', async () => {
  await publisher.connect();

  const internals = publisher as unknown as PublisherInternals;
  assert.equal(internals.reconnectAttempts, 1);

  // Base delay is 50ms; after it fires, the retry fails again (port still
  // closed) and must schedule the NEXT attempt — proving the loop is alive.
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
});
