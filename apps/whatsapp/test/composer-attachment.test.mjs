import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentCaptionError, attachmentError, filesFromClipboard, MAX_ATTACHMENT_BYTES, uploadPayload } from '../public/composer-attachment.mjs';

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
