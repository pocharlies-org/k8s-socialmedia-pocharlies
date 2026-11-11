import {
  ensureSearchIndexes,
  IndexClient,
  MAX_SEARCH_LIMIT,
  SEARCH_FTS_INDEX,
  searchLimit,
} from '../application/search.service';
import { useTestAccounts } from '../domain/test-accounts';
import { MCPServer, whatsAppChatKeys } from './server';
import { SOCIAL_TOOL_REGISTRY } from './tool-registry';

/**
 * QA audit 02-10-2026, MCP side:
 * - social_search_messages without a chat timed out (seq scan computing
 *   to_tsvector over every message): a GIN index built CONCURRENTLY outside
 *   any transaction, once, under an advisory lock; the limit is bounded;
 * - social_get_conversation answered not_found for WhatsApp 1:1 chats: the
 *   provider list is only the last history snapshot, so ids are compared in
 *   every spelling and the index answers what the provider does not;
 * - a social_send_message attachment `name` names the WhatsApp document.
 */

function fakeIndexClient(answers: Record<string, Array<Record<string, unknown>> | Error>): {
  client: IndexClient;
  sql: string[];
  ended: () => boolean;
} {
  const sql: string[] = [];
  let ended = false;
  const client: IndexClient = {
    query: jest.fn(async (text: string) => {
      sql.push(text.replace(/\s+/g, ' ').trim());
      for (const [needle, rows] of Object.entries(answers)) {
        if (text.includes(needle)) {
          if (rows instanceof Error) throw rows;
          return { rows };
        }
      }
      return { rows: [] };
    }),
    end: jest.fn(async () => {
      ended = true;
    }),
  };
  return { client, sql, ended: () => ended };
}

