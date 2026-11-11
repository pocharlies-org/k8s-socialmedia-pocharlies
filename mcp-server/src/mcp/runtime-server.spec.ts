import { createMcpServer } from './runtime-server';

jest.mock('./server', () => ({
  MCPServer: jest.fn(),
}));

import { MCPServer } from './server';

describe('createMcpServer', () => {
  it('passes the shared runtime configuration in constructor order', () => {
    const db = {} as any;
    const redis = {} as any;
    const config = {
      databaseUrl: 'postgres://db',
      redisUrl: 'redis://cache',
      redisTlsCa: undefined,
      openaiApiKey: 'openai',
      llmBaseUrl: 'http://llm',
      llmChatModel: 'model',
      encryptionKey: 'encryption',
      connectorSharedSecret: 'connector',
      connectorUrl: 'http://connector',
    };

    createMcpServer(db, redis, config);

    expect(MCPServer).toHaveBeenCalledWith(
      db,
      redis,
      'openai',
      'encryption',
      'connector',
      'http://connector',
      'redis://cache',
      'http://llm',
      'model'
    );
  });

  it('passes empty optional model settings as undefined', () => {
    (MCPServer as jest.Mock).mockClear();
    createMcpServer({} as any, {} as any, {
      databaseUrl: 'postgres://db',
      redisUrl: 'redis://cache',
      openaiApiKey: '',
      llmBaseUrl: '',
      llmChatModel: '',
      encryptionKey: 'encryption',
      connectorSharedSecret: 'connector',
      connectorUrl: 'http://connector',
    });
    expect(MCPServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '',
      'encryption',
      'connector',
      'http://connector',
      'redis://cache',
      undefined,
      undefined
    );
  });
});
