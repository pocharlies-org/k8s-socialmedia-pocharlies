import {
  jidNormalizedUser,
  normalizeMessageContent,
  type WAMessage,
} from '@whiskeysockets/baileys';
import {
  aggregateEventResponses,
  decryptCapturedEventResponses,
  latestEventResponses,
  type CapturedEventResponse,
} from './event-responses';
import {
  getRawWAMessage,
  listCapturedEventResponses,
  type StoredRawMessageRow,
} from './durable-message-store';

interface EventResultPorts {
  ownJid: string | null;
  resolvePhoneJid: (jid: string) => Promise<string | null>;
  loadMessage?: (id: string, chat: string) => Promise<WAMessage | undefined>;
  loadReplies?: (
    id: string,
    chat: string,
    page: { cursor: string | null }
  ) => Promise<{ items: StoredRawMessageRow[]; nextCursor: string | null }>;
}

export async function readEventResults(
  chatId: string,
  eventIds: string[],
  ports: EventResultPorts
) {
  if (
    !chatId ||
    !Array.isArray(eventIds) ||
    !eventIds.length ||
    eventIds.length > 50 ||
    eventIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 512)
  ) {
    throw new Error('Invalid event results request');
  }
  const loadMessage = ports.loadMessage || getRawWAMessage;
  const loadReplies = ports.loadReplies || listCapturedEventResponses;
  const phone = async (jid: string | null | undefined) => {
    if (!jid || !/^\d+(?::\d+)?@(?:s\.whatsapp\.net|c\.us|lid)$/.test(jid)) return null;
    const normalized = jidNormalizedUser(jid);
    const resolved = normalized.endsWith('@lid')
      ? await ports.resolvePhoneJid(normalized)
      : normalized;
    return resolved && /^\d+@s\.whatsapp\.net$/.test(resolved) ? resolved : null;
  };
  const own = await phone(ports.ownJid);
  const results = [];
  for (const eventMessageId of new Set(eventIds)) {
    const base = {
      ...aggregateEventResponses([]),
      eventMessageId,
      name: null as string | null,
      available: false,
      availability: 'unavailable' as 'unavailable' | 'local_partial',
      reason: null as string | null,
      decryptionFailures: 0,
    };
    const stored = await loadMessage(eventMessageId, chatId);
    const content = normalizeMessageContent(stored?.message);
    if (!stored?.key?.id || !content?.eventMessage) {
      results.push({ ...base, reason: 'EVENT_NOT_FOUND' });
      continue;
    }
    base.name = content.eventMessage.name || null;
    const secret =
      content.messageContextInfo?.messageSecret ||
      stored.message?.messageContextInfo?.messageSecret;
    if (!(secret instanceof Uint8Array) || secret.length !== 32) {
      results.push({ ...base, reason: 'ENCRYPTION_KEY_UNAVAILABLE' });
      continue;
    }
    const creator = await phone(
      stored.key.fromMe ? own : stored.key.participant || stored.key.remoteJid
    );
    if (!creator || !own) {
      results.push({ ...base, reason: 'IDENTITY_UNAVAILABLE' });
      continue;
    }
    const latest = new Map<string, CapturedEventResponse>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let decryptionFailures = 0;
    do {
      const page: { items: StoredRawMessageRow[]; nextCursor: string | null } = await loadReplies(
        eventMessageId,
        chatId,
        { cursor }
      );
      const decrypted = await decryptCapturedEventResponses(
        page.items.map(item => ({
          key: item.key,
          content: (item.content as WAMessage['message']) || undefined,
        })),
        {
          eventKey: stored.key,
          eventSecret: secret,
          creatorJid: creator,
          ownJid: own,
          resolvePhoneJid: ports.resolvePhoneJid,
        }
      );
      latestEventResponses(decrypted.responses, latest);
      decryptionFailures += decrypted.undecryptable;
      cursor = page.nextCursor;
      if (cursor) {
        if (cursors.has(cursor)) throw new Error('Event response pagination did not advance');
        cursors.add(cursor);
      }
    } while (cursor);
    results.push({
      ...base,
      ...aggregateEventResponses([...latest.values()]),
      available: true,
      decryptionFailures,
    });
  }
  return results;
}
