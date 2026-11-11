import assert from 'node:assert/strict';
import test from 'node:test';
import { providerChatStateMap } from '../server.mjs';

test('provider pin state resolves both bare and account-prefixed chat IDs', () => {
  const state = providerChatStateMap([
    { chat_id: 'secondary:123@lid', pinned: true, mute_until: null },
    { chat_id: 'secondary:456@g.us', pinned: false, mute_until: null },
  ], 'secondary');
  assert.equal(state.get('123@lid').pinned, true);
  assert.equal(state.get('secondary:123@lid').pinned, true);
  assert.equal(state.get('456@g.us').pinned, false);
  assert.equal(state.has('personal:123@lid'), false);
});
