import './test-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { WAMessage } from '@whiskeysockets/baileys';
import { declaredMediaBytes, inboundMediaMaxBytes } from './baileys-client';

// SC-6631: an inbound media bigger than the pod's memory OOM-killed the
// connector (MCPBackendOOMKilled). These guard the two halves of the cap:
// the declared-size skip and the configured bound (the stream cut itself is
// tested in novedades-reader.test.ts, readNovedadesMediaStream).

test('declaredMediaBytes reads fileLength from any media content', () => {
  const doc = { message: { documentMessage: { fileLength: 1234 } } } as unknown as WAMessage;
  assert.equal(declaredMediaBytes(doc), 1234);
  const video = { message: { videoMessage: { fileLength: '99' } } } as unknown as WAMessage;
  assert.equal(declaredMediaBytes(video), 99);
  const text = { message: { textMessage: { text: 'hola' } } } as WAMessage;
  assert.equal(declaredMediaBytes(text), 0);
});

test('inboundMediaMaxBytes defaults to 512 MiB and honors the env override', () => {
  const saved = process.env.WA_MAX_INBOUND_MEDIA_BYTES;
  try {
    delete process.env.WA_MAX_INBOUND_MEDIA_BYTES;
    assert.equal(inboundMediaMaxBytes(), 512 * 1024 * 1024);
    process.env.WA_MAX_INBOUND_MEDIA_BYTES = '1024';
    assert.equal(inboundMediaMaxBytes(), 1024);
    process.env.WA_MAX_INBOUND_MEDIA_BYTES = 'nope';
    assert.equal(inboundMediaMaxBytes(), 512 * 1024 * 1024);
    process.env.WA_MAX_INBOUND_MEDIA_BYTES = '0';
    assert.equal(inboundMediaMaxBytes(), 512 * 1024 * 1024);
  } finally {
    if (saved === undefined) delete process.env.WA_MAX_INBOUND_MEDIA_BYTES;
    else process.env.WA_MAX_INBOUND_MEDIA_BYTES = saved;
  }
});
