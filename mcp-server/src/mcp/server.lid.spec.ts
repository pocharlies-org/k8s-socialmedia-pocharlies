import {
  isLidJid,
  normalizeDirectWhatsAppJid,
  resolveProfessionalSendTarget as resolveAccountSendTarget,
  MCPServer,
} from './server';

const resolveProfessionalSendTarget = (id: unknown, evidence = {}) => resolveAccountSendTarget(id, evidence, 'professional');

describe('isLidJid', () => {
  it('detects bare @lid and @hosted.lid jids', () => {
    expect(isLidJid('198517716955152@lid')).toBe(true);
    expect(isLidJid('198517716955152@hosted.lid')).toBe(true);
  });

  it('detects @lid jids that carry the professional account prefix', () => {
    expect(isLidJid('professional:198517716955152@lid')).toBe(true);
  });

  it('is false for phones, @c.us, @s.whatsapp.net and groups', () => {
    expect(isLidJid('34660242739')).toBe(false);
    expect(isLidJid('34660242739@c.us')).toBe(false);
    expect(isLidJid('34660242739@s.whatsapp.net')).toBe(false);
    expect(isLidJid('123456789-987654321@g.us')).toBe(false);
    expect(isLidJid(undefined)).toBe(false);
    expect(isLidJid(34660242739)).toBe(false);
  });
});

describe('normalizeDirectWhatsAppJid (legacy phone behavior unchanged)', () => {
  it('normalizes a bare phone to @s.whatsapp.net', () => {
    expect(normalizeDirectWhatsAppJid('34660242739')).toBe('34660242739@s.whatsapp.net');
  });

  it('normalizes a @c.us jid to @s.whatsapp.net', () => {
    expect(normalizeDirectWhatsAppJid('34660242739@c.us')).toBe('34660242739@s.whatsapp.net');
  });

  it('keeps an @s.whatsapp.net jid as @s.whatsapp.net', () => {
    expect(normalizeDirectWhatsAppJid('34660242739@s.whatsapp.net')).toBe(
      '34660242739@s.whatsapp.net'
    );
  });

  it('drops a PN device suffix without treating the device number as part of the phone', () => {
    expect(normalizeDirectWhatsAppJid('34660242739:2@s.whatsapp.net')).toBe('34660242739@s.whatsapp.net');
  });

  it('prefixes a 9-digit Spanish mobile with 34', () => {
    expect(normalizeDirectWhatsAppJid('660242739')).toBe('34660242739@s.whatsapp.net');
  });

  it('rejects group jids and out-of-range ids', () => {
    expect(normalizeDirectWhatsAppJid('123456789-987654321@g.us')).toBeNull();
    expect(normalizeDirectWhatsAppJid('123')).toBeNull();
    expect(normalizeDirectWhatsAppJid('198517716955152@lid')).toBeNull();
    expect(normalizeDirectWhatsAppJid('198517716955152@hosted.lid')).toBeNull();
    expect(normalizeDirectWhatsAppJid('198517716955152@unknown')).toBeNull();
    expect(normalizeDirectWhatsAppJid('foreign:35796658668')).toBeNull();
  });
});

