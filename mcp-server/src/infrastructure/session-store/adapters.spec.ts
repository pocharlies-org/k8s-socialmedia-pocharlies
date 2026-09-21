import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyBaileysAuthDir,
  deserializeBaileysAuthPayload,
  serializeBaileysAuthDir,
} from '@mcp-socialmedia/shared';
import { deserializeMtcuteSession, serializeMtcuteSession } from '@mcp-socialmedia/shared';
import {
  deserializeInstagramToken,
  serializeInstagramToken,
} from '@mcp-socialmedia/shared';

describe('SC-552 baileys auth-state adapter', () => {
  test('round-trips a multi-file auth dir byte-for-byte (incl. binary)', async () => {
    const src = await mkdtemp(join(tmpdir(), 'baileys-src-'));
    const dst = await mkdtemp(join(tmpdir(), 'baileys-dst-'));
    await writeFile(join(src, 'creds.json'), JSON.stringify({ noiseKey: 'abc' }));
    await writeFile(join(src, 'session-1234'), Buffer.from([0, 1, 2, 250, 255]));
    await mkdir(join(src, 'ignored-subdir'));

    const payload = await serializeBaileysAuthDir(src);
    expect(Object.keys(payload.files).sort()).toEqual(['creds.json', 'session-1234']);

    await applyBaileysAuthDir(payload, dst);
    expect(await readFile(join(dst, 'creds.json'), 'utf-8')).toBe(
      JSON.stringify({ noiseKey: 'abc' })
    );
    expect(await readFile(join(dst, 'session-1234'))).toEqual(Buffer.from([0, 1, 2, 250, 255]));
  });

  test('rejects payloads with path-traversal file names', async () => {
    const dst = await mkdtemp(join(tmpdir(), 'baileys-dst-'));
    expect(() => deserializeBaileysAuthPayload({ files: { '../evil': 'eA==' } })).toThrow(
      /unsafe file name/
    );
    await expect(applyBaileysAuthDir({ files: { 'a/../../evil': 'eA==' } }, dst)).rejects.toThrow(
      /unsafe file name/
    );
    expect(() => deserializeBaileysAuthPayload({})).toThrow(/missing `files`/);
  });
});

describe('SC-552 mtcute session adapter', () => {
  test('round-trips the session string', () => {
    const payload = serializeMtcuteSession('1.2.3 ABCdef==');
    expect(payload).toEqual({ sessionString: '1.2.3 ABCdef==' });
    expect(deserializeMtcuteSession(payload).sessionString).toBe('1.2.3 ABCdef==');
  });

  test('rejects empty/invalid payloads', () => {
    expect(() => serializeMtcuteSession('')).toThrow(/empty session string/);
    expect(() => deserializeMtcuteSession({ sessionString: '  ' })).toThrow(
      /missing `sessionString`/
    );
    expect(() => deserializeMtcuteSession(undefined)).toThrow(/missing `sessionString`/);
  });
});

describe('SC-552 instagram token adapter', () => {
  test('round-trips token + ids, keeping optional fields', () => {
    const payload = serializeInstagramToken({
      accessToken: 'EAAB…',
      businessAccountId: '17841400000000000',
      fbAccessToken: 'fb-token',
    });
    expect(payload).toEqual({
      accessToken: 'EAAB…',
      businessAccountId: '17841400000000000',
      fbAccessToken: 'fb-token',
    });
    expect(deserializeInstagramToken(payload)).toEqual(payload);
  });

  test('rejects payloads without accessToken/businessAccountId', () => {
    expect(() => deserializeInstagramToken({ businessAccountId: '1' })).toThrow(
      /missing `accessToken`/
    );
    expect(() => deserializeInstagramToken({ accessToken: 'x' })).toThrow(
      /missing `businessAccountId`/
    );
    expect(() => serializeInstagramToken({ accessToken: ' ', businessAccountId: '1' })).toThrow(
      /empty access token/
    );
  });
});
