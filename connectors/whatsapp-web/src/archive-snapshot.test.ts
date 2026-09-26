import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readArchiveSnapshot, readCurrentArchiveSnapshot } from './archive-snapshot';

test('archive bootstrap requests a read-only snapshot and keeps current archive decisions', async () => {
  let request: any;
  let setCalled = false;
  const socket = {
    query: async (node: any) => { request = node; return {} as any; },
    authState: { keys: {
      get: async () => ({}),
      set: async () => { setCalled = true; },
    } },
  } as unknown as Parameters<typeof readArchiveSnapshot>[0];
  const deps = {
    extract: async () => ({ regular_low: { snapshot: {}, patches: [], hasMorePatches: false } }),
    decode: async () => ({ state: { version: 42 }, mutationMap: {
      first: { index: ['archive', '123@g.us'], syncAction: { value: { archiveChatAction: { archived: true } } } },
      second: { index: ['archive', '456@s.whatsapp.net'], syncAction: { value: { archiveChatAction: { archived: false } } } },
      ignored: { index: ['archive', 'status@broadcast'], syncAction: { value: { archiveChatAction: { archived: true } } } },
    } }),
  } as unknown as Parameters<typeof readArchiveSnapshot>[1];

  const result = await readArchiveSnapshot(socket, deps);
  assert.deepEqual(request.content[0].content[0].attrs, {
    name: 'regular_low', version: '0', return_snapshot: 'true',
  });
  assert.deepEqual([...result.states], [
    ['123@g.us', true], ['456@s.whatsapp.net', false],
  ]);
  assert.equal(result.records, 3);
  assert.equal(setCalled, false);
});

test('archive bootstrap refuses partial snapshots', async () => {
  let requests = 0;
  const socket = {
    query: async () => { requests++; return {} as any; },
    authState: { keys: { get: async () => ({}) } },
  } as unknown as Parameters<typeof readArchiveSnapshot>[0];
  const deps = {
    extract: async () => ({ regular_low: { snapshot: requests === 1 ? {} : undefined, patches: [], hasMorePatches: true } }),
    decode: async () => ({ state: { version: 1 }, mutationMap: {} }),
  } as unknown as Parameters<typeof readArchiveSnapshot>[1];
  await assert.rejects(readArchiveSnapshot(socket, deps), /Complete WhatsApp archive snapshot is unavailable/);
  assert.equal(requests, 16);
});

test('later archive patch overrides the snapshot state', async () => {
  let requests = 0;
  const socket = {
    query: async () => { requests++; return {} as any; },
    authState: { keys: { get: async () => ({}) } },
  } as unknown as Parameters<typeof readArchiveSnapshot>[0];
  const deps = {
    extract: async () => ({ regular_low: requests === 1
      ? { snapshot: {}, patches: [], hasMorePatches: true }
      : { patches: [{}], hasMorePatches: false } }),
    decode: async () => ({ state: { version: 10 }, mutationMap: {
      archived: { index: ['archive', '123@g.us'], syncAction: { value: { archiveChatAction: { archived: true } } } },
    } }),
    decodePatches: async () => ({ state: { version: 11 }, mutationMap: {
      unarchived: { index: ['unarchive', '123@g.us'], syncAction: { value: { archiveChatAction: { archived: false } } } },
    } }),
  } as unknown as Parameters<typeof readArchiveSnapshot>[1];
  const result = await readArchiveSnapshot(socket, deps);
  assert.equal(requests, 2);
  assert.equal(result.version, 11);
  assert.equal(result.states.get('123@g.us'), false);
});

test('rejects a snapshot whose decoder skipped records', async () => {
  const socket = {
    query: async () => ({} as any),
    authState: { keys: { get: async () => ({}) } },
  } as unknown as Parameters<typeof readArchiveSnapshot>[0];
  const deps = {
    extract: async () => ({ regular_low: {
      snapshot: { records: [{}, {}] }, patches: [], hasMorePatches: false,
    } }),
    decode: async () => ({ state: { version: 1, indexValueMap: { one: {} } }, mutationMap: {} }),
  } as unknown as Parameters<typeof readArchiveSnapshot>[1];
  await assert.rejects(readArchiveSnapshot(socket, deps), /Complete WhatsApp archive snapshot is unavailable/);
});

test('rejects a snapshot after decoder reports a MAC warning', async () => {
  const socket = {
    query: async () => ({} as any),
    authState: { keys: { get: async () => ({}) } },
  } as unknown as Parameters<typeof readArchiveSnapshot>[0];
  const deps = {
    extract: async () => ({ regular_low: { snapshot: {}, patches: [], hasMorePatches: false } }),
    decode: async (_name: unknown, _snapshot: unknown, _key: unknown, _min: unknown,
      _verify: unknown, logger: { warn: () => void }) => {
      logger.warn();
      return { state: { version: 1 }, mutationMap: {} };
    },
  } as unknown as Parameters<typeof readArchiveSnapshot>[1];
  await assert.rejects(readArchiveSnapshot(socket, deps), /Complete WhatsApp archive snapshot is unavailable/);
});

test('refuses to persist a snapshot read from a replaced socket', async () => {
  const replacement = {} as Parameters<typeof readCurrentArchiveSnapshot>[0];
  let current: Parameters<typeof readCurrentArchiveSnapshot>[0] | null = null;
  const original = {
    query: async () => {
      current = replacement;
      return {} as any;
    },
    authState: { keys: { get: async () => ({}) } },
  } as unknown as Parameters<typeof readCurrentArchiveSnapshot>[0];
  current = original;
  const deps = {
    extract: async () => ({ regular_low: { snapshot: {}, patches: [], hasMorePatches: false } }),
    decode: async () => ({ state: { version: 1 }, mutationMap: {} }),
  } as unknown as Parameters<typeof readCurrentArchiveSnapshot>[2];
  await assert.rejects(readCurrentArchiveSnapshot(original, () => current, deps),
    /WhatsApp socket changed during archive snapshot/);
});
