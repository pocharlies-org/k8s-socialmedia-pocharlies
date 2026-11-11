import { runWithRequestActor } from '@mcp-socialmedia/shared';
import { useTestAccounts } from '../domain/test-accounts';
import { MCPServer } from './server';
import { SOCIAL_TOOL_REGISTRY } from './tool-registry';

/**
 * WhatsApp communities and channels: social_list_communities,
 * social_get_community, social_manage_community, social_lookup_channel,
 * social_list_channels and social_manage_channel_subscription reach their
 * connector routes with the ids bare inside the signed body, refuse another
 * account's namespaced ids, keep the connector's failureClass as the code,
 * mark the followed-channel list as partial and answer
 * unsupported_capability on other channels.
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
const COMMUNITY = '120363000000000100@g.us';
const GROUP = '120363000000000104@g.us';
const CHANNEL = '120363400253693272@newsletter';
const connectorError = (status: number, payload: unknown) =>
  new Error(`Connector error ${status}: ${JSON.stringify(payload)}`);

describe('social_list_communities / social_get_community', () => {
  it('lists through GET /communities and reads one through POST /communities/state', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockResolvedValueOnce({ communities: [{ communityId: COMMUNITY }], count: 1 });
    const list = await run('social_list_communities', wa);
    expect(connectorCall).toHaveBeenLastCalledWith(
      'http://wa-professional',
      'GET',
      '/api/v1/communities',
      undefined
    );
    expect(list.structuredContent).toMatchObject({
      ok: true,
      data: { count: 1 },
      meta: { source: { kind: 'providerQuery', completeness: 'complete' } },
    });
    await run('social_get_community', { ...wa, target: `professional:${COMMUNITY}` });
    expect(connectorCall).toHaveBeenLastCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/communities/state',
      { communityId: COMMUNITY }
    );
  });

  it('keeps not_a_community with the community id; refuses index reads, other accounts and channels', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockRejectedValueOnce(
      connectorError(422, {
        error: 'a group of the community',
        failureClass: 'not_a_community',
        communityId: COMMUNITY,
      })
    );
    const out = await run('social_get_community', { ...wa, target: GROUP });
    expect(out.structuredContent.error).toMatchObject({
      code: 'not_a_community',
      details: { status: 422, communityId: COMMUNITY },
    });
    connectorCall.mockClear();
    const index = await run('social_list_communities', { ...wa, readSource: 'index' });
    expect(index.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    const foreign = await run('social_get_community', {
      channel: 'whatsapp',
      accountId: 'personal',
      target: `professional:${COMMUNITY}`,
    });
    expect(foreign.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    const direct = await run('social_get_community', { ...wa, target: '34600@s.whatsapp.net' });
    expect(direct.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    const telegram = await run('social_list_communities', {
      channel: 'telegram',
      accountId: 'personal',
    });
    expect(telegram.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    expect(connectorCall).not.toHaveBeenCalled();
  });
});

describe('social_manage_community', () => {
  it('creates, links, unlinks and leaves through the community routes with the caller', async () => {
    const { run, connectorCall } = serverWith();
    await runWithRequestActor({ sub: 'sub-1', name: 'dani' }, async () => {
      await run('social_manage_community', {
        ...wa,
        action: 'create',
        subject: 'Liga',
        description: 'Torneos',
      });
      await run('social_manage_community', {
        ...wa,
        action: 'link',
        target: `professional:${COMMUNITY}`,
        group: `professional:${GROUP}`,
      });
      await run('social_manage_community', {
        ...wa,
        action: 'unlink',
        target: COMMUNITY,
        group: GROUP,
      });
      await run('social_manage_community', {
        ...wa,
        action: 'leave',
        target: COMMUNITY,
        confirm: true,
      });
    });
    expect(connectorCall.mock.calls.map(call => call.slice(1, 4))).toEqual([
      [
        'POST',
        '/api/v1/communities/create',
        { subject: 'Liga', description: 'Torneos', actor: 'dani' },
      ],
      [
        'POST',
        '/api/v1/communities/groups',
        { communityId: COMMUNITY, groupId: GROUP, action: 'link', actor: 'dani' },
      ],
      [
        'POST',
        '/api/v1/communities/groups',
        { communityId: COMMUNITY, groupId: GROUP, action: 'unlink', actor: 'dani' },
      ],
      [
        'POST',
        '/api/v1/communities/leave',
        { communityId: COMMUNITY, confirm: true, actor: 'dani' },
      ],
    ]);
  });

  it('the schema requires subject / target + group / target + confirm per action', async () => {
    const { run, connectorCall } = serverWith();
    for (const args of [
      { action: 'create' },
      { action: 'link', target: COMMUNITY },
      { action: 'unlink', group: GROUP },
      { action: 'leave', target: COMMUNITY },
      { action: 'leave', target: COMMUNITY, confirm: false },
      { action: 'rename', target: COMMUNITY },
    ]) {
      await expect(run('social_manage_community', { ...wa, ...args })).rejects.toMatchObject({
        canonicalCode: 'invalid_request',
      });
    }
    const foreignGroup = await run('social_manage_community', {
      channel: 'whatsapp',
      accountId: 'personal',
      action: 'link',
      target: COMMUNITY,
      group: `professional:${GROUP}`,
    });
    expect(foreignGroup.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    expect(foreignGroup.structuredContent.error.message).toMatch(
      /group belongs to the professional/
    );
    const notGroup = await run('social_manage_community', {
      ...wa,
      action: 'link',
      target: COMMUNITY,
      group: CHANNEL,
    });
    expect(notGroup.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('keeps the connector failureClass (linked_elsewhere, change_not_confirmed, disabled_sending)', async () => {
    const { run, connectorCall } = serverWith();
    for (const [status, failureClass] of [
      [409, 'linked_elsewhere'],
      [409, 'change_not_confirmed'],
      [403, 'not_community_admin'],
      [403, 'disabled_sending'],
    ] as const) {
      connectorCall.mockRejectedValueOnce(connectorError(status, { error: 'x', failureClass }));
      const out = await run('social_manage_community', {
        ...wa,
        action: 'link',
        target: COMMUNITY,
        group: GROUP,
      });
      expect(out.structuredContent).toMatchObject({
        ok: false,
        error: { code: failureClass, details: { status } },
      });
    }
  });
});

describe('social_lookup_channel / social_list_channels / social_manage_channel_subscription', () => {
  it('looks up by jid or link, lists as a partial read', async () => {
    const { run, connectorCall } = serverWith();
    await run('social_lookup_channel', {
      ...wa,
      target: 'https://whatsapp.com/channel/0029VaClub',
    });
    expect(connectorCall).toHaveBeenLastCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/channels/lookup',
      { channel: 'https://whatsapp.com/channel/0029VaClub' }
    );
    await run('social_lookup_channel', { ...wa, target: `professional:${CHANNEL}` });
    expect(connectorCall).toHaveBeenLastCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/channels/lookup',
      { channel: CHANNEL }
    );
    connectorCall.mockResolvedValueOnce({ channels: [], count: 0, coverage: { complete: false } });
    const list = await run('social_list_channels', wa);
    expect(connectorCall).toHaveBeenLastCalledWith(
      'http://wa-professional',
      'GET',
      '/api/v1/channels',
      undefined
    );
    expect(list.structuredContent).toMatchObject({
      ok: true,
      data: { coverage: { complete: false } },
      meta: { source: { completeness: 'partial' } },
    });
  });

  it('follows / mutes through POST /channels/subscription with the caller', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockResolvedValueOnce({ updated: true, changed: true, confirmed: true });
    const out = await runWithRequestActor({ sub: 'sub-1', name: 'dani' }, () =>
      run('social_manage_channel_subscription', { ...wa, target: CHANNEL, action: 'mute' })
    );
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/channels/subscription',
      { channelId: CHANNEL, action: 'mute', actor: 'dani' }
    );
    expect(out.structuredContent).toMatchObject({ ok: true, data: { changed: true } });
  });

  it('refuses a link as subscription target, unknown actions, other accounts and channels', async () => {
    const { run, connectorCall } = serverWith();
    const link = await run('social_manage_channel_subscription', {
      ...wa,
      target: 'https://whatsapp.com/channel/0029VaClub',
      action: 'follow',
    });
    expect(link.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    expect(link.structuredContent.error.message).toMatch(/social_lookup_channel/);
    await expect(
      run('social_manage_channel_subscription', { ...wa, target: CHANNEL, action: 'join' })
    ).rejects.toMatchObject({ canonicalCode: 'invalid_request' });
    const foreign = await run('social_lookup_channel', {
      channel: 'whatsapp',
      accountId: 'personal',
      target: `professional:${CHANNEL}`,
    });
    expect(foreign.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    const telegram = await run('social_list_channels', {
      channel: 'telegram',
      accountId: 'personal',
    });
    expect(telegram.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('keeps channel_unavailable, not_following and change_not_confirmed as codes', async () => {
    const { run, connectorCall } = serverWith();
    for (const [status, failureClass] of [
      [404, 'channel_unavailable'],
      [422, 'not_following'],
      [409, 'change_not_confirmed'],
    ] as const) {
      connectorCall.mockRejectedValueOnce(connectorError(status, { error: 'x', failureClass }));
      const out = await run('social_manage_channel_subscription', {
        ...wa,
        target: CHANNEL,
        action: 'follow',
      });
      expect(out.structuredContent.error).toMatchObject({
        code: failureClass,
        details: { status },
      });
    }
  });
});

describe('registry', () => {
  it('reads are reads; manage_community is destructive; the subscription is an idempotent write', () => {
    const byName = (name: string) => SOCIAL_TOOL_REGISTRY.find(tool => tool.name === name)!;
    for (const name of [
      'social_list_communities',
      'social_get_community',
      'social_lookup_channel',
      'social_list_channels',
    ]) {
      expect(byName(name)).toMatchObject({ effect: 'read', authScope: 'social.read' });
    }
    expect(byName('social_manage_community')).toMatchObject({
      effect: 'destructive',
      authScope: 'social.write',
      annotations: { destructiveHint: true, idempotentHint: false },
    });
    expect(byName('social_manage_channel_subscription')).toMatchObject({
      effect: 'externalWrite',
      authScope: 'social.write',
      annotations: { destructiveHint: false, idempotentHint: true },
    });
  });
});