describe('ensureSearchIndexes', () => {
  const previous = process.env.SOCIAL_SEARCH_ENSURE_INDEX;
  afterEach(() => {
    if (previous === undefined) delete process.env.SOCIAL_SEARCH_ENSURE_INDEX;
    else process.env.SOCIAL_SEARCH_ENSURE_INDEX = previous;
  });

  it('builds the GIN index CONCURRENTLY with no statement timeout, under the advisory lock', async () => {
    const { client, sql, ended } = fakeIndexClient({ pg_try_advisory_lock: [{ locked: true }] });
    await expect(ensureSearchIndexes(async () => client)).resolves.toBe('created');
    expect(sql[0]).toContain('pg_try_advisory_lock');
    expect(sql).toContain('SET statement_timeout = 0');
    const create = sql.find(s => s.startsWith('CREATE INDEX'))!;
    expect(create).toBe(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${SEARCH_FTS_INDEX} ON messages USING gin (to_tsvector('english', content))`
    );
    expect(sql.some(s => s.startsWith('BEGIN'))).toBe(false);
    expect(sql[sql.length - 1]).toContain('pg_advisory_unlock');
    expect(ended()).toBe(true);
  });

  it('does nothing when the index is valid, or another pod holds the lock', async () => {
    const valid = fakeIndexClient({
      pg_try_advisory_lock: [{ locked: true }],
      indisvalid: [{ valid: true }],
    });
    await expect(ensureSearchIndexes(async () => valid.client)).resolves.toBe('exists');
    expect(valid.sql.some(s => s.startsWith('CREATE INDEX'))).toBe(false);

    const busy = fakeIndexClient({ pg_try_advisory_lock: [{ locked: false }] });
    await expect(ensureSearchIndexes(async () => busy.client)).resolves.toBe('busy');
    expect(busy.sql).toHaveLength(1);
    expect(busy.ended()).toBe(true);
  });

  it('drops an INVALID leftover of an interrupted build before building again', async () => {
    const { client, sql } = fakeIndexClient({
      pg_try_advisory_lock: [{ locked: true }],
      indisvalid: [{ valid: false }],
    });
    await expect(ensureSearchIndexes(async () => client)).resolves.toBe('created');
    const drop = sql.findIndex(s => s === `DROP INDEX CONCURRENTLY IF EXISTS ${SEARCH_FTS_INDEX}`);
    const create = sql.findIndex(s => s.startsWith('CREATE INDEX CONCURRENTLY'));
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
  });

  it('never throws: a failed build or connection is reported, the lock released', async () => {
    const failing = fakeIndexClient({
      pg_try_advisory_lock: [{ locked: true }],
      'CREATE INDEX': new Error('canceling statement due to lock timeout'),
    });
    const log = jest.fn();
    await expect(ensureSearchIndexes(async () => failing.client, log)).resolves.toBe('failed');
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('lock timeout'));
    expect(failing.sql[failing.sql.length - 1]).toContain('pg_advisory_unlock');
    await expect(
      ensureSearchIndexes(async () => Promise.reject(new Error('ECONNREFUSED')))
    ).resolves.toBe('failed');
  });

  it('can be switched off', async () => {
    process.env.SOCIAL_SEARCH_ENSURE_INDEX = 'false';
    const connect = jest.fn();
    await expect(ensureSearchIndexes(connect)).resolves.toBe('disabled');
    expect(connect).not.toHaveBeenCalled();
  });

  it('bounds the search limit', () => {
    expect(searchLimit(undefined)).toBe(20);
    expect(searchLimit(0)).toBe(20);
    expect(searchLimit('7')).toBe(7);
    expect(searchLimit(10_000)).toBe(MAX_SEARCH_LIMIT);
  });
});

function serverWith(chats: Array<Record<string, unknown>> = []) {
  const server = Object.create(MCPServer.prototype) as MCPServer;
  const connectorCall = jest.fn(async (..._args: unknown[]): Promise<unknown> => ({ sent: true }));
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (/FROM conversations c\s+WHERE c\.id = \$1 OR/i.test(sql)) {
      if (params[0] === '174869610295503@lid' && params[1] === 'whatsapp:professional') {
        return {
          rows: [
            {
              id: 'professional:174869610295503@lid',
              account_id: 'whatsapp:professional',
              external_id: '174869610295503@lid',
              merged_into: null,
              name: '174869610295503@lid',
              is_group: false,
              last_message_at: '2026-10-02T15:46:54.985Z',
            },
          ],
        };
      }
      return { rows: [] };
    }
    if (/FROM social_contact_aliases al/i.test(sql)) {
      if (params[1] === '34659695630@c.us') {
        return {
          rows: [
            {
              id: 'professional:174869610295503@lid',
              account_id: 'whatsapp:professional',
              external_id: '174869610295503@lid',
              merged_into: null,
              name: '174869610295503@lid',
              is_group: false,
              last_message_at: '2026-10-02T15:46:54.985Z',
            },
          ],
        };
      }
      return { rows: [] };
    }
    if (/FROM conversation_participants cp/i.test(sql)) {
      return { rows: [{ name: 'Daniel Ibáñez Fernández' }] };
    }
    return { rows: [] };
  });
  useTestAccounts({
    whatsapp: { personal: 'http://wa-personal', professional: 'http://wa-professional' },
    telegram: { personal: 'http://tg-personal' },
  });
  Object.assign(server as unknown as Record<string, unknown>, {
    connectorCall,
    dbClient: { query },
    providerGet: jest.fn(async () => ({ chats })),
    logger: { error: jest.fn() },
    redisClient: { set: jest.fn(async () => 'OK'), get: jest.fn(async () => null) },
  });
  const any = server as unknown as Record<string, (...a: unknown[]) => Promise<any>>;
  const run = (name: string, args: Record<string, unknown>) =>
    any.executeCanonicalTool(
      SOCIAL_TOOL_REGISTRY.find(tool => tool.name === name),
      args
    ) as Promise<{ isError?: boolean; structuredContent: Record<string, any> }>;
  return { run, connectorCall, query };
}

const wa = { channel: 'whatsapp', accountId: 'professional' };

describe('social_get_conversation — WhatsApp 1:1', () => {
  it('matches the provider list in any spelling of the jid', async () => {
    expect(whatsAppChatKeys('professional:34600@s.whatsapp.net')).toEqual([
      '34600@s.whatsapp.net',
      '34600@c.us',
    ]);
    const { run, query } = serverWith([
      { id: '34600@c.us', name: 'Ana', isGroup: false, timestamp: 1 },
    ]);
    const out = await run('social_get_conversation', { ...wa, target: '34600@s.whatsapp.net' });
    expect(out.structuredContent.data).toEqual({
      id: '34600@c.us',
      name: 'Ana',
      isGroup: false,
      timestamp: 1,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('answers from the index what the provider snapshot does not list (LID and its phone alias)', async () => {
    const { run } = serverWith([{ id: '1203@g.us', name: 'G', isGroup: true, timestamp: 1 }]);
    const expected = {
      id: '174869610295503@lid',
      name: 'Daniel Ibáñez Fernández',
      isGroup: false,
      timestamp: Math.floor(Date.parse('2026-10-02T15:46:54.985Z') / 1000),
      conversationId: 'professional:174869610295503@lid',
      resolvedFrom: 'index',
    };
    const lid = await run('social_get_conversation', { ...wa, target: '174869610295503@lid' });
    expect(lid.isError).toBeFalsy();
    expect(lid.structuredContent.data).toEqual(expected);
    const phone = await run('social_get_conversation', {
      ...wa,
      target: '34659695630@s.whatsapp.net',
    });
    expect(phone.structuredContent.data).toEqual(expected);
  });

  it('is still not_found when neither knows the chat', async () => {
    const { run } = serverWith([]);
    const out = await run('social_get_conversation', { ...wa, target: '999@lid' });
    expect(out.structuredContent.error).toMatchObject({ code: 'not_found' });
  });
});

describe('social_send_message attachment name → WhatsApp document fileName', () => {
  const previous = process.env.ENABLE_SENDING;
  beforeAll(() => {
    process.env.ENABLE_SENDING = 'true';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = previous;
  });

  it('forwards name as fileName only when given', async () => {
    const { run, connectorCall } = serverWith();
    await run('social_send_message', {
      ...wa,
      target: '34600@s.whatsapp.net',
      attachments: [
        { url: 'http://minio/b/x1.pdf?X-Amz-Signature=z', name: 'factura.pdf' },
        { url: 'https://x/c.pdf' },
      ],
    });
    expect(connectorCall.mock.calls.map(call => call[3])).toEqual([
      {
        conversationId: '34600@s.whatsapp.net',
        fileUrl: 'http://minio/b/x1.pdf?X-Amz-Signature=z',
        fileName: 'factura.pdf',
      },
      { conversationId: '34600@s.whatsapp.net', fileUrl: 'https://x/c.pdf' },
    ]);
  });
});
