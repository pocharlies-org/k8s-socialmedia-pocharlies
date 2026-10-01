import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Boom } from '@hapi/boom';
import {
  ProfileError,
  mapProfileProviderError,
  applyProfileUpdates,
  decodeProfilePhoto,
  normalizeStatusReadResult,
  phoneFromProfileJid,
  profileCapabilities,
  readOwnProfile,
  readOwnProfilePhotoBytes,
  removeOwnProfilePhoto,
  setOwnProfilePhoto,
  type OwnProfilePhotoProvider,
} from './profile-service';
import { BaileysClient } from './baileys-client';
import { USyncStatusProtocol } from '@whiskeysockets/baileys/lib/WAUSync/Protocols/USyncStatusProtocol.js';

/** Synthetic 96x96 RGB checker/gradient, encoded as JPEG with sharp. */
const REAL_JPEG_BASE64 =
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCABgAGADASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAwYI/8QAGhABAAMBAQEAAAAAAAAAAAAA8AIDIZHBYf/EABgBAQEBAQEAAAAAAAAAAAAAAAUDBwQG/8QAFhEAAwAAAAAAAAAAAAAAAAAAAAID/9oADAMBAAIRAxEAPwDNsKx48Kx40KxnGhWPPbM5zSoDCsZxoVjOPCscxoVjyLOJyoDCseNCseNCsZx4VjORZxKVAYVjPmNCsZ8xoVjxoVjyLOJSoDCscx4VjmNCsZ8xoVjPmRZxKVAYVjxoVjPmPCscxoVjyDOJyoQsKx48KxnGhWPGhWOYmzmKSoDCsZxoVjx4VjxoVjORZxKVAYVjxoVjPmNCsZx4VjyLOJSoDCsZ8xoVjmNCsePCsZ8yLOJyoBCscx4VjxoVjPmNCscyDOJSoDCsZ8x4VjONCseNCseRZxKVCFhWM48KxnGhWOY0Kx4mzmKyoDCsePCseNCsZxoVjORZxKVAYVjPmNCsZ8xoVjx4VjyLOJSoDCscxoVjmNCsZ8x4VjPmRZxKVAIVjx4VjPmNCscxoVjyDOJyoDCsZx4VjmNCseNCsZyLOJSoQsKxnHhWPGhWPGhWM4mzmKSoDCsePCsZ8xoVjONCseRZxKVAYVjPmNCscxoVjx4VjPmRZxOVAYVjmNCseNCsZ8x4VjmQZxKVAIVjPmPCsZxoVjxoVjyLOJSoDCscx4VjxoVjONCsZyLOJyoQsKx48Kx40KxnGhWM4mzmKSoDCsZ8x4VjPmNCseNCseRZxKVAYVjmNCscx4VjPmNCsZ8yDOJSoDCseNCsZ8xoVjmPCseRZxOVAYVjONCscxoVjxoVjORZxKVAYVjx4VjxoVjONCseRZxKVCGhWPGhWM+Y0KxnGhWPE2cxWVAYVjPmPCscxoVjxoVjPmRZxKVAYVjmNCsePCsZ8xoVjmQZxKVAYVjPmNCsZxoVjx4VjyLOJSoDCscxoVjxoVjONCsZyLOJyoDCsePCsZxoVjxoVjyLOJSof//Z';
const REAL_JPEG = Buffer.from(REAL_JPEG_BASE64, 'base64');
/** A header-only buffer, enough to exercise the media-type sniffing. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const noWait = (): Promise<void> => Promise.resolve();

const statusProtocol = new USyncStatusProtocol();

/**
 * Build the entry shape the installed `fetchStatus` really returns:
 * `USyncQuery.parse` emits `{ [protocolName]: parser(node), id }`.
 */
function usyncStatusList(text: string | null | undefined, atSeconds = 1_760_000_000) {
  const content = text === null || text === undefined ? undefined : Buffer.from(text, 'utf-8');
  const node: { tag: string; attrs: Record<string, string>; content?: Buffer } = {
    tag: 'status',
    attrs: { t: String(atSeconds) },
  };
  if (content) node.content = content;
  return [
    {
      id: '34600123456@s.whatsapp.net',
      status: statusProtocol.parser(node as never),
    },
  ];
}

