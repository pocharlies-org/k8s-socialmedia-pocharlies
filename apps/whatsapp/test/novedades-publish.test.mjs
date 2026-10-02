import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  STATUS_CAPTION_MAX,
  STATUS_COLORS,
  STATUS_IMAGE_MIME_TYPES,
  STATUS_MEDIA_MAX_BYTES,
  STATUS_RECIPIENTS_MAX,
  STATUS_TEXT_MAX,
  STATUS_VIDEO_MIME_TYPES,
  normalizeStatusContact,
  statusAudienceSummary,
  statusContactAvatarUrl,
  statusDraftRecipients,
  statusFailureIsUncertain,
  statusFormatHint,
  statusMediaError,
  statusPayload,
  statusRecipientFromContact,
  statusSendOutcome,
  validateStatusDraft,
} from '../public/novedades-ui.mjs';

// The DTO rows below are copied from lib/contact-directory.mjs `publicEntry`,
// which exposes `key` (phone digits or `lid:<digits>`), `phone` only when a real
// number was synced, and an account-scoped avatar proxy path.
const account = 'personal';
const savedContact = {
  key: '34600111222',
  label: 'Ana Ruiz',
  sublabel: '+34600111222',
  kind: 'chat',
  chatId: '34600111222@s.whatsapp.net',
  phone: '+34600111222',
  avatarUrl: '/api/contacts/34600111222%40s.whatsapp.net/avatar?account=personal',
  hasChat: true,
  archived: false,
  canOpen: true,
  canStart: false,
};
const privateContact = { key: 'lid:987654321', label: 'ID privado', sublabel: 'LID ···321', kind: 'private', chatId: null, phone: null, avatarUrl: null };

test('a synced phone becomes an @s.whatsapp.net recipient and a lid key an @lid one', () => {
  assert.deepEqual(statusRecipientFromContact(savedContact), { jid: '34600111222@s.whatsapp.net', realm: 'phone', digits: '34600111222', reason: '' });
  assert.deepEqual(statusRecipientFromContact(privateContact), { jid: '987654321@lid', realm: 'lid', digits: '987654321', reason: '' });
});

test('the number always wins and an unusable identifier is refused, never guessed', () => {
  assert.equal(statusRecipientFromContact({ key: 'lid:987654321', phone: '+34 600 11 12 22' }).jid, '34600111222@s.whatsapp.net');
  assert.equal(statusRecipientFromContact({ key: '34600111222', phone: '+34600111222' }).jid, '34600111222@s.whatsapp.net');
  // Too short to be a number and not a lid key: nothing to address.
  assert.equal(statusRecipientFromContact({ key: '999', phone: '+999' }).jid, '');
  assert.match(statusRecipientFromContact({ key: '999', phone: '+999' }).reason, /número sincronizado/u);
  assert.equal(statusRecipientFromContact({ key: '111@newsletter' }).jid, '');
  assert.equal(statusRecipientFromContact({ key: 'lid:12ab' }).jid, '');
  assert.equal(statusRecipientFromContact({}).jid, '');
});

test('directory rows normalize to labelled recipients with an account-scoped avatar', () => {
  const entry = normalizeStatusContact(savedContact, { account });
  assert.equal(entry.jid, '34600111222@s.whatsapp.net');
  assert.equal(entry.label, 'Ana Ruiz');
  assert.equal(entry.hint, '+34600111222');
  assert.equal(entry.addressable, true);
  assert.equal(entry.avatarUrl, '/api/contacts/34600111222%40s.whatsapp.net/avatar?account=personal');

  const privateEntry = normalizeStatusContact(privateContact, { account });
  assert.equal(privateEntry.jid, '987654321@lid');
  assert.equal(privateEntry.hint, 'ID privado ···321');

  // A row without a stored name is named by its identifier, never invented.
  const nameless = normalizeStatusContact({ key: '34600999888', label: null, phone: '+34600999888' }, { account });
  assert.equal(nameless.label, '+34600999888');
  const namelessLid = normalizeStatusContact({ key: 'lid:555000111', label: null, phone: null }, { account });
  assert.equal(namelessLid.label, 'ID privado ···111');

  const broken = normalizeStatusContact({ key: '999', phone: '+999', label: 'Raro' }, { account });
  assert.equal(broken.addressable, false);
  assert.equal(broken.jid, '');
  assert.match(broken.hint, /número sincronizado/u);

  assert.equal(normalizeStatusContact(null, { account }), null);
  assert.equal(normalizeStatusContact({ label: 'Sin key' }, { account }), null);
});

