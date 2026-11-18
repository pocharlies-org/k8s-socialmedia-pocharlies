import assert from 'node:assert/strict';
import express from 'express';
import { test } from 'node:test';
import { createRouter } from './controller';
import { generateHMACSignature } from './auth';
import { ProfileError } from '../profile-service';

const secret = 'profile-controller-test-secret';
const JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]).toString(
  'base64'
);

async function startApp(client: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createRouter(client as never, { getCurrentQR: () => null } as never, secret));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  return { base, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

function signed(body: unknown) {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    'content-type': 'application/json',
    'x-connector-timestamp': String(timestamp),
    // The connector signs the canonical JSON body, exactly like the app does.
    'x-connector-signature': generateHMACSignature(body, timestamp, secret),
  };
}

function profileClient(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    isConnected: () => true,
    getStatus: () => ({}),
    getCachedState: () => 'open',
    getOwnProfile: async () => ({
      jid: '34600123456@c.us',
      phone: '34600123456',
      name: 'Daniel',
      about: 'Disponible',
      aboutSetAt: '2026-09-20T08:00:00.000Z',
      photo: { available: true },
      capabilities: { name: true, about: true, photo: true, photoRemove: true },
      aboutKnown: true,
      photoKnown: true,
    }),
    updateOwnProfile: async () => ({
      name: {
        requested: 'Daniel',
        current: 'Daniel',
        accepted: true,
        confirmed: true,
        reason: 'READBACK_MATCHED',
      },
      applied: ['name'],
      failed: [],
      partial: false,
    }),
    setOwnProfilePhoto: async () => ({
      photo: {
        available: true,
        accepted: true,
        confirmed: true,
        reason: 'IDENTITY_CHANGED',
      },
      mimeType: 'image/jpeg',
      bytes: 8,
    }),
    removeOwnProfilePhoto: async () => ({
      photo: {
        available: false,
        accepted: true,
        confirmed: true,
        reason: 'READBACK_REMOVED',
      },
    }),
    getOwnProfilePhotoBytes: async () =>
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
    ...overrides,
  };
}

async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const previous = new Map(
    Object.keys(values).map(key => [key, process.env[key] as string | undefined])
  );
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('the profile read is authenticated and preserves the production envelope', async () => {
  const app = await startApp(profileClient());
  try {
    const anonymous = await fetch(`${app.base}/profile/me`);
    assert.equal(anonymous.status, 401);

    const response = await fetch(`${app.base}/profile/me`, { headers: signed({}) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ['profile']);
    assert.equal(body.profile.name, 'Daniel');
    assert.deepEqual(body.profile.photo, { available: true });
    assert.equal(body.profile.capabilities.photoRemove, true);
  } finally {
    await app.close();
  }
});

test('a blocked sending switch refuses profile writes before the provider', async () => {
  for (const env of [
    { ENABLE_SENDING: 'false', EMERGENCY_DISABLE_SENDING: 'false', code: 'SENDING_DISABLED' },
    {
      ENABLE_SENDING: 'true',
      EMERGENCY_DISABLE_SENDING: 'true',
      code: 'EMERGENCY_DISABLE_SENDING',
    },
  ]) {
    let writes = 0;
    const app = await startApp(
      profileClient({
        updateOwnProfile: async () => {
          writes += 1;
          return { applied: ['name'], failed: [], partial: false };
        },
        setOwnProfilePhoto: async () => {
          writes += 1;
          return { photo: { available: true, accepted: true, confirmed: true, reason: 'x' } };
        },
        removeOwnProfilePhoto: async () => {
          writes += 1;
          return { photo: { available: false, accepted: true, confirmed: true, reason: 'x' } };
        },
      })
    );
    try {
      await withEnv(
        {
          ENABLE_SENDING: env.ENABLE_SENDING,
          EMERGENCY_DISABLE_SENDING: env.EMERGENCY_DISABLE_SENDING,
        },
        async () => {
          const patch = await fetch(`${app.base}/profile/me`, {
            method: 'PATCH',
            headers: signed({ name: 'Nuevo' }),
            body: JSON.stringify({ name: 'Nuevo' }),
          });
          assert.equal(patch.status, 403);
          assert.equal((await patch.json()).error.code, env.code);

          const photo = await fetch(`${app.base}/profile/me/photo`, {
            method: 'POST',
            headers: signed({ imageBase64: JPEG_BASE64, mimeType: 'image/jpeg', confirm: true }),
            body: JSON.stringify({
              imageBase64: JPEG_BASE64,
              mimeType: 'image/jpeg',
              confirm: true,
            }),
          });
          assert.equal(photo.status, 403);

          const remove = await fetch(`${app.base}/profile/me/photo`, {
            method: 'DELETE',
            headers: signed({}),
          });
          assert.equal(remove.status, 403);
        }
      );
      assert.equal(writes, 0, 'the provider must not be touched while sending is blocked');
    } finally {
      await app.close();
    }
  }
});

test('profile writes run when sending is enabled and answer with per-field outcomes', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const app = await startApp(
    profileClient({
      updateOwnProfile: async (input: Record<string, unknown>) => {
        seen.push(input);
        return {
          name: {
            requested: 'Daniel',
            current: 'Old',
            accepted: true,
            confirmed: false,
            reason: 'SESSION_NAME_NOT_REFRESHED: WhatsApp accepted the name',
          },
          applied: ['name'],
          failed: [],
          partial: false,
        };
      },
    })
  );
  try {
    await withEnv({ ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: 'false' }, async () => {
      for (const method of ['PATCH', 'POST'] as const) {
        const input = { name: 'Daniel', ...(method === 'POST' ? { confirm: true } : {}) };
        const response = await fetch(`${app.base}/profile/me`, {
          method,
          headers: signed(input),
          body: JSON.stringify(input),
        });
        assert.equal(response.status, 200, `${method} must be accepted`);
        const body = await response.json();
        assert.equal(method === 'PATCH' ? body.ok : body.updated, true);
        const result = method === 'PATCH' ? body.data : body;
        assert.equal(result.name.accepted, true);
        assert.equal(result.name.confirmed, false);
        assert.match(result.name.reason, /SESSION_NAME_NOT_REFRESHED/);
      }
    });
    // Only the keys the caller actually sent reach the provider.
    assert.deepEqual(seen, [{ name: 'Daniel' }, { name: 'Daniel' }]);
  } finally {
    await app.close();
  }
});

