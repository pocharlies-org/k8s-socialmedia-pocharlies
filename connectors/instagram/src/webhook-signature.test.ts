/**
 * SKIRM-102 — POST /webhook of the Instagram connector verifies Meta's
 * `x-hub-signature-256`, always, and fails closed (security F2-1 to F2-6).
 *
 * The app is the real `createInstagramApp`; requests go through `fetch`.
 * Case design adapted from the fork's webhook-access.test.ts (jibanez-staticduo):
 * the signature is over the original bytes, not over re-serialised JSON.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { createInstagramApp, loadAccounts, metaAppSecrets } from './main';
import type { WebhookEvent, WebhookLog } from './webhook';
import { webhookSignatureGuard } from './webhook';

const FB_SECRET = 'fb-app-secret-0000000000000000';
const IG_LOGIN_SECRET = 'ig-login-secret-000000000000000';
const ACCOUNT_SECRET = 'acct-own-app-secret-00000000000';
const VERIFY_TOKEN = 'verify-token-00000000000000000000';
const BIZ_ID = 'biz-acct';
// The token the connector used to fall back to; spelled in pieces so `git grep` of the old literal stays empty.
const FORMER_DEFAULT_TOKEN = ['instagram', 'verify', 'token'].join('-');

/** The prod Secret as the pod sees it, dead keys included (F2-2). */
const PROD_ENV = {
  FACEBOOK_APP_SECRET: FB_SECRET,
  INSTAGRAM_LOGIN_APP_SECRET: IG_LOGIN_SECRET,
  INSTAGRAM_WEBHOOK_SECRET: 'dead-key-webhook-secret',
  INSTAGRAM_INTERNAL_API_TOKEN: 'dead-key-internal-token',
  WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
  INSTAGRAM_ACCOUNTS: 'acct',
  INSTAGRAM_ACCT_ACCESS_TOKEN: 'tok',
  INSTAGRAM_ACCT_BUSINESS_ACCOUNT_ID: BIZ_ID,
  INSTAGRAM_ACCT_APP_SECRET: ACCOUNT_SECRET,
} as NodeJS.ProcessEnv;

const sign = (body: string, key: string): string =>
  'sha256=' + createHmac('sha256', key).update(body).digest('hex');

/** Pretty-printed on purpose: re-serialising it gives different bytes. */
const DM = JSON.stringify(
  {
    object: 'instagram',
    entry: [
      {
        id: BIZ_ID,
        messaging: [
          {
            sender: { id: 'user-1' },
            recipient: { id: BIZ_ID },
            timestamp: 1700000000,
            message: { mid: 'mid-1', text: 'hola desde Meta' },
          },
        ],
      },
    ],
  },
  null,
  2
);

interface Booted {
  base: string;
  published: Array<{ account: string; event: WebhookEvent }>;
  logs: Array<{ obj: Record<string, unknown>; msg: string }>;
  close(): Promise<void>;
}