function provider(overrides: Partial<OwnProfilePhotoProvider> = {}): OwnProfilePhotoProvider {
  return {
    isConnected: () => true,
    ownJid: () => '34600123456@s.whatsapp.net',
    accountName: () => 'Old Name',
    updateProfileName: async () => undefined,
    updateProfileStatus: async () => undefined,
    updateProfilePicture: async () => undefined,
    removeProfilePicture: async () => undefined,
    fetchStatus: async () => usyncStatusList('Available'),
    profilePictureIdentity: async () => 'picture-current',
    downloadProfilePhoto: async () => JPEG,
    ...overrides,
  };
}

test('own profile read exposes the name, the about and the live capabilities', async () => {
  const seen: string[] = [];
  const profile = await readOwnProfile(
    provider({
      fetchStatus: async jid => {
        seen.push(jid);
        return usyncStatusList('A trabajar', 1_758_355_200);
      },
    }),
    { sleep: noWait }
  );
  assert.equal(profile.jid, '34600123456@s.whatsapp.net');
  assert.equal(profile.phone, '34600123456');
  assert.equal(profile.name, 'Old Name');
  assert.equal(profile.about, 'A trabajar');
  assert.equal(profile.aboutSetAt, new Date(1_758_355_200 * 1000).toISOString());
  assert.deepEqual(profile.photo, { available: true });
  assert.deepEqual(profile.capabilities, {
    name: true,
    about: true,
    photo: true,
    photoRemove: true,
  });
  assert.deepEqual(seen, ['34600123456@s.whatsapp.net']);
});

test('the phone is only reported for a phone JID and never absorbs a device suffix', () => {
  assert.equal(phoneFromProfileJid('34600123456@s.whatsapp.net'), '34600123456');
  assert.equal(phoneFromProfileJid('34600123456:8@s.whatsapp.net'), '34600123456');
  assert.equal(phoneFromProfileJid('34600123456@c.us'), '34600123456');
  assert.equal(phoneFromProfileJid('156234567890123@lid'), null);
  assert.equal(phoneFromProfileJid('34600123456:8@lid'), null);
  assert.equal(phoneFromProfileJid('1234@g.us'), null);
  assert.equal(phoneFromProfileJid(''), null);
});

test('a photo lookup that cannot answer is unknown, not "no photo"', async () => {
  const profile = await readOwnProfile(
    provider({
      profilePictureIdentity: async () => {
        throw new Boom('timeout', { statusCode: 500 });
      },
    }),
    { sleep: noWait }
  );
  assert.equal(profile.photo.available, false);
  assert.equal(profile.photoKnown, false);
});

test('an unreadable about does not hide the rest of the profile', async () => {
  const profile = await readOwnProfile(
    provider({
      fetchStatus: async () => {
        throw new Boom('status query failed', { statusCode: 500 });
      },
    }),
    { sleep: noWait }
  );
  assert.equal(profile.about, null);
  assert.equal(profile.aboutKnown, false);
  assert.equal(profile.name, 'Old Name');
  assert.equal(profile.photo.available, true);
});

test('an unrecognised status payload is never read as an empty About', () => {
  assert.deepEqual(normalizeStatusReadResult([{ unexpected: true }]), {
    about: null,
    setAt: null,
    recognized: false,
  });
  assert.deepEqual(normalizeStatusReadResult([{ status: { text: 'x' } }]), {
    about: null,
    setAt: null,
    recognized: false,
  });
  assert.deepEqual(normalizeStatusReadResult(undefined), {
    about: null,
    setAt: null,
    recognized: false,
  });
  assert.deepEqual(normalizeStatusReadResult([{ status: null }]), {
    about: null,
    setAt: null,
    recognized: true,
  });
});

test('about readback tolerates the USync shapes Baileys actually returns', () => {
  assert.deepEqual(normalizeStatusReadResult([{ status: 'Hola', setAt: 1760000000 }]), {
    about: 'Hola',
    setAt: new Date(1760000000 * 1000).toISOString(),
    recognized: true,
  });
  assert.deepEqual(normalizeStatusReadResult([{ status: '  ', setAt: new Date(0) }]), {
    about: null,
    setAt: '1970-01-01T00:00:00.000Z',
    recognized: true,
  });
});

