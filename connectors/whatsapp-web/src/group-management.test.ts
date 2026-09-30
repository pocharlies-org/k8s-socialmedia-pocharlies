/**
 * Group management (fase 3 / PR-6): create a group, change subject /
 * description / settings, add / remove / promote / demote participants — the
 * admin checks, the per-participant answers of WhatsApp, the conversation row
 * the connector keeps, and the HTTP surface (signed body, sending gate,
 * errors with failureClass).
 *
 * No socket and no DB: a fake sock records what would go to WhatsApp and
 * pg.Pool#query is stubbed per test (same harness as chat-state.test.ts).
 * Ported and adapted from the NAS fork's capabilities-client.test.ts ("group
 * capabilities follow the account participant admin role and restrict
 * setting", "group info and participants reject direct JIDs before querying
 * Baileys").
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
  GroupActionError,
  groupCapabilities,
  normalizeGroupJid,
  parseGroupParticipants,
  parseGroupUpdate,
  participantOutcome,
  toParticipantJid,
} from './group-management';
import { resetChatStateForTests } from './chat-state';
import { resetDurableStoreStateForTests } from './durable-message-store';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';

interface QueryCall {
  sql: string;
  params: unknown[];
}

type Rows = Record<string, unknown>[];

function stubPool(route: (sql: string, params: unknown[]) => Rows = () => []): {
  calls: QueryCall[];
  restore: () => void;
} {
  const calls: QueryCall[] = [];
  const original = pg.Pool.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    try {
      const rows = route(sql, params);
      return Promise.resolve({ rows, rowCount: rows.length });
    } catch (error) {
      return Promise.reject(error);
    }
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
}

const isResolve = (sql: string): boolean => /WITH RECURSIVE hop/.test(sql);
const isInsert = (sql: string): boolean => /INSERT INTO conversations/.test(sql);
const isGroupUpdate = (sql: string): boolean =>
  /^\s*UPDATE conversations SET (name|participant_count)/.test(sql);

/** Our account: PN 34600111222 (device 5), LID 900. */
const ME_PN = '34600111222@s.whatsapp.net';
const ME_LID = '900@lid';
const GROUP = '120363000000000001@g.us';

type Admin = 'admin' | 'superadmin' | null;

function groupMeta(
  options: {
    selfAdmin?: Admin;
    selfListed?: boolean;
    restrict?: boolean;
    announce?: boolean;
    memberAddMode?: boolean;
    community?: boolean;
    subject?: string;
    desc?: string;
  } = {}
): any {
  const participants: any[] = [
    // A LID-addressed group: we appear by LID with our PN alongside.
    ...(options.selfListed === false
      ? []
      : [{ id: ME_LID, phoneNumber: ME_PN, admin: options.selfAdmin ?? null }]),
    { id: '111@lid', phoneNumber: '34611111111@s.whatsapp.net', admin: 'superadmin' },
    { id: '222@lid', phoneNumber: '34622222222@s.whatsapp.net', admin: null },
    { id: '34633333333@s.whatsapp.net', admin: null },
  ];
  return {
    id: GROUP,
    subject: options.subject ?? 'Equipo',
    desc: options.desc ?? 'Antes',
    owner: '111@lid',
    creation: 1_790_000_000,
    restrict: options.restrict ?? true,
    announce: options.announce ?? false,
    memberAddMode: options.memberAddMode ?? false,
    isCommunity: options.community ?? false,
    isCommunityAnnounce: false,
    size: participants.length,
    participants,
  };
}

interface SockCalls {
  metadata: string[];
  created: Array<{ subject: string; participants: string[] }>;
  subject: Array<[string, string]>;
  description: Array<[string, string | undefined]>;
  settings: Array<[string, string]>;
  participants: Array<{ jid: string; participants: string[]; action: string }>;
}

interface Behaviour {
  meta?: () => any;
  metadataError?: unknown;
  createAnswer?: (subject: string, participants: string[]) => any;
  participantsAnswer?: (participants: string[], action: string) => any[];
  descriptionError?: unknown;
  subjectError?: unknown;
  lid?: Record<string, string>;
}

function makeClient(
  options: BaileysClientOptions = {},
  behaviour: Behaviour = {}
): { client: BaileysClient; calls: SockCalls; handlers: Record<string, (u: any) => unknown> } {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16), options);
  const calls: SockCalls = {
    metadata: [],
    created: [],
    subject: [],
    description: [],
    settings: [],
    participants: [],
  };
  const handlers: Record<string, (u: any) => unknown> = {};
  const lid = behaviour.lid || {};
  const sock = {
    ev: {
      on: (event: string, fn: (u: any) => unknown) => {
        handlers[event] = fn;
      },
    },
    user: { id: '34600111222:5@s.whatsapp.net', lid: '900:5@lid' },
    signalRepository: {
      lidMapping: {
        getLIDForPN: async (pn: string) => lid[pn] ?? null,
        getPNForLID: async (l: string) =>
          Object.entries(lid).find(([, value]) => value === l)?.[0] ?? null,
      },
    },
    groupMetadata: async (jid: string) => {
      calls.metadata.push(jid);
      if (behaviour.metadataError) throw behaviour.metadataError;
      return (behaviour.meta || (() => groupMeta()))();
    },
    groupCreate: async (subject: string, participants: string[]) => {
      calls.created.push({ subject, participants });
      return behaviour.createAnswer
        ? behaviour.createAnswer(subject, participants)
        : {
            ...groupMeta({ selfAdmin: 'superadmin', subject }),
            participants: [
              { id: ME_LID, phoneNumber: ME_PN, admin: 'superadmin' },
              ...participants.map(id => ({ id, admin: null })),
            ],
          };
    },
    groupUpdateSubject: async (jid: string, subject: string) => {
      calls.subject.push([jid, subject]);
      if (behaviour.subjectError) throw behaviour.subjectError;
    },
    groupUpdateDescription: async (jid: string, description?: string) => {
      calls.description.push([jid, description]);
      if (behaviour.descriptionError) throw behaviour.descriptionError;
    },
    groupSettingUpdate: async (jid: string, setting: string) => {
      calls.settings.push([jid, setting]);
    },
    groupParticipantsUpdate: async (jid: string, participants: string[], action: string) => {
      calls.participants.push({ jid, participants, action });
      return behaviour.participantsAnswer
        ? behaviour.participantsAnswer(participants, action)
        : participants.map(p => ({ status: '200', jid: p }));
    },
    end: () => {},
  };
  const internals = client as unknown as { sock: unknown; ready: boolean };
  internals.sock = sock;
  internals.ready = true;
  return { client, calls, handlers };
}

