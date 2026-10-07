import test from 'node:test';
import assert from 'node:assert/strict';
import { canCommunityAction, createCommunityClient, providerGroupJid, resolveLinkedGroupChat } from '../public/communities-ui.mjs';

const community = { id: 'community@g.us', capabilities: { editInfo: true, manageGroups: false, leave: true } };

test('community actions respect provider capabilities before any request', async () => {
  const calls = [];
  const client = createCommunityClient({ api: (...args) => { calls.push(args); }, getAccount: () => 'personal' });
  assert.equal(canCommunityAction(community, 'subject'), true);
  assert.equal(canCommunityAction(community, 'link'), false);
  assert.equal(canCommunityAction({}, 'leave'), false);
  await assert.rejects(client.action(community, 'link', { groupJid: 'group@g.us' }), /permiso/);
  await assert.rejects(client.action(community, 'unlink', { groupJid: 'group@g.us' }), /permiso/);
  assert.deepEqual(calls, []);
});

test('account switch discards late list, detail and mutation acknowledgements', async () => {
  let account = 'personal';
  const waiting = [];
  const api = () => new Promise(resolve => waiting.push(resolve));
  const client = createCommunityClient({ api, getAccount: () => account });
  const list = client.list();
  const detail = client.detail(community.id);
  const action = client.action(community, 'subject', { subject: 'Renamed' });
  account = 'secondary';
  client.accountChanged();
  waiting[0]({ account: 'personal', communities: [community] });
  waiting[1]({ account: 'personal', community, linkedGroups: [] });
  waiting[2]({ account: 'personal', action: 'subject', communityId: community.id, confirmed: true });
  assert.deepEqual(await Promise.all([list, detail, action]), [null, null, null]);
});

test('provider failures and ambiguous acknowledgements never confirm a mutation', async () => {
  const payloads = [];
  const client = createCommunityClient({
    getAccount: () => 'personal',
    api: async (path, body) => { payloads.push({ path, body }); return { account: 'personal', action: 'subject', communityId: community.id, confirmed: false }; },
  });
  await assert.rejects(client.action(community, 'subject', { subject: 'New name' }), /no confirmó/);
  assert.deepEqual(payloads, [{ path: '/api/communities/community%40g.us/action', body: { account: 'personal', action: 'subject', subject: 'New name' } }]);
  const failing = createCommunityClient({ getAccount: () => 'personal', api: async () => { throw new Error('Proveedor no disponible'); } });
  await assert.rejects(failing.action(community, 'subject', { subject: 'New name' }), /Proveedor no disponible/);
  await assert.rejects(failing.create('New community', ''), /Proveedor no disponible/);
});

test('list and detail reject another account and create requires server confirmation', async () => {
  const listClient = createCommunityClient({ getAccount: () => 'personal', api: async () => ({ account: 'secondary', communities: [] }) });
  await assert.rejects(listClient.list(), /no válida/);
  const detailClient = createCommunityClient({ getAccount: () => 'personal', api: async () => ({ account: 'secondary', community, linkedGroups: [] }) });
  await assert.rejects(detailClient.detail(community.id), /no válido/);
  const createClient = createCommunityClient({ getAccount: () => 'personal', api: async () => ({ account: 'personal', community }) });
  await assert.rejects(createClient.create('Comunidad', ''), /no confirmó/);
});

test('secondary account links and opens groups with provider JID, retaining DB id for chat selection', async () => {
  const chat = { id: 'secondary:120363000000002@g.us', waChatId: '120363000000002@g.us', isGroup: true, name: 'Equipo' };
  const group = { id: '120363000000002@g.us', name: 'Equipo' };
  assert.equal(providerGroupJid(chat), group.id);
  assert.equal([chat].find(item => item.isGroup && providerGroupJid(item) === group.id), chat);
  assert.equal(providerGroupJid({ ...chat, waChatId: 'secondary:120363000000002@g.us' }), null);
  assert.equal(providerGroupJid({ id: group.id, isGroup: true }), group.id);
  const calls = [];
  const client = createCommunityClient({ getAccount: () => 'secondary', api: async (path, body) => {
    calls.push({ path, body });
    return { account: 'secondary', action: 'link', communityId: '120363000000001@g.us', confirmed: true };
  } });
  const editable = { id: '120363000000001@g.us', capabilities: { manageGroups: true } };
  await client.action(editable, 'link', { groupJid: providerGroupJid(chat) });
  assert.deepEqual(calls[0].body, { account: 'secondary', action: 'link', groupJid: group.id });
});

test('archived linked group outside loaded chats opens by account-scoped DB id from detail', async () => {
  const group = { id: '120363000000002@g.us', name: 'Equipo', chatId: 'secondary:120363000000002@g.us' };
  const detailClient = createCommunityClient({
    getAccount: () => 'secondary',
    api: async () => ({ account: 'secondary', community: { id: '120363000000001@g.us' }, linkedGroups: [group] }),
  });
  const detail = await detailClient.detail('120363000000001@g.us');
  assert.deepEqual(resolveLinkedGroupChat(detail.linkedGroups[0], []), {
    id: group.chatId, waChatId: group.id, name: group.name, isGroup: true,
  });
  const loaded = { id: 'secondary:db-row-id', waChatId: group.id, name: 'Equipo actualizado', isGroup: true };
  assert.equal(resolveLinkedGroupChat(group, [loaded]), loaded);
  assert.equal(resolveLinkedGroupChat({ ...group, chatId: null }, []), null);
  assert.equal(resolveLinkedGroupChat({ ...group, chatId: '  ' }, []), null);
});
