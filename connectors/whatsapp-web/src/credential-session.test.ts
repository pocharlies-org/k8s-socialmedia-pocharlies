/**
 * SC-705 phase 1.5: connector-side credential-session wiring against a fake
 * store (node:test, run through the connector's `pnpm test`). The encryption
 * itself is specced under the mcp-server jest harness; here the contract is
 * the load/write-back choreography the connector depends on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CredentialChannel,
  CredentialStore,
  StoredCredential,
} from '@mcp-socialmedia/shared';
import {
  createCredentialWriteBack,
  credentialSessionKeyFromEnv,
  loadCredentialSession,
  sessionPathForSub,
} from './credential-session';

class FakeStore implements CredentialStore {
  rows = new Map<string, StoredCredential>();
  puts: { key: string; channel: CredentialChannel; payload: Record<string, unknown> }[] = [];
  putError: Error | null = null;

  async get(sessionKey: string, channel: CredentialChannel): Promise<StoredCredential | null> {
    return this.rows.get(`${sessionKey}/${channel}`) ?? null;
  }
  async put(
    sessionKey: string,
    channel: CredentialChannel,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (this.putError) throw this.putError;
    this.puts.push({ key: sessionKey, channel, payload });
    this.rows.set(`${sessionKey}/${channel}`, {
      sessionKey,
      channel,
      payload,
      updatedAt: new Date(),
    });
  }
  async delete(sessionKey: string, channel: CredentialChannel): Promise<void> {
    this.rows.delete(`${sessionKey}/${channel}`);
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('credentialSessionKeyFromEnv: flag off or key unset → null (legacy path)', () => {
  assert.equal(credentialSessionKeyFromEnv({}), null);
  assert.equal(credentialSessionKeyFromEnv({ CREDENTIAL_STORE_ENABLED: 'true' }), null);
  assert.equal(
    credentialSessionKeyFromEnv({
      CREDENTIAL_STORE_ENABLED: 'false',
      CREDENTIAL_SESSION_KEY: 'e51253a7-9e1b-4f4a-9a1d-0f2b3c4d5e6f',
    }),
    null
  );
});

test('credentialSessionKeyFromEnv: sub and sub:account accepted, traversal rejected', () => {
  const env = { CREDENTIAL_STORE_ENABLED: 'true' };
  assert.equal(
    credentialSessionKeyFromEnv({ ...env, CREDENTIAL_SESSION_KEY: 'e51253a7-9e1b-4f4a-9a1d-0f2b3c4d5e6f' }),
    'e51253a7-9e1b-4f4a-9a1d-0f2b3c4d5e6f'
  );
  assert.equal(
    credentialSessionKeyFromEnv({ ...env, CREDENTIAL_SESSION_KEY: 'e51253a7:professional' }),
    'e51253a7:professional'
  );
  assert.throws(
    () => credentialSessionKeyFromEnv({ ...env, CREDENTIAL_SESSION_KEY: '../../etc' }),
    /CREDENTIAL_SESSION_KEY/
  );
  assert.throws(
    () => credentialSessionKeyFromEnv({ ...env, CREDENTIAL_SESSION_KEY: 'a/b' }),
    /CREDENTIAL_SESSION_KEY/
  );
});

test('sessionPathForSub indexes the session dir by sub', () => {
  assert.equal(
    sessionPathForSub('/app/persistent-session', 'sub-1'),
    join('/app/persistent-session', 'by-sub', 'sub-1')
  );
});

test('loadCredentialSession: no row → fresh; row → applied into the auth dir', async () => {
  const store = new FakeStore();
  const authDir = await mkdtemp(join(tmpdir(), 'cred-fresh-'));
  assert.equal(await loadCredentialSession(store, 'sub-1', authDir), 'fresh');

  store.rows.set('sub-2/whatsapp', {
    sessionKey: 'sub-2',
    channel: 'whatsapp',
    payload: { files: { 'creds.json': Buffer.from('{"a":1}').toString('base64') } },
    updatedAt: new Date(),
  });
  const dst = await mkdtemp(join(tmpdir(), 'cred-load-'));
  assert.equal(await loadCredentialSession(store, 'sub-2', dst), 'loaded');
  assert.equal(await readFile(join(dst, 'creds.json'), 'utf-8'), '{"a":1}');
});

test('write-back: saveCreds bursts coalesce into serialized puts of the auth dir', async () => {
  const store = new FakeStore();
  const authDir = await mkdtemp(join(tmpdir(), 'cred-wb-'));
  await writeFile(join(authDir, 'creds.json'), 'first');

  const wb = createCredentialWriteBack(store, 'sub-1', authDir, () => {}, 10);
  wb.schedule();
  await writeFile(join(authDir, 'session-1'), 'second');
  wb.schedule(); // burst: only the trailing run must hit the store
  await wb.flush();

  assert.equal(store.puts.length, 1);
  assert.equal(store.puts[0].key, 'sub-1');
  assert.equal(store.puts[0].channel, 'whatsapp');
  const files = (store.puts[0].payload as { files: Record<string, string> }).files;
  assert.equal(Buffer.from(files['creds.json'], 'base64').toString(), 'first');
  assert.equal(Buffer.from(files['session-1'], 'base64').toString(), 'second');
});

test('write-back: a put scheduled mid-flight runs a trailing put (last saveCreds lands)', async () => {
  const store = new FakeStore();
  const authDir = await mkdtemp(join(tmpdir(), 'cred-wb2-'));
  await writeFile(join(authDir, 'creds.json'), 'v1');

  const wb = createCredentialWriteBack(store, 'sub-1', authDir, () => {}, 0);
  wb.schedule();
  await sleep(1); // fire the first put
  await writeFile(join(authDir, 'creds.json'), 'v2');
  wb.schedule(); // lands while the first put is still in flight
  await wb.flush();

  assert.equal(store.puts.length >= 2, true);
  const last = store.puts[store.puts.length - 1];
  const files = (last.payload as { files: Record<string, string> }).files;
  assert.equal(Buffer.from(files['creds.json'], 'base64').toString(), 'v2');
});

test('write-back: store failures log and never throw into the socket handler', async () => {
  const store = new FakeStore();
  store.putError = new Error('db down');
  const authDir = await mkdtemp(join(tmpdir(), 'cred-wb3-'));
  await writeFile(join(authDir, 'creds.json'), 'x');

  const errors: string[] = [];
  const wb = createCredentialWriteBack(store, 'sub-1', authDir, m => errors.push(m), 0);
  wb.schedule();
  await wb.flush(); // must not reject

  assert.equal(errors.length, 1);
  assert.match(errors[0], /db down/);
});

test('write-back: empty auth dir still round-trips through serialize (fresh pairing dir)', async () => {
  const store = new FakeStore();
  const authDir = await mkdtemp(join(tmpdir(), 'cred-wb4-'));
  await mkdir(join(authDir, 'nested-ignored'), { recursive: true });

  const wb = createCredentialWriteBack(store, 'sub-1', authDir, () => {}, 0);
  wb.schedule();
  await wb.flush();

  assert.equal(store.puts.length, 1);
  assert.deepEqual((store.puts[0].payload as { files: Record<string, string> }).files, {});
});
