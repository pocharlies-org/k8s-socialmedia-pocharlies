import test from 'node:test';
import assert from 'node:assert/strict';
import { pollVoterNames } from '../lib/poll-voter-names.mjs';
import { publicPollResults } from '../lib/message-projection.mjs';

test('poll voters resolve in the selected account with saved names, self and honest fallback', async () => {
  const calls = [];
  const polls = [{ options: [{ name: 'Followers', count: 4, voters: [
    { jid: '123@lid', fromMe: false }, { jid: '456@s.whatsapp.net', fromMe: true },
    { jid: '789@s.whatsapp.net', fromMe: false }, { jid: '999@lid', fromMe: false },
    { jid: 'invalid', fromMe: false },
  ] }] }];
  const named = await pollVoterNames(async (sql, args) => {
    calls.push({ sql, args });
    return [{ id: '123@lid', name: 'Ari ❤️', priority: 1 }, { id: '123@lid', name: 'Ariadna', priority: 2 }];
  }, 'secondary', polls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], 'secondary');
  assert(calls[0].sql.includes("a.account_id='whatsapp:' || $1"));
  assert(calls[0].sql.includes('c.account=$1'));
  assert(calls[0].sql.includes('p.account=$1'));
  assert.deepEqual(named[0].options[0].voters, [
    { id: '123@lid', name: 'Ari ❤️' }, { id: '456@s.whatsapp.net', name: 'Tú' },
    { id: '789@s.whatsapp.net', name: '+789' }, { id: '999@lid', name: 'Contacto sin nombre' },
  ]);
  assert.deepEqual(publicPollResults(named[0]).options[0].voters, named[0].options[0].voters);
});
