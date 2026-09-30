/**
 * Privacy tokens and profile pictures (fase 3 / PR-10).
 *
 * The patched Baileys (patches/@whiskeysockets__baileys@7.0.0-rc13.patch):
 * the profile-picture iq nests a timestamped <tctoken> inside <picture>; the
 * NCT salt (app-state `nct_salt_sync` = SyncActionValue field 80,
 * HistorySync field 19) is decoded into creds.nctSalt; with no tctoken a 1:1
 * send carries <cstoken> = HMAC-SHA256(salt, recipientLid) (WA Web
 * genCsTokenBody, whatsmeow cstoken.go).
 *
 * The connector: the direct-send preflight lets a first message through when
 * a cstoken can be attached and still refuses (account_restricted) when it
 * cannot; a session without salt re-snapshots regular_high once; a hung
 * profile-picture lookup is a 504, not a "no photo".
 *
 * No socket and no DB: fake sock / fake key store, stubbed fetch.
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { Boom } from '@hapi/boom';
import {
  BaileysClient,
  canAttachCsToken,
  ProfilePictureDownloadError,
  ProfilePictureTimeoutError,
  WhatsAppSendError,
} from './baileys-client';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';

const BAILEYS = '@whiskeysockets/baileys/lib';
const SALT = Buffer.alloc(32, 0xab);
const LID = '68642335125543@lid';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function newClient(): Any {
  return new BaileysClient('/tmp/unused-session', 'k'.repeat(16)) as Any;
}

/** In-memory Baileys key store (get/set by type → id → value, null deletes). */
function keyStore(initial: Record<string, Record<string, unknown>> = {}) {
  const data: Record<string, Record<string, unknown>> = JSON.parse(JSON.stringify(initial));
  const sets: Array<Record<string, Record<string, unknown>>> = [];
  return {
    data,
    sets,
    get: async (type: string, ids: string[]) => {
      const out: Record<string, unknown> = {};
      for (const id of ids) if (data[type]?.[id] !== undefined) out[id] = data[type][id];
      return out;
    },
    set: async (update: Record<string, Record<string, unknown>>) => {
      sets.push(update);
      for (const [type, entries] of Object.entries(update)) {
        data[type] ??= {};
        for (const [id, value] of Object.entries(entries)) {
          if (value === null) delete data[type][id];
          else data[type][id] = value;
        }
      }
    },
  };
}

/** Fake sock for the direct-send preflight: WhatsApp answers the token iq with no token. */
function preflightSock(creds: Record<string, unknown>, lidForPn: string | null) {
  const calls = { issued: [] as string[], sent: [] as string[] };
  const sock = {
    ev: { on: () => {}, emit: () => {} },
    user: { id: '34600111222:5@s.whatsapp.net' },
    authState: { creds, keys: keyStore() },
    serverProps: { privacyTokenOn1to1: true, lidTrustedTokenIssueToLid: false },
    signalRepository: {
      lidMapping: { getLIDForPN: async () => lidForPn, getPNForLID: async () => null },
    },
    onWhatsApp: async (jid: string) => [{ jid, exists: true }],
    getUSyncDevices: async () => [],
    issuePrivacyTokens: async (jids: string[]) => {
      calls.issued.push(...jids);
      return { tag: 'iq', attrs: {}, content: [] };
    },
    sendMessage: async (jid: string) => {
      calls.sent.push(jid);
      return { key: { id: 'M1', remoteJid: jid, fromMe: true }, message: {} };
    },
  };
  return { sock, calls };
}

function connected(client: Any, sock: unknown): void {
  client.sock = sock;
  client.ready = true;
  client.lastState = 'CONNECTED';
  client.isConnected = () => true;
  client.waitForImmediateSendFailure = async () => undefined;
  client.persistDurablePayload = async () => {};
}

// ---------------------------------------------------------------------------
// The patch lands in the installed Baileys
// ---------------------------------------------------------------------------

