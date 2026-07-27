import { MCPServer } from './server';

function adminServer() {
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
  };
}

describe('Telegram forum topic admin tools', () => {
  it('lists topics with a clamped limit on the personal session by default', async () => {
    const { server, connectorCall } = adminServer();
    await server.handleTelegramGetTopics({ chatId: 'tg_-1003749364241' });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-personal',
      'GET',
      '/api/v1/chats/-1003749364241/topics?limit=100'
    );
  });

  it('passes the title filter and routes to the professional session', async () => {
    const { server, connectorCall } = adminServer();
    await server.handleTelegramGetTopics({
      chatId: '-1003749364241',
      limit: 5,
      query: 'orders',
      account: 'professional',
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-professional',
      'GET',
      '/api/v1/chats/-1003749364241/topics?limit=5&query=orders'
    );
  });

  it('ignores the topic part of the shorthand when listing topics', async () => {
    const { server, connectorCall } = adminServer();
    await server.handleTelegramGetTopics({ chatId: 'tg_-1003749364241_4775' });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-personal',
      'GET',
      '/api/v1/chats/-1003749364241/topics?limit=100'
    );
  });

  it('creates a topic and omits the icon when not given', async () => {
    const { server, connectorCall } = adminServer();
    await server.handleTelegramCreateTopic({
      chatId: 'tg_-1003749364241',
      title: 'nuevo topic',
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-personal',
      'POST',
      '/api/v1/chats/-1003749364241/topics',
      { title: 'nuevo topic' }
    );
  });

  it('forwards the icon colour when given', async () => {
    const { server, connectorCall } = adminServer();
    await server.handleTelegramCreateTopic({
      chatId: '-1003749364241',
      title: 'con icono',
      icon: 6633270,
      account: 'professional',
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-professional',
      'POST',
      '/api/v1/chats/-1003749364241/topics',
      { title: 'con icono', icon: 6633270 }
    );
  });

  it('rejects topic creation without a title before calling the connector', async () => {
    const { server, connectorCall } = adminServer();
    await expect(
      server.handleTelegramCreateTopic({ chatId: '-1003749364241', title: '   ' })
    ).rejects.toThrow('title is required');
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('renames a topic addressed via the tg_<chat>_<topic> shorthand', async () => {
    const { server, connectorCall } = adminServer();
    await server.handleTelegramEditTopic({
      chatId: 'tg_-1003749364241_4775',
      title: 'renombrado',
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-personal',
      'PATCH',
      '/api/v1/chats/-1003749364241/topics/4775',
      { title: 'renombrado' }
    );
  });

  it('sends only the fields present when editing a topic', async () => {
    const { server, connectorCall } = adminServer();
    await server.handleTelegramEditTopic({
      chatId: '-1003749364241',
      topicId: '4775',
      closed: true,
      account: 'professional',
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-professional',
      'PATCH',
      '/api/v1/chats/-1003749364241/topics/4775',
      { closed: true }
    );
  });

  it('rejects an edit with nothing to change', async () => {
    const { server, connectorCall } = adminServer();
    await expect(
      server.handleTelegramEditTopic({ chatId: 'tg_-1003749364241_4775' })
    ).rejects.toThrow('at least one of title, closed, hidden or clearIcon is required');
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('rejects topic admin calls with no topic id at all', async () => {
    const { server, connectorCall } = adminServer();
    await expect(
      server.handleTelegramEditTopic({ chatId: '-1003749364241', title: 'x' })
    ).rejects.toThrow('topicId is required');
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('rejects a non positive integer topic id', async () => {
    const { server, connectorCall } = adminServer();
    await expect(
      server.handleTelegramEditTopic({ chatId: '-1003749364241', topicId: '0', title: 'x' })
    ).rejects.toThrow('topicId must be a positive integer');
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('closes a topic', async () => {
    const { server, connectorCall } = adminServer();
    await server.handleTelegramToggleTopicClosed({
      chatId: 'tg_-1003749364241_4775',
      closed: true,
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-personal',
      'POST',
      '/api/v1/chats/-1003749364241/topics/4775/closed',
      { closed: true }
    );
  });

  it('rejects a close toggle without a boolean', async () => {
    const { server, connectorCall } = adminServer();
    await expect(
      server.handleTelegramToggleTopicClosed({ chatId: 'tg_-1003749364241_4775' } as any)
    ).rejects.toThrow('closed must be a boolean');
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('pins a topic', async () => {
    const { server, connectorCall } = adminServer();
    await server.handleTelegramToggleTopicPinned({
      chatId: '-1003749364241',
      topicId: 4775,
      pinned: true,
      account: 'professional',
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-professional',
      'POST',
      '/api/v1/chats/-1003749364241/topics/4775/pinned',
      { pinned: true }
    );
  });

  it('deletes a topic with the id in the path and no body', async () => {
    const { server, connectorCall } = adminServer();
    await server.handleTelegramDeleteTopic({ chatId: 'tg_-1003749364241_4775' });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-personal',
      'DELETE',
      '/api/v1/chats/-1003749364241/topics/4775'
    );
  });
});

describe('Telegram group admin tools', () => {
  it('enables forum mode with the default threads mode omitted', async () => {
    const { server, connectorCall } = adminServer();
    await server.handleTelegramUpdateForumSettings({
      chatId: 'tg_-1003749364241',
      isForum: true,
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-personal',
      'POST',
      '/api/v1/chats/-1003749364241/forum-settings',
      { isForum: true }
    );
  });

  it('forwards threadsMode when given', async () => {
    const { server, connectorCall } = adminServer();
    await server.handleTelegramUpdateForumSettings({
      chatId: '-1003749364241',
      isForum: true,
      threadsMode: 'tabs',
      account: 'professional',
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-professional',
      'POST',
      '/api/v1/chats/-1003749364241/forum-settings',
      { isForum: true, threadsMode: 'tabs' }
    );
  });

  it('rejects forum settings without a boolean isForum', async () => {
    const { server, connectorCall } = adminServer();
    await expect(
      server.handleTelegramUpdateForumSettings({ chatId: '-1003749364241' } as any)
    ).rejects.toThrow('isForum must be a boolean');
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('sets the chat title', async () => {
    const { server, connectorCall } = adminServer();
    await server.handleTelegramSetChatTitle({
      chatId: 'tg_-1003749364241',
      title: 'Ops',
      account: 'professional',
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-professional',
      'PATCH',
      '/api/v1/chats/-1003749364241/title',
      { title: 'Ops' }
    );
  });

  it('rejects a blank chat title', async () => {
    const { server, connectorCall } = adminServer();
    await expect(
      server.handleTelegramSetChatTitle({ chatId: '-1003749364241', title: '  ' })
    ).rejects.toThrow('title is required');
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('accepts an empty description as a clear', async () => {
    const { server, connectorCall } = adminServer();
    await server.handleTelegramSetChatDescription({
      chatId: '-1003749364241',
      description: '',
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-personal',
      'PATCH',
      '/api/v1/chats/-1003749364241/description',
      { description: '' }
    );
  });

  it('sets the chat photo and omits the default type', async () => {
    const { server, connectorCall } = adminServer();
    await server.handleTelegramSetChatPhoto({
      chatId: 'tg_-1003749364241',
      filePath: 'https://example.invalid/logo.png',
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-personal',
      'PATCH',
      '/api/v1/chats/-1003749364241/photo',
      { filePath: 'https://example.invalid/logo.png' }
    );
  });

  it('forwards the video type when given', async () => {
    const { server, connectorCall } = adminServer();
    await server.handleTelegramSetChatPhoto({
      chatId: '-1003749364241',
      filePath: '/tmp/avatar.mp4',
      type: 'video',
      account: 'professional',
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-professional',
      'PATCH',
      '/api/v1/chats/-1003749364241/photo',
      { filePath: '/tmp/avatar.mp4', type: 'video' }
    );
  });

  it('rejects a chat photo without a file path', async () => {
    const { server, connectorCall } = adminServer();
    await expect(
      server.handleTelegramSetChatPhoto({ chatId: '-1003749364241', filePath: '' })
    ).rejects.toThrow('filePath is required');
    expect(connectorCall).not.toHaveBeenCalled();
  });
});
