import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, STATUS_PUBLISH_LIMITS } from '../server.mjs';

/*
 * POST /api/novedades/status is a send to an audience the caller names, so these
 * tests hold the proxy to three promises: a request is either refused locally in
 * full or forwarded in full, exactly one attempt reaches the connector, and the
 * answer only claims what the connector actually proved.
 */

const auth = `Basic ${Buffer.from('operator:password').toString('base64')}`;
const PUBLIC_URL = 'https://wa.example';
const DIRECT = '34600111222@s.whatsapp.net';
const TEXT = { type: 'text', text: 'Buenas', recipients: [DIRECT] };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

async function fixture(t, { fetchImpl, env = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'whatsapp-status-test-'));
  const queries = [];
  const attempts = [];
  const db = { query: async (sql, args) => { queries.push({ sql, args }); return { rows: [] }; } };
  const runtimeEnv = {
    DATA_DIR: dir,
    UI_AUTH_USERNAME: 'operator',
    UI_AUTH_PASSWORD: 'password',
    APP_PUBLIC_URL: PUBLIC_URL,
    APP_ENABLE_SENDING: 'true',
    PERSONAL_SECRET: 'personal-secret',
    SECONDARY_SECRET: 'secondary-secret',
    ...env,
  };
  const app = await createApp({
    env: runtimeEnv,
    db,
    registry: [
      { channel: 'whatsapp', accountId: 'personal', secretEnv: 'PERSONAL_SECRET', connectorUrl: 'http://personal-connector' },
      { channel: 'whatsapp', accountId: 'secondary', secretEnv: 'SECONDARY_SECRET', connectorUrl: 'http://secondary-connector' },
    ],
    fetchImpl: fetchImpl || (async (url, options) => {
      attempts.push({ url, method: options.method, raw: options.body, headers: options.headers });
      return Response.json({ ok: true, messageId: 'status-receipt-1', type: 'text' });
    }),
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, body, headers = {}) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: auth, ...(body === undefined ? {} : { origin: PUBLIC_URL, 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const publish = (body, headers) => request('/api/novedades/status', body, headers);
  return { request, publish, attempts, queries };
}

/** The connector authenticates the exact bytes it received, not a re-serialization. */
function signed(raw, headers, secret) {
  const timestamp = headers['x-connector-timestamp'];
  return Boolean(timestamp)
    && headers['x-connector-signature'] === `sha256=${createHmac('sha256', secret).update(`${timestamp}:${raw}`).digest('hex')}`;
}

test('a text status reaches only its own connector with the audience and card it names', async t => {
  const { publish, attempts, queries } = await fixture(t);
  const response = await publish({
    ...TEXT, account: 'secondary', text: '  Buenas  ',
    recipients: ['34600333444:3@s.whatsapp.net', DIRECT, '34600111222@c.us', '34600555666@lid', '34600333444@s.whatsapp.net'],
    backgroundColor: '#FFAA00', font: 3, chat: 'secondary-chat', sendToken: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    account: 'secondary', confirmed: true, type: 'text', messageId: 'status-receipt-1',
    recipients: ['34600333444@s.whatsapp.net', DIRECT, '34600555666@lid'],
  });
  assert.equal(attempts.length, 1);
  const [attempt] = attempts;
  assert.equal(attempt.url, 'http://secondary-connector/api/v1/novedades/status');
  assert.equal(attempt.method, 'POST');
  assert.deepEqual(JSON.parse(attempt.raw), {
    type: 'text',
    recipients: ['34600333444@s.whatsapp.net', DIRECT, '34600555666@lid'],
    text: 'Buenas',
    backgroundColor: '#FFAA00',
    font: 3,
  });
  // The signature has to cover the bytes that were sent, so the body must be the
  // canonical serialization of the forwarded object rather than a spliced string.
  assert.equal(attempt.raw, JSON.stringify(JSON.parse(attempt.raw)));
  assert.equal(signed(attempt.raw, attempt.headers, 'secondary-secret'), true);
  assert.equal(queries.length, 0);
});

test('the account in the body selects both the connector and the signing secret', async t => {
  const { publish, attempts } = await fixture(t);
  assert.equal((await publish({ ...TEXT, account: 'personal' })).status, 200);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].url, 'http://personal-connector/api/v1/novedades/status');
  assert.equal(signed(attempts[0].raw, attempts[0].headers, 'personal-secret'), true);
});

