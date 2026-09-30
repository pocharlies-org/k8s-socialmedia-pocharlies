/**
 * Invites for the people WhatsApp would not add to a group: a 403 on
 * /groups/participants add (their privacy only allows an invite) is reported
 * as `inviteRequired`, and the opt-in POST /groups/invite sends each of them
 * the invite card — WhatsApp's private code from that refused add when this
 * process still has it, else the group's link code. Admins only, against
 * fresh metadata; the card goes to the person's canonical chat; gated like
 * every send.
 *
 * No socket and no DB: a fake sock records what would go to WhatsApp and
 * pg.Pool#query is stubbed per test.
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import pg from 'pg';
import { BaileysClient, BaileysClientOptions } from './baileys-client';
import {
  addRequestOf,
  GroupActionError,
  GROUP_INVITES_MAX,
  parseGroupInviteParticipants,
  parseGroupInviteText,
} from './group-management';
import { resetChatStateForTests } from './chat-state';
import { resetDurableStoreStateForTests } from './durable-message-store';
import { resetDisappearingStateForTests } from './disappearing';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';

type Rows = Record<string, unknown>[];

function stubPool(route: (sql: string, params: unknown[]) => Rows = () => []): {
  calls: Array<{ sql: string; params: unknown[] }>;
  restore: () => void;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const original = pg.Pool.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    const rows = route(sql, params);
    return Promise.resolve({ rows, rowCount: rows.length });
  };
  return {
    calls,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pg.Pool.prototype as any).query = original;
    },
  };
}

function useAccount(account: string): void {
  process.env.CONNECTOR_ACCOUNT = account;
  resetDurableStoreStateForTests();
  resetChatStateForTests();
  resetDisappearingStateForTests();
}

const ME_PN = '34600111222@s.whatsapp.net';
const ME_LID = '900@lid';
const GROUP = '120363000000000001@g.us';
const ANA_PN = '34644444444@s.whatsapp.net';
const ANA_LID = '444@lid';
const BEA_PN = '34655555555@s.whatsapp.net';
const isResolve = (sql: string): boolean => /WITH RECURSIVE hop/.test(sql);

function groupMeta(options: { selfAdmin?: 'admin' | 'superadmin' | null; extra?: any[] } = {}) {
  return {
    id: GROUP,
    subject: 'Equipo',
    restrict: true,
    announce: false,
    memberAddMode: true,
    isCommunity: false,
    participants: [
      {
        id: ME_LID,
        phoneNumber: ME_PN,
        admin: 'selfAdmin' in options ? options.selfAdmin : 'admin',
      },
      { id: '111@lid', phoneNumber: '34611111111@s.whatsapp.net', admin: 'superadmin' },
      ...(options.extra || []),
    ],
  };
}

/** WhatsApp's answer node for a refused add, as Baileys hands it back in `content`. */
function refused(jid: string, code?: string, expiration?: number): any {
  return {
    status: '403',
    jid,
    content: {
      tag: 'participant',
      attrs: { jid, error: '403' },
      content: code
        ? [{ tag: 'add_request', attrs: { code, expiration: String(expiration) } }]
        : undefined,
    },
  };
}

interface Calls {
  sent: Array<{ jid: string; content: any; opts: any }>;
  inviteCode: number;
  metadata: number;
}

function makeClient(
  options: BaileysClientOptions = {},
  behaviour: {
    meta?: () => any;
    answer?: (participants: string[]) => any[];
    inviteCode?: () => Promise<string | undefined>;
    sendError?: (jid: string) => unknown;
    lid?: Record<string, string>;
  } = {}
): { client: BaileysClient; calls: Calls } {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16), options);
  const calls: Calls = { sent: [], inviteCode: 0, metadata: 0 };
  const lid = behaviour.lid || { [ANA_PN]: ANA_LID };
  let n = 0;
  const sock = {
    ev: { on: () => {} },
    user: { id: '34600111222:5@s.whatsapp.net', lid: '900:5@lid' },
    signalRepository: {
      lidMapping: {
        getLIDForPN: async (pn: string) => lid[pn] ?? null,
        getPNForLID: async (l: string) =>
          Object.entries(lid).find(([, value]) => value === l)?.[0] ?? null,
      },
    },
    groupMetadata: async () => {
      calls.metadata += 1;
      return (behaviour.meta || (() => groupMeta()))();
    },
    groupParticipantsUpdate: async (_jid: string, participants: string[]) =>
      behaviour.answer
        ? behaviour.answer(participants)
        : participants.map(p => ({ status: '200', jid: p })),
    groupInviteCode: async () => {
      calls.inviteCode += 1;
      return behaviour.inviteCode ? behaviour.inviteCode() : 'LINKCODE';
    },
    sendMessage: async (jid: string, content: any, opts: any) => {
      const error = behaviour.sendError?.(jid);
      if (error) throw error;
      calls.sent.push({ jid, content, opts });
      n += 1;
      return { key: { id: `INV${n}`, remoteJid: jid, fromMe: true }, message: {} };
    },
    end: () => {},
  };
  const internals = client as any;
  internals.sock = sock;
  internals.ready = true;
  internals.persistDurablePayload = async () => {};
  return { client, calls };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

