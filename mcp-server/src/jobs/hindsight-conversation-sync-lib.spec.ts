import { randomUUID } from 'node:crypto';
import { defaultRegistry } from '../domain/account-registry';
import { socialmediaConversationDocumentId } from '../infrastructure/hindsight-client';
import { syncOptionsFromEnv } from './hindsight-sync-lib';
import {
  advanceConversationEntry,
  buildConversationSnapshot,
  conversationScope,
  newConversationEntry,
  planConversationUpdate,
  NamedMessage,
  ConversationSnapshot,
} from './hindsight-conversation-sync-lib';

const scope = {
  platform: 'whatsapp',
  namespace: 'personal',
  provider_account: 'personal',
  conversation_id: 'qa@c.us',
  topic_id: '',
};
const options = syncOptionsFromEnv({});
const names = { title: 'Alice', accountName: 'Jordi', participants: ['Alice', 'Jordi'] };
const accounts = defaultRegistry();
const message = (content = 'Hello', timestamp = '2026-10-08T10:00:00Z'): NamedMessage => ({
  id: randomUUID(),
  platform: 'whatsapp',
  account: 'personal',
  conversation_id: scope.conversation_id,
  wa_message_id: 'provider-id',
  wa_timestamp: timestamp,
  content,
  sender_wa_id: 'qa@c.us',
  sender_name: 'Alice',
  direction: 'INBOUND',
  message_type: 'TEXT',
  is_deleted: false,
  metadata: {},
});
const snapshot = (rows: NamedMessage[]) =>
  buildConversationSnapshot(scope, rows, names, accounts, options);