test('the real USync entry shape is parsed and a flat one still decodes', () => {
  const real = usyncStatusList('Original', 1_760_000_000);
  assert.deepEqual(normalizeStatusReadResult(real), {
    about: 'Original',
    setAt: new Date(1_760_000_000 * 1000).toISOString(),
    recognized: true,
  });
  assert.deepEqual(normalizeStatusReadResult(usyncStatusList(null)), {
    about: null,
    setAt: new Date(1_760_000_000 * 1000).toISOString(),
    recognized: true,
  });
  // Older builds surfaced the parser fields on the entry itself.
  assert.deepEqual(
    normalizeStatusReadResult([{ status: 'Plano', setAt: new Date('2026-09-10T00:00:00Z') }]),
    { about: 'Plano', setAt: '2026-09-10T00:00:00.000Z', recognized: true }
  );
});

test('a cleared about is only confirmed by a readback that recognised the answer', async () => {
  const cleared = await applyProfileUpdates(
    provider({
      updateProfileStatus: async () => undefined,
      fetchStatus: async () => usyncStatusList(''),
    }),
    { about: '' },
    { sleep: noWait }
  );
  assert.equal(cleared.about?.accepted, true);
  assert.equal(cleared.about?.confirmed, true);
  assert.equal(cleared.about?.reason, 'READBACK_MATCHED');

  const blind = await applyProfileUpdates(
    provider({
      updateProfileStatus: async () => undefined,
      fetchStatus: async () => [{ unexpected: true }],
    }),
    { about: '' },
    { sleep: noWait }
  );
  assert.equal(blind.about?.accepted, true);
  assert.equal(blind.about?.confirmed, false, 'an unreadable answer cannot confirm a clear');
  assert.match(blind.about?.reason || '', /READBACK_UNAVAILABLE/);
});

test('an About lookup timeout preserves the profile and an accepted write', async () => {
  let writes = 0;
  const slow = provider({
    fetchStatus: () => new Promise(() => {}),
    updateProfileStatus: async () => {
      writes += 1;
    },
  });
  const view = await readOwnProfile(slow, { timeoutMs: 5 });
  assert.equal(view.name, 'Old Name');
  assert.equal(view.aboutKnown, false);
  assert.equal(view.photoKnown, true);
  const result = await applyProfileUpdates(slow, { about: 'Available' }, { timeoutMs: 5 });
  assert.equal(writes, 1);
  assert.equal(result.about?.accepted, true);
  assert.equal(result.about?.confirmed, false);
  assert.match(result.about?.reason || '', /^READBACK_TIMEOUT/);
});

test('an About write timeout is still rejected without a readback', async () => {
  let reads = 0;
  await assert.rejects(
    applyProfileUpdates(
      provider({
        updateProfileStatus: () => new Promise(() => {}),
        fetchStatus: async () => {
          reads += 1;
          return usyncStatusList('Available');
        },
      }),
      { about: 'Available' },
      { timeoutMs: 5 }
    ),
    (error: unknown) => error instanceof ProfileError && error.code === 'PROFILE_UPSTREAM_TIMEOUT'
  );
  assert.equal(reads, 0);
});

test('an about that the provider wrote differently is reported as different', async () => {
  const result = await applyProfileUpdates(
    provider({
      updateProfileStatus: async () => undefined,
      fetchStatus: async () => usyncStatusList('Otra cosa'),
    }),
    { about: 'Lo que pedí' },
    { sleep: noWait }
  );
  assert.equal(result.about?.confirmed, false);
  assert.equal(result.about?.current, 'Otra cosa');
  assert.match(result.about?.reason || '', /READBACK_DIFFERS/);
});

test('a disconnected account refuses the read before touching the provider', async () => {
  let lookups = 0;
  await assert.rejects(
    readOwnProfile(
      provider({
        isConnected: () => false,
        fetchStatus: async () => {
          lookups += 1;
          return [];
        },
      }),
      { sleep: noWait }
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProfileError);
      assert.equal(error.code, 'PROFILE_DISCONNECTED');
      assert.equal(error.status, 503);
      return true;
    }
  );
  assert.equal(lookups, 0);
});

test('the display name is accepted even while the session has not refreshed it', async () => {
  const calls: string[] = [];
  const result = await applyProfileUpdates(
    provider({
      updateProfileName: async name => {
        calls.push(name);
      },
    }),
    { name: '  Nuevo   Nombre ' },
    { sleep: () => new Promise<void>(resolve => setTimeout(resolve, 1)) }
  );
  assert.deepEqual(calls, ['Nuevo Nombre']);
  assert.equal(result.name?.accepted, true);
  assert.equal(result.name?.confirmed, false);
  assert.equal(result.name?.current, 'Old Name');
  assert.match(result.name?.reason || '', /SESSION_NAME_NOT_REFRESHED/);
  assert.deepEqual(result.applied, ['name']);
  assert.equal(result.partial, false);
});

