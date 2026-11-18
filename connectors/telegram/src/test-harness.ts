import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { TelegramClientWrapper } from './telegram-client';
import { createRouter } from './api/controller';

/**
 * A real TelegramClientWrapper with a fake mtcute client wired in: the route
 * specs (send-idempotency, moderation-routes) pin the REAL wrapper over a
 * fake client, so this wiring lives here once. `connected` is forced true —
 * those specs test past the connection check.
 */
export function wrapperWith(fake: unknown): TelegramClientWrapper {
  const wrapper = new TelegramClientWrapper({ apiId: 1, apiHash: 'x', sessionString: 's' });
  const internals = wrapper as unknown as { client: unknown; connected: boolean };
  internals.client = fake;
  internals.connected = true;
  return wrapper;
}

/**
 * Serves the real signed router over a fake mtcute client on an ephemeral
 * port. Returns the base URL and a close() to register in afterEach. Lives
 * here once so the route specs (moderation-routes, participants-route) share
 * one serve instead of each cloning it.
 */
// Shared fixtures for the signed-route specs (one copy, not one per file).
export const TEST_CONNECTOR_SECRET = 'test-connector-secret';
export const TEST_GROUP_ID = '-1003365295248';

export async function serveConnector(
  fake: unknown,
  sharedSecret: string
): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createRouter(wrapperWith(fake), sharedSecret));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

/**
 * Per-test `serve` with afterEach cleanup, shared by the signed-route specs.
 * `afterEachFn` is node:test's afterEach passed in, so this module stays free
 * of the test runner.
 */
export function connectorFixture(
  secret: string,
  afterEachFn: (fn: () => Promise<void>) => void
): (fake: unknown) => Promise<string> {
  const open: Array<() => Promise<void>> = [];
  afterEachFn(async () => {
    for (const close of open.splice(0)) await close();
  });
  return async fake => {
    const { base, close } = await serveConnector(fake, secret);
    open.push(close);
    return base;
  };
}
