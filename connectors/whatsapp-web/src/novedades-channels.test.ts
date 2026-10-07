import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ChannelLookupError,
  ChannelSubscriptionUncertainError,
  parseChannelQuery,
  publicChannelFromMetadata,
  subscriptionRoleConfirmed,
} from './novedades-channels';

/*
 * These tests pin the channel lookup/follow contract for Baileys 7.0.0-rc13:
 * `newsletterMetadata` only resolves a supplied JID or invite code (rc13
 * exposes no global channel directory), the follow/unfollow results are
 * `unknown` and prove nothing on their own, so the only honest confirmation
 * of a subscription change is the viewer-role read-back of `newsletterMetadata`.
 */

test('lookup accepts only a bare newsletter JID or a WhatsApp channel link', () => {
  assert.deepEqual(parseChannelQuery('123456789012345678@newsletter'), {
    type: 'jid',
    key: '123456789012345678@newsletter',
  });
  assert.deepEqual(parseChannelQuery('  https://whatsapp.com/channel/AbC-123_x  '), {
    type: 'invite',
    key: 'AbC-123_x',
  });
  assert.deepEqual(parseChannelQuery('https://wa.me/channel/CODE'), {
    type: 'invite',
    key: 'CODE',
  });
  for (const bad of [
    '',
    '   ',
    'not-a-channel',
    'https://example.com/channel/CODE',
    'https://whatsapp.com/channel/',
    'https://whatsapp.com/channel/bad code',
    '34600111222@s.whatsapp.net',
    '123@g.us',
    '123:4@newsletter', // device-suffixed newsletter JID is not a channel address
    'x'.repeat(2049),
    42,
    null,
    undefined,
    {},
  ]) {
    assert.throws(() => parseChannelQuery(bad), ChannelLookupError, `must reject ${String(bad)}`);
  }
});

test('rc13 nested metadata projects only public fields and maps the viewer role', () => {
  const channel = publicChannelFromMetadata({
    id: '123456789012345678@newsletter',
    invite: 'InviteCode',
    thread_metadata: {
      name: { text: 'Canal de prueba' },
      description: { text: 'Descripción pública' },
      subscribers_count: '12',
      creation_time: '1760000000',
      verification: 'VERIFIED',
      picture: { id: 'pic', mediaKey: 'private-media-key', directPath: '/private/path' },
    },
    viewer_metadata: { role: 'SUBSCRIBER', mute: 'OFF' },
  });
  assert.deepEqual(channel, {
    id: '123456789012345678@newsletter',
    name: 'Canal de prueba',
    description: 'Descripción pública',
    role: 'subscriber',
    subscribed: true,
    verification: 'verified',
    subscribers: 12,
    createdAt: '2025-10-09T08:53:20.000Z',
    muted: false,
    avatarAvailable: false,
    avatarUrl: null,
  });
  const serialized = JSON.stringify(channel);
  assert(!serialized.includes('InviteCode'), 'the invite code never leaves the connector');
  assert(!serialized.includes('private-media-key'), 'the picture media key never leaves');
  assert(!serialized.includes('private/path'), 'the picture direct path never leaves');
});

test('guest viewers are unsubscribed and unknown roles stay unknown', () => {
  const base = { id: '9@newsletter', thread_metadata: { name: { text: 'C' } } };
  assert.equal(
    publicChannelFromMetadata({ ...base, viewer_metadata: { role: 'GUEST', mute: 'ON' } }).subscribed,
    false
  );
  assert.equal(
    publicChannelFromMetadata({ ...base, viewer_metadata: { role: 'OWNER', mute: 'OFF' } }).subscribed,
    true
  );
  assert.equal(publicChannelFromMetadata(base).subscribed, null);
  assert.equal(publicChannelFromMetadata(base).muted, null);
});

test('incomplete provider metadata is rejected instead of guessed', () => {
  for (const bad of [
    null,
    undefined,
    {},
    { id: '123@g.us' },
    { id: '9@newsletter', thread_metadata: { name: 'not-an-object' } },
  ]) {
    assert.throws(() => publicChannelFromMetadata(bad), ChannelLookupError);
  }
});

