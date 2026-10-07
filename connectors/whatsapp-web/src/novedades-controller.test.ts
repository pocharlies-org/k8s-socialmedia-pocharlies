import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';
import { CommunityError } from './novedades-communities';

const secret = 'communities-test-only-secret';
async function appFor(client: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createRouter(client as any, {} as any, secret));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  return { base, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
function headers(body: unknown) {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    'content-type': 'application/json',
    'x-connector-timestamp': String(timestamp),
    'x-connector-signature': generateHMACSignature(body, timestamp, secret),
  };
}

test('all community routes require HMAC and never reach provider anonymously', async () => {
  let calls = 0;
  const stub = async () => {
    calls++;
    return [];
  };
  const app = await appFor({
    isConnected: () => true,
    listCommunities: async () => { calls++; return { communities: [] }; },
    getCommunity: stub,
    createCommunity: stub,
    communityAction: stub,
  });
  try {
    for (const [path, method] of [
      ['/communities', 'GET'],
      ['/communities/123@g.us', 'GET'],
      ['/communities', 'POST'],
      ['/communities/123@g.us/action', 'POST'],
    ]) {
      assert.equal((await fetch(app.base + path, { method })).status, 401);
    }
    assert.equal(calls, 0);
    const result = await fetch(app.base + '/communities', { headers: headers({}) });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { communities: [], count: 0 });
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
});

