import {
  jidNormalizedUser,
  normalizeMessageContent,
  type WAMessage,
} from '@whiskeysockets/baileys';
import {
  accountKey,
  canonicalConversationId,
  connectorAccount,
  getPool,
  stripAccountKey,
} from './db-writer';
import { PIN_ACTION_SQL, storageConversationId } from './durable-message-store';
import { deserializeDurableValue } from './whatsapp-capabilities';
import { activePinnedMessages } from './pinned-messages';

export interface PinPage {
  items: WAMessage[];
  nextCursor: string | null;
}

export async function listCapturedPins(
  chatId: string,
  cursor: string | null = null,
  limit = 200
): Promise<PinPage> {
  if (
    !chatId ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500 ||
    (cursor !== null && (typeof cursor !== 'string' || !cursor || cursor.length > 512))
  )
    throw new Error('Invalid pin page');
  // Parameters are numbered per branch because PostgreSQL needs a determinable
  // type for every symbol up to the highest one used: an unreferenced $3 fails
  // the first page outright, and a nullable OR would push the keyset bound out
  // of the index condition and into a post-scan filter.
  const params: unknown[] = [
    connectorAccount(),
    accountKey(await canonicalConversationId(storageConversationId(chatId))),
  ];
  const filters = [PIN_ACTION_SQL];
  if (cursor !== null) {
    params.push(accountKey(cursor));
    filters.push(`wa_message_id COLLATE "C" > $${params.length}::text COLLATE "C"`);
  }
  params.push(limit + 1);
  const result = await getPool().query(
    [
      `SELECT wa_message_id, message_key, message_payload, message_timestamp_ms`,
      `  FROM whatsapp_message_payloads`,
      ` WHERE account = $1 AND conversation_id = $2`,
      // Same expression as idx_whatsapp_message_payloads_pins, so ordinary chat
      // messages never enter the scan.
      ...filters.map(filter => `   AND ${filter}`),
      ` ORDER BY wa_message_id COLLATE "C" ASC LIMIT $${params.length}`,
    ].join('\n'),
    params
  );
  const rows = result.rows.slice(0, limit);
  return {
    items: rows.map(row => ({
      key: deserializeDurableValue(row.message_key) as WAMessage['key'],
      message: deserializeDurableValue(row.message_payload) as WAMessage['message'],
      messageTimestamp:
        row.message_timestamp_ms == null ? undefined : Number(row.message_timestamp_ms) / 1000,
    })),
    nextCursor: result.rows.length > limit ? stripAccountKey(rows.at(-1)!.wa_message_id) : null,
  };
}

export async function readPinnedMessages(
  chatId: string,
  {
    loadPage = listCapturedPins,
    nowMs = Date.now(),
    canonicalChat = (jid: string) => canonicalConversationId(storageConversationId(jid)),
  }: {
    loadPage?: typeof listCapturedPins;
    nowMs?: number;
    canonicalChat?: (jid: string) => Promise<string>;
  } = {}
) {
  const messages: WAMessage[] = [];
  const cursors = new Set<string>();
  const aliases = new Map<string, Promise<string>>();
  const resolve = (jid: string) => {
    if (!aliases.has(jid)) aliases.set(jid, canonicalChat(jid));
    return aliases.get(jid)!;
  };
  const sameChat = async (jid: string | null | undefined) =>
    typeof jid === 'string' &&
    (jidNormalizedUser(jid) === jidNormalizedUser(chatId) ||
      (await resolve(jid)) === (await resolve(chatId)));
  let cursor: string | null = null;
  do {
    const page = await loadPage(chatId, cursor);
    for (const message of page.items) {
      const content = normalizeMessageContent(message.message);
      const pin = content?.pinInChatMessage;
      if (
        !pin ||
        !(await sameChat(message.key.remoteJid)) ||
        !(await sameChat(pin.key?.remoteJid || message.key.remoteJid))
      )
        continue;
      // Only verified aliases are projected into the requested scope; raw storage stays intact.
      messages.push({
        ...message,
        key: { ...message.key, remoteJid: chatId },
        message: {
          ...content,
          messageContextInfo: content?.messageContextInfo || message.message?.messageContextInfo,
          pinInChatMessage: { ...pin, key: { ...pin.key, remoteJid: chatId } },
        },
      });
    }
    cursor = page.nextCursor;
    if (cursor) {
      if (cursors.has(cursor)) throw new Error('Pinned message pagination did not advance');
      cursors.add(cursor);
    }
  } while (cursor);
  return {
    availability: 'local_partial' as const,
    items: activePinnedMessages(messages, chatId, nowMs).map(
      ({ messageId, timestampMs, expiresAtMs }) => ({ messageId, timestampMs, expiresAtMs })
    ),
  };
}