test('the display name is confirmed when the session refreshes within the readback window', async () => {
  let polls = 0;
  const result = await applyProfileUpdates(
    provider({
      accountName: () => (polls++ === 0 ? 'Old Name' : 'Nuevo Nombre'),
      updateProfileName: async () => undefined,
    }),
    { name: 'Nuevo Nombre' },
    { sleep: noWait }
  );
  assert.equal(result.name?.confirmed, true);
  assert.equal(result.name?.current, 'Nuevo Nombre');
});

test('a 26 character display name is rejected before the provider is called', async () => {
  let writes = 0;
  await assert.rejects(
    applyProfileUpdates(
      provider({
        updateProfileName: async () => {
          writes += 1;
        },
      }),
      { name: 'x'.repeat(26) },
      { sleep: noWait }
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProfileError);
      assert.equal(error.code, 'INVALID_PROFILE_INPUT');
      assert.equal(error.status, 400);
      return true;
    }
  );
  assert.equal(writes, 0);
});

test('a rejected name does not swallow an accepted about', async () => {
  const result = await applyProfileUpdates(
    provider({
      updateProfileName: async () => {
        throw new Boom('App state key not present!', { statusCode: 400 });
      },
      updateProfileStatus: async () => undefined,
      fetchStatus: async () => usyncStatusList('Nuevo about'),
    }),
    { name: 'Otro nombre', about: 'Nuevo about' },
    { sleep: noWait }
  );
  assert.deepEqual(result.applied, ['about']);
  assert.deepEqual(result.failed, ['name']);
  assert.equal(result.partial, true);
  assert.equal(result.name, undefined);
  assert.equal(result.about?.confirmed, true);
});

test('when every field fails the first provider error decides the status', async () => {
  await assert.rejects(
    applyProfileUpdates(
      provider({
        updateProfileName: async () => {
          throw new Boom('App state key not present!', { statusCode: 400 });
        },
        updateProfileStatus: async () => {
          throw new Boom('not authorized', { statusCode: 401 });
        },
      }),
      { name: 'Nombre', about: 'About' },
      { sleep: noWait }
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProfileError);
      assert.equal(error.code, 'PROFILE_APP_STATE_UNAVAILABLE');
      assert.equal(error.status, 409);
      return true;
    }
  );
});

test('a name and an about written together are read back field by field', async () => {
  const result = await applyProfileUpdates(
    provider({
      accountName: () => 'Nombre',
      fetchStatus: async () => usyncStatusList('About'),
    }),
    { name: 'Nombre', about: 'About' },
    { sleep: noWait }
  );
  assert.deepEqual(result.applied, ['name', 'about']);
  assert.equal(result.name?.confirmed, true);
  assert.equal(result.about?.confirmed, true);
});

test('the photo decoder only accepts a real JPEG, PNG or WebP payload', () => {
  assert.deepEqual(
    decodeProfilePhoto({ imageBase64: JPEG.toString('base64'), mimeType: 'image/jpeg' }),
    { bytes: JPEG, mimeType: 'image/jpeg' }
  );
  // A data: URL prefix is the shape the composer already produces.
  assert.equal(
    decodeProfilePhoto({
      imageBase64: `data:image/jpeg;base64,${JPEG.toString('base64')}`,
      mimeType: 'image/jpeg; charset=binary',
    }).mimeType,
    'image/jpeg'
  );
  const cases: Array<[unknown, string, RegExp, number]> = [
    [JPEG.toString('base64'), 'image/gif', /must be JPEG, PNG or WebP/, 400],
    [JPEG.toString('base64'), 'image/png', /does not match its media type/, 400],
    ['not base64 at all!!', 'image/jpeg', /not valid base64/, 400],
    ['', 'image/jpeg', /imageBase64 is required/, 400],
    [Buffer.alloc(9 * 1024 * 1024, 0xff).toString('base64'), 'image/jpeg', /exceeds 8 MB/, 413],
    [Buffer.alloc(32 * 1024 * 1024, 0xff).toString('base64'), 'image/jpeg', /too large/, 413],
  ];
  for (const [imageBase64, mimeType, expected, status] of cases) {
    assert.throws(
      () => decodeProfilePhoto({ imageBase64, mimeType }),
      (error: unknown) => {
        assert.ok(error instanceof ProfileError, `expected a ProfileError for ${mimeType}`);
        assert.equal(error.status, status);
        assert.match(error.message, expected);
        return true;
      }
    );
  }
  assert.deepEqual(decodeProfilePhoto({ imageBase64: REAL_JPEG_BASE64, mimeType: 'image/jpeg' }), {
    bytes: REAL_JPEG,
    mimeType: 'image/jpeg',
  });
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16, 7),
  ]);
  assert.equal(
    decodeProfilePhoto({ imageBase64: png.toString('base64'), mimeType: 'image/png' }).mimeType,
    'image/png'
  );
});

