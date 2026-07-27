import {
  isLidJid,
  normalizeDirectWhatsAppJid,
  resolveProfessionalSendTarget,
  MCPServer,
} from './server';

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

  it('prefixes a 9-digit Spanish mobile with 34', () => {
    expect(normalizeDirectWhatsAppJid('660242739')).toBe('34660242739@s.whatsapp.net');
  });

  it('rejects group jids and out-of-range ids', () => {
    expect(normalizeDirectWhatsAppJid('123456789-987654321@g.us')).toBeNull();
    expect(normalizeDirectWhatsAppJid('123')).toBeNull();
  });
});

describe('resolveProfessionalSendTarget', () => {
  it('keeps a bare @lid under the @lid key but marks it as missing phone evidence', () => {
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

  it('uses trusted phone evidence to turn an @lid send into a phone-number send jid', () => {
    expect(
      resolveProfessionalSendTarget('198517716955152@lid', {
        manualOpenUrl: 'https://wa.me/35796658668?text=hello',
      })
    ).toEqual({
      lookupKey: 'professional:198517716955152@lid',
      lookupKeys: [
        'professional:198517716955152@lid',
        'professional:35796658668@s.whatsapp.net',
      ],
      sendJid: '35796658668@s.whatsapp.net',
      sourceLidJid: '198517716955152@lid',
      phoneE164: '+35796658668',
      phoneWaJid: '35796658668@c.us',
      manualOpenUrl: 'https://wa.me/35796658668?text=hello',
      phoneEvidenceSource: 'manualOpenUrl',
    });
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
        evidence: { phone?: string; phoneE164?: string; manualOpenUrl?: string } = {}
      ) =>
        (
          server as unknown as {
            requireProfessionalInboundChat: (
              id: string,
              evidence?: { phone?: string; phoneE164?: string; manualOpenUrl?: string }
            ) => Promise<string>;
          }
        ).requireProfessionalInboundChat(chatId, evidence),
      query: (server as unknown as { dbClient: { query: jest.Mock } }).dbClient.query,
    };
  }

  it('@lid without trusted phone evidence stays blocked before touching the DB', async () => {
    const { call, query } = gateWith(async () => ({
      rows: [{ id: 'professional:198517716955152@lid' }],
    }));
    await expect(call('198517716955152@lid')).rejects.toThrow(/require trusted phone evidence/);
    expect(query).not.toHaveBeenCalled();
  });

  it('@lid plus trusted phone evidence and inbound history sends to the phone-number jid', async () => {
    const { call, query } = gateWith(async (sql) => {
      if (/SELECT c\.id/.test(sql)) return { rows: [{ id: 'professional:198517716955152@lid' }] };
      return { rows: [] };
    });
    await expect(call('198517716955152@lid', { phoneE164: '+35796658668' })).resolves.toBe(
      '35796658668@s.whatsapp.net'
    );
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('c.wa_chat_id = $1'), [
      'professional:198517716955152@lid',
    ]);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('UPDATE conversations'), [
      'professional:198517716955152@lid',
      'professional:35796658668@s.whatsapp.net',
      expect.any(String),
    ]);
  });

  it('@lid plus phone still blocks when neither the LID nor phone has inbound history', async () => {
    const { call, query } = gateWith(async () => ({ rows: [] }));
    await expect(call('198517716955152@lid', { phone: '35796658668' })).rejects.toThrow(
      /only allowed after the customer has sent an inbound message/
    );
    expect(query).toHaveBeenCalledWith(expect.any(String), ['professional:198517716955152@lid']);
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'professional:35796658668@s.whatsapp.net',
    ]);
  });

  it('bare phone with an inbound returns the normalized @s.whatsapp.net jid', async () => {
    const { call, query } = gateWith(async () => ({
      rows: [{ id: 'professional:34660242739@s.whatsapp.net' }],
    }));
    await expect(call('34660242739')).resolves.toBe('34660242739@s.whatsapp.net');
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'professional:34660242739@s.whatsapp.net',
    ]);
  });

  it('bare phone with an inbound LID conversation found through wa_chat_id is allowed', async () => {
    const { call, query } = gateWith(async (sql, params) => {
      expect(sql).toContain('c.wa_chat_id = $1');
      expect(params).toEqual(['professional:35796658668@s.whatsapp.net']);
      return { rows: [{ id: 'professional:79723233333251@lid' }] };
    });
    await expect(call('35796658668')).resolves.toBe('35796658668@s.whatsapp.net');
    expect(query).toHaveBeenCalledTimes(1);
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

  it('preserves manual fallback when the connector rejects the verified phone destination', async () => {
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

    const { send } = sendServer(async (sql) => {
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
    ).rejects.toThrow(/Manual fallback: open https:\/\/wa\.me\/35796658668/);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.conversationId).toBe('35796658668@s.whatsapp.net');
  });
});