test('invalid profile input becomes a 400 before calling the provider', async () => {
  let writes = 0;
  const app = await startApp(
    profileClient({
      updateOwnProfile: async () => {
        writes += 1;
        throw new ProfileError('INVALID_PROFILE_INPUT', 'Profile name exceeds 25 characters', {
          maxChars: 25,
        });
      },
    })
  );
  try {
    await withEnv({ ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: 'false' }, async () => {
      const response = await fetch(`${app.base}/profile/me`, {
        method: 'POST',
        headers: signed({ name: 'x'.repeat(30), confirm: true }),
        body: JSON.stringify({ name: 'x'.repeat(30), confirm: true }),
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, 'INVALID_PROFILE_INPUT');
      assert.equal(writes, 0);
    });
  } finally {
    await app.close();
  }
});

test('a missing image library surfaces as 501 instead of a fake photo success', async () => {
  const app = await startApp(
    profileClient({
      setOwnProfilePhoto: async () => {
        throw new ProfileError(
          'PROFILE_PICTURE_PROCESSING_UNAVAILABLE',
          'The connector platform has no image processing library, so the profile photo cannot be re-encoded'
        );
      },
    })
  );
  try {
    await withEnv({ ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: 'false' }, async () => {
      const response = await fetch(`${app.base}/profile/me/photo`, {
        method: 'POST',
        headers: signed({ imageBase64: JPEG_BASE64, mimeType: 'image/jpeg', confirm: true }),
        body: JSON.stringify({ imageBase64: JPEG_BASE64, mimeType: 'image/jpeg', confirm: true }),
      });
      assert.equal(response.status, 501);
      const body = await response.json();
      assert.equal(body.code, 'PROFILE_PICTURE_PROCESSING_UNAVAILABLE');
    });
  } finally {
    await app.close();
  }
});

test('the own photo is served as base64 or as an honest 404', async () => {
  const app = await startApp(profileClient());
  const empty = await startApp(profileClient({ getOwnProfilePhotoBytes: async () => null }));
  try {
    const photo = await fetch(`${app.base}/profile/me/photo`, { headers: signed({}) });
    assert.equal(photo.status, 200);
    const body = await photo.json();
    assert.equal(body.data.contentType, 'image/jpeg');
    assert.equal(body.data.size, 8);
    assert.equal(Buffer.from(body.data.data, 'base64').length, 8);

    const missing = await fetch(`${empty.base}/profile/me/photo`, { headers: signed({}) });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'PROFILE_PHOTO_UNAVAILABLE');
  } finally {
    await app.close();
    await empty.close();
  }
});
