/**
 * Validation of the event emitted by connectors/instagram/src/publisher.ts.
 *
 * Validation deliberately happens before the raw bytes leave the cluster. The
 * validated bytes themselves are forwarded unchanged so the HMAC has a single,
 * auditable byte identity end to end.
 */

export const INSTAGRAM_SKIRMSHOP_DM_STREAM = 'INSTAGRAM_SKIRMSHOP_DM';
export const INSTAGRAM_SKIRMSHOP_DM_SUBJECT = 'instagram.skirmshop.dm.received';

export interface InstagramDmEvent {
  platform: 'instagram';
  account: 'skirmshop';
  eventType: 'dm';
  senderId: string;
  conversationId: string;
  messageId: string;
  timestamp: string;
  senderUsername?: string;
  text: string;
  mediaId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function optionalBoundedString(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= max);
}

/** Returns null rather than throwing so malformed broker input can be termed safely. */
export function validateInstagramDmEvent(value: unknown): InstagramDmEvent | null {
  if (!isRecord(value)) return null;
  if (value.platform !== 'instagram' || value.account !== 'skirmshop' || value.eventType !== 'dm') {
    return null;
  }
  if (
    !boundedString(value.senderId, 512) ||
    !boundedString(value.conversationId, 1024) ||
    !boundedString(value.messageId, 1024) ||
    !boundedString(value.timestamp, 128) ||
    Number.isNaN(Date.parse(value.timestamp)) ||
    !optionalBoundedString(value.senderUsername, 256) ||
    !boundedString(value.text, 20_000) ||
    !optionalBoundedString(value.mediaId, 1024)
  ) {
    return null;
  }
  return value as unknown as InstagramDmEvent;
}