describe('resolveProfessionalSendTarget', () => {
  it('keeps a bare @lid under the @lid key', () => {
    expect(resolveProfessionalSendTarget('198517716955152@lid')).toEqual({
      lookupKey: 'professional:198517716955152@lid',
      lookupKeys: ['professional:198517716955152@lid'],
      sendJid: '198517716955152@lid',
    });
  });

  it('keeps a @hosted.lid jid under the @hosted.lid key too', () => {
    expect(resolveProfessionalSendTarget('198517716955152@hosted.lid')).toEqual({
      lookupKey: 'professional:198517716955152@hosted.lid',
      lookupKeys: ['professional:198517716955152@hosted.lid'],
      sendJid: '198517716955152@hosted.lid',
    });
  });

  it('strips an already-prefixed professional @lid before re-keying (no double prefix)', () => {
    expect(resolveProfessionalSendTarget('professional:198517716955152@lid')).toEqual({
      lookupKey: 'professional:198517716955152@lid',
      lookupKeys: ['professional:198517716955152@lid'],
      sendJid: '198517716955152@lid',
    });
  });

  it('ignores caller phone evidence for an @lid destination', () => {
    expect(
      resolveProfessionalSendTarget('198517716955152@lid', {
        phone: '35796658668',
        phoneE164: '+35796658668',
        manualOpenUrl: 'https://wa.me/35796658668?text=hello',
      })
    ).toEqual({
      lookupKey: 'professional:198517716955152@lid',
      lookupKeys: ['professional:198517716955152@lid'],
      sendJid: '198517716955152@lid',
    });
  });

  it('rejects a destination prefixed for another account', () => {
    expect(resolveProfessionalSendTarget('personal:198517716955152@lid')).toBeNull();
    expect(resolveProfessionalSendTarget('personal:35796658668@s.whatsapp.net')).toBeNull();
  });

  it('(b) normalizes a bare phone to @s.whatsapp.net under the professional key', () => {
    expect(resolveProfessionalSendTarget('34660242739')).toEqual({
      lookupKey: 'professional:34660242739@s.whatsapp.net',
      lookupKeys: ['professional:34660242739@s.whatsapp.net'],
      sendJid: '34660242739@s.whatsapp.net',
    });
  });

  it('(b) normalizes a @c.us jid to @s.whatsapp.net under the professional key', () => {
    expect(resolveProfessionalSendTarget('34660242739@c.us')).toEqual({
      lookupKey: 'professional:34660242739@s.whatsapp.net',
      lookupKeys: ['professional:34660242739@s.whatsapp.net'],
      sendJid: '34660242739@s.whatsapp.net',
    });
  });

  it('returns null for ids that are neither @lid nor a normalizable phone', () => {
    expect(resolveProfessionalSendTarget('123456789-987654321@g.us')).toBeNull();
    expect(resolveProfessionalSendTarget('123')).toBeNull();
    expect(resolveProfessionalSendTarget(undefined)).toBeNull();
  });
});