test('a platform without an image library reports it instead of a fake success', async () => {
  await assert.rejects(
    setOwnProfilePhoto(
      provider({
        updateProfilePicture: async () => {
          throw new Boom('No image processing library available', { statusCode: 500 });
        },
      }),
      { imageBase64: JPEG.toString('base64'), mimeType: 'image/jpeg' },
      { sleep: noWait }
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProfileError);
      assert.equal(error.code, 'PROFILE_PICTURE_PROCESSING_UNAVAILABLE');
      assert.equal(error.status, 501);
      return true;
    }
  );
});

test('an unchanged picture identity is not proof that a new photo is live', async () => {
  const written: Buffer[] = [];
  const result = await setOwnProfilePhoto(
    provider({
      profilePictureIdentity: async () => 'same-picture-id',
      updateProfilePicture: async (_jid, image) => {
        written.push(image);
      },
    }),
    { imageBase64: JPEG.toString('base64'), mimeType: 'image/jpeg' },
    { sleep: noWait }
  );
  assert.equal(written.length, 1);
  assert.equal(result.photo.accepted, true);
  assert.equal(result.photo.available, true);
  assert.equal(result.photo.confirmed, false, 'the same picture proves nothing');
  assert.match(result.photo.reason, /IDENTITY_UNCHANGED/);
});

test('a photo is confirmed when its identity really changed or appeared', async () => {
  let identity: string | null = 'old-picture';
  const changed = await setOwnProfilePhoto(
    provider({
      profilePictureIdentity: async () => identity,
      updateProfilePicture: async () => {
        identity = 'new-picture';
      },
    }),
    { imageBase64: JPEG.toString('base64'), mimeType: 'image/jpeg' },
    { sleep: noWait }
  );
  assert.deepEqual(changed.photo, {
    available: true,
    accepted: true,
    confirmed: true,
    reason: 'IDENTITY_CHANGED',
  });

  let appeared: string | null = null;
  const first = await setOwnProfilePhoto(
    provider({
      profilePictureIdentity: async () => appeared,
      updateProfilePicture: async () => {
        appeared = 'new-picture';
      },
    }),
    { imageBase64: JPEG.toString('base64'), mimeType: 'image/jpeg' },
    { sleep: noWait }
  );
  assert.equal(first.photo.confirmed, true);
  assert.equal(first.photo.available, true);
});

test('an identity provider that answers with nothing is unknown, not absent', async () => {
  const profile = await readOwnProfile(
    provider({ profilePictureIdentity: async () => undefined as unknown as string | null }),
    { sleep: noWait }
  );
  assert.equal(profile.photoKnown, false);
  assert.equal(profile.photo.available, false);
});

test('a photo whose previous identity could not be read stays unconfirmed', async () => {
  let lookups = 0;
  const result = await setOwnProfilePhoto(
    provider({
      profilePictureIdentity: async () => {
        lookups += 1;
        if (lookups === 1) throw new Boom('lookup failed', { statusCode: 500 });
        return 'new-picture';
      },
    }),
    { imageBase64: JPEG.toString('base64'), mimeType: 'image/jpeg' },
    { sleep: noWait }
  );
  assert.equal(result.photo.accepted, true);
  assert.equal(result.photo.confirmed, false);
  assert.match(result.photo.reason, /IDENTITY_UNKNOWN/);
});

