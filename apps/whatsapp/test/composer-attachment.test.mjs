import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentCaptionError, attachmentError, canViewOnce, filesFromClipboard, MAX_ATTACHMENT_BYTES, readUploadQuality, readUploadQualityPreference, uploadPayload, writeUploadQualityPreference } from '../public/composer-attachment.mjs';

test('clipboard image and document items become attachments without requiring a file picker', () => {
  const image = { name: 'captura.png', type: 'image/png', size: 24 };
  const document = { name: 'informe.pdf', type: 'application/pdf', size: 32 };
  const clipboard = { items: [
    { kind: 'string', getAsFile: () => null },
    { kind: 'file', getAsFile: () => image },
    { kind: 'file', getAsFile: () => document },
  ], files: [image, document] };
  assert.deepEqual(filesFromClipboard(clipboard), [image, document]);
  assert.deepEqual(filesFromClipboard({ items: [], files: [document] }), [document]);
  assert.deepEqual(filesFromClipboard({ items: [{ kind: 'string' }], files: [] }), []);
});

test('attachment and typed text form one media upload with a caption', () => {
  const file = { name: 'foto.jpg', type: 'image/jpeg', size: 8 };
  assert.equal(attachmentError(file), '');
  assert.deepEqual(uploadPayload(file, 'AQID', '  Nos vemos  ', 'message-uuid'), {
    name: 'foto.jpg', mimeType: 'image/jpeg', data: 'AQID', voice: false, caption: 'Nos vemos', replyToMessageId: 'message-uuid',
  });
  assert.equal(attachmentError({ name: 'foto.jpg', type: 'image/jpeg', size: MAX_ATTACHMENT_BYTES + 1 }), 'El archivo supera el límite de 10 MiB.');
});

test('view once is offered only for photos and videos and travels with that upload', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime']) {
    assert.equal(canViewOnce({type}), true, type);
  }
  for (const type of ['image/gif', 'audio/mpeg', 'application/pdf']) {
    assert.equal(canViewOnce({type}), false, type);
  }
  const photo = {name:'private.jpg', type:'image/jpeg'};
  assert.equal(uploadPayload(photo, 'AQID', '', '', 'source', true).viewOnce, true);
  assert.equal('viewOnce' in uploadPayload(photo, 'AQID'), false);
});

test('Safari recordings with AAC codec parameters can be staged', () => {
  for (const type of ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4; codecs="mp4a.40.2"', 'audio/webm;codecs=opus']) {
    assert.equal(attachmentError({name: 'voice.m4a', type, size: 24}), '');
  }
  for (const type of ['audio/mp4;codecs="mp4a.40.2', 'audio/mp4;codecs=mp4a.40.2;evil=yes']) {
    assert.notEqual(attachmentError({name: 'voice.m4a', type, size: 24}), '');
  }
});
test('unsupported files cannot be staged; document MIME must match extension', () => {
  assert.equal(attachmentError({ name: 'script.js', type: 'text/javascript', size: 10 }), 'Este tipo de archivo no se puede enviar.');
  assert.equal(attachmentError({ name: 'informe.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 10 }), '');
  assert.equal(attachmentError({ name: 'informe.pdf', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 10 }), 'El nombre del archivo no coincide con su tipo.');
  assert.equal(attachmentError({ name: '', type: 'image/png', size: 10 }), '');
  assert.equal(uploadPayload({ name: '', type: 'image/png' }, 'AQID').name, 'imagen.png');
  assert.equal(attachmentError({ name: 'texto.txt', type: 'text/plain', size: 10 }), '');
});

test('audio with text is blocked while a caption on image remains valid', () => {
  assert.match(attachmentCaptionError({ type: 'audio/mpeg' }, 'Hola'), /no admite texto junto a un audio/);
  assert.equal(attachmentCaptionError({ type: 'audio/mpeg' }, '  '), '');
  assert.equal(attachmentCaptionError({ type: 'image/png' }, 'Hola'), '');
});

test('upload quality is chosen per account for still images and captured in the upload payload', () => {
  const values = new Map([['wa-media-upload-quality', JSON.stringify({personal:'hd', secondary:'standard'})]]);
  const storage = {getItem: key => values.get(key) || null};
  const photo = {name:'foto.jpg', type:'image/jpeg'};
  assert.equal(readUploadQuality(storage, 'personal', photo), 'hd');
  assert.equal(readUploadQuality(storage, 'secondary', photo), 'standard');
  assert.equal(readUploadQuality(storage, 'other', photo), 'standard');
  assert.equal(readUploadQuality(storage, 'personal', {name:'clip.mp4', type:'video/mp4'}), 'source');
  assert.equal(readUploadQuality(storage, 'personal', {name:'anim.gif', type:'image/gif'}), 'source');
  assert.equal(readUploadQuality(storage, 'personal', {name:'file.pdf', type:'application/pdf'}), 'source');
  assert.equal(uploadPayload(photo, 'AQID', '', '', 'hd').quality, 'hd');
  const mutableStorage = {getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value)};
  assert.equal(writeUploadQualityPreference(mutableStorage, 'secondary', 'hd'), true);
  assert.equal(readUploadQualityPreference(mutableStorage, 'secondary'), 'hd');
  assert.equal(readUploadQualityPreference(mutableStorage, 'personal'), 'hd');
  assert.equal(writeUploadQualityPreference(mutableStorage, 'secondary', 'source'), false);
});
