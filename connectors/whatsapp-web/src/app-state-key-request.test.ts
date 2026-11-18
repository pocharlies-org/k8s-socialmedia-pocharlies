import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractMissingKeyIds, requestMissingAppStateKeys } from './app-state-key-request';

test('extracts the base64 key ids of a Baileys park line (pino obj + msg)', () => {
  const logData = {
    name: 'regular',
    attempt: 2,
    error:
      'Error: failed to find key "AAAAAAvU" to decode mutation\n' +
      '    at getKey (/app/node_modules/baileys/src/Utils/chat-utils.ts:309:10)',
  };
  assert.deepEqual(
    extractMissingKeyIds([
      logData,
      'regular blocked on missing key from v58, parking after 2 attempts',
    ]),
    ['AAAAAAvU']
  );
});

test('dedupes repeated ids and ignores warns without a missing key', () => {
  assert.deepEqual(
    extractMissingKeyIds([
      { error: 'failed to find key "AAAAAAvX" to decode mutation' },
      { error: 'failed to find key "AAAAAAvX" to decode mutation' },
    ]),
    ['AAAAAAvX']
  );
  assert.deepEqual(extractMissingKeyIds(['failed to find key "AAAAAAvU" to decode mutation']), [
    'AAAAAAvU',
  ]);
  assert.deepEqual(extractMissingKeyIds(['resyncAppState (api)']), []);
});

test('relays the request to the primary device once per key, with the decoded key id', async () => {
  const sent: Array<{ jid: string; keyIds: Buffer[]; category?: string }> = [];
  const sock = {
    user: { id: '34600000000:10@s.whatsapp.net' },
    relayMessage: async (jid: string, content: any, options: any) => {
      sent.push({
        jid,
        keyIds: content.protocolMessage.appStateSyncKeyRequest.keyIds,
        category: options.additionalAttributes?.category,
      });
      return 'MSGID';
    },
  };
  const requested = new Set<string>();
  await requestMissingAppStateKeys(
    sock as any,
    '34600000000@c.us',
    ['AAAAAAvU', 'AAAAAAvU'],
    requested
  );
  await requestMissingAppStateKeys(sock as any, '34600000000@c.us', ['AAAAAAvU'], requested);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, '34600000000@c.us');
  assert.equal(sent[0].keyIds[0].toString('base64'), 'AAAAAAvU');
  assert.equal(sent[0].category, 'peer');
});

test('a failed request is forgotten so the next park retries it', async () => {
  const sock = {
    relayMessage: async () => {
      throw new Error('not connected');
    },
  };
  const requested = new Set<string>();
  const logs: string[] = [];
  await requestMissingAppStateKeys(sock as any, 'me@c.us', ['AAAAAAvU'], requested, l =>
    logs.push(l)
  );
  assert.equal(requested.has('AAAAAAvU'), false);
  assert.match(logs.join('\n'), /failed/);
});
