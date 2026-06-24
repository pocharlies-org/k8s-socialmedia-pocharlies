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
  it('(a) resolves a bare @lid under the @lid key and returns the @lid jid', () => {
    expect(resolveProfessionalSendTarget('198517716955152@lid')).toEqual({
      lookupKey: 'professional:198517716955152@lid',
      sendJid: '198517716955152@lid',
    });
  });

  it('(a) resolves a @hosted.lid jid verbatim too', () => {
    expect(resolveProfessionalSendTarget('198517716955152@hosted.lid')).toEqual({
      lookupKey: 'professional:198517716955152@hosted.lid',
      sendJid: '198517716955152@hosted.lid',
    });
  });

  it('(a) strips an already-prefixed professional @lid before re-keying (no double prefix)', () => {
    expect(resolveProfessionalSendTarget('professional:198517716955152@lid')).toEqual({
      lookupKey: 'professional:198517716955152@lid',
      sendJid: '198517716955152@lid',
    });
  });

  it('(b) normalizes a bare phone to @s.whatsapp.net under the professional key', () => {
    expect(resolveProfessionalSendTarget('34660242739')).toEqual({
      lookupKey: 'professional:34660242739@s.whatsapp.net',
      sendJid: '34660242739@s.whatsapp.net',
    });
  });

  it('(b) normalizes a @c.us jid to @s.whatsapp.net under the professional key', () => {
    expect(resolveProfessionalSendTarget('34660242739@c.us')).toEqual({
      lookupKey: 'professional:34660242739@s.whatsapp.net',
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
      call: (chatId: string) =>
        (
          server as unknown as {
            requireProfessionalInboundChat: (id: string) => Promise<string>;
          }
        ).requireProfessionalInboundChat(chatId),
      query: (server as unknown as { dbClient: { query: jest.Mock } }).dbClient.query,
    };
  }

  it('(a) @lid with an inbound message resolves and returns the @lid jid, looked up under the @lid key', async () => {
    const { call, query } = gateWith(async () => ({ rows: [{ id: 'professional:198517716955152@lid' }] }));
    await expect(call('198517716955152@lid')).resolves.toBe('198517716955152@lid');
    expect(query).toHaveBeenCalledWith(expect.any(String), ['professional:198517716955152@lid']);
  });

  it('(c) @lid with NO inbound rows still throws the manual-fallback guard error', async () => {
    const { call, query } = gateWith(async () => ({ rows: [] }));
    await expect(call('198517716955152@lid')).rejects.toThrow(
      /only allowed after the customer has sent an inbound message/
    );
    expect(query).toHaveBeenCalledWith(expect.any(String), ['professional:198517716955152@lid']);
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
