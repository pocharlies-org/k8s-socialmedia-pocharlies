/**
 * WhatsApp communities and channels (newsletters): request parsing, the views
 * (a community's announcement group and its groups, joined or not; a
 * channel's whitelisted metadata from rc13's raw WMex shape), the admin
 * checks against fresh metadata, the read-back that proves every write (409
 * change_not_confirmed otherwise, never a blind retry), one write per id at a
 * time, the followed-channel list built from what the connector has seen,
 * and the HTTP surface (signed body, 400s first, the sending gate on writes,
 * reads ungated, 503 offline).
 *
 * No socket and no DB: a provider-shaped fake sock (state that the writes
 * change, like WhatsApp would) and pg.Pool#query stubbed per test. Cases
 * ported from the NAS fork's novedades-communities / novedades-channels tests.
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
  CommunityActionError,
  communityView,
  parseCommunityGroupRequest,
  parseCommunityJid,
  requireLeaveConfirmation,
} from './communities';
import {
  channelStateMatches,
  channelView,
  KeyedSerializer,
  parseChannelJid,
  parseChannelQuery,
  parseChannelSubscriptionAction,
} from './channels';
import { MessageMutationError } from './message-mutations';
import { resetChatStateForTests } from './chat-state';
import { resetDurableStoreStateForTests } from './durable-message-store';
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
}

const isWrite = (sql: string): boolean => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql);

function boom(statusCode: number, message = `boom ${statusCode}`): Error {
  return Object.assign(new Error(message), { isBoom: true, output: { statusCode } });
}

function fails(status: number, failureClass: string, message?: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof MessageMutationError, String(error));
    assert.equal(error.status, status, error.message);
    assert.equal(error.failureClass, failureClass, error.message);
    if (message) assert.match(error.message, message);
    return true;
  };
}

// ---------------------------------------------------------------------------
// A provider-shaped fake: communities as groups (rc13's group parser), and
// channels as rc13's raw newsletter WMex answers
// ---------------------------------------------------------------------------

/** Our account: PN 34600111222 (device 5), LID 900. */
const ME_PN = '34600111222@s.whatsapp.net';
const ME_LID = '900@lid';
const COMMUNITY = '120363000000000100@g.us';
const ANNOUNCE = '120363000000000101@g.us';
const LINKED = '120363000000000102@g.us';
const NOT_JOINED = '120363000000000103@g.us';
const PLAIN = '120363000000000104@g.us';
const OTHER_COMMUNITY = '120363000000000200@g.us';
const CHANNEL = '120363400253693272@newsletter';
const CHANNEL_2 = '120363400000000002@newsletter';

type Admin = 'admin' | 'superadmin' | null;

function group(
  id: string,
  options: {
    subject?: string;
    self?: Admin | 'absent';
    community?: boolean;
    announce?: boolean;
    linkedParent?: string;
    size?: number;
  } = {}
): any {
  const participants: any[] = [
    ...(options.self === 'absent'
      ? []
      : [{ id: ME_LID, phoneNumber: ME_PN, admin: options.self ?? null }]),
    { id: '111@lid', phoneNumber: '34611111111@s.whatsapp.net', admin: 'superadmin' },
  ];
  return {
    id,
    subject: options.subject ?? id.slice(-3),
    desc: options.community ? 'Comunidad del club' : undefined,
    owner: '111@lid',
    creation: 1_790_000_000,
    isCommunity: options.community === true,
    isCommunityAnnounce: options.announce === true,
    linkedParent: options.linkedParent,
    size: options.size ?? participants.length,
    participants,
  };
}

interface Provider {
  groups: Map<string, any>;
  /** What `<sub_groups>` answers per community (also groups we are not in). */
  subGroups: Map<string, Array<{ id: string; subject: string; size?: number; creation?: number }>>;
  channels: Map<string, { role: string; mute: 'ON' | 'OFF'; invite: string; name: string }>;
  writes: string[];
  /** Override per method: throw or change the answer. */
  fail: Record<string, unknown>;
  /** Writes that "land" without changing state (an ignored mutation). */
  ignore: Set<string>;
  createAnswer?: 'null' | 'meta';
}

function newsletterAnswer(jid: string, state: Provider['channels'] extends Map<string, infer V> ? V : never): any {
  return {
    id: jid,
    state: { type: 'ACTIVE' },
    thread_metadata: {
      creation_time: '1700000000',
      description: { id: '1', text: 'Novedades del club', update_time: '0' },
      handle: null,
      invite: state.invite,
      name: { id: '2', text: state.name, update_time: '0' },
      picture: { direct_path: '/v/t61/secret-path', id: '3', type: 'IMAGE' },
      preview: { direct_path: '/v/t61/secret-preview', id: '4', type: 'PREVIEW' },
      subscribers_count: '1234',
      verification: 'VERIFIED',
    },
    viewer_metadata: { mute: state.mute, role: state.role },
  };
}