function boom(statusCode: number, message = `boom ${statusCode}`): Error {
  return Object.assign(new Error(message), { isBoom: true, output: { statusCode } });
}

function priv(client: BaileysClient): any {
  return client as any;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
}

function sockCallsToWhatsApp(calls: SockCalls): number {
  return (
    calls.created.length +
    calls.subject.length +
    calls.description.length +
    calls.settings.length +
    calls.participants.length
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

test('participants: phone numbers and PN / LID jids become Baileys jids; the rest is refused', () => {
  useAccount('professional');
  assert.equal(toParticipantJid('+34 600 11 22 33'), '34600112233@s.whatsapp.net');
  assert.equal(toParticipantJid('0034-600-112-233'), '34600112233@s.whatsapp.net');
  // A 9-digit national number gets WA_DEFAULT_COUNTRY_CODE (34), as the contact seed does.
  assert.equal(toParticipantJid('600112233'), '34600112233@s.whatsapp.net');
  assert.equal(toParticipantJid('34600112233@c.us'), '34600112233@s.whatsapp.net');
  assert.equal(toParticipantJid('34600112233:7@s.whatsapp.net'), '34600112233@s.whatsapp.net');
  assert.equal(toParticipantJid('professional:34600112233@c.us'), '34600112233@s.whatsapp.net');
  assert.equal(toParticipantJid('123456789012345@lid'), '123456789012345@lid');
  for (const bad of [
    '',
    'hola',
    '600abc123',
    GROUP,
    'status@broadcast',
    '123@newsletter',
    'x@lid',
    '12@c.us',
    3,
    null,
  ]) {
    assert.equal(toParticipantJid(bad), null, String(bad));
  }
  assert.deepEqual(parseGroupParticipants(['+34600112233', '34600112233@c.us', '900@lid']), [
    { input: '+34600112233', jid: '34600112233@s.whatsapp.net' },
    { input: '900@lid', jid: '900@lid' },
  ]);
  assert.throws(
    () => parseGroupParticipants(['+34600112233', GROUP]),
    (e: unknown) =>
      e instanceof GroupActionError &&
      e.status === 400 &&
      e.failureClass === 'invalid_request' &&
      JSON.stringify(e.details) === JSON.stringify({ invalid: [GROUP] })
  );
  assert.throws(() => parseGroupParticipants([]), GroupActionError);
  assert.throws(() => parseGroupParticipants('34600112233'), GroupActionError);
  assert.throws(
    () => parseGroupParticipants(Array.from({ length: 51 }, (_, i) => `346001122${10 + i}`)),
    /At most 50/
  );
});

test('group jids: only …@g.us, the account prefix stripped, a direct chat refused', () => {
  useAccount('professional');
  assert.equal(normalizeGroupJid(`professional:${GROUP}`), GROUP);
  assert.equal(normalizeGroupJid('34600-1500000000@g.us'), '34600-1500000000@g.us');
  assert.equal(normalizeGroupJid('34600@c.us'), null);
  assert.equal(normalizeGroupJid('34600@s.whatsapp.net'), null);
  assert.equal(normalizeGroupJid('900@lid'), null);
  assert.equal(normalizeGroupJid(`leila:${GROUP}`), null, 'another account’s prefix');
  assert.equal(normalizeGroupJid('status@broadcast'), null);
});

test('updates: subject 1–100, description ≤ 2048 ("" removes it), settings booleans, something asked', () => {
  assert.deepEqual(parseGroupUpdate({ subject: '  Nuevo  ' }), { subject: 'Nuevo' });
  assert.deepEqual(parseGroupUpdate({ description: '   ' }), { description: '' });
  assert.deepEqual(parseGroupUpdate({ settings: { announce: true, restrict: false } }), {
    settings: { announce: true, restrict: false },
  });
  for (const bad of [
    {},
    { settings: {} },
    { subject: '' },
    { subject: 'x'.repeat(101) },
    { description: 'x'.repeat(2049) },
    { description: 5 },
    { settings: { announce: 'yes' } },
    { settings: { ephemeral: true } },
    { settings: [] },
  ]) {
    assert.throws(
      () => parseGroupUpdate(bad),
      (e: unknown) => e instanceof GroupActionError && e.failureClass === 'invalid_request',
      JSON.stringify(bad)
    );
  }
  // 100 emoji are 100 characters, not 200 UTF-16 units.
  assert.equal(parseGroupUpdate({ subject: '🙂'.repeat(100) }).subject?.length, 200);
});

test('WhatsApp per-participant codes read as reasons', () => {
  assert.deepEqual(participantOutcome('add', '200'), { ok: true, reason: 'added' });
  assert.deepEqual(participantOutcome('remove', '200'), { ok: true, reason: 'removed' });
  assert.deepEqual(participantOutcome('add', '403'), { ok: false, reason: 'invite_required' });
  assert.deepEqual(participantOutcome('add', '408'), { ok: false, reason: 'recently_left' });
  assert.deepEqual(participantOutcome('add', '409'), { ok: false, reason: 'already_participant' });
  assert.deepEqual(participantOutcome('promote', '404'), {
    ok: false,
    reason: 'not_a_participant',
  });
  assert.deepEqual(participantOutcome('demote', null), { ok: false, reason: 'no_answer' });
  assert.deepEqual(participantOutcome('add', '500'), { ok: false, reason: 'failed' });
});

// ---------------------------------------------------------------------------
// Capabilities (ported: "follow the account participant admin role")
// ---------------------------------------------------------------------------

test('group capabilities follow the account participant admin role and restrict setting', async () => {
  useAccount('personal');
  let meta = groupMeta({ selfAdmin: null, restrict: true });
  const { client } = makeClient({}, { meta: () => meta });
  const caps = async (): Promise<Record<string, boolean>> =>
    (await client.getGroupState(GROUP)).capabilities as unknown as Record<string, boolean>;

  assert.deepEqual(await caps(), {
    isMember: true,
    isAdmin: false,
    isSuperAdmin: false,
    editInfo: false,
    changeSettings: false,
    addParticipants: false,
    manageParticipants: false,
  });
  meta = groupMeta({ selfAdmin: null, restrict: false, memberAddMode: true });
  assert.deepEqual(await caps(), {
    isMember: true,
    isAdmin: false,
    isSuperAdmin: false,
    editInfo: true,
    changeSettings: false,
    addParticipants: true,
    manageParticipants: false,
  });
  meta = groupMeta({ selfAdmin: 'admin', restrict: true });
  assert.deepEqual(await caps(), {
    isMember: true,
    isAdmin: true,
    isSuperAdmin: false,
    editInfo: true,
    changeSettings: true,
    addParticipants: true,
    manageParticipants: true,
  });
  meta = groupMeta({ selfListed: false });
  assert.equal((await caps()).isMember, false);
  assert.equal((await caps()).editInfo, false);
  // Communities are managed from WhatsApp: nothing here.
  assert.deepEqual(
    Object.values(
      groupCapabilities(groupMeta({ selfAdmin: 'superadmin', community: true }), {
        id: ME_LID,
        admin: 'superadmin',
      })
    ).slice(3),
    [false, false, false, false]
  );
});

test('group state: our row found by LID or PN, participants with phone / lid, fresh metadata', async () => {
  useAccount('professional');
  const { client, calls } = makeClient(
    {},
    { meta: () => groupMeta({ selfAdmin: 'admin', restrict: false, announce: true }) }
  );
  priv(client).contactNames.set('222@lid', 'Bea');
  const state = await client.getGroupState(`professional:${GROUP}`);
  await client.getGroupState(GROUP);
  assert.deepEqual(calls.metadata, [GROUP, GROUP], 'forced, never the cache');
  assert.equal(state.groupId, GROUP);
  assert.equal(state.subject, 'Equipo');
  assert.equal(state.description, 'Antes');
  assert.equal(state.announce, true);
  assert.equal(state.restrict, false);
  assert.equal(state.createdAt, new Date(1_790_000_000_000).toISOString());
  assert.equal(state.owner, '111@lid');
  assert.deepEqual(state.participants, [
    {
      jid: ME_LID,
      phone: '+34600111222',
      lid: ME_LID,
      name: null,
      isAdmin: true,
      isSuperAdmin: false,
      isSelf: true,
    },
    {
      jid: '111@lid',
      phone: '+34611111111',
      lid: '111@lid',
      name: null,
      isAdmin: true,
      isSuperAdmin: true,
      isSelf: false,
    },
    {
      jid: '222@lid',
      phone: '+34622222222',
      lid: '222@lid',
      name: 'Bea',
      isAdmin: false,
      isSuperAdmin: false,
      isSelf: false,
    },
    {
      jid: '34633333333@c.us',
      phone: '+34633333333',
      lid: null,
      name: null,
      isAdmin: false,
      isSuperAdmin: false,
      isSelf: false,
    },
  ]);
});

test('group routes reject direct JIDs before querying Baileys', async () => {
  useAccount('personal');
  const { client, calls } = makeClient({}, { meta: () => groupMeta({ selfAdmin: 'admin' }) });
  const direct = (e: unknown): boolean =>
    e instanceof GroupActionError && e.status === 400 && e.failureClass === 'invalid_request';
  for (const jid of ['34600@s.whatsapp.net', '34600@c.us', '900@lid', 'status@broadcast']) {
    await assert.rejects(client.getGroupState(jid), direct);
    await assert.rejects(client.updateGroup(jid, { subject: 'x' }), direct);
    await assert.rejects(client.updateGroupParticipants(jid, 'add', ['+34600112233']), direct);
  }
  assert.deepEqual(calls.metadata, []);
  assert.equal(sockCallsToWhatsApp(calls), 0);
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

test('create: phones go as PN jids, each person reported, the conversation row namespaced + account_id', async () => {
  useAccount('professional');
  const { calls: db, restore } = stubPool(sql =>
    isInsert(sql) ? [{ id: `professional:${GROUP}` }] : []
  );
  try {
    const { client, calls } = makeClient(
      {},
      {
        // WhatsApp put the first one in (under its LID) and not the second
        // (privacy: invite only) — Baileys drops the per-participant error.
        createAnswer: (subject, participants) => ({
          ...groupMeta({ selfAdmin: 'superadmin', subject }),
          participants: [
            { id: ME_LID, phoneNumber: ME_PN, admin: 'superadmin' },
            { id: '444@lid', phoneNumber: participants[0], admin: null },
          ],
        }),
      }
    );
    const result = await client.createGroup(' Pedidos ', ['+34 644 444 444', '34655555555@c.us'], {
      actor: 'dani',
    });
    assert.deepEqual(calls.created, [
      {
        subject: 'Pedidos',
        participants: ['34644444444@s.whatsapp.net', '34655555555@s.whatsapp.net'],
      },
    ]);
    assert.equal(result.groupId, GROUP);
    assert.equal(result.conversationId, `professional:${GROUP}`);
    assert.equal(result.persisted, true);
    assert.deepEqual(result.participants, [
      {
        participant: '+34 644 444 444',
        jid: '34644444444@c.us',
        status: null,
        ok: true,
        reason: 'added',
      },
      {
        participant: '34655555555@c.us',
        jid: '34655555555@c.us',
        status: null,
        ok: false,
        reason: 'not_added',
      },
    ]);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.group.capabilities.isSuperAdmin, true);

    const inserts = db.filter(c => isInsert(c.sql));
    assert.equal(inserts.length, 1);
    assert.match(inserts[0].sql, /ON CONFLICT \(id\) DO UPDATE/);
    assert.match(inserts[0].sql, /WHERE conversations\.merged_into IS NULL/);
    assert.doesNotMatch(inserts[0].sql.split('DO UPDATE')[1], /last_message_at/);
    assert.deepEqual(inserts[0].params, [
      `professional:${GROUP}`,
      'Pedidos',
      2,
      new Date(1_790_000_000_000),
      'professional',
      'whatsapp:professional',
      GROUP,
    ]);
  } finally {
    restore();
  }
});

test('create: our own number is refused before WhatsApp; a PN answered as an unknown LID resolves by mapping', async () => {
  useAccount('personal');
  const { restore } = stubPool(() => []);
  try {
    const { client, calls } = makeClient(
      {},
      {
        lid: { '34644444444@s.whatsapp.net': '444@lid' },
        createAnswer: subject => ({
          ...groupMeta({ subject }),
          participants: [
            { id: ME_LID, admin: 'superadmin' },
            { id: '444@lid', admin: null },
          ],
        }),
      }
    );
    await assert.rejects(
      client.createGroup('X', ['+34 600 111 222']),
      (e: unknown) => e instanceof GroupActionError && e.failureClass === 'self_participant'
    );
    assert.equal(calls.created.length, 0);
    const result = await client.createGroup('X', ['+34644444444']);
    assert.deepEqual(
      result.participants.map(p => [p.participant, p.ok]),
      [['+34644444444', true]]
    );
  } finally {
    restore();
  }
});

test('create with ingest off (the pairing pool) goes to WhatsApp and writes nothing', async () => {
  useAccount('personal');
  const { calls: db, restore } = stubPool(() => []);
  try {
    const { client, calls } = makeClient(
      { ingest: false },
      { meta: () => groupMeta({ selfAdmin: 'admin' }) }
    );
    const result = await client.createGroup('Pool', ['+34644444444']);
    assert.equal(calls.created.length, 1);
    assert.equal(result.conversationId, null);
    assert.equal(result.persisted, false);
    const updated = await client.updateGroup(GROUP, { subject: 'Otro' });
    assert.equal(updated.persisted, false);
    assert.deepEqual(db, []);
  } finally {
    restore();
  }
});

test('a WhatsApp refusal of the create is 422 rejected_by_whatsapp with its code; a timeout stays a timeout', async () => {
  useAccount('personal');
  const { client } = makeClient(
    {},
    {
      createAnswer: () => {
        throw boom(406, 'not-acceptable');
      },
    }
  );
  await assert.rejects(
    client.createGroup('X', ['+34644444444']),
    (e: unknown) =>
      e instanceof GroupActionError &&
      e.status === 422 &&
      e.failureClass === 'rejected_by_whatsapp' &&
      e.code === '406'
  );
  const { client: slow } = makeClient(
    {},
    {
      createAnswer: () => {
        throw boom(408, 'Timed Out');
      },
    }
  );
  await assert.rejects(
    slow.createGroup('X', ['+34644444444']),
    (e: unknown) => !(e instanceof GroupActionError)
  );
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

test('update: not admin of a restricted group → 403 not_group_admin, nothing sent', async () => {
  useAccount('personal');
  const { calls: db, restore } = stubPool(() => []);
  try {
    const { client, calls } = makeClient(
      {},
      { meta: () => groupMeta({ selfAdmin: null, restrict: true }) }
    );
    for (const update of [
      { subject: 'Nuevo' },
      { description: 'x' },
      { settings: { announce: true } },
    ]) {
      await assert.rejects(
        client.updateGroup(GROUP, update),
        (e: unknown) =>
          e instanceof GroupActionError && e.status === 403 && e.failureClass === 'not_group_admin',
        JSON.stringify(update)
      );
    }
    assert.equal(sockCallsToWhatsApp(calls), 0);
    assert.deepEqual(db, []);
  } finally {
    restore();
  }
});

test('update: a member may edit info of an unrestricted group but not its settings; not a member → 403', async () => {
  useAccount('personal');
  const { restore } = stubPool(sql => (isResolve(sql) ? [{ id: GROUP, external_id: GROUP }] : []));
  try {
    let meta = groupMeta({ selfAdmin: null, restrict: false });
    const { client, calls } = makeClient({}, { meta: () => meta });
    const result = await client.updateGroup(GROUP, { subject: 'Nuevo' });
    assert.deepEqual(calls.subject, [[GROUP, 'Nuevo']]);
    assert.deepEqual(result.changed, ['subject']);
    await assert.rejects(
      client.updateGroup(GROUP, { settings: { restrict: true } }),
      (e: unknown) => e instanceof GroupActionError && e.failureClass === 'not_group_admin'
    );
    meta = groupMeta({ selfListed: false, restrict: false });
    await assert.rejects(
      client.updateGroup(GROUP, { subject: 'Otra' }),
      (e: unknown) =>
        e instanceof GroupActionError && e.status === 403 && e.failureClass === 'not_group_member'
    );
    meta = groupMeta({ selfAdmin: 'superadmin', community: true });
    await assert.rejects(
      client.updateGroup(GROUP, { subject: 'Otra' }),
      (e: unknown) =>
        e instanceof GroupActionError &&
        e.status === 422 &&
        e.failureClass === 'community_unsupported'
    );
    assert.equal(calls.subject.length, 1);
  } finally {
    restore();
  }
});

test('update as admin: only what changes goes out, the subject lands on the canonical row', async () => {
  useAccount('professional');
  const { calls: db, restore } = stubPool(sql => {
    if (isResolve(sql)) return [{ id: `professional:${GROUP}`, external_id: GROUP }];
    if (isGroupUpdate(sql)) return [{}];
    return [];
  });
  try {
    const { client, calls } = makeClient(
      {},
      {
        meta: () =>
          groupMeta({ selfAdmin: 'admin', restrict: true, announce: false, desc: 'Antes' }),
      }
    );
    const result = await client.updateGroup(
      `professional:${GROUP}`,
      {
        subject: 'Pedidos 2026',
        description: 'Antes',
        settings: { announce: true, restrict: true },
      },
      { actor: 'dani' }
    );
    assert.deepEqual(calls.subject, [[GROUP, 'Pedidos 2026']]);
    assert.deepEqual(calls.description, [], 'same description: not sent');
    assert.deepEqual(calls.settings, [[GROUP, 'announcement']], 'already restricted: not sent');
    assert.deepEqual(result.changed, ['subject', 'announce']);
    assert.deepEqual(result.unchanged, ['description', 'restrict']);
    assert.equal(result.persisted, true);
    assert.ok(result.group);
    const writes = db.filter(c => isGroupUpdate(c.sql));
    assert.equal(writes.length, 1);
    assert.match(writes[0].sql, /WHERE id = \$1 AND account_id = \$2 AND merged_into IS NULL/);
    assert.match(writes[0].sql, /name IS DISTINCT FROM \$3/);
    assert.deepEqual(writes[0].params, [
      `professional:${GROUP}`,
      'whatsapp:professional',
      'Pedidos 2026',
    ]);

    // Removing the description sends an empty one (Baileys: delete).
    await client.updateGroup(GROUP, { description: '' });
    assert.deepEqual(calls.description, [[GROUP, undefined]]);
  } finally {
    restore();
  }
});

test('update: a failure after an earlier change says what was already applied', async () => {
  useAccount('personal');
  const { restore } = stubPool(() => []);
  try {
    const { client, calls } = makeClient(
      {},
      {
        meta: () => groupMeta({ selfAdmin: 'admin' }),
        descriptionError: boom(406, 'not-acceptable'),
      }
    );
    await assert.rejects(
      client.updateGroup(GROUP, { subject: 'Nuevo', description: 'Otra' }),
      (e: unknown) =>
        e instanceof GroupActionError &&
        e.status === 422 &&
        e.failureClass === 'rejected_by_whatsapp' &&
        e.code === '406' &&
        JSON.stringify(e.details) ===
          JSON.stringify({ applied: ['subject'], failed: 'description' })
    );
    assert.equal(calls.subject.length, 1);
    // Refused on the first change: nothing applied, the plain error.
    const { client: second } = makeClient(
      {},
      { meta: () => groupMeta({ selfAdmin: 'admin' }), subjectError: boom(403, 'forbidden') }
    );
    await assert.rejects(
      second.updateGroup(GROUP, { subject: 'Nuevo' }),
      (e: unknown) =>
        e instanceof GroupActionError && e.failureClass === 'not_group_admin' && !e.details
    );
  } finally {
    restore();
  }
});

test('metadata refusals: 403 = not a member, 404 = no such group', async () => {
  useAccount('personal');
  const { client: gone } = makeClient({}, { metadataError: boom(404, 'item-not-found') });
  await assert.rejects(
    gone.getGroupState(GROUP),
    (e: unknown) =>
      e instanceof GroupActionError && e.status === 404 && e.failureClass === 'group_unavailable'
  );
  const { client: out } = makeClient({}, { metadataError: boom(403, 'forbidden') });
  await assert.rejects(
    out.updateGroupParticipants(GROUP, 'add', ['+34644444444']),
    (e: unknown) =>
      e instanceof GroupActionError && e.status === 403 && e.failureClass === 'not_group_member'
  );
});

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

test('participants: partial results reported per person, never a pretended success', async () => {
  useAccount('professional');
  const { calls: db, restore } = stubPool(sql => {
    if (isResolve(sql)) return [{ id: `professional:${GROUP}`, external_id: GROUP }];
    if (isGroupUpdate(sql)) return [{}];
    return [];
  });
  try {
    const { client, calls } = makeClient(
      {},
      {
        meta: () => groupMeta({ selfAdmin: 'admin' }),
        participantsAnswer: participants =>
          participants.map((jid, i) => ({ status: ['200', '403', '409', '408'][i], jid })),
      }
    );
    const result = await client.updateGroupParticipants(
      GROUP,
      'add',
      ['+34644444444', '34655555555@c.us', '+34 622 222 222', '666@lid'],
      { actor: 'dani' }
    );
    // A PN the group knows under its LID goes as that LID.
    assert.deepEqual(calls.participants, [
      {
        jid: GROUP,
        action: 'add',
        participants: [
          '34644444444@s.whatsapp.net',
          '34655555555@s.whatsapp.net',
          '222@lid',
          '666@lid',
        ],
      },
    ]);
    assert.deepEqual(result.results, [
      {
        participant: '+34644444444',
        jid: '34644444444@c.us',
        status: '200',
        ok: true,
        reason: 'added',
      },
      {
        participant: '34655555555@c.us',
        jid: '34655555555@c.us',
        status: '403',
        ok: false,
        reason: 'invite_required',
      },
      {
        participant: '+34 622 222 222',
        jid: '222@lid',
        status: '409',
        ok: false,
        reason: 'already_participant',
      },
      { participant: '666@lid', jid: '666@lid', status: '408', ok: false, reason: 'recently_left' },
    ]);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 3);
    assert.equal(result.partial, true);
    assert.equal(result.persisted, true);
    const writes = db.filter(c => isGroupUpdate(c.sql));
    assert.deepEqual(
      writes.map(w => w.params),
      [[`professional:${GROUP}`, 'whatsapp:professional', 4]]
    );
  } finally {
    restore();
  }
});

test('participants: nobody done → 422 with the results; answers under other ids pair in order', async () => {
  useAccount('personal');
  const { calls: db, restore } = stubPool(() => []);
  try {
    const { client } = makeClient(
      {},
      {
        meta: () => groupMeta({ selfAdmin: 'admin' }),
        // WhatsApp answered the PN we sent under a LID we did not know.
        participantsAnswer: () => [{ status: '403', jid: '777@lid' }],
      }
    );
    await assert.rejects(
      client.updateGroupParticipants(GROUP, 'add', ['+34677777777']),
      (e: unknown) => {
        assert.ok(e instanceof GroupActionError);
        assert.equal(e.status, 422);
        assert.equal(e.failureClass, 'rejected_by_whatsapp');
        assert.deepEqual(e.details, {
          action: 'add',
          results: [
            {
              participant: '+34677777777',
              jid: '34677777777@c.us',
              status: '403',
              ok: false,
              reason: 'invite_required',
            },
          ],
          succeeded: 0,
          failed: 1,
        });
        return true;
      }
    );
    assert.deepEqual(db, [], 'nothing changed: nothing written');
  } finally {
    restore();
  }
});

test('participants: admin role checked per action; our own row refused; superadmin answers reported', async () => {
  useAccount('personal');
  const { restore } = stubPool(() => []);
  try {
    let meta = groupMeta({ selfAdmin: null, memberAddMode: true });
    const { client, calls } = makeClient(
      {},
      {
        meta: () => meta,
        participantsAnswer: (participants, action) =>
          participants.map(jid => ({
            status: action === 'demote' && jid === '111@lid' ? '406' : '200',
            jid,
          })),
      }
    );
    // Member-add mode on: a plain member may add…
    const added = await client.updateGroupParticipants(GROUP, 'add', ['+34644444444']);
    assert.equal(added.succeeded, 1);
    // …but not remove, promote or demote.
    for (const action of ['remove', 'promote', 'demote']) {
      await assert.rejects(
        client.updateGroupParticipants(GROUP, action, ['+34633333333']),
        (e: unknown) =>
          e instanceof GroupActionError && e.status === 403 && e.failureClass === 'not_group_admin',
        action
      );
    }
    meta = groupMeta({ selfAdmin: 'admin', memberAddMode: false });
    for (const self of ['+34600111222', '900@lid', ME_PN]) {
      await assert.rejects(
        client.updateGroupParticipants(GROUP, 'remove', [self]),
        (e: unknown) =>
          e instanceof GroupActionError &&
          e.status === 422 &&
          e.failureClass === 'self_participant',
        self
      );
    }
    // Demoting the creator: WhatsApp's answer, reported as is.
    const demoted = await client.updateGroupParticipants(GROUP, 'demote', [
      '+34611111111',
      '+34633333333',
    ]);
    assert.deepEqual(calls.participants.at(-1)?.participants, [
      '111@lid',
      '34633333333@s.whatsapp.net',
    ]);
    assert.deepEqual(
      demoted.results.map(r => [r.jid, r.status, r.reason]),
      [
        ['111@lid', '406', 'not_allowed'],
        ['34633333333@c.us', '200', 'demoted'],
      ]
    );
    assert.equal(calls.participants.length, 2);
    await assert.rejects(
      client.updateGroupParticipants(GROUP, 'kick', ['+34633333333']),
      (e: unknown) => e instanceof GroupActionError && e.failureClass === 'invalid_request'
    );
  } finally {
    restore();
  }
});

test('disconnected: group calls fail before WhatsApp', async () => {
  useAccount('personal');
  const { client, calls } = makeClient({}, { meta: () => groupMeta({ selfAdmin: 'admin' }) });
  priv(client).ready = false;
  await assert.rejects(client.getGroupState(GROUP), /not connected/);
  await assert.rejects(client.createGroup('X', ['+34644444444']), /not connected/);
  await assert.rejects(client.updateGroup(GROUP, { subject: 'Y' }), /not connected/);
  await assert.rejects(
    client.updateGroupParticipants(GROUP, 'add', ['+34644444444']),
    /not connected/
  );
  assert.deepEqual(calls.metadata, []);
  assert.equal(sockCallsToWhatsApp(calls), 0);
});

// ---------------------------------------------------------------------------
// Inbound: groups.upsert / groups.update
// ---------------------------------------------------------------------------

test('groups.upsert records the new group; groups.update a new subject on the canonical row', async () => {
  useAccount('leila');
  const { calls: db, restore } = stubPool(sql => {
    if (isResolve(sql)) return [{ id: `leila:${GROUP}`, external_id: GROUP }];
    if (isInsert(sql)) return [{ id: `leila:${GROUP}` }];
    return [];
  });
  try {
    const { client, handlers } = makeClient();
    priv(client).bindSocketEvents(async () => {});
    await handlers['groups.upsert']([groupMeta({ subject: 'Familia' })]);
    await handlers['groups.update']([
      { id: GROUP, subject: 'Familia 2' },
      { id: GROUP, announce: true },
    ]);
    await settle();
    const inserts = db.filter(c => isInsert(c.sql));
    assert.equal(inserts.length, 1);
    assert.deepEqual(inserts[0].params.slice(0, 3), [`leila:${GROUP}`, 'Familia', 4]);
    assert.deepEqual(inserts[0].params.slice(4), ['leila', 'whatsapp:leila', GROUP]);
    const updates = db.filter(c => isGroupUpdate(c.sql));
    assert.equal(updates.length, 1, 'an announce-only update writes nothing');
    assert.deepEqual(updates[0].params, [`leila:${GROUP}`, 'whatsapp:leila', 'Familia 2']);
    assert.equal(priv(client).chatStore.get(GROUP)?.name, 'Familia 2');
  } finally {
    restore();
  }
});

test('a failing group persist never throws out of the handler', async () => {
  useAccount('personal');
  const { restore } = stubPool(() => {
    throw Object.assign(new Error('db down'), { code: '57P01' });
  });
  const warn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const { client, handlers } = makeClient();
    priv(client).bindSocketEvents(async () => {});
    await handlers['groups.upsert']([groupMeta()]);
    await handlers['groups.update']([{ id: GROUP, subject: 'X' }]);
    await settle();
    assert.equal(warnings.length, 2);
  } finally {
    console.warn = warn;
    restore();
  }
});

test('ingest off binds no group handlers at all (the pairing pool never writes)', () => {
  useAccount('personal');
  const { client, handlers } = makeClient({ ingest: false });
  priv(client).bindSocketEvents(async () => {});
  assert.equal(handlers['groups.upsert'], undefined);
  assert.equal(handlers['groups.update'], undefined);
  assert.equal(handlers['group-participants.update'], undefined);
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type Call = (
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
) => Promise<globalThis.Response>;

async function withRouter(
  client: Partial<BaileysClient>,
  env: Record<string, string | undefined>,
  run: (call: Call) => Promise<void>
): Promise<void> {
  const secret = 'test-secret';
  const app = express();
  app.use(express.json());
  const qr = { getCurrentQR: () => null };
  app.use('/api/v1', createRouter(client as BaileysClient, qr as never, secret));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const call: Call = (method, path, body, headers) => {
    const ts = Math.floor(Date.now() / 1000);
    return fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-connector-timestamp': String(ts),
        'x-connector-signature': generateHMACSignature(body ?? {}, ts, secret),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await run(call);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise(resolve => server.close(resolve));
  }
}

function recordingClient(): { client: Partial<BaileysClient>; seen: unknown[] } {
  const seen: unknown[] = [];
  const client = {
    isConnected: () => true,
    getCachedState: () => 'CONNECTED',
    getGroupState: async (groupId: string) => {
      seen.push({ state: groupId });
      return { groupId } as never;
    },
    createGroup: async (subject: unknown, participants: unknown, request?: { actor?: string }) => {
      seen.push({ create: subject, participants, ...request });
      return { groupId: GROUP, conversationId: GROUP, subject, persisted: true } as never;
    },
    updateGroup: async (groupId: string, update: unknown, request?: { actor?: string }) => {
      seen.push({ update: groupId, ...(update as object), ...request });
      return { groupId, changed: ['subject'] } as never;
    },
    updateGroupParticipants: async (
      groupId: string,
      action: string,
      participants: unknown,
      request?: { actor?: string }
    ) => {
      seen.push({ participants: groupId, action, list: participants, ...request });
      return { groupId, action, succeeded: 1 } as never;
    },
  };
  return { client: client as unknown as Partial<BaileysClient>, seen };
}

const ON = { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: undefined };

test('HTTP: the sending gate blocks create / update / participants before WhatsApp (not the read)', async () => {
  const { client, seen } = recordingClient();
  for (const env of [
    { ENABLE_SENDING: 'false', EMERGENCY_DISABLE_SENDING: undefined },
    { ENABLE_SENDING: undefined, EMERGENCY_DISABLE_SENDING: undefined },
    { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: 'true' },
  ]) {
    await withRouter(client, env, async call => {
      for (const [path, body] of [
        ['/groups/create', { subject: 'X', participants: ['+34644444444'] }],
        ['/groups/update', { groupId: GROUP, subject: 'X' }],
        [
          '/groups/participants',
          { groupId: GROUP, action: 'remove', participants: ['+34644444444'] },
        ],
      ] as const) {
        const res = await call('POST', path, body);
        assert.equal(res.status, 403, path);
        assert.equal(
          ((await res.json()) as { failureClass: string }).failureClass,
          'disabled_sending'
        );
      }
      const read = await call('POST', '/groups/state', { groupId: GROUP });
      assert.equal(read.status, 200);
    });
  }
  assert.deepEqual(seen, [{ state: GROUP }, { state: GROUP }, { state: GROUP }]);
});

test('HTTP: 200 shapes carry the ids from the signed body and the actor', async () => {
  useAccount('professional');
  const { client, seen } = recordingClient();
  await withRouter(client, ON, async call => {
    const created = await call('POST', '/groups/create', {
      subject: ' Pedidos ',
      participants: ['+34 644 444 444', '34644444444@c.us'],
      actor: ' dani ',
    });
    assert.equal(created.status, 200);
    assert.deepEqual(await created.json(), {
      created: true,
      groupId: GROUP,
      conversationId: GROUP,
      subject: 'Pedidos',
      persisted: true,
    });
    const updated = await call('POST', '/groups/update', {
      groupId: `professional:${GROUP}`,
      subject: 'Nuevo',
      settings: { announce: true },
    });
    assert.deepEqual(await updated.json(), { updated: true, groupId: GROUP, changed: ['subject'] });
    const members = await call('POST', '/groups/participants', {
      conversationId: GROUP,
      action: 'Promote',
      participants: ['900@lid'],
      actor: 'dani',
    });
    assert.deepEqual(await members.json(), {
      updated: true,
      groupId: GROUP,
      action: 'promote',
      succeeded: 1,
    });
    const state = await call('POST', '/groups/state', { groupId: `professional:${GROUP}` });
    assert.deepEqual(await state.json(), { group: { groupId: GROUP } });
  });
  assert.deepEqual(seen, [
    { create: 'Pedidos', participants: ['+34 644 444 444'], actor: 'dani' },
    { update: GROUP, subject: 'Nuevo', settings: { announce: true }, actor: undefined },
    { participants: GROUP, action: 'promote', list: ['900@lid'], actor: 'dani' },
    { state: GROUP },
  ]);
});

test('HTTP: 400 on bad input before the gate, direct jids refused, 503 when disconnected', async () => {
  const { client, seen } = recordingClient();
  let connected = true;
  Object.assign(client, { isConnected: () => connected });
  // Sending off: a 400 still wins (nothing is even considered for WhatsApp).
  await withRouter(client, { ENABLE_SENDING: 'false' }, async call => {
    const bad = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
      const res = await call('POST', path, body);
      assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`);
      const json = (await res.json()) as Record<string, unknown>;
      assert.equal(json.failureClass, 'invalid_request');
      return json;
    };
    await bad('/groups/state', {});
    await bad('/groups/state', { groupId: '34600@c.us' });
    await bad('/groups/create', { participants: ['+34644444444'] });
    await bad('/groups/create', { subject: 'X', participants: [] });
    await bad('/groups/create', { subject: 'X' });
    const listed = await bad('/groups/create', {
      subject: 'X',
      participants: ['+34644444444', GROUP],
    });
    assert.deepEqual(listed.invalid, [GROUP]);
    await bad('/groups/update', { groupId: GROUP });
    await bad('/groups/update', { groupId: '34600@s.whatsapp.net', subject: 'X' });
    await bad('/groups/update', { groupId: GROUP, settings: { announce: 'si' } });
    await bad('/groups/participants', {
      groupId: GROUP,
      action: 'kick',
      participants: ['+34644444444'],
    });
    await bad('/groups/participants', {
      groupId: '900@lid',
      action: 'add',
      participants: ['+34644444444'],
    });
    await bad('/groups/participants', { groupId: GROUP, action: 'add', participants: ['hola'] });
  });
  await withRouter(client, ON, async call => {
    connected = false;
    for (const [path, body] of [
      ['/groups/state', { groupId: GROUP }],
      ['/groups/create', { subject: 'X', participants: ['+34644444444'] }],
      ['/groups/update', { groupId: GROUP, subject: 'X' }],
      ['/groups/participants', { groupId: GROUP, action: 'add', participants: ['+34644444444'] }],
    ] as const) {
      const res = await call('POST', path, body);
      assert.equal(res.status, 503, path);
      assert.equal(((await res.json()) as { failureClass: string }).failureClass, 'disconnected');
    }
  });
  assert.deepEqual(seen, []);
});

test('HTTP: unsigned or tampered bodies are 401 before anything runs', async () => {
  const { client, seen } = recordingClient();
  await withRouter(client, ON, async call => {
    const body = { groupId: GROUP, action: 'remove', participants: ['+34644444444'] };
    const ts = String(Math.floor(Date.now() / 1000));
    const tampered = await call('POST', '/groups/participants', body, {
      'x-connector-timestamp': ts,
      'x-connector-signature': generateHMACSignature(
        { ...body, participants: ['+34655555555'] },
        Number(ts),
        'test-secret'
      ),
    });
    assert.equal(tampered.status, 401);
    const stale = Math.floor(Date.now() / 1000) - 600;
    const old = await call(
      'POST',
      '/groups/create',
      { subject: 'X', participants: ['+34644444444'] },
      {
        'x-connector-timestamp': String(stale),
        'x-connector-signature': generateHMACSignature(
          { subject: 'X', participants: ['+34644444444'] },
          stale,
          'test-secret'
        ),
      }
    );
    assert.equal(old.status, 401);
    const wrongKey = await call(
      'POST',
      '/groups/update',
      { groupId: GROUP, subject: 'X' },
      {
        'x-connector-timestamp': ts,
        'x-connector-signature': generateHMACSignature(
          { groupId: GROUP, subject: 'X' },
          Number(ts),
          'other'
        ),
      }
    );
    assert.equal(wrongKey.status, 401);
  });
  assert.deepEqual(seen, []);
});

test('HTTP: group errors map to status + failureClass with their details', async () => {
  const { client } = recordingClient();
  let failure: Error | null = null;
  Object.assign(client, {
    updateGroupParticipants: async () => {
      throw failure;
    },
    updateGroup: async () => {
      throw failure;
    },
  });
  await withRouter(client, ON, async call => {
    const results = [
      {
        participant: '+34644444444',
        jid: '34644444444@c.us',
        status: '403',
        ok: false,
        reason: 'invite_required',
      },
    ];
    failure = new GroupActionError('nobody', 422, 'rejected_by_whatsapp', {
      details: { action: 'add', results, succeeded: 0, failed: 1 },
    });
    const none = await call('POST', '/groups/participants', {
      groupId: GROUP,
      action: 'add',
      participants: ['+34644444444'],
    });
    assert.equal(none.status, 422);
    assert.deepEqual(await none.json(), {
      error: 'nobody',
      failureClass: 'rejected_by_whatsapp',
      action: 'add',
      results,
      succeeded: 0,
      failed: 1,
    });
    failure = new GroupActionError('admins only', 403, 'not_group_admin');
    const admin = await call('POST', '/groups/update', { groupId: GROUP, subject: 'X' });
    assert.equal(admin.status, 403);
    assert.deepEqual(await admin.json(), { error: 'admins only', failureClass: 'not_group_admin' });
    failure = new GroupActionError('late', 422, 'rejected_by_whatsapp', {
      code: '406',
      details: { applied: ['subject'], failed: 'description' },
    });
    const late = await call('POST', '/groups/update', {
      groupId: GROUP,
      subject: 'X',
      description: 'Y',
    });
    assert.deepEqual(await late.json(), {
      error: 'late',
      failureClass: 'rejected_by_whatsapp',
      code: '406',
      applied: ['subject'],
      failed: 'description',
    });
    failure = new Error('Timed Out');
    const slow = await call('POST', '/groups/update', { groupId: GROUP, subject: 'X' });
    assert.equal(slow.status, 504);
    assert.equal(((await slow.json()) as { failureClass: string }).failureClass, 'timeout');
  });
});

test('HTTP: the existing group reads are untouched', async () => {
  const seen: string[] = [];
  const client = {
    getGroupInfo: async (id: string) => {
      seen.push(`info ${id}`);
      return { id, name: 'Equipo', description: '', participantCount: 3, createdAt: 1 };
    },
    getGroupParticipants: async (id: string) => {
      seen.push(`participants ${id}`);
      return [{ id: '34600@c.us', isAdmin: true, isSuperAdmin: false }];
    },
  };
  await withRouter(client as unknown as Partial<BaileysClient>, ON, async call => {
    const info = await call('GET', `/groups/${GROUP}/info`);
    assert.deepEqual(await info.json(), {
      id: GROUP,
      name: 'Equipo',
      description: '',
      participantCount: 3,
      createdAt: 1,
    });
    const participants = await call('GET', `/groups/${GROUP}/participants`);
    assert.deepEqual(await participants.json(), {
      participants: [{ id: '34600@c.us', isAdmin: true, isSuperAdmin: false }],
    });
  });
  assert.deepEqual(seen, [`info ${GROUP}`, `participants ${GROUP}`]);
});