test('a provider without the profile writers degrades to capabilities false and 501', async () => {
  const bare = provider({
    updateProfileName: undefined,
    updateProfileStatus: undefined,
    updateProfilePicture: undefined,
    removeProfilePicture: undefined,
    fetchStatus: undefined,
  });
  assert.deepEqual(profileCapabilities(bare), {
    name: false,
    about: false,
    photo: false,
    photoRemove: false,
  });
  const profile = await readOwnProfile(bare, { sleep: noWait });
  assert.equal(profile.aboutKnown, false);
  // Reading a photo and writing one are different abilities: this provider can
  // still report availability while it cannot change it.
  assert.equal(profile.photoKnown, true);
  assert.equal(profile.photo.available, true);
  for (const mutation of [
    applyProfileUpdates(bare, { name: 'x' }, { sleep: noWait }),
    setOwnProfilePhoto(
      bare,
      { imageBase64: JPEG.toString('base64'), mimeType: 'image/jpeg' },
      { sleep: noWait }
    ),
    removeOwnProfilePhoto(bare, { sleep: noWait }),
    readOwnProfilePhotoBytes(provider({ downloadProfilePhoto: undefined }), { sleep: noWait }),
  ]) {
    await assert.rejects(mutation, (error: unknown) => {
      assert.ok(error instanceof ProfileError);
      assert.equal(error.code, 'PROFILE_PROVIDER_UNAVAILABLE');
      assert.equal(error.status, 501);
      return true;
    });
  }
});

test('removing a photo reports the readback it actually observed', async () => {
  const stuck = await removeOwnProfilePhoto(
    provider({ profilePictureIdentity: async () => 'still-there' }),
    { sleep: noWait }
  );
  assert.deepEqual(stuck.photo, {
    available: true,
    accepted: true,
    confirmed: false,
    reason: 'READBACK_DIFFERS: WhatsApp still reports a profile photo',
  });
  const clean = await removeOwnProfilePhoto(
    provider({ profilePictureIdentity: async () => null }),
    { sleep: noWait }
  );
  assert.deepEqual(clean.photo, {
    available: false,
    accepted: true,
    confirmed: true,
    reason: 'READBACK_REMOVED',
  });
});

// --- Baileys adapter -------------------------------------------------------
// These are the guards against trusting the published types: the adapter only
// advertises what the installed socket really exposes.

function clientWithSocket(socket: Record<string, unknown>): BaileysClient {
  const client = new BaileysClient('/tmp/unused-profile-service-session', 'test-key');
  (client as unknown as { ready: boolean }).ready = true;
  (client as unknown as { sock: Record<string, unknown> | null }).sock = socket;
  return client;
}

test('the adapter reads the own profile through the socket methods that exist', async () => {
  const calls: string[] = [];
  const client = clientWithSocket({
    user: { id: '34600123456:12@s.whatsapp.net', name: 'Daniel' },
    authState: { creds: { me: { id: '34600123456:12@s.whatsapp.net', name: 'Daniel' } } },
    fetchStatus: async (jid: string) => {
      calls.push(`status:${jid}`);
      return usyncStatusList('Disponible', 1_758_771_600);
    },
    profilePictureUrl: async (jid: string) => {
      calls.push(`pic:${jid}`);
      return 'https://mmwebwhaecxzf.fbcdn.net/v/t39.3436-2/one.jpg?oe=EXPIRING_TOKEN';
    },
    updateProfileStatus: async () => undefined,
    updateProfilePicture: async () => undefined,
    removeProfilePicture: async () => undefined,
  });
  const profile = await client.getOwnProfile();
  // The socket is addressed with the raw JID while the API answers with the
  // `@c.us` shape every other connector route returns.
  assert.equal(profile.jid, '34600123456@c.us');
  assert.equal(profile.phone, '34600123456');
  assert.equal(profile.name, 'Daniel');
  assert.equal(profile.about, 'Disponible');
  assert.equal(profile.photo.available, true);
  assert.equal(profile.aboutSetAt, new Date(1_758_771_600 * 1000).toISOString());
  assert.equal(profile.capabilities.name, false, 'this socket has no updateProfileName');
  assert.equal(profile.capabilities.about, true);
  assert.deepEqual(calls, ['status:34600123456@s.whatsapp.net', 'pic:34600123456@s.whatsapp.net']);
});

