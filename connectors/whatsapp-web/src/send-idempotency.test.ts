import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import express from 'express';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';
import { claimSendAttempt, confirmTextSend, reserveMediaSend, reserveTextSend, reserveVoiceSend, SendAlreadyClaimedError } from './send-idempotency';

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
