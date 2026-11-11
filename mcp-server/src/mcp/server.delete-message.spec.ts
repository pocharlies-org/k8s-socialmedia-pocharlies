import { runWithRequestActor } from '@mcp-socialmedia/shared';
import { useTestAccounts } from '../domain/test-accounts';
import { MCPServer } from './server';

/**
 * social_delete_message on WhatsApp (fase 3 / PR-3): through the connector's
 * POST /api/v1/messages/delete, ids inside the signed body, bare on the wire.
 * The tool's input schema is unchanged.
 */
function serverWith() {
  const server = Object.create(MCPServer.prototype) as MCPServer;
  const connectorCall = jest.fn(async () => ({
    deleted: true,
    scope: 'everyone',
    messageId: '3EB0AAA',
    deletedAt: '2026-09-29T10:00:00.000Z',
  }));
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
    canonicalDelete: (args: object) => any.canonicalDeleteMessage(args),
  };
}

describe('social_delete_message on WhatsApp', () => {
  it('revokes through POST /messages/delete with the bare chat and message ids', async () => {
    const { canonicalDelete, connectorCall, query } = serverWith();
    const out = (await canonicalDelete({
      channel: 'whatsapp',
      accountId: 'professional',
      target: 'professional:34600@s.whatsapp.net',
      messageId: 'professional:3EB0AAA',
    })) as { content: Array<{ text: string }> };
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/messages/delete',
      { chatId: '34600@s.whatsapp.net', messageId: '3EB0AAA' }
    );
    // The connector owns the row: the MCP writes nothing itself.
    expect(query).not.toHaveBeenCalled();
    expect(JSON.parse(out.content[0].text)).toMatchObject({ deleted: true, scope: 'everyone' });
  });

  it('accepts a bare message id on the personal account and records the caller', async () => {
    const { canonicalDelete, connectorCall } = serverWith();
    await runWithRequestActor({ sub: 'sub-1', name: 'dani' }, () =>
      canonicalDelete({
        channel: 'whatsapp',
        accountId: 'personal',
        target: '34600@s.whatsapp.net',
        messageId: '3EB0BBB',
      })
    );
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-personal',
      'POST',
      '/api/v1/messages/delete',
      { chatId: '34600@s.whatsapp.net', messageId: '3EB0BBB', actor: 'dani' }
    );
  });

  it('refuses a message id namespaced to another account', async () => {
    const { canonicalDelete, connectorCall } = serverWith();
    await expect(
      canonicalDelete({
        channel: 'whatsapp',
        accountId: 'personal',
        target: '34600@s.whatsapp.net',
        messageId: 'professional:3EB0CCC',
      })
    ).rejects.toThrow(/professional WhatsApp namespace/);
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('surfaces the connector refusal (404 message_unavailable, 403 disabled) as an error', async () => {
    const { canonicalDelete, connectorCall } = serverWith();
    connectorCall.mockRejectedValueOnce(
      new Error('Connector error 404: {"failureClass":"message_unavailable"}')
    );
    await expect(
      canonicalDelete({
        channel: 'whatsapp',
        accountId: 'personal',
        target: '34600@s.whatsapp.net',
        messageId: 'NOPE',
      })
    ).rejects.toThrow(/message_unavailable/);
  });
});