test('the photo identity ignores the rotating CDN token', async () => {
  let url = 'https://mmwebwhaecxzf.fbcdn.net/v/t39.3436-2/one.jpg?oe=AAA';
  const client = clientWithSocket({
    user: { id: '34600123456@s.whatsapp.net', name: 'Daniel' },
    authState: { creds: { me: { id: '34600123456@s.whatsapp.net' } } },
    fetchStatus: async () => usyncStatusList('x'),
    profilePictureUrl: async () => url,
    updateProfilePicture: async () => undefined,
  });
  const first = await client
    .ownProfileProvider()
    .profilePictureIdentity?.('34600123456@s.whatsapp.net');
  url = 'https://mmwebwhaecxzf.fbcdn.net/v/t39.3436-2/one.jpg?oe=BBB';
  const second = await client
    .ownProfileProvider()
    .profilePictureIdentity?.('34600123456@s.whatsapp.net');
  assert.equal(first, second);
  assert.match(String(first), /^[a-f0-9]{64}$/);
});

test('the installed provider can really re-encode the fixture as a profile picture', async () => {
  // This is the capability the photo button depends on: Baileys re-encodes the
  // upload through sharp or jimp. Without either it throws, and the API has to
  // answer 501 rather than pretend the photo was set.
  const { generateProfilePicture } = await import('@whiskeysockets/baileys');
  let encoded: Buffer;
  try {
    encoded = (await generateProfilePicture(REAL_JPEG)).img;
  } catch (error) {
    const mapped = mapProfileProviderError(error, 'profile photo update');
    assert.equal(mapped.code, 'PROFILE_PICTURE_PROCESSING_UNAVAILABLE');
    throw new Error(
      'this platform has no image processing library, so the profile photo cannot be offered'
    );
  }
  assert.ok(Buffer.isBuffer(encoded));
  assert.equal(encoded.subarray(0, 3).toString('hex'), 'ffd8ff', 'a JPEG must come back');
  assert.ok(encoded.length > 512, `re-encoded picture looks too small (${encoded.length} bytes)`);
});

test('a refused own-picture lookup stays unknown instead of proving absence', async () => {
  const denied = clientWithSocket({
    user: { id: '34600123456@s.whatsapp.net', name: 'Daniel' },
    authState: { creds: { me: { id: '34600123456@s.whatsapp.net' } } },
    fetchStatus: async () => usyncStatusList('x'),
    profilePictureUrl: async () => {
      throw new Boom('Forbidden', { statusCode: 403 });
    },
    removeProfilePicture: async () => undefined,
  });
  await assert.rejects(
    denied.ownProfileProvider().profilePictureIdentity?.('34600123456@s.whatsapp.net') as Promise<
      string | null
    >,
    (error: unknown) => {
      assert.match(String((error as Error).message), /Forbidden|timed out/);
      return true;
    }
  );
  const removal = await denied.removeOwnProfilePhoto();
  assert.equal(removal.photo.accepted, true);
  assert.equal(removal.photo.confirmed, false, 'a 403 cannot confirm a removal');
  assert.match(removal.photo.reason, /READBACK_UNAVAILABLE/);
  assert.equal((await denied.getOwnProfile()).photoKnown, false);

  const absent = clientWithSocket({
    user: { id: '34600123456@s.whatsapp.net', name: 'Daniel' },
    authState: { creds: { me: { id: '34600123456@s.whatsapp.net' } } },
    fetchStatus: async () => usyncStatusList('x'),
    profilePictureUrl: async () => {
      throw new Boom('Not Found', { statusCode: 404 });
    },
    removeProfilePicture: async () => undefined,
  });
  const profile = await absent.getOwnProfile();
  assert.equal(profile.photoKnown, true, 'a 404 is an answer: the account has no picture');
  assert.equal(profile.photo.available, false);
  const removed = await absent.removeOwnProfilePhoto();
  assert.equal(removed.photo.confirmed, true);
});

test('a socket without the profile writers cannot mutate the profile', async () => {
  const client = clientWithSocket({
    user: { id: '34600123456@s.whatsapp.net', name: 'Daniel' },
    authState: { creds: { me: { id: '34600123456@s.whatsapp.net' } } },
  });
  await assert.rejects(client.updateOwnProfile({ name: 'Otro' }), (error: unknown) => {
    assert.ok(error instanceof ProfileError);
    assert.equal(error.code, 'PROFILE_PROVIDER_UNAVAILABLE');
    return true;
  });
  const profile = await client.getOwnProfile();
  assert.deepEqual(profile.capabilities, {
    name: false,
    about: false,
    photo: false,
    photoRemove: false,
  });
  assert.equal(profile.photoKnown, false, 'no profilePictureUrl means no photo knowledge');
});
