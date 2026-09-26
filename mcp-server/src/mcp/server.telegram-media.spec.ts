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
  it.each(['personal', 'professional'])('keeps requested %s despite sibling database evidence', async requested => {
    const { resolve, query } = resolverWith({ messageRows: [{ conversation_id: 'professional:tg_42' }, { conversation_id: 'tg_42' }] });
    const result = await resolve('42', 'message', requested);
    expect(result.account).toBe(requested);
    expect(result.candidates).toEqual([requested === 'personal' ? 'tg_42' : 'professional:tg_42']);
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects unknown account without querying another account', async () => {
    const { resolve, query } = resolverWith({});
    await expect(resolve('42', 'message', 'unknown')).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
