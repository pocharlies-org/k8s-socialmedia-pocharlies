import { useTestAccounts } from '../domain/test-accounts';
import { fakeSocialDb } from '../infrastructure/database/fake-social-db';
import { isLidJid, normalizeDirectWhatsAppJid, resolveDirectSendTarget, MCPServer } from './server';

const PRO = 'whatsapp:professional';

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

describe('resolveDirectSendTarget', () => {
  it('keeps a bare @lid as the lookup ref and send jid', () => {
    expect(resolveDirectSendTarget('198517716955152@lid')).toEqual({
      lookupRefs: ['198517716955152@lid'],
      sendJid: '198517716955152@lid',
    });
  });

  it('keeps a @hosted.lid jid verbatim too', () => {
    expect(resolveDirectSendTarget('198517716955152@hosted.lid')).toEqual({
      lookupRefs: ['198517716955152@hosted.lid'],
      sendJid: '198517716955152@hosted.lid',
    });
  });

  it('accepts a legacy account-prefixed @lid reference (no prefix in the refs)', () => {
    expect(resolveDirectSendTarget('professional:198517716955152@lid')).toEqual({
      lookupRefs: ['198517716955152@lid'],
      sendJid: '198517716955152@lid',
    });
  });

  it('uses trusted phone evidence to turn an @lid send into a phone-number send jid', () => {
    expect(
      resolveDirectSendTarget('198517716955152@lid', {
        manualOpenUrl: 'https://wa.me/35796658668?text=hello',
      })
    ).toEqual({
      lookupRefs: ['198517716955152@lid', '35796658668@s.whatsapp.net'],
      sendJid: '35796658668@s.whatsapp.net',
      sourceLidJid: '198517716955152@lid',
      phoneE164: '+35796658668',
      phoneWaJid: '35796658668@c.us',
      manualOpenUrl: 'https://wa.me/35796658668?text=hello',
      phoneEvidenceSource: 'manualOpenUrl',
    });
  });

  it('normalizes a bare phone or @c.us jid to @s.whatsapp.net', () => {
    for (const id of ['34660242739', '34660242739@c.us']) {
      expect(resolveDirectSendTarget(id)).toEqual({
        lookupRefs: ['34660242739@s.whatsapp.net'],
        sendJid: '34660242739@s.whatsapp.net',
      });
    }
  });

  it('returns null for ids that are neither @lid nor a normalizable phone', () => {
    expect(resolveDirectSendTarget('123456789-987654321@g.us')).toBeNull();
    expect(resolveDirectSendTarget('123')).toBeNull();
    expect(resolveDirectSendTarget(undefined)).toBeNull();
  });
});

describe('requireInboundChat gate (resolver-backed, per account)', () => {
  // Build an MCPServer without running the heavy constructor, injecting only the
  // fake dbClient the gate uses.
  function gateWith(db: ReturnType<typeof fakeSocialDb>, account = 'professional') {
    const server = Object.create(MCPServer.prototype) as MCPServer;
    Object.assign(server as unknown as Record<string, unknown>, {
      dbClient: { query: db.query },
      logger: { warn: jest.fn() },
    });
    return (
      chatId: string,
      evidence: { phone?: string; phoneE164?: string; manualOpenUrl?: string } = {}
    ) =>
      (
        server as unknown as {
          requireInboundChat: (a: string, id: string, e?: object) => Promise<string>;
        }
      ).requireInboundChat(account, chatId, evidence);
  }

  it('@lid without trusted phone evidence stays blocked before touching the DB', async () => {
    const db = fakeSocialDb([]);
    await expect(gateWith(db)('198517716955152@lid')).rejects.toThrow(
      /require trusted phone evidence/
    );
    expect(db.calls).toHaveLength(0);
  });

  it('@lid plus phone evidence and inbound history sends to the phone jid and records the alias', async () => {
    const db = fakeSocialDb([
      {
        id: 'professional:198517716955152@lid',
        account_id: PRO,
        external_id: '198517716955152@lid',
        inbound: true,
      },
    ]);
    await expect(gateWith(db)('198517716955152@lid', { phoneE164: '+35796658668' })).resolves.toBe(
      '35796658668@s.whatsapp.net'
    );
    expect(db.insertedAliases).toEqual([
      {
        account_id: PRO,
        alias_external_id: '35796658668@s.whatsapp.net',
        canonical_external_id: '198517716955152@lid',
        evidence: 'send-phone-evidence:phoneE164',
      },
    ]);
  });

  it('@lid plus phone still blocks when neither the LID nor the phone has inbound history', async () => {
    const db = fakeSocialDb([
      {
        id: 'professional:198517716955152@lid',
        account_id: PRO,
        external_id: '198517716955152@lid',
      },
    ]);
    await expect(gateWith(db)('198517716955152@lid', { phone: '35796658668' })).rejects.toThrow(
      /only allowed after the customer has sent an inbound message/
    );
    expect(db.insertedAliases).toHaveLength(0);
  });

  it('bare phone reaching an inbound LID conversation through a contact alias is allowed', async () => {
    const db = fakeSocialDb(
      [
        {
          id: 'professional:79723233333251@lid',
          account_id: PRO,
          external_id: '79723233333251@lid',
          inbound: true,
        },
      ],
      [
        {
          account_id: PRO,
          alias_external_id: '35796658668@s.whatsapp.net',
          canonical_external_id: '79723233333251@lid',
          evidence: 'senderPnE164',
        },
      ]
    );
    await expect(gateWith(db)('35796658668')).resolves.toBe('35796658668@s.whatsapp.net');
  });

  it('follows a merged (tombstone) conversation to its canonical inbound history', async () => {
    const db = fakeSocialDb([
      {
        id: 'professional:34660242739@s.whatsapp.net',
        account_id: PRO,
        external_id: '34660242739@s.whatsapp.net',
        merged_into: 'professional:1111@lid',
      },
      { id: 'professional:1111@lid', account_id: PRO, external_id: '1111@lid', inbound: true },
    ]);
    await expect(gateWith(db)('34660242739')).resolves.toBe('34660242739@s.whatsapp.net');
  });

  it("does not count another account's inbound history", async () => {
    const db = fakeSocialDb([
      {
        id: '34660242739@s.whatsapp.net',
        account_id: 'whatsapp:personal',
        external_id: '34660242739@s.whatsapp.net',
        inbound: true,
      },
    ]);
    await expect(gateWith(db)('34660242739')).rejects.toThrow(/only allowed after/);
  });

  it('applies to any account declaring the gate, with the account in the error', async () => {
    const db = fakeSocialDb([]);
    await expect(gateWith(db, 'leila')('34660242739')).rejects.toThrow(
      /WhatsApp leila direct sends are only allowed after.*wa\.me\/34660242739/
    );
  });

  it('rejects an unusable id before touching the DB', async () => {
    const db = fakeSocialDb([]);
    await expect(gateWith(db)('123456789-987654321@g.us')).rejects.toThrow(
      /valid individual phone or WhatsApp chat ID/
    );
    expect(db.calls).toHaveLength(0);
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

    const db = fakeSocialDb([
      {
        id: 'professional:198517716955152@lid',
        account_id: PRO,
        external_id: '198517716955152@lid',
        inbound: true,
      },
    ]);
    const { send } = sendServer(db.query);

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
