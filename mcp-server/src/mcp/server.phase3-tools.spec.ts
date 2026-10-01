import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('surfaces inviteRequired of an add, in data (200) and in error.details (422)', async () => {
    const { run, connectorCall } = serverWith();
    const inviteRequired = [
      {
        participant: '+34600000002',
        jid: '34600000002@s.whatsapp.net',
        privateInvite: true,
        inviteExpiresAt: '2026-10-04T10:00:00.000Z',
      },
    ];
    const add = {
      ...wa,
      target: '1203@g.us',
      action: 'addParticipants',
      participants: ['+34600000001', '+34600000002'],
    };
    connectorCall.mockResolvedValueOnce({
      updated: true,
      action: 'add',
      succeeded: 1,
      failed: 1,
      partial: true,
      inviteRequired,
    });
    const partial = await run('social_manage_group', add);
    expect(partial.structuredContent).toMatchObject({
      ok: true,
      data: { partial: true, inviteRequired },
    });
    connectorCall.mockRejectedValueOnce(
      connectorError(422, {
        error: 'WhatsApp did not add any',
        failureClass: 'rejected_by_whatsapp',
        action: 'add',
        succeeded: 0,
        failed: 1,
        inviteRequired,
      })
    );
    const refused = await run('social_manage_group', {
      ...add,
      participants: ['+34600000002'],
    });
    expect(refused.structuredContent.error).toMatchObject({
      code: 'rejected_by_whatsapp',
      details: { status: 422, inviteRequired },
    });
  });
});