function provider(): Provider {
  const groups = new Map<string, any>([
    [COMMUNITY, group(COMMUNITY, { subject: 'Club', community: true, self: 'admin', size: 40 })],
    [
      ANNOUNCE,
      group(ANNOUNCE, { subject: 'Avisos', announce: true, linkedParent: COMMUNITY, size: 40 }),
    ],
    [LINKED, group(LINKED, { subject: 'Partidas', linkedParent: COMMUNITY, self: 'admin' })],
    [PLAIN, group(PLAIN, { subject: 'Suelto', self: 'admin' })],
  ]);
  return {
    groups,
    subGroups: new Map([
      [
        COMMUNITY,
        [
          { id: ANNOUNCE, subject: 'Avisos', size: 40 },
          { id: LINKED, subject: 'Partidas', size: 2 },
          { id: NOT_JOINED, subject: 'Material', size: 12, creation: 1_790_000_100 },
        ],
      ],
    ]),
    channels: new Map([
      [CHANNEL, { role: 'SUBSCRIBER', mute: 'OFF', invite: '0029VaClubAbc123', name: 'Club' }],
      [CHANNEL_2, { role: 'GUEST', mute: 'OFF', invite: '0029VaOtherXyz789', name: 'Otro' }],
    ]),
    writes: [],
    fail: {},
    ignore: new Set(),
  };
}

function makeClient(
  state: Provider,
  options: BaileysClientOptions = {}
): { client: BaileysClient; calls: string[] } {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16), options);
  const calls: string[] = [];
  const failing = (name: string): void => {
    const error = state.fail[name];
    if (error) throw error;
  };
  const write = (entry: string, apply: () => void): void => {
    state.writes.push(entry);
    if (!state.ignore.has(entry.split(':')[0])) apply();
  };
  const channelOf = (jid: string) => {
    const channel = state.channels.get(jid);
    if (!channel) throw boom(404, 'GraphQL server error: Newsletter not found');
    return channel;
  };
  const sock = {
    ev: { on: () => {} },
    user: { id: '34600111222:5@s.whatsapp.net', lid: '900:5@lid' },
    signalRepository: { lidMapping: { getLIDForPN: async () => null, getPNForLID: async () => null } },
    groupFetchAllParticipating: async () => {
      calls.push('participating');
      failing('participating');
      const all: Record<string, any> = {};
      for (const [id, meta] of state.groups) {
        if (meta.participants.some((p: any) => p.id === ME_LID)) all[id] = structuredClone(meta);
      }
      return all;
    },
    groupMetadata: async (jid: string) => {
      calls.push(`metadata:${jid}`);
      failing(`metadata:${jid}`);
      const meta = state.groups.get(jid);
      if (!meta || !meta.participants.some((p: any) => p.id === ME_LID)) {
        throw boom(403, 'forbidden');
      }
      return structuredClone(meta);
    },
    communityFetchLinkedGroups: async (jid: string) => {
      calls.push(`subgroups:${jid}`);
      failing('subgroups');
      return { communityJid: jid, isCommunity: true, linkedGroups: state.subGroups.get(jid) || [] };
    },
    communityCreate: async (subject: string, description: string) => {
      write(`create:${subject}:${description}`, () => {
        state.groups.set(OTHER_COMMUNITY, {
          ...group(OTHER_COMMUNITY, { subject, community: true, self: 'superadmin' }),
          owner: ME_LID,
          creation: Math.floor(Date.now() / 1000),
        });
      });
      failing('create');
      return state.createAnswer === 'null' ? null : structuredClone(state.groups.get(OTHER_COMMUNITY));
    },
    communityLinkGroup: async (groupJid: string, parent: string) => {
      write(`link:${groupJid}:${parent}`, () => {
        state.groups.get(groupJid).linkedParent = parent;
        state.subGroups.get(parent)?.push({ id: groupJid, subject: 'x' });
      });
      failing('link');
    },
    communityUnlinkGroup: async (groupJid: string, parent: string) => {
      write(`unlink:${groupJid}:${parent}`, () => {
        const meta = state.groups.get(groupJid);
        if (meta) meta.linkedParent = undefined;
        state.subGroups.set(
          parent,
          (state.subGroups.get(parent) || []).filter(entry => entry.id !== groupJid)
        );
      });
      failing('unlink');
    },
    communityLeave: async (id: string) => {
      write(`leave:${id}`, () => {
        for (const meta of state.groups.values()) {
          if (meta.id === id || meta.linkedParent === id) {
            meta.participants = meta.participants.filter((p: any) => p.id !== ME_LID);
          }
        }
      });
      failing('leave');
    },
    newsletterMetadata: async (type: 'jid' | 'invite', key: string) => {
      calls.push(`newsletter:${type}:${key}`);
      failing('newsletterMetadata');
      if (type === 'invite') {
        const found = Array.from(state.channels.entries()).find(([, c]) => c.invite === key);
        return found ? newsletterAnswer(found[0], found[1]) : null;
      }
      const channel = state.channels.get(key);
      return channel ? newsletterAnswer(key, channel) : null;
    },
    newsletterFollow: async (jid: string) => {
      const channel = channelOf(jid);
      write(`follow:${jid}`, () => (channel.role = 'SUBSCRIBER'));
      failing('follow');
    },
    newsletterUnfollow: async (jid: string) => {
      const channel = channelOf(jid);
      write(`unfollow:${jid}`, () => (channel.role = 'GUEST'));
      failing('unfollow');
    },
    newsletterMute: async (jid: string) => {
      const channel = channelOf(jid);
      write(`mute:${jid}`, () => (channel.mute = 'ON'));
      failing('mute');
    },
    newsletterUnmute: async (jid: string) => {
      const channel = channelOf(jid);
      write(`unmute:${jid}`, () => (channel.mute = 'OFF'));
      failing('unmute');
    },
    end: () => {},
  };
  const internals = client as unknown as { sock: unknown; ready: boolean };
  internals.sock = sock;
  internals.ready = true;
  return { client, calls };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

