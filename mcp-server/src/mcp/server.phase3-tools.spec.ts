import { runWithRequestActor } from '@mcp-socialmedia/shared';
import { useTestAccounts } from '../domain/test-accounts';
import { MCPServer } from './server';
import { SOCIAL_TOOL_REGISTRY } from './tool-registry';

/**
 * Fase 3 WhatsApp tools (reactions, chat state, groups, polls / events, start
 * chat, contacts, presence / privacy reads): each reaches its connector route
 * with the ids bare inside the signed body, refuses another account's
 * namespaced ids, maps the connector's {error, failureClass} to a canonical
 * code and answers unsupported_capability on channels without the route.
 */
function serverWith() {
  const server = Object.create(MCPServer.prototype) as MCPServer;
  const connectorCall = jest.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true }));
  useTestAccounts({
    whatsapp: { personal: 'http://wa-personal', professional: 'http://wa-professional' },
    telegram: { personal: 'http://tg-personal', professional: 'http://tg-professional' },
  });
  Object.assign(server as unknown as Record<string, unknown>, {
    connectorCall,
    logger: { error: jest.fn() },
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

describe('social_react_message', () => {
  it('reacts on WhatsApp through POST /messages/react with bare ids', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockResolvedValueOnce({ reacted: true, emoji: '👍', messageId: '3EB0AAA' });
    const out = await run('social_react_message', {
      ...wa,
      target: 'professional:34600@s.whatsapp.net',
      messageId: 'professional:3EB0AAA',
      emoji: '👍',
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/messages/react',
      { conversationId: '34600@s.whatsapp.net', messageId: '3EB0AAA', emoji: '👍' }
    );
    expect(out.structuredContent).toMatchObject({
      ok: true,
      status: 'accepted',
      data: { reacted: true },
    });
  });

  it('reacts on Telegram with the message number and clears with an empty emoji', async () => {
    const { run, connectorCall } = serverWith();
    await run('social_react_message', {
      channel: 'telegram',
      accountId: 'personal',
      target: 'tg_12345',
      messageId: 'tg_12345_77',
      emoji: '',
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://tg-personal',
      'POST',
      '/api/v1/messages/react',
      { chatId: '12345', messageId: 77, emoji: null }
    );
  });

  it('refuses a message id of another account and answers unsupported on Instagram', async () => {
    const { run, connectorCall } = serverWith();
    const foreign = await run('social_react_message', {
      channel: 'whatsapp',
      accountId: 'personal',
      target: '34600@s.whatsapp.net',
      messageId: 'professional:3EB0AAA',
      emoji: '👍',
    });
    expect(foreign.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    expect(foreign.structuredContent.error.message).toMatch(/professional WhatsApp namespace/);
    const ig = await run('social_react_message', {
      channel: 'instagram',
      accountId: 'skirmshop',
      target: '1',
      messageId: '2',
      emoji: '👍',
    });
    expect(ig.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('maps the connector gate (403 disabled_sending) to its failureClass with details', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockRejectedValueOnce(
      connectorError(403, { error: 'Sending disabled', failureClass: 'disabled_sending' })
    );
    const out = await run('social_react_message', {
      ...wa,
      target: '34600@s.whatsapp.net',
      messageId: '3EB0AAA',
      emoji: '👍',
    });
    expect(out.isError).toBe(true);
    expect(out.structuredContent).toMatchObject({
      ok: false,
      status: 'failed',
      error: {
        code: 'disabled_sending',
        details: { status: 403, failureClass: 'disabled_sending' },
      },
    });
  });
});

describe('social_set_chat_state', () => {
  it('mutes for a duration through POST /chats/modify and records the caller', async () => {
    const { run, connectorCall } = serverWith();
    await runWithRequestActor({ sub: 'sub-1', name: 'dani' }, () =>
      run('social_set_chat_state', {
        ...wa,
        target: 'professional:34600@s.whatsapp.net',
        action: 'mute',
        durationMs: 3600000,
      })
    );
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/chats/modify',
      {
        conversationId: '34600@s.whatsapp.net',
        action: 'mute',
        durationMs: 3600000,
        actor: 'dani',
      }
    );
  });

  // Schema refusals throw before the call (the MCP handler turns them into invalid_request).
  it('rejects a mute duration on another action and both mute bounds at once', async () => {
    const { run, connectorCall } = serverWith();
    await expect(
      run('social_set_chat_state', {
        ...wa,
        target: '34600@s.whatsapp.net',
        action: 'archive',
        durationMs: 1000,
      })
    ).rejects.toMatchObject({ canonicalCode: 'invalid_request' });
    await expect(
      run('social_set_chat_state', {
        ...wa,
        target: '34600@s.whatsapp.net',
        action: 'mute',
        durationMs: 1000,
        muteUntil: '2030-01-01T00:00:00Z',
      })
    ).rejects.toMatchObject({ canonicalCode: 'invalid_request' });
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('answers unsupported_capability on Telegram', async () => {
    const { run, connectorCall } = serverWith();
    const out = await run('social_set_chat_state', {
      channel: 'telegram',
      accountId: 'personal',
      target: '12345',
      action: 'archive',
    });
    expect(out.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('keeps invalid_request from a connector 400', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockRejectedValueOnce(
      connectorError(400, {
        error: 'muteUntil must be a future time',
        failureClass: 'invalid_request',
      })
    );
    const out = await run('social_set_chat_state', {
      ...wa,
      target: '34600@s.whatsapp.net',
      action: 'mute',
      muteUntil: '2020-01-01T00:00:00Z',
    });
    expect(out.structuredContent.error).toMatchObject({ code: 'invalid_request' });
  });
});

describe('social_get_group / social_manage_group', () => {
  it('reads group state through POST /groups/state', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockResolvedValueOnce({ group: { groupId: '1203@g.us' } });
    const out = await run('social_get_group', { ...wa, target: 'professional:1203@g.us' });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/groups/state',
      { groupId: '1203@g.us' }
    );
    expect(out.structuredContent).toMatchObject({
      status: 'completed',
      meta: { source: { kind: 'providerQuery' } },
    });
  });

  it('refuses a non-group target and the local index', async () => {
    const { run, connectorCall } = serverWith();
    const direct = await run('social_get_group', { ...wa, target: '34600@s.whatsapp.net' });
    expect(direct.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    const index = await run('social_get_group', {
      ...wa,
      target: '1203@g.us',
      readSource: 'index',
    });
    expect(index.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('creates a group with bare participants', async () => {
    const { run, connectorCall } = serverWith();
    await run('social_manage_group', {
      ...wa,
      action: 'create',
      subject: 'Equipo',
      participants: ['+34600000001', 'professional:34600000002@s.whatsapp.net'],
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/groups/create',
      { subject: 'Equipo', participants: ['+34600000001', '34600000002@s.whatsapp.net'] }
    );
  });

  it('updates subject and settings, and maps participant actions', async () => {
    const { run, connectorCall } = serverWith();
    await run('social_manage_group', {
      ...wa,
      target: '1203@g.us',
      action: 'update',
      subject: 'Nuevo',
      announce: true,
    });
    expect(connectorCall).toHaveBeenLastCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/groups/update',
      { groupId: '1203@g.us', subject: 'Nuevo', settings: { announce: true } }
    );
    await run('social_manage_group', {
      ...wa,
      target: '1203@g.us',
      action: 'promoteParticipants',
      participants: ['34600000001@s.whatsapp.net'],
    });
    expect(connectorCall).toHaveBeenLastCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/groups/participants',
      { groupId: '1203@g.us', action: 'promote', participants: ['34600000001@s.whatsapp.net'] }
    );
  });

  it('refuses another account participant and an update with nothing to change', async () => {
    const { run, connectorCall } = serverWith();
    const foreign = await run('social_manage_group', {
      channel: 'whatsapp',
      accountId: 'personal',
      target: '1203@g.us',
      action: 'addParticipants',
      participants: ['1@s.whatsapp.net', 'professional:2@s.whatsapp.net'],
    });
    expect(foreign.structuredContent.error.message).toMatch(/professional WhatsApp namespace/);
    await expect(
      run('social_manage_group', { ...wa, target: '1203@g.us', action: 'update' })
    ).rejects.toMatchObject({ canonicalCode: 'invalid_request' });
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('maps 403 not_group_admin', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockRejectedValueOnce(
      connectorError(403, { error: 'Only admins', failureClass: 'not_group_admin' })
    );
    const out = await run('social_manage_group', {
      ...wa,
      target: '1203@g.us',
      action: 'removeParticipants',
      participants: ['34600000001'],
    });
    expect(out.structuredContent.error).toMatchObject({ code: 'not_group_admin' });
  });
});

describe('polls and events', () => {
  it('sends a poll with a scoped connector Idempotency-Key', async () => {
    await runWithRedisDouble(async server => {
      await server.run('social_send_poll', {
        ...wa,
        target: '34600@s.whatsapp.net',
        question: '¿Cuándo?',
        options: ['Lunes', 'Martes'],
        selectableCount: 1,
        idempotencyKey: 'k-1',
      });
      const [url, method, path, body, timeout, headers] = server.connectorCall.mock.calls[0];
      expect([url, method, path, timeout]).toEqual([
        'http://wa-professional',
        'POST',
        '/api/v1/messages/poll',
        undefined,
      ]);
      expect(body).toEqual({
        conversationId: '34600@s.whatsapp.net',
        name: '¿Cuándo?',
        options: ['Lunes', 'Martes'],
        selectableCount: 1,
      });
      expect((headers as Record<string, string>)['Idempotency-Key']).toMatch(/^mcp-[0-9a-f]{64}$/);
    });
  });

  it('votes, retracts and reads poll results with bare message ids', async () => {
    const { run, connectorCall } = serverWith();
    await run('social_vote_poll', {
      ...wa,
      target: '34600@s.whatsapp.net',
      messageId: 'professional:3EB0POLL',
      options: [],
    });
    expect(connectorCall).toHaveBeenLastCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/messages/poll/vote',
      { conversationId: '34600@s.whatsapp.net', messageId: '3EB0POLL', options: [] }
    );
    await run('social_get_poll_results', {
      ...wa,
      target: '34600@s.whatsapp.net',
      messageId: '3EB0POLL',
    });
    expect(connectorCall).toHaveBeenLastCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/messages/poll/results',
      { conversationId: '34600@s.whatsapp.net', messageId: '3EB0POLL' }
    );
  });

  it('maps a refused vote (400 with validOptions) and 422 poll_secret_unavailable', async () => {
    const { run, connectorCall } = serverWith();
    const vote = {
      ...wa,
      target: '34600@s.whatsapp.net',
      messageId: '3EB0POLL',
      options: ['Domingo'],
    };
    connectorCall.mockRejectedValueOnce(
      connectorError(400, {
        error: 'Unknown option',
        failureClass: 'invalid_request',
        details: { validOptions: ['Lunes', 'Martes'] },
      })
    );
    const unknown = await run('social_vote_poll', vote);
    expect(unknown.structuredContent.error).toMatchObject({
      code: 'invalid_request',
      details: { status: 400, details: { validOptions: ['Lunes', 'Martes'] } },
    });
    connectorCall.mockRejectedValueOnce(
      connectorError(422, { error: 'no secret', failureClass: 'poll_secret_unavailable' })
    );
    const secret = await run('social_vote_poll', vote);
    expect(secret.structuredContent.error).toMatchObject({
      code: 'poll_secret_unavailable',
      details: { status: 422 },
    });
  });

  it('sends an event and responds to one', async () => {
    const { run, connectorCall } = serverWith();
    await run('social_send_event', {
      ...wa,
      target: '1203@g.us',
      name: 'Cena',
      startTime: '2026-10-10T20:00:00Z',
      location: { name: 'Casa', degreesLatitude: 40.4, degreesLongitude: -3.7 },
      call: 'video',
    });
    expect(connectorCall).toHaveBeenLastCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/messages/event',
      {
        conversationId: '1203@g.us',
        name: 'Cena',
        startTime: '2026-10-10T20:00:00Z',
        location: { name: 'Casa', degreesLatitude: 40.4, degreesLongitude: -3.7 },
        call: 'video',
      }
    );
    await run('social_respond_event', {
      ...wa,
      target: '1203@g.us',
      messageId: '3EB0EVT',
      response: 'going',
      extraGuestCount: 2,
    });
    expect(connectorCall).toHaveBeenLastCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/messages/event/respond',
      { conversationId: '1203@g.us', messageId: '3EB0EVT', response: 'going', extraGuestCount: 2 }
    );
    await run('social_get_event_results', { ...wa, target: '1203@g.us', messageId: '3EB0EVT' });
    expect(connectorCall).toHaveBeenLastCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/messages/event/results',
      { conversationId: '1203@g.us', messageId: '3EB0EVT' }
    );
  });

  it('answers unsupported_capability for polls on Telegram and Instagram', async () => {
    const { run, connectorCall } = serverWith();
    for (const channel of [
      { channel: 'telegram', accountId: 'personal' },
      { channel: 'instagram', accountId: 'skirmshop' },
    ]) {
      const out = await run('social_send_poll', {
        ...channel,
        target: '1',
        question: 'q',
        options: ['a', 'b'],
      });
      expect(out.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    }
    expect(connectorCall).not.toHaveBeenCalled();
  });
});

describe('social_start_chat', () => {
  it('starts a chat and returns the canonical conversation', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockResolvedValueOnce({
      started: true,
      chat: { conversationId: 'professional:34600000001@c.us', chatId: '34600000001@c.us' },
    });
    const out = await run('social_start_chat', { ...wa, phone: '+34600000001' });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/chats/start',
      { phone: '+34600000001' }
    );
    expect(out.structuredContent.data).toMatchObject({
      chat: { conversationId: 'professional:34600000001@c.us' },
    });
  });

  it('surfaces account_restricted with a wa.me link for a human', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockRejectedValueOnce(
      connectorError(403, { error: 'restricted', failureClass: 'account_restricted' })
    );
    const out = await run('social_start_chat', {
      ...wa,
      phone: '+34600000001',
      message: 'Hola',
    });
    expect(out.structuredContent.error).toMatchObject({
      code: 'account_restricted',
      details: { fallback: { manualOpenUrl: 'https://wa.me/34600000001?text=Hola' } },
    });
    expect(out.structuredContent.error.message).toMatch(/https:\/\/wa\.me\/34600000001\?text=Hola/);
  });

  it('maps 422 not_on_whatsapp and refuses Telegram', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockRejectedValueOnce(
      connectorError(422, { error: 'Not on WhatsApp', failureClass: 'not_on_whatsapp' })
    );
    const out = await run('social_start_chat', { ...wa, phone: '+34600000009' });
    expect(out.structuredContent.error).toMatchObject({ code: 'not_on_whatsapp' });
    const tg = await run('social_start_chat', {
      channel: 'telegram',
      accountId: 'personal',
      phone: '+34600000009',
    });
    expect(tg.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
  });
});

describe('contacts', () => {
  it('shares contact cards and lists contacts from the index', async () => {
    const { run, connectorCall } = serverWith();
    const contacts = [{ displayName: 'Ana', phone: '+34600000001' }];
    await run('social_share_contact', { ...wa, target: '34600@s.whatsapp.net', contacts });
    expect(connectorCall).toHaveBeenLastCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/contacts/share',
      { conversationId: '34600@s.whatsapp.net', contacts }
    );
    connectorCall.mockResolvedValueOnce({ contacts: [], count: 0 });
    const out = await run('social_list_contacts', { ...wa, query: 'Ana', limit: 10 });
    expect(connectorCall).toHaveBeenLastCalledWith(
      'http://wa-professional',
      'GET',
      '/api/v1/contacts?q=Ana&limit=10',
      undefined
    );
    expect(out.structuredContent.meta.source.kind).toBe('localIndex');
  });

  it('refuses readSource=provider for contacts and a sixth card', async () => {
    const { run, connectorCall } = serverWith();
    const provider = await run('social_list_contacts', { ...wa, readSource: 'provider' });
    expect(provider.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    const card = { displayName: 'A', phone: '+34600000001' };
    await expect(
      run('social_share_contact', {
        ...wa,
        target: '34600@s.whatsapp.net',
        contacts: [card, card, card, card, card, card],
      })
    ).rejects.toMatchObject({ canonicalCode: 'invalid_request' });
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('maps a route the deployed connector lacks (404 without failureClass)', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockRejectedValueOnce(
      new Error('Connector error 404: Cannot GET /api/v1/contacts')
    );
    const out = await run('social_list_contacts', wa);
    expect(out.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
  });
});

describe('presence and privacy (read-only)', () => {
  it('reads presence of a group participant', async () => {
    const { run, connectorCall } = serverWith();
    await run('social_get_presence', {
      ...wa,
      target: '1203@g.us',
      participant: 'professional:34600000001@s.whatsapp.net',
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/chats/presence/read',
      { conversationId: '1203@g.us', participant: '34600000001@s.whatsapp.net' }
    );
  });

  it('reads privacy settings and, with target, the chat disappearing timer', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall
      .mockResolvedValueOnce({ privacy: { settings: { lastSeen: 'contacts' } } })
      .mockResolvedValueOnce({ disappearing: { expiration: 604800 } });
    const out = await run('social_get_privacy', { ...wa, target: '34600@s.whatsapp.net' });
    expect(connectorCall.mock.calls).toEqual([
      ['http://wa-professional', 'GET', '/api/v1/privacy', undefined],
      [
        'http://wa-professional',
        'POST',
        '/api/v1/chats/disappearing/read',
        { conversationId: '34600@s.whatsapp.net' },
      ],
    ]);
    expect(out.structuredContent.data).toEqual({
      privacy: { settings: { lastSeen: 'contacts' } },
      disappearing: { expiration: 604800 },
    });
  });

  it('maps 503 disconnected and exposes no presence or privacy writes', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockRejectedValueOnce(
      connectorError(503, { error: 'not connected', failureClass: 'disconnected' })
    );
    const out = await run('social_get_privacy', wa);
    expect(out.structuredContent.error).toMatchObject({ code: 'disconnected' });
    for (const name of ['social_get_presence', 'social_get_privacy']) {
      const tool = SOCIAL_TOOL_REGISTRY.find(candidate => candidate.name === name)!;
      expect(tool.effect).toBe('read');
      expect(tool.annotations.readOnlyHint).toBe(true);
    }
  });
});

describe('social_block_contact', () => {
  it('blocks the 1:1 conversation through POST /contacts/block with confirm and the caller', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockResolvedValueOnce({
      ok: true,
      action: 'block',
      blocked: true,
      changed: true,
    });
    const out = await runWithRequestActor({ sub: 'sub-1', name: 'dani' }, () =>
      run('social_block_contact', {
        ...wa,
        target: 'professional:34600@s.whatsapp.net',
        action: 'block',
        confirm: true,
      })
    );
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/contacts/block',
      { conversationId: '34600@s.whatsapp.net', action: 'block', confirm: true, actor: 'dani' }
    );
    expect(out.structuredContent).toMatchObject({ ok: true, data: { blocked: true } });
  });

  it('unblocks by phone', async () => {
    const { run, connectorCall } = serverWith();
    await run('social_block_contact', {
      ...wa,
      phone: '+34600111222',
      action: 'unblock',
      confirm: true,
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/contacts/block',
      { phone: '+34600111222', action: 'unblock', confirm: true }
    );
  });

  it('refuses without confirm: true (schema) and with both or neither target and phone', async () => {
    const { run, connectorCall } = serverWith();
    for (const confirm of [undefined, false]) {
      await expect(
        run('social_block_contact', {
          ...wa,
          target: '34600@s.whatsapp.net',
          action: 'block',
          ...(confirm === undefined ? {} : { confirm }),
        })
      ).rejects.toMatchObject({ canonicalCode: 'invalid_request' });
    }
    for (const ids of [{}, { target: '34600@s.whatsapp.net', phone: '+34600111222' }]) {
      const out = await run('social_block_contact', {
        ...wa,
        ...ids,
        action: 'block',
        confirm: true,
      });
      expect(out.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    }
    const foreign = await run('social_block_contact', {
      channel: 'whatsapp',
      accountId: 'personal',
      target: 'professional:34600@s.whatsapp.net',
      action: 'block',
      confirm: true,
    });
    expect(foreign.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    const tg = await run('social_block_contact', {
      channel: 'telegram',
      accountId: 'personal',
      target: '12345',
      action: 'block',
      confirm: true,
    });
    expect(tg.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('maps the connector refusals to their failureClass', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall
      .mockRejectedValueOnce(
        connectorError(403, { error: 'Sending disabled', failureClass: 'disabled_sending' })
      )
      .mockRejectedValueOnce(
        connectorError(422, { error: 'no LID yet', failureClass: 'identity_unresolved' })
      );
    const args = { ...wa, target: '34600@s.whatsapp.net', action: 'block', confirm: true };
    const gated = await run('social_block_contact', args);
    expect(gated.structuredContent.error).toMatchObject({
      code: 'disabled_sending',
      details: { status: 403 },
    });
    const unresolved = await run('social_block_contact', args);
    expect(unresolved.structuredContent.error).toMatchObject({ code: 'identity_unresolved' });
  });

  it('is a destructive write and social_list_blocked a read', () => {
    const block = SOCIAL_TOOL_REGISTRY.find(tool => tool.name === 'social_block_contact')!;
    expect(block.effect).toBe('destructive');
    expect(block.annotations.destructiveHint).toBe(true);
    expect((block.inputSchema.properties as Record<string, unknown>).confirm).toMatchObject({
      const: true,
    });
    const list = SOCIAL_TOOL_REGISTRY.find(tool => tool.name === 'social_list_blocked')!;
    expect(list.effect).toBe('read');
    expect(list.annotations.readOnlyHint).toBe(true);
  });
});

describe('social_list_blocked', () => {
  it('reads GET /contacts/blocklist, fresh on demand', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockResolvedValue({ blocked: [], count: 0, cached: false });
    await run('social_list_blocked', wa);
    const out = await run('social_list_blocked', { ...wa, fresh: true });
    expect(connectorCall.mock.calls).toEqual([
      ['http://wa-professional', 'GET', '/api/v1/contacts/blocklist', undefined],
      ['http://wa-professional', 'GET', '/api/v1/contacts/blocklist?fresh=1', undefined],
    ]);
    expect(out.structuredContent).toMatchObject({ ok: true, data: { count: 0 } });
  });

  it('is provider-only and WhatsApp-only', async () => {
    const { run, connectorCall } = serverWith();
    const index = await run('social_list_blocked', { ...wa, readSource: 'index' });
    expect(index.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    const tg = await run('social_list_blocked', { channel: 'telegram', accountId: 'personal' });
    expect(tg.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    expect(connectorCall).not.toHaveBeenCalled();
  });
});

describe('social_edit_message / social_delete_message error codes', () => {
  it('keep the connector failureClass as the code on WhatsApp and Telegram', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall
      .mockRejectedValueOnce(
        connectorError(422, { error: 'too late', failureClass: 'rejected_by_whatsapp' })
      )
      .mockRejectedValueOnce(
        connectorError(403, { error: 'Sending is disabled', failureClass: 'disabled_sending' })
      )
      .mockRejectedValueOnce(
        connectorError(404, { error: 'gone', failureClass: 'message_unavailable' })
      )
      .mockRejectedValueOnce(
        connectorError(403, { error: 'Sending is disabled', failureClass: 'disabled_sending' })
      );
    const waEdit = await run('social_edit_message', {
      ...wa,
      target: '34600@s.whatsapp.net',
      messageId: '3EB0OLD',
      message: 'x',
    });
    expect(waEdit.structuredContent.error).toMatchObject({
      code: 'rejected_by_whatsapp',
      details: { status: 422, failureClass: 'rejected_by_whatsapp' },
    });
    const tgEdit = await run('social_edit_message', {
      channel: 'telegram',
      accountId: 'personal',
      target: '12345',
      messageId: '77',
      message: 'x',
    });
    expect(tgEdit.structuredContent.error).toMatchObject({ code: 'disabled_sending' });
    const waDelete = await run('social_delete_message', {
      ...wa,
      target: '34600@s.whatsapp.net',
      messageId: 'NOPE',
    });
    expect(waDelete.structuredContent.error).toMatchObject({ code: 'message_unavailable' });
    const tgDelete = await run('social_delete_message', {
      channel: 'telegram',
      accountId: 'personal',
      target: '12345',
      messageId: '77',
    });
    expect(tgDelete.structuredContent.error).toMatchObject({ code: 'disabled_sending' });
    expect(connectorCall.mock.calls.map(call => [call[1], call[2]])).toEqual([
      ['POST', '/api/v1/messages/edit'],
      ['POST', '/api/v1/messages/edit'],
      ['POST', '/api/v1/messages/delete'],
      ['DELETE', '/api/v1/messages/12345/77'],
    ]);
  });

  it('answer provider_error for a connector error without failureClass', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockRejectedValueOnce(connectorError(500, { error: 'boom' }));
    const out = await run('social_delete_message', {
      channel: 'telegram',
      accountId: 'personal',
      target: '12345',
      messageId: '77',
    });
    expect(out.structuredContent.error).toMatchObject({
      code: 'provider_error',
      details: { status: 500 },
    });
  });
});

/** A server whose Redis double lets an idempotencyKey through (first use). */
async function runWithRedisDouble(
  body: (server: {
    run: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    connectorCall: jest.Mock;
  }) => Promise<void>
): Promise<void> {
  const server = Object.create(MCPServer.prototype) as MCPServer;
  const connectorCall = jest.fn(async (..._args: unknown[]): Promise<unknown> => ({ sent: true }));
  useTestAccounts({ whatsapp: { professional: 'http://wa-professional' } });
  Object.assign(server as unknown as Record<string, unknown>, {
    connectorCall,
    logger: { error: jest.fn() },
    redisClient: { set: jest.fn(async () => 'OK'), get: jest.fn(async () => null) },
  });
  const any = server as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  await body({
    connectorCall,
    run: (name, args) =>
      any.executeCanonicalTool(
        SOCIAL_TOOL_REGISTRY.find(tool => tool.name === name),
        args
      ),
  });
}
