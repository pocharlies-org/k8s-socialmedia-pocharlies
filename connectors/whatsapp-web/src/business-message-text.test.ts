import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import { businessMessageText, BUSINESS_MESSAGE_TYPES } from './business-message-text';
import { BaileysClient } from './baileys-client';
import { quotedPreview, quotedReply } from './ingest-extras';
import { hasCapturedPayloadContent, hasUserMessageContent, UNAVAILABLE_MESSAGE_TYPES } from './message-preservation';

// Encode/decode fixtures against the installed rc13 schema, not invented SDK shapes.
const wire = (message: proto.IMessage): proto.IMessage =>
  proto.Message.decode(proto.Message.encode(message).finish());

test('hydrated business template keeps visible title/body/footer/buttons and quoted variants', () => {
  const hydrated = {
    hydratedTitleText: 'Appointment', hydratedContentText: 'Please confirm your visit',
    hydratedFooterText: 'Customer service', templateId: 'internal-template',
    hydratedButtons: [
      { quickReplyButton: { displayText: 'CONFIRMAR', id: 'internal-confirm' } },
      { urlButton: { displayText: 'Details', url: 'https://internal.example' } },
      { callButton: { displayText: 'Call', phoneNumber: '123456' } },
    ],
  };
  for (const key of ['hydratedTemplate', 'hydratedFourRowTemplate'] as const) {
    const message = wire({ templateMessage: { [key]: hydrated } });
    const expected = 'Appointment\nPlease confirm your visit\nCustomer service\nCONFIRMAR\nDetails\nCall';
    assert.deepEqual(businessMessageText(message), { type: 'TEMPLATEMESSAGE', text: expected });
    assert.deepEqual(quotedPreview({ ephemeralMessage: { message } }), { type: 'TEMPLATEMESSAGE', text: expected });
  }
});

test('buttons and native-flow messages preserve visible labels, never arbitrary routing values', () => {
  const message = wire({ buttonsMessage: {
    text: 'Header', contentText: 'Are you coming?', footerText: 'Reception',
    buttons: [{ buttonId: 'opaque', buttonText: { displayText: 'YES' } },
      { nativeFlowInfo: { name: 'quick_reply', paramsJson: '{"display_text":"NO","id":"opaque"}' } }],
  } });
  assert.equal(businessMessageText(message)?.text, 'Header\nAre you coming?\nReception\nYES\nNO');
  assert.equal(businessMessageText(wire({ interactiveMessage: {
    header: { title: 'Visit' }, body: { text: 'Choose' }, footer: { text: 'Support' },
    nativeFlowMessage: { buttons: [{ name: 'quick_reply', buttonParamsJson: '{"display_text":"Confirm","id":"private"}' }] },
  } }))?.text, 'Visit\nChoose\nSupport\nConfirm');
});

test('list body and choices use labels; replies use displayed selection text only', () => {
  assert.equal(businessMessageText(wire({ listMessage: {
    title: 'Services', description: 'Select service', footerText: 'Support', buttonText: 'Open',
    sections: [{ title: 'Appointments', rows: [{ title: 'Visit', description: 'Morning', rowId: 'private-row' }] }],
  } }))?.text, 'Services\nSelect service\nSupport\nOpen\nAppointments\nVisit\nMorning');
  for (const key of ['buttonsResponseMessage', 'templateButtonReplyMessage'] as const) {
    assert.equal(businessMessageText(wire({ [key]: { selectedDisplayText: 'CONFIRMAR', selectedId: 'private', selectedButtonId: 'private' } }))?.text, 'CONFIRMAR');
  }
  assert.equal(businessMessageText(wire({ listResponseMessage: { title: 'Visit', description: 'Morning', singleSelectReply: { selectedRowId: 'private' } } }))?.text, 'Visit\nMorning');
  assert.equal(businessMessageText(wire({ interactiveResponseMessage: {
    nativeFlowResponseMessage: { name: 'quick_reply', paramsJson: '{"id":"private","title":"Selected service"}' },
  } }))?.text, 'Selected service');
});

test('missing labels, malformed/oversized JSON and HSM identifiers never masquerade as body', () => {
  const fixtures: proto.IMessage[] = [
    { templateButtonReplyMessage: { selectedId: 'private' } },
    { buttonsResponseMessage: { selectedButtonId: 'private' } },
    { listResponseMessage: { singleSelectReply: { selectedRowId: 'private' } } },
    { templateMessage: { fourRowTemplate: { content: { namespace: 'private', elementName: 'private', params: ['private'] } } } },
    ...['{', '{"id":"private","flow_token":"private"}', '["private"]', ' '.repeat(65537)].map(paramsJson => ({
      interactiveResponseMessage: { nativeFlowResponseMessage: { name: 'internal-name', paramsJson } },
    })),
  ];
  for (const fixture of fixtures) {
    const message = wire(fixture);
    const before = proto.Message.encode(message).finish();
    assert.equal(businessMessageText(message)?.text, null);
    assert.deepEqual(proto.Message.encode(message).finish(), before, 'parser preserves provider bytes');
  }
});

test('client projects original business type with text and distinguishes real provider placeholders', () => {
  const client = new BaileysClient('/tmp/unused-business-session', 'k'.repeat(16)) as any;
  const make = (message: proto.IMessage): WAMessage => ({ key: { id: 'M', remoteJid: '123@lid' }, message, messageTimestamp: 1 });
  const business = wire({ buttonsResponseMessage: { selectedDisplayText: 'NO', selectedButtonId: 'private' } });
  assert.equal(client.convertMessage(make(business)).messageType, 'BUTTONSRESPONSEMESSAGE');
  assert.equal(client.convertMessage(make(business)).content, 'NO');
  const reply = wire({ viewOnceMessageV2: { message: { buttonsResponseMessage: {
    selectedDisplayText: 'NO', contextInfo: { stanzaId: 'ORIGINAL', participant: '456@lid',
      isForwarded: true, quotedMessage: { templateMessage: { hydratedFourRowTemplate: { hydratedContentText: 'Please confirm' } } } },
  } } } });
  const converted = client.convertMessage(make(reply));
  assert.equal(converted.replyToWaId, 'ORIGINAL');
  assert.equal(converted.isForwarded, true);
  assert.equal(quotedReply(reply)?.preview?.text, 'Please confirm');
  assert.equal(hasUserMessageContent(business), true);
  const placeholder = wire({ placeholderMessage: { type: 0 } });
  assert.equal(hasUserMessageContent(placeholder), false);
  assert.equal(hasCapturedPayloadContent(placeholder), false);
  assert.equal(client.convertMessage(make(placeholder)).messageType, 'UNAVAILABLE');
  assert.equal(client.convertMessage(make(placeholder)).metadata.unavailableReason, 'provider_placeholder');
  assert.ok(UNAVAILABLE_MESSAGE_TYPES.includes('PLACEHOLDERMESSAGE'));
  assert.ok(BUSINESS_MESSAGE_TYPES.every(type => !(UNAVAILABLE_MESSAGE_TYPES as readonly string[]).includes(type)));
  assert.equal(hasUserMessageContent(wire({ ...placeholder, conversation: 'real content' })), true);
});
