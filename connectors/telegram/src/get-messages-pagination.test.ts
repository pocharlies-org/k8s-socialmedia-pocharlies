/**
 * INFRA-1008: getMessages pages through messages.getHistory's 100-per-call cap
 * (iterHistory) and honours the before/after cursors of social_list_messages
 * (readSource provider). The boundary id is dropped on both sides so the caller
 * can feed any returned id back as the next cursor without overlap.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramClientWrapper } from './telegram-client';

type HistoryParams = {
  limit: number;
  offset?: { id: number; date: number };
  reverse?: boolean;
};

function wrapperWithHistory(ids: number[], seen: HistoryParams[]) {
  const client: Record<string, unknown> = {
    iterHistory: async function* (_peer: unknown, params: HistoryParams) {
      seen.push(params);
      for (const id of ids) yield { id };
    },
  };
  Object.assign(client, { withParams: () => client });
  const wrapper = Object.assign(Object.create(TelegramClientWrapper.prototype), {
    client,
    connected: true,
    parseMessage: async (m: { id: number }) => ({ telegramMessageId: String(m.id) }),
  }) as TelegramClientWrapper;
  return wrapper;
}

test('before (offsetId) pages backwards: offset id set, no reverse, the boundary id itself is dropped', async () => {
  const seen: HistoryParams[] = [];
  const wrapper = wrapperWithHistory([20200, 20199, 20198], seen);
  const out = await wrapper.getMessages('-1004409526898', 3, 20200);
  assert.deepEqual(seen, [{ limit: 3, offset: { id: 20200, date: 0 } }]);
  assert.deepEqual(
    out.map(m => m.telegramMessageId),
    ['20199', '20198']
  );
});

test('after pages forwards: reverse=true from the cursor, the boundary id itself is dropped', async () => {
  const seen: HistoryParams[] = [];
  const wrapper = wrapperWithHistory([20100, 20101, 20102], seen);
  const out = await wrapper.getMessages('-1004409526898', 3, undefined, 20100);
  assert.deepEqual(seen, [{ limit: 3, offset: { id: 20100, date: 0 }, reverse: true }]);
  assert.deepEqual(
    out.map(m => m.telegramMessageId),
    ['20101', '20102']
  );
});

test('no cursor reads the newest page: no offset, no reverse', async () => {
  const seen: HistoryParams[] = [];
  const wrapper = wrapperWithHistory([5, 4], seen);
  const out = await wrapper.getMessages('-1004409526898', 50);
  assert.deepEqual(seen, [{ limit: 50 }]);
  assert.equal(out.length, 2);
});

test('limit above 100 travels whole to iterHistory (its chunking is what breaks the old 100 cap)', async () => {
  const seen: HistoryParams[] = [];
  const wrapper = wrapperWithHistory([], seen);
  await wrapper.getMessages('-1004409526898', 500);
  assert.deepEqual(seen, [{ limit: 500 }]);
});

test('with both cursors, after wins: forwards page, reverse', async () => {
  const seen: HistoryParams[] = [];
  const wrapper = wrapperWithHistory([], seen);
  await wrapper.getMessages('-1004409526898', 10, 20200, 100);
  assert.deepEqual(seen, [{ limit: 10, offset: { id: 100, date: 0 }, reverse: true }]);
});
