import { normalizeMessageContent, type proto } from '@whiskeysockets/baileys';
import { BUSINESS_MESSAGE_TYPES } from './business-message-text';

/** Historic envelope rows that can be filled when the phone supplies real content. */
export const UNAVAILABLE_MESSAGE_TYPES = [
  'UNAVAILABLE',
  'SECRETENCRYPTEDMESSAGE',
  'MESSAGECONTEXTINFO',
  'SENDERKEYDISTRIBUTIONMESSAGE',
  'ENCREACTIONMESSAGE',
  'POLLUPDATEMESSAGE',
  'PLACEHOLDERMESSAGE',
] as const;

/** Full captured business payloads need reprojection, not a placeholder resend. */
export const RECOVERABLE_MESSAGE_TYPES = [...UNAVAILABLE_MESSAGE_TYPES, ...BUSINESS_MESSAGE_TYPES];

const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
] as const;

/** Inspect wrappers before Baileys unwraps them, preserving the provider's marker. */
export function isViewOnceContent(message: proto.IMessage | null | undefined): boolean {
  let current = message;
  for (let depth = 0; current && depth < 10; depth++) {
    if (current.viewOnceMessage || current.viewOnceMessageV2 || current.viewOnceMessageV2Extension)
      return true;
    if (
      [current.imageMessage, current.videoMessage, current.audioMessage].some(
        media => media?.viewOnce === true
      )
    )
      return true;
    const wrapper = WRAPPERS.find(key => current?.[key]?.message);
    current = wrapper ? current[wrapper]?.message : undefined;
  }
  return false;
}

/** Pure control/encrypted envelopes must not replace a captured user payload. */
export function hasUserMessageContent(message: proto.IMessage | null | undefined): boolean {
  return hasPayloadContent(message, true);
}

/** Pins and encrypted poll/event responses remain useful to the durable state scans. */
export function hasCapturedPayloadContent(message: proto.IMessage | null | undefined): boolean {
  return hasPayloadContent(message, false);
}

function hasPayloadContent(message: proto.IMessage | null | undefined, userOnly: boolean): boolean {
  const content = normalizeMessageContent(message);
  if (!content) return false;
  const envelopes = new Set([
    'messageContextInfo',
    'senderKeyDistributionMessage',
    'protocolMessage',
    'secretEncryptedMessage',
    'placeholderMessage',
    'encReactionMessage',
    ...(userOnly ? ['pollUpdateMessage', 'encEventResponseMessage', 'pinInChatMessage'] : []),
  ]);
  return Object.entries(content).some(([key, value]) => !envelopes.has(key) && value != null);
}
