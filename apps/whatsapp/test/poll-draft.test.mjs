import test from 'node:test';
import assert from 'node:assert/strict';
import {pollDraft} from '../public/poll-draft.mjs';

test('poll options preserve commas and default to allowing all selections', () => {
  assert.deepEqual(pollDraft({question: ' Menu? ', options: [' Pasta, ensalada ', 'Arroz']}), {
    question: 'Menu?', options: ['Pasta, ensalada', 'Arroz'], selectableCount: 2,
  });
  assert.equal(pollDraft({question: 'Menu?', options: ['A', 'B'], selectableCount: 1}).selectableCount, 1);
});

test('poll draft enforces provider limits and rejects empty, repeated and invalid choices', () => {
  const draft = {question: 'Menu?', options: ['A', 'B']};
  for (const patch of [
    {question: ''}, {question: 'x'.repeat(256)}, {options: ['A']},
    {options: Array.from({length: 13}, (_, i) => String(i))},
    {options: ['A', ' A ']}, {options: ['A', ' ']}, {options: ['A', 42]},
    {options: ['A', 'x'.repeat(101)]}, {selectableCount: 0},
    {selectableCount: 3}, {selectableCount: 1.5}, {selectableCount: '1'},
  ]) assert.throws(() => pollDraft({...draft, ...patch}));
  assert.equal(pollDraft({question: 'x'.repeat(255), options: Array.from({length: 12}, (_, i) => String(i).padEnd(100, 'a'))}).options.length, 12);
});
