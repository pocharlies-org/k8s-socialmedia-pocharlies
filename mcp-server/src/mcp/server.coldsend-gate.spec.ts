import { MCPServer } from './server';

/**
 * Cold-send gate parity for media (handleSendFile) and forward
 * (handleForwardMessage) on the professional WhatsApp account.
 *
 * Background: requireProfessionalInboundChat blocks first-contact ("cold")
 * professional sends — sending to a contact who never messaged us risks a
 * Baileys account_restricted / ban. Before this fix the gate covered only the
 * text route (handleSendMessage); media and forward sends to a professional
 * conversationId/toChatId with no prior inbound went through ungated. These
 * tests pin the parity: both routes must now (a) block cold professional sends,
 * (b) rewrite the destination to the @lid-aware send jid when an inbound
 * exists, and (c) leave personal sends completely untouched.
 */

type QueryImpl = (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;

function serverWith(queryImpl: QueryImpl) {
  const server = Object.create(MCPServer.prototype) as MCPServer;
  const connectorCall = jest.fn(async () => ({ ok: true }));
  const query = jest.fn(queryImpl);
  Object.assign(server as unknown as Record<string, unknown>, {
    dbClient: { query },
    connectorCall,
    waUrls: { personal: 'http://wa-personal', professional: 'http://wa-professional' },
  });
  return {
    connectorCall,
    query,
    sendFile: (args: {
      conversationId: string;
      fileUrl: string;
      caption?: string;
      account?: string;
    }) =>
      (server as unknown as { handleSendFile: (a: unknown) => Promise<unknown> }).handleSendFile(
        args
      ),
    forward: (args: { chatId: string; messageId: string; toChatId: string; account?: string }) =>
      (
        server as unknown as { handleForwardMessage: (a: unknown) => Promise<unknown> }
      ).handleForwardMessage(args),
  };
}

const hasInbound: QueryImpl = async () => ({ rows: [{ id: 'professional:x' }] });
const noInbound: QueryImpl = async () => ({ rows: [] });

describe('handleSendFile cold-send gate (professional)', () => {
  const ORIG = process.env.ENABLE_SENDING;
  beforeEach(() => {
    process.env.ENABLE_SENDING = 'true';
  });
  afterAll(() => {
    if (ORIG === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = ORIG;
  });

  it('blocks a cold professional media send (no prior inbound) and never calls the connector', async () => {
    const { sendFile, connectorCall } = serverWith(noInbound);
    await expect(
      sendFile({
        conversationId: '34660242739',
        fileUrl: 'http://f/x.jpg',
        account: 'professional',
      })
    ).rejects.toThrow(/only allowed after the customer has sent an inbound message/);
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('with a prior inbound, rewrites conversationId to the @s.whatsapp.net send jid and forwards caption/url', async () => {
    const { sendFile, connectorCall } = serverWith(hasInbound);
    await sendFile({
      conversationId: '34660242739',
      fileUrl: 'http://f/x.jpg',
      caption: 'hi',
      account: 'professional',
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/messages/media/send',
      { conversationId: '34660242739@s.whatsapp.net', fileUrl: 'http://f/x.jpg', caption: 'hi' }
    );
  });

  it('blocks a @lid media send without trusted phone evidence, even when an inbound exists', async () => {
    const { sendFile, connectorCall, query } = serverWith(hasInbound);
    await expect(
      sendFile({
        conversationId: '198517716955152@lid',
        fileUrl: 'http://f/x.jpg',
        account: 'professional',
      })
    ).rejects.toThrow(/require trusted phone evidence/);
    expect(query).not.toHaveBeenCalled();
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('blocks a professional media send to a group/unusable id before touching the DB (parity with text)', async () => {
    const { sendFile, connectorCall, query } = serverWith(noInbound);
    await expect(
      sendFile({
        conversationId: '123456789-987654321@g.us',
        fileUrl: 'http://f/x.jpg',
        account: 'professional',
      })
    ).rejects.toThrow(/valid individual phone or WhatsApp chat ID/);
    expect(query).not.toHaveBeenCalled();
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('leaves PERSONAL media sends ungated: no inbound check, conversationId unchanged', async () => {
    const { sendFile, connectorCall, query } = serverWith(noInbound);
    await sendFile({
      conversationId: '34660242739',
      fileUrl: 'http://f/x.jpg',
      account: 'personal',
    });
    expect(query).not.toHaveBeenCalled();
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-personal',
      'POST',
      '/api/v1/messages/media/send',
      { conversationId: '34660242739', fileUrl: 'http://f/x.jpg' }
    );
  });

  it('defaults to personal (ungated) when no account is given', async () => {
    const { sendFile, connectorCall, query } = serverWith(noInbound);
    await sendFile({ conversationId: '34660242739', fileUrl: 'http://f/x.jpg' });
    expect(query).not.toHaveBeenCalled();
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-personal',
      'POST',
      '/api/v1/messages/media/send',
      { conversationId: '34660242739', fileUrl: 'http://f/x.jpg' }
    );
  });
});

describe('handleForwardMessage cold-send gate (professional)', () => {
  const ORIG = process.env.ENABLE_SENDING;
  beforeEach(() => {
    process.env.ENABLE_SENDING = 'true';
  });
  afterAll(() => {
    if (ORIG === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = ORIG;
  });

  it('blocks a cold professional forward (destination has no prior inbound) and never calls the connector', async () => {
    const { forward, connectorCall } = serverWith(noInbound);
    await expect(
      forward({
        chatId: 'professional:source@s.whatsapp.net',
        messageId: 'm1',
        toChatId: '34660242739',
        account: 'professional',
      })
    ).rejects.toThrow(/only allowed after the customer has sent an inbound message/);
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('gates the DESTINATION (toChatId), rewrites it to the send jid, and leaves the source chatId/messageId intact', async () => {
    const { forward, connectorCall, query } = serverWith(hasInbound);
    await forward({
      chatId: 'professional:source@s.whatsapp.net',
      messageId: 'm1',
      toChatId: '34660242739',
      account: 'professional',
    });
    // The gate is keyed on the DESTINATION, not the source chat.
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'professional:34660242739@s.whatsapp.net',
    ]);
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/messages/forward',
      {
        chatId: 'professional:source@s.whatsapp.net',
        messageId: 'm1',
        toChatId: '34660242739@s.whatsapp.net',
      }
    );
  });

  it('leaves PERSONAL forwards ungated: no inbound check, toChatId unchanged', async () => {
    const { forward, connectorCall, query } = serverWith(noInbound);
    await forward({
      chatId: 'source@s.whatsapp.net',
      messageId: 'm1',
      toChatId: '34660242739',
      account: 'personal',
    });
    expect(query).not.toHaveBeenCalled();
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-personal',
      'POST',
      '/api/v1/messages/forward',
      {
        chatId: 'source@s.whatsapp.net',
        messageId: 'm1',
        toChatId: '34660242739',
      }
    );
  });

  it('blocks a @lid forward destination without trusted phone evidence', async () => {
    const { forward, connectorCall, query } = serverWith(hasInbound);
    await expect(
      forward({
        chatId: 'professional:source@s.whatsapp.net',
        messageId: 'm1',
        toChatId: '198517716955152@lid',
        account: 'professional',
      })
    ).rejects.toThrow(/require trusted phone evidence/);
    expect(query).not.toHaveBeenCalled();
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('blocks a professional forward to a group/unusable destination before touching the DB', async () => {
    const { forward, connectorCall, query } = serverWith(noInbound);
    await expect(
      forward({
        chatId: 'professional:source@s.whatsapp.net',
        messageId: 'm1',
        toChatId: '123456789-987654321@g.us',
        account: 'professional',
      })
    ).rejects.toThrow(/valid individual phone or WhatsApp chat ID/);
    expect(query).not.toHaveBeenCalled();
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('defaults to personal (ungated) forward when no account is given', async () => {
    const { forward, connectorCall, query } = serverWith(noInbound);
    await forward({
      chatId: 'source@s.whatsapp.net',
      messageId: 'm1',
      toChatId: '34660242739',
    });
    expect(query).not.toHaveBeenCalled();
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-personal',
      'POST',
      '/api/v1/messages/forward',
      { chatId: 'source@s.whatsapp.net', messageId: 'm1', toChatId: '34660242739' }
    );
  });

  it('treats odd-cased/padded account strings as personal (ungated) — matches waUrl routing', async () => {
    const { forward, connectorCall, query } = serverWith(noInbound);
    // normalizeAccount and waUrl both reduce to a strict === 'professional'
    // check, so 'PROFESSIONAL' / 'professional ' route to the personal
    // connector AND skip the gate together — no split-brain bypass.
    await forward({
      chatId: 'source@s.whatsapp.net',
      messageId: 'm1',
      toChatId: '34660242739',
      account: 'PROFESSIONAL',
    });
    expect(query).not.toHaveBeenCalled();
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-personal',
      'POST',
      '/api/v1/messages/forward',
      { chatId: 'source@s.whatsapp.net', messageId: 'm1', toChatId: '34660242739' }
    );
  });
});