test('community inputs: jids (account prefix stripped), link | unlink, never itself; leave needs confirm', () => {
  useAccount('professional');
  assert.equal(parseCommunityJid(`professional:${COMMUNITY}`), COMMUNITY);
  for (const bad of ['', '34600111222@c.us', CHANNEL, 'leila:120363@g.us', 7]) {
    assert.throws(() => parseCommunityJid(bad), fails(400, 'invalid_request'));
  }
  assert.deepEqual(
    parseCommunityGroupRequest({ communityId: COMMUNITY, groupId: LINKED, action: 'Unlink' }),
    { communityId: COMMUNITY, groupId: LINKED, action: 'unlink' }
  );
  for (const body of [
    { communityId: COMMUNITY, groupId: LINKED, action: 'leave' },
    { communityId: COMMUNITY, groupId: COMMUNITY, action: 'link' },
    { communityId: COMMUNITY, action: 'link' },
  ]) {
    assert.throws(() => parseCommunityGroupRequest(body), fails(400, 'invalid_request'));
  }
  assert.throws(() => requireLeaveConfirmation({}), fails(400, 'invalid_request', /confirm/));
  assert.throws(() => requireLeaveConfirmation({ confirm: 'true' }), fails(400, 'invalid_request'));
  requireLeaveConfirmation({ confirm: true });
});

test('channel inputs: jid, its digits, a share link (with or without https) or the bare code', () => {
  useAccount('personal');
  assert.deepEqual(parseChannelQuery(CHANNEL), { type: 'jid', key: CHANNEL });
  assert.deepEqual(parseChannelQuery('120363400253693272'), { type: 'jid', key: CHANNEL });
  assert.deepEqual(parseChannelQuery('https://whatsapp.com/channel/0029VaClubAbc123'), {
    type: 'invite',
    key: '0029VaClubAbc123',
  });
  assert.deepEqual(parseChannelQuery('www.whatsapp.com/channel/0029VaClubAbc123/?utm=x'), {
    type: 'invite',
    key: '0029VaClubAbc123',
  });
  assert.deepEqual(parseChannelQuery('0029VaClubAbc123'), { type: 'invite', key: '0029VaClubAbc123' });
  for (const bad of ['', 'https://example.com/channel/abc123', 'hola que tal', COMMUNITY, 7]) {
    assert.throws(() => parseChannelQuery(bad), fails(400, 'invalid_request'), String(bad));
  }
  assert.equal(parseChannelJid(CHANNEL), CHANNEL);
  assert.throws(() => parseChannelJid('0029VaClubAbc123'), fails(400, 'invalid_request'));
  assert.equal(parseChannelSubscriptionAction(' Mute '), 'mute');
  assert.throws(() => parseChannelSubscriptionAction('subscribe'), fails(400, 'invalid_request'));
});

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

test("channel view: rc13's raw WMex answer, only public fields (no picture handles)", () => {
  const view = channelView(
    newsletterAnswer(CHANNEL, { role: 'SUBSCRIBER', mute: 'ON', invite: '0029VaClubAbc123', name: 'Club' })
  );
  assert.deepEqual(view, {
    channelId: CHANNEL,
    name: 'Club',
    description: 'Novedades del club',
    subscribers: 1234,
    verification: 'verified',
    createdAt: '2023-11-14T22:13:20.000Z',
    inviteLink: 'https://whatsapp.com/channel/0029VaClubAbc123',
    role: 'subscriber',
    following: true,
    muted: true,
  });
  assert.doesNotMatch(JSON.stringify(view), /secret|direct_path/);
  // The flat NewsletterMetadata of rc13's types, a guest without viewer mute.
  const flat = channelView({ id: CHANNEL, name: 'Club', subscribers: 7, viewer_metadata: { role: 'GUEST' } });
  assert.equal(flat.following, false);
  assert.equal(flat.muted, null);
  assert.equal(flat.subscribers, 7);
  for (const bad of [null, {}, { id: COMMUNITY }, []]) {
    assert.throws(() => channelView(bad), fails(502, 'provider_invalid_response'));
  }
  assert.equal(channelStateMatches({ following: true, muted: null }, 'follow'), true);
  assert.equal(channelStateMatches({ following: true, muted: null }, 'unmute'), null);
  assert.equal(channelStateMatches({ following: null, muted: false }, 'unfollow'), null);
});

test('community view: announcement group apart, every linked group (joined or not), fallback to joined ones', () => {
  const state = provider();
  const participating = Array.from(state.groups.values());
  const own = (meta: any) => meta.participants.find((p: any) => p.id === ME_LID);
  const view = communityView(
    state.groups.get(COMMUNITY),
    participating,
    state.subGroups.get(COMMUNITY)!,
    own
  );
  assert.equal(view.communityId, COMMUNITY);
  assert.equal(view.subject, 'Club');
  assert.equal(view.description, 'Comunidad del club');
  assert.equal(view.size, 40);
  assert.equal(view.owner, '111@lid');
  assert.deepEqual(view.capabilities, {
    isMember: true,
    isAdmin: true,
    isSuperAdmin: false,
    linkGroups: true,
    unlinkGroups: true,
    leave: true,
  });
  assert.equal(view.announcementGroup?.groupId, ANNOUNCE);
  assert.equal(view.announcementGroup?.joined, true);
  assert.equal(view.announcementGroup?.isAdmin, false);
  assert.deepEqual(
    view.linkedGroups.map(g => [g.groupId, g.subject, g.joined, g.isAdmin, g.size]),
    [
      [LINKED, 'Partidas', true, true, 2],
      [NOT_JOINED, 'Material', false, false, 12],
    ]
  );
  assert.equal(view.linkedGroupsComplete, true);
  const fallback = communityView(state.groups.get(COMMUNITY), participating, null, own);
  assert.deepEqual(
    fallback.linkedGroups.map(g => g.groupId),
    [LINKED]
  );
  assert.equal(fallback.linkedGroupsComplete, false);
});

