/** Load the installed patch and build one timestamped profile-picture token. */
export async function profilePictureQueryFixture() {
  const moduleRoot = '@whiskeysockets/baileys/lib';
  const chats = await import(`${moduleRoot}/Socket/chats.js`);
  const tokens = await import(`${moduleRoot}/Utils/tc-token-utils.js`);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const jid = '34600@s.whatsapp.net';
  const token = Buffer.from([4, 1, 33]);
  const tcTokenContent = await tokens.buildTcTokenFromJid({
    jid,
    getLIDForPN: async () => null,
    authState: { keys: { get: async () => ({ [jid]: { token, timestamp } }) } },
  });
  return {
    buildProfilePictureQueryContent: chats.buildProfilePictureQueryContent,
    buildTcTokenFromJid: tokens.buildTcTokenFromJid,
    timestamp,
    jid,
    token,
    tcTokenContent,
  };
}

/** Both public clients must distinguish provider timeouts from unavailable photos. */
export async function assertProfilePictureFailures(
  client: Pick<BaileysClient, 'getProfilePictureBytes'>,
  unavailableCodes: readonly number[]
): Promise<void> {
  const timeouts: number[] = [];
  const sock = {
    profilePictureUrl: async (_jid: string, _type: string, timeout: number): Promise<string> => {
      timeouts.push(timeout);
      throw new Boom('provider timeout', { statusCode: 408 });
    },
  };
  Object.assign(client, { sock });
  await assert.rejects(client.getProfilePictureBytes('34600@c.us'), ProfilePictureTimeoutError);
  assert.deepEqual(timeouts, [8000]);
  for (const statusCode of unavailableCodes) {
    sock.profilePictureUrl = async () => {
      throw new Boom('photo unavailable', { statusCode });
    };
    assert.equal(await client.getProfilePictureBytes('34600@c.us'), null);
  }
}

/** Assert the patched wire shapes once while retaining each caller's scenario. */
export async function assertTimestampedPictureQuery() {
  const fixture = await profilePictureQueryFixture();
  const { buildProfilePictureQueryContent, tcTokenContent, timestamp, token } = fixture;
  assert.deepEqual(buildProfilePictureQueryContent('image', tcTokenContent), [
    {
      tag: 'picture',
      attrs: { type: 'image', query: 'url' },
      content: [{ tag: 'tctoken', attrs: { t: timestamp }, content: token }],
    },
  ]);
  assert.deepEqual(buildProfilePictureQueryContent('preview'), [
    { tag: 'picture', attrs: { type: 'preview', query: 'url' } },
  ]);
  return fixture;
}
import assert from 'node:assert/strict';
import { Boom } from '@hapi/boom';
import { ProfilePictureTimeoutError, type BaileysClient } from '../baileys-client';