test('patched Baileys nests the timestamped tctoken inside the picture query', async () => {
  const { buildProfilePictureQueryContent } = await import(`${BAILEYS}/Socket/chats.js`);
  const { buildTcTokenFromJid } = await import(`${BAILEYS}/Utils/tc-token-utils.js`);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const jid = '34600@s.whatsapp.net';
  const token = Buffer.from([4, 1, 33]);
  const tcTokenContent = await buildTcTokenFromJid({
    jid,
    getLIDForPN: async () => null,
    authState: { keys: { get: async () => ({ [jid]: { token, timestamp } }) } },
  });
  assert.deepEqual(buildProfilePictureQueryContent('image', tcTokenContent), [
    {
      tag: 'picture',
      attrs: { type: 'image', query: 'url' },
      content: [{ tag: 'tctoken', attrs: { t: timestamp }, content: token }],
    },
  ]);
  assert.deepEqual(buildProfilePictureQueryContent('preview'), [
    { tag: 'picture', attrs: { type: 'preview', query: 'url' } },
  ]);
  // A token without a timestamp is unusable: no <tctoken> at all.
  assert.equal(
    await buildTcTokenFromJid({
      jid,
      getLIDForPN: async () => null,
      authState: { keys: { get: async () => ({ [jid]: { token } }), set: async () => {} } },
    }),
    undefined
  );
});

test('patched WAProto decodes the NCT salt from app-state (field 80) and history sync (field 19)', async () => {
  const { proto } = await import('@whiskeysockets/baileys');
  // Hand-encoded protobuf: tag varints, then length-delimited payloads.
  const bytesField = (tag: number[], payload: Buffer) => Buffer.concat([Buffer.from([...tag, payload.length]), payload]);
  const inner = bytesField([0x0a], SALT); // salt = 1
  const action = Buffer.concat([
    Buffer.from([0x08, 0x01]), // timestamp = 1
    bytesField([0x82, 0x05], inner), // nctSaltSyncAction = 80
  ]);
  const decoded = proto.SyncActionValue.decode(action) as Any;
  assert.equal(Number(decoded.timestamp), 1);
  assert.deepEqual(Buffer.from(decoded.nctSaltSyncAction.salt), SALT);

  const history = Buffer.concat([
    Buffer.from([0x08, proto.HistorySync.HistorySyncType.PUSH_NAME]), // syncType = 1
    bytesField([0x9a, 0x01], SALT), // nctSalt = 19
  ]);
  assert.deepEqual(Buffer.from((proto.HistorySync.decode(history) as Any).nctSalt), SALT);
});

test('patched processSyncAction stores the salt in creds; computeCsToken is HMAC-SHA256(salt, lid)', async () => {
  const { processSyncAction } = await import(`${BAILEYS}/Utils/chat-utils.js`);
  const { computeCsToken } = await import(`${BAILEYS}/Utils/tc-token-utils.js`);
  const emitted: Array<[string, Any]> = [];
  processSyncAction(
    { syncAction: { value: { nctSaltSyncAction: { salt: SALT } } }, index: ['nct_salt_sync'] },
    { emit: (name: string, value: unknown) => emitted.push([name, value]) },
    { id: '34600111222@s.whatsapp.net' }
  );
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], 'creds.update');
  assert.deepEqual(Buffer.from(emitted[0][1].nctSalt), SALT);

  const expected = createHmac('sha256', SALT).update(LID, 'utf8').digest();
  assert.deepEqual(Buffer.from(computeCsToken(SALT, LID)), expected);
  assert.notDeepEqual(Buffer.from(computeCsToken(SALT, '1@lid')), expected);
});

test('patched relayMessage attaches <cstoken> only as the no-tctoken fallback', async () => {
  // relayMessage needs a live Signal session to reach the stanza; the branch
  // itself is checked on the installed source so a lost patch fails here.
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    `${process.cwd()}/node_modules/@whiskeysockets/baileys/lib/Socket/messages-send.js`,
    'utf8'
  );
  const tc = source.indexOf("tag: 'tctoken',\n                    attrs: {},\n                    content: tcTokenBuffer");
  const cs = source.indexOf("tag: 'cstoken'");
  assert.ok(tc > 0 && cs > tc, 'cstoken branch after the tctoken one');
  assert.match(
    source.slice(tc, cs),
    /else if \(is1on1Send && authState\.creds\.me\?\.lid && authState\.creds\.nctSalt\?\.length && tcTokenJid && isLidUser\(tcTokenJid\)\)/
  );
});

