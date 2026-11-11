import { createHash } from 'node:crypto';
import { SocialAccount } from '../domain/account-registry';
import {
  socialmediaChatTag,
  socialmediaConversationDocumentId,
  socialmediaScopeTag,
} from '../infrastructure/hindsight-client';
import {
  messageScope,
  scopeEnabled,
  selectionHash,
  SyncMessage,
  SyncOptions,
  versionOperationId,
  SyncClient,
} from './hindsight-sync-lib';
import { unwrapAsrJson } from './voice-json-fix-lib';

export interface ConversationScope {
  platform: string;
  namespace: string;
  provider_account: string;
  conversation_id: string;
  topic_id: string;
}
export interface NamedMessage extends SyncMessage {
  sender_name?: string | null;
}
export interface ConversationNames {
  title: string;
  accountName: string;
  participants: string[];
  topicName?: string;
}
export interface ConversationSnapshot {
  content: string;
  metadata: Record<string, string>;
  tags: string[];
  timestamp: string;
  messageIds: string[];
}
export interface ConversationPending {
  operationId: string;
  snapshot: ConversationSnapshot;
  content: string;
  updateMode: 'append' | 'replace';
  isDeleted: boolean;
  attempts: number;
  sourceRevision: string;
  selectionHash: string;
}
export interface ConversationEntry {
  destination: string;
  documentId: string;
  scopeKey: string;
  scope: ConversationScope;
  sourceRevision: string;
  selectionHash: string;
  confirmed: ConversationSnapshot | null;
  pending: ConversationPending | null;
  lastOperationId?: string;
  status: 'pending' | 'accepted' | 'completed' | 'failed';
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])
        )
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
export function conversationScope(row: SyncMessage): ConversationScope {
  const scope = messageScope(row);
  const topic =
    row.platform === 'telegram'
      ? [row.metadata?.topic_id, row.metadata?.thread_id, row.metadata?.telegram_topic_id].find(
          value => (typeof value === 'string' || typeof value === 'number') && String(value) !== ''
        )
      : '';
  return {
    platform: scope.platform,
    namespace: scope.namespace,
    provider_account: scope.provider_account || '',
    conversation_id: scope.conversation_id,
    topic_id: typeof topic === 'string' || typeof topic === 'number' ? String(topic) : '',
  };
}
export function conversationSelectionHash(accounts: SocialAccount[], options: SyncOptions): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        selectionHash(accounts, options),
        accounts.map(a => [a.channel, a.accountId, a.label]).sort(),
      ])
    )
    .digest('hex');
}
export function buildConversationSnapshot(
  scope: ConversationScope,
  rows: NamedMessage[],
  names: ConversationNames,
  accounts: SocialAccount[],
  options: SyncOptions
): ConversationSnapshot {
  const enabled =
    scopeEnabled({ ...scope, timestamp: options.since }, accounts) &&
    (!options.chatIds.length || options.chatIds.includes(scope.conversation_id));
  const messages = enabled
    ? rows
        .filter(
          m =>
            !m.is_deleted &&
            m.metadata?.deleted_for_me !== true &&
            m.content?.trim() &&
            Date.parse(String(m.wa_timestamp)) >= Date.parse(options.since) &&
            Object.entries(scope).every(
              ([key, value]) => conversationScope(m)[key as keyof ConversationScope] === value
            )
        )
        .sort(
          (a, b) =>
            new Date(a.wa_timestamp).getTime() - new Date(b.wa_timestamp).getTime() ||
            a.id.localeCompare(b.id)
        )
    : [];
  const participants = [...new Set(names.participants.filter(Boolean))].sort();
  const header = JSON.stringify({
    type: 'conversation',
    platform: scope.platform,
    account_name: names.accountName,
    title: names.title,
    topic_name: names.topicName || '',
    participants,
  });
  const turns = messages.map(m =>
    JSON.stringify({
      type: 'message',
      message_id: m.id,
      timestamp: new Date(m.wa_timestamp).toISOString(),
      sender_id: m.sender_wa_id || '',
      sender_name:
        m.direction === 'OUTBOUND' ? names.accountName : m.sender_name || 'Unknown participant',
      direction: m.direction,
      content: unwrapAsrJson(m.content!) ?? m.content,
    })
  );
  return {
    content: messages.length ? [header, ...turns].join('\n') : '',
    metadata: {
      platform: scope.platform,
      namespace: scope.namespace,
      provider_account: scope.provider_account,
      conversation_id: scope.conversation_id,
      topic_id: scope.topic_id,
      conversation_title: names.title,
      account_name: names.accountName,
      participants: JSON.stringify(participants),
      format: 'socialmedia-conversation-jsonl-v1',
    },
    tags: [
      socialmediaScopeTag(scope.platform, scope.namespace, scope.provider_account),
      socialmediaChatTag(scope.conversation_id),
    ],
    timestamp: messages.length
      ? new Date(messages.at(-1)!.wa_timestamp).toISOString()
      : options.since,
    messageIds: messages.map(m => m.id),
  };
}
export function planConversationUpdate(
  entry: ConversationEntry,
  snapshot: ConversationSnapshot,
  revision: string,
  hash: string
): ConversationEntry {
  if (entry.pending)
    throw new Error('Reconcile pending conversation before advancing its snapshot');
  const previous = entry.confirmed;
  const unchanged = canonicalJson(previous) === canonicalJson(snapshot);
  if (unchanged)
    return { ...entry, sourceRevision: revision, selectionHash: hash, status: 'completed' };
  const append = Boolean(
    previous?.content &&
    snapshot.content.length > previous.content.length &&
    snapshot.content.startsWith(previous.content + '\n') &&
    canonicalJson(snapshot.metadata) === canonicalJson(previous.metadata) &&
    canonicalJson(snapshot.tags) === canonicalJson(previous.tags)
  );
  const version = createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
  return {
    ...entry,
    status: 'pending',
    pending: {
      operationId: versionOperationId(
        entry.destination,
        entry.documentId,
        revision,
        version,
        entry.lastOperationId
      ),
      // Hindsight itself inserts one newline between existing and appended text.
      snapshot,
      content: append ? snapshot.content.slice(previous!.content.length + 1) : snapshot.content,
      updateMode: append ? 'append' : 'replace',
      isDeleted: !snapshot.messageIds.length,
      attempts: 0,
      sourceRevision: revision,
      selectionHash: hash,
    },
  };
}
export function newConversationEntry(
  destination: string,
  scopeKey: string,
  scope: ConversationScope
): ConversationEntry {
  return {
    destination,
    scopeKey,
    scope,
    documentId: socialmediaConversationDocumentId(scope),
    sourceRevision: '0',
    selectionHash: '',
    confirmed: null,
    pending: null,
    status: 'completed',
  };
}
export type SaveConversation = (entry: ConversationEntry, delay: number) => Promise<void>;
export async function advanceConversationEntry(
  entry: ConversationEntry,
  client: SyncClient,
  save: SaveConversation,
  retryMs: number
): Promise<ConversationEntry['status']> {
  const pending = entry.pending;
  if (!pending) return entry.status;
  let done = false;
  try {
    if (pending.isDeleted) {
      await client.deleteDocument(entry.documentId);
      done = true;
    } else {
      const operation = await client.getOperation(pending.operationId);
      if (operation.status === 'completed') done = true;
      else if (operation.status === 'not_found') {
        if (pending.updateMode === 'append' && pending.attempts > 0) {
          // Operation TTL may erase an already-applied append. Reconstruct the full
          // canonical document instead of replaying a suffix with an uncertain ACK.
          pending.operationId = versionOperationId(
            entry.destination,
            entry.documentId,
            pending.sourceRevision,
            createHash('sha256').update(canonicalJson(pending.snapshot)).digest('hex'),
            pending.operationId
          );
          pending.updateMode = 'replace';
          pending.content = pending.snapshot.content;
          pending.attempts = 0;
          await save(entry, 0);
        }
        // Persist send intent before HTTP: a process crash after provider ACK
        // must not leave a suffix eligible for blind replay after operation TTL.
        pending.attempts++;
        await save(entry, 0);
        await client.retainDocument({
          documentId: entry.documentId,
          content: pending.content,
          metadata: pending.snapshot.metadata,
          tags: pending.snapshot.tags,
          timestamp: pending.snapshot.timestamp,
          operationId: pending.operationId,
          updateMode: pending.updateMode,
        });
      } else if (operation.status === 'failed' || operation.status === 'cancelled') {
        await client.retryOperation(pending.operationId);
        pending.attempts++;
      }
    }
  } catch (error) {
    entry.status = 'failed';
    pending.attempts++;
    await save(entry, retryMs);
    throw error;
  }
  if (done) {
    entry.confirmed = pending.snapshot;
    entry.sourceRevision = pending.sourceRevision;
    entry.lastOperationId = pending.operationId;
    entry.selectionHash = pending.selectionHash;
    entry.pending = null;
    entry.status = 'completed';
  } else entry.status = 'accepted';
  await save(entry, done ? 0 : retryMs);
  return entry.status;
}
