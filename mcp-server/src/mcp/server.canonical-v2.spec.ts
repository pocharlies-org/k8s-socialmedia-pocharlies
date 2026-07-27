import { MCPServer } from './server';
import { SOCIAL_TOOL_REGISTRY } from './tool-registry';

function definition(name: string) {
  const found = SOCIAL_TOOL_REGISTRY.find(tool => tool.name === name);
  if (!found) throw new Error(`Missing test definition ${name}`);
  return found;
}

function legacy(data: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fakeRedis() {
  const values = new Map<string, string>();
  return {
    values,
    get: jest.fn(async (key: string) => values.get(key) ?? null),
    set: jest.fn(
      async (key: string, value: string, ...args: Array<string | number>) => {
        if (args.includes('NX') && values.has(key)) return null;
        values.set(key, value);
        return 'OK';
      }
    ),
  };
}

function createServer() {
  const server: any = Object.create(MCPServer.prototype);
  server.redisClient = fakeRedis();
  server.logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
  server.waUrls = {
    personal: 'http://wa-personal',
    professional: 'http://wa-professional',
  };
  server.tgUrls = {
    personal: 'http://tg-personal',
    professional: 'http://tg-professional',
  };
  return server;
}

describe('Socialmedia canonical v2 adapter', () => {
  test('routes WhatsApp, Telegram and Instagram sends without target-shape inference', async () => {
    const server = createServer();
    server.handleSendMessage = jest.fn(async (args: unknown) => legacy({ provider: 'wa', args }));
    server.handleTelegramSendMessage = jest.fn(async (args: unknown) =>
      legacy({ provider: 'tg', args })
    );
    server.handleInstagramSendDm = jest.fn(async (args: unknown) =>
      legacy({ provider: 'ig', args })
    );

    const wa = await server.executeCanonicalTool(definition('social_send_message'), {
      channel: 'whatsapp',
      accountId: 'personal',
      target: '123456789@s.whatsapp.net',
      message: 'hola',
    });
    const tg = await server.executeCanonicalTool(definition('social_send_message'), {
      channel: 'telegram',
      accountId: 'professional',
      target: '-100123456',
      message: 'hola',
      replyTo: '22',
      threadId: '77',
    });
    const ig = await server.executeCanonicalTool(definition('social_send_message'), {
      channel: 'instagram',
      accountId: 'skirmshop',
      target: '1789001',
      message: 'hola',
    });

    expect(wa.structuredContent).toMatchObject({ ok: true, status: 'accepted' });
    expect(tg.structuredContent).toMatchObject({ ok: true, status: 'accepted' });
    expect(ig.structuredContent).toMatchObject({ ok: true, status: 'accepted' });
    expect(server.handleTelegramSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-100123456',
        account: 'professional',
        replyTo: '22',
        topicId: '77',
      })
    );
  });

  test('requires string targets and never infers a channel from a numeric id', () => {
    const server = createServer();
    expect(() =>
      server.validateCanonicalArguments(definition('social_send_message'), {
        channel: 'telegram',
        accountId: 'personal',
        target: -100123456,
        message: 'hola',
      })
    ).toThrow('/target must be string');
    expect(() =>
      server.validateCanonicalArguments(definition('social_send_message'), {
        accountId: 'personal',
        target: '-100123456',
        message: 'hola',
      })
    ).toThrow("must have required property 'channel'");
  });

  test('returns structured MCP errors instead of successful failed text', async () => {
    const server = createServer();
    server.handleSendMessage = jest.fn(async () => {
      throw new Error('provider failed');
    });
    const result = await server.executeCanonicalTool(definition('social_send_message'), {
      channel: 'whatsapp',
      accountId: 'personal',
      target: '34600000000@s.whatsapp.net',
      message: 'hola',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      status: 'failed',
      error: { code: 'provider_error', message: 'provider failed' },
    });
  });

  test('reports outcome_unknown for provider timeouts', async () => {
    const server = createServer();
    server.handleTelegramSendMessage = jest.fn(async () => {
      const error = new Error('request timed out');
      error.name = 'TimeoutError';
      throw error;
    });
    const result = await server.executeCanonicalTool(definition('social_send_message'), {
      channel: 'telegram',
      accountId: 'personal',
      target: '-100123456',
      message: 'hola',
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        status: 'outcome_unknown',
        error: { code: 'outcome_unknown' },
      },
    });
  });

  test('replays identical idempotent sends and conflicts on a changed payload', async () => {
    const server = createServer();
    server.handleSendMessage = jest.fn(async () => legacy({ accepted: true, messageId: 'm1' }));
    const base = {
      channel: 'whatsapp',
      accountId: 'personal',
      target: '34600000000@s.whatsapp.net',
      message: 'uno',
      idempotencyKey: 'send-1',
    };
    const first = await server.executeCanonicalTool(
      definition('social_send_message'),
      base
    );
    const replay = await server.executeCanonicalTool(
      definition('social_send_message'),
      base
    );
    const conflict = await server.executeCanonicalTool(
      definition('social_send_message'),
      { ...base, message: 'dos' }
    );

    expect(first.structuredContent.ok).toBe(true);
    expect(replay.structuredContent.meta.replayed).toBe(true);
    expect(server.handleSendMessage).toHaveBeenCalledTimes(1);
    expect(conflict).toMatchObject({
      isError: true,
      structuredContent: { status: 'conflict', error: { code: 'conflict' } },
    });
  });

  test('declares partial aggregate conversation results and per-account errors', async () => {
    const server = createServer();
    server.providerGet = jest.fn(async (baseUrl: string) => {
      if (baseUrl === 'http://tg-professional') throw new Error('telegram unavailable');
      return baseUrl.startsWith('http://wa')
        ? { chats: [{ id: `${baseUrl}-chat` }] }
        : { dialogs: [{ id: `${baseUrl}-dialog` }] };
    });
    server.handleInstagramGetProfile = jest.fn(async ({ account }: any) =>
      legacy({ id: `${account}-self` })
    );
    server.handleInstagramGetConversations = jest.fn(async ({ account }: any) =>
      legacy({
        conversations: [
          {
            id: `${account}-conversation`,
            participants: {
              data: [
                { id: `${account}-self`, username: account },
                { id: `${account}-peer`, username: `${account}-customer` },
              ],
            },
          },
        ],
      })
    );

    const result = await server.executeCanonicalTool(
      definition('social_list_conversations'),
      { readSource: 'provider' }
    );
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.data.conversations).toHaveLength(5);
    expect(result.structuredContent.meta).toMatchObject({
      source: { kind: 'providerQuery', completeness: 'partial' },
      partialErrors: [
        expect.objectContaining({
          channel: 'telegram',
          accountId: 'professional',
          code: 'provider_error',
        }),
      ],
    });
  });

  test('routes the complete Telegram forum management surface', async () => {
    const server = createServer();
    server.connectorCall = jest.fn(async () => ({ ok: true }));
    const result = await server.executeCanonicalTool(
      definition('social_manage_forum'),
      {
        channel: 'telegram',
        accountId: 'professional',
        action: 'addMembers',
        target: '-100123456',
        members: ['@alice', '1234'],
      }
    );
    expect(result.structuredContent).toMatchObject({ ok: true, status: 'accepted' });
    expect(server.connectorCall).toHaveBeenCalledWith(
      'http://tg-professional',
      'POST',
      '/api/v1/chats/-100123456/members',
      { members: ['@alice', '1234'], forwardCount: undefined }
    );
  });

  test('rejects unsupported source/provider combinations explicitly', async () => {
    const server = createServer();
    const result = await server.executeCanonicalTool(
      definition('social_list_conversations'),
      {
        channel: 'instagram',
        accountId: 'skirmshop',
        readSource: 'index',
      }
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: 'unsupported_capability' },
      },
    });
  });
});
