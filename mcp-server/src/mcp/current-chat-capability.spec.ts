import { createHmac } from 'node:crypto';
import { verifyCurrentChatCapability } from './current-chat-capability';
import { MCPServer } from './server';
import { SOCIAL_TOOL_REGISTRY } from './tool-registry';

const SECRET = 'test-secret-for-current-chat';
const CHAT = 'personal:123456789@s.whatsapp.net';
const TURN = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';

function capability(overrides: Record<string, unknown> = {}, secret = SECRET): string {
  const value: Record<string, any> = {
      account: 'personal',
      chat: CHAT,
      exp: Math.floor(Date.now() / 1000) + 120,
      ops: ['read', 'propose'],
      turn: TURN,
      ...overrides,
    };
  if (Array.isArray(value.ops) && value.ops.includes('send') && value.requestId === undefined) value.requestId = REQUEST_ID;
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

function tool(name: string) {
  const found = SOCIAL_TOOL_REGISTRY.find(item => item.name === name);
  if (!found) throw new Error(`Missing tool: ${name}`);
  return found;
}

function server(): any {
  const instance: any = Object.create(MCPServer.prototype);
  const entries = new Map<string, string>();
  let activeTurn = TURN;
  instance.setActiveTurn = (turn: string) => { activeTurn = turn; };
  instance.redisClient = {
    get: jest.fn(async (key: string) =>
      key.startsWith('social:hermes:active:') ? activeTurn : (entries.get(key) ?? null)
    ),
    set: jest.fn(async (key: string, value: string, ...options: unknown[]) => {
      if (options.includes('NX') && entries.has(key)) return null;
      entries.set(key, value);
      return 'OK';
    }),
    eval: jest.fn(async (_script: string, _keys: number, ...args: unknown[]) => {
      const proposal = JSON.parse(String(args[6]));
      entries.set(`social:hermes:proposal:${proposal.id}`, JSON.stringify(proposal));
      return ['created', proposal.id];
    }),
  };
  instance.logger = { error: jest.fn() };
  instance.waUrls = { personal: 'http://wa-personal' };
  return instance;
}

describe('Hermes current-chat capability', () => {
  const previous = { ...process.env };
  beforeEach(() => {
    process.env.HERMES_CHAT_TOOL_SECRET = SECRET;
    process.env.ENABLE_SENDING = 'false';
    process.env.HERMES_CHAT_ALLOW_PROPOSALS = 'true';
    process.env.HERMES_CHAT_ALLOW_DIRECT_SEND = 'true';
    delete process.env.EMERGENCY_DISABLE_SENDING;
  });
  afterAll(() => {
    process.env = previous;
  });

  test('rejects forged, expired, future, wrong-account and read-only send tokens', () => {
    expect(() => verifyCurrentChatCapability(capability({}, 'wrong'), 'read')).toThrow();
    expect(() =>
      verifyCurrentChatCapability(capability({ exp: Math.floor(Date.now() / 1000) - 1 }), 'read')
    ).toThrow();
    expect(() =>
      verifyCurrentChatCapability(capability({ exp: Math.floor(Date.now() / 1000) + 301 }), 'read')
    ).toThrow();
    expect(() =>
      verifyCurrentChatCapability(capability({ account: 'skirmshop' }), 'read')
    ).toThrow();
    expect(() =>
      verifyCurrentChatCapability(
        capability({ chat: 'professional:123456789@s.whatsapp.net' }),
        'read'
      )
    ).toThrow();
    expect(() => verifyCurrentChatCapability(capability({ ops: ['read'] }), 'propose')).toThrow();
    expect(() => verifyCurrentChatCapability(capability({ ops: ['read', 'propose'] }), 'send')).toThrow();
    expect(() => verifyCurrentChatCapability(capability({ ops: undefined }), 'read')).toThrow();
    const signed = capability();
    const [payload, signature] = signed.split('.');
    const forgedPayload = Buffer.from(
      Buffer.from(payload, 'base64url').toString('utf8').replace(CHAT, '999999999@s.whatsapp.net')
    ).toString('base64url');
    expect(() => verifyCurrentChatCapability(`${forgedPayload}.${signature}`, 'read')).toThrow();
  });

  test('reads and proposes only for the signed chat and rejects model-selected destinations', async () => {
    const instance = server();
    instance.resolveCurrentChatReadScope = jest.fn(async () => ({
      chatId: CHAT,
      conversationIds: [CHAT],
    }));
    instance.handleWhatsAppGetMessages = jest.fn(async (args: unknown) => ({
      content: [{ type: 'text', text: JSON.stringify({ args }) }],
    }));
    const token = capability();
    const read = await instance.executeCanonicalTool(tool('social_read_current_chat'), {
      capability: token,
      limit: 5,
    });
    expect(read.structuredContent.ok).toBe(true);
    expect(instance.handleWhatsAppGetMessages).toHaveBeenCalledWith({
      account: 'personal',
      chatId: CHAT,
      conversationIds: [CHAT],
      limit: 5,
    });

    const send = await instance.executeCanonicalTool(tool('social_send_current_chat'), {
      capability: token,
      text: 'Hello',
      idempotencyKey: 'turn-1',
    });
    expect(send.structuredContent.ok).toBe(true);
    expect(send.structuredContent.data).toMatchObject({
      account: 'personal',
      chat: CHAT,
      turn: TURN,
      text: 'Hello',
      requiresOwnerApproval: true,
    });
    expect(() =>
      instance.validateCanonicalArguments(tool('social_send_current_chat'), {
        capability: token,
        text: 'Hello',
        idempotencyKey: 'turn-2',
        target: 'attacker@s.whatsapp.net',
      })
    ).toThrow();
  });

  test('current-chat read combines only the uniquely linked PN and LID rows', async () => {
    const instance = server();
    const lid = 'personal:777@lid';
    const pn = 'personal:34600123456@c.us';
    const providerPn = 'personal:34600123456@s.whatsapp.net';
    const conversations = [
      { id: lid, account: 'personal', wa_chat_id: providerPn, is_group: false },
      { id: pn, account: 'personal', wa_chat_id: null, is_group: false },
      {
        id: 'personal:888@lid',
        account: 'personal',
        wa_chat_id: 'personal:34600999999@s.whatsapp.net',
        is_group: false,
      },
      { id: 'secondary:999@lid', account: 'secondary', wa_chat_id: providerPn, is_group: false },
    ];
    const messages = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        conversation_id: lid,
        account: 'personal',
        content: 'LID history',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        conversation_id: pn,
        account: 'personal',
        content: 'PN history',
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        conversation_id: 'secondary:999@lid',
        account: 'secondary',
        content: 'Other account',
      },
    ];
    const normalize = (id: string) => id.replace(/@c\.us$/, '@s.whatsapp.net');
    instance.dbClient = {
      query: jest.fn(async (sql: string, args: unknown[]) => {
        if (sql.includes('FROM conversations WHERE'))
          return {
            rows: conversations.filter(row => row.account === args[0] && row.id === args[1]),
          };
        if (sql.includes('SELECT lid.id, lid.wa_chat_id'))
          return {
            rows: conversations.filter(
              row =>
                row.account === args[0] &&
                row.id.endsWith('@lid') &&
                normalize(row.wa_chat_id || '') === normalize(String(args[1]))
            ),
          };
        if (sql.includes('SELECT pn.id FROM conversations pn'))
          return {
            rows: conversations
              .filter(
                row =>
                  row.account === args[0] &&
                  /\d+@(?:c\.us|s\.whatsapp\.net)$/.test(row.id) &&
                  normalize(row.id) === normalize(String(args[1]))
              )
              .map(row => ({ id: row.id })),
          };
        if (sql.includes('FROM messages'))
          return {
            rows: messages.filter(
              row => row.account === args[1] && (args[0] as string[]).includes(row.conversation_id)
            ),
          };
        if (sql.includes('FROM attachments')) return { rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const read = await instance.executeCanonicalTool(tool('social_read_current_chat'), {
      capability: capability({ chat: pn }),
      limit: 10,
    });
    expect(read.structuredContent.ok).toBe(true);
    expect(read.structuredContent.data).toMatchObject({ chatId: lid, count: 2 });
    expect(
      read.structuredContent.data.messages.map((row: { content: string }) => row.content)
    ).toEqual(['LID history', 'PN history']);
    const messageQuery = instance.dbClient.query.mock.calls.find(([sql]: [string]) =>
      sql.includes('FROM messages')
    );
    expect(messageQuery[1].slice(0, 2)).toEqual([[lid, pn], 'personal']);

    conversations.push({
      id: 'personal:999@lid',
      account: 'personal',
      wa_chat_id: providerPn,
      is_group: false,
    });
    const ambiguous = await instance.executeCanonicalTool(tool('social_read_current_chat'), {
      capability: capability({ chat: pn }),
      limit: 10,
    });
    expect(ambiguous.structuredContent.ok).toBe(true);
    expect(ambiguous.structuredContent.data).toMatchObject({ chatId: pn, count: 1 });
    expect(ambiguous.structuredContent.data.messages[0].content).toBe('PN history');
  });

  test('blocks proposals when disabled or emergency stopped', async () => {
    const instance = server();
    const token = capability();
    const args = { capability: token, text: 'Hello', idempotencyKey: 'turn-3' };
    process.env.HERMES_CHAT_ALLOW_PROPOSALS = 'false';
    const disabled = await instance.executeCanonicalTool(tool('social_send_current_chat'), args);
    expect(disabled.structuredContent.ok).toBe(false);
    process.env.HERMES_CHAT_ALLOW_PROPOSALS = 'true';
    process.env.EMERGENCY_DISABLE_SENDING = 'true';
    const emergency = await instance.executeCanonicalTool(tool('social_send_current_chat'), args);
    expect(emergency.structuredContent.ok).toBe(false);
    expect(instance.redisClient.eval).not.toHaveBeenCalled();
  });

  test('does not replay a proposal after its capability expires', async () => {
    const instance = server();
    const args = { capability: capability(), text: 'Hello', idempotencyKey: 'turn-5' };
    const first = await instance.executeCanonicalTool(tool('social_send_current_chat'), args);
    expect(first.structuredContent.ok).toBe(true);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 301_000);
    try {
      await expect(
        instance.executeCanonicalTool(tool('social_send_current_chat'), args)
      ).rejects.toThrow('Invalid current-chat capability');
      expect(instance.redisClient.eval).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  test('global sending stays disabled while a proposal never calls the connector', async () => {
    const instance = server();
    const connector = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ messageId: 'fake-message' }),
    } as Response);
    try {
      const generic = await instance.executeCanonicalTool(tool('social_send_message'), {
        channel: 'whatsapp',
        accountId: 'personal',
        target: CHAT,
        message: 'No',
      });
      expect(generic.structuredContent.ok).toBe(false);
      const scoped = await instance.executeCanonicalTool(tool('social_send_current_chat'), {
        capability: capability(),
        text: 'Yes',
        idempotencyKey: 'turn-4',
      });
      expect(scoped.structuredContent.ok).toBe(true);
      expect(connector).not.toHaveBeenCalled();
    } finally {
      connector.mockRestore();
    }
  });

  test('direct delivery uses the signed chat and one durable send token on replay', async () => {
    const instance = server();
    instance.resolveCurrentChatReadScope = jest.fn(async (_account: string, chat: string) => ({ chatId: chat, conversationIds: [chat] }));
    instance.handleSendMessage = jest.fn(async () => ({
      content: [{ type: 'text', text: JSON.stringify({ messageId: 'confirmed-id' }) }],
    }));
    const args = { capability: capability({ ops: ['read', 'propose', 'send'] }), text: 'Enviado' };
    const first = await instance.executeCanonicalTool(tool('social_deliver_current_chat'), args);
    instance.setActiveTurn('33333333-3333-4333-8333-333333333333');
    const replay = await instance.executeCanonicalTool(tool('social_deliver_current_chat'), {
      ...args, capability: capability({ ops: ['read', 'send'], turn: '33333333-3333-4333-8333-333333333333' }),
    });
    expect(first.structuredContent.ok).toBe(true);
    expect(replay.structuredContent.ok).toBe(true);
    expect(instance.handleSendMessage).toHaveBeenCalledTimes(1);
    expect(instance.handleSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      account: 'personal', chatId: '123456789@s.whatsapp.net', text: 'Enviado',
      scopedSendToken: expect.stringMatching(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
    }));
    const conflict = await instance.executeCanonicalTool(tool('social_deliver_current_chat'), {
      capability: capability({ ops: ['read', 'send'], turn: '33333333-3333-4333-8333-333333333333' }), text: 'Otro texto',
    });
    expect(conflict.structuredContent.ok).toBe(false);
    expect(instance.handleSendMessage).toHaveBeenCalledTimes(1);
    const otherAccount = await instance.executeCanonicalTool(tool('social_deliver_current_chat'), {
      capability: capability({ account: 'professional', chat: 'professional:987654321@s.whatsapp.net', ops: ['read', 'send'], turn: '33333333-3333-4333-8333-333333333333' }),
      text: 'Enviado',
    });
    expect(otherAccount.structuredContent.ok).toBe(true);
    expect(instance.handleSendMessage).toHaveBeenCalledTimes(2);
    expect(instance.handleSendMessage.mock.calls[1][0]).toMatchObject({ account: 'professional', chatId: '987654321@s.whatsapp.net' });
    expect(instance.handleSendMessage.mock.calls[1][0].scopedSendToken).not.toBe(instance.handleSendMessage.mock.calls[0][0].scopedSendToken);
  });

  test('direct delivery requires a live send grant and honors the emergency switch', async () => {
    const instance = server();
    instance.handleSendMessage = jest.fn();
    const args = { capability: capability(), text: 'No enviar' };
    await expect(instance.executeCanonicalTool(tool('social_deliver_current_chat'), args)).rejects.toThrow('Invalid current-chat capability');
    const granted = { ...args, capability: capability({ ops: ['read', 'send'] }) };
    process.env.HERMES_CHAT_ALLOW_DIRECT_SEND = 'false';
    expect((await instance.executeCanonicalTool(tool('social_deliver_current_chat'), granted)).structuredContent.ok).toBe(false);
    process.env.HERMES_CHAT_ALLOW_DIRECT_SEND = 'true';
    process.env.EMERGENCY_DISABLE_SENDING = 'true';
    expect((await instance.executeCanonicalTool(tool('social_deliver_current_chat'), granted)).structuredContent.ok).toBe(false);
    expect(instance.handleSendMessage).not.toHaveBeenCalled();
  });

  test('direct connector delivery remains idempotent after a lost response', async () => {
    const instance = server();
    process.env.CONNECTOR_SHARED_SECRET = 'fixture-connector-secret';
    instance.authHeaders = jest.fn(() => ({}));
    instance.resolveCurrentChatReadScope = jest.fn(async () => ({ chatId: CHAT, conversationIds: [CHAT] }));
    const connector = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('response lost'));
    const args = { capability: capability({ ops: ['read', 'send'] }), text: 'Solo una vez' };
    try {
      const first = await instance.executeCanonicalTool(tool('social_deliver_current_chat'), args);
      const replay = await instance.executeCanonicalTool(tool('social_deliver_current_chat'), args);
      expect(first.structuredContent.ok).toBe(false);
      expect(replay.structuredContent.ok).toBe(false);
      expect(connector).toHaveBeenCalledTimes(1);
      const [url, options] = connector.mock.calls[0];
      expect(url).toBe('http://wa-personal/api/v1/messages/send');
      expect(JSON.parse(String(options?.body))).toMatchObject({
        conversationId: '123456789@s.whatsapp.net', content: 'Solo una vez',
        sendToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
    } finally {
      connector.mockRestore();
      delete process.env.CONNECTOR_SHARED_SECRET;
    }
  });
});