test('one write per key at a time; other keys do not wait', async () => {
  const serializer = new KeyedSerializer();
  const order: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => (release = resolve));
  const first = serializer.run('a', async () => {
    order.push('a1 start');
    await gate;
    order.push('a1 end');
  });
  const second = serializer.run('a', async () => {
    order.push('a2');
  });
  const other = serializer.run('b', async () => {
    order.push('b');
  });
  await other;
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a1 start', 'b', 'a1 end', 'a2']);
  // A failure does not block the next one.
  await assert.rejects(serializer.run('a', async () => Promise.reject(new Error('x'))), /x/);
  assert.equal(await serializer.run('a', async () => 'next'), 'next');
});

// ---------------------------------------------------------------------------
// Communities through the client
// ---------------------------------------------------------------------------

test('list: communities from the group parser, their groups from <sub_groups>, a parent reached via a group', async () => {
  useAccount('personal');
  const state = provider();
  // A community whose parent is not among the participating groups: only its group is.
  state.groups.set(
    OTHER_COMMUNITY,
    group(OTHER_COMMUNITY, { subject: 'Asociación', community: true, self: 'absent' })
  );
  state.groups.set(
    '120363000000000201@g.us',
    group('120363000000000201@g.us', { subject: 'Junta', linkedParent: OTHER_COMMUNITY })
  );
  const { client, calls } = makeClient(state);
  // Its parent answers our metadata read (members of a community may read it).
  const sock = (client as any).sock;
  const original = sock.groupMetadata;
  sock.groupMetadata = async (jid: string) =>
    jid === OTHER_COMMUNITY ? structuredClone(state.groups.get(jid)) : original(jid);
  const { communities } = await client.listCommunities();
  assert.deepEqual(
    communities.map(c => [c.communityId, c.subject, c.capabilities.isMember, c.linkedGroups.length]),
    [
      [OTHER_COMMUNITY, 'Asociación', false, 1],
      [COMMUNITY, 'Club', true, 2],
    ]
  );
  assert.equal(communities[1].announcementGroup?.groupId, ANNOUNCE);
  assert.equal(calls.filter(c => c === 'participating').length, 1);
  assert.deepEqual(state.writes, []);
});

test('state: a group of a community → 422 not_a_community with its community; not a member → 403', async () => {
  useAccount('personal');
  const state = provider();
  const { client } = makeClient(state);
  const view = await client.getCommunityState(COMMUNITY);
  assert.equal(view.linkedGroups.length, 2);
  await assert.rejects(client.getCommunityState(LINKED), (error: unknown) => {
    fails(422, 'not_a_community')(error);
    assert.deepEqual((error as CommunityActionError).details, { communityId: COMMUNITY });
    return true;
  });
  await assert.rejects(client.getCommunityState(PLAIN), fails(422, 'not_a_community'));
  state.groups.get(COMMUNITY).participants = [];
  await assert.rejects(client.getCommunityState(COMMUNITY), fails(403, 'not_community_member'));
  // <sub_groups> unreadable: still answered, with the groups we are in.
  state.groups.get(COMMUNITY).participants = [{ id: ME_LID, phoneNumber: ME_PN, admin: null }];
  state.fail.subgroups = new Error('timeout');
  const partial = await client.getCommunityState(COMMUNITY);
  assert.equal(partial.linkedGroupsComplete, false);
  assert.deepEqual(
    partial.linkedGroups.map(g => g.groupId),
    [LINKED]
  );
  assert.equal(partial.capabilities.isAdmin, false);
});

test('create: the new community; a null answer is found by reading back, never created twice', async () => {
  useAccount('personal');
  const state = provider();
  const { client } = makeClient(state);
  const created = await client.createCommunity('  Liga  ', 'Torneos', { actor: 'dani' });
  assert.equal(created.communityId, OTHER_COMMUNITY);
  assert.equal(created.community.subject, 'Liga');
  assert.equal(created.community.capabilities.isSuperAdmin, true);
  assert.deepEqual(state.writes, ['create:Liga:Torneos']);

  const lost = provider();
  lost.createAnswer = 'null';
  const second = makeClient(lost).client;
  assert.equal((await second.createCommunity('Liga', undefined)).communityId, OTHER_COMMUNITY);
  assert.deepEqual(lost.writes, ['create:Liga:']);

  const nowhere = provider();
  nowhere.createAnswer = 'null';
  nowhere.ignore.add('create');
  const third = makeClient(nowhere).client;
  await assert.rejects(third.createCommunity('Liga', ''), fails(409, 'change_not_confirmed'));
  assert.deepEqual(nowhere.writes, ['create:Liga:']);

  const refused = provider();
  refused.fail.create = boom(400, 'bad-request');
  await assert.rejects(
    makeClient(refused).client.createCommunity('Liga', ''),
    fails(422, 'rejected_by_whatsapp')
  );
  for (const bad of ['', 'x'.repeat(101)]) {
    await assert.rejects(makeClient(provider()).client.createCommunity(bad, ''), fails(400, 'invalid_request'));
  }
});

