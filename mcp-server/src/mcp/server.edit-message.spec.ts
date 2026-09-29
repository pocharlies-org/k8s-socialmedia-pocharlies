import { runWithRequestActor } from '@mcp-socialmedia/shared';
import { useTestAccounts } from '../domain/test-accounts';
import { MCPServer } from './server';

/**
 * social_edit_message on WhatsApp: through the connector's POST
 * /api/v1/messages/edit (fase 3 / PR-3), ids inside the signed body, bare on
 * the wire. Other channels answer unsupported_capability.
 */
function serverWith() {
  const server = Object.create(MCPServer.prototype) as MCPServer;
  const connectorCall = jest.fn(async () => ({
    edited: true,
    messageId: '3EB0AAA',
    editId: '3EB0EDIT',
    editedAt: '2026-09-29T10:00:00.000Z',
  }));
  const query = jest.fn(async () => ({ rows: [] }));
  useTestAccounts({
    whatsapp: { personal: 'http://wa-personal', professional: 'http://wa-professional' },
    telegram: { personal: 'http://tg-personal' },
  });
  Object.assign(server as unknown as Record<string, unknown>, {
    dbClient: { query },
    connectorCall,
  });
  const any = server as unknown as Record<string, (a: unknown) => Promise<unknown>>;
  return {
    connectorCall,
    query,
    canonicalEdit: (args: object) => any.canonicalEditMessage(args),
  };
}

describe('social_edit_message on WhatsApp', () => {
  it('edits through POST /messages/edit with the bare chat and message ids', async () => {
    const { canonicalEdit, connectorCall, query } = serverWith();
    const out = (await canonicalEdit({
      channel: 'whatsapp',
      accountId: 'professional',
      target: 'professional:34600@s.whatsapp.net',
      messageId: 'professional:3EB0AAA',
      message: 'Texto corregido',
    })) as { content: Array<{ text: string }> };
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/messages/edit',
      { chatId: '34600@s.whatsapp.net', messageId: '3EB0AAA', content: 'Texto corregido' }
    );
    // The connector owns the row (and its edit history): the MCP writes nothing itself.
    expect(query).not.toHaveBeenCalled();
    expect(JSON.parse(out.content[0].text)).toMatchObject({ edited: true, editId: '3EB0EDIT' });
  });

  it('accepts a bare message id on the personal account and records the caller', async () => {
    const { canonicalEdit, connectorCall } = serverWith();
    await runWithRequestActor({ sub: 'sub-1', name: 'dani' }, () =>
      canonicalEdit({
        channel: 'whatsapp',
        accountId: 'personal',
        target: '34600@s.whatsapp.net',
        messageId: '3EB0BBB',
        message: 'Hola',
      })
    );
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-personal',
      'POST',
      '/api/v1/messages/edit',
      { chatId: '34600@s.whatsapp.net', messageId: '3EB0BBB', content: 'Hola', actor: 'dani' }
    );
  });

  it('refuses a message id namespaced to another account', async () => {
    const { canonicalEdit, connectorCall } = serverWith();
    await expect(
      canonicalEdit({
        channel: 'whatsapp',
        accountId: 'personal',
        target: '34600@s.whatsapp.net',
        messageId: 'professional:3EB0CCC',
        message: 'x',
      })
    ).rejects.toThrow(/professional WhatsApp namespace/);
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('surfaces the connector refusal (422 rejected_by_whatsapp) as an error', async () => {
    const { canonicalEdit, connectorCall } = serverWith();
    connectorCall.mockRejectedValueOnce(
      new Error('Connector error 422: {"failureClass":"rejected_by_whatsapp"}')
    );
    await expect(
      canonicalEdit({
        channel: 'whatsapp',
        accountId: 'personal',
        target: '34600@s.whatsapp.net',
        messageId: '3EB0OLD',
        message: 'demasiado tarde',
      })
    ).rejects.toThrow(/rejected_by_whatsapp/);
  });

  it('answers unsupported_capability on Telegram without calling a connector', async () => {
    const { canonicalEdit, connectorCall } = serverWith();
    await expect(
      canonicalEdit({
        channel: 'telegram',
        accountId: 'personal',
        target: '12345',
        messageId: '77',
        message: 'x',
      })
    ).rejects.toThrow(/not supported/);
    expect(connectorCall).not.toHaveBeenCalled();
  });
});
