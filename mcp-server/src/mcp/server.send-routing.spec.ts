import { useTestAccounts } from '../domain/test-accounts';
import { MCPServer } from './server';

/**
 * No cold-send gate: 1:1 sends go straight to the account's connector with
 * the bare jid, on every account, without consulting inbound history.
 */
function serverWith() {
  const server = Object.create(MCPServer.prototype) as MCPServer;
  const connectorCall = jest.fn(async () => ({ ok: true }));
  const query = jest.fn(async () => ({ rows: [] }));
  useTestAccounts({
    whatsapp: { personal: 'http://wa-personal', professional: 'http://wa-professional' },
  });
  Object.assign(server as unknown as Record<string, unknown>, {
    dbClient: { query },
    connectorCall,
  });
  const any = server as unknown as Record<string, (a: unknown) => Promise<unknown>>;
  return {
    connectorCall,
    query,
    sendFile: (args: object) => any.handleSendFile(args),
    forward: (args: object) => any.handleForwardMessage(args),
  };
}

describe('WhatsApp send routing without a cold-send gate', () => {
  const ORIG = process.env.ENABLE_SENDING;
  beforeEach(() => {
    process.env.ENABLE_SENDING = 'true';
  });
  afterAll(() => {
    if (ORIG === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = ORIG;
  });

  it.each([
    ['a phone jid', '34660242739@s.whatsapp.net', '34660242739@s.whatsapp.net'],
    ['a legacy prefixed @lid', 'professional:198517716955152@lid', '198517716955152@lid'],
    ['a prefixed group', 'professional:120363000000000000@g.us', '120363000000000000@g.us'],
  ])('sends professional media to %s directly, with the bare jid', async (_l, id, bare) => {
    const { sendFile, connectorCall, query } = serverWith();
    await sendFile({ conversationId: id, fileUrl: 'http://f/x.jpg', account: 'professional' });
    expect(query).not.toHaveBeenCalled();
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/messages/media/send',
      { conversationId: bare, fileUrl: 'http://f/x.jpg' }
    );
  });

  it('forwards to a first-contact destination without checking inbound history', async () => {
    const { forward, connectorCall, query } = serverWith();
    await forward({
      chatId: 'professional:source@s.whatsapp.net',
      messageId: 'm1',
      toChatId: 'professional:34660242739@s.whatsapp.net',
      account: 'professional',
    });
    expect(query).not.toHaveBeenCalled();
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

  it('still refuses when sending is disabled', async () => {
    delete process.env.ENABLE_SENDING;
    const { sendFile, connectorCall } = serverWith();
    await expect(
      sendFile({ conversationId: 'x@lid', fileUrl: 'u', account: 'personal' })
    ).rejects.toThrow(/disabled/);
    expect(connectorCall).not.toHaveBeenCalled();
  });
});
