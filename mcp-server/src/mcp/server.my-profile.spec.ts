import { runWithRequestActor } from '@mcp-socialmedia/shared';
import { useTestAccounts } from '../domain/test-accounts';
import { MCPServer } from './server';
import { SOCIAL_TOOL_REGISTRY } from './tool-registry';

/**
 * Own WhatsApp profile and the view-once / HD attachment options:
 * social_get_my_profile and social_update_my_profile reach /profile/me*,
 * confirm: true is required by the schema and passed through, photoUrl and
 * removePhoto exclude each other, a failed photo step after an accepted
 * name/about is outcome_unknown, and social_send_message attachments forward
 * viewOnce / hd (as quality 'hd') only when asked, WhatsApp only.
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
  return { server, connectorCall, run };
}

const wa = { channel: 'whatsapp', accountId: 'professional' };
const connectorError = (status: number, payload: unknown) =>
  new Error(`Connector error ${status}: ${JSON.stringify(payload)}`);

describe('social_get_my_profile', () => {
  it('reads GET /profile/me of the account; provider-only and WhatsApp-only', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockResolvedValueOnce({ profile: { jid: '34600@c.us', name: 'Dani' } });
    const out = await run('social_get_my_profile', wa);
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'GET',
      '/api/v1/profile/me',
      undefined
    );
    expect(out.structuredContent).toMatchObject({
      ok: true,
      data: { profile: { name: 'Dani' } },
    });
    const index = await run('social_get_my_profile', { ...wa, readSource: 'index' });
    expect(index.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    const telegram = await run('social_get_my_profile', {
      channel: 'telegram',
      accountId: 'personal',
    });
    expect(telegram.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    expect(connectorCall).toHaveBeenCalledTimes(1);
  });
});

describe('social_update_my_profile', () => {
  it('sends name + about in one call with confirm and the caller, then the photo by URL', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall
      .mockResolvedValueOnce({ updated: true, applied: ['name', 'about'], partial: false })
      .mockResolvedValueOnce({ updated: true, photo: { accepted: true, confirmed: true } });
    const out = await runWithRequestActor({ sub: 'sub-1', name: 'dani' }, () =>
      run('social_update_my_profile', {
        ...wa,
        name: 'Skirmshop',
        about: '',
        photoUrl: 'https://cdn.example.com/logo.png',
        confirm: true,
      })
    );
    expect(connectorCall.mock.calls).toEqual([
      [
        'http://wa-professional',
        'POST',
        '/api/v1/profile/me',
        { name: 'Skirmshop', about: '', confirm: true, actor: 'dani' },
      ],
      [
        'http://wa-professional',
        'POST',
        '/api/v1/profile/me/photo',
        { fileUrl: 'https://cdn.example.com/logo.png', confirm: true, actor: 'dani' },
      ],
    ]);
    expect(out.structuredContent).toMatchObject({
      ok: true,
      data: {
        updated: true,
        profile: { applied: ['name', 'about'] },
        photo: { photo: { confirmed: true } },
      },
    });
  });

  it('removes the photo alone through /profile/me/photo/remove', async () => {
    const { run, connectorCall } = serverWith();
    await run('social_update_my_profile', { ...wa, removePhoto: true, confirm: true });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/profile/me/photo/remove',
      { confirm: true }
    );
    expect(connectorCall).toHaveBeenCalledTimes(1);
  });

  it('refuses before the connector: no confirm, nothing to change, photoUrl with removePhoto, long name, Telegram', async () => {
    const { run, connectorCall } = serverWith();
    for (const args of [
      { ...wa, name: 'Dani' },
      { ...wa, name: 'Dani', confirm: false },
      { ...wa, confirm: true },
      { ...wa, photoUrl: 'https://x/a.jpg', removePhoto: true, confirm: true },
      { ...wa, photoUrl: 'file:///etc/passwd', confirm: true },
      { ...wa, name: 'x'.repeat(26), confirm: true },
      { ...wa, about: 'x'.repeat(140), confirm: true },
    ]) {
      await expect(run('social_update_my_profile', args)).rejects.toMatchObject({
        canonicalCode: 'invalid_request',
      });
    }
    const telegram = await run('social_update_my_profile', {
      channel: 'telegram',
      accountId: 'personal',
      name: 'Dani',
      confirm: true,
    });
    expect(telegram.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('keeps the connector failureClass; a failed photo after an accepted name is outcome_unknown', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockRejectedValueOnce(
      connectorError(403, { error: 'Sending is disabled', failureClass: 'disabled_sending' })
    );
    const gated = await run('social_update_my_profile', { ...wa, about: 'hola', confirm: true });
    expect(gated.structuredContent.error).toMatchObject({ code: 'disabled_sending' });

    connectorCall.mockResolvedValueOnce({ updated: true, applied: ['name'] }).mockRejectedValueOnce(
      connectorError(400, {
        error: 'Profile photo must be JPEG, PNG or WebP',
        failureClass: 'invalid_request',
      })
    );
    const partial = await run('social_update_my_profile', {
      ...wa,
      name: 'Dani',
      photoUrl: 'https://x/a.gif',
      confirm: true,
    });
    expect(partial.structuredContent.error).toMatchObject({ code: 'outcome_unknown' });
    expect(partial.structuredContent.error.message).toMatch(
      /accepted name but the photo change failed/
    );
  });

  it('is a destructive, idempotent write; the read is read-only', () => {
    const byName = (name: string) => SOCIAL_TOOL_REGISTRY.find(tool => tool.name === name)!;
    expect(byName('social_get_my_profile')).toMatchObject({
      effect: 'read',
      authScope: 'social.read',
    });
    expect(byName('social_update_my_profile')).toMatchObject({
      effect: 'destructive',
      authScope: 'social.write',
      annotations: { destructiveHint: true, idempotentHint: true },
    });
  });
});

describe('social_send_message attachments: viewOnce / hd', () => {
  const previous = process.env.ENABLE_SENDING;
  beforeAll(() => {
    process.env.ENABLE_SENDING = 'true';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = previous;
  });

  it('forwards viewOnce and hd (as quality hd) only when asked', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockResolvedValue({ sent: true });
    await run('social_send_message', {
      ...wa,
      target: '34600@s.whatsapp.net',
      attachments: [
        { url: 'https://x/a.jpg', viewOnce: true, hd: true },
        { url: 'https://x/b.mp4', viewOnce: true },
        { url: 'https://x/c.pdf' },
      ],
    });
    expect(connectorCall.mock.calls.map(call => call[3])).toEqual([
      {
        conversationId: '34600@s.whatsapp.net',
        fileUrl: 'https://x/a.jpg',
        viewOnce: true,
        quality: 'hd',
      },
      { conversationId: '34600@s.whatsapp.net', fileUrl: 'https://x/b.mp4', viewOnce: true },
      { conversationId: '34600@s.whatsapp.net', fileUrl: 'https://x/c.pdf' },
    ]);
  });

  it('refuses them on other channels before any send', async () => {
    const { run, connectorCall } = serverWith();
    const out = await run('social_send_message', {
      channel: 'telegram',
      accountId: 'personal',
      target: '-100123',
      attachments: [{ url: 'https://x/a.jpg', viewOnce: true }],
    });
    expect(out.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    expect(connectorCall).not.toHaveBeenCalled();
  });
});
