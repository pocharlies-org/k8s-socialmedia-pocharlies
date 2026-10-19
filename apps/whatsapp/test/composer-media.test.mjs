import test from 'node:test';
import assert from 'node:assert/strict';
import {planAttachmentSends, stopCameraTracks} from '../public/composer-media.mjs';

const file = (name, type) => ({name, type});

test('one caption and reply belong to the first compatible file in a mixed batch', () => {
  const audio = file('audio.mp3', 'audio/mpeg');
  const image = file('foto.jpg', 'image/jpeg');
  const document = file('nota.txt', 'text/plain');
  assert.deepEqual(planAttachmentSends([audio, image, document], '  Hola  ', 'original'), [
    {file:audio, caption:'', replyTo:''},
    {file:image, caption:'Hola', replyTo:'original'},
    {file:document, caption:'', replyTo:''},
  ]);
});

test('text accompanying only audio is a separate message; each audio has no caption', () => {
  const first = file('uno.mp3', 'audio/mpeg');
  const second = file('dos.ogg', 'audio/ogg');
  assert.deepEqual(planAttachmentSends([first, second], 'Escucha esto', 'original'), [
    {text:'Escucha esto', replyTo:'original'},
    {file:first, caption:'', replyTo:''},
    {file:second, caption:'', replyTo:''},
  ]);
});

test('camera cleanup stops every acquired track', () => {
  const stopped = [];
  stopCameraTracks({getTracks: () => [1, 2].map(id => ({stop: () => stopped.push(id)}))});
  assert.deepEqual(stopped, [1, 2]);
  assert.doesNotThrow(() => stopCameraTracks(null));
});
