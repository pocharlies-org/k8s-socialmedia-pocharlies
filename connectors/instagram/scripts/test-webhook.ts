import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import express from 'express';
import {
  createWebhookRouter,
  isInboundDm,
  isValidSignature,
  normalizeMetaTimestamp,
  WebhookEvent,
} from '../src/webhook';
import { publishWithAcknowledgement } from '../src/publisher-ack';
import { InstagramEventPublisher } from '../src/publisher';

const INSTAGRAM_SKIRMSHOP_DM_SUBJECT = 'instagram.skirmshop.dm.received';

const secret = 'test-webhook-app-secret';
const raw = Buffer.from('{"object":"instagram"}');
const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
const request = (value = signature) =>
  ({
    rawBody: raw,
    get: (header: string) => (header.toLowerCase() === 'x-hub-signature-256' ? value : undefined),
  }) as unknown as Request;

assert.equal(isValidSignature(request(), secret), true);
assert.equal(isValidSignature(request('sha256=00'), secret), false);
assert.equal(isValidSignature(request(), ''), false);
assert.equal(normalizeMetaTimestamp(1510609444865), '2017-11-13T21:44:04.865Z');
assert.equal(normalizeMetaTimestamp('1510609444865'), '2017-11-13T21:44:04.865Z');
assert.equal(normalizeMetaTimestamp(1510609444), '2017-11-13T21:44:04.000Z');
assert.equal(normalizeMetaTimestamp(undefined, 1510609444865), '2017-11-13T21:44:04.865Z');
assert.equal(
  isInboundDm({
    sender: { id: 'customer' },
    recipient: { id: 'skirmshop' },
    message: { mid: 'm1' },
  }),
  true
);
assert.equal(
  isInboundDm({
    sender: { id: 'skirmshop' },
    recipient: { id: 'skirmshop' },
    message: { mid: 'm2' },
  }),
  false
);
assert.equal(
  isInboundDm({
    sender: { id: 'customer' },
    recipient: { id: 'skirmshop' },
    message: { mid: 'm3', is_echo: true },
  }),
  false
);
assert.equal(isInboundDm({ sender: { id: 'customer' }, recipient: { id: 'skirmshop' } }), false);

async function testPublisherAcknowledgements(): Promise<void> {
  const published: Array<{ subject: string; messageId: string }> = [];
  const ack = async (subject: string, _payload: Uint8Array, messageId: string) => {
    published.push({ subject, messageId });
  };
  await publishWithAcknowledgement(
    ack,
    INSTAGRAM_SKIRMSHOP_DM_SUBJECT,
    new Uint8Array(),
    'skirmshop:broker-dm-1'
  );
  assert.deepEqual(published, [
    {
      subject: INSTAGRAM_SKIRMSHOP_DM_SUBJECT,
      messageId: 'skirmshop:broker-dm-1',
    },
  ]);
  await assert.rejects(
    publishWithAcknowledgement(
      async () => {
        throw new Error('no puback');
      },
      INSTAGRAM_SKIRMSHOP_DM_SUBJECT,
      new Uint8Array(),
      'skirmshop:broker-dm-2'
    )
  );
}

async function testPublisherDeduplicatesMessageIds(): Promise<void> {
  const acknowledged: string[] = [];
  const publisher = new InstagramEventPublisher(
    'nats://unused.test:4222',
    undefined,
    async (_subject, _payload, messageId) => {
      acknowledged.push(messageId);
    }
  );
  const event: WebhookEvent = {
    type: 'dm',
    senderId: 'customer',
    conversationId: 'customer',
    messageId: 'dm-deduplicated',
    text: 'hello',
    timestamp: new Date(0).toISOString(),
    raw: {},
  };

  assert.equal(await publisher.publish('skirmshop', event), true);
  assert.equal(await publisher.publish('skirmshop', event), true);
  assert.deepEqual(acknowledged, ['skirmshop:dm-deduplicated']);
}