describe('requireProfessionalInboundChat gate (DB-backed)', () => {
  // Build an MCPServer without running the heavy constructor, injecting only the
  // fake dbClient the gate uses. The gate is a private method exercised via a
  // typed bracket-access cast.
  function gateWith(queryImpl: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>) {
    const server = Object.create(MCPServer.prototype) as MCPServer;
    (server as unknown as { dbClient: { query: typeof queryImpl } }).dbClient = {
      query: jest.fn(queryImpl),
    };
    return {
      server,
      call: (
        chatId: string,
        evidence: { phone?: string; phoneE164?: string; manualOpenUrl?: string } = {},
        account = 'professional'
      ) =>
        (
          server as unknown as {
            requireProfessionalInboundChat: (
              id: string,
              evidence?: { phone?: string; phoneE164?: string; manualOpenUrl?: string },
              account?: string
            ) => Promise<string>;
          }
        ).requireProfessionalInboundChat(chatId, evidence, account),
      query: (server as unknown as { dbClient: { query: jest.Mock } }).dbClient.query,
    };
  }

  it('@lid with inbound sends to the same LID despite conflicting caller phone fields', async () => {
    const { call, query } = gateWith(async () => ({ rows: [{ id: 'professional:198517716955152@lid' }] }));
    await expect(call('198517716955152@lid', {
      phone: '11111111111', phoneE164: '+22222222222', manualOpenUrl: 'https://wa.me/33333333333',
    })).resolves.toBe('198517716955152@lid');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('m.direction = \'INBOUND\''), [
      ['professional:198517716955152@lid'], 'professional', null,
    ]);
    expect(query.mock.calls[0][0]).not.toContain('wa_chat_id');
  });

  it('@lid without inbound blocks even when caller supplies a phone with its own inbound', async () => {
    const { call, query } = gateWith(async () => ({ rows: [] }));
    await expect(call('198517716955152@lid', { phone: '35796658668' })).rejects.toThrow(
      /only allowed after the customer has sent an inbound message/
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      ['professional:198517716955152@lid'], 'professional', null,
    ]);
  });

  it('bare phone with an inbound returns the normalized @s.whatsapp.net jid', async () => {
    const { call, query } = gateWith(async () => ({
      rows: [{ id: 'professional:34660242739@s.whatsapp.net' }],
    }));
    await expect(call('34660242739')).resolves.toBe('34660242739@s.whatsapp.net');
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      ['professional:34660242739@s.whatsapp.net', 'professional:34660242739@c.us'],
      'professional', '+34660242739',
    ]);
  });

  it('bare phone routes to an inbound LID with provider PN metadata, even without wa_chat_id', async () => {
    const { call, query } = gateWith(async (sql, params) => {
      expect(sql).toContain("m.metadata->>'senderPnE164' = $3");
      expect(sql).not.toContain('wa_chat_id');
      expect(params).toEqual([
        ['professional:35796658668@s.whatsapp.net', 'professional:35796658668@c.us'],
        'professional', '+35796658668',
      ]);
      return { rows: [{ id: 'professional:79723233333251@lid' }] };
    });
    await expect(call('35796658668')).resolves.toBe('79723233333251@lid');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('prefers an exact PN inbound over a LID metadata match', async () => {
    const { call } = gateWith(async () => ({ rows: [
      { id: 'professional:79723233333251@lid' },
      { id: 'professional:35796658668@s.whatsapp.net' },
    ] }));
    await expect(call('35796658668')).resolves.toBe('35796658668@s.whatsapp.net');
  });

  it('blocks an ambiguous PN mapped by inbound messages from two LIDs', async () => {
    const { call } = gateWith(async () => ({ rows: [
      { id: 'professional:79723233333251@lid' },
      { id: 'professional:88888888888888@lid' },
    ] }));
    await expect(call('35796658668')).rejects.toThrow(/only allowed after/);
  });

  it('bare phone rejects a LID whose only mapping is wa_chat_id', async () => {
    const { call, query } = gateWith(async () => ({ rows: [] }));
    await expect(call('35796658668')).rejects.toThrow(/only allowed after/);
    expect(query.mock.calls[0][0]).not.toContain('wa_chat_id');
  });

  it('does not use another account inbound for the same LID or PN', async () => {
    const { call, query } = gateWith(async (_sql, params) => ({
      rows: params[1] === 'personal' && (params[0] as string[]).includes('198517716955152@lid')
        ? [{ id: '198517716955152@lid' }]
        : [],
    }));
    await expect(call('198517716955152@lid', {}, 'professional')).rejects.toThrow(/only allowed after/);
    await expect(call('35796658668', {}, 'professional')).rejects.toThrow(/only allowed after/);
    await expect(call('198517716955152@lid', {}, 'personal')).resolves.toBe('198517716955152@lid');
    expect(query.mock.calls.map(([, params]) => params[1])).toEqual(['professional', 'professional', 'personal']);
    expect(query.mock.calls[0][1][0]).toEqual(['professional:198517716955152@lid']);
    expect(query.mock.calls[1][1][0]).toEqual([
      'professional:35796658668@s.whatsapp.net', 'professional:35796658668@c.us',
    ]);
    expect(query.mock.calls[0][0]).toContain('m.account = $2');
    expect(query.mock.calls[0][0]).toContain('c.account = $2');
  });

  it('bare phone with NO inbound throws the guard error with a wa.me manual fallback', async () => {
    const { call } = gateWith(async () => ({ rows: [] }));
    await expect(call('34660242739')).rejects.toThrow(/Manual fallback: https:\/\/wa\.me\/34660242739/);
  });

  it('rejects an unusable id before touching the DB', async () => {
    const { call, query } = gateWith(async () => ({ rows: [] }));
    await expect(call('123456789-987654321@g.us')).rejects.toThrow(
      /valid individual phone or WhatsApp chat ID/
    );
    expect(query).not.toHaveBeenCalled();
  });
});

