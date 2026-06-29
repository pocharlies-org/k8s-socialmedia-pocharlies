import { MCPServer } from './server';

function topicServer() {
  const server = Object.create(MCPServer.prototype) as MCPServer;
  const anyServer = server as any;
  anyServer.tgUrls = {
    personal: 'http://telegram-personal',
    professional: 'http://telegram-professional',
  };
  anyServer.connectorCall = jest.fn(async () => ({ success: true }));
  anyServer.dbClient = {
    query: jest.fn(async () => ({ rows: [] })),
  };
  return {
    server: anyServer,
    connectorCall: anyServer.connectorCall as jest.Mock,
    query: anyServer.dbClient.query as jest.Mock,
  };
}

describe('Telegram topic MCP helpers', () => {
  it('parses tg_<chat>_<topic> shorthand without leaking the topic into the connector chat id', () => {
    const { server } = topicServer();
    expect(server.telegramTopicTarget('tg_-1003749364241_4775')).toEqual({
      chatId: '-1003749364241',
      topicId: 4775,
    });
  });

  it('resolves tg_<chat>_<topic> to the base DB conversation id', async () => {
    const { server } = topicServer();
    await expect(server.resolveTelegramChatId('tg_-1003749364241_4775', 'personal')).resolves.toBe(
      'tg_-1003749364241'
    );
  });

  it('sends Telegram messages to a real forum topic', async () => {
    const { server, connectorCall } = topicServer();
    await server.handleTelegramSendMessage({
      chatId: 'tg_-1003749364241_4775',
      text: 'hola topic',
      account: 'personal',
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-personal',
      'POST',
      '/api/v1/messages/-1003749364241',
      { text: 'hola topic', topicId: 4775 }
    );
  });

  it('preserves replyTo while sending into a topic', async () => {
    const { server, connectorCall } = topicServer();
    await server.handleTelegramSendMessage({
      chatId: '-1003749364241',
      topicId: '4775',
      replyTo: '4777',
      text: 'reply in topic',
      account: 'professional',
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-professional',
      'POST',
      '/api/v1/messages/-1003749364241',
      { text: 'reply in topic', topicId: 4775, replyTo: 4777 }
    );
  });

  it('clicks a real Telegram callback button through the connector', async () => {
    const { server, connectorCall } = topicServer();
    await server.handleTelegramClickButton({
      chatId: 'tg_-1003749364241_4775',
      messageId: '4777',
      data: 'draft:send:-1003749364241:4775',
      fireAndForget: true,
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-personal',
      'POST',
      '/api/v1/messages/callback',
      {
        chatId: '-1003749364241',
        messageId: 4777,
        data: 'draft:send:-1003749364241:4775',
        timeoutMs: 10000,
        fireAndForget: true,
      }
    );
  });

  it('rejects callback clicks without a message id before calling the connector', async () => {
    const { server, connectorCall } = topicServer();
    await expect(
      server.handleTelegramClickButton({
        chatId: 'tg_-1003749364241_4775',
        data: 'draft:send:-1003749364241:4775',
      })
    ).rejects.toThrow('messageId is required');
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('adds topic predicates to Telegram DB search', async () => {
    const { server, query } = topicServer();
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          conversation_id: 'tg_-1003749364241',
          sender_wa_id: 'tg_1',
          direction: 'INBOUND',
          content: 'ping',
          wa_timestamp: new Date('2026-06-29T00:00:00Z'),
          reply_to_message_id: null,
          metadata: { topic_id: 4775 },
        },
      ],
    });

    await server.handleTelegramSearch({
      query: 'ping',
      chatId: 'tg_-1003749364241_4775',
      account: 'personal',
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("metadata->>'topic_id'");
    expect(sql).toContain('reply_to_message_id = ($4 ||');
    expect(params).toEqual(['%ping%', 20, 'personal', 'tg_-1003749364241', '4775']);
  });
});