test('the next pairing keeps the NCT salt of its INITIAL_BOOTSTRAP history sync', async () => {
  const { proto, DEFAULT_CONNECTION_CONFIG } = await import('@whiskeysockets/baileys');
  const { default: processMessage } = await import(`${BAILEYS}/Utils/process-message.js`);
  const { deflateSync } = await import('node:zlib');
  const { readFile } = await import('node:fs/promises');
  const T = proto.HistorySync.HistorySyncType;

  // The connector leaves shouldSyncHistoryMessage to Baileys: WA_HISTORY_SYNC_ON_LOGIN
  // only decides what the DB ingests, never which history blobs Baileys decodes.
  const source = await readFile(`${process.cwd()}/src/baileys-client.ts`, 'utf8');
  const socketOptions = source.slice(source.indexOf('makeWASocket({'), source.indexOf('this.bindSocketEvents(saveCreds)'));
  assert.ok(socketOptions.length > 0);
  assert.doesNotMatch(socketOptions, /shouldSyncHistoryMessage/);
  for (const syncType of [T.INITIAL_BOOTSTRAP, T.NON_BLOCKING_DATA, T.RECENT, T.PUSH_NAME, T.ON_DEMAND]) {
    assert.equal(DEFAULT_CONNECTION_CONFIG.shouldSyncHistoryMessage({ syncType } as Any), true, `syncType ${syncType}`);
  }

  // What the phone sends at pairing: HistorySync { syncType = 0, nctSalt = 19 }, inline and deflated.
  const blob = Buffer.concat([Buffer.from([0x08, T.INITIAL_BOOTSTRAP]), Buffer.from([0x9a, 0x01, SALT.length]), SALT]);
  const emitted: Array<[string, Any]> = [];
  await processMessage(
    {
      key: { remoteJid: '34600111222@s.whatsapp.net', fromMe: true, id: 'HIST1' },
      message: {
        protocolMessage: {
          type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
          historySyncNotification: { syncType: T.INITIAL_BOOTSTRAP, initialHistBootstrapInlinePayload: deflateSync(blob) },
        },
      },
    },
    {
      shouldProcessHistoryMsg: true,
      ev: { emit: (name: string, value: unknown) => emitted.push([name, value]) },
      creds: { me: { id: '34600111222:5@s.whatsapp.net', lid: '900:5@lid' }, processedHistoryMessages: [] },
      signalRepository: { lidMapping: { storeLIDPNMappings: async () => {}, getLIDForPN: async () => null } },
      keyStore: keyStore(),
      options: {},
      getMessage: async () => undefined,
    }
  );
  const salt = emitted.find(([name, value]) => name === 'creds.update' && value.nctSalt);
  assert.ok(salt, 'creds.update carries the salt');
  assert.deepEqual(Buffer.from(salt[1].nctSalt), SALT);
  const history = emitted.find(([name]) => name === 'messaging-history.set');
  assert.equal(history?.[1].syncType, T.INITIAL_BOOTSTRAP);
  assert.deepEqual(Buffer.from(history?.[1].nctSalt), SALT);
});

test('the connector logs the NCT salt when it arrives (the Baileys logger runs at warn)', async () => {
  const client = newClient();
  const handlers: Record<string, (u: Any) => unknown> = {};
  const infos: string[] = [];
  client.sock = { ev: { on: (e: string, fn: (u: Any) => unknown) => (handlers[e] = fn), emit: () => {} } };
  client.logger = { info: (m: string) => infos.push(m), warn() {}, error() {}, debug() {} };
  client.ingest = true;
  client.bindSocketEvents(async () => {});

  handlers['creds.update']({ accountSyncCounter: 2 });
  assert.equal(infos.filter(m => /NCT salt/.test(m)).length, 0);
  handlers['creds.update']({ nctSalt: SALT });
  assert.ok(infos.some(m => /NCT salt stored in creds/.test(m)));

  // History outside the ingest window is not ingested, but its salt is still reported.
  await handlers['messaging-history.set']({ chats: [], contacts: [], messages: [], syncType: 0, nctSalt: SALT });
  assert.ok(infos.some(m => m === 'NCT salt received in history sync (syncType=0)'));
  assert.equal(infos.filter(m => /history\.set received/.test(m)).length, 0);
});

// ---------------------------------------------------------------------------
// Direct-send preflight
// ---------------------------------------------------------------------------