async function main(): Promise<void> {
  await testPublisherAcknowledgements();
  await testPublisherDeduplicatesMessageIds();
  const accountIds = new Map([
    ['ig-skirmshop', 'skirmshop'],
    ['ig-other', 'barbelpapis'],
  ]);
  const published: WebhookEvent[] = [];
  let publishResult = true;
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buffer) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
      },
    })
  );
  app.use(
    createWebhookRouter('verify', secret, accountIds, async (_account, event) => {
      published.push(event);
      return publishResult;
    })
  );
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/webhook`;

  async function post(body: object, signatureValue?: string): Promise<Response> {
    const payload = JSON.stringify(body);
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(signatureValue === undefined ? {} : { 'x-hub-signature-256': signatureValue }),
      },
      body: payload,
    });
  }

  function signed(body: object): string {
    return `sha256=${createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex')}`;
  }

  const dm = {
    object: 'instagram',
    entry: [
      {
        id: 'ig-skirmshop',
        messaging: [
          {
            sender: { id: 'customer' },
            recipient: { id: 'ig-skirmshop' },
            timestamp: 1510609444865,
            message: { mid: 'dm-1', text: 'Need help' },
          },
        ],
      },
    ],
  };
  try {
    assert.equal((await post(dm)).status, 401);
    const other = structuredClone(dm);
    other.entry[0].id = 'ig-other';
    other.entry[0].messaging[0].recipient.id = 'ig-other';
    assert.equal((await post(other, signed(other))).status, 403);
    const comment = {
      object: 'instagram',
      entry: [
        {
          id: 'ig-skirmshop',
          changes: [{ field: 'comments', value: { id: 'c1', text: 'no publish' } }],
        },
      ],
    };
    assert.equal((await post(comment, signed(comment))).status, 200);
    const echo = structuredClone(dm);
    echo.entry[0].messaging[0].message.is_echo = true;
    assert.equal((await post(echo, signed(echo))).status, 200);
    assert.equal(published.length, 0);
    publishResult = false;
    const unavailable = structuredClone(dm);
    unavailable.entry[0].messaging[0].message.mid = 'dm-unavailable';
    assert.equal((await post(unavailable, signed(unavailable))).status, 503);
    assert.equal(published.length, 1);
    publishResult = true;
    assert.equal((await post(dm, signed(dm))).status, 200);
    assert.equal((await post(dm, signed(dm))).status, 200);
    assert.equal(published.filter(event => event.messageId === 'dm-1').length, 2);
    assert.equal(
      published.find(event => event.messageId === 'dm-1')?.timestamp,
      '2017-11-13T21:44:04.865Z'
    );

    const changesDm = {
      object: 'instagram',
      entry: [
        {
          id: 'ig-skirmshop',
          changes: [
            {
              field: 'messages',
              value: {
                sender: { id: 'customer-changes' },
                recipient: { id: 'ig-skirmshop' },
                timestamp: '1510609444865',
                message: { mid: 'dm-changes', text: 'Changes payload' },
              },
            },
          ],
        },
      ],
    };
    assert.equal((await post(changesDm, signed(changesDm))).status, 200);
    assert.equal(
      published.find(event => event.messageId === 'dm-changes')?.timestamp,
      '2017-11-13T21:44:04.865Z'
    );

    const missingTimestamp = structuredClone(dm);
    delete (missingTimestamp.entry[0].messaging[0] as { timestamp?: number }).timestamp;
    missingTimestamp.entry[0].messaging[0].message.mid = 'dm-missing-timestamp';
    const beforeMissingTimestamp = Date.now();
    assert.equal((await post(missingTimestamp, signed(missingTimestamp))).status, 200);
    const normalizedMissingTimestamp = Date.parse(
      published.find(event => event.messageId === 'dm-missing-timestamp')?.timestamp || ''
    );
    assert.ok(normalizedMissingTimestamp >= beforeMissingTimestamp);
    assert.ok(normalizedMissingTimestamp <= Date.now());
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  }
  process.stdout.write('instagram webhook router tests passed\n');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