function confirmed(value: ConversationSnapshot) {
  return { ...newConversationEntry('qa', 'scope', scope), confirmed: value, sourceRevision: '1' };
}
describe('conversation snapshots', () => {
  it('uses exact provider/account/chat/topic identities and UUID turn ids', () => {
    const row = message();
    const value = snapshot([row]);
    expect(value.messageIds).toEqual([row.id]);
    expect(JSON.parse(value.content.split('\n')[1])).toMatchObject({
      message_id: row.id,
      sender_name: 'Alice',
      content: 'Hello',
    });
    expect(value.content).not.toContain('provider-id');
    const id = socialmediaConversationDocumentId(scope);
    for (const key of [
      'platform',
      'namespace',
      'provider_account',
      'conversation_id',
      'topic_id',
    ] as const)
      expect(socialmediaConversationDocumentId({ ...scope, [key]: 'different' })).not.toBe(id);
    expect(
      conversationScope({ ...row, platform: 'telegram', metadata: { telegram_topic_id: 123 } })
        .topic_id
    ).toBe('123');
    expect(
      conversationScope({
        ...row,
        platform: 'telegram',
        metadata: { topic_id: '', thread_id: 123 },
      }).topic_id
    ).toBe('123');
  });
  it('appends exact chronological prefix growth but replaces edits, late history and names', () => {
    const first = message();
    const second = message('Second', '2026-10-08T11:00:00Z');
    const prior = snapshot([first]);
    const grown = snapshot([first, second]);
    const planned = planConversationUpdate(confirmed(prior), grown, '2', 'hash');
    expect(planned.pending?.updateMode).toBe('append');
    expect(prior.content + '\n' + planned.pending?.content).toBe(grown.content);
    for (const changed of [
      snapshot([{ ...first, content: 'Edit' }, second]),
      snapshot([message('Old', '2026-10-08T09:00:00Z'), first]),
      buildConversationSnapshot(
        scope,
        [first, second],
        { ...names, title: 'New name' },
        accounts,
        options
      ),
      snapshot([]),
    ])
      expect(
        planConversationUpdate(confirmed(prior), changed, '2', 'hash').pending?.updateMode
      ).toBe('replace');
  });
  it('filters deleted, moved and outside selection turns before serializing', () => {
    const rows = [
      message(),
      { ...message(), is_deleted: true },
      { ...message(), metadata: { deleted_for_me: true } },
      { ...message(), account: 'professional' },
      message('old', '1960-01-01T00:00:00Z'),
    ];
    expect(snapshot(rows).messageIds).toEqual([rows[0].id]);
    expect(
      buildConversationSnapshot(scope, rows, names, accounts, { ...options, chatIds: ['other'] })
        .content
    ).toBe('');
    expect(buildConversationSnapshot(scope, rows, names, [], options).messageIds).toEqual([]);
  });
  it('reconciles a lost acknowledgement before marking mapping confirmed', async () => {
    const value = snapshot([message()]);
    const entry = planConversationUpdate(
      newConversationEntry('qa', 'scope', scope),
      value,
      '1',
      'hash'
    );
    let accepted = false;
    const retainDocument = jest.fn(async () => {
      accepted = true;
      throw new Error('lost ack');
    });
    const client = {
      retainDocument,
      deleteDocument: jest.fn(),
      retryOperation: jest.fn(),
      getOperation: jest.fn(async () => ({
        operationId: entry.pending!.operationId,
        status: accepted ? ('completed' as const) : ('not_found' as const),
      })),
    };
    const save = jest.fn(async () => {});
    await expect(advanceConversationEntry(entry, client, save, 1)).rejects.toThrow('lost ack');
    expect(entry.confirmed).toBeNull();
    expect(entry.pending).not.toBeNull();
    await advanceConversationEntry(entry, client, save, 1);
    expect(retainDocument).toHaveBeenCalledTimes(1);
    expect(entry.confirmed?.messageIds).toEqual(value.messageIds);
    expect(entry.pending).toBeNull();
  });
  it('does not replace a pending snapshot and retries failed provider operation', async () => {
    const entry = planConversationUpdate(
      confirmed(snapshot([message()])),
      snapshot([message()]),
      '2',
      'hash'
    );
    expect(() => planConversationUpdate(entry, snapshot([]), '3', 'hash')).toThrow('Reconcile');
    const retryOperation = jest.fn(async () => ({ operationId: 'op' }));
    const client = {
      retainDocument: jest.fn(),
      deleteDocument: jest.fn(),
      retryOperation,
      getOperation: async () => ({ operationId: 'op', status: 'failed' as const }),
    };
    await advanceConversationEntry(entry, client, async () => {}, 1);
    expect(retryOperation).toHaveBeenCalledWith(entry.pending!.operationId);
    expect(entry.confirmed).not.toBe(entry.pending!.snapshot);
    expect(entry.status).toBe('accepted');
  });
  it('repairs an uncertain append with a durable canonical replacement after operation TTL', async () => {
    const first = message();
    const full = snapshot([first, message('Second', '2026-10-08T11:00:00Z')]);
    const entry = planConversationUpdate(confirmed(snapshot([first])), full, '2', 'hash');
    const original = entry.pending!.operationId;
    entry.pending!.attempts = 1;
    const events: string[] = [];
    const retainDocument = jest.fn(async input => {
      events.push('retain');
      return { operationId: input.operationId };
    });
    const client = {
      retainDocument,
      deleteDocument: jest.fn(),
      retryOperation: jest.fn(),
      getOperation: async () => ({ operationId: original, status: 'not_found' as const }),
    };
    await advanceConversationEntry(
      entry,
      client,
      async () => {
        events.push('save');
      },
      1
    );
    expect(events).toEqual(['save', 'save', 'retain', 'save']);
    expect(entry.pending!.operationId).not.toBe(original);
    expect(retainDocument).toHaveBeenCalledWith(
      expect.objectContaining({ updateMode: 'replace', content: full.content })
    );
    expect(entry.confirmed!.messageIds).toHaveLength(1);
  });
  it('persists send intent before provider acceptance and repairs after a process crash', async () => {
    const first = message();
    const full = snapshot([first, message('Second', '2026-10-08T11:00:00Z')]);
    const entry = planConversationUpdate(confirmed(snapshot([first])), full, '2', 'hash');
    let durable: typeof entry | undefined;
    let crashSnapshot: typeof entry | undefined;
    const save = async (e: typeof entry) => {
      durable = JSON.parse(JSON.stringify(e));
    };
    const client = {
      getOperation: async () => ({ operationId: 'op', status: 'not_found' as const }),
      retryOperation: jest.fn(),
      deleteDocument: jest.fn(),
      retainDocument: jest.fn(async () => {
        expect(durable?.pending?.attempts).toBe(1);
        crashSnapshot = JSON.parse(JSON.stringify(durable));
        throw new Error('Process dies after remote acceptance');
      }),
    };
    await expect(advanceConversationEntry(entry, client, save, 1)).rejects.toThrow('Process dies');
    expect(crashSnapshot!.pending!.updateMode).toBe('append');
    const retainDocument = jest.fn(async () => ({ operationId: 'repair' }));
    await advanceConversationEntry(crashSnapshot!, { ...client, retainDocument }, save, 1);
    expect(retainDocument).toHaveBeenCalledWith(
      expect.objectContaining({ updateMode: 'replace', content: full.content })
    );
  });
});