test('canAttachCsToken: own LID, a salt and a LID recipient', () => {
  const creds = { me: { lid: '900:5@lid' }, nctSalt: SALT };
  assert.equal(canAttachCsToken(creds, LID), true);
  assert.equal(canAttachCsToken(creds, '34677431173@s.whatsapp.net'), false);
  assert.equal(canAttachCsToken({ me: { lid: '900:5@lid' } }, LID), false);
  assert.equal(canAttachCsToken({ me: {}, nctSalt: SALT }, LID), false);
  assert.equal(canAttachCsToken({ me: { lid: '900:5@lid' }, nctSalt: Buffer.alloc(0) }, LID), false);
  assert.equal(canAttachCsToken(undefined, LID), false);
});

test('first message without tctoken goes out when a cstoken can be attached', async () => {
  const client = newClient();
  const { sock, calls } = preflightSock({ me: { id: '34600111222:5@s.whatsapp.net', lid: '900:5@lid' }, nctSalt: SALT }, null);
  connected(client, sock);
  const id = await client.sendMessage(LID, 'hola');
  assert.equal(id, 'M1');
  assert.deepEqual(calls.issued, [LID]);
  assert.deepEqual(calls.sent, [LID]);
});

test('first message without tctoken and without salt is still refused before reaching WhatsApp', async () => {
  const client = newClient();
  const { sock, calls } = preflightSock({ me: { id: '34600111222:5@s.whatsapp.net', lid: '900:5@lid' } }, null);
  connected(client, sock);
  await assert.rejects(
    client.sendMessage(LID, 'hola'),
    (e: unknown) =>
      e instanceof WhatsAppSendError &&
      e.details.failureClass === 'account_restricted' &&
      e.cause instanceof WhatsAppSendError &&
      /no NCT salt/.test(e.cause.details.causeMessage || '')
  );
  assert.deepEqual(calls.sent, []);
});

test('a phone recipient with no LID mapping cannot carry a cstoken: refused', async () => {
  const client = newClient();
  const { sock, calls } = preflightSock({ me: { id: '34600111222:5@s.whatsapp.net', lid: '900:5@lid' }, nctSalt: SALT }, null);
  connected(client, sock);
  await assert.rejects(
    client.sendMessage('34677431173@c.us', 'hola'),
    (e: unknown) => e instanceof WhatsAppSendError && e.details.failureClass === 'account_restricted'
  );
  assert.deepEqual(calls.sent, []);
});

// ---------------------------------------------------------------------------
// NCT salt bootstrap
// ---------------------------------------------------------------------------

test('a session without salt re-snapshots regular_high once; with salt or the marker it does not', async () => {
  const run = async (creds: Record<string, unknown>) => {
    const client = newClient();
    const keys = keyStore({ 'app-state-sync-version': { regular_high: { version: 2 } } });
    const resyncs: Array<[string[], boolean]> = [];
    const sock = {
      authState: { creds, keys },
      ev: { emit: (name: string, update: Record<string, unknown>) => name === 'creds.update' && Object.assign(creds, update) },
      resyncAppState: async (collections: string[], initial: boolean) => {
        resyncs.push([collections, initial]);
      },
    };
    client.sock = sock;
    client.ingest = true;
    const result = await client.resyncChatState('connection-open');
    return { result, keys, resyncs };
  };

  const fresh = await run({ me: { lid: '900:5@lid' } });
  assert.deepEqual(fresh.result, { ok: true });
  assert.equal(fresh.keys.data['app-state-sync-version'].regular_high, undefined);
  assert.equal(fresh.resyncs[0][0].includes('regular_high'), true);

  const marked = await run({ me: { lid: '900:5@lid' }, nctSaltBootstrapAt: 1 });
  assert.deepEqual(marked.keys.data['app-state-sync-version'].regular_high, { version: 2 });
  assert.equal(marked.keys.sets.length, 0);

  const salted = await run({ me: { lid: '900:5@lid' }, nctSalt: SALT });
  assert.equal(salted.keys.sets.length, 0);

  const noLid = await run({ me: { id: '34600111222:5@s.whatsapp.net' } });
  assert.equal(noLid.keys.sets.length, 0);

  // Once is once: the marker set by the first run stops the second.
  const creds: Record<string, unknown> = { me: { lid: '900:5@lid' } };
  await run(creds);
  assert.equal(typeof creds.nctSaltBootstrapAt, 'number');
  const again = await run(creds);
  assert.equal(again.keys.sets.length, 0);

  // A manual resync never resets state.
  const client = newClient();
  const keys = keyStore({ 'app-state-sync-version': { regular_high: { version: 2 } } });
  client.sock = { authState: { creds: {}, keys }, ev: { emit: () => {} }, resyncAppState: async () => {} };
  await client.resyncChatState('manual');
  assert.equal(keys.sets.length, 0);
});

