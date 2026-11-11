import { useTestAccounts } from '../domain/test-accounts';
import { MCPServer } from './server';
import { SOCIAL_TOOL_REGISTRY } from './tool-registry';

/**
 * fase 3 / PR-2: social_send_message's idempotencyKey keeps its Redis replay
 * AND reaches the WhatsApp connector as an `Idempotency-Key` header — one
 * derived key per sub-operation (text, each attachment), never the sendToken.
 * Without a key every call is exactly what it was.
 */
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
    set: jest.fn(async (key: string, value: string, ...args: Array<string | number>) => {
      if (args.includes('NX') && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    }),
  };
}

function createServer() {
  const server: any = Object.create(MCPServer.prototype);
  server.redisClient = fakeRedis();
  server.logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
  server.connectorSecret = 'secret';
  useTestAccounts({
    whatsapp: { personal: 'http://wa-personal', professional: 'http://wa-professional' },
    telegram: { personal: 'http://tg-personal' },
  });
  return server;
}

const KEY = /^mcp-[0-9a-f]{64}$/;

describe('social_send_message idempotencyKey → connector Idempotency-Key', () => {
  const ORIG = process.env.ENABLE_SENDING;
  const originalFetch = global.fetch;
  beforeEach(() => {
    process.env.ENABLE_SENDING = 'true';
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });
  afterAll(() => {
    if (ORIG === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = ORIG;
  });

  const send = {
    channel: 'whatsapp',
    accountId: 'professional',
    target: '34600000000@s.whatsapp.net',
    message: 'texto',
    attachments: [{ url: 'https://f/a.jpg', caption: 'a' }, { url: 'https://f/b.jpg' }],
    idempotencyKey: 'op-42',
  };

  test('derives one stable key per WhatsApp sub-operation and keeps the Redis replay', async () => {
    const server = createServer();
    server.handleSendMessage = jest.fn(async () => legacy({ messageId: 'T1' }));
    server.handleSendFile = jest.fn(async () => legacy({ sent: true, messageId: 'M1' }));

    const first = await server.executeCanonicalTool(definition('social_send_message'), send);
    expect(first.structuredContent.ok).toBe(true);

    const [, textOptions] = server.handleSendMessage.mock.calls[0];
    const [, mediaA] = server.handleSendFile.mock.calls[0];
    const [, mediaB] = server.handleSendFile.mock.calls[1];
    for (const options of [textOptions, mediaA, mediaB]) {
      expect(options.idempotencyKey).toMatch(KEY);
    }
    const keys = new Set([textOptions, mediaA, mediaB].map(o => o.idempotencyKey));
    expect(keys.size).toBe(3);
    expect([...keys].some(k => k.includes('op-42'))).toBe(false);

    // Redis replays: the connector is not called again.
    const replay = await server.executeCanonicalTool(definition('social_send_message'), send);
    expect(replay.structuredContent.meta.replayed).toBe(true);
    expect(server.handleSendMessage).toHaveBeenCalledTimes(1);
    expect(server.handleSendFile).toHaveBeenCalledTimes(2);

    // Redis lost the record: the retry carries the SAME connector keys.
    server.redisClient.values.clear();
    await server.executeCanonicalTool(definition('social_send_message'), send);
    expect(server.handleSendMessage.mock.calls[1][1]).toEqual(textOptions);
    expect(server.handleSendFile.mock.calls[2][1]).toEqual(mediaA);
    expect(server.handleSendFile.mock.calls[3][1]).toEqual(mediaB);

    // Another account or another key → other connector keys.
    server.redisClient.values.clear();
    await server.executeCanonicalTool(definition('social_send_message'), {
      ...send,
      accountId: 'personal',
    });
    expect(server.handleSendMessage.mock.calls[2][1].idempotencyKey).not.toBe(
      textOptions.idempotencyKey
    );
  });

  test('without idempotencyKey the legacy handlers keep their one-argument call', async () => {
    const server = createServer();
    server.handleSendMessage = jest.fn(async () => legacy({ messageId: 'T1' }));
    server.handleSendFile = jest.fn(async () => legacy({ sent: true }));
    const { idempotencyKey: _unused, ...plain } = send;
    await server.executeCanonicalTool(definition('social_send_message'), plain);
    expect(server.handleSendMessage.mock.calls[0]).toHaveLength(1);
    expect(server.handleSendFile.mock.calls[0]).toHaveLength(1);
  });

  test('Telegram sends never get a connector key', async () => {
    const server = createServer();
    server.handleTelegramSendMessage = jest.fn(async () => legacy({ messageId: 1 }));
    await server.executeCanonicalTool(definition('social_send_message'), {
      channel: 'telegram',
      accountId: 'personal',
      target: '-100123',
      message: 'hola',
      idempotencyKey: 'op-tg',
    });
    expect(server.handleTelegramSendMessage.mock.calls[0]).toHaveLength(1);
  });

  test('handleSendMessage puts the key in the Idempotency-Key header, the body is unchanged', async () => {
    const server = createServer();
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({ messageId: '3EB0X', sentAt: '2026-09-29T10:00:00.000Z' }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await server.handleSendMessage(
      { chatId: '34600000000@s.whatsapp.net', text: 'hola', account: 'professional' },
      { idempotencyKey: 'mcp-abc' }
    );
    await server.handleSendMessage({
      chatId: '34600000000@s.whatsapp.net',
      text: 'hola',
      account: 'professional',
    });

    const [url, keyed] = fetchMock.mock.calls[0] as unknown as [string, any];
    const [, plain] = fetchMock.mock.calls[1] as unknown as [string, any];
    expect(url).toBe('http://wa-professional/api/v1/messages/send');
    expect(keyed.headers['Idempotency-Key']).toBe('mcp-abc');
    expect('Idempotency-Key' in plain.headers).toBe(false);
    const body = JSON.parse(keyed.body);
    expect(body).not.toHaveProperty('idempotencyKey');
    expect(body.sendToken).toMatch(/^direct-\d+$/);
  });

  test('handleSendFile passes the header through connectorCall; connectorCall sends it', async () => {
    const server = createServer();
    const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ sent: true }) }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await server.handleSendFile(
      {
        conversationId: 'professional:34600000000@s.whatsapp.net',
        fileUrl: 'https://f/a.jpg',
        account: 'professional',
      },
      { idempotencyKey: 'mcp-def' }
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, any];
    expect(url).toBe('http://wa-professional/api/v1/messages/media/send');
    expect(init.headers['Idempotency-Key']).toBe('mcp-def');
    expect(JSON.parse(init.body)).toEqual({
      conversationId: '34600000000@s.whatsapp.net',
      fileUrl: 'https://f/a.jpg',
    });
  });

  test('the connector 409s map to the canonical conflict / outcome_unknown codes', async () => {
    const server = createServer();
    server.handleSendMessage = jest.fn(async () => {
      throw new Error(
        'Failed to send message: Error: Connector returned 409 (send_outcome_uncertain): unknown'
      );
    });
    const uncertain = await server.executeCanonicalTool(definition('social_send_message'), {
      channel: 'whatsapp',
      accountId: 'personal',
      target: '34600000000@s.whatsapp.net',
      message: 'hola',
      idempotencyKey: 'op-u',
    });
    expect(uncertain.structuredContent.error.code).toBe('outcome_unknown');

    server.handleSendMessage = jest.fn(async () => {
      throw new Error('Connector error 409: {"failureClass":"idempotency_key_reused"}');
    });
    const reused = await server.executeCanonicalTool(definition('social_send_message'), {
      channel: 'whatsapp',
      accountId: 'personal',
      target: '34600000000@s.whatsapp.net',
      message: 'hola',
      idempotencyKey: 'op-r',
    });
    expect(reused.structuredContent.error.code).toBe('conflict');
  });
});