test('the follow read-back decides confirmed, unchanged and uncertain only from viewer role', () => {
  const role = (viewer: unknown) => ({ viewer_metadata: viewer ?? null });
  assert.equal(subscriptionRoleConfirmed('follow', role({ role: 'SUBSCRIBER' })), 'confirmed');
  assert.equal(subscriptionRoleConfirmed('follow', role({ role: 'OWNER' })), 'confirmed');
  assert.equal(subscriptionRoleConfirmed('follow', role({ role: 'ADMIN' })), 'confirmed');
  assert.equal(subscriptionRoleConfirmed('follow', role({ role: 'GUEST' })), 'uncertain');
  assert.equal(subscriptionRoleConfirmed('follow', role(null)), 'uncertain');
  assert.equal(subscriptionRoleConfirmed('unfollow', role({ role: 'GUEST' })), 'confirmed');
  assert.equal(subscriptionRoleConfirmed('unfollow', role({ role: 'SUBSCRIBER' })), 'uncertain');
  assert.equal(subscriptionRoleConfirmed('unfollow', role({ role: 'ADMIN' })), 'uncertain');
});

test('subscription errors distinguish an uncertain provider answer from a refusal', () => {
  assert.equal(new ChannelSubscriptionUncertainError().outcomeUncertain, true);
  assert.equal(new ChannelLookupError('NOVEDADES_SESSION_DOWN', 'down', 503).outcomeUncertain, undefined);
});

/* ---- service-level: exact identity and honest post-write handling ---- */

type FakeSocket = {
  newsletterMetadata: (type: string, key: string) => Promise<unknown>;
  newsletterFollow: (jid: string) => Promise<unknown>;
  newsletterUnfollow: (jid: string) => Promise<unknown>;
};

function socketFor(
  t: import('node:test').TestContext,
  meta: (type: string, key: string, call: number) => unknown,
  opts: { failMetaCall?: number; role?: 'follow' | 'unfollow' } = {}
) {
  const calls: string[] = [];
  let writes = 0;
  let metaCalls = 0;
  const socket: FakeSocket = {
    newsletterMetadata: async (type, key) => {
      metaCalls++;
      calls.push(`metadata:${type}:${key}:${metaCalls}`);
      if (opts.failMetaCall === metaCalls) throw new Error('session dropped');
      return meta(type, key, metaCalls);
    },
    newsletterFollow: async jid => {
      writes++;
      calls.push(`follow:${jid}`);
      return {};
    },
    newsletterUnfollow: async jid => {
      writes++;
      calls.push(`unfollow:${jid}`);
      return {};
    },
  };
  return { socket, calls, writes: () => writes, metaCalls: () => metaCalls };
}

const chan = (id: string, role: string) => ({
  id,
  thread_metadata: { name: { text: 'C' } },
  viewer_metadata: { role, mute: 'OFF' },
});

test('lookup of a JID rejects metadata for a different channel instead of returning it', async t => {
  const { ChannelService } = await import('./novedades-channels');
  const { socket, calls } = socketFor(t, () => chan('999@newsletter', 'GUEST'));
  await assert.rejects(
    new ChannelService(socket).lookup('111@newsletter'),
    (error: unknown) =>
      error instanceof ChannelLookupError &&
      (error as ChannelLookupError).status === 502 &&
      (error as ChannelLookupError).code === 'INVALID_PROVIDER_RESPONSE'
  );
  assert.equal(calls.length, 1, 'the mismatch is answered from the single lookup call');
});

test('a pre-read naming another channel never reaches the socket with a write', async t => {
  const { ChannelService } = await import('./novedades-channels');
  const { socket, calls, writes } = socketFor(t, () => chan('999@newsletter', 'GUEST'));
  await assert.rejects(
    new ChannelService(socket).subscription({ jid: '111@newsletter', action: 'follow' }),
    ChannelLookupError
  );
  assert.equal(writes(), 0, 'identity must be proven before any mutation');
  assert(calls.every(call => call.startsWith('metadata:')));
});