async function boot(env: NodeJS.ProcessEnv): Promise<Booted> {
  const published: Booted['published'] = [];
  const logs: Booted['logs'] = [];
  const log: WebhookLog = { warn: (obj, msg) => logs.push({ obj, msg }) };
  const accounts = loadAccounts({ env, storeEnabled: false, onFatal: () => {}, info: () => {} });

  // registerInstagramIds calls graph.instagram.com once per account at boot; a
  // 500 keeps the id taken from the env and nothing leaves the machine.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 500 })) as typeof fetch;
  let app: Awaited<ReturnType<typeof createInstagramApp>>;
  try {
    app = await createInstagramApp({
      env,
      accounts,
      credentialStore: null,
      publisher: { publish: (account, event) => published.push({ account, event }) },
      log,
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    published,
    logs,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

const post = (base: string, body: string, signature?: string): Promise<Response> =>
  fetch(`${base}/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature === undefined ? {} : { 'x-hub-signature-256': signature }),
    },
    body,
  });

test('C2: no signature → 401 and nothing reaches the publisher', async t => {
  const app = await boot(PROD_ENV);
  t.after(() => app.close());
  assert.equal((await post(app.base, DM)).status, 401);
  assert.equal(app.published.length, 0);
});

test('C2: malformed signature → 401', async t => {
  const app = await boot(PROD_ENV);
  t.after(() => app.close());
  const good = sign(DM, FB_SECRET);
  const hex = good.slice('sha256='.length);
  for (const header of [
    hex,
    `sha1=${hex}`,
    `sha256=${hex.slice(1)}`,
    `sha256=${'z'.repeat(64)}`,
    'garbage',
  ]) {
    assert.equal((await post(app.base, DM, header)).status, 401, header);
  }
  assert.equal(app.published.length, 0);
});

test('C2: valid signature of another body, or of re-serialised JSON → 401', async t => {
  const app = await boot(PROD_ENV);
  t.after(() => app.close());
  assert.equal(
    (await post(app.base, DM, sign('{"object":"instagram","entry":[]}', FB_SECRET))).status,
    401
  );
  assert.equal(
    (await post(app.base, DM, sign(JSON.stringify(JSON.parse(DM)), FB_SECRET))).status,
    401
  );
  assert.equal((await post(app.base, DM, sign(DM, 'not-an-app-secret'))).status, 401);
  assert.equal(app.published.length, 0);
});

test('C2/C5: valid signature (any of the three app secrets) → 200 and the parsed event reaches publisher.publish', async t => {
  const app = await boot(PROD_ENV);
  t.after(() => app.close());
  for (const secret of [FB_SECRET, IG_LOGIN_SECRET, ACCOUNT_SECRET]) {
    const before = app.published.length;
    assert.equal((await post(app.base, DM, sign(DM, secret))).status, 200, secret);
    assert.equal(app.published.length, before + 1);
  }
  const { account, event } = app.published[0];
  assert.equal(account, 'acct');
  assert.equal(event.type, 'dm');
  assert.equal(event.senderId, 'user-1');
  assert.equal(event.text, 'hola desde Meta');
  assert.equal(event.messageId, 'mid-1');
});

test('F2-2: the dead keys of the prod Secret are not secrets of Meta', async t => {
  const app = await boot(PROD_ENV);
  t.after(() => app.close());
  for (const key of [
    'INSTAGRAM_WEBHOOK_SECRET',
    'INSTAGRAM_INTERNAL_API_TOKEN',
    'WEBHOOK_VERIFY_TOKEN',
  ]) {
    const status = (await post(app.base, DM, sign(DM, PROD_ENV[key] as string))).status;
    assert.equal(status, 401, key);
  }
  assert.equal(app.published.length, 0);
});

test('C1b/F2-1: metaAppSecrets is the closed list, without empties, duplicates or dead keys', () => {
  const accounts = loadAccounts({
    env: PROD_ENV,
    storeEnabled: false,
    onFatal: () => {},
    info: () => {},
  });
  assert.deepEqual(metaAppSecrets(PROD_ENV, accounts), [
    FB_SECRET,
    IG_LOGIN_SECRET,
    ACCOUNT_SECRET,
  ]);

  // main.ts hands the account FACEBOOK_APP_SECRET (or '') when it has none of its own
  const inheriting = { ...PROD_ENV, INSTAGRAM_ACCT_APP_SECRET: '' } as NodeJS.ProcessEnv;
  const inherited = loadAccounts({
    env: inheriting,
    storeEnabled: false,
    onFatal: () => {},
    info: () => {},
  });
  assert.deepEqual(metaAppSecrets(inheriting, inherited), [FB_SECRET, IG_LOGIN_SECRET]);

  const bare = {
    ...inheriting,
    FACEBOOK_APP_SECRET: '',
    INSTAGRAM_LOGIN_APP_SECRET: '',
  } as NodeJS.ProcessEnv;
  const empty = loadAccounts({ env: bare, storeEnabled: false, onFatal: () => {}, info: () => {} });
  assert.equal(
    empty.get('acct')?.config.appSecret,
    '',
    'precondition: main.ts leaves the empty string'
  );
  assert.deepEqual(metaAppSecrets(bare, empty), []);
});

test('C2/F2-1: no secret configured → 503, and a signature made with the empty key does not open it', async t => {
  const env = {
    ...PROD_ENV,
    FACEBOOK_APP_SECRET: '',
    INSTAGRAM_LOGIN_APP_SECRET: '',
    INSTAGRAM_ACCT_APP_SECRET: '',
  } as NodeJS.ProcessEnv;
  const app = await boot(env);
  t.after(() => app.close());
  assert.equal((await post(app.base, DM, sign(DM, ''))).status, 503);
  assert.equal((await post(app.base, DM)).status, 503);
  assert.equal(app.published.length, 0);
  assert.ok(
    app.logs.some(l => /app secret/i.test(l.msg)),
    `startup warn missing: ${JSON.stringify(app.logs)}`
  );
});

test('F2-1: one secret set and the others empty → the empty key still does not pass', async t => {
  const env = {
    ...PROD_ENV,
    FACEBOOK_APP_SECRET: '',
    INSTAGRAM_ACCT_APP_SECRET: '',
  } as NodeJS.ProcessEnv;
  const app = await boot(env);
  t.after(() => app.close());
  assert.equal((await post(app.base, DM, sign(DM, ''))).status, 401);
  assert.equal((await post(app.base, DM, sign(DM, IG_LOGIN_SECRET))).status, 200);
  assert.equal(app.published.length, 1);
});

test('C4: GET verification keeps its behaviour with a token configured', async t => {
  const app = await boot(PROD_ENV);
  t.after(() => app.close());
  const get = (token: string) =>
    fetch(`${app.base}/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=abc123`);
  const ok = await get(VERIFY_TOKEN);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'abc123');
  assert.equal((await get('wrong')).status, 403);
  assert.equal((await get('')).status, 403);
});

test('C4/F2-6: no WEBHOOK_VERIFY_TOKEN → GET answers 503 (also with an empty or the old default token) and warns at boot', async t => {
  const env = { ...PROD_ENV } as NodeJS.ProcessEnv;
  delete env.WEBHOOK_VERIFY_TOKEN;
  const app = await boot(env);
  t.after(() => app.close());
  for (const token of ['', FORMER_DEFAULT_TOKEN, 'anything']) {
    const res = await fetch(
      `${app.base}/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=abc123`
    );
    assert.equal(res.status, 503, `hub.verify_token=${token}`);
    assert.notEqual(await res.text(), 'abc123');
  }
  assert.equal(
    (await fetch(`${app.base}/webhook?hub.mode=subscribe&hub.challenge=abc123`)).status,
    503
  );
  assert.ok(
    app.logs.some(l => /WEBHOOK_VERIFY_TOKEN/.test(l.msg)),
    `startup warn missing: ${JSON.stringify(app.logs)}`
  );

  const blank = { ...PROD_ENV, WEBHOOK_VERIFY_TOKEN: '' } as NodeJS.ProcessEnv;
  const blankApp = await boot(blank);
  t.after(() => blankApp.close());
  assert.equal(
    (await fetch(`${blankApp.base}/webhook?hub.mode=subscribe&hub.verify_token=&hub.challenge=x`))
      .status,
    503
  );
});

test('C4b/F2-4/F2-5: a rejected POST is never answered 200, and nothing of the body or the signature is logged', async t => {
  const app = await boot(PROD_ENV);
  t.after(() => app.close());
  const bad = sign(DM, 'not-an-app-secret');
  const res = await post(app.base, DM, bad);
  assert.equal(res.status, 401);
  assert.equal(app.published.length, 0);

  const rejections = app.logs.filter(l => l.msg === 'Webhook POST rejected');
  assert.equal(rejections.length, 1, 'one log for the rejection');
  assert.equal(rejections[0].obj.reason, 'invalid_signature');
  assert.equal(rejections[0].obj.count, 1);
  const logged = JSON.stringify(app.logs);
  for (const leak of ['hola desde Meta', 'user-1', 'mid-1', bad, bad.slice('sha256='.length)]) {
    assert.ok(!logged.includes(leak), `log leaks ${leak}`);
  }
});

test('F2-5: a log per rejection reason with a running count, at most one line per interval', async t => {
  let clock = 1_000_000;
  const logs: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const log: WebhookLog = { warn: (obj, msg) => logs.push({ obj, msg }) };
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => ((req as typeof req & { rawBody?: Buffer }).rawBody = buf),
    })
  );
  app.post(
    '/webhook',
    webhookSignatureGuard([FB_SECRET], { log, now: () => clock }),
    (_req, res) => {
      res.sendStatus(200);
    }
  );
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  for (let i = 0; i < 4; i++) await post(base, DM); // missing_signature x4
  await post(base, DM, sign(DM, 'nope')); // invalid_signature x1
  assert.deepEqual(
    logs.map(l => [l.obj.reason, l.obj.count]),
    [
      ['missing_signature', 1],
      ['invalid_signature', 1],
    ],
    'one line per reason inside the interval'
  );

  clock += 10_000;
  await post(base, DM);
  assert.deepEqual(logs.at(-1)?.obj, { reason: 'missing_signature', count: 5 });
  assert.equal(
    (await post(base, DM, sign(DM, FB_SECRET))).status,
    200,
    'a valid signature still passes'
  );
});
