/**
 * Alias de rutas de la app whatsapp.e-dani.com (SC-2760): la app manda el id en
 * la ruta y firma el body tal cual; el conector plano lo esperaba en el body.
 * El merge del param va después del HMAC (firma sobre JSON.stringify(req.body)).
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import '../test-env';
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createRouter } from './controller';
import { generateHMACSignature } from './auth';

test('parameterized aliases merge the id into the body after the HMAC', async () => {
  const secret = 'alias-fixture';
  const calls: unknown[][] = [];
  const app = express();
  app.use(express.json());
  app.use(
    createRouter(
      {
        isConnected: () => true,
        getCachedState: () => 'open',
        modifyChat: async (...args: unknown[]) => {
          calls.push(['modify', ...args]);
          return { action: args[1], chatId: args[0], persisted: true, state: {} };
        },
        setContactBlock: async (...args: unknown[]) => {
          calls.push(['block', ...args]);
          return { blocked: true, changed: true, confirmed: true, jid: '34600@c.us' };
        },
        deleteMessageForMe: async (...args: unknown[]) => {
          calls.push(['deleteForMe', ...args]);
          return { revoked: false };
        },
      } as any,
      { getCurrentQR: () => null } as any,
      secret
    )
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown, method = 'POST') => {
    const timestamp = Math.floor(Date.now() / 1000);
    return fetch(`${base}${path}`, {
      method,
      body: method === 'DELETE' ? undefined : JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        'x-connector-timestamp': String(timestamp),
        'x-connector-signature': generateHMACSignature(body, timestamp, secret),
      },
    });
  };
  const previous = process.env.ENABLE_SENDING;
  process.env.ENABLE_SENDING = 'true';
  try {
    // modify: id en la ruta, mute con `value` (ms) como manda la app.
    const mute = await post('/chats/34600%40c.us/modify', { action: 'mute', value: 3_600_000 });
    assert.equal(mute.status, 200);
    assert.deepEqual(calls.at(-1)?.[0], 'modify');
    assert.equal(calls.at(-1)?.[1], '34600@c.us');
    assert.equal(calls.at(-1)?.[2], 'mute');
    const muteOptions = calls.at(-1)?.[3] as { mute?: { until?: Date } };
    assert.ok(muteOptions.mute && muteOptions.mute.until instanceof Date);
    // Sin firma, el alias tampoco entra.
    const unsigned = await fetch(`${base}/chats/34600%40c.us/modify`, {
      method: 'POST',
      body: JSON.stringify({ action: 'mute' }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(unsigned.status, 401);
    // block: {blocked} → action + confirm, y conversationId desde la ruta.
    const block = await post('/chats/34600%40c.us/block', { blocked: true });
    assert.equal(block.status, 200);
    assert.deepEqual(await block.json(), {
      ok: true,
      blocked: true,
      changed: true,
      confirmed: true,
      jid: '34600@c.us',
    });
    assert.equal((calls.at(-1)?.[1] as { conversationId?: string }).conversationId, '34600@c.us');
    assert.equal((calls.at(-1)?.[1] as { action?: string }).action, 'block');
    // delete for-me: ids en la ruta, body vacío firmado "{}".
    const del = await post('/messages/34600%40c.us/ABC123/for-me', {}, 'DELETE');
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { deleted: true, scope: 'me', revoked: false });
    assert.equal(calls.at(-1)?.[0], 'deleteForMe');
    assert.equal(calls.at(-1)?.[1], '34600@c.us');
    assert.equal(calls.at(-1)?.[2], 'ABC123');
  } finally {
    if (previous === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = previous;
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  }
});
