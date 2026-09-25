import { useTestAccounts } from '../domain/test-accounts';
import { isLidJid, normalizeDirectWhatsAppJid, MCPServer } from './server';

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

  function sendServer(queryImpl: (sql: string, params: unknown[]) => Promise<{ rows: any[] }>) {
    const server = Object.create(MCPServer.prototype) as MCPServer;
    const query = jest.fn(queryImpl);
    const logger = { error: jest.fn(), warn: jest.fn() };
    useTestAccounts({
      whatsapp: { personal: 'http://wa-personal', professional: 'http://wa-professional' },
    });
    Object.assign(server as unknown as Record<string, unknown>, {
      dbClient: { query },
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

    const { send, query } = sendServer(async () => ({ rows: [] }));

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
    // No gate: the LID goes out verbatim and inbound history is never read.
    expect(body.conversationId).toBe('198517716955152@lid');
    expect(query).not.toHaveBeenCalled();
  });
});