test('link: community admin and group admin, ordinary group, read back; already linked sends nothing', async () => {
  useAccount('personal');
  const state = provider();
  const { client } = makeClient(state);
  const linked = await client.updateCommunityGroup(COMMUNITY, PLAIN, 'link', { actor: 'dani' });
  assert.equal(linked.changed, true);
  assert.equal(linked.confirmed, true);
  assert.ok(linked.community?.linkedGroups.some(g => g.groupId === PLAIN));
  assert.deepEqual(state.writes, [`link:${PLAIN}:${COMMUNITY}`]);
  const again = await client.updateCommunityGroup(COMMUNITY, PLAIN, 'link');
  assert.equal(again.changed, false);
  assert.equal(state.writes.length, 1);

  // Refusals before anything is sent.
  const cases: Array<[(s: Provider) => void, string, number, string]> = [
    [s => (s.groups.get(COMMUNITY).participants[0].admin = null), PLAIN, 403, 'not_community_admin'],
    [s => (s.groups.get(PLAIN).participants[0].admin = null), PLAIN, 403, 'not_group_admin'],
    [s => (s.groups.get(PLAIN).participants = []), PLAIN, 403, 'not_group_member'],
    [() => {}, ANNOUNCE, 422, 'not_linkable_group'],
    [s => (s.groups.get(PLAIN).linkedParent = OTHER_COMMUNITY), PLAIN, 409, 'linked_elsewhere'],
  ];
  for (const [setup, target, status, failureClass] of cases) {
    const fresh = provider();
    setup(fresh);
    await assert.rejects(
      makeClient(fresh).client.updateCommunityGroup(COMMUNITY, target, 'link'),
      fails(status, failureClass)
    );
    assert.deepEqual(fresh.writes, [], failureClass);
  }
});

test('link: WhatsApp 403 → not_community_admin; a lost answer that landed is success; one that did not → 409', async () => {
  useAccount('personal');
  const refused = provider();
  refused.fail.link = boom(403);
  await assert.rejects(
    makeClient(refused).client.updateCommunityGroup(COMMUNITY, PLAIN, 'link'),
    fails(403, 'not_community_admin')
  );

  const landed = provider();
  landed.fail.link = new Error('Timed Out');
  const ok = await makeClient(landed).client.updateCommunityGroup(COMMUNITY, PLAIN, 'link');
  assert.equal(ok.changed, true);

  const ignored = provider();
  ignored.ignore.add('link');
  await assert.rejects(
    makeClient(ignored).client.updateCommunityGroup(COMMUNITY, PLAIN, 'link'),
    fails(409, 'change_not_confirmed', /read it again/)
  );
  assert.equal(ignored.writes.length, 1, 'never retried');
});

test('unlink: by the group or, outside it, by the community list; never the announcement group', async () => {
  useAccount('personal');
  const state = provider();
  const { client } = makeClient(state);
  const done = await client.updateCommunityGroup(COMMUNITY, LINKED, 'unlink');
  assert.equal(done.changed, true);
  assert.equal(state.groups.get(LINKED).linkedParent, undefined);
  // A group we are not in: the <sub_groups> list proves before and after.
  const outside = await client.updateCommunityGroup(COMMUNITY, NOT_JOINED, 'unlink');
  assert.equal(outside.changed, true);
  assert.ok(!state.subGroups.get(COMMUNITY)!.some(entry => entry.id === NOT_JOINED));
  const noop = await client.updateCommunityGroup(COMMUNITY, NOT_JOINED, 'unlink');
  assert.equal(noop.changed, false);
  assert.deepEqual(state.writes, [
    `unlink:${LINKED}:${COMMUNITY}`,
    `unlink:${NOT_JOINED}:${COMMUNITY}`,
  ]);
  await assert.rejects(
    client.updateCommunityGroup(COMMUNITY, ANNOUNCE, 'unlink'),
    fails(422, 'announcement_group')
  );
  // Neither the group nor the list readable: nothing is sent.
  const blind = provider();
  blind.fail.subgroups = new Error('timeout');
  await assert.rejects(
    makeClient(blind).client.updateCommunityGroup(COMMUNITY, NOT_JOINED, 'unlink'),
    fails(502, 'provider_invalid_response')
  );
  assert.deepEqual(blind.writes, []);
});

test('leave: members only, proven by the participating groups; an ignored leave → 409', async () => {
  useAccount('personal');
  const state = provider();
  const { client } = makeClient(state);
  assert.deepEqual(await client.leaveCommunity(COMMUNITY, { actor: 'dani' }), {
    communityId: COMMUNITY,
    changed: true,
    confirmed: true,
  });
  assert.deepEqual(state.writes, [`leave:${COMMUNITY}`]);
  await assert.rejects(client.leaveCommunity(COMMUNITY), fails(403, 'not_community_member'));
  assert.equal(state.writes.length, 1);

  const ignored = provider();
  ignored.ignore.add('leave');
  await assert.rejects(
    makeClient(ignored).client.leaveCommunity(COMMUNITY),
    fails(409, 'change_not_confirmed')
  );
});

test('a community in the group routes stays 422 community_unsupported, pointing to the community routes', async () => {
  useAccount('personal');
  const state = provider();
  const { client } = makeClient(state);
  await assert.rejects(
    client.updateGroup(COMMUNITY, { subject: 'Otra' }),
    fails(422, 'community_unsupported', /\/communities\/groups/)
  );
});

