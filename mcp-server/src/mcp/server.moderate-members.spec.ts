/**
 * social_moderate_members (INFRA-218 P2 / INFRA-345). The criteria exercised
 * here are the ones the dictamen and the story spec put on the MCP side:
 * confirmation_required and invalid_target refuse BEFORE the connector, one
 * audit row per mutation attempt (failures included, actor = the gateway
 * principal), audit_unavailable refuses the mutation with zero connector
 * calls, get_admin_rights is a read and does not audit, and the connector's
 * failureClass answers arrive as the canonical codes (never a 500, never
 * outcome_unknown).
 */
import { runWithRequestActor } from '@mcp-socialmedia/shared';
import { useTestAccounts } from '../domain/test-accounts';
import { SOCIAL_TOOL_REGISTRY } from './tool-registry';
import { MCPServer } from './server';

function moderateServer() {
  const server = Object.create(MCPServer.prototype) as MCPServer;
  const anyServer = server as any;
  useTestAccounts({
    telegram: {
      personal: 'http://telegram-personal',
      professional: 'http://telegram-professional',
    },
  });
  anyServer.connectorCall = jest.fn(async () => ({ success: true }));
  anyServer.dbClient = { query: jest.fn(async () => ({ rows: [{ id: 7 }] })) };
  anyServer.logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
  return {
    server: anyServer,
    moderate: (args: Record<string, unknown>) =>
      runWithRequestActor({ sub: 'sub-1', name: 'dani' }, () =>
        anyServer.canonicalModerateMembers(args)
      ),
    connectorCall: anyServer.connectorCall as jest.Mock,
    dbQuery: anyServer.dbClient.query as jest.Mock,
  };
}

const banArgs = {
  channel: 'telegram',
  accountId: 'personal',
  target: '-1001234567890',
  action: 'ban',
  userId: '456',
  reason: 'spam reiterado',
  confirm: true,
};

async function expectCanonical(promise: Promise<unknown>, code: string, message?: string) {
  const error = await promise.then(
    () => {
      throw new Error(`expected a rejection with code ${code}`);
    },
    (e: unknown) => e
  );
  expect((error as { canonicalCode?: string }).canonicalCode).toBe(code);
  if (message) expect((error as Error).message).toContain(message);
}

