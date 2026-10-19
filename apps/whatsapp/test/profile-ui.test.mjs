import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfileClient } from '../public/profile-ui.mjs';

test('profile requests always use the active account, including writes', async () => {
  const calls = [];
  const client = createProfileClient({ getAccount: () => 'secondary', api: async (...args) => {
    calls.push(args); return { account: 'secondary', profile: { name: 'Owner' } };
  } });
  await client.request();
  await client.request('/api/profile', { account: 'personal', about: '' });
  assert.deepEqual(calls, [
    ['/api/profile?account=secondary', undefined],
    ['/api/profile', { account: 'secondary', about: '' }],
  ]);
});

test('late profile responses cannot restore an old account or closed panel', async () => {
  let account = 'personal';
  let finish;
  const client = createProfileClient({ getAccount: () => account, api: () => new Promise(resolve => { finish = resolve; }) });
  const pending = client.request();
  account = 'secondary';
  finish({ account: 'personal', profile: { name: 'Old' } });
  assert.equal(await pending, null);
  const closed = client.request();
  client.invalidate();
  finish({ account: 'secondary', profile: { name: 'Late' } });
  assert.equal(await closed, null);
});

test('mismatched or malformed profile projections are rejected', async () => {
  for (const result of [{ account: 'other', profile: {} }, { account: 'personal' }, { account: 'personal', profile: [] }, { account: 'personal', profile: 'invalid' }]) {
    const client = createProfileClient({ getAccount: () => 'personal', api: async () => result });
    await assert.rejects(client.request(), /perfil no válida/);
  }
});