// ---------------------------------------------------------------------------
// Profile pictures
// ---------------------------------------------------------------------------

test('profile picture provider timeout stays distinct from private or missing photos', async () => {
  const client = newClient();
  const calls: number[] = [];
  client.sock = {
    profilePictureUrl: async (_jid: string, _type: string, timeout: number) => {
      calls.push(timeout);
      throw new Boom('provider timeout', { statusCode: 408 });
    },
  };
  await assert.rejects(client.getProfilePictureBytes('34600@c.us'), ProfilePictureTimeoutError);
  assert.deepEqual(calls, [8000]);
  client.sock.profilePictureUrl = async () => {
    throw new Boom('private', { statusCode: 403 });
  };
  assert.equal(await client.getProfilePictureBytes('34600@c.us'), null);
  client.sock.profilePictureUrl = async () => {
    throw new Boom('item-not-found', { statusCode: 404 });
  };
  assert.equal(await client.getProfilePictureBytes('34600@c.us'), null);
});

test('profile picture lookup that never answers is cut at the deadline', async () => {
  const client = newClient();
  client.sock = { profilePictureUrl: () => new Promise(() => {}) };
  const started = Date.now();
  await assert.rejects(client.getProfilePictureBytes('34600@c.us'), ProfilePictureTimeoutError);
  assert.ok(Date.now() - started < 10_000);
});

test('profile picture download: off-CDN URL, >10 MB stream and network failure are download errors', async () => {
  const client = newClient();
  const originalFetch = globalThis.fetch;
  try {
    client.sock = { profilePictureUrl: async () => 'https://evil.example/photo' };
    await assert.rejects(client.getProfilePictureBytes('34600@c.us'), ProfilePictureDownloadError);

    client.sock = { profilePictureUrl: async () => 'https://mmg.whatsapp.net/photo' };
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1));
          },
        })
      )) as Any;
    await assert.rejects(client.getProfilePictureBytes('34600@c.us'), ProfilePictureDownloadError);

    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as Any;
    await assert.rejects(client.getProfilePictureBytes('34600@c.us'), ProfilePictureDownloadError);

    globalThis.fetch = (async () => new Response(new Uint8Array([0xff, 0xd8]))) as Any;
    assert.deepEqual(await client.getProfilePictureBytes('34600@c.us'), Buffer.from([0xff, 0xd8]));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GET /chats/:jid/photo: timeout 504, download failure 502, none 404', async () => {
  const secret = 'privacy-tokens-test-secret';
  let behaviour: () => Promise<Buffer | null> = async () => null;
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createRouter(
      { getProfilePictureBytes: async () => behaviour() } as Any,
      { getCurrentQR: () => null } as Any,
      secret
    )
  );
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async () => {
    const ts = Math.floor(Date.now() / 1000);
    return fetch(`${base}/api/v1/chats/34600%40c.us/photo`, {
      headers: {
        'x-connector-timestamp': String(ts),
        'x-connector-signature': generateHMACSignature({}, ts, secret),
      },
    });
  };
  try {
    assert.equal((await get()).status, 404);
    behaviour = async () => {
      throw new ProfilePictureTimeoutError();
    };
    assert.equal((await get()).status, 504);
    behaviour = async () => {
      throw new ProfilePictureDownloadError('WhatsApp profile picture exceeds 10 MB');
    };
    const bad = await get();
    assert.equal(bad.status, 502);
    assert.deepEqual(await bad.json(), { error: 'WhatsApp profile picture exceeds 10 MB' });
    behaviour = async () => Buffer.from([1, 2]);
    assert.deepEqual(await (await get()).json(), { data: 'AQI=', size: 2, contentType: 'image/jpeg' });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
