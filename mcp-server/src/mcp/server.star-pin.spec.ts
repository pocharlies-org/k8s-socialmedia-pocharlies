import { runWithRequestActor } from '@mcp-socialmedia/shared';
import { useTestAccounts } from '../domain/test-accounts';
import { MCPServer } from './server';
import { SOCIAL_TOOL_REGISTRY } from './tool-registry';

/**
 * Starred and pinned messages (WhatsApp): social_star_message,
 * social_pin_message, social_list_pinned and social_list_starred reach their
 * connector routes with the ids bare inside the signed body, refuse another
 * account's namespaced ids, keep the connector's failureClass as the code and
 * answer unsupported_capability on other channels.
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
    // The tool-level idempotencyKey ledger.
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

describe('social_star_message', () => {
  it('stars through POST /messages/star with the bare id, the chat only when given', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockResolvedValueOnce({ starred: true, messageId: '3EB0AAA', persisted: true });
    const out = await run('social_star_message', {
      ...wa,
      messageId: 'professional:3EB0AAA',
      star: true,
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/messages/star',
      { messageId: '3EB0AAA', star: true }
    );
    expect(out.structuredContent).toMatchObject({ ok: true, data: { starred: true } });

    await run('social_star_message', {
      ...wa,
      target: 'professional:34600@s.whatsapp.net',
      messageId: '3EB0AAA',
      star: false,
    });
    expect(connectorCall).toHaveBeenLastCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/messages/star',
      { conversationId: '34600@s.whatsapp.net', messageId: '3EB0AAA', star: false }
    );
  });

  it('refuses another account id, a missing star and other channels before the connector', async () => {
    const { run, connectorCall } = serverWith();
    const foreign = await run('social_star_message', {
      channel: 'whatsapp',
      accountId: 'personal',
      messageId: 'professional:3EB0AAA',
      star: true,
    });
    expect(foreign.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    expect(foreign.structuredContent.error.message).toMatch(/professional WhatsApp namespace/);
    await expect(run('social_star_message', { ...wa, messageId: '3EB0AAA' })).rejects.toMatchObject(
      { canonicalCode: 'invalid_request' }
    );
    const telegram = await run('social_star_message', {
      channel: 'telegram',
      accountId: 'personal',
      messageId: 'tg_1_2',
      star: true,
    });
    expect(telegram.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('keeps the connector failureClass (404 message_unavailable, 403 disabled_sending)', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockRejectedValueOnce(
      connectorError(404, { error: 'unknown message', failureClass: 'message_unavailable' })
    );
    const out = await run('social_star_message', { ...wa, messageId: 'NOPE', star: true });
    expect(out.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'message_unavailable', details: { status: 404 } },
    });
    connectorCall.mockRejectedValueOnce(
      connectorError(403, { error: 'Sending is disabled', failureClass: 'disabled_sending' })
    );
    const gated = await run('social_star_message', { ...wa, messageId: 'M1', star: true });
    expect(gated.structuredContent.error).toMatchObject({ code: 'disabled_sending' });
  });
});

describe('social_pin_message', () => {
  it('pins with a duration, the caller and a scoped Idempotency-Key', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockResolvedValueOnce({
      pinned: true,
      messageId: 'PIN1',
      pinnedMessageId: '3EB0AAA',
      expiresAt: '2026-10-31T10:00:00.000Z',
    });
    const out = await runWithRequestActor({ sub: 'sub-1', name: 'dani' }, () =>
      run('social_pin_message', {
        ...wa,
        target: '120363000@g.us',
        messageId: 'professional:3EB0AAA',
        pin: true,
        durationSeconds: 2592000,
        idempotencyKey: 'k1',
      })
    );
    const [url, method, path, body, timeout, headers] = connectorCall.mock.calls[0] as unknown[];
    expect([url, method, path, timeout]).toEqual([
      'http://wa-professional',
      'POST',
      '/api/v1/messages/pin',
      undefined,
    ]);
    expect(body).toEqual({
      conversationId: '120363000@g.us',
      messageId: '3EB0AAA',
      pin: true,
      durationSeconds: 2592000,
      actor: 'dani',
    });
    expect((headers as Record<string, string>)['Idempotency-Key']).toMatch(/^mcp-[0-9a-f]{64}$/);
    expect(out.structuredContent).toMatchObject({
      ok: true,
      data: { pinned: true, pinnedMessageId: '3EB0AAA' },
    });
  });

  it('unpins without a duration or key; a duration on an unpin is refused', async () => {
    const { run, connectorCall } = serverWith();
    await run('social_pin_message', { ...wa, messageId: '3EB0AAA', pin: false });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/messages/pin',
      { messageId: '3EB0AAA', pin: false }
    );
    const refused = await run('social_pin_message', {
      ...wa,
      messageId: '3EB0AAA',
      pin: false,
      durationSeconds: 86400,
    });
    expect(refused.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    expect(connectorCall).toHaveBeenCalledTimes(1);
  });

  it('only accepts the three WhatsApp durations (schema) and WhatsApp', async () => {
    const { run, connectorCall } = serverWith();
    await expect(
      run('social_pin_message', { ...wa, messageId: '3EB0AAA', pin: true, durationSeconds: 3600 })
    ).rejects.toMatchObject({ canonicalCode: 'invalid_request' });
    const telegram = await run('social_pin_message', {
      channel: 'telegram',
      accountId: 'personal',
      messageId: 'tg_1_2',
      pin: true,
    });
    expect(telegram.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('maps 403 not_group_admin with the connector payload', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockRejectedValueOnce(
      connectorError(403, { error: 'Only admins can pin', failureClass: 'not_group_admin' })
    );
    const out = await run('social_pin_message', {
      ...wa,
      target: '120363000@g.us',
      messageId: '3EB0AAA',
      pin: true,
    });
    expect(out.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'not_group_admin', details: { status: 403, failureClass: 'not_group_admin' } },
    });
  });
});

describe('social_list_pinned / social_list_starred', () => {
  it('reads the pins of a chat through POST /messages/pins', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockResolvedValueOnce({ conversationId: '2222@lid', pinned: [], limit: 3 });
    const out = await run('social_list_pinned', { ...wa, target: 'professional:2222@lid' });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/messages/pins',
      { conversationId: '2222@lid' }
    );
    expect(out.structuredContent).toMatchObject({ ok: true, data: { limit: 3 } });
  });

  it('lists starred messages account-wide or of one chat, paged', async () => {
    const { run, connectorCall } = serverWith();
    await run('social_list_starred', wa);
    expect(connectorCall).toHaveBeenLastCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/messages/starred',
      {}
    );
    await run('social_list_starred', {
      ...wa,
      target: '34600@s.whatsapp.net',
      limit: 10,
      cursor: 'abc',
    });
    expect(connectorCall).toHaveBeenLastCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/messages/starred',
      { conversationId: '34600@s.whatsapp.net', limit: 10, cursor: 'abc' }
    );
  });

  it('are provider-only, WhatsApp-only, refuse another account chat and need a chat for pins', async () => {
    const { run, connectorCall } = serverWith();
    const index = await run('social_list_starred', { ...wa, readSource: 'index' });
    expect(index.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    const telegram = await run('social_list_pinned', {
      channel: 'telegram',
      accountId: 'personal',
      target: 'tg_1',
    });
    expect(telegram.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    const foreign = await run('social_list_pinned', {
      channel: 'whatsapp',
      accountId: 'personal',
      target: 'professional:2222@lid',
    });
    expect(foreign.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    await expect(run('social_list_pinned', wa)).rejects.toMatchObject({
      canonicalCode: 'invalid_request',
    });
    await expect(run('social_list_starred', { ...wa, limit: 500 })).rejects.toMatchObject({
      canonicalCode: 'invalid_request',
    });
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('are reads; star and pin are idempotent non-destructive writes', () => {
    const byName = (name: string) => SOCIAL_TOOL_REGISTRY.find(tool => tool.name === name)!;
    for (const name of ['social_list_pinned', 'social_list_starred']) {
      expect(byName(name)).toMatchObject({ effect: 'read', authScope: 'social.read' });
    }
    for (const name of ['social_star_message', 'social_pin_message']) {
      expect(byName(name)).toMatchObject({
        effect: 'externalWrite',
        authScope: 'social.write',
        annotations: { destructiveHint: false, idempotentHint: true },
      });
    }
  });
});
