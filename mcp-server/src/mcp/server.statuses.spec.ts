import { useTestAccounts } from '../domain/test-accounts';
import { MCPServer } from './server';
import { SOCIAL_TOOL_REGISTRY } from './tool-registry';

/**
 * Statuses and channel posts (WhatsApp): social_list_statuses,
 * social_list_channel_posts reach their connector routes with bare ids inside
 * the signed body, refuse another account's namespaced ids and answer
 * unsupported_capability on other channels and on the local index.
 */
function serverWith() {
  const server = Object.create(MCPServer.prototype) as MCPServer;
  const connectorCall = jest.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true }));
  useTestAccounts({
    whatsapp: { personal: 'http://wa-personal', professional: 'http://wa-professional' },
    telegram: { personal: 'http://tg-personal' },
  });
  Object.assign(server as unknown as Record<string, unknown>, {
    connectorCall,
    logger: { error: jest.fn() },
    redisClient: { set: jest.fn(async () => 'OK'), get: jest.fn(async () => null) },
  });
  const any = server as unknown as Record<string, (...a: unknown[]) => Promise<any>>;
  const run = (name: string, args: Record<string, unknown>) =>
    any.executeCanonicalTool(
      SOCIAL_TOOL_REGISTRY.find(tool => tool.name === name),
      args
    ) as Promise<{ isError?: boolean; structuredContent: Record<string, any> }>;
  return { connectorCall, run };
}

const wa = { channel: 'whatsapp', accountId: 'professional' };

describe('social_list_statuses', () => {
  it('lists through POST /statuses: defaults untouched, a contact bare, flags and page passed', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockResolvedValueOnce({ statuses: [], nextCursor: null, persisted: true });
    const out = await run('social_list_statuses', wa);
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/statuses',
      {}
    );
    expect(out.structuredContent).toMatchObject({ ok: true, data: { persisted: true } });

    await run('social_list_statuses', {
      ...wa,
      contact: 'professional:34600111222@s.whatsapp.net',
      includeExpired: true,
      includeOwn: false,
      limit: 5,
      cursor: ' c1 ',
    });
    expect(connectorCall).toHaveBeenLastCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/statuses',
      {
        contact: '34600111222@s.whatsapp.net',
        includeExpired: true,
        includeOwn: false,
        limit: 5,
        cursor: 'c1',
      }
    );
  });

  it('refuses another account, the index, other channels and a bad limit', async () => {
    const { run, connectorCall } = serverWith();
    const foreign = await run('social_list_statuses', {
      channel: 'whatsapp',
      accountId: 'personal',
      contact: 'professional:34600111222@s.whatsapp.net',
    });
    expect(foreign.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    const index = await run('social_list_statuses', { ...wa, readSource: 'index' });
    expect(index.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    const telegram = await run('social_list_statuses', {
      channel: 'telegram',
      accountId: 'personal',
    });
    expect(telegram.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    await expect(run('social_list_statuses', { ...wa, limit: 500 })).rejects.toMatchObject({
      canonicalCode: 'invalid_request',
    });
    expect(connectorCall).not.toHaveBeenCalled();
  });
});

describe('social_list_channel_posts', () => {
  it('lists every channel, or one channel bare, through POST /channels/posts', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockResolvedValueOnce({ posts: [], nextCursor: null, channels: 2 });
    const out = await run('social_list_channel_posts', { ...wa, limit: 10 });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/channels/posts',
      { limit: 10 }
    );
    expect(out.structuredContent).toMatchObject({ ok: true, data: { channels: 2 } });
    await run('social_list_channel_posts', {
      ...wa,
      target: 'professional:120363400253693272@newsletter',
    });
    expect(connectorCall).toHaveBeenLastCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/channels/posts',
      { channelId: '120363400253693272@newsletter' }
    );
  });

  it('only a channel jid is a target (schema), never another account', async () => {
    const { run, connectorCall } = serverWith();
    await expect(
      run('social_list_channel_posts', { ...wa, target: '120363000@g.us' })
    ).rejects.toMatchObject({ canonicalCode: 'invalid_request' });
    const foreign = await run('social_list_channel_posts', {
      channel: 'whatsapp',
      accountId: 'personal',
      target: 'professional:120363400253693272@newsletter',
    });
    expect(foreign.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    expect(connectorCall).not.toHaveBeenCalled();
  });
});