test('community mutations respect enable and emergency gates', async () => {
  const oldEnabled = process.env.ENABLE_SENDING;
  const oldEmergency = process.env.EMERGENCY_DISABLE_SENDING;
  let calls = 0;
  const stub = async () => {
    calls++;
  };
  const app = await appFor({ createCommunity: stub, communityAction: stub });
  try {
    for (const [enabled, emergency] of [
      ['false', 'false'],
      ['true', 'true'],
    ]) {
      process.env.ENABLE_SENDING = enabled;
      process.env.EMERGENCY_DISABLE_SENDING = emergency;
      for (const path of ['/communities', '/communities/123@g.us/action']) {
        const response = await fetch(app.base + path, {
          method: 'POST',
          headers: headers({}),
          body: '{}',
        });
        assert.equal(response.status, 403);
      }
    }
    assert.equal(calls, 0);
  } finally {
    await app.close();
    if (oldEnabled === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = oldEnabled;
    if (oldEmergency === undefined) delete process.env.EMERGENCY_DISABLE_SENDING;
    else process.env.EMERGENCY_DISABLE_SENDING = oldEmergency;
  }
});

test('community input and provider errors preserve honest HTTP error contract', async () => {
  const app = await appFor({
    getCommunity: async (jid: string) => {
      if (jid === 'bad') throw new CommunityError('INVALID_COMMUNITY_INPUT', 'Invalid JID', 400);
      throw new CommunityError('INVALID_PROVIDER_RESPONSE', 'Incomplete result', 502);
    },
  });
  try {
    for (const [jid, status] of [
      ['bad', 400],
      ['123@g.us', 502],
    ] as const) {
      const response = await fetch(app.base + '/communities/' + jid, { headers: headers({}) });
      assert.equal(response.status, status);
      assert.equal((await response.json()).ok, false);
    }
  } finally {
    await app.close();
  }
});

test('channel lookup resolves only the supplied newsletter JID or WhatsApp invite link', async () => {
  const calls: unknown[][] = [];
  const socket = {
    newsletterMetadata: async (kind: string, key: string) => {
      calls.push([kind, key]);
      return {
        id: '123456789012345678@newsletter',
        invite: 'secret-invite-code',
        thread_metadata: {
          name: { text: 'Canal de prueba' },
          description: { text: 'Descripción pública' },
          subscribers_count: '12',
          creation_time: '1760000000',
          verification: 'VERIFIED',
          picture: { mediaKey: 'secret-media-key', directPath: '/private' },
        },
        viewer_metadata: { role: 'GUEST', mute: 'OFF' },
      };
    },
  };
  const app = await appFor({ novedadesChannelSocket: () => socket, isConnected: () => true });
  try {
    const jid = '123456789012345678@newsletter';
    const response = await fetch(`${app.base}/novedades/channels/lookup?query=${encodeURIComponent(jid)}`, {
      headers: headers({}),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.channel.id, jid);
    assert.equal(result.channel.name, 'Canal de prueba');
    assert.equal(result.channel.subscribed, false);
    assert.equal(result.channel.verification, 'verified');
    assert.equal(JSON.stringify(result).includes('secret'), false);

    const invite = await fetch(
      `${app.base}/novedades/channels/lookup?query=${encodeURIComponent('https://whatsapp.com/channel/CODE')}`,
      { headers: headers({}) }
    );
    assert.equal(invite.status, 200);
    assert.deepEqual(calls, [
      ['jid', jid],
      ['invite', 'CODE'],
    ]);

    for (const query of ['https://example.com/channel/CODE', 'not-a-channel']) {
      const invalid = await fetch(
        `${app.base}/novedades/channels/lookup?query=${encodeURIComponent(query)}`,
        { headers: headers({}) }
      );
      assert.equal(invalid.status, 400);
    }
    assert.equal(calls.length, 2, 'invalid identities never reach the provider');
  } finally {
    await app.close();
  }
});

test('following and unfollowing are gated, state-verified, and idempotent', async () => {
  const previousSending = process.env.ENABLE_SENDING;
  const previousEmergency = process.env.EMERGENCY_DISABLE_SENDING;
  const jid = '123456789012345678@newsletter';
  let role = 'GUEST';
  const calls: string[] = [];
  let followWrites = 0;
  let unfollowWrites = 0;
  const socket = {
    newsletterMetadata: async (_kind: string, key: string) => {
      calls.push(`metadata:${key}:${role}`);
      return {
        id: jid,
        thread_metadata: { name: { text: 'Canal' } },
        viewer_metadata: { role, mute: 'OFF' },
      };
    },
    newsletterFollow: async (target: string) => {
      calls.push(`follow:${target}`);
      followWrites++;
      role = 'SUBSCRIBER';
      return { accepted: true };
    },
    newsletterUnfollow: async (target: string) => {
      calls.push(`unfollow:${target}`);
      unfollowWrites++;
      role = 'GUEST';
      return { accepted: true };
    },
  };
  const app = await appFor({ novedadesChannelSocket: () => socket, isConnected: () => true });
  try {
    process.env.ENABLE_SENDING = 'false';
    delete process.env.EMERGENCY_DISABLE_SENDING;
    const followBody = { jid, action: 'follow' };
    const blocked = await fetch(`${app.base}/novedades/channels/subscription`, {
      method: 'POST',
      headers: headers(followBody),
      body: JSON.stringify(followBody),
    });
    assert.equal(blocked.status, 403);
    assert.deepEqual(calls, [], 'the connector send gate runs before provider access');

    process.env.ENABLE_SENDING = 'true';
    const followed = await fetch(`${app.base}/novedades/channels/subscription`, {
      method: 'POST',
      headers: headers(followBody),
      body: JSON.stringify(followBody),
    });
    assert.equal(followed.status, 200);
    assert.equal((await followed.json()).confirmed, true);
    assert.deepEqual(calls, [
      `metadata:${jid}:GUEST`,
      `follow:${jid}`,
      `metadata:${jid}:SUBSCRIBER`,
    ]);

    const alreadyFollowing = await fetch(`${app.base}/novedades/channels/subscription`, {
      method: 'POST',
      headers: headers(followBody),
      body: JSON.stringify(followBody),
    });
    assert.equal(alreadyFollowing.status, 200);
    assert.equal((await alreadyFollowing.json()).unchanged, true);
    assert.equal(followWrites, 1, 'the second follow request writes nothing');

    const unfollowBody = { jid, action: 'unfollow' };
    const unfollowed = await fetch(`${app.base}/novedades/channels/subscription`, {
      method: 'POST',
      headers: headers(unfollowBody),
      body: JSON.stringify(unfollowBody),
    });
    assert.equal(unfollowed.status, 200);
    assert.equal((await unfollowed.json()).channel.subscribed, false);
    assert.equal(unfollowWrites, 1);
  } finally {
    await app.close();
    if (previousSending === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = previousSending;
    if (previousEmergency === undefined) delete process.env.EMERGENCY_DISABLE_SENDING;
    else process.env.EMERGENCY_DISABLE_SENDING = previousEmergency;
  }
});

test('a subscription without provider read-back confirmation is reported uncertain once', async () => {
  const previousSending = process.env.ENABLE_SENDING;
  const jid = '123456789012345678@newsletter';
  let writes = 0;
  const socket = {
    newsletterMetadata: async () => ({
      id: jid,
      thread_metadata: { name: { text: 'Canal' } },
      viewer_metadata: { role: 'GUEST', mute: 'OFF' },
    }),
    newsletterFollow: async () => {
      writes++;
      return { accepted: true };
    },
  };
  const app = await appFor({ novedadesChannelSocket: () => socket, isConnected: () => true });
  try {
    process.env.ENABLE_SENDING = 'true';
    const body = { jid, action: 'follow' };
    const response = await fetch(`${app.base}/novedades/channels/subscription`, {
      method: 'POST',
      headers: headers(body),
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.outcomeUncertain, true);
    assert.equal(result.error.code, 'NOVEDADES_SUBSCRIPTION_UNCONFIRMED');
    assert.equal(writes, 1, 'an unconfirmed provider write is never retried');
  } finally {
    await app.close();
    if (previousSending === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = previousSending;
  }
});

test('the channel routes use only the public newsletter port of the client', async () => {
  const jid = '123456789012345678@newsletter';
  const reached: string[] = [];
  const port = {
    newsletterMetadata: async (_kind: string, key: string) => {
      reached.push(`metadata:${key}`);
      return {
        id: jid,
        thread_metadata: { name: { text: 'Canal' } },
        viewer_metadata: { role: 'GUEST', mute: 'OFF' },
      };
    },
  };
  // `sock` is the private session handle: if a route ever reads it again, this
  // client answers with a metadata call the test does not expect.
  const app = await appFor({
    sock: {
      newsletterMetadata: async () => {
        reached.push('private-sock');
        return null;
      },
    },
    novedadesChannelSocket: () => port,
    isConnected: () => true,
  });
  try {
    const response = await fetch(
      `${app.base}/novedades/channels/lookup?query=${encodeURIComponent(jid)}`,
      { headers: headers({}) }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(reached, [`metadata:${jid}`], 'the port is the only way to the provider');
  } finally {
    await app.close();
  }
});

test('a client build without the newsletter port answers 501 instead of guessing', async () => {
  const app = await appFor({ novedadesChannelSocket: () => ({}), isConnected: () => true });
  try {
    const lookup = await fetch(
      `${app.base}/novedades/channels/lookup?query=${encodeURIComponent('111@newsletter')}`,
      { headers: headers({}) }
    );
    assert.equal(lookup.status, 501);
    assert.equal((await lookup.json()).error.code, 'NOVEDADES_CAPABILITY_MISSING');
  } finally {
    await app.close();
  }
});

test('two concurrent subscription requests for one channel write to WhatsApp once', async () => {
  const previousSending = process.env.ENABLE_SENDING;
  const jid = '123456789012345678@newsletter';
  let role = 'GUEST';
  let writes = 0;
  let release: (() => void) | undefined;
  const followHeld = new Promise<void>(resolve => {
    release = resolve;
  });
  const socket = {
    newsletterMetadata: async () => ({
      id: jid,
      thread_metadata: { name: { text: 'Canal' } },
      viewer_metadata: { role, mute: 'OFF' },
    }),
    newsletterFollow: async () => {
      writes++;
      await followHeld;
      role = 'SUBSCRIBER';
      return { accepted: true };
    },
  };
  // A fresh request object per call, as the real router does: the per-account
  // serialization must survive that, because both requests hit the same session.
  const app = await appFor({ novedadesChannelSocket: () => socket, isConnected: () => true });
  const body = { jid, action: 'follow' };
  try {
    process.env.ENABLE_SENDING = 'true';
    const send = () =>
      fetch(`${app.base}/novedades/channels/subscription`, {
        method: 'POST',
        headers: headers(body),
        body: JSON.stringify(body),
      });
    const first = send();
    const second = send();
    release!();
    const [a, b] = await Promise.all([first, second]);
    const [firstResult, secondResult] = await Promise.all([a.json(), b.json()]);

    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(writes, 1, 'the duplicate click must not follow the channel twice');
    assert.equal(firstResult.confirmed, true);
    assert.equal(firstResult.unchanged, false);
    assert.equal(secondResult.confirmed, true);
    assert.equal(secondResult.unchanged, true, 'the duplicate reports the state the provider holds');
    assert.equal(secondResult.channel.subscribed, true);
  } finally {
    await app.close();
    if (previousSending === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = previousSending;
  }
});