describe('social_moderate_members', () => {
  it('C1: the action enum is exactly the six moderation actions', () => {
    const tool = SOCIAL_TOOL_REGISTRY.find(t => t.name === 'social_moderate_members');
    expect(tool).toBeDefined();
    expect(tool!.effect).toBe('destructive');
    expect(tool!.authScope).toBe('social.write');
    expect((tool!.inputSchema.properties as any).action.enum).toEqual([
      'ban',
      'unban',
      'kick',
      'restrict',
      'unrestrict',
      'get_admin_rights',
    ]);
  });

  describe('C2: confirm is refused before the connector', () => {
    for (const action of ['ban', 'kick', 'restrict']) {
      for (const [label, confirm] of [
        ['ausente', undefined],
        ['false', false],
      ] as const) {
        it(`${action} with confirm ${label} → confirmation_required, 0 connector calls`, async () => {
          const { moderate, connectorCall } = moderateServer();
          await expectCanonical(
            moderate({ ...banArgs, action, reason: 'x', confirm }),
            'confirmation_required'
          );
          expect(connectorCall).not.toHaveBeenCalled();
        });
      }
    }
  });

  it('C6: user_id "@nombre-que-no-existe" → invalid_target, 0 connector calls', async () => {
    const { moderate, connectorCall } = moderateServer();
    await expectCanonical(
      moderate({ ...banArgs, userId: '@nombre-que-no-existe' }),
      'invalid_target',
      'debe ser id numérico de Telegram'
    );
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('C6: chat_id "abc" → invalid_target, 0 connector calls', async () => {
    const { moderate, connectorCall } = moderateServer();
    await expectCanonical(
      moderate({ ...banArgs, target: 'abc' }),
      'invalid_target',
      'target debe ser id numérico de Telegram'
    );
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('reason is required on ban and refused before the connector', async () => {
    const { moderate, connectorCall } = moderateServer();
    const { reason: _reason, ...withoutReason } = banArgs;
    await expectCanonical(moderate(withoutReason), 'invalid_request', 'reason es obligatorio');
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('C5: the inputSchema carries the closed restriction enum', () => {
    const tool = SOCIAL_TOOL_REGISTRY.find(t => t.name === 'social_moderate_members')!;
    expect((tool.inputSchema.properties as any).restriction.enum).toEqual([
      'mute',
      'no_media',
      'no_invite',
      'read_only',
    ]);
  });

  it('unsupported_platform: a whatsapp call never reaches the Telegram connector', async () => {
    const { moderate, connectorCall } = moderateServer();
    await expectCanonical(
      moderate({ ...banArgs, channel: 'whatsapp' }),
      'unsupported_platform',
      'only supports Telegram'
    );
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('ban: one audit row per attempt — pending with the caller as actor, then ok', async () => {
    const { moderate, connectorCall, dbQuery } = moderateServer();
    await moderate(banArgs);
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-personal',
      'POST',
      '/api/v1/chats/-1001234567890/moderation/ban',
      { user_id: '456' }
    );
    expect(dbQuery).toHaveBeenCalledTimes(2);
    const [insertSql, insertParams] = dbQuery.mock.calls[0];
    expect(insertSql).toContain('INSERT INTO moderation_audit');
    expect(insertParams).toEqual([
      'sub-1',
      'telegram:personal',
      '-1001234567890',
      '456',
      'ban',
      null,
      null,
      'spam reiterado',
    ]);
    const [updateSql, updateParams] = dbQuery.mock.calls[1];
    expect(updateSql).toContain('UPDATE moderation_audit');
    expect(updateParams).toEqual([7, 'ok', null]);
  });

  it('ban: a failed attempt still audits, with the canonical code and the TL error', async () => {
    const { moderate, connectorCall, dbQuery } = moderateServer();
    connectorCall.mockRejectedValueOnce(
      new Error(
        'Connector error 403: {"error":"no eres admin","failureClass":"not_admin","code":"CHAT_ADMIN_REQUIRED"}'
      )
    );
    await expectCanonical(moderate(banArgs), 'not_admin');
    expect(dbQuery).toHaveBeenCalledTimes(2);
    expect(dbQuery.mock.calls[0][0]).toContain('INSERT INTO moderation_audit');
    expect(dbQuery.mock.calls[1][1]).toEqual([7, 'not_admin', 'CHAT_ADMIN_REQUIRED']);
  });

  it('rate_limited keeps retry_after_s from the connector payload', async () => {
    const { moderate, connectorCall, dbQuery } = moderateServer();
    connectorCall.mockRejectedValueOnce(
      new Error(
        'Connector error 429: {"error":"flood","failureClass":"rate_limited","code":"FLOOD_WAIT_30","retry_after_s":30}'
      )
    );
    const error = (await moderate(banArgs).catch((e: unknown) => e)) as {
      canonicalCode?: string;
      canonicalDetails?: Record<string, unknown>;
    };
    expect(error.canonicalCode).toBe('rate_limited');
    expect(error.canonicalDetails?.retry_after_s).toBe(30);
    expect(dbQuery.mock.calls[1][1][1]).toBe('rate_limited');
    expect(connectorCall).toHaveBeenCalledTimes(1);
  });

  it('audit_unavailable: an audit write failure refuses the mutation with 0 connector calls', async () => {
    const { moderate, connectorCall, dbQuery } = moderateServer();
    dbQuery.mockRejectedValueOnce(new Error('connection refused'));
    await expectCanonical(moderate(banArgs), 'audit_unavailable');
    expect(connectorCall).not.toHaveBeenCalled();
  });

  it('get_admin_rights is a read: GET admin-rights and no audit row', async () => {
    const { moderate, connectorCall, dbQuery } = moderateServer();
    await moderate({
      channel: 'telegram',
      accountId: 'professional',
      target: '-1001234567890',
      action: 'get_admin_rights',
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-professional',
      'GET',
      '/api/v1/chats/-1001234567890/moderation/admin-rights',
      undefined
    );
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('routing: each account_id goes to its own connector url', async () => {
    const { moderate, connectorCall } = moderateServer();
    await moderate({ ...banArgs, accountId: 'professional' });
    await moderate({ ...banArgs, accountId: 'personal' });
    expect(connectorCall.mock.calls.map(call => call[0])).toEqual([
      'http://telegram-professional',
      'http://telegram-personal',
    ]);
  });

  it('restrict forwards restriction and until to the connector', async () => {
    const { moderate, connectorCall } = moderateServer();
    await moderate({
      ...banArgs,
      action: 'restrict',
      restriction: 'mute',
      until: '2026-11-10T00:00:00Z',
    });
    expect(connectorCall).toHaveBeenCalledWith(
      'http://telegram-personal',
      'POST',
      '/api/v1/chats/-1001234567890/moderation/restrict',
      { user_id: '456', until: '2026-11-10T00:00:00Z', restriction: 'mute' }
    );
  });
});