test('a post-write read failure stays uncertain with exactly one write and no retry', async t => {
  const { ChannelService } = await import('./novedades-channels');
  const { socket, calls, writes, metaCalls } = socketFor(t, (_type, _key, call) => chan('111@newsletter', call === 1 ? 'GUEST' : 'SUBSCRIBER'), {
    failMetaCall: 2,
  });
  await assert.rejects(
    new ChannelService(socket).subscription({ jid: '111@newsletter', action: 'follow' }),
    (error: unknown) => error instanceof ChannelSubscriptionUncertainError
  );
  assert.equal(writes(), 1, 'the mutation may have landed, so nothing is retried');
  assert.equal(metaCalls(), 2, 'the dropped read-back is not re-attempted');
  assert.deepEqual(calls.at(-1), 'metadata:jid:111@newsletter:2');
});

test('post-write metadata that is malformed or names another channel is uncertain', async t => {
  const { ChannelService } = await import('./novedades-channels');
  for (const after of [null, { junk: true }, chan('999@newsletter', 'SUBSCRIBER')]) {
    const { socket, writes } = socketFor(t, (_type, _key, call) =>
      call === 1 ? chan('111@newsletter', 'GUEST') : after
    );
    await assert.rejects(
      new ChannelService(socket).subscription({ jid: '111@newsletter', action: 'follow' }),
      ChannelSubscriptionUncertainError,
      `post-read ${JSON.stringify(after)} cannot confirm`
    );
    assert.equal(writes(), 1);
  }
});

/* ---- service-level: one mutation per channel at a time ---- */

/**
 * `newsletterFollow` proves nothing, so nothing stops a second concurrent
 * request from mutating the same channel twice. The service must serialize per
 * JID: the duplicate arrives after the first read-back and is answered from the
 * state the provider then reports, without a second write.
 */
test('two concurrent follows of one channel produce exactly one provider write', async () => {
  const { ChannelService } = await import('./novedades-channels');
  const jid = '111@newsletter';
  let role = 'GUEST';
  let writes = 0;
  let releaseFollow: (() => void) | undefined;
  const followStarted = new Promise<void>(resolve => {
    releaseFollow = resolve;
  });
  const socket = {
    newsletterMetadata: async () => ({
      id: jid,
      thread_metadata: { name: { text: 'C' } },
      viewer_metadata: { role, mute: 'OFF' },
    }),
    newsletterFollow: async () => {
      writes++;
      await followStarted;
      role = 'SUBSCRIBER';
      return {};
    },
  };
  const service = new ChannelService(socket);
  const first = service.subscription({ jid, action: 'follow' });
  const second = service.subscription({ jid, action: 'follow' });
  releaseFollow!();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(writes, 1, 'the duplicate must not mutate the channel twice');
  assert.equal(a.confirmed, true);
  assert.equal(a.unchanged, false);
  assert.equal(b.confirmed, true);
  assert.equal(b.unchanged, true, 'the duplicate is answered from the state the provider reports');
  assert.equal(b.channel.subscribed, true);
});

test('the per-channel lock does not hold a different channel behind it', async () => {
  const { ChannelService } = await import('./novedades-channels');
  const roles: Record<string, string> = { '111@newsletter': 'GUEST', '222@newsletter': 'GUEST' };
  const writes: string[] = [];
  // The first channel only finishes once the second one has written, so a lock
  // that was global instead of per channel would deadlock here, not merely be
  // slower.
  let releaseFirst: (() => void) | undefined;
  const secondWrote = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  const starved = new Promise<never>((_resolve, reject) =>
    setTimeout(() => reject(new Error('second channel starved behind a global lock')), 250)
  );
  const socket = {
    newsletterMetadata: async (_type: string, key: string) => ({
      id: key,
      thread_metadata: { name: { text: 'C' } },
      viewer_metadata: { role: roles[key], mute: 'OFF' },
    }),
    newsletterFollow: async (key: string) => {
      writes.push(key);
      if (key === '111@newsletter') await secondWrote;
      else releaseFirst!();
      roles[key] = 'SUBSCRIBER';
      return {};
    },
  };
  const service = new ChannelService(socket);
  const both = Promise.all([
    service.subscription({ jid: '111@newsletter', action: 'follow' }),
    service.subscription({ jid: '222@newsletter', action: 'follow' }),
  ]);
  const results = await Promise.race([both, starved]);
  assert.deepEqual(writes, ['222@newsletter', '111@newsletter'].sort(), 'both wrote independently');
  for (const result of results) assert.equal(result.confirmed, true);
});