test('add_request of a 403 answer; invite inputs: text and participant caps are 400', () => {
  assert.deepEqual(addRequestOf(refused(ANA_LID, 'PRIV1', 1_800_000_000).content), {
    code: 'PRIV1',
    expiration: 1_800_000_000,
  });
  assert.equal(addRequestOf(refused(ANA_LID).content), null);
  assert.equal(addRequestOf(undefined), null);
  assert.equal(addRequestOf({ content: [{ tag: 'add_request', attrs: {} }] }), null);

  assert.equal(parseGroupInviteText(undefined), undefined);
  assert.equal(parseGroupInviteText('  Únete  '), 'Únete');
  assert.throws(
    () => parseGroupInviteText('x'.repeat(2000)),
    (e: unknown) => e instanceof GroupActionError && e.status === 400
  );
  assert.throws(
    () => parseGroupInviteText(42),
    (e: unknown) => e instanceof GroupActionError && e.status === 400
  );
  const many = Array.from({ length: GROUP_INVITES_MAX + 1 }, (_, i) => `+3464400${1000 + i}`);
  assert.throws(
    () => parseGroupInviteParticipants(many),
    (e: unknown) => e instanceof GroupActionError && e.failureClass === 'invalid_request'
  );
  assert.equal(parseGroupInviteParticipants(['+34644444444']).length, 1);
});

// ---------------------------------------------------------------------------
// /groups/participants add → inviteRequired
// ---------------------------------------------------------------------------

test('add: a 403 is reported in inviteRequired (the private code kept, never returned)', async () => {
  useAccount('professional');
  const pool = stubPool();
  try {
    const expiration = Math.floor(Date.now() / 1000) + 3 * 86400;
    const { client, calls } = makeClient(
      {},
      {
        answer: participants =>
          participants.map(p =>
            // WhatsApp answers the PN under her LID.
            p === ANA_PN ? refused(ANA_LID, 'PRIV1', expiration) : { status: '200', jid: p }
          ),
      }
    );
    const result = await client.updateGroupParticipants(GROUP, 'add', [
      '+34644444444',
      '+34655555555',
    ]);
    assert.equal(result.succeeded, 1);
    assert.equal(result.partial, true);
    assert.deepEqual(result.inviteRequired, [
      {
        participant: '+34644444444',
        jid: '34644444444@c.us',
        privateInvite: true,
        inviteExpiresAt: new Date(expiration * 1000).toISOString(),
      },
    ]);
    assert.doesNotMatch(JSON.stringify(result), /PRIV1/, 'the code stays in the connector');

    // Then the invite: Ana gets WhatsApp's private code, to her chat.
    const invited = await client.sendGroupInvites(GROUP, ['+34644444444'], {
      text: 'Te añado al equipo',
      actor: 'dani',
    });
    assert.equal(invited.succeeded, 1);
    assert.deepEqual(invited.results[0], {
      participant: '+34644444444',
      jid: '34644444444@c.us',
      ok: true,
      reason: 'invited',
      invite: 'private',
      messageId: 'INV1',
    });
    assert.equal(calls.inviteCode, 0, 'no group link needed');
    assert.equal(calls.sent.length, 1);
    assert.equal(calls.sent[0].jid, ANA_PN);
    assert.deepEqual(calls.sent[0].content, {
      groupInvite: {
        inviteCode: 'PRIV1',
        inviteExpiration: expiration,
        text: 'Te añado al equipo',
        jid: GROUP,
        subject: 'Equipo',
      },
    });
    // Used once: a second invite falls back to the link.
    await client.sendGroupInvites(GROUP, [ANA_LID]);
    assert.equal(calls.sent[1].content.groupInvite.inviteCode, 'LINKCODE');
  } finally {
    pool.restore();
  }
});

