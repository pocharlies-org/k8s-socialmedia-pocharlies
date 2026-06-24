import { MCPServer } from './server';
import type { Account } from '../domain/account';

type Rows = { rows: Array<Record<string, unknown>> };
type QueryImpl = (sql: string, params: unknown[]) => Promise<Rows>;

type Resolution = {
  account: Account;
  source: string;
  candidates: string[];
};

function resolverWith(opts: {
  messageRows?: Array<Record<string, unknown>>;
  conversationRows?: Array<Record<string, unknown>>;
  queryImpl?: QueryImpl;
}) {
  const defaultImpl: QueryImpl = async (sql: string) => {
    if (/FROM messages/i.test(sql)) return { rows: opts.messageRows ?? [] };
    if (/FROM conversations/i.test(sql)) return { rows: opts.conversationRows ?? [] };
    return { rows: [] };
  };
  const impl = opts.queryImpl ?? defaultImpl;
  const server = Object.create(MCPServer.prototype) as MCPServer;
  (server as unknown as { dbClient: { query: jest.Mock } }).dbClient = {
    query: jest.fn(impl),
  };
  return {
    server,
    query: (server as unknown as { dbClient: { query: jest.Mock } }).dbClient.query,
    resolve: (chatId: string, messageId: string, requested: Account): Promise<Resolution> =>
      (
        server as unknown as {
          resolveTelegramMediaAccount: (
            c: string,
            m: string,
            r: Account
          ) => Promise<Resolution>;
        }
      ).resolveTelegramMediaAccount(chatId, messageId, requested),
  };
}

describe('resolveTelegramMediaAccount', () => {
  it('overrides an explicit professional request when the message lives in the personal chat', async () => {
    const { resolve } = resolverWith({ messageRows: [{ conversation_id: 'tg_8621739742' }] });
    const r = await resolve('8621739742', '197531', 'professional');
    expect(r.account).toBe('personal');
    expect(r.source).toBe('message');
    expect(r.candidates).toEqual(['tg_8621739742', 'professional:tg_8621739742']);
  });

  it('keeps professional when the message really belongs to the professional chat', async () => {
    const { resolve } = resolverWith({
      messageRows: [{ conversation_id: 'professional:tg_8621739742' }],
    });
    const r = await resolve('8621739742', '197531', 'professional');
    expect(r.account).toBe('professional');
    expect(r.source).toBe('message');
  });

  it('promotes a default personal request to professional when the message is professional', async () => {
    const { resolve } = resolverWith({
      messageRows: [{ conversation_id: 'professional:tg_8621739742' }],
    });
    const r = await resolve('8621739742', '197531', 'personal');
    expect(r.account).toBe('professional');
    expect(r.source).toBe('message');
  });

  it('falls back to conversation-level evidence when no message row matches', async () => {
    const { resolve } = resolverWith({
      messageRows: [],
      conversationRows: [{ id: 'professional:tg_999' }],
    });
    const r = await resolve('999', '5', 'personal');
    expect(r.account).toBe('professional');
    expect(r.source).toBe('conversation');
  });

  it('preserves the requested account when there is no DB evidence at all', async () => {
    const { resolve, query } = resolverWith({ messageRows: [], conversationRows: [] });
    const r = await resolve('123456', '7', 'professional');
    expect(r.account).toBe('professional');
    expect(r.source).toBe('fallback');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('keeps the requested account on an ambiguous message match', async () => {
    const { resolve } = resolverWith({
      messageRows: [
        { conversation_id: 'tg_8621739742' },
        { conversation_id: 'professional:tg_8621739742' },
      ],
    });
    const r = await resolve('8621739742', '197531', 'professional');
    expect(r.account).toBe('professional');
    expect(r.source).toBe('message-ambiguous');
  });

  it('normalizes tg-prefixed and account-prefixed chat ids to the same candidate set', async () => {
    const { resolve } = resolverWith({ messageRows: [{ conversation_id: 'tg_8621739742' }] });
    const fromTgPrefix = await resolve('tg_8621739742', '197531', 'professional');
    const fromAccountPrefix = await resolve('professional:tg_8621739742', '197531', 'professional');
    expect(fromTgPrefix.candidates).toEqual(['tg_8621739742', 'professional:tg_8621739742']);
    expect(fromAccountPrefix.candidates).toEqual(['tg_8621739742', 'professional:tg_8621739742']);
  });

  it('resolves username chats per-account before probing for the message', async () => {
    const queryImpl: QueryImpl = async (sql: string, params: unknown[]) => {
      if (/lower\(metadata->>'username'\)/i.test(sql)) {
        const like = String(params[1]);
        return like.startsWith('professional:')
          ? { rows: [{ id: 'professional:tg_555' }] }
          : { rows: [] };
      }
      if (/FROM messages/i.test(sql)) return { rows: [{ conversation_id: 'professional:tg_555' }] };
      return { rows: [] };
    };
    const { resolve } = resolverWith({ queryImpl });
    const r = await resolve('@someshop', '42', 'personal');
    expect(r.account).toBe('professional');
    expect(r.source).toBe('message');
    expect(r.candidates).toEqual(['professional:tg_555']);
  });
});
