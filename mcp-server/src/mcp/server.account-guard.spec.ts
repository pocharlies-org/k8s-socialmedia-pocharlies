import { DatabaseRepository } from '../infrastructure/database/repository';
import { useTestAccounts } from '../domain/test-accounts';
import { MCPServer } from './server';

/**
 * SKIRM-107: a tool argument that is a stored id already namespaced to ANOTHER
 * account (`leila:…`, how the index returns it) is refused instead of read or
 * written under the requested account. The account's own prefix still works.
 */
beforeEach(() => {
  useTestAccounts({
    whatsapp: { personal: 'http://wa', professional: 'http://wa-pro', leila: 'http://wa-leila' },
  });
});

function serverWithDb() {
  const query = jest.fn(async (..._args: unknown[]) => ({ rows: [] as any[] }));
  const server: any = Object.create(MCPServer.prototype);
  server.dbClient = { query };
  return { server, query };
}

describe('social_list_messages (handleWhatsAppGetMessages)', () => {
  it('reads the conversation of the requested account as before', async () => {
    const { server, query } = serverWithDb();
    await server.handleWhatsAppGetMessages({
      account: 'professional',
      chatId: '34600@s.whatsapp.net',
    });
    await server.handleWhatsAppGetMessages({
      account: 'professional',
      chatId: 'professional:34600@s.whatsapp.net',
    });
    expect((query.mock.calls[0] as unknown as [string, unknown[]])[1][0]).toBe(
      'professional:34600@s.whatsapp.net'
    );
    expect((query.mock.calls[1] as unknown as [string, unknown[]])[1][0]).toBe(
      'professional:34600@s.whatsapp.net'
    );
  });

  it.each(['professional', 'personal', undefined])(
    'refuses a leila id asked under %s, without querying',
    async account => {
      const { server, query } = serverWithDb();
      await expect(
        server.handleWhatsAppGetMessages({ account, chatId: 'leila:34600@s.whatsapp.net' })
      ).rejects.toThrow('Cross-account identifier');
      expect(query).not.toHaveBeenCalled();
    }
  );
});

describe('DatabaseRepository per-user lookups (handleGetUserMessages)', () => {
  const user = '34600@s.whatsapp.net';
  function repository() {
    const query = jest.fn(async (..._args: unknown[]) => ({ rows: [] as any[] }));
    return { query, repo: new DatabaseRepository({ query } as any) };
  }

  it('looks the user and the conversation up under the requested account as before', async () => {
    const { query, repo } = repository();
    await repo.getMessagesByUser(user, { conversationId: user }, 'professional');
    await repo.getMessagesByUser(user, { conversationId: `professional:${user}` }, 'professional');
    for (const call of query.mock.calls as unknown as Array<[string, unknown[]]>) {
      expect(call[1].slice(0, 2)).toEqual([`professional:${user}`, `professional:${user}`]);
    }
  });

  it('refuses a user or conversation id namespaced to another account', async () => {
    const { query, repo } = repository();
    await expect(repo.getUserInfo(`leila:${user}`, 'professional')).rejects.toThrow(
      'Cross-account identifier'
    );
    await expect(repo.getMessagesByUser(`leila:${user}`, {}, 'professional')).rejects.toThrow(
      'Cross-account identifier'
    );
    await expect(
      repo.getMessagesByUser(user, { conversationId: `leila:${user}` }, 'professional')
    ).rejects.toThrow('Cross-account identifier');
    expect(query).not.toHaveBeenCalled();
  });
});
