import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BaileysClient } from './baileys-client';

test('archive sync shares one request per socket and starts fresh after reconnect', async () => {
  const client = new BaileysClient('/tmp/unused', 'key') as any;
  const firstSocket = {};
  const nextSocket = {};
  client.sock = firstSocket;
  client.ready = true;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let calls = 0;
  client.performArchiveSnapshotSync = async () => {
    calls++;
    if (calls === 1) await firstGate;
    return { version: calls, records: 1, chats: 1, archived: 1, created: 0 };
  };
  const first = client.syncArchiveSnapshot();
  const duplicate = client.syncArchiveSnapshot();
  assert.equal(first, duplicate);
  assert.equal(calls, 1);
  client.sock = nextSocket;
  const afterReconnect = client.syncArchiveSnapshot();
  assert.equal(calls, 1);
  releaseFirst();
  assert.equal((await first).version, 1);
  assert.equal((await afterReconnect).version, 2);
  assert.equal(calls, 2);
});
