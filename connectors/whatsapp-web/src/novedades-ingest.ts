import { proto, type WAMessage, type WAMessageKey } from '@whiskeysockets/baileys';
import { normalizeMessageContent } from '@whiskeysockets/baileys/lib/Utils/messages.js';
import {
  novedadesKind,
  type NovedadesMessageInput,
  type NovedadesStatusInput,
} from './novedades-store';

export interface NovedadesIngestStore {
  post: (input: NovedadesMessageInput) => Promise<unknown>;
  status: (input: NovedadesStatusInput) => Promise<unknown>;
  deletePost: (channel: string, id: string) => Promise<unknown>;
  deleteStatus: (key: WAMessageKey) => Promise<unknown>;
}

/** Route before chat conversion/retry storage: channel IDs are not globally unique. */
export async function ingestNovedadesMessage(
  message: WAMessage,
  store: NovedadesIngestStore,
  options: { ownJid?: string | null; source?: string } = {}
): Promise<boolean> {
  const kind = novedadesKind(message.key);
  if (!kind) return false;
  if (!message.key.id) throw new Error('Novedades message is missing its provider ID');
  if (message.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
    return ingestNovedadesUpdate(message.key, message, store);
  }
  const content = normalizeMessageContent(message.message);
  const protocol = content?.protocolMessage;
  if (protocol?.type === proto.Message.ProtocolMessage.Type.REVOKE && protocol.key?.id) {
    // A malformed cross-chat target must never mutate another channel/status.
    if (protocol.key.remoteJid && protocol.key.remoteJid !== message.key.remoteJid) return true;
    const target = { ...message.key, ...protocol.key, remoteJid: message.key.remoteJid };
    if (kind === 'channel') await store.deletePost(message.key.remoteJid!, target.id!);
    else await store.deleteStatus(target);
    return true;
  }
  const timestamp = Number(message.messageTimestamp) * 1000;
  const timestampMs = Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : undefined;
  const metadata = {
    source: options.source || 'live',
    ...(message.messageStubType != null
      ? {
          messageStubType: message.messageStubType,
          messageStubParameters: message.messageStubParameters || [],
        }
      : {}),
  };
  if (kind === 'channel') {
    await store.post({
      channelJid: message.key.remoteJid!,
      key: message.key,
      message: message.message,
      messageTimestampMs: timestampMs,
      metadata,
      identityKind: message.key.fromMe && !message.key.server_id ? 'client' : 'server',
    });
  } else {
    // Missing historical timestamps must not turn old statuses into fresh ones.
    if (!timestampMs) throw new Error('Status message is missing its original timestamp');
    await store.status({
      key: message.key,
      message: message.message,
      messageTimestampMs: timestampMs,
      metadata,
      ...(message.key.fromMe && options.ownJid ? { authorJid: options.ownJid } : {}),
    });
  }
  return true;
}

/** Update events for Novedades must never reach generic message status/deletion APIs. */
export async function ingestNovedadesUpdate(
  key: WAMessageKey,
  update: Partial<WAMessage>,
  store: NovedadesIngestStore
): Promise<boolean> {
  const kind = novedadesKind(key);
  if (!kind) return false;
  if (!key.id) return true;
  if (update.messageStubType === proto.WebMessageInfo.StubType.REVOKE || update.message === null) {
    if (kind === 'channel') await store.deletePost(key.remoteJid!, key.server_id || key.id);
    else await store.deleteStatus(key);
  } else if (kind === 'channel') {
    // Store metadata-only acknowledgements without replacing an existing payload.
    await store.post({
      channelJid: key.remoteJid!,
      key,
      message: update.message?.editedMessage?.message || update.message || undefined,
      identityKind: key.fromMe && !key.server_id ? 'client' : 'server',
      metadata: typeof update.status === 'number' ? { status: update.status } : {},
    });
  }
  return true;
}
