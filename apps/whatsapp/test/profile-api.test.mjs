import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const auth = `Basic ${Buffer.from('operator:password').toString('base64')}`;
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==', 'base64');

function profilePayload(overrides = {}) {
  return {
    jid: '34600123456@s.whatsapp.net',
    phone: '34600123456',
    name: 'Daniel',
    about: 'Disponible',
    aboutSetAt: '2026-09-20T10:00:00.000Z',
    photo: { available: true },
    capabilities: { name: true, about: true, photo: true, photoRemove: true },
    aboutKnown: true,
    photoKnown: true,
    ...overrides,
  };
}

/** Build an explicitly confirmed connector field result for write scenarios. */
function confirmedMutation(field, value, { failed = [], partial = false } = {}) {
  return ok({
    [field]: { requested: value, current: value, accepted: true, confirmed: true, reason: 'READBACK_MATCHED' },
    applied: [field],
    failed,
    partial,
  });
}

// The gateway signs every connector call; a fake that accepted anything would
// not prove that the account secret actually reaches the provider.
function signatureOk(headers, body, secret) {
  const timestamp = headers?.['x-connector-timestamp'];
  const signature = String(headers?.['x-connector-signature'] || '').replace('sha256=', '');
  if (!timestamp || !signature) return false;
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}:${JSON.stringify(body)}`)
    .digest('hex');
  return signature === expected;
}

async function fixture(t, { handler, env = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'whatsapp-profile-test-'));
  const calls = [];
  const runtimeEnv = {
    DATA_DIR: dir,
    UI_AUTH_USERNAME: 'operator',
    UI_AUTH_PASSWORD: 'password',
    APP_PUBLIC_URL: 'https://wa.example',
    APP_ENABLE_SENDING: 'true',
    PERSONAL_SECRET: 'personal-secret',
    SECONDARY_SECRET: 'secondary-secret',
    ...env,
  };
  const app = await createApp({
    env: runtimeEnv,
    db: { query: async () => ({ rows: [] }) },
    registry: [
      {
        channel: 'whatsapp',
        accountId: 'personal',
        secretEnv: 'PERSONAL_SECRET',
        connectorUrl: 'http://personal-connector',
      },
      {
        channel: 'whatsapp',
        accountId: 'secondary',
        secretEnv: 'SECONDARY_SECRET',
        connectorUrl: 'http://secondary-connector',
      },
    ],
    fetchImpl: async (url, options = {}) => {
      const method = options.method || 'GET';
      const body = typeof options.body === 'string' && options.body ? JSON.parse(options.body) : {};
      calls.push({ url: String(url), method, body });
      const secret = String(url).includes('secondary') ? 'secondary-secret' : 'personal-secret';
      if (!signatureOk(options.headers, body, secret)) {
        return Response.json(
          { ok: false, error: { code: 'BAD_SIGNATURE', message: 'bad signature' } },
          { status: 401 }
        );
      }
      return handler
        ? handler({ url: String(url), method, body })
        : Response.json({ ok: true, account: 'personal', data: profilePayload() });
    },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const send = (path, body, method, headers = {}) =>
    fetch(base + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: auth,
        ...(body === undefined
          ? {}
          : { origin: runtimeEnv.APP_PUBLIC_URL, 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const profileCalls = () => calls.filter(call => call.url.includes('/api/v1/profile'));
  return { send, calls, profileCalls };
}

const ok = (data, account = 'personal') => Response.json({ ok: true, account, data });
const upstreamError = (status, code, message, account = 'personal') =>
  Response.json({ ok: false, account, error: { code, message } }, { status });

test('GET /api/profile returns the account profile with live capabilities', async t => {
  const { send, profileCalls } = await fixture(t);
  const response = await send('/api/profile?account=personal');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    account: 'personal',
    sendingEnabled: true,
    capabilities: { name: true, about: true, photo: true, photoRemove: true },
    profile: {
      jid: '34600123456@s.whatsapp.net',
      phone: '34600123456',
      name: 'Daniel',
      about: 'Disponible',
      aboutSetAt: '2026-09-20T10:00:00.000Z',
      photo: { available: true },
    },
  });
  assert.deepEqual(profileCalls(), [
    { url: 'http://personal-connector/api/v1/profile/me', method: 'GET', body: {} },
  ]);
});

test('a profile read that does not name the account is an upstream fault, not an empty success', async t => {
  for (const data of [
    {},
    { name: 'Sin jid', photo: {}, capabilities: {} },
    { jid: 'x', photo: {}, capabilities: {} },
    { jid: '34600123456@s.whatsapp.net', photo: [], capabilities: {} },
    { jid: '34600123456@s.whatsapp.net', photo: {}, capabilities: {}, about: 7 },
  ]) {
    const { send } = await fixture(t, { handler: () => ok(data) });
    const response = await send('/api/profile?account=personal');
    assert.equal(response.status, 502, JSON.stringify(data));
    assert.equal((await response.json()).code, 'UPSTREAM_INVALID');
  }
  const array = await fixture(t, { handler: () => ok([]) });
  const arrayResponse = await array.send('/api/profile?account=personal');
  assert.equal(arrayResponse.status, 502);
  assert.equal((await arrayResponse.json()).code, 'UPSTREAM_INVALID');
});

test('a device or @c.us identity JID from the socket is a valid identity', async t => {
  for (const jid of [
    '34600123456:8@s.whatsapp.net',
    '34600123456@c.us',
    '123456789101112131415161718192021222324252627282930313233343536373839404142434445464748495051525354555657585960616263646566676869707172737475767778798081828384858687888990919293949596979899123456@lid',
  ]) {
    const { send } = await fixture(t, { handler: () => ok(profilePayload({ jid })) });
    const response = await send('/api/profile?account=personal');
    assert.equal(response.status, 200, jid);
    assert.equal((await response.json()).profile.jid, jid);
  }
});

test('an unreadable About or photo stays unknown instead of erasing the known value', async t => {
  const { send } = await fixture(t, {
    handler: () =>
      ok(
        profilePayload({
          about: null,
          aboutKnown: false,
          photo: { available: false },
          photoKnown: false,
        })
      ),
  });
  const profile = (await (await send('/api/profile?account=personal')).json()).profile;
  assert.equal('about' in profile, false);
  assert.equal('photo' in profile, false);
  assert.equal(profile.name, 'Daniel');
});

test('a profile answered by another account is rejected on reads and writes', async t => {
  const read = await fixture(t, { handler: () => ok(profilePayload(), 'secondary') });
  const readResponse = await read.send('/api/profile?account=personal');
  assert.equal(readResponse.status, 502);
  assert.match((await readResponse.json()).code, /ACCOUNT_MISMATCH/);
  const write = await fixture(t, {
    handler: () => ok({ applied: ['name'], failed: [], partial: false }, 'secondary'),
  });
  const writeResponse = await write.send('/api/profile', { account: 'personal', name: 'Otro' });
  assert.equal(writeResponse.status, 502);
  assert.match((await writeResponse.json()).code, /ACCOUNT_MISMATCH/);
});

test('a profile mutation forwards only the provided fields and answers with the merged contract', async t => {
  const seen = [];
  const { send, profileCalls } = await fixture(t, {
    handler: ({ method, body }) => {
      seen.push({ method, body });
      return method === 'PATCH'
        ? confirmedMutation('name', 'Nuevo')
        : ok(profilePayload({ name: 'Nuevo' }));
    },
  });
  const response = await send('/api/profile', { account: 'personal', name: 'Nuevo' });
  assert.equal(response.status, 200);
  const body = await response.json();
  // The only write must carry the requested field and explicit confirmation; the second call is
  // the readback that rebuilds the projection.
  assert.deepEqual(seen[0], { method: 'PATCH', body: { name: 'Nuevo', confirm: true } });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].method, 'GET');
  assert.equal(body.account, 'personal');
  assert.equal(body.sendingEnabled, true);
  assert.equal(body.confirmed, true);
  assert.equal(body.partial, false);
  assert.deepEqual(body.capabilities, { name: true, about: true, photo: true, photoRemove: true });
  assert.equal(body.profile.name, 'Nuevo');
  assert.deepEqual(body.results.name, {
    requested: 'Nuevo',
    current: 'Nuevo',
    accepted: true,
    confirmed: true,
    reason: 'READBACK_MATCHED',
  });
  assert.deepEqual(
    profileCalls().map(call => call.method),
    ['PATCH', 'GET']
  );
});

test('field limits and empty mutations are refused before the account is touched', async t => {
  const cases = [
    [{ name: 'x'.repeat(26) }, 'name'],
    [{ about: 'x'.repeat(140) }, 'about'],
    [{ about: 5 }, 'about'],
    [{ account: 'personal' }, 'no field'],
  ];
  for (const [payload] of cases) {
    const { send, profileCalls } = await fixture(t);
    const response = await send('/api/profile', { account: 'personal', ...payload });
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal(profileCalls().length, 0, payload);
  }
});

test('an empty About is a real clear and is forwarded', async t => {
  const seen = [];
  const { send } = await fixture(t, {
    handler: ({ method, body }) => {
      seen.push(body);
      return method === 'PATCH'
        ? ok({
            about: {
              requested: '',
              current: '',
              accepted: true,
              confirmed: true,
              reason: 'READBACK_MATCHED',
            },
            applied: ['about'],
            failed: [],
            partial: false,
          })
        : ok(profilePayload({ about: '' }));
    },
  });
  const body = await (await send('/api/profile', { account: 'personal', about: '' })).json();
  assert.deepEqual(seen[0], { about: '', confirm: true });
  assert.equal(body.confirmed, true);
  assert.equal(body.profile.about, '');
});

test('an unconfirmed or partially applied write never reports success', async t => {
  const stalled = await fixture(t, {
    handler: ({ method }) =>
      method === 'PATCH'
        ? ok({
            name: {
              requested: 'Nuevo',
              current: 'Viejo',
              accepted: true,
              confirmed: false,
              reason: 'SESSION_NAME_NOT_REFRESHED: wait for a reconnect',
            },
            applied: ['name'],
            failed: [],
            partial: false,
          })
        : ok(profilePayload({ name: 'Viejo' })),
  });
  const stalledBody = await (
    await stalled.send('/api/profile', { account: 'personal', name: 'Nuevo' })
  ).json();
  assert.equal(stalledBody.confirmed, false);
  assert.match(stalledBody.results.name.reason, /^SESSION_NAME_NOT_REFRESHED/);
  assert.equal(stalledBody.profile.name, 'Viejo');

  const partial = await fixture(t, {
    handler: ({ method }) =>
      method === 'PATCH'
        ? confirmedMutation('about', 'Hola', { failed: ['name'], partial: true })
        : ok(profilePayload()),
  });
  const partialBody = await (
    await partial.send('/api/profile', { account: 'personal', name: 'Nuevo', about: 'Hola' })
  ).json();
  assert.equal(partialBody.confirmed, false);
  assert.equal(partialBody.partial, true);
  assert.deepEqual(partialBody.results.about && partialBody.results.about.current, 'Hola');
});

test('profile writes respect both sending gates while reads stay available', async t => {
  for (const env of [{ APP_ENABLE_SENDING: 'false' }, { EMERGENCY_DISABLE_SENDING: 'true' }]) {
    const { send, profileCalls } = await fixture(t, { env });
    assert.equal((await send('/api/profile', { account: 'personal', name: 'Nuevo' })).status, 403);
    assert.equal(
      (
        await send('/api/profile/photo', {
          account: 'personal',
          mimeType: 'image/jpeg',
          data: JPEG.toString('base64'),
        })
      ).status,
      403
    );
    assert.equal((await send('/api/profile/photo/remove', { account: 'personal' })).status, 403);
    assert.equal(profileCalls().length, 0);
    assert.equal((await send('/api/profile?account=personal')).status, 200);
  }
});

test('PATCH is an origin-checked alias of the profile mutation', async t => {
  const { send } = await fixture(t, {
    handler: ({ method }) =>
      method === 'PATCH'
        ? confirmedMutation('about', 'Hola')
        : ok(profilePayload()),
  });
  assert.equal(
    (
      await send('/api/profile', { account: 'personal', about: 'Hola' }, 'PATCH', {
        origin: 'https://evil.example',
      })
    ).status,
    403
  );
  const response = await send('/api/profile', { account: 'personal', about: 'Hola' }, 'PATCH');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).confirmed, true);
});

test('connector profile faults keep their status and code', async t => {
  const { send } = await fixture(t, {
    handler: () => upstreamError(409, 'PROFILE_APP_STATE_UNAVAILABLE', 'App state key not present'),
  });
  const response = await send('/api/profile', { account: 'personal', name: 'Nuevo' });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, 'PROFILE_APP_STATE_UNAVAILABLE');
  assert.equal(body.error, 'App state key not present');
});

test('a photo upload validates the payload locally and forwards the base64 image', async t => {
  const seen = [];
  const { send, profileCalls } = await fixture(t, {
    handler: ({ method, body }) => {
      seen.push({ method, body });
      return method === 'POST'
        ? ok({
            photo: { available: true, accepted: true, confirmed: true, reason: 'READBACK_MATCHED' },
          })
        : ok(profilePayload());
    },
  });
  const data = JPEG.toString('base64');
  const response = await send('/api/profile/photo', {
    account: 'personal',
    name: 'foto.jpg',
    mimeType: 'image/jpeg',
    data,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.confirmed, true);
  assert.deepEqual(seen[0], {
    method: 'POST',
    body: { imageBase64: data, mimeType: 'image/jpeg', confirm: true },
  });
  assert.deepEqual(
    profileCalls().map(call => call.url),
    [
      'http://personal-connector/api/v1/profile/me/photo',
      'http://personal-connector/api/v1/profile/me',
    ]
  );

  const bad = [
    [{ mimeType: 'image/gif', data }, 400],
    [{ mimeType: 'image/jpeg', data: 'not base64!' }, 400],
    [{ mimeType: 'image/jpeg', data: 'A'.repeat(16 * 1024 * 1024 + 4) }, 413],
    [{ mimeType: 'image/jpeg' }, 400],
  ];
  for (const [payload, status] of bad) {
    const guard = await fixture(t, { handler: () => ok({ photo: { available: true } }) });
    const guardResponse = await guard.send('/api/profile/photo', {
      account: 'personal',
      ...payload,
    });
    assert.equal(guardResponse.status, status, JSON.stringify(Object.keys(payload)));
    assert.equal(guard.profileCalls().length, 0);
  }
});

test('a photo removal is confirmed only by the readback that observed it', async t => {
  const seen = [];
  const confirmed = await fixture(t, {
    handler: ({ method }) => {
      seen.push(method);
      return method === 'DELETE'
        ? ok({
            photo: {
              available: false,
              accepted: true,
              confirmed: true,
              reason: 'READBACK_REMOVED',
            },
          })
        : ok(profilePayload({ photo: { available: false } }));
    },
  });
  const body = await (
    await confirmed.send('/api/profile/photo/remove', { account: 'personal' })
  ).json();
  assert.deepEqual(seen, ['DELETE', 'GET']);
  assert.equal(body.confirmed, true);
  assert.deepEqual(body.profile.photo, { available: false });

  const unknown = await fixture(t, {
    handler: ({ method }) =>
      method === 'DELETE'
        ? ok({
            photo: {
              available: false,
              accepted: true,
              confirmed: false,
              reason: 'IDENTITY_UNKNOWN: lookup refused',
            },
          })
        : ok(profilePayload()),
  });
  const unknownBody = await (
    await unknown.send('/api/profile/photo/remove', { account: 'personal' })
  ).json();
  assert.equal(unknownBody.confirmed, false);
  assert.deepEqual(unknownBody.profile.photo, { available: true });
});

test('GET /api/profile/photo proxies bytes without exposing the provider', async t => {
  const { send } = await fixture(t, {
    handler: ({ url }) =>
      url.endsWith('/profile/me/photo')
        ? ok({ data: JPEG.toString('base64'), size: JPEG.length, contentType: 'image/svg+xml' })
        : ok(profilePayload()),
  });
  const response = await send('/api/profile/photo?account=personal&v=3');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(Number(response.headers.get('content-length')), JPEG.length);
  assert.match(response.headers.get('content-disposition'), /^inline/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), JPEG);
});

test('a missing, malformed or oversized own photo never becomes a fake image', async t => {
  const missing = await fixture(t, {
    handler: () =>
      upstreamError(404, 'PROFILE_PHOTO_UNAVAILABLE', 'This account has no profile photo'),
  });
  const missingResponse = await missing.send('/api/profile/photo?account=personal');
  assert.equal(missingResponse.status, 404);
  assert.equal((await missingResponse.json()).code, 'PROFILE_PHOTO_UNAVAILABLE');

  const malformed = await fixture(t, {
    handler: () => ok({ data: '!!!!not base64!!!!', size: 4, contentType: 'image/jpeg' }),
  });
  const malformedResponse = await malformed.send('/api/profile/photo?account=personal');
  assert.equal(malformedResponse.status, 502);
  assert.equal((await malformedResponse.json()).code, 'UPSTREAM_INVALID');

  const empty = await fixture(t, {
    handler: () => ok({ data: '', size: 0, contentType: 'image/jpeg' }),
  });
  assert.equal((await empty.send('/api/profile/photo?account=personal')).status, 404);

  const big = await fixture(t, {
    handler: () =>
      ok({
        data: 'A'.repeat(11 * 1024 * 1024),
        size: 8 * 1024 * 1024 + 1,
        contentType: 'image/jpeg',
      }),
  });
  assert.equal((await big.send('/api/profile/photo?account=personal')).status, 413);
});

test('a write whose readback fails keeps only proven fields and says the readback is unavailable', async t => {
  const { send } = await fixture(t, {
    handler: ({ method }) =>
      method === 'PATCH'
        ? confirmedMutation('name', 'Nuevo')
        : upstreamError(500, 'BOOM', 'connector exploded'),
  });
  const body = await (await send('/api/profile', { account: 'personal', name: 'Nuevo' })).json();
  assert.deepEqual(body.profile, { name: 'Nuevo' });
  assert.equal(body.profileReadback.available, false);
  assert.equal('capabilities' in body, false);
  assert.equal('about' in body.profile, false);
});

test('a read that fails outright is an error rather than an empty profile', async t => {
  const { send } = await fixture(t, {
    handler: () => upstreamError(503, 'PROFILE_DISCONNECTED', 'Socket not ready'),
  });
  const response = await send('/api/profile?account=personal');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'PROFILE_DISCONNECTED');
});
