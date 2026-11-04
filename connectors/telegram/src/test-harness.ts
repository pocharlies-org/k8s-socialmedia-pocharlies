import { TelegramClientWrapper } from './telegram-client';

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
