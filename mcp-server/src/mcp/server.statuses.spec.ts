import { runWithRequestActor } from '@mcp-socialmedia/shared';
import { useTestAccounts } from '../domain/test-accounts';
import { MCPServer } from './server';
import { SOCIAL_TOOL_REGISTRY } from './tool-registry';

/**
 * Statuses and channel posts (WhatsApp): social_list_statuses,
 * social_list_channel_posts and social_publish_status reach their connector
 * routes with bare ids inside the signed body, refuse another account's
 * namespaced ids, force confirm + an explicit audience for a publish, keep the
 * connector's failureClass (status_publish_disabled, disabled_sending…) as the
 * code and answer unsupported_capability on other channels.
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
const connectorError = (status: number, payload: unknown) =>
  new Error(`Connector error ${status}: ${JSON.stringify(payload)}`);

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

describe('social_publish_status', () => {
  const text = {
    ...wa,
    type: 'text',
    text: 'Abrimos el sábado',
    recipients: ['+34600111222', 'professional:2222@lid'],
    confirm: true,
  };

  it('publishes with confirm, bare recipients, the caller and a scoped Idempotency-Key', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockResolvedValueOnce({ published: true, messageId: 'ST1', audienceSize: 2 });
    const out = await runWithRequestActor({ sub: 'sub-1', name: 'dani' }, () =>
      run('social_publish_status', {
        ...text,
        backgroundColor: '#112233',
        font: 2,
        idempotencyKey: 'k1',
      })
    );
    const [url, method, path, body, timeout, headers] = connectorCall.mock.calls[0] as unknown[];
    expect([url, method, path, timeout]).toEqual([
      'http://wa-professional',
      'POST',
      '/api/v1/statuses/publish',
      undefined,
    ]);
    expect(body).toEqual({
      type: 'text',
      text: 'Abrimos el sábado',
      backgroundColor: '#112233',
      font: 2,
      recipients: ['+34600111222', '2222@lid'],
      confirm: true,
      actor: 'dani',
    });
    expect((headers as Record<string, string>)['Idempotency-Key']).toMatch(/^mcp-[0-9a-f]{64}$/);
    expect(out.structuredContent).toMatchObject({ ok: true, data: { messageId: 'ST1' } });

    await run('social_publish_status', {
      ...wa,
      type: 'image',
      url: 'https://cdn.example/x.png',
      recipients: ['2222@lid'],
      confirm: true,
    });
    expect(connectorCall.mock.calls[1][3]).toEqual({
      type: 'image',
      url: 'https://cdn.example/x.png',
      recipients: ['2222@lid'],
      confirm: true,
    });
  });

  it('schema: confirm, an audience and the fields of each type are required before the connector', async () => {
    const { run, connectorCall } = serverWith();
    for (const args of [
      { ...text, confirm: undefined },
      { ...text, confirm: false },
      { ...text, recipients: [] },
      { ...text, recipients: undefined },
      { ...text, text: undefined },
      { ...text, url: 'https://cdn.example/x.png' },
      { ...text, type: 'video' },
      { ...wa, type: 'image', recipients: ['2222@lid'], confirm: true },
      {
        ...wa,
        type: 'image',
        url: 'https://cdn.example/x.png',
        font: 1,
        recipients: ['2222@lid'],
        confirm: true,
      },
      { ...wa, type: 'image', url: 'file:///x.png', recipients: ['2222@lid'], confirm: true },
    ]) {
      await expect(
        run('social_publish_status', args as Record<string, unknown>)
      ).rejects.toMatchObject({ canonicalCode: 'invalid_request' });
    }
    const foreign = await run('social_publish_status', {
      ...text,
      accountId: 'personal',
    });
    expect(foreign.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    const telegram = await run('social_publish_status', {
      ...text,
      channel: 'telegram',
      accountId: 'personal',
      recipients: ['123'],
    });
    expect(telegram.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('keeps the connector refusal: flag off, sending disabled', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockRejectedValueOnce(
      connectorError(403, {
        error: 'Publishing statuses is disabled on this connector (WA_STATUS_PUBLISH_ENABLED)',
        failureClass: 'status_publish_disabled',
      })
    );
    const off = await run('social_publish_status', text);
    expect(off.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'status_publish_disabled', details: { status: 403 } },
    });
    connectorCall.mockRejectedValueOnce(
      connectorError(403, { error: 'Sending is disabled', failureClass: 'disabled_sending' })
    );
    const gated = await run('social_publish_status', text);
    expect(gated.structuredContent.error).toMatchObject({ code: 'disabled_sending' });
  });

  it('is destructive and not idempotent in its annotations', () => {
    const tool = SOCIAL_TOOL_REGISTRY.find(t => t.name === 'social_publish_status')!;
    expect(tool.effect).toBe('destructive');
    expect(tool.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false });
  });
});
