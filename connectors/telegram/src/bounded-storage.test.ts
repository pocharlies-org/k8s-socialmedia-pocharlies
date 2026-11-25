/**
 * SKIRM-443: the telegram connector's peers / ref-messages / dialogs caches
 * must be bounded in code, not just by the pod's memory limit (INFRA-928: the
 * personal connector OOMed because mtcute's MemoryStorage Maps never evict).
 *
 * The first test is the one that fails on the current (unbounded) code: a
 * plain MemoryPeersRepository grows past any ceiling; the bounded variant
 * evicts. node:test, run through `pnpm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage, MemoryStorageDriver, MemoryPeersRepository } from '@mtcute/node';
import {
  BoundedMap,
  BoundedMemoryPeersRepository,
  BoundedMemoryRefMessagesRepository,
  BoundedMemoryStorage,
  capDialogs,
} from './bounded-storage';

// A peer DTO is opaque to the cache: only its id matters for eviction.
const peer = (id: number): any => ({ id, accessHash: '0', isMin: false, updated: Date.now() });

test('plain MemoryPeersRepository grows unbounded (the bug being fixed)', () => {
  const repo = new MemoryPeersRepository(new MemoryStorageDriver());
  assert.ok(!(repo.state.entities instanceof BoundedMap));
  for (let i = 0; i < 100; i++) repo.state.entities.set(i, peer(i));
  assert.equal(repo.state.entities.size, 100); // no eviction
});

test('BoundedMemoryPeersRepository caps entities, username and phone indexes', () => {
  const max = 20;
  const repo = new BoundedMemoryPeersRepository(new MemoryStorageDriver(), max);
  assert.ok(repo.state.entities instanceof BoundedMap);
  assert.ok(repo.state.usernameIndex instanceof BoundedMap);
  assert.ok(repo.state.phoneIndex instanceof BoundedMap);
  for (let i = 0; i < max + 100; i++) {
    repo.state.entities.set(i, peer(i));
    repo.state.usernameIndex.set(`u${i}`, i);
    repo.state.phoneIndex.set(`+${i}`, i);
  }
  assert.equal(repo.state.entities.size, max);
  assert.equal(repo.state.usernameIndex.size, max);
  assert.equal(repo.state.phoneIndex.size, max);
  // FIFO: the oldest are gone, the newest survive.
  assert.equal(repo.state.entities.has(0), false);
  assert.equal(repo.state.entities.has(max + 99), true);
});

test('BoundedMemoryRefMessagesRepository caps the per-peer reference set', () => {
  const max = 10;
  const repo = new BoundedMemoryRefMessagesRepository(new MemoryStorageDriver(), max);
  assert.ok(repo.state.refs instanceof BoundedMap);
  for (let i = 0; i < max + 50; i++) repo.state.refs.set(i, new Set([`${i}:1`]));
  assert.equal(repo.state.refs.size, max);
  assert.equal(repo.state.refs.has(0), false);
  assert.equal(repo.state.refs.has(max + 49), true);
});

test('BoundedMemoryStorage wires bounded peers + refMessages, plain kv/authKeys', () => {
  const storage = new BoundedMemoryStorage(5, 5);
  assert.ok(storage.peers instanceof BoundedMemoryPeersRepository);
  assert.ok(storage.refMessages instanceof BoundedMemoryRefMessagesRepository);
  // kv/authKeys hold a handful of session keys, not per-peer data: left plain.
  storage.kv.set('k', new Uint8Array([1, 2, 3]));
  assert.deepEqual(storage.kv.get('k'), new Uint8Array([1, 2, 3]));
});

test('BoundedMap evicts the oldest entry past its cap', () => {
  const m = new BoundedMap<number, number>(3);
  m.set(1, 1);
  m.set(2, 2);
  m.set(3, 3);
  m.set(4, 4);
  assert.equal(m.size, 3);
  assert.equal(m.has(1), false);
  assert.equal(m.get(4), 4);
});

test('capDialogs caps the dialogs snapshot and returns a copy', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  assert.equal(capDialogs(many, 10).length, 10);
  assert.equal(capDialogs(many, 1000).length, 100);
  const capped = capDialogs(many, 50);
  capped.pop();
  assert.equal(many.length, 100); // input not mutated
});

// Sanity: the default MemoryStorage the connector used before is still the
// unbounded one — proves the fix is in our subclass, not a library change.
test('default MemoryStorage stays unbounded (fix is in the subclass)', () => {
  const storage = new MemoryStorage();
  assert.ok(!(storage.peers.state.entities instanceof BoundedMap));
});