test('only this account\'s contact-avatar proxy is rendered', () => {
  assert.equal(statusContactAvatarUrl('/api/contacts/p-1/avatar?account=personal', 'personal'), '/api/contacts/p-1/avatar?account=personal');
  assert.equal(statusContactAvatarUrl('/api/contacts/p-1/avatar?account=other', 'personal'), '');
  assert.equal(statusContactAvatarUrl('/api/novedades/media?account=personal', 'personal'), '');
  assert.equal(statusContactAvatarUrl('https://cdn.example/avatar.jpg?account=personal', 'personal'), '');
  assert.equal(statusContactAvatarUrl('not a url', 'personal'), '');
});

test('an empty audience is the first thing that stops a status', () => {
  const draft = { type: 'text', text: 'Hola', recipients: [] };
  assert.deepEqual(validateStatusDraft(draft), { field: 'recipients', message: 'Elige al menos un destinatario: el estado no se envía a toda la agenda.' });
  assert.equal(validateStatusDraft({ ...draft, recipients: ['34600111222@s.whatsapp.net'] }), null);
  const crowded = Array.from({ length: STATUS_RECIPIENTS_MAX + 1 }, (_, index) => `3460000000${index}@s.whatsapp.net`);
  assert.equal(validateStatusDraft({ type: 'text', text: 'Hola', recipients: crowded }).field, 'recipients');
});

test('a text status needs text and a media status needs a supported file', () => {
  const recipients = ['34600111222@s.whatsapp.net'];
  assert.equal(validateStatusDraft({ type: 'text', text: '   ', recipients }).field, 'text');
  assert.equal(validateStatusDraft({ type: 'image', text: '', recipients }).field, 'media');
  assert.equal(validateStatusDraft({ type: 'image', recipients, media: { name: 'foto.jpg', size: 2048, type: 'image/jpeg' } }), null);
  assert.equal(validateStatusDraft({ type: 'video', recipients, media: { name: 'clip.mp4', size: 2048, type: 'video/mp4' } }), null);
});

test('the 10 MiB cap and the accepted formats are refused before reading the file', () => {
  const oversize = { name: 'grande.jpg', size: STATUS_MEDIA_MAX_BYTES + 1, type: 'image/jpeg' };
  assert.match(statusMediaError(oversize, 'image'), /10 MiB/u);
  assert.equal(statusMediaError({ name: 'justo.jpg', size: STATUS_MEDIA_MAX_BYTES, type: 'image/jpeg' }, 'image'), '');
  assert.match(statusMediaError({ name: 'vacio.png', size: 0, type: 'image/png' }, 'image'), /vacío/u);
  assert.match(statusMediaError({ name: 'clips.gif', size: 4096, type: 'image/gif' }, 'image'), /Admitidos: JPG, PNG o WEBP/u);
  assert.match(statusMediaError({ name: 'audio.mp3', size: 4096, type: 'audio/mpeg' }, 'video'), /Admitidos: MP4, 3GP o MOV/u);
  // A file dropped in without a MIME type is judged by its extension only.
  assert.equal(statusMediaError({ name: 'foto.JPG', size: 4096, type: '' }, 'image'), '');
  assert.match(statusMediaError({ name: 'captura.unknown', size: 4096, type: '' }, 'image'), /Formato no admitido/u);
  assert.equal(statusFormatHint('video'), 'MP4, 3GP o MOV · hasta 10 MiB');
});

test('text limits follow the state type: 700 for a status, 1024 for a caption', () => {
  const recipients = ['34600111222@s.whatsapp.net'];
  assert.equal(STATUS_TEXT_MAX, 700);
  assert.equal(STATUS_CAPTION_MAX, 1024);
  assert.equal(validateStatusDraft({ type: 'text', text: 'a'.repeat(STATUS_TEXT_MAX), recipients }), null);
  assert.equal(validateStatusDraft({ type: 'text', text: 'a'.repeat(STATUS_TEXT_MAX + 1), recipients }).field, 'text');
  assert.equal(validateStatusDraft({ type: 'image', text: 'a'.repeat(STATUS_CAPTION_MAX), recipients, media: { name: 'f.png', size: 10, type: 'image/png' } }), null);
  assert.equal(validateStatusDraft({ type: 'image', text: 'a'.repeat(STATUS_CAPTION_MAX + 1), recipients, media: { name: 'f.png', size: 10, type: 'image/png' } }).field, 'text');
});

