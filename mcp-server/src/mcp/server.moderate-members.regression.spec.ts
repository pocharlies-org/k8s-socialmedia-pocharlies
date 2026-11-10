/**
 * Regression for INFRA-218, built from qa's PASA on INFRA-348 (70-qa.md). It
 * pins what qa measured by hand against the live fixture, with no Telegram and
 * no live data:
 *  - the tools/call envelope (executeCanonicalTool, what the gateway returns):
 *    confirmation_required and invalid_target refuse before the connector;
 *  - one audit row per attempt for every mutation, failures included, written
 *    BEFORE the connector call, and fail-closed (audit_unavailable) without
 *    mutating;
 *  - the connector's {failureClass} answers over real signed HTTP arrive as the
 *    canonical code (never outcome_unknown, never provider_error);
 *  - the INSERT/UPDATE of the handler agree with migration 043.
 * server.moderate-members.spec.ts covers the handler with a mocked connector;
 * this file adds the envelope, the other four mutations and the wire.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWithRequestActor } from '@mcp-socialmedia/shared';
import { useTestAccounts } from '../domain/test-accounts';
import { connector, TEST_CONNECTOR_SECRET } from './test-connector';
import { MCPServer } from './server';
import { SOCIAL_TOOL_REGISTRY } from './tool-registry';

const tool = SOCIAL_TOOL_REGISTRY.find(t => t.name === 'social_moderate_members')!;
const CHAT = '-1001234567890';
const USER = '456';

type Envelope = { isError?: boolean; structuredContent: Record<string, any> };

function moderationServer(opts: { url?: string } = {}) {
  const server = Object.create(MCPServer.prototype) as MCPServer;
  const anyServer = server as any;
  if (opts.url) {
    process.env.TEST_CONNECTOR_SECRET = TEST_CONNECTOR_SECRET;
    useTestAccounts({ telegram: { personal: opts.url }, secretEnv: 'TEST_CONNECTOR_SECRET' });
  } else {
    useTestAccounts({ telegram: { personal: 'http://telegram-personal' } });
    anyServer.connectorCall = jest.fn(async () => ({ success: true }));
  }
  anyServer.dbClient = { query: jest.fn(async () => ({ rows: [{ id: 7 }] })) };
  anyServer.logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
  return {
    connectorCall: anyServer.connectorCall as jest.Mock,
    dbQuery: anyServer.dbClient.query as jest.Mock,
    logger: anyServer.logger as { error: jest.Mock },
    call: (
      args: Record<string, unknown>,
      actor: { sub?: string; name?: string } = { sub: 'sub-1' }
    ) =>
      runWithRequestActor(
        actor,
        () => anyServer.executeCanonicalTool(tool, { ...args }) as Promise<Envelope>
      ),
  };
}

const base = { channel: 'telegram', accountId: 'personal', target: CHAT };
const UNTIL = '2026-12-01T10:00:00Z';

// Every mutation: what the caller sends, what the connector must receive, and
// the audit row (actor, account, chat, user, action, restriction, until, reason).
const MUTATIONS = [
  {
    action: 'ban',
    args: { reason: 'spam', confirm: true },
    body: { user_id: USER },
    audit: ['ban', null, null, 'spam'],
  },
  { action: 'unban', args: {}, body: { user_id: USER }, audit: ['unban', null, null, null] },
  {
    action: 'kick',
    args: { reason: 'flood', confirm: true },
    body: { user_id: USER },
    audit: ['kick', null, null, 'flood'],
  },
  {
    action: 'restrict',
    args: { reason: 'ruido', confirm: true, restriction: 'mute', until: UNTIL },
    body: { user_id: USER, until: UNTIL, restriction: 'mute' },
    audit: ['restrict', 'mute', UNTIL, 'ruido'],
  },
  {
    action: 'unrestrict',
    args: {},
    body: { user_id: USER },
    audit: ['unrestrict', null, null, null],
  },
] as const;

const notAdmin = new Error(
  'Connector error 403: ' +
    JSON.stringify({
      error:
        'Telegram rechazó ban (CHAT_ADMIN_REQUIRED): esta cuenta no es administradora del chat o le falta el derecho banUsers',
      failureClass: 'not_admin',
      code: 'CHAT_ADMIN_REQUIRED',
      missing_right: 'banUsers',
    })
);

describe('INFRA-218 envelope: refusals happen before the connector', () => {
  for (const action of ['ban', 'kick', 'restrict']) {
    for (const [label, confirm] of [
      ['ausente', undefined],
      ['false', false],
    ] as const) {
      it(`${action} with confirm ${label} → confirmation_required, no connector call, no audit row`, async () => {
        const { call, connectorCall, dbQuery } = moderationServer();
        const out = await call({
          ...base,
          action,
          userId: USER,
          reason: 'x',
          ...(action === 'restrict' ? { restriction: 'mute' } : {}),
          confirm,
        });
        expect(out.isError).toBe(true);
        expect(out.structuredContent.error.code).toBe('confirmation_required');
        expect(connectorCall).not.toHaveBeenCalled();
        expect(dbQuery).not.toHaveBeenCalled();
      });
    }
  }

  it('a string "true" is not a confirmation: the input schema refuses it, nothing sent', async () => {
    const { call, connectorCall, dbQuery } = moderationServer();
    await expect(
      call({ ...base, action: 'ban', userId: USER, reason: 'x', confirm: 'true' })
    ).rejects.toMatchObject({ canonicalCode: 'invalid_request' });
    expect(connectorCall).not.toHaveBeenCalled();
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('restrict without a restriction, or ban with one, is refused by the schema before any call', async () => {
    const { call, connectorCall, dbQuery } = moderationServer();
    const refused = [
      { action: 'restrict', userId: USER, reason: 'x', confirm: true },
      { action: 'ban', userId: USER, reason: 'x', confirm: true, restriction: 'mute' },
      { action: 'restrict', userId: USER, reason: 'x', confirm: true, restriction: 'shadowban' },
    ];
    for (const args of refused) {
      await expect(call({ ...base, ...args })).rejects.toMatchObject({
        canonicalCode: 'invalid_request',
      });
    }
    expect(connectorCall).not.toHaveBeenCalled();
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('unban and unrestrict need neither confirm nor reason', async () => {
    const { call, connectorCall } = moderationServer();
    for (const action of ['unban', 'unrestrict']) {
      const out = await call({ ...base, action, userId: USER });
      expect(out.isError).toBeUndefined();
      expect(out.structuredContent).toMatchObject({ ok: true, status: 'accepted' });
    }
    expect(connectorCall).toHaveBeenCalledTimes(2);
  });

  for (const userId of ['@nombre-que-no-existe', 'abc', '12x', '1.5', '1'.repeat(21)]) {
    it(`user_id ${JSON.stringify(userId)} → invalid_target, no connector call, no audit row`, async () => {
      const { call, connectorCall, dbQuery } = moderationServer();
      const out = await call({ ...base, action: 'ban', userId, reason: 'x', confirm: true });
      expect(out.isError).toBe(true);
      expect(out.structuredContent.error.code).toBe('invalid_target');
      expect(out.structuredContent.error.message).toContain('id numérico de Telegram');
      expect(connectorCall).not.toHaveBeenCalled();
      expect(dbQuery).not.toHaveBeenCalled();
    });
  }

  it('a @username chat is invalid_target for the mutations and for get_admin_rights', async () => {
    const { call, connectorCall, dbQuery } = moderationServer();
    for (const action of ['ban', 'get_admin_rights']) {
      const out = await call({
        ...base,
        target: '@grupo',
        action,
        userId: USER,
        reason: 'x',
        confirm: true,
      });
      expect(out.structuredContent.error.code).toBe('invalid_target');
    }
    expect(connectorCall).not.toHaveBeenCalled();
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('an integer user id is accepted and travels to the connector as a string', async () => {
    const { call, connectorCall } = moderationServer();
    const out = await call({ ...base, action: 'unban', userId: 456 });
    expect(out.isError).toBeUndefined();
    expect(connectorCall.mock.calls[0][3]).toEqual({ user_id: '456' });
  });
});

describe('INFRA-218 audit: one row per attempt, every mutation', () => {
  for (const { action, args, body, audit } of MUTATIONS) {
    it(`${action}: connector path and body, one pending row BEFORE the call, closed ok`, async () => {
      const { call, connectorCall, dbQuery } = moderationServer();
      let rowsWhenSent = -1;
      connectorCall.mockImplementationOnce(async () => {
        rowsWhenSent = dbQuery.mock.calls.length;
        return { success: true };
      });
      const out = await call({ ...base, action, userId: USER, ...args });
      expect(out.structuredContent).toMatchObject({ ok: true, status: 'accepted' });
      expect(connectorCall).toHaveBeenCalledWith(
        'http://telegram-personal',
        'POST',
        `/api/v1/chats/${CHAT}/moderation/${action}`,
        body
      );
      expect(rowsWhenSent).toBe(1);
      expect(dbQuery).toHaveBeenCalledTimes(2);
      const [insertSql, insertParams] = dbQuery.mock.calls[0];
      expect(insertSql).toContain('INSERT INTO moderation_audit');
      expect(insertSql).toContain("'pending'");
      expect(insertParams).toEqual([
        'sub-1',
        'telegram:personal',
        CHAT,
        USER,
        audit[0],
        audit[1],
        audit[2],
        audit[3],
      ]);
      expect(dbQuery.mock.calls[1][1]).toEqual([7, 'ok', null]);
    });

    it(`${action}: a failed attempt is audited with the canonical code and the TL error`, async () => {
      const { call, connectorCall, dbQuery } = moderationServer();
      connectorCall.mockRejectedValueOnce(notAdmin);
      const out = await call({ ...base, action, userId: USER, ...args });
      expect(out.isError).toBe(true);
      expect(out.structuredContent.error.code).toBe('not_admin');
      expect(dbQuery).toHaveBeenCalledTimes(2);
      expect(dbQuery.mock.calls[0][0]).toContain('INSERT INTO moderation_audit');
      expect(dbQuery.mock.calls[1][1]).toEqual([7, 'not_admin', 'CHAT_ADMIN_REQUIRED']);
    });

    it(`${action}: audit_unavailable refuses the mutation (fail-closed), connector untouched`, async () => {
      const { call, connectorCall, dbQuery, logger } = moderationServer();
      dbQuery.mockRejectedValueOnce(new Error('connection refused'));
      const out = await call({ ...base, action, userId: USER, ...args });
      expect(out.isError).toBe(true);
      expect(out.structuredContent.error.code).toBe('audit_unavailable');
      expect(out.structuredContent.error.message).toContain('la mutación no se ejecutó');
      expect(connectorCall).not.toHaveBeenCalled();
      expect(dbQuery).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalled();
    });
  }

  it('a failed outcome UPDATE after the mutation went out does not turn success into an error', async () => {
    const { call, connectorCall, dbQuery, logger } = moderationServer();
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: 7 }] })
      .mockRejectedValueOnce(new Error('connection lost'));
    const out = await call({ ...base, action: 'ban', userId: USER, reason: 'x', confirm: true });
    expect(out.isError).toBeUndefined();
    expect(out.structuredContent).toMatchObject({ ok: true, status: 'accepted' });
    expect(connectorCall).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it('get_admin_rights is a read: no audit row and no confirm needed', async () => {
    const { call, connectorCall, dbQuery } = moderationServer();
    const out = await call({ ...base, action: 'get_admin_rights' });
    expect(out.structuredContent).toMatchObject({ ok: true });
    expect(connectorCall.mock.calls[0].slice(1, 3)).toEqual([
      'GET',
      `/api/v1/chats/${CHAT}/moderation/admin-rights`,
    ]);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('the audited actor is the gateway sub, else the name, else null', async () => {
    const actors: Array<[{ sub?: string; name?: string }, string | null]> = [
      [{ sub: 'sub-1', name: 'dani' }, 'sub-1'],
      [{ name: 'dani' }, 'dani'],
      [{}, null],
    ];
    for (const [actor, expected] of actors) {
      const { call, dbQuery } = moderationServer();
      await call({ ...base, action: 'unban', userId: USER }, actor);
      expect(dbQuery.mock.calls[0][1][0]).toBe(expected);
    }
  });
});

describe('INFRA-218 over a signed connector: failureClass → canonical code', () => {
  it('sends the HMAC-signed POST with the caller identity next to the signature', async () => {
    const tg = await connector('gated', '{"chatId":"-1001234567890","action":"ban"}');
    try {
      const { call } = moderationServer({ url: tg.url });
      const out = await call({ ...base, action: 'ban', userId: USER, reason: 'x', confirm: true });
      expect(out.structuredContent).toMatchObject({
        ok: true,
        status: 'accepted',
        data: { action: 'ban' },
      });
      expect(tg.seen).toHaveLength(1);
      expect(tg.seen[0]).toMatchObject({
        method: 'POST',
        url: `/api/v1/chats/${CHAT}/moderation/ban`,
        signatureOk: true,
        body: { user_id: USER },
      });
      expect(tg.seen[0].headers['x-user-sub']).toBe('sub-1');
    } finally {
      await tg.close();
    }
  });

  const answers: Array<{
    status: number;
    failureClass: string;
    code?: string;
    retry_after_s?: number;
  }> = [
    { status: 403, failureClass: 'not_admin', code: 'CHAT_ADMIN_REQUIRED' },
    { status: 429, failureClass: 'rate_limited', code: 'FLOOD_WAIT_30', retry_after_s: 30 },
    { status: 404, failureClass: 'user_not_participant', code: 'USER_NOT_PARTICIPANT' },
    { status: 400, failureClass: 'invalid_target', code: 'PEER_ID_INVALID' },
    { status: 400, failureClass: 'invalid_request' },
    { status: 422, failureClass: 'unsupported_chat_type' },
    { status: 502, failureClass: 'telegram_error', code: 'FOO_BAR' },
  ];
  for (const answer of answers) {
    it(`${answer.status} ${answer.failureClass} → error.code ${answer.failureClass}, audited, never outcome_unknown`, async () => {
      const { status, ...payload } = answer;
      const tg = await connector('gated', JSON.stringify({ error: 'x', ...payload }), status);
      try {
        const { call, dbQuery } = moderationServer({ url: tg.url });
        const out = await call({
          ...base,
          action: 'ban',
          userId: USER,
          reason: 'x',
          confirm: true,
        });
        const { error } = out.structuredContent;
        expect(out.isError).toBe(true);
        expect(out.structuredContent.status).toBe('failed');
        expect(error.code).toBe(answer.failureClass);
        expect(['outcome_unknown', 'provider_error']).not.toContain(error.code);
        expect(error.details).toMatchObject({ status, ...payload });
        expect(dbQuery.mock.calls[1][1]).toEqual([7, answer.failureClass, answer.code ?? null]);
      } finally {
        await tg.close();
      }
    });
  }

  it('not_admin names the missing right in a message the caller can act on', async () => {
    const tg = await connector(
      'gated',
      JSON.stringify({
        error:
          'Telegram rechazó ban (CHAT_ADMIN_REQUIRED): esta cuenta no es administradora del chat o le falta el derecho banUsers',
        failureClass: 'not_admin',
        code: 'CHAT_ADMIN_REQUIRED',
        missing_right: 'banUsers',
      }),
      403
    );
    try {
      const { call } = moderationServer({ url: tg.url });
      const out = await call({ ...base, action: 'ban', userId: USER, reason: 'x', confirm: true });
      expect(out.structuredContent.error.message).toMatch(/CHAT_ADMIN_REQUIRED.*banUsers/);
      expect(out.structuredContent.error.details.missing_right).toBe('banUsers');
    } finally {
      await tg.close();
    }
  });
});

describe('INFRA-218 migration 043 agrees with the handler', () => {
  const dir = join(__dirname, '../infrastructure/database/migrations');
  const file = readdirSync(dir).find(name => /moderation_audit\.sql$/.test(name));
  const sql = file ? readFileSync(join(dir, file), 'utf8') : '';
  const tableBody = /CREATE TABLE IF NOT EXISTS moderation_audit \(([\s\S]*?)\n\);/.exec(sql)?.[1];
  const columns = [...(tableBody ?? '').matchAll(/^ {2}("?\w+"?)\s/gm)].map(m => m[1]);
  const enumOf = (name: string): string[] =>
    ((tool.inputSchema.properties as Record<string, any>)[name].enum as string[]).slice();
  const checkValues = (column: string): string[] => {
    const list = new RegExp(`${column}\\s+TEXT[^\\n]*CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(
      sql
    )?.[1];
    return [...(list ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]);
  };

  it('the migration exists and declares the audit table', () => {
    expect(file).toBeDefined();
    expect(columns).toEqual(expect.arrayContaining(['id', 'ts', 'actor', 'outcome']));
  });

  it('every column the handler writes exists in the table', async () => {
    const { call, dbQuery } = moderationServer();
    await call({ ...base, action: 'ban', userId: USER, reason: 'x', confirm: true });
    const [insertSql] = dbQuery.mock.calls[0];
    const [updateSql] = dbQuery.mock.calls[1];
    const inserted = /INSERT INTO moderation_audit\s*\(([^)]*)\)/
      .exec(insertSql)![1]
      .split(',')
      .map((c: string) => c.trim());
    const updated = [...(/SET (.+?) WHERE/.exec(updateSql)![1] as string).matchAll(/(\w+) =/g)].map(
      m => m[1]
    );
    expect(inserted).toEqual(
      expect.arrayContaining([
        'actor',
        'account_id',
        'chat_id',
        'target_user_id',
        'action',
        'reason',
      ])
    );
    for (const column of [...inserted, ...updated]) expect(columns).toContain(column);
  });

  it('the CHECK lists are the tool enums: five mutations (no get_admin_rights) and four restrictions', () => {
    expect(checkValues('action')).toEqual(enumOf('action').filter(a => a !== 'get_admin_rights'));
    expect(checkValues('restriction')).toEqual(enumOf('restriction'));
  });

  it("a new attempt starts 'pending'", () => {
    expect(sql).toMatch(/outcome\s+TEXT NOT NULL DEFAULT 'pending'/);
  });
});

describe('INFRA-218 additive contract: contracts/socialmedia-tools.json', () => {
  type PublishedTool = {
    name: string;
    effect: string;
    authScope: string;
    capability: string;
    annotations: Record<string, boolean>;
    inputSchema: {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { enum?: string[]; type?: unknown }>;
      allOf: Array<{ if: unknown; then: unknown }>;
    };
  };
  const manifest = JSON.parse(
    readFileSync(join(__dirname, '../../../contracts/socialmedia-tools.json'), 'utf8')
  ) as { tools: PublishedTool[] };
  const published = manifest.tools.find(t => t.name === 'social_moderate_members');

  it('publishes social_moderate_members once, as a destructive write under social.write', () => {
    expect(manifest.tools.filter(t => t.name === 'social_moderate_members')).toHaveLength(1);
    expect(published).toMatchObject({
      effect: 'destructive',
      authScope: 'social.write',
      capability: 'members.moderate',
      annotations: { readOnlyHint: false, destructiveHint: true },
    });
  });

  it('enumerates the six actions and the four restrictions in the published schema', () => {
    const { properties } = published!.inputSchema;
    expect(properties.action.enum).toEqual([
      'ban',
      'unban',
      'kick',
      'restrict',
      'unrestrict',
      'get_admin_rights',
    ]);
    expect(properties.restriction.enum).toEqual(['mute', 'no_media', 'no_invite', 'read_only']);
    expect(properties.confirm.type).toBe('boolean');
  });

  it('keeps the schema closed and routed by account (no extra keys, channel+accountId+target+action)', () => {
    expect(published!.inputSchema.additionalProperties).toBe(false);
    expect(published!.inputSchema.required).toEqual(['channel', 'accountId', 'target', 'action']);
    expect(published!.inputSchema.allOf.length).toBeGreaterThanOrEqual(4);
  });

  it('is additive: moderation is its own tool, not actions of social_manage_forum; addMembers (C3) stays', () => {
    const names = manifest.tools.map(t => t.name);
    for (const kept of ['social_manage_forum', 'social_manage_group', 'social_send_message']) {
      expect(names).toContain(kept);
    }
    expect(new Set(names).size).toBe(names.length);
    const forum = manifest.tools.find(t => t.name === 'social_manage_forum')!;
    const forumActions = forum.inputSchema.properties.action.enum!;
    expect(forumActions).toContain('addMembers');
    for (const verb of ['ban', 'unban', 'kick', 'restrict', 'unrestrict']) {
      expect(forumActions).not.toContain(verb);
    }
  });
});
