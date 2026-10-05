/**
 * INFRA-592: the audio payload of a media send. OGG/Opus is WhatsApp's voice
 * note and must go out with `ptt: true`; sent as a plain audio message
 * (`ptt: false`) WhatsApp accepts and stores it but never delivers it
 * (measured 05-10: two AUDIO sends stuck at status `sent`; the same clip as
 * a voice note reached `read`). Other audio keeps the audio-message form.
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { audioMessagePayload } from './media-quality';

const buf = Buffer.from('opusbytes');

test('ogg audio is the native voice note: ptt true, codecs=opus mimetype', () => {
  assert.deepEqual(audioMessagePayload('audio/ogg', buf), {
    audio: buf,
    mimetype: 'audio/ogg; codecs=opus',
    ptt: true,
  });
  assert.deepEqual(audioMessagePayload('audio/ogg; codecs=opus', buf), {
    audio: buf,
    mimetype: 'audio/ogg; codecs=opus',
    ptt: true,
  });
  assert.equal(audioMessagePayload('AUDIO/OGG; Codecs=Opus', buf).ptt, true, 'case does not matter');
});

test('other audio keeps the audio-message form and its own mimetype', () => {
  assert.deepEqual(audioMessagePayload('audio/mpeg', buf), {
    audio: buf,
    mimetype: 'audio/mpeg',
    ptt: false,
  });
  assert.deepEqual(audioMessagePayload('audio/mp4', buf), {
    audio: buf,
    mimetype: 'audio/mp4',
    ptt: false,
  });
});

test('no caption key: WhatsApp AudioMessage has no caption and baileys drops it', () => {
  assert.equal('caption' in audioMessagePayload('audio/ogg', buf), false);
  assert.equal('caption' in audioMessagePayload('audio/mpeg', buf), false);
});
