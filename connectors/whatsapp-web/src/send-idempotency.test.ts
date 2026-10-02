import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import pg from 'pg';
import express from 'express';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';
import { claimSendAttempt, confirmTextSend, reserveMediaSend, reserveTextSend, reserveVoiceSend, reserveEventResponseSend, reservePinSend, reservePollVoteSend, SendAlreadyClaimedError } from './send-idempotency';

test('reserves one send per account and token across retries and rejects changed payloads', async () => {
  const original = pg.Pool.prototype.query;
  const previousAccount = process.env.CONNECTOR_ACCOUNT;
  const rows = new Map<string, { request_hash: string; message_id: string; status: string; sent_at: Date | null }>();
  (pg.Pool.prototype as any).query = async (sql: string, params: string[] = []) => {
    if (sql.includes('CREATE TABLE')) return { rowCount: 0, rows: [] };
    const key = `${params[0]}:${params[1]}`;
    if (sql.includes('INSERT INTO whatsapp_send_attempts')) {
      if (rows.has(key)) return { rowCount: 0, rows: [] };
      rows.set(key, { request_hash: params[2], message_id: params[3], status: 'prepared', sent_at: null });
      return { rowCount: 1, rows: [{ message_id: params[3] }] };
    }
    if (sql.includes('SELECT request_hash')) return { rowCount: rows.has(key) ? 1 : 0, rows: rows.has(key) ? [rows.get(key)] : [] };
    if (sql.includes('UPDATE whatsapp_send_attempts')) {
      const row = rows.get(key);
      if (!row || row.message_id !== params[2]) return { rowCount: 0, rows: [] };
      if (sql.includes("SET status = 'pending'")) {
        if (row.status !== 'prepared') return { rowCount: 0, rows: [] };
        row.status = 'pending';
        return { rowCount: 1, rows: [{ message_id: row.message_id }] };
      }
      if (row.status !== 'pending') return { rowCount: 0, rows: [] };
      row.status = 'sent';
      row.sent_at = new Date('2026-01-01T00:00:00Z');
      return { rowCount: 1, rows: [{ sent_at: row.sent_at }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  try {
    process.env.CONNECTOR_ACCOUNT = 'personal';
    const input = { token: 'operation-1', conversationId: '111@s.whatsapp.net', content: 'hello' };
    const first = await reserveTextSend(input);
    assert.equal(first.state, 'claimed');
    assert.match(first.messageId, /^3EB0[A-F0-9]{18}$/);
    assert.deepEqual(await reserveTextSend(input), { state: 'prepared', messageId: first.messageId, sentAt: undefined });
    assert.equal((await reserveTextSend({ ...input, content: 'changed' })).state, 'conflict');
    await claimSendAttempt(input.token, first.messageId);
    assert.equal((await reserveTextSend(input)).state, 'pending');
    await assert.rejects(claimSendAttempt(input.token, first.messageId), SendAlreadyClaimedError);
    assert.equal(await confirmTextSend(input.token, first.messageId), '2026-01-01T00:00:00.000Z');
    assert.deepEqual(await reserveTextSend(input), { state: 'sent', messageId: first.messageId, sentAt: '2026-01-01T00:00:00.000Z' });

    process.env.CONNECTOR_ACCOUNT = 'professional';
    const otherAccount = await reserveTextSend(input);
    assert.equal(otherAccount.state, 'claimed');
    assert.notEqual(otherAccount.messageId, first.messageId);

    process.env.CONNECTOR_ACCOUNT = 'personal';
    const sourceA = 'a'.repeat(64);
    const eventResponse = {token: 'event-response', conversationId: '123@g.us', eventMessageId: 'event', attendance: 'going', extraGuestCount: 0};
    assert.equal((await reserveEventResponseSend(eventResponse)).state, 'claimed');
    assert.equal((await reserveEventResponseSend(eventResponse)).state, 'prepared');
    for (const change of [{attendance: 'maybe'}, {eventMessageId: 'other'}, {conversationId: '999@g.us'}, {extraGuestCount: 1}]) {
      assert.equal((await reserveEventResponseSend({...eventResponse, ...change})).state, 'conflict');
    }
    const pin = {token:'pin-token',conversationId:'123@g.us',targetMessageId:'target',pinned:true,duration:86400};
    const firstPin = await reservePinSend(pin);
    assert.equal(firstPin.state,'claimed');
    assert.equal((await reservePinSend(pin)).state,'prepared');
    for (const change of [{targetMessageId:'other'},{conversationId:'999@g.us'},{pinned:false,duration:0},{duration:604800}]) {
      assert.equal((await reservePinSend({...pin,...change})).state,'conflict');
    }
    assert.equal((await reserveEventResponseSend({...eventResponse,token:pin.token})).state,'conflict');
    const vote = {token:'poll-vote-1',conversationId:'123@g.us',pollMessageId:'poll-1',options:['Uno']};
    const firstVote = await reservePollVoteSend(vote);
    assert.equal(firstVote.state,'claimed');
    assert.equal((await reservePollVoteSend(vote)).state,'prepared');
    for (const changed of [{options:['Dos']},{options:[]},{pollMessageId:'poll-2'},{conversationId:'999@g.us'}]) {
      assert.equal((await reservePollVoteSend({...vote,...changed})).state,'conflict');
    }
    assert.equal((await reservePollVoteSend({...vote,token:'poll-vote-2',options:['Dos']})).state,'claimed');
    process.env.CONNECTOR_ACCOUNT='professional';
    const secondAccountPin=await reservePinSend(pin);
    assert.equal(secondAccountPin.state,'claimed');assert.notEqual(secondAccountPin.messageId,firstPin.messageId);
    process.env.CONNECTOR_ACCOUNT='personal';
    const sourceB = 'b'.repeat(64);
    const convertedMedia = { token: 'transcoded-gif', conversationId: '111@s.whatsapp.net',
      fileUrl: 'data:video/mp4;base64,Zmlyc3Q=', fileName: 'animation.mp4',
      asSticker: false, asGif: true, sourceDigest: sourceA, sourceMimeType: 'image/gif' };
    assert.equal((await reserveMediaSend(convertedMedia)).state, 'claimed');
    assert.equal((await reserveMediaSend({ ...convertedMedia, fileUrl: 'data:video/mp4;base64,c2Vjb25k' })).state, 'prepared');
    assert.equal((await reserveMediaSend({ ...convertedMedia, sourceDigest: sourceB })).state, 'conflict');
    assert.equal((await reserveMediaSend({ ...convertedMedia, fileUrl: 'data:image/gif;base64,Zmlyc3Q=' })).state, 'conflict');
    assert.equal((await reserveMediaSend({ ...convertedMedia, fileUrl: 'data:video/mp4;codecs=h264;base64,Zmlyc3Q=' })).state, 'conflict');
    assert.equal((await reserveMediaSend({ ...convertedMedia, sourceMimeType: 'video/quicktime' })).state, 'conflict');
    await assert.rejects(reserveMediaSend({ ...convertedMedia, sourceMimeType: undefined }), /sourceMimeType is required/);
    const convertedVoice = { token: 'transcoded-voice', conversationId: '111@s.whatsapp.net',
      audioBase64: 'Zmlyc3Q=', mimeType: 'audio/ogg; codecs=opus', sourceDigest: sourceA, sourceMimeType: 'audio/webm' };
    assert.equal((await reserveVoiceSend(convertedVoice)).state, 'claimed');
    assert.equal((await reserveVoiceSend({ ...convertedVoice, audioBase64: 'c2Vjb25k' })).state, 'prepared');
    assert.equal((await reserveVoiceSend({ ...convertedVoice, sourceDigest: sourceB })).state, 'conflict');
    assert.equal((await reserveVoiceSend({ ...convertedVoice, sourceMimeType: 'audio/mp4' })).state, 'conflict');
    await assert.rejects(reserveVoiceSend({ ...convertedVoice, sourceMimeType: undefined }), /sourceMimeType is required/);

    const previousEnabled = process.env.ENABLE_SENDING;
    process.env.ENABLE_SENDING = 'true';
    let sendCalls = 0;
    let mediaCalls = 0;
    let voiceCalls = 0;
    const preflightFailures = new Set(['preflight-failure', 'media-preflight-failure', 'voice-preflight-failure']);
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createRouter({
      isConnected: () => true,
      sendMessage: async (_chat: string, text: string, options: { messageId: string; beforeSend: () => Promise<void> }) => {
        sendCalls++;
        if (preflightFailures.delete(text)) throw new Error('Preflight failed before send');
        await options.beforeSend();
        if (text === 'timeout') throw new Error('sendMessage timeout after 45000ms');
        return options.messageId;
      },
      sendFile: async (_chat: string, url: string, _caption: string, options: { messageId?: string; beforeSend?: () => Promise<void> }) => {
        mediaCalls++;
        if (preflightFailures.delete(url)) throw new Error('Media preflight failed before send');
        await options.beforeSend?.();
        return options.messageId || 'legacy-media';
      },
      sendVoice: async (_chat: string, audio: Buffer, _mime: string, messageId?: string, beforeSend?: () => Promise<void>) => {
        voiceCalls++;
        if (preflightFailures.delete(audio.toString())) throw new Error('Voice preflight failed before send');
        await beforeSend?.();
        return messageId || 'legacy-voice';
      },
    } as any, { getCurrentQR: () => null } as any, 'test-secret'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
      const address = server.address() as { port: number };
      const url = `http://127.0.0.1:${address.port}/api/v1/messages/send`;
      async function send(token: string, content = 'hello') {
        const body = { sendToken: token, conversationId: '111@s.whatsapp.net', content };
        const timestamp = Math.floor(Date.now() / 1000);
        return fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-connector-timestamp': String(timestamp),
            'x-connector-signature': generateHMACSignature(body, timestamp, 'test-secret'),
          },
          body: JSON.stringify(body),
        });
      }
      const response = await send('http-operation');
      assert.equal(response.status, 200);
      const sent = await response.json() as { messageId: string };
      const replay = await send('http-operation');
      assert.equal(replay.status, 200);
      assert.deepEqual((await replay.json()).messageId, sent.messageId);
      assert.equal((await send('http-operation', 'changed')).status, 409);
      assert.equal(sendCalls, 1);
      const pending = await reserveTextSend({ ...input, token: 'uncertain-operation' });
      assert.equal(pending.state, 'claimed');
      await claimSendAttempt('uncertain-operation', pending.messageId);
      const uncertain = await send('uncertain-operation');
      assert.equal(uncertain.status, 409);
      assert.equal(sendCalls, 1);
      const timedOut = await send('timeout-operation', 'timeout');
      assert.equal(timedOut.status, 504);
      const timedOutReplay = await send('timeout-operation', 'timeout');
      assert.equal(timedOutReplay.status, 409);
      assert.equal(sendCalls, 2);
      assert.equal((await send('preflight-operation', 'preflight-failure')).status, 500);
      assert.equal((await reserveTextSend({ token: 'preflight-operation', conversationId: '111@s.whatsapp.net', content: 'preflight-failure' })).state, 'prepared');
      assert.equal((await send('preflight-operation', 'preflight-failure')).status, 200);

      async function post(path: string, body: Record<string, unknown>) {
        const timestamp = Math.floor(Date.now() / 1000);
        return fetch(`http://127.0.0.1:${address.port}/api/v1${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-connector-timestamp': String(timestamp),
            'x-connector-signature': generateHMACSignature(body, timestamp, 'test-secret'),
          },
          body: JSON.stringify(body),
        });
      }
      const media = { sendToken: 'media-operation', conversationId: '111@s.whatsapp.net',
        fileUrl: 'data:image/png;base64,aW1hZ2U=', fileName: 'image.png', caption: 'caption' };
      const firstMedia = await post('/messages/media/send', media);
      assert.equal(firstMedia.status, 200);
      const mediaId = (await firstMedia.json()).messageId;
      assert.equal((await post('/messages/media/send', media)).status, 200);
      assert.equal((await post('/messages/media/send', { ...media, caption: 'changed' })).status, 409);
      assert.equal((await post('/messages/media/send', { ...media, quality: 'source' })).status, 200);
      assert.equal((await post('/messages/media/send', { ...media, quality: 'hd' })).status, 409);
      assert.equal((await post('/messages/media/send', { ...media, quality: 'standard' })).status, 409);
      for (const quality of ['invalid', null, 1]) {
        assert.equal((await post('/messages/media/send', { ...media, sendToken: 'invalid-quality', quality })).status, 400);
      }
      assert.equal(mediaCalls, 1);
      assert.equal((await post('/messages/media/send', { ...media, sendToken: undefined })).status, 200);
      assert.equal(mediaCalls, 2);
      assert.match(mediaId, /^3EB0/);
      const failedMedia = { ...media, sendToken: 'media-preflight', fileUrl: 'media-preflight-failure' };
      assert.equal((await post('/messages/media/send', failedMedia)).status, 500);
      assert.equal((await post('/messages/media/send', failedMedia)).status, 200);
      const gif = { ...media, sendToken: 'gif-retry', kind: 'gif', sourceDigest: sourceA, sourceMimeType: 'image/gif',
        fileUrl: 'data:video/mp4;base64,Zmlyc3Q=' };
      assert.equal((await post('/messages/media/send', gif)).status, 200);
      assert.equal((await post('/messages/media/send', { ...gif, fileUrl: 'data:video/mp4;base64,c2Vjb25k' })).status, 200);
      assert.equal((await post('/messages/media/send', { ...gif, sourceDigest: sourceB })).status, 409);
      assert.equal((await post('/messages/media/send', { ...gif, fileUrl: 'data:image/gif;base64,Zmlyc3Q=' })).status, 409);
      assert.equal((await post('/messages/media/send', { ...gif, sourceMimeType: 'video/quicktime' })).status, 409);
      assert.equal(mediaCalls, 5);
      const standard = { ...media, sendToken: 'quality-retry', quality: 'standard' };
      assert.equal((await post('/messages/media/send', standard)).status, 200);
      assert.equal((await post('/messages/media/send', standard)).status, 200);
      assert.equal((await post('/messages/media/send', { ...standard, quality: 'hd' })).status, 409);
      assert.equal((await post('/messages/media/send', { ...standard, quality: 'source' })).status, 409);
      assert.equal(mediaCalls, 6);

      const voice = { sendToken: 'voice-operation', conversationId: '111@s.whatsapp.net',
        audioBase64: 'YXVkaW8=', mimeType: 'audio/ogg; codecs=opus' };
      assert.equal((await post('/messages/audio', voice)).status, 200);
      assert.equal((await post('/messages/audio', voice)).status, 200);
      assert.equal((await post('/messages/audio', { ...voice, audioBase64: 'Y2hhbmdlZA==' })).status, 409);
      assert.equal(voiceCalls, 1);
      assert.equal((await post('/messages/audio', { ...voice, sendToken: undefined })).status, 200);
      assert.equal(voiceCalls, 2);
      const failedVoice = { ...voice, sendToken: 'voice-preflight', audioBase64: Buffer.from('voice-preflight-failure').toString('base64') };
      assert.equal((await post('/messages/audio', failedVoice)).status, 500);
      assert.equal((await post('/messages/audio', failedVoice)).status, 200);
      const voiceRetry = { ...voice, sendToken: 'voice-transcode-retry', sourceDigest: sourceA, sourceMimeType: 'audio/webm' };
      assert.equal((await post('/messages/audio', voiceRetry)).status, 200);
      assert.equal((await post('/messages/audio', { ...voiceRetry, audioBase64: 'c2Vjb25k' })).status, 200);
      assert.equal((await post('/messages/audio', { ...voiceRetry, sourceDigest: sourceB })).status, 409);
      assert.equal((await post('/messages/audio', { ...voiceRetry, sourceMimeType: 'audio/mp4' })).status, 409);
      assert.equal(voiceCalls, 5);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (previousEnabled === undefined) delete process.env.ENABLE_SENDING;
      else process.env.ENABLE_SENDING = previousEnabled;
    }
  } finally {
    (pg.Pool.prototype as any).query = original;
    if (previousAccount === undefined) delete process.env.CONNECTOR_ACCOUNT;
    else process.env.CONNECTOR_ACCOUNT = previousAccount;
  }
});

test('viewOnce joins the media fingerprint without touching normal-send hashes', async () => {
  const original = pg.Pool.prototype.query;
  const previousAccount = process.env.CONNECTOR_ACCOUNT;
  const rows = new Map<string, { request_hash: string; message_id: string; status: string; sent_at: Date | null }>();
  (pg.Pool.prototype as any).query = async (sql: string, params: string[] = []) => {
    if (sql.includes('CREATE TABLE')) return { rowCount: 0, rows: [] };
    const key = `${params[0]}:${params[1]}`;
    if (sql.includes('INSERT INTO whatsapp_send_attempts')) {
      if (rows.has(key)) return { rowCount: 0, rows: [] };
      rows.set(key, { request_hash: params[2], message_id: params[3], status: 'prepared', sent_at: null });
      return { rowCount: 1, rows: [{ message_id: params[3] }] };
    }
    if (sql.includes('SELECT request_hash')) return { rowCount: rows.has(key) ? 1 : 0, rows: rows.has(key) ? [rows.get(key)] : [] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  try {
    process.env.CONNECTOR_ACCOUNT = 'personal';
    const conversationId = '111@s.whatsapp.net';
    const fileUrl = 'data:image/jpeg;base64,Zmlyc3Q=';
    // The exact hash the pre-viewOnce code produced: no trailing flag element.
    const legacyHash = createHash('sha256')
      .update(
        JSON.stringify([
          'media',
          conversationId,
          null,
          null,
          false,
          false,
          null,
          'image/jpeg',
          'image/jpeg',
        ])
      )
      .update('\0')
      .update(fileUrl)
      .digest('hex');
    const base = { conversationId, fileUrl, asSticker: false, asGif: false };
    const normal = await reserveMediaSend({ ...base, token: 'vo-normal' });
    assert.equal(
      rows.get(`personal:${createHash('sha256').update('vo-normal').digest('hex')}`)?.request_hash,
      legacyHash,
      'a normal media reservation keeps the byte-identical legacy hash'
    );
    const viewOnce = await reserveMediaSend({ ...base, token: 'vo-once', viewOnce: true });
    const onceRow = rows.get(`personal:${createHash('sha256').update('vo-once').digest('hex')}`);
    assert.ok(onceRow && onceRow.request_hash !== legacyHash, 'viewOnce changes the fingerprint');
    // Reusing the one token across the two spellings is a conflict, not a replay.
    assert.equal((await reserveMediaSend({ ...base, token: 'vo-once' })).state, 'conflict');
    assert.equal((await reserveMediaSend({ ...base, token: 'vo-normal', viewOnce: true })).state, 'conflict');
    // The same viewOnce bytes reserve identically on a fresh token.
    const repeat = await reserveMediaSend({ ...base, token: 'vo-once-2', viewOnce: true });
    assert.equal(
      rows.get(`personal:${createHash('sha256').update('vo-once-2').digest('hex')}`)?.request_hash,
      onceRow!.request_hash,
      'viewOnce fingerprints deterministically'
    );
    assert.equal(normal.state, 'claimed');
    assert.equal(viewOnce.state, 'claimed');
    assert.equal(repeat.state, 'claimed');
  } finally {
    (pg.Pool.prototype as any).query = original;
    if (previousAccount === undefined) delete process.env.CONNECTOR_ACCOUNT;
    else process.env.CONNECTOR_ACCOUNT = previousAccount;
  }
});

test('the media route validates viewOnce before spending a token and echoes it back', async () => {
  const original = pg.Pool.prototype.query;
  const previousAccount = process.env.CONNECTOR_ACCOUNT;
  const previousEnabled = process.env.ENABLE_SENDING;
  const rows = new Map<string, { request_hash: string; message_id: string; status: string; sent_at: Date | null }>();
  let queries = 0;
  (pg.Pool.prototype as any).query = async (sql: string, params: string[] = []) => {
    queries++;
    if (sql.includes('CREATE TABLE')) return { rowCount: 0, rows: [] };
    const key = `${params[0]}:${params[1]}`;
    if (sql.includes('INSERT INTO whatsapp_send_attempts')) {
      if (rows.has(key)) return { rowCount: 0, rows: [] };
      rows.set(key, { request_hash: params[2], message_id: params[3], status: 'prepared', sent_at: null });
      return { rowCount: 1, rows: [{ message_id: params[3] }] };
    }
    if (sql.includes('SELECT request_hash')) return { rowCount: rows.has(key) ? 1 : 0, rows: rows.has(key) ? [rows.get(key)] : [] };
    if (sql.includes('UPDATE whatsapp_send_attempts')) {
      const row = rows.get(key);
      if (!row || row.message_id !== params[2]) return { rowCount: 0, rows: [] };
      if (sql.includes("SET status = 'pending'")) {
        if (row.status !== 'prepared') return { rowCount: 0, rows: [] };
        row.status = 'pending';
        return { rowCount: 1, rows: [{ message_id: row.message_id }] };
      }
      if (row.status !== 'pending') return { rowCount: 0, rows: [] };
      row.status = 'sent';
      row.sent_at = new Date('2026-01-01T00:00:00Z');
      return { rowCount: 1, rows: [{ sent_at: row.sent_at }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  const mediaCalls: Array<{ url: string; options: any }> = [];
  let voiceCalls = 0;
  const app = express();
  app.use(express.json());
  app.use(
    createRouter(
      {
        isConnected: () => true,
        getCachedState: () => 'CONNECTED',
        sendFile: async (_chat: string, url: string, _caption: string, options: any) => {
          mediaCalls.push({ url, options });
          await options.beforeSend?.();
          return options.messageId || 'direct-media';
        },
        sendVoice: async () => {
          voiceCalls++;
          return 'voice-x';
        },
      } as any,
      { getCurrentQR: () => null } as any,
      'vo-secret'
    )
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    process.env.CONNECTOR_ACCOUNT = 'personal';
    process.env.ENABLE_SENDING = 'true';
    const address = server.address() as { port: number };
    async function post(path: string, body: Record<string, unknown>) {
      const timestamp = Math.floor(Date.now() / 1000);
      return fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-connector-timestamp': String(timestamp),
          'x-connector-signature': generateHMACSignature(body, timestamp, 'vo-secret'),
        },
        body: JSON.stringify(body),
      });
    }
    const base = { conversationId: '111@s.whatsapp.net' };

    const once = await post('/messages/media/send', {
      ...base,
      sendToken: 'vo-http-1',
      fileUrl: 'data:image/jpeg;base64,YQ==',
      viewOnce: true,
    });
    assert.equal(once.status, 200);
    const onceBody = (await once.json()) as Record<string, unknown>;
    assert.equal(onceBody.sent, true);
    assert.equal(onceBody.viewOnce, true, 'the response echoes the play-once flag');
    assert.equal(mediaCalls.at(-1)!.options.viewOnce, true);
    assert.ok(queries > 0);

    const queriesBefore = queries;
    const mediaCallsBefore = mediaCalls.length;
    const rejected: Array<[string, unknown]> = [
      ['/messages/media/send', { ...base, sendToken: 'vo-http-2', fileUrl: 'data:image/jpeg;base64,YQ==', viewOnce: 'yes' }],
      ['/messages/media/send', { ...base, sendToken: 'vo-http-3', fileUrl: 'data:image/webp;base64,YQ==', kind: 'sticker', viewOnce: true }],
      ['/messages/media/send', { ...base, sendToken: 'vo-http-4', fileUrl: 'data:video/quicktime;base64,YQ==', kind: 'gif', viewOnce: true }],
      ['/messages/media/send', { ...base, sendToken: 'vo-http-5', fileUrl: 'data:image/tiff;base64,YQ==', viewOnce: true }],
      ['/messages/media/send', { ...base, sendToken: 'vo-http-6', fileUrl: 'data:video/3gpp;base64,YQ==', viewOnce: true }],
      ['/messages/audio', { ...base, sendToken: 'vo-http-7', audioBase64: 'YQ==', viewOnce: true }],
      ['/messages/audio', { ...base, sendToken: 'vo-http-8', audioBase64: 'YQ==', viewOnce: 1 }],
      ['/messages/sticker', { ...base, fileUrl: 'data:image/webp;base64,YQ==', viewOnce: true }],
      ['/messages/gif', { ...base, fileUrl: 'data:video/mp4;base64,YQ==', viewOnce: 1 }],
    ];
    for (const [path, body] of rejected) {
      const response = await post(path, body as Record<string, unknown>);
      assert.equal(response.status, 400, `${path} ${JSON.stringify(body)} must be refused`);
      assert.match(JSON.stringify(await response.json()), /viewOnce/);
    }
    assert.equal(queries, queriesBefore, 'a refused play-once request never touches the token store');
    assert.equal(mediaCalls.length, mediaCallsBefore, 'a refused play-once request never reaches sendFile');
    assert.equal(voiceCalls, 0, 'a refused voice request never reaches sendVoice');

    const plain = await post('/messages/media/send', {
      ...base,
      sendToken: 'vo-http-9',
      fileUrl: 'data:image/png;base64,YQ==',
    });
    assert.equal(plain.status, 200);
    assert.equal('viewOnce' in ((await plain.json()) as Record<string, unknown>), false);
    assert.equal(mediaCalls.at(-1)!.options.viewOnce, false, 'absent viewOnce stays a plain send');
  } finally {
    (pg.Pool.prototype as any).query = original;
    if (previousAccount === undefined) delete process.env.CONNECTOR_ACCOUNT;
    else process.env.CONNECTOR_ACCOUNT = previousAccount;
    if (previousEnabled === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = previousEnabled;
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  }
});