test('add: all refused → 422 whose details carry inviteRequired; other actions have none', async () => {
  useAccount('professional');
  const pool = stubPool();
  try {
    const { client } = makeClient({}, { answer: ps => ps.map(p => refused(p)) });
    await assert.rejects(
      client.updateGroupParticipants(GROUP, 'add', ['+34655555555']),
      (e: unknown) =>
        e instanceof GroupActionError &&
        e.status === 422 &&
        Array.isArray((e.details as any)?.inviteRequired) &&
        (e.details as any).inviteRequired[0].privateInvite === false
    );
    const { client: other } = makeClient({/* promote answers 200 */});
    const promoted = await other.updateGroupParticipants(GROUP, 'promote', ['111@lid']);
    assert.equal(promoted.inviteRequired, undefined);
  } finally {
    pool.restore();
  }
});

// ---------------------------------------------------------------------------
// /groups/invite
// ---------------------------------------------------------------------------

test('invite: admins only; a member already in is reported, not messaged; link code fetched once', async () => {
  useAccount('professional');
  const pool = stubPool();
  try {
    const { client: member, calls: memberCalls } = makeClient(
      {},
      { meta: () => groupMeta({ selfAdmin: null }) }
    );
    await assert.rejects(
      member.sendGroupInvites(GROUP, ['+34644444444']),
      (e: unknown) =>
        e instanceof GroupActionError && e.status === 403 && e.failureClass === 'not_group_admin'
    );
    assert.equal(memberCalls.sent.length, 0);

    const { client, calls } = makeClient(
      {},
      { meta: () => groupMeta({ extra: [{ id: '777@lid', phoneNumber: BEA_PN, admin: null }] }) }
    );
    const result = await client.sendGroupInvites(GROUP, [
      '+34655555555',
      '+34644444444',
      '34666666666@c.us',
    ]);
    assert.deepEqual(
      result.results.map(r => [r.participant, r.reason, r.invite]),
      [
        ['+34655555555', 'already_participant', null],
        ['+34644444444', 'invited', 'link'],
        ['34666666666@c.us', 'invited', 'link'],
      ]
    );
    assert.equal(result.partial, true);
    assert.equal(calls.inviteCode, 1);
    assert.deepEqual(
      calls.sent.map(s => s.jid),
      [ANA_PN, '34666666666@s.whatsapp.net']
    );
    const card = calls.sent[0].content.groupInvite;
    assert.equal(card.text, '');
    assert.ok(card.inviteExpiration > Date.now() / 1000 + 2.9 * 86400, 'about 3 days');
    await assert.rejects(
      client.sendGroupInvites(GROUP, [ME_PN]),
      (e: unknown) => e instanceof GroupActionError && e.failureClass === 'self_participant'
    );
  } finally {
    pool.restore();
  }
});

test('invite: to the canonical chat with its timer; a failed send is reported; none sent → 422', async () => {
  useAccount('professional');
  // Ana's phone chat was merged into her LID conversation, timer 7 days.
  const pool = stubPool((sql, params) => {
    if (isResolve(sql)) {
      const candidates = (params[1] as string[]) || [];
      if (candidates.includes(ANA_PN) || candidates.includes('34644444444@c.us')) {
        return [{ id: `professional:${ANA_LID}`, external_id: ANA_LID }];
      }
      return [];
    }
    if (/SELECT ephemeral_expiration/.test(sql)) {
      return params[0] === `professional:${ANA_LID}`
        ? [{ ephemeral_expiration: 604800, ephemeral_setting_at: null }]
        : [];
    }
    return [];
  });
  try {
    const { client, calls } = makeClient(
      {},
      { sendError: jid => (jid === BEA_PN ? new Error('socket closed') : undefined) }
    );
    const result = await client.sendGroupInvites(GROUP, ['+34644444444', '+34655555555']);
    assert.equal(calls.sent[0].jid, ANA_LID);
    assert.equal(calls.sent[0].opts.ephemeralExpiration, 604800);
    assert.deepEqual(
      result.results.map(r => [r.jid, r.ok, r.reason]),
      [
        ['444@lid', true, 'invited'],
        ['34655555555@c.us', false, 'send_failed'],
      ]
    );
    await assert.rejects(
      client.sendGroupInvites(GROUP, ['+34655555555']),
      (e: unknown) =>
        e instanceof GroupActionError &&
        e.status === 422 &&
        e.failureClass === 'invite_not_sent' &&
        (e.details as any).results[0].reason === 'send_failed'
    );
    // No link (WhatsApp refused it): reported per person, nothing thrown midway.
    const { client: noLink, calls: noLinkCalls } = makeClient(
      {},
      {
        inviteCode: async () => {
          throw Object.assign(new Error('forbidden'), {
            isBoom: true,
            output: { statusCode: 403 },
          });
        },
      }
    );
    await assert.rejects(
      noLink.sendGroupInvites(GROUP, ['+34655555555']),
      (e: unknown) =>
        e instanceof GroupActionError &&
        (e.details as any).results[0].reason === 'invite_link_unavailable'
    );
    assert.equal(noLinkCalls.sent.length, 0);
  } finally {
    pool.restore();
  }
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function withRouter(
  client: Partial<BaileysClient>,
  env: Record<string, string | undefined>,
  run: (call: (path: string, body: unknown) => Promise<globalThis.Response>) => Promise<void>
): Promise<void> {
  const secret = 'test-secret';
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createRouter(client as BaileysClient, { getCurrentQR: () => null } as never, secret)
  );
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await run((path, body) => {
      const ts = Math.floor(Date.now() / 1000);
      return fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-connector-timestamp': String(ts),
          'x-connector-signature': generateHMACSignature(body, ts, secret),
        },
        body: JSON.stringify(body),
      });
    });
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise(resolve => server.close(resolve));
  }
}