describe('handleSendMessage professional @lid + phone fallback behavior', () => {
  const originalEnableSending = process.env.ENABLE_SENDING;
  const originalEmergencyDisable = process.env.EMERGENCY_DISABLE_SENDING;
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalEnableSending === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = originalEnableSending;
    if (originalEmergencyDisable === undefined) delete process.env.EMERGENCY_DISABLE_SENDING;
    else process.env.EMERGENCY_DISABLE_SENDING = originalEmergencyDisable;
    global.fetch = originalFetch;
  });

  function sendServer(queryImpl: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>) {
    const server = Object.create(MCPServer.prototype) as MCPServer;
    const query = jest.fn(queryImpl);
    const logger = { error: jest.fn(), warn: jest.fn() };
    Object.assign(server as unknown as Record<string, unknown>, {
      dbClient: { query },
      waUrls: { personal: 'http://wa-personal', professional: 'http://wa-professional' },
      logger,
    });
    return {
      send: (args: {
        chatId: string;
        text: string;
        account?: string;
        phone?: string;
        phoneE164?: string;
        manualOpenUrl?: string;
      }) =>
        (
          server as unknown as {
            handleSendMessage: (a: unknown) => Promise<unknown>;
          }
        ).handleSendMessage(args),
      query,
      logger,
    };
  }

  it('does not offer a caller-supplied PN fallback when the connector rejects a LID', async () => {
    process.env.ENABLE_SENDING = 'true';
    delete process.env.EMERGENCY_DISABLE_SENDING;
    const fetchMock = jest.fn(async (_url: unknown, init: any) => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () =>
        JSON.stringify({
          error: 'Failed to send message: account restricted',
          failureClass: 'account_restricted',
          fallback: {
            manualOpenUrl: 'https://wa.me/35796658668',
          },
        }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { send, logger } = sendServer(async (sql) => {
      if (/SELECT c\.id/.test(sql)) return { rows: [{ id: 'professional:198517716955152@lid' }] };
      return { rows: [] };
    });

    await expect(
      send({
        chatId: '198517716955152@lid',
        phoneE164: '+35796658668',
        manualOpenUrl: 'https://wa.me/35796658668',
        text: 'safe test body',
        account: 'professional',
      })
    ).rejects.toThrow(/account restricted/);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.conversationId).toBe('198517716955152@lid');
    expect(logger.error.mock.calls[0][0]).not.toContain('Manual fallback:');
  });
});

describe('approved draft inbound gate', () => {
  const originalEnableSending = process.env.ENABLE_SENDING;
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalEnableSending === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = originalEnableSending;
    global.fetch = originalFetch;
  });

  function draftServer(conversationId: string, inbound: boolean) {
    const server = Object.create(MCPServer.prototype) as any;
    const draft = { conversationId, content: 'draft body', status: 'APPROVED' };
    const query = jest.fn(async () => ({ rows: inbound ? [{ id: conversationId }] : [] }));
    server.dbClient = { query };
    server.draftService = { getDraftById: jest.fn(async () => draft), markAsSent: jest.fn() };
    server.waUrl = jest.fn(() => 'http://wa-professional');
    server.secretForUrl = jest.fn(() => 'test-secret');
    server.authHeaders = jest.fn(() => ({}));
    return { server, query };
  }

  it('blocks an approved professional LID draft without inbound before connector fetch', async () => {
    process.env.ENABLE_SENDING = 'true';
    delete process.env.EMERGENCY_DISABLE_SENDING;
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const { server, query } = draftServer('professional:198517716955152@lid', false);
    await expect(server.handleSendApprovedReply({ sendToken: 'send-draft-123', account: 'professional' }))
      .rejects.toThrow(/only allowed after the customer has sent an inbound message/);
    expect(query).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(server.draftService.markAsSent).not.toHaveBeenCalled();
  });

  it('sends an approved professional LID draft to the same LID after inbound', async () => {
    process.env.ENABLE_SENDING = 'true';
    delete process.env.EMERGENCY_DISABLE_SENDING;
    const fetchMock = jest.fn(async (_url: unknown, _init: any) => ({ ok: true, json: async () => ({}) }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { server, query } = draftServer('professional:198517716955152@lid', true);
    await server.handleSendApprovedReply({ sendToken: 'send-draft-123', account: 'professional' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).conversationId).toBe('198517716955152@lid');
  });

  it('keeps approved group drafts outside the direct-chat gate', async () => {
    process.env.ENABLE_SENDING = 'true';
    delete process.env.EMERGENCY_DISABLE_SENDING;
    const fetchMock = jest.fn(async (_url: unknown, _init: any) => ({ ok: true, json: async () => ({}) }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { server, query } = draftServer('professional:123456789-987654321@g.us', false);
    await server.handleSendApprovedReply({ sendToken: 'send-draft-123', account: 'professional' });
    expect(query).not.toHaveBeenCalled();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).conversationId).toBe('123456789-987654321@g.us');
  });

  it('keeps approved personal drafts outside the professional inbound gate', async () => {
    process.env.ENABLE_SENDING = 'true';
    delete process.env.EMERGENCY_DISABLE_SENDING;
    const fetchMock = jest.fn(async (_url: unknown, _init: any) => ({ ok: true, json: async () => ({}) }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { server, query } = draftServer('198517716955152@lid', false);
    await server.handleSendApprovedReply({ sendToken: 'send-draft-123', account: 'personal' });
    expect(query).not.toHaveBeenCalled();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).conversationId).toBe('198517716955152@lid');
  });
});