describe('social_invite_to_group', () => {
  const invite = {
    ...wa,
    target: 'professional:1203@g.us',
    participants: ['+34600000002', 'professional:34600000003@s.whatsapp.net', '1234@lid'],
  };

  it('invites through POST /groups/invite with bare ids, caption, caller and a scoped Idempotency-Key', async () => {
    await runWithRedisDouble(async server => {
      server.connectorCall.mockResolvedValueOnce({
        invited: true,
        groupId: '1203@g.us',
        results: [
          {
            participant: '+34600000002',
            jid: '34600000002@s.whatsapp.net',
            ok: true,
            reason: 'invited',
            invite: 'private',
            messageId: '3EB0INV',
          },
        ],
        succeeded: 1,
        failed: 0,
        partial: false,
      });
      const out = (await runWithRequestActor({ sub: 'sub-1', name: 'dani' }, () =>
        server.run('social_invite_to_group', {
          ...invite,
          text: 'Únete al grupo',
          idempotencyKey: 'inv-1',
        })
      )) as { structuredContent: Record<string, any> };
      const [url, method, path, body, timeout, headers] = server.connectorCall.mock.calls[0];
      expect([url, method, path, timeout]).toEqual([
        'http://wa-professional',
        'POST',
        '/api/v1/groups/invite',
        undefined,
      ]);
      expect(body).toEqual({
        groupId: '1203@g.us',
        participants: ['+34600000002', '34600000003@s.whatsapp.net', '1234@lid'],
        text: 'Únete al grupo',
        actor: 'dani',
      });
      expect((headers as Record<string, string>)['Idempotency-Key']).toMatch(/^mcp-[0-9a-f]{64}$/);
      expect(out.structuredContent).toMatchObject({
        ok: true,
        status: 'accepted',
        data: { invited: true, succeeded: 1, results: [{ reason: 'invited', invite: 'private' }] },
      });
    });
  });

  it('sends no caption or key when none is given', async () => {
    const { run, connectorCall } = serverWith();
    await run('social_invite_to_group', invite);
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/groups/invite',
      {
        groupId: '1203@g.us',
        participants: ['+34600000002', '34600000003@s.whatsapp.net', '1234@lid'],
      }
    );
  });

  it('refuses a non-group target, another account group or participant, Telegram and Instagram', async () => {
    const { run, connectorCall } = serverWith();
    const direct = await run('social_invite_to_group', {
      ...invite,
      target: '34600@s.whatsapp.net',
    });
    expect(direct.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    const foreignGroup = await run('social_invite_to_group', {
      ...invite,
      accountId: 'personal',
      participants: ['+34600000002'],
    });
    expect(foreignGroup.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    expect(foreignGroup.structuredContent.error.message).toMatch(/^target belongs to/);
    const foreignParticipant = await run('social_invite_to_group', {
      ...invite,
      accountId: 'personal',
      target: '1203@g.us',
    });
    expect(foreignParticipant.structuredContent.error.message).toMatch(
      /professional WhatsApp namespace/
    );
    const tg = await run('social_invite_to_group', {
      channel: 'telegram',
      accountId: 'personal',
      target: '-100123',
      participants: ['@someone'],
    });
    expect(tg.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    const ig = await run('social_invite_to_group', {
      channel: 'instagram',
      accountId: 'skirmshop',
      target: '1',
      participants: ['2'],
    });
    expect(ig.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    expect(connectorCall).not.toHaveBeenCalled();
  });

  // Schema refusals throw before the call (the MCP handler turns them into invalid_request).
  it('rejects no participants, more than 20, a long caption and a missing target', async () => {
    const { run, connectorCall } = serverWith();
    const many = Array.from({ length: 21 }, (_, i) => `+3460000${String(i).padStart(4, '0')}`);
    for (const args of [
      { ...invite, participants: [] },
      { ...invite, participants: many },
      { ...invite, text: 'x'.repeat(1025) },
      { ...wa, participants: ['+34600000002'] },
    ]) {
      await expect(run('social_invite_to_group', args)).rejects.toMatchObject({
        canonicalCode: 'invalid_request',
      });
    }
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('maps the gate, admin-only and invite_not_sent with the per-person results', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockRejectedValueOnce(
      connectorError(403, { error: 'Sending disabled', failureClass: 'disabled_sending' })
    );
    const gated = await run('social_invite_to_group', invite);
    expect(gated.structuredContent.error).toMatchObject({
      code: 'disabled_sending',
      details: { status: 403 },
    });
    connectorCall.mockRejectedValueOnce(
      connectorError(403, { error: 'Only admins', failureClass: 'not_group_admin' })
    );
    const admin = await run('social_invite_to_group', invite);
    expect(admin.structuredContent.error).toMatchObject({ code: 'not_group_admin' });
    const results = [
      {
        participant: '+34600000002',
        jid: '34600000002@s.whatsapp.net',
        ok: false,
        reason: 'invite_link_unavailable',
        invite: null,
        messageId: null,
      },
    ];
    connectorCall.mockRejectedValueOnce(
      connectorError(422, {
        error: 'Nobody was invited',
        failureClass: 'invite_not_sent',
        results,
        succeeded: 0,
        failed: 1,
      })
    );
    const none = await run('social_invite_to_group', invite);
    expect(none.structuredContent).toMatchObject({
      ok: false,
      status: 'failed',
      error: { code: 'invite_not_sent', details: { status: 422, results, succeeded: 0 } },
    });
  });

  it('is gated by the identity binding before reaching the connector', async () => {
    const saved = {
      on: process.env.SOCIAL_IDENTITY_BINDING,
      file: process.env.SOCIAL_IDENTITY_BINDINGS_FILE,
    };
    const dir = mkdtempSync(join(tmpdir(), 'invite-binding-'));
    const file = join(dir, 'bindings.yaml');
    writeFileSync(file, 'bindings:\n  - sub: sub-leila\n    label: leila\n    accounts: [leila]\n');
    process.env.SOCIAL_IDENTITY_BINDING = 'on';
    process.env.SOCIAL_IDENTITY_BINDINGS_FILE = file;
    try {
      const { run, connectorCall } = serverWith();
      await expect(
        runWithRequestActor({ sub: 'sub-leila' }, () => run('social_invite_to_group', invite))
      ).rejects.toMatchObject({ canonicalCode: 'forbidden' });
      expect(connectorCall).not.toHaveBeenCalled();
    } finally {
      for (const [key, value] of [
        ['SOCIAL_IDENTITY_BINDING', saved.on],
        ['SOCIAL_IDENTITY_BINDINGS_FILE', saved.file],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
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

describe('social_set_privacy', () => {
  const privacy = { ...wa, setting: 'lastSeen', value: 'contacts', confirm: true };

  it('changes one setting through POST /privacy with confirm and the caller', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockResolvedValueOnce({
      updated: true,
      setting: 'lastSeen',
      value: 'contacts',
      previous: 'all',
      changed: true,
    });
    const out = await runWithRequestActor({ sub: 'sub-1', name: 'dani' }, () =>
      run('social_set_privacy', privacy)
    );
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/privacy',
      {
        setting: 'lastSeen',
        value: 'contacts',
        confirm: true,
        actor: 'dani',
      }
    );
    expect(out.structuredContent).toMatchObject({
      ok: true,
      status: 'accepted',
      data: { changed: true, previous: 'all' },
    });
  });

  it('sets the default disappearing timer of new chats in seconds', async () => {
    const { run, connectorCall } = serverWith();
    await run('social_set_privacy', {
      ...wa,
      setting: 'defaultDisappearing',
      value: 604800,
      confirm: true,
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/privacy',
      {
        setting: 'defaultDisappearing',
        value: 604800,
        confirm: true,
      }
    );
  });

  it('refuses without confirm: true and values the connector does not accept (schema)', async () => {
    const { run, connectorCall } = serverWith();
    for (const args of [
      { ...privacy, confirm: undefined },
      { ...privacy, confirm: false },
      { ...privacy, setting: 'about' },
      { ...privacy, setting: 'online', value: 'none' },
      { ...privacy, setting: 'readReceipts', value: 'contacts' },
      { ...privacy, value: 'Contacts' },
      { ...privacy, setting: 'defaultDisappearing', value: 3600 },
      { ...privacy, setting: 'defaultDisappearing', value: '7d' },
      { ...privacy, channel: undefined },
      { ...privacy, accountId: undefined },
    ]) {
      await expect(run('social_set_privacy', args)).rejects.toMatchObject({
        canonicalCode: 'invalid_request',
      });
    }
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('maps 403 disabled_sending, 400 confirm_required and 422 rejected_by_whatsapp', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall
      .mockRejectedValueOnce(
        connectorError(403, { error: 'Sending disabled', failureClass: 'disabled_sending' })
      )
      .mockRejectedValueOnce(
        connectorError(400, {
          error: 'pass confirm: true',
          failureClass: 'invalid_request',
          code: 'confirm_required',
        })
      )
      .mockRejectedValueOnce(
        connectorError(422, { error: 'refused', failureClass: 'rejected_by_whatsapp', code: '400' })
      );
    const gated = await run('social_set_privacy', privacy);
    expect(gated.structuredContent.error).toMatchObject({
      code: 'disabled_sending',
      details: { status: 403 },
    });
    const confirm = await run('social_set_privacy', privacy);
    expect(confirm.structuredContent.error).toMatchObject({
      code: 'invalid_request',
      details: { status: 400, code: 'confirm_required' },
    });
    const rejected = await run('social_set_privacy', privacy);
    expect(rejected.structuredContent.error).toMatchObject({
      code: 'rejected_by_whatsapp',
      details: { status: 422 },
    });
  });

  it('is WhatsApp-only and a destructive write with confirm const true', async () => {
    const { run, connectorCall } = serverWith();
    for (const channel of [
      { channel: 'telegram', accountId: 'personal' },
      { channel: 'instagram', accountId: 'skirmshop' },
    ]) {
      const out = await run('social_set_privacy', { ...privacy, ...channel });
      expect(out.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    }
    expect(connectorCall).not.toHaveBeenCalled();
    const tool = SOCIAL_TOOL_REGISTRY.find(candidate => candidate.name === 'social_set_privacy')!;
    expect(tool.effect).toBe('destructive');
    expect(tool.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect((tool.inputSchema.properties as Record<string, unknown>).confirm).toEqual({
      const: true,
      description: expect.any(String),
    });
    expect(tool.inputSchema.required).toEqual(
      expect.arrayContaining(['channel', 'accountId', 'setting', 'value', 'confirm'])
    );
  });
});

describe('social_set_disappearing', () => {
  it('sets a chat timer through POST /chats/disappearing with the bare chat', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockResolvedValueOnce({
      updated: true,
      expiration: 86400,
      label: '24h',
      previous: 0,
      changed: true,
    });
    const out = await run('social_set_disappearing', {
      ...wa,
      target: 'professional:1203@g.us',
      expiration: 86400,
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/chats/disappearing',
      { conversationId: '1203@g.us', expiration: 86400 }
    );
    expect(out.structuredContent).toMatchObject({ ok: true, data: { label: '24h' } });
    await run('social_set_disappearing', { ...wa, target: '34600@s.whatsapp.net', expiration: 0 });
    expect(connectorCall).toHaveBeenLastCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/chats/disappearing',
      { conversationId: '34600@s.whatsapp.net', expiration: 0 }
    );
  });

  it('refuses other timers, another account target and other channels', async () => {
    const { run, connectorCall } = serverWith();
    for (const expiration of [3600, 2592000, '24h', -1]) {
      await expect(
        run('social_set_disappearing', { ...wa, target: '1203@g.us', expiration })
      ).rejects.toMatchObject({ canonicalCode: 'invalid_request' });
    }
    const foreign = await run('social_set_disappearing', {
      channel: 'whatsapp',
      accountId: 'personal',
      target: 'professional:1203@g.us',
      expiration: 604800,
    });
    expect(foreign.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    expect(foreign.structuredContent.error.message).toMatch(/professional WhatsApp namespace/);
    const tg = await run('social_set_disappearing', {
      channel: 'telegram',
      accountId: 'personal',
      target: '12345',
      expiration: 604800,
    });
    expect(tg.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('maps 403 disabled_sending / not_group_admin and 404 conversation_unavailable', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall
      .mockRejectedValueOnce(
        connectorError(403, { error: 'Sending disabled', failureClass: 'disabled_sending' })
      )
      .mockRejectedValueOnce(
        connectorError(403, { error: 'admins only', failureClass: 'not_group_admin' })
      )
      .mockRejectedValueOnce(
        connectorError(404, { error: 'unknown chat', failureClass: 'conversation_unavailable' })
      );
    const args = { ...wa, target: '1203@g.us', expiration: 604800 };
    expect((await run('social_set_disappearing', args)).structuredContent.error).toMatchObject({
      code: 'disabled_sending',
      details: { status: 403 },
    });
    expect((await run('social_set_disappearing', args)).structuredContent.error).toMatchObject({
      code: 'not_group_admin',
    });
    expect((await run('social_set_disappearing', args)).structuredContent.error).toMatchObject({
      code: 'conversation_unavailable',
      details: { status: 404 },
    });
  });
});

describe('social_send_typing', () => {
  it('sends a chat-state to one chat through POST /chats/presence', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockResolvedValueOnce({
      ok: true,
      state: 'composing',
      scope: 'chat',
      sent: true,
      throttled: false,
    });
    const out = await run('social_send_typing', {
      ...wa,
      target: 'professional:34600@s.whatsapp.net',
      state: 'composing',
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/chats/presence',
      { conversationId: '34600@s.whatsapp.net', state: 'composing' }
    );
    expect(out.structuredContent).toMatchObject({ ok: true, data: { scope: 'chat', sent: true } });
  });

  it('never sends account-wide presence and needs the chat', async () => {
    const { run, connectorCall } = serverWith();
    for (const state of ['available', 'unavailable', 'typing']) {
      await expect(
        run('social_send_typing', { ...wa, target: '34600@s.whatsapp.net', state })
      ).rejects.toMatchObject({ canonicalCode: 'invalid_request' });
    }
    await expect(run('social_send_typing', { ...wa, state: 'paused' })).rejects.toMatchObject({
      canonicalCode: 'invalid_request',
    });
    const foreign = await run('social_send_typing', {
      channel: 'whatsapp',
      accountId: 'personal',
      target: 'professional:34600@s.whatsapp.net',
      state: 'paused',
    });
    expect(foreign.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    const tg = await run('social_send_typing', {
      channel: 'telegram',
      accountId: 'personal',
      target: '12345',
      state: 'composing',
    });
    expect(tg.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('maps the gate and 422 presence_unsupported', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall
      .mockRejectedValueOnce(
        connectorError(403, { error: 'Sending disabled', failureClass: 'disabled_sending' })
      )
      .mockRejectedValueOnce(
        connectorError(422, { error: 'no push name', failureClass: 'presence_unsupported' })
      );
    const args = { ...wa, target: '34600@s.whatsapp.net', state: 'recording' };
    expect((await run('social_send_typing', args)).structuredContent.error).toMatchObject({
      code: 'disabled_sending',
    });
    expect((await run('social_send_typing', args)).structuredContent.error).toMatchObject({
      code: 'presence_unsupported',
      details: { status: 422 },
    });
  });
});

describe('social_send_sticker / social_send_gif', () => {
  const sticker = {
    ...wa,
    target: 'professional:34600@s.whatsapp.net',
    fileUrl: 'https://cdn.example.com/hola.webp',
  };

  it('sends a WhatsApp sticker with a bare reply id and a tool-scoped Idempotency-Key', async () => {
    await runWithRedisDouble(async server => {
      server.connectorCall.mockResolvedValueOnce({
        sent: true,
        messageId: '3EB0STK',
        kind: 'sticker',
        animated: false,
      });
      const out = (await server.run('social_send_sticker', {
        ...sticker,
        replyTo: 'professional:3EB0QUOTE',
        idempotencyKey: 'stk-1',
      })) as { structuredContent: Record<string, any> };
      const [url, method, path, body, timeout, headers] = server.connectorCall.mock.calls[0];
      expect([url, method, path, timeout]).toEqual([
        'http://wa-professional',
        'POST',
        '/api/v1/messages/sticker',
        undefined,
      ]);
      expect(body).toEqual({
        conversationId: '34600@s.whatsapp.net',
        fileUrl: 'https://cdn.example.com/hola.webp',
        replyTo: '3EB0QUOTE',
      });
      expect((headers as Record<string, string>)['Idempotency-Key']).toMatch(/^mcp-[0-9a-f]{64}$/);
      expect(out.structuredContent).toMatchObject({ ok: true, data: { kind: 'sticker' } });
    });
  });

  it('sends a WhatsApp GIF with its caption, keyed apart from a sticker', async () => {
    await runWithRedisDouble(async server => {
      await server.run('social_send_gif', {
        ...wa,
        target: '1203@g.us',
        fileUrl: 'http://minio.storage:9000/drive/baile.mp4?X-Amz-Signature=abc',
        caption: '¡Viernes!',
        idempotencyKey: 'same-key',
      });
      await server.run('social_send_sticker', {
        ...wa,
        target: '1203@g.us',
        fileUrl: 'https://cdn.example.com/hola.webp',
        idempotencyKey: 'same-key',
      });
      const [gif, stk] = server.connectorCall.mock.calls;
      expect(gif.slice(0, 4)).toEqual([
        'http://wa-professional',
        'POST',
        '/api/v1/messages/gif',
        {
          conversationId: '1203@g.us',
          fileUrl: 'http://minio.storage:9000/drive/baile.mp4?X-Amz-Signature=abc',
          caption: '¡Viernes!',
        },
      ]);
      expect(stk[2]).toBe('/api/v1/messages/sticker');
      expect(gif[5]['Idempotency-Key']).not.toBe(stk[5]['Idempotency-Key']);
    });
  });

  it('sends a Telegram sticker through its media send with sticker: true', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockResolvedValueOnce({ sent: true });
    const out = await run('social_send_sticker', {
      channel: 'telegram',
      accountId: 'personal',
      target: 'tg_-100123',
      fileUrl: 'https://cdn.example.com/hola.webp',
      replyTo: 'tg_-100123_77',
      threadId: 5,
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://tg-personal',
      'POST',
      '/api/v1/messages/media/send',
      {
        chatId: '-100123',
        filePath: 'https://cdn.example.com/hola.webp',
        sticker: true,
        replyTo: 77,
        threadId: 5,
      }
    );
    expect(out.structuredContent).toMatchObject({ ok: true, status: 'accepted' });
  });

  it('maps 400 sticker_not_webp / gif_not_mp4 and the 403 gate', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall
      .mockRejectedValueOnce(
        connectorError(400, {
          error: 'A sticker must be a WebP image',
          failureClass: 'invalid_request',
          code: 'sticker_not_webp',
        })
      )
      .mockRejectedValueOnce(
        connectorError(400, {
          error: 'transcode to MP4',
          failureClass: 'invalid_request',
          code: 'gif_not_mp4',
        })
      )
      .mockRejectedValueOnce(
        connectorError(403, { error: 'Sending disabled', failureClass: 'disabled_sending' })
      )
      .mockRejectedValueOnce(
        connectorError(403, { error: 'Sending disabled', failureClass: 'disabled_sending' })
      );
    const webp = await run('social_send_sticker', sticker);
    expect(webp.structuredContent.error).toMatchObject({
      code: 'invalid_request',
      details: { status: 400, code: 'sticker_not_webp' },
    });
    const gif = await run('social_send_gif', {
      ...sticker,
      fileUrl: 'https://cdn.example.com/baile.gif',
    });
    expect(gif.structuredContent.error).toMatchObject({
      code: 'invalid_request',
      details: { code: 'gif_not_mp4' },
    });
    const gated = await run('social_send_sticker', sticker);
    expect(gated.structuredContent.error).toMatchObject({
      code: 'disabled_sending',
      details: { status: 403 },
    });
    const tgGated = await run('social_send_sticker', {
      channel: 'telegram',
      accountId: 'personal',
      target: '12345',
      fileUrl: 'https://cdn.example.com/hola.webp',
    });
    expect(tgGated.structuredContent.error).toMatchObject({ code: 'disabled_sending' });
  });

  it('refuses non-http urls, a sticker caption, foreign ids, threadId on WhatsApp and other channels', async () => {
    const { run, connectorCall } = serverWith();
    for (const fileUrl of [
      'file:///tmp/a.webp',
      's3://drive/a.webp',
      'data:image/webp;base64,UklG',
    ]) {
      await expect(run('social_send_sticker', { ...sticker, fileUrl })).rejects.toMatchObject({
        canonicalCode: 'invalid_request',
      });
    }
    await expect(run('social_send_sticker', { ...sticker, caption: 'no' })).rejects.toMatchObject({
      canonicalCode: 'invalid_request',
    });
    await expect(
      run('social_send_gif', { ...sticker, caption: 'x'.repeat(1025) })
    ).rejects.toMatchObject({ canonicalCode: 'invalid_request' });
    const foreignTarget = await run('social_send_gif', {
      ...sticker,
      accountId: 'personal',
    });
    expect(foreignTarget.structuredContent.error.message).toMatch(
      /professional WhatsApp namespace/
    );
    const foreignReply = await run('social_send_sticker', {
      ...sticker,
      accountId: 'personal',
      target: '34600@s.whatsapp.net',
      replyTo: 'professional:3EB0X',
    });
    expect(foreignReply.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    expect(foreignReply.structuredContent.error.message).toMatch(
      /messageId belongs to the professional/
    );
    const foreignTg = await run('social_send_sticker', {
      channel: 'telegram',
      accountId: 'personal',
      target: 'professional:tg_12345',
      fileUrl: 'https://cdn.example.com/hola.webp',
    });
    expect(foreignTg.structuredContent.error.message).toMatch(/professional Telegram namespace/);
    const thread = await run('social_send_sticker', { ...sticker, threadId: 5 });
    expect(thread.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    const tgGif = await run('social_send_gif', {
      channel: 'telegram',
      accountId: 'personal',
      target: '12345',
      fileUrl: 'https://cdn.example.com/baile.mp4',
    });
    expect(tgGif.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    const ig = await run('social_send_sticker', {
      channel: 'instagram',
      accountId: 'skirmshop',
      target: '1',
      fileUrl: 'https://cdn.example.com/hola.webp',
    });
    expect(ig.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    expect(connectorCall).not.toHaveBeenCalled();
  });
});

describe('social_delete_message forMe', () => {
  it('deletes only for this account on WhatsApp with forMe: true', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockResolvedValueOnce({ deleted: true, scope: 'me', messageId: '3EB0AAA' });
    const out = await run('social_delete_message', {
      ...wa,
      target: 'professional:34600@s.whatsapp.net',
      messageId: 'professional:3EB0AAA',
      forMe: true,
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/messages/delete',
      { chatId: '34600@s.whatsapp.net', messageId: '3EB0AAA', forMe: true }
    );
    expect(out.structuredContent).toMatchObject({ ok: true, data: { scope: 'me' } });
  });

  it('keeps forMe: false identical to the delete for everyone', async () => {
    const { run, connectorCall } = serverWith();
    await run('social_delete_message', {
      ...wa,
      target: '34600@s.whatsapp.net',
      messageId: '3EB0AAA',
      forMe: false,
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://wa-professional',
      'POST',
      '/api/v1/messages/delete',
      { chatId: '34600@s.whatsapp.net', messageId: '3EB0AAA' }
    );
  });

  it('maps 404 message_unavailable and answers unsupported_capability off WhatsApp', async () => {
    const { run, connectorCall } = serverWith();
    connectorCall.mockRejectedValueOnce(
      connectorError(404, { error: 'no timestamp', failureClass: 'message_unavailable' })
    );
    const gone = await run('social_delete_message', {
      ...wa,
      target: '34600@s.whatsapp.net',
      messageId: '3EB0OLD',
      forMe: true,
    });
    expect(gone.structuredContent.error).toMatchObject({ code: 'message_unavailable' });
    for (const channel of [
      { channel: 'telegram', accountId: 'personal', target: '12345', messageId: '77' },
      { channel: 'instagram', accountId: 'skirmshop', target: '1', messageId: '2' },
    ]) {
      const out = await run('social_delete_message', { ...channel, forMe: true });
      expect(out.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
      expect(out.structuredContent.error.message).toMatch(/forMe/);
    }
    await expect(
      run('social_delete_message', {
        ...wa,
        target: '34600@s.whatsapp.net',
        messageId: '3',
        forMe: 'yes',
      })
    ).rejects.toMatchObject({ canonicalCode: 'invalid_request' });
    expect(connectorCall).toHaveBeenCalledTimes(1);
  });
});

describe('new WhatsApp writes and the identity binding', () => {
  const saved: Record<string, string | undefined> = {};
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'social-gate-'));
    writeFileSync(
      join(dir, 'bindings.yaml'),
      'bindings:\n  - sub: leila-sub\n    label: leila\n    accounts: [leila]\n'
    );
    for (const key of ['SOCIAL_IDENTITY_BINDING', 'SOCIAL_IDENTITY_BINDINGS_FILE']) {
      saved[key] = process.env[key];
    }
    process.env.SOCIAL_IDENTITY_BINDING = 'on';
    process.env.SOCIAL_IDENTITY_BINDINGS_FILE = join(dir, 'bindings.yaml');
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuse an account the caller is not bound to before reaching the connector', async () => {
    const { run, connectorCall } = serverWith();
    const calls: Array<[string, Record<string, unknown>]> = [
      ['social_set_privacy', { ...wa, setting: 'readReceipts', value: 'none', confirm: true }],
      ['social_set_disappearing', { ...wa, target: '34600@s.whatsapp.net', expiration: 0 }],
      ['social_send_typing', { ...wa, target: '34600@s.whatsapp.net', state: 'composing' }],
      [
        'social_send_sticker',
        { ...wa, target: '34600@s.whatsapp.net', fileUrl: 'https://cdn.example.com/a.webp' },
      ],
      [
        'social_send_gif',
        { ...wa, target: '34600@s.whatsapp.net', fileUrl: 'https://cdn.example.com/a.mp4' },
      ],
    ];
    for (const [name, args] of calls) {
      await expect(
        runWithRequestActor({ sub: 'leila-sub' }, () => run(name, args))
      ).rejects.toMatchObject({ canonicalCode: 'forbidden' });
    }
    expect(connectorCall).not.toHaveBeenCalled();
  });
});