test('HTTP /groups/invite: 400 first, then the sending gate (403), offline 503, 200 shape, errors', async () => {
  const seen: unknown[] = [];
  let connected = true;
  let fail: unknown;
  const client = {
    isConnected: () => connected,
    getCachedState: () => (connected ? 'CONNECTED' : 'DISCONNECTED'),
    sendGroupInvites: async (groupId: string, participants: unknown, request: unknown) => {
      seen.push({ groupId, participants, request });
      if (fail) throw fail;
      return { groupId, results: [], succeeded: 1, failed: 0, partial: false };
    },
  } as unknown as Partial<BaileysClient>;
  const ON = { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: undefined };

  await withRouter(
    client,
    { ENABLE_SENDING: 'false', EMERGENCY_DISABLE_SENDING: undefined },
    async call => {
      const bad = await call('/groups/invite', {
        groupId: '34600@c.us',
        participants: ['+34644444444'],
      });
      assert.equal(bad.status, 400, 'a direct chat is not a group, before the gate');
      const noText = await call('/groups/invite', {
        groupId: GROUP,
        participants: ['+34644444444'],
        text: 7,
      });
      assert.equal(noText.status, 400);
      const gated = await call('/groups/invite', {
        groupId: GROUP,
        participants: ['+34644444444'],
      });
      assert.equal(gated.status, 403);
      assert.equal(((await gated.json()) as any).failureClass, 'disabled_sending');
    }
  );
  assert.equal(seen.length, 0);

  await withRouter(client, ON, async call => {
    connected = false;
    const offline = await call('/groups/invite', {
      groupId: GROUP,
      participants: ['+34644444444'],
    });
    assert.equal(offline.status, 503);
    connected = true;
    const ok = await call('/groups/invite', {
      groupId: `professional:${GROUP}`,
      participants: ['+34644444444'],
      text: 'Únete',
      actor: 'dani',
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), {
      invited: true,
      groupId: GROUP,
      results: [],
      succeeded: 1,
      failed: 0,
      partial: false,
    });
    assert.deepEqual(seen[0], {
      groupId: GROUP,
      participants: ['+34644444444'],
      request: { actor: 'dani', text: 'Únete' },
    });
    fail = new GroupActionError('Only admins can invite people', 403, 'not_group_admin');
    const refusedRes = await call('/groups/invite', {
      groupId: GROUP,
      participants: ['+34644444444'],
    });
    assert.equal(refusedRes.status, 403);
    assert.equal(((await refusedRes.json()) as any).failureClass, 'not_group_admin');
    fail = new GroupActionError('none', 422, 'invite_not_sent', {
      details: { results: [{ reason: 'send_failed' }], succeeded: 0, failed: 1 },
    });
    const none = await call('/groups/invite', { groupId: GROUP, participants: ['+34644444444'] });
    assert.equal(none.status, 422);
    const body = (await none.json()) as any;
    assert.equal(body.failureClass, 'invite_not_sent');
    assert.equal(body.results[0].reason, 'send_failed');
  });
});