test('the payload carries only the fields the status route reads', () => {
  const draft = {
    type: 'text',
    text: '  Buenas noches  ',
    recipients: [{ jid: '34600111222@s.whatsapp.net', label: 'Ana' }, { jid: '987654321@lid', label: 'Privado' }, '34600111222@s.whatsapp.net'],
    backgroundColor: STATUS_COLORS[2].id,
    font: 4,
  };
  assert.deepEqual(statusPayload(draft), {
    type: 'text',
    recipients: ['34600111222@s.whatsapp.net', '987654321@lid'],
    text: 'Buenas noches',
    backgroundColor: STATUS_COLORS[2].hex,
    font: 4,
  });
  assert.deepEqual(statusDraftRecipients(draft), ['34600111222@s.whatsapp.net', '987654321@lid']);
  assert.match(statusPayload({ ...draft, backgroundColor: 'no-existe' }).backgroundColor, /^#[0-9a-f]{6}$/u);
  assert.equal(statusPayload({ ...draft, font: 99 }).font, 1);
  assert.equal(statusPayload({ ...draft, recipients: [] }), null);
  assert.equal(statusPayload({ ...draft, text: '   ' }), null);
  assert.equal(statusPayload({ ...draft, text: 'a'.repeat(STATUS_TEXT_MAX + 1) }), null);
});

test('a media payload sends plain base64 and keeps background and font out', () => {
  const draft = {
    type: 'video',
    text: 'Desde el móvil',
    recipients: [{ jid: '34600111222@s.whatsapp.net' }],
    media: { name: 'clip.mp4', size: 8, type: 'video/mp4', base64: 'aGVsbG8=' },
    backgroundColor: STATUS_COLORS[0].id,
    font: 3,
  };
  assert.deepEqual(statusPayload(draft), {
    type: 'video',
    recipients: ['34600111222@s.whatsapp.net'],
    text: 'Desde el móvil',
    data: 'aGVsbG8=',
    mimeType: 'video/mp4',
  });
  assert.deepEqual(Object.keys(statusPayload({ ...draft, text: '  ' })), ['type', 'recipients', 'data', 'mimeType']);
  // Without the decoded bytes there is nothing to send.
  assert.equal(statusPayload({ ...draft, media: { name: 'clip.mp4', size: 8, type: 'video/mp4' } }), null);
});

test('the confirmation lists each chosen contact once', () => {
  const summary = statusAudienceSummary([
    { jid: '34600111222@s.whatsapp.net', label: 'Ana', hint: '+34600111222' },
    '34600111222@s.whatsapp.net',
    { jid: '987654321@lid', label: 'Privado', hint: 'ID privado ···321' },
  ], 1);
  assert.equal(summary.total, 2);
  assert.equal(summary.hidden, 1);
  assert.deepEqual(summary.lines, [{ jid: '34600111222@s.whatsapp.net', label: 'Ana', hint: '+34600111222' }]);
  assert.deepEqual(statusAudienceSummary(['111@lid'], 6).lines, [{ jid: '111@lid', label: 'ID privado ···111', hint: 'ID privado' }]);
});

test('only a confirmed send with a message id may clear the draft', () => {
  assert.equal(statusSendOutcome({ account, confirmed: true, type: 'text', recipients: ['1@s.whatsapp.net'], messageId: 'ABCD' }, account), 'sent');
  assert.equal(statusSendOutcome({}, account), 'uncertain');
  assert.equal(statusSendOutcome(null, account), 'uncertain');
  assert.equal(statusSendOutcome(undefined, account), 'uncertain');
  assert.equal(statusSendOutcome({ account, confirmed: true }, account), 'uncertain');
  assert.equal(statusSendOutcome({ account, confirmed: false, messageId: 'ABCD' }, account), 'uncertain');
  assert.equal(statusSendOutcome({ account: 'other', confirmed: true, messageId: 'ABCD' }, account), 'stale');
});

test('a settled failure and an unknown outcome are told apart before retrying', () => {
  assert.equal(statusFailureIsUncertain({ code: 'DELIVERY_UNCONFIRMED', message: 'Estado de entrega desconocido; no reintentar automáticamente' }), true);
  assert.equal(statusFailureIsUncertain({ code: 'UNSUPPORTED_UPSTREAM', message: 'WhatsApp provider does not support this operation' }), true);
  assert.equal(statusFailureIsUncertain({ code: 'STATUS_PUBLISH_REJECTED', message: 'El conector rechazó el estado' }), false);
  assert.equal(statusFailureIsUncertain({ code: 'MEDIA_TOO_LARGE', message: 'El archivo supera el límite' }), false);
  assert.equal(statusFailureIsUncertain({ code: 'INVALID_RECIPIENT', message: 'Destinatario no válido' }), false);
  assert.equal(statusFailureIsUncertain({ status: 503, message: 'El conector no responde' }), true);
  assert.equal(statusFailureIsUncertain({ status: 400, message: 'Falta el texto' }), false);
  assert.equal(statusFailureIsUncertain(new Error('Estado de entrega desconocido; no reintentar automáticamente')), true);
  assert.equal(statusFailureIsUncertain(new Error('Sending is disabled')), false);
  assert.equal(statusFailureIsUncertain(new Error('Error del servidor (502).')), true);
  assert.equal(statusFailureIsUncertain(new Error('Se agotó el tiempo de espera del agente. Comprueba el chat antes de repetir una acción.')), true);
  assert.equal(statusFailureIsUncertain(new TypeError('Failed to fetch')), true);
  // Shapes the proxy really answers with: a connector 4xx proves the refusal
  // reached the dispatch, every silence after the dispatch does not.
  assert.equal(statusFailureIsUncertain({ code: 'STATUS_PUBLISH_REJECTED', status: 400, message: 'WhatsApp connector refused the status publish (HTTP 400)' }), false);
  assert.equal(statusFailureIsUncertain({ code: 'DELIVERY_UNCONFIRMED', status: 502, message: 'Estado de entrega desconocido; el estado puede haberse publicado. No reintentar automáticamente.' }), true);
  // A 5xx that still carries the refusal code proves nothing: the label was
  // assigned before anyone knew the outcome.
  assert.equal(statusFailureIsUncertain({ code: 'STATUS_PUBLISH_REJECTED', status: 502, message: 'WhatsApp connector refused the status publish (HTTP 502)' }), true);
  assert.equal(statusFailureIsUncertain({ code: 'STATUS_PUBLISH_REJECTED', message: 'WhatsApp connector refused the status publish' }), false);
  assert.equal(statusFailureIsUncertain({ outcomeUncertain: true, code: 'STATUS_PUBLISH_REJECTED', status: 400, message: 'WhatsApp connector refused the status publish (HTTP 400)' }), true);
  // The send gate and a missing account secret refuse before the request is
  // handed over, so the 503 must not read as a status that may already be live.
  assert.equal(statusFailureIsUncertain({ status: 503, message: 'Connector credentials unavailable' }), false);
  assert.equal(statusFailureIsUncertain({ status: 403, message: 'Sending is disabled' }), false);
  // A phone number in the message must not be read as an HTTP status.
  assert.equal(statusFailureIsUncertain(new Error('Destinatario no válido: +34600500123')), false);
  assert.equal(statusFailureIsUncertain(new Error('')), true);
  // Safari names a dead connection `Load failed` and says nothing more; a
  // message we cannot place stays uncertain, because "check before retrying" is
  // the only answer that cannot publish the same status twice.
  assert.equal(statusFailureIsUncertain(new Error('Load failed')), true);
  assert.equal(statusFailureIsUncertain(new Error('El conector devolvió una respuesta rara')), true);
});

test('the composer limits agree with the connector constants they must match', async () => {
  const source = await readFile(new URL('../../../connectors/whatsapp-web/src/baileys-client.ts', import.meta.url), 'utf8');
  const constant = name => {
    const raw = new RegExp(`export const ${name} = ([^;\\n]+)`).exec(source)?.[1]?.trim();
    assert.ok(raw, `el conector ya no expone ${name}`);
    // Constants are written as plain numbers or as a product like 10 * 1024 * 1024.
    return /^[\d *+]+$/.test(raw) ? Number(Function(`"use strict"; return (${raw});`)()) : Number(raw);
  };
  const setMembers = name => {
    const literal = new RegExp(`export const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(source)?.[1] || '';
    return [...literal.matchAll(/'([^']+)'/g)].map(match => match[1]);
  };
  assert.equal(constant('NOVEDADES_STATUS_MEDIA_MAX_BYTES'), STATUS_MEDIA_MAX_BYTES);
  assert.equal(constant('NOVEDADES_STATUS_RECIPIENTS_MAX'), STATUS_RECIPIENTS_MAX);
  assert.equal(constant('NOVEDADES_STATUS_FONT_MIN'), 1);
  assert.equal(constant('NOVEDADES_STATUS_FONT_MAX'), 5);
  assert.ok(STATUS_IMAGE_MIME_TYPES.every(mime => setMembers('NOVEDADES_STATUS_IMAGE_MIME_TYPES').includes(mime)));
  assert.ok(STATUS_VIDEO_MIME_TYPES.every(mime => setMembers('NOVEDADES_STATUS_VIDEO_MIME_TYPES').includes(mime)));
});