test('offline: every community and channel call refuses before touching WhatsApp', async () => {
  useAccount('personal');
  const state = provider();
  const { client, calls } = makeClient(state);
  (client as any).ready = false;
  for (const call of [
    () => client.listCommunities(),
    () => client.getCommunityState(COMMUNITY),
    () => client.createCommunity('Liga', ''),
    () => client.updateCommunityGroup(COMMUNITY, PLAIN, 'link'),
    () => client.leaveCommunity(COMMUNITY),
    () => client.lookupChannel(CHANNEL),
    () => client.listChannels(),
    () => client.setChannelSubscription(CHANNEL, 'mute'),
  ]) {
    await assert.rejects(call(), /not connected/);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(state.writes, []);
});

// ---------------------------------------------------------------------------
// Channels through the client
// ---------------------------------------------------------------------------

test('lookup: by jid or invite; none → 404 channel_unavailable; a GraphQL refusal keeps its meaning', async () => {
  useAccount('personal');
  const state = provider();
  const { client, calls } = makeClient(state);
  assert.equal((await client.lookupChannel(CHANNEL)).role, 'subscriber');
  const byLink = await client.lookupChannel('https://whatsapp.com/channel/0029VaOtherXyz789');
  assert.equal(byLink.channelId, CHANNEL_2);
  assert.equal(byLink.following, false);
  assert.deepEqual(calls, [`newsletter:jid:${CHANNEL}`, 'newsletter:invite:0029VaOtherXyz789']);
  await assert.rejects(client.lookupChannel('0029VaNobody0000'), fails(404, 'channel_unavailable'));
  await assert.rejects(
    client.lookupChannel('120363499999999999@newsletter'),
    fails(404, 'channel_unavailable')
  );
  state.fail.newsletterMetadata = boom(404, 'GraphQL server error: not found');
  await assert.rejects(client.lookupChannel(CHANNEL), fails(404, 'channel_unavailable'));
  state.fail.newsletterMetadata = boom(400, 'GraphQL server error: bad key');
  await assert.rejects(client.lookupChannel(CHANNEL), fails(422, 'rejected_by_whatsapp'));
  // Not a refusal (Baileys could not read the answer): not dressed up as one.
  state.fail.newsletterMetadata = boom(400, 'Failed to newsletter, unexpected response structure.');
  await assert.rejects(client.lookupChannel(CHANNEL), (error: unknown) => {
    assert.ok(!(error instanceof MessageMutationError));
    return true;
  });
});

test('subscription: follow / unfollow / mute / unmute proven by the viewer metadata; equal state sends nothing', async () => {
  useAccount('personal');
  const state = provider();
  const { client } = makeClient(state);
  const followed = await client.setChannelSubscription(CHANNEL_2, 'follow', { actor: 'dani' });
  assert.equal(followed.changed, true);
  assert.equal(followed.channel.following, true);
  const muted = await client.setChannelSubscription(CHANNEL_2, 'mute');
  assert.equal(muted.channel.muted, true);
  assert.equal((await client.setChannelSubscription(CHANNEL_2, 'mute')).changed, false);
  assert.equal((await client.setChannelSubscription(CHANNEL_2, 'unmute')).channel.muted, false);
  assert.equal((await client.setChannelSubscription(CHANNEL_2, 'unfollow')).channel.following, false);
  assert.equal((await client.setChannelSubscription(CHANNEL_2, 'unfollow')).changed, false);
  assert.deepEqual(state.writes, [
    `follow:${CHANNEL_2}`,
    `mute:${CHANNEL_2}`,
    `unmute:${CHANNEL_2}`,
    `unfollow:${CHANNEL_2}`,
  ]);
  await assert.rejects(client.setChannelSubscription(CHANNEL_2, 'mute'), fails(422, 'not_following'));
  await assert.rejects(
    client.setChannelSubscription('120363499999999999@newsletter', 'follow'),
    fails(404, 'channel_unavailable')
  );
  assert.equal(state.writes.length, 4);
});

test('subscription: a lost answer that landed is success, one that did not → 409; refusals are 422', async () => {
  useAccount('personal');
  const landed = provider();
  landed.fail.follow = new Error('Timed Out');
  assert.equal(
    (await makeClient(landed).client.setChannelSubscription(CHANNEL_2, 'follow')).changed,
    true
  );
  const ignored = provider();
  ignored.ignore.add('follow');
  await assert.rejects(
    makeClient(ignored).client.setChannelSubscription(CHANNEL_2, 'follow'),
    fails(409, 'change_not_confirmed')
  );
  assert.equal(ignored.writes.length, 1);
  const refused = provider();
  refused.fail.follow = boom(400, 'GraphQL server error: not allowed');
  await assert.rejects(
    makeClient(refused).client.setChannelSubscription(CHANNEL_2, 'follow'),
    fails(422, 'rejected_by_whatsapp')
  );
});

test('subscription: two concurrent follows of one channel write once', async () => {
  useAccount('personal');
  const state = provider();
  const { client } = makeClient(state);
  const [a, b] = await Promise.all([
    client.setChannelSubscription(CHANNEL_2, 'follow'),
    client.setChannelSubscription(CHANNEL_2, 'follow'),
  ]);
  assert.deepEqual([a.changed, b.changed].sort(), [false, true]);
  assert.deepEqual(state.writes, [`follow:${CHANNEL_2}`]);
});

test('followed list: known chats, ingested channel conversations and this process, each confirmed', async () => {
  useAccount('professional');
  const state = provider();
  state.channels.set('120363400000000003@newsletter', {
    role: 'OWNER',
    mute: 'ON',
    invite: '0029VaMineQrs456',
    name: 'Mío',
  });
  const { calls: db, restore } = stubPool(sql =>
    /FROM conversations/.test(sql)
      ? [
          { jid: `professional:${CHANNEL}` },
          { jid: '120363400000000003@newsletter' },
          { jid: 'not-a-channel@g.us' },
        ]
      : []
  );
  try {
    const { client } = makeClient(state);
    (client as any).chatStore.set(CHANNEL_2, {
      id: CHANNEL_2,
      rawJid: CHANNEL_2,
      name: 'Otro',
      isGroup: false,
      unreadCount: 0,
      timestamp: 0,
    });
    (client as any).chatStore.set('120363499999999999@newsletter', {
      id: '120363499999999999@newsletter',
      rawJid: '120363499999999999@newsletter',
      name: 'Gone',
      isGroup: false,
      unreadCount: 0,
      timestamp: 0,
    });
    const result = await client.listChannels();
    assert.deepEqual(
      result.channels.map(c => [c.channelId, c.role]),
      [
        [CHANNEL, 'subscriber'],
        ['120363400000000003@newsletter', 'owner'],
      ]
    );
    assert.deepEqual(result.coverage, {
      complete: false,
      source: 'known-channels',
      candidates: 4,
      checked: 4,
      unreadable: 1,
    });
    assert.deepEqual(db[0].params, ['whatsapp:professional', 100]);
    assert.equal(db.filter(call => isWrite(call.sql)).length, 0);
  } finally {
    restore();
  }
  // A pairing-only client (ingest off) never touches the DB; a follow of this
  // process is remembered.
  const pairing = stubPool();
  try {
    const { client } = makeClient(provider(), { ingest: false });
    await client.setChannelSubscription(CHANNEL_2, 'follow');
    const result = await client.listChannels();
    assert.deepEqual(
      result.channels.map(c => c.channelId),
      [CHANNEL_2]
    );
    assert.equal(pairing.calls.length, 0);
  } finally {
    pairing.restore();
  }
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type Call = (method: string, path: string, body?: unknown) => Promise<globalThis.Response>;

async function withRouter(
  client: Partial<BaileysClient>,
  env: Record<string, string | undefined>,
  run: (call: Call, port: number) => Promise<void>
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
  const call: Call = (method, path, body) => {
    const ts = Math.floor(Date.now() / 1000);
    return fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-connector-timestamp': String(ts),
        'x-connector-signature': generateHMACSignature(body ?? {}, ts, secret),
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
    await run(call, port);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise(resolve => server.close(resolve));
  }
}

function recordingClient(connected = true): { client: Partial<BaileysClient>; seen: unknown[] } {
  const seen: unknown[] = [];
  const community = { communityId: COMMUNITY, subject: 'Club' };
  const channel = { channelId: CHANNEL, name: 'Club', following: true };
  const client = {
    isConnected: () => connected,
    getCachedState: () => (connected ? 'CONNECTED' : 'CLOSED:428'),
    listCommunities: async () => {
      seen.push('list');
      return { communities: [community] } as never;
    },
    getCommunityState: async (id: unknown) => {
      seen.push({ state: id });
      return community as never;
    },
    createCommunity: async (subject: unknown, description: unknown, options?: unknown) => {
      seen.push({ create: [subject, description, options] });
      return { communityId: OTHER_COMMUNITY, community } as never;
    },
    updateCommunityGroup: async (id: unknown, groupId: unknown, action: unknown, options?: unknown) => {
      seen.push({ groups: [id, groupId, action, options] });
      return { action, communityId: id, groupId, changed: true, confirmed: true, community } as never;
    },
    leaveCommunity: async (id: unknown, options?: unknown) => {
      seen.push({ leave: [id, options] });
      return { communityId: id, changed: true, confirmed: true } as never;
    },
    lookupChannel: async (query: unknown) => {
      seen.push({ lookup: query });
      return channel as never;
    },
    listChannels: async () => {
      seen.push('channels');
      return { channels: [channel], coverage: { complete: false } } as never;
    },
    setChannelSubscription: async (id: unknown, action: unknown, options?: unknown) => {
      seen.push({ subscription: [id, action, options] });
      return { action, channelId: id, changed: true, confirmed: true, channel } as never;
    },
  };
  return { client: client as unknown as Partial<BaileysClient>, seen };
}

const ON = { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: undefined };

const WRITES: Array<[string, Record<string, unknown>]> = [
  ['/communities/create', { subject: 'Liga' }],
  ['/communities/groups', { communityId: COMMUNITY, groupId: PLAIN, action: 'link' }],
  ['/communities/leave', { communityId: COMMUNITY, confirm: true }],
  ['/channels/subscription', { channelId: CHANNEL, action: 'follow' }],
];

const BAD_WRITES: Array<[string, Record<string, unknown>]> = [
  ['/communities/create', { subject: '' }],
  ['/communities/groups', { communityId: COMMUNITY, groupId: CHANNEL, action: 'link' }],
  ['/communities/groups', { communityId: COMMUNITY, groupId: PLAIN, action: 'leave' }],
  ['/communities/leave', { communityId: COMMUNITY }],
  ['/communities/leave', { communityId: '34600111222@c.us', confirm: true }],
  ['/channels/subscription', { channelId: COMMUNITY, action: 'follow' }],
  ['/channels/subscription', { channelId: CHANNEL, action: 'join' }],
];

test('HTTP: 400s first, then the sending gate on the four writes; reads are not gated', async () => {
  const { client, seen } = recordingClient();
  for (const env of [
    { ENABLE_SENDING: 'false', EMERGENCY_DISABLE_SENDING: undefined },
    { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: 'true' },
  ]) {
    await withRouter(client, env, async call => {
      for (const [path, body] of BAD_WRITES) {
        const res = await call('POST', path, body);
        assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`);
        assert.equal(((await res.json()) as { failureClass: string }).failureClass, 'invalid_request');
      }
      for (const [path, body] of WRITES) {
        const res = await call('POST', path, body);
        assert.equal(res.status, 403, path);
        assert.equal(((await res.json()) as { failureClass: string }).failureClass, 'disabled_sending');
      }
      for (const body of [{ communityId: CHANNEL }, {}]) {
        assert.equal((await call('POST', '/communities/state', body)).status, 400);
      }
      assert.equal((await call('POST', '/channels/lookup', { channel: 'hola que tal' })).status, 400);
      assert.equal((await call('GET', '/communities')).status, 200);
      assert.equal((await call('POST', '/communities/state', { communityId: COMMUNITY })).status, 200);
      assert.equal((await call('POST', '/channels/lookup', { channel: CHANNEL })).status, 200);
      assert.equal((await call('GET', '/channels')).status, 200);
    });
  }
  // Only the reads reached the client.
  const writes = seen.filter(
    entry =>
      entry !== 'list' &&
      entry !== 'channels' &&
      !('state' in (entry as object)) &&
      !('lookup' in (entry as object))
  );
  assert.deepEqual(writes, []);
});

test('HTTP: answers with the actor recorded; 503 offline; unsigned 401', async () => {
  useAccount('professional');
  const { client, seen } = recordingClient();
  await withRouter(client, ON, async (call, port) => {
    const list = await call('GET', '/communities');
    assert.deepEqual(await list.json(), {
      communities: [{ communityId: COMMUNITY, subject: 'Club' }],
      count: 1,
    });
    const created = await call('POST', '/communities/create', {
      subject: ' Liga ',
      description: 'Torneos',
      actor: 'dani',
    });
    assert.deepEqual(await created.json(), {
      created: true,
      communityId: OTHER_COMMUNITY,
      community: { communityId: COMMUNITY, subject: 'Club' },
    });
    const groups = await call('POST', '/communities/groups', {
      communityId: `professional:${COMMUNITY}`,
      groupId: PLAIN,
      action: 'unlink',
    });
    assert.equal(groups.status, 200);
    assert.equal(((await groups.json()) as { updated: boolean }).updated, true);
    const left = await call('POST', '/communities/leave', { communityId: COMMUNITY, confirm: true });
    assert.deepEqual(await left.json(), {
      left: true,
      communityId: COMMUNITY,
      changed: true,
      confirmed: true,
    });
    const channels = await call('GET', '/channels');
    assert.deepEqual(await channels.json(), {
      channels: [{ channelId: CHANNEL, name: 'Club', following: true }],
      count: 1,
      coverage: { complete: false },
    });
    const followed = await call('POST', '/channels/subscription', {
      channelId: CHANNEL,
      action: 'mute',
      actor: 'dani',
    });
    assert.equal(((await followed.json()) as { updated: boolean }).updated, true);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/communities`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/channels`)).status, 401);
  });
  assert.deepEqual(seen, [
    'list',
    { create: ['Liga', 'Torneos', { actor: 'dani' }] },
    { groups: [COMMUNITY, PLAIN, 'unlink', { actor: undefined }] },
    { leave: [COMMUNITY, { actor: undefined }] },
    'channels',
    { subscription: [CHANNEL, 'mute', { actor: 'dani' }] },
  ]);
  const offline = recordingClient(false);
  await withRouter(offline.client, ON, async call => {
    for (const [path, body] of WRITES) assert.equal((await call('POST', path, body)).status, 503);
    assert.equal((await call('GET', '/communities')).status, 503);
    assert.equal((await call('GET', '/channels')).status, 503);
    assert.equal((await call('POST', '/channels/lookup', { channel: CHANNEL })).status, 503);
  });
  assert.deepEqual(offline.seen, []);
});

test('HTTP: client errors keep their status, failureClass and details', async () => {
  for (const [error, status, failureClass, extra] of [
    [new CommunityActionError('x', 409, 'linked_elsewhere', { details: { linkedTo: OTHER_COMMUNITY } }), 409, 'linked_elsewhere', { linkedTo: OTHER_COMMUNITY }],
    [new MessageMutationError('x', 409, 'change_not_confirmed'), 409, 'change_not_confirmed', {}],
    [new CommunityActionError('x', 422, 'not_a_community'), 422, 'not_a_community', {}],
  ] as const) {
    const client = {
      ...recordingClient().client,
      updateCommunityGroup: async () => {
        throw error;
      },
    };
    await withRouter(client, ON, async call => {
      const res = await call('POST', '/communities/groups', {
        communityId: COMMUNITY,
        groupId: PLAIN,
        action: 'link',
      });
      assert.equal(res.status, status);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.failureClass, failureClass);
      for (const [name, value] of Object.entries(extra)) assert.equal(body[name], value);
    });
  }
});