test('the socket is resolved per call, so a reconnect is not pinned to a dead handle', async () => {
  const { ChannelService } = await import('./novedades-channels');
  const used: string[] = [];
  const make = (label: string) => ({
    newsletterMetadata: async (_type: string, key: string) => {
      used.push(label);
      return { id: key, thread_metadata: { name: { text: label } }, viewer_metadata: { role: 'GUEST' } };
    },
  });
  let current: ReturnType<typeof make> | null = make('before');
  const service = new ChannelService(() => current);
  await service.lookup('111@newsletter');
  current = make('after');
  const after = await service.lookup('111@newsletter');
  assert.deepEqual(used, ['before', 'after']);
  assert.equal(after.channel.name, 'after');
});

test('a session without a live socket answers 503 instead of a stale write', async () => {
  const { ChannelService, ChannelLookupError } = await import('./novedades-channels');
  for (const service of [new ChannelService(null), new ChannelService(() => null)]) {
    await assert.rejects(
      service.lookup('111@newsletter'),
      (error: unknown) =>
        error instanceof ChannelLookupError && (error as ChannelLookupError).status === 503
    );
    await assert.rejects(
      service.subscription({ jid: '111@newsletter', action: 'follow' }),
      (error: unknown) =>
        error instanceof ChannelLookupError && (error as ChannelLookupError).status === 503
    );
  }
});

/* ---- the BaileysClient provider port ---- */

/**
 * The channel service reaches the provider through `novedadesChannelSocket()`,
 * a narrow port owned by BaileysClient. This pins that the port exists, that it
 * carries only the three newsletter calls, and that a missing capability stays
 * absent so the service can answer 501 instead of pretending.
 */
test('BaileysClient hands out only the newsletter port, never the socket', async () => {
  const { BaileysClient } = await import('./baileys-client');
  const client = new (BaileysClient as any)('/tmp/unused-channel-port-test', 'key-32-bytes-long-key-32-bytes');
  type Port = import('./novedades-channels').ChannelSocketLike;
  assert.equal(client.novedadesChannelSocket(), null, 'a session with no socket has no port');

  const seen: unknown[][] = [];
  const socket = {
    identity: 'socket-owner',
    newsletterMetadata: async function (this: { identity: string }, type: string, key: string) {
      seen.push(['metadata', type, key, this.identity]);
      return { id: key, thread_metadata: { name: { text: 'C' } } };
    },
    newsletterFollow: async function (this: { identity: string }, jid: string) {
      seen.push(['follow', jid, this.identity]);
      return { accepted: true };
    },
    // No newsletterUnfollow in this provider build.
    sendMessage: async () => {
      throw new Error('the channel port must not carry messaging');
    },
  };
  (client as unknown as { sock: unknown }).sock = socket;
  const port = client.novedadesChannelSocket() as Port;
  assert.ok(port);
  assert.deepEqual(Object.keys(port).filter(key => port[key as keyof typeof port] !== undefined), [
    'newsletterMetadata',
    'newsletterFollow',
  ]);
  assert.equal(typeof port.newsletterUnfollow, 'undefined', 'absent capability stays absent');
  assert.equal((port as Record<string, unknown>).sendMessage, undefined, 'no messaging leaks out');

  await port.newsletterMetadata!('jid', '111@newsletter');
  await port.newsletterFollow!('111@newsletter');
  assert.deepEqual(seen, [
    ['metadata', 'jid', '111@newsletter', 'socket-owner'],
    ['follow', '111@newsletter', 'socket-owner'],
  ]);

  // The port stays attached to the socket that existed when it was taken.
  const replaced = {
    newsletterMetadata: async () => {
      seen.push(['metadata', 'replaced']);
      return null;
    },
  };
  (client as unknown as { sock: unknown }).sock = replaced;
  const next = client.novedadesChannelSocket()!;
  await next.newsletterMetadata!('jid', '222@newsletter');
  assert.deepEqual(seen.at(-1), ['metadata', 'replaced']);
});