test('a text card option arrives as the connector parses it and absent means absent', async t => {
  const { publish, attempts } = await fixture(t);
  assert.equal((await publish({ ...TEXT, account: 'secondary', font: '4', backgroundColor: '00ccff' })).status, 200);
  assert.deepEqual(JSON.parse(attempts[0].raw), { type: 'text', recipients: [DIRECT], text: 'Buenas', backgroundColor: '00ccff', font: 4 });
  assert.equal((await publish({ ...TEXT, account: 'secondary', font: null, backgroundColor: null })).status, 200);
  assert.deepEqual(JSON.parse(attempts[1].raw), { type: 'text', recipients: [DIRECT], text: 'Buenas' });
});

test('the audience bound is the connector bound, so 256 names pass and one more does not', async t => {
  const { publish, attempts } = await fixture(t);
  const many = Array.from({ length: 256 }, (_, index) => `${34600000000 + index}@s.whatsapp.net`);
  const accepted = await publish({ ...TEXT, account: 'secondary', recipients: many });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).recipients.length, 256);
  assert.equal(attempts.length, 1);
  const over = await publish({ ...TEXT, account: 'secondary', recipients: [...many, '34600999999@s.whatsapp.net'] });
  assert.equal(over.status, 400);
  assert.match((await over.json()).error, /256/);
  assert.equal(attempts.length, 1);
});

test('a media status forwards bare base64 and the type WhatsApp will be told', async t => {
  const { publish, attempts } = await fixture(t);
  // A pasted asset arrives as a data URL; the connector only accepts bare base64,
  // and a declared mimeType is the caller's own statement about those bytes.
  assert.equal((await publish({
    account: 'secondary', type: 'image', recipients: [DIRECT], text: '  Foto  ',
    data: `data:image/png;base64,${PNG}`, mimeType: 'image/jpeg; charset=binary', backgroundColor: '#112233', font: 2,
  })).status, 200);
  assert.deepEqual(JSON.parse(attempts[0].raw), {
    type: 'image', recipients: [DIRECT], text: 'Foto', data: PNG, mimeType: 'image/jpeg',
  });
  assert.equal(signed(attempts[0].raw, attempts[0].headers, 'secondary-secret'), true);

  assert.equal((await publish({
    account: 'secondary', type: 'image', recipients: [DIRECT], data: `data:image/webp;base64,${PNG}`,
  })).status, 200);
  assert.equal(JSON.parse(attempts[1].raw).mimeType, 'image/webp');

  assert.equal((await publish({
    account: 'secondary', type: 'video', recipients: [DIRECT], data: PNG, mimeType: 'video/quicktime',
  })).status, 200);
  assert.deepEqual(JSON.parse(attempts[2].raw), { type: 'video', recipients: [DIRECT], data: PNG, mimeType: 'video/quicktime' });

  // Wrapped base64 is the same payload as unwrapped base64: the line breaks are
  // formatting, and the connector would drop them anyway.
  assert.equal((await publish({
    account: 'secondary', type: 'image', recipients: [DIRECT], data: `${PNG.slice(0, 8)}\n${PNG.slice(8)}\n`, mimeType: 'image/png',
  })).status, 200);
  assert.equal(JSON.parse(attempts[3].raw).data, PNG);
});

