import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DedupCache } from './dedup';

test('first sight is a miss, immediate re-sight is a hit', () => {
  const d = new DedupCache(1000, 100);
  assert.equal(d.has('M1'), false, 'first sight should be a miss');
  assert.equal(d.has('M1'), true, 'second sight should be a hit');
  assert.equal(d.has('M2'), false, 'a different id is a miss');
});

test('entries expire after TTL', () => {
  let now = 1_000_000;
  const d = new DedupCache(5000, 100, () => now);
  assert.equal(d.has('M1'), false); // recorded at t=1_000_000
  now += 4999;
  assert.equal(d.has('M1'), true, 'still within TTL => hit');
  // The hit above refreshes recency to now (1_004_999). Advance past TTL.
  now += 5001;
  assert.equal(d.has('M1'), false, 'past TTL => miss (expired)');
});

test('empty key never dedups (filter handles missing id)', () => {
  const d = new DedupCache(1000, 100);
  assert.equal(d.has(''), false);
  assert.equal(d.has(''), false);
});

test('exceeding maxEntries evicts the oldest', () => {
  let now = 0;
  const d = new DedupCache(1_000_000, 3, () => now);
  d.has('A'); now += 1;
  d.has('B'); now += 1;
  d.has('C'); now += 1;
  // size at cap (3); inserting D evicts the oldest (A).
  d.has('D');
  assert.equal(d.size(), 3, 'cap holds at maxEntries after overflow');
  // Probe the survivors first: each survivor probe is a hit and refreshes
  // recency (it does not grow the set). B, C, D were the last three inserted.
  assert.equal(d.has('B'), true, 'B survives');
  assert.equal(d.has('C'), true, 'C survives');
  assert.equal(d.has('D'), true, 'D survives');
  // A was the oldest and must have been evicted: its first re-probe is a miss.
  // (That miss re-records A and would now evict the next-oldest — which is why
  // we asserted the survivors BEFORE touching A.)
  assert.equal(d.has('A'), false, 'A was evicted (oldest), so it is a miss');
});

test('size() reflects live entries after expiry', () => {
  let now = 0;
  const d = new DedupCache(1000, 100, () => now);
  d.has('A');
  d.has('B');
  assert.equal(d.size(), 2);
  now += 2000;
  assert.equal(d.size(), 0, 'all expired');
});
