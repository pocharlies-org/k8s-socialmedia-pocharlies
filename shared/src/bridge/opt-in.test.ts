import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTrackingOptInControlMessage } from './opt-in';

// Round-trip guard: these strings are the VERBATIM output of
// trackingWhatsAppOptInMessage (skirmshop-labels
// packages/tracking-optin/src/optin-message.ts) — if a builder changes and
// this mirror stops recognizing it, the CTA would wake a case session again.
const ES_CTA =
  'Hola Skirmshop, quiero recibir seguimiento por WhatsApp del pedido ORD18629. Enlace: https://track.skirmshop.es/labels/track/AVf5DGrrpc8gahvAXHMKSmZ_y78bMxIIJGvzGUMoi4CdCOYmBdPdjTRjV460_30Upv0qorNCmFFP1wYwZIs#pickup';
const EN_CTA =
  'Hi Skirmshop, I want to receive tracking updates on WhatsApp for order ORD18629. Link: https://track.skirmshop.es/labels/track/AVf5DGrrpc8gahvAXHMKSmZ_y78bMxII';

test('every labels-owned surface is dropped', () => {
  for (const content of [
    ES_CTA,
    EN_CTA,
    // PUDO CTA (pre-checkout): template without ref or link.
    'Hola Skirmshop, quiero recibir seguimiento por WhatsApp de mi pedido',
    // Bare order ref (the ask-for-ref answer).
    'ORD18504',
    '#ORD18504',
    // Opt-out keywords.
    'baja',
    'STOP.',
    'unsubscribe !',
  ]) {
    assert.equal(isTrackingOptInControlMessage(content), true, content);
  }
});

test('ordinary conversation is never a surface', () => {
  for (const content of [
    // Ref mentioned inside a sentence: not anchored, not a bare ref.
    'Hola, quiero recibir seguimiento del pedido ORD18629, este enlace no me carga.',
    'mi pedido ORD18504 no llegó',
    'hola',
    '12',
    'stop no me escribas más por favor, quiero hablar con una persona sobre mi devolución',
    null,
    undefined,
    '',
    'x'.repeat(513),
  ]) {
    assert.equal(isTrackingOptInControlMessage(content), false, String(content));
  }
});