test('an unusable status is refused before the live account is touched', async t => {
  let touched = 0;
  const { publish, queries } = await fixture(t, {
    fetchImpl: async () => { touched += 1; return Response.json({ ok: true, messageId: 'unused' }); },
  });
  const image = { account: 'secondary', type: 'image', recipients: [DIRECT], data: PNG, mimeType: 'image/jpeg' };
  const video = { account: 'secondary', type: 'video', recipients: [DIRECT], data: PNG, mimeType: 'video/mp4' };
  const cases = [
    ['the type is required', { recipients: [DIRECT], text: 'hola' }, 400],
    ['the type must be one WhatsApp has', { ...TEXT, type: 'story' }, 400],
    ['a text status needs text', { type: 'text', recipients: [DIRECT] }, 400],
    ['whitespace is not a status', { ...TEXT, text: '   ' }, 400],
    ['a text card holds 700 characters', { ...TEXT, text: 'x'.repeat(701) }, 400],
    ['a caption holds 1024 characters', { ...image, text: 'x'.repeat(1025) }, 400],
    ['the audience has to be named', { type: 'text', text: 'hola' }, 400],
    ['an empty audience is not everyone', { ...TEXT, recipients: [] }, 400],
    ['the audience is a list', { ...TEXT, recipients: DIRECT }, 400],
    ['a group is not a contact', { ...TEXT, recipients: ['120363141234567890@g.us'] }, 400, 'INVALID_RECIPIENT'],
    ['a channel is not a contact', { ...TEXT, recipients: ['123456789012345678@newsletter'] }, 400, 'INVALID_RECIPIENT'],
    ['the status address is not an audience', { ...TEXT, recipients: ['status@broadcast'] }, 400, 'INVALID_RECIPIENT'],
    ['an audience entry is a string', { ...TEXT, recipients: [34600111222] }, 400, 'INVALID_RECIPIENT'],
    ['a number without an address is not a JID', { ...TEXT, recipients: ['+34 600 11 22 22'] }, 400, 'INVALID_RECIPIENT'],
    ['an image needs its bytes', { type: 'image', recipients: [DIRECT], mimeType: 'image/jpeg' }, 400],
    ['an image needs a type', { type: 'image', recipients: [DIRECT], data: PNG }, 400],
    ['a gif is not a status image', { ...image, mimeType: 'image/gif' }, 400],
    ['a webm is not a status video', { ...video, mimeType: 'video/webm' }, 400],
    ['media has to be base64', { ...image, data: 'not base64 at all!' }, 400],
    ['base64 with stray bits is not the same bytes', { ...image, data: 'YWB=' }, 400],
    ['empty media is not a photo', { ...image, data: '' }, 400],
    ['a background colour is six or eight hex digits', { ...TEXT, backgroundColor: '#GGHHII' }, 400],
    ['a background colour has no 0x spelling', { ...TEXT, backgroundColor: '0x00ff00ff' }, 400],
    ['the font is an index', { ...TEXT, font: 'SERIF' }, 400],
    ['the font index has a range', { ...TEXT, font: 6 }, 400],
    ['oversized media is refused at the decoded size', { ...image, data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') }, 413, 'MEDIA_TOO_LARGE'],
    ['absurd media is refused before it is decoded', { ...image, data: 'A'.repeat(14 * 1024 * 1024 + 1) }, 413, 'MEDIA_TOO_LARGE'],
  ];
  for (const [name, body, status, code] of cases) {
    const response = await publish({ account: 'secondary', ...body });
    assert.equal(response.status, status, name);
    const payload = await response.json();
    if (code) assert.equal(payload.code, code, name);
    assert.match(payload.error, /\S/, name);
  }
  assert.equal(touched, 0);
  assert.equal(queries.length, 0);
});

test('sending, origin, authentication and account scope gate the publish', async t => {
  // Every refusal in this test happens before a request exists, so none of them may
  // borrow the uncertain-delivery wording: nothing could have been published.
  const certain = async (response, status) => {
    assert.equal(response.status, status);
    const payload = await response.json();
    assert.notEqual(payload.code, 'DELIVERY_UNCONFIRMED');
    assert(!JSON.stringify(payload).includes('desconocido'));
  };
  const disabled = await fixture(t, { env: { APP_ENABLE_SENDING: 'false' } });
  await certain(await disabled.publish({ ...TEXT, account: 'secondary' }), 403);
  const emergency = await fixture(t, { env: { EMERGENCY_DISABLE_SENDING: 'true' } });
  assert.equal((await emergency.publish({ ...TEXT, account: 'secondary' })).status, 403);
  const noSecret = await fixture(t, { env: { SECONDARY_SECRET: '' } });
  await certain(await noSecret.publish({ ...TEXT, account: 'secondary' }), 503);
  assert.equal(disabled.attempts.length + emergency.attempts.length + noSecret.attempts.length, 0);

  const open = await fixture(t);
  assert.equal((await open.publish({ ...TEXT, account: 'secondary' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await open.publish({ ...TEXT, account: 'secondary' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await open.publish({ ...TEXT, account: 'unknown' })).status, 404);
  assert.equal((await open.publish(TEXT)).status, 400);
  assert.equal((await open.publish({ ...TEXT, account: 'secondary' }, { authorization: '' })).status, 401);
  assert.equal(open.attempts.length, 0);
});

test('a refused publish is settled and an unanswered one is labelled unknown', async t => {
  // `remote` throws away a non-OK connector body, so only the connector's HTTP
  // status is safe to repeat here. What each answer costs the caller has to be
  // readable from the code alone: a refusal means the draft can be edited again,
  // an unknown outcome means the audience may already have the status.
  const uncertain = 'Estado de entrega desconocido';
  const cases = [
    ['accepted without a provider id', () => Response.json({ ok: true, type: 'text' }), 502, 'DELIVERY_UNCONFIRMED', { reason: 'no_message_id' }],
    ['refused input', () => Response.json({ ok: false, error: { code: 'INVALID_CAPABILITY_INPUT', message: 'provider private text' } }, { status: 422 }), 400, 'STATUS_PUBLISH_REJECTED', { upstreamStatus: 422 }],
    ['account restricted', () => Response.json({ ok: false, error: { code: 'ACCOUNT_RESTRICTED', message: 'provider private text' } }, { status: 403 }), 400, 'STATUS_PUBLISH_REJECTED', { upstreamStatus: 403 }],
    ['account not connected', () => Response.json({ ok: false, error: { code: 'WHATSAPP_NOT_CONNECTED', message: 'socket state=offline private' } }, { status: 503 }), 502, 'DELIVERY_UNCONFIRMED', { upstreamStatus: 503 }],
    ['connector behind a bad gateway', () => Response.json({ ok: false, error: { code: 'INTERNAL', message: 'private stack trace' } }, { status: 502 }), 502, 'DELIVERY_UNCONFIRMED', { upstreamStatus: 502 }],
    ['provider send timed out', () => Response.json({ ok: false, error: { code: 'SEND_TIMEOUT', message: 'private deadline detail' } }, { status: 504 }), 502, 'DELIVERY_UNCONFIRMED', { upstreamStatus: 504 }],
    ['connector fault page', () => new Response('<html>private upstream details</html>', { status: 500 }), 502, 'DELIVERY_UNCONFIRMED', { upstreamStatus: 500 }],
    // A body carrying `error` is not an acknowledgement, and an empty object is not
    // a receipt either: both leave the app unable to read its own result.
    ['connector answered with an error at HTTP 200', () => Response.json({ ok: true, error: 'provider private text' }), 502, 'DELIVERY_UNCONFIRMED', { reason: 'connector_answer_unreadable', connectorCode: 'UPSTREAM_INVALID' }],
    ['connector answered an empty body', () => new Response('', { status: 200 }), 502, 'DELIVERY_UNCONFIRMED', { reason: 'no_message_id' }],
    ['connector unreachable', () => Promise.reject(Error('socket hang up')), 502, 'DELIVERY_UNCONFIRMED', { reason: 'connector_unreachable' }],
    ['publish route not deployed yet', () => Response.json({ ok: false, error: { code: 'NOVEDADES_NOT_FOUND' } }, { status: 404 }), 501, 'UNSUPPORTED_UPSTREAM', undefined],
  ];
  for (const [name, answer, status, code, details] of cases) {
    let calls = 0;
    const { publish } = await fixture(t, { fetchImpl: async () => { calls += 1; return answer(); } });
    const response = await publish({ ...TEXT, account: 'secondary' });
    const payload = await response.json();
    assert.equal(response.status, status, name);
    assert.equal(payload.code, code, name);
    if (details) {
      for (const [key, value] of Object.entries(details)) {
        assert.equal(payload.details?.[key], value, `${name}: details.${key}`);
      }
    }
    const isUnknown = code === 'DELIVERY_UNCONFIRMED';
    // The two families must never share a label: this is what tells the composer
    // whether the draft is safe to resend or has to stay untouched.
    assert.equal(payload.error.includes(uncertain), isUnknown, name);
    if (isUnknown) assert.match(payload.error, /no reintentar/i, name);
    // A publish has no idempotency token, so an answer of either kind stays single:
    // retrying here is how one status ends up published twice.
    assert.equal(calls, 1, name);
    assert(!JSON.stringify(payload).includes('private'), name);
    assert(!JSON.stringify(payload).includes('stack'), name);
  }
});

test('publishing does not disturb the novedades read on the same path', async t => {
  const { request, attempts } = await fixture(t, {
    fetchImpl: async (url, options) => {
      attempts.push({ url, method: options.method, body: options.body });
      return Response.json({ ok: true, account: 'secondary', hasMore: false, nextCursor: null, coverage: {}, items: [] });
    },
  });
  const response = await request('/api/novedades/status?account=secondary&author=34600111222%40s.whatsapp.net');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).items, []);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].method, 'GET');
  assert.equal(attempts[0].body, undefined);
  assert(attempts[0].url.startsWith('http://secondary-connector/api/v1/novedades/status?author=34600111222%40s.whatsapp.net'));
});

test('the app gate and the connector still describe one publish contract', async t => {
  // Two copies of a limit drift apart silently, and the last drift cost a full
  // review cycle. The connector files are read, never imported: the app suite must
  // not need the connector toolchain, and a missing connector means no opinion.
  const read = async path => { try { return await readFile(new URL(path, import.meta.url), 'utf8'); } catch { return null; } };
  const client = await read('../../../connectors/whatsapp-web/src/baileys-client.ts');
  const controller = await read('../../../connectors/whatsapp-web/src/api/controller.ts');
  if (client === null || controller === null) return t.skip('connector sources are not in this checkout');
  // Prettier may break a long Set literal over several lines, so the literal is
  // taken up to its first semicolon rather than to the end of one line.
  const value = (source, name) => source.match(new RegExp(`const ${name} = ([\\s\\S]*?);\\n`))?.[1] ?? null;
  const number = (source, name) => {
    const literal = value(source, name);
    if (!/^[\d\s*]+$/.test(literal || '')) return null;
    return literal.split('*').reduce((product, part) => product * Number(part.trim()), 1);
  };
  const strings = (source, name) => {
    const items = value(source, name)?.match(/'[^']+'/g);
    return !Array.isArray(items) ? null : items.map(item => item.slice(1, -1));
  };
  for (const name of ['NOVEDADES_STATUS_MEDIA_MAX_BYTES', 'NOVEDADES_STATUS_RECIPIENTS_MAX', 'NOVEDADES_STATUS_IMAGE_MIME_TYPES',
    'NOVEDADES_STATUS_VIDEO_MIME_TYPES', 'NOVEDADES_STATUS_FONT_MIN', 'NOVEDADES_STATUS_FONT_MAX', 'NOVEDADES_STATUS_TEXT_MAX_CHARS']) {
    assert.notEqual(value(client, name), null, `${name} is no longer a literal the contract test can read`);
  }
  // The app may be stricter than the provider, never looser: a looser gate would
  // turn an accepted browser request into a provider fault against a live account.
  assert.equal(number(client, 'NOVEDADES_STATUS_MEDIA_MAX_BYTES'), STATUS_PUBLISH_LIMITS.mediaMaxBytes);
  assert.equal(number(client, 'NOVEDADES_STATUS_RECIPIENTS_MAX'), STATUS_PUBLISH_LIMITS.recipientsMax);
  assert.deepEqual(strings(client, 'NOVEDADES_STATUS_IMAGE_MIME_TYPES').sort(), [...STATUS_PUBLISH_LIMITS.imageMimeTypes].sort());
  assert.deepEqual(strings(client, 'NOVEDADES_STATUS_VIDEO_MIME_TYPES').sort(), [...STATUS_PUBLISH_LIMITS.videoMimeTypes].sort());
  assert.equal(number(client, 'NOVEDADES_STATUS_FONT_MIN'), STATUS_PUBLISH_LIMITS.fontMin);
  assert.equal(number(client, 'NOVEDADES_STATUS_FONT_MAX'), STATUS_PUBLISH_LIMITS.fontMax);
  assert.ok(STATUS_PUBLISH_LIMITS.textMaxChars <= number(client, 'NOVEDADES_STATUS_TEXT_MAX_CHARS'));
  assert.ok(STATUS_PUBLISH_LIMITS.captionMaxChars <= number(client, 'NOVEDADES_STATUS_TEXT_MAX_CHARS'));
  // The HTTP layer of the connector is the contract the app mirrors, so an
  // audience address has to satisfy the very same pattern on both sides.
  const pattern = controller.match(/const novedadesStatusDirectJid = \/(.+)\//)?.[1];
  assert.equal(pattern, STATUS_PUBLISH_LIMITS.recipientPattern);
});
