/**
 * The ONLY place that names the contract v1 fields (§C). Window + chunks go in
 * one request (adapter `conversation`); the packet goes alone (adapter
 * `knowledge_packet`) and only when its hash changes.
 */
import { createHash } from 'crypto';
import type { BrainDoc } from '../brain-ingest-lib';
import { chunkWindow } from './chunker';
import { normalizeEntityType, type ExtractionResult } from './llm-extract';
import { dayUtc, isoUtc, type ConversationMeta, type Window } from './window-builder';

export const CONTRACT_VERSION = 1;
export const CONVERSATION_ADAPTER = 'conversation';
export const PACKET_ADAPTER = 'knowledge_packet';
const FALLBACK_CONTENT_CHARS = 1_500;
export const MAX_CONCEPTS = 12;

export type LlmStatus = 'pending' | 'done' | 'skipped';

function common(w: Window, meta: ConversationMeta): Record<string, unknown> {
  return {
    window_id: w.windowId,
    source_system: meta.platform,
    platform: meta.platform,
    account: meta.account,
    conversation_id: meta.conversationId,
    conversation_name: meta.conversationName,
    is_group: meta.isGroup,
    kind: meta.kind,
    start_ts: isoUtc(w.startTs),
    end_ts: isoUtc(w.endTs),
    wa_timestamp: isoUtc(w.startTs),
    day: dayUtc(w.startTs),
    message_count: w.messageCount,
    contract_version: CONTRACT_VERSION,
  };
}

export function windowDocs(
  w: Window,
  meta: ConversationMeta,
  llmStatus: LlmStatus,
  result: ExtractionResult | null
): BrainDoc[] {
  const done = llmStatus === 'done' && result !== null;
  const content = done
    ? result.summary
    : `${w.header}\n${w.lines.map(l => l.text).join('\n')}`.slice(0, FALLBACK_CONTENT_CHARS);
  const windowDoc: BrainDoc = {
    source_id: w.windowId,
    content,
    metadata: {
      type: 'conversation_window',
      source: 'conversation',
      ...common(w, meta),
      window_text: w.windowText,
      message_ids: w.messageIds,
      participants: w.participants,
      window_hash: w.windowHash,
      llm_status: llmStatus,
      truncated_by_size: w.truncatedBySize,
      patterns: done ? result.patterns : [],
    },
  };
  const chunks = chunkWindow(w, w.header);
  const chunkDocs: BrainDoc[] = chunks.map(c => ({
    source_id: `${w.windowId}#c${c.index}`,
    content: c.text,
    metadata: {
      type: 'conversation_chunk',
      source: 'conversation',
      ...common(w, meta),
      chunk_index: c.index,
      chunk_count: c.count,
      msg_id_first: c.msgIdFirst,
      msg_id_last: c.msgIdLast,
    },
  }));
  return [windowDoc, ...chunkDocs];
}

function title(summary: string): string {
  const first = summary.split(/(?<=[.!?])\s/)[0] ?? summary;
  return first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first;
}

/** null when the extraction has neither topics nor entities (nothing to learn). */
export function packetDoc(w: Window, meta: ConversationMeta, r: ExtractionResult): BrainDoc | null {
  // Joint cap (MAX_CONCEPTS_FOR_PAIRS): topics + entities <= 12, topics first.
  const topics = r.topics.slice(0, MAX_CONCEPTS);
  const entities = r.entities.slice(0, MAX_CONCEPTS - topics.length);
  if (!topics.length && !entities.length) return null;
  const parts: string[] = [];
  if (topics.length) parts.push(`Temas: ${topics.join(', ')}.`);
  if (entities.length) parts.push(`Entidades: ${entities.map(e => e.name).join(', ')}.`);
  return {
    source_id: `${w.windowId}#kp`,
    content: parts.join(' '),
    metadata: {
      type: 'conversation_packet',
      source: 'knowledge_packet',
      ...common(w, meta),
      kp_kind: 'summary',
      kp_source_id: w.windowId,
      kp_source_type: 'conversation_window',
      kp_source_label: 'ConvDay',
      kp_title: title(r.summary),
      kp_ts: isoUtc(w.endTs),
      kp_date: dayUtc(w.startTs),
      kp_participant_count: w.participants.length,
      kp_permalinks: [],
      kp_sensitivity: 'personal',
      kp_topics: topics,
      kp_entities: entities.map(e => ({ type: normalizeEntityType(e.type), name: e.name })),
    },
  };
}

export function packetHash(doc: BrainDoc): string {
  const m = doc.metadata;
  return createHash('sha256')
    .update(JSON.stringify([doc.content, m.kp_title, m.kp_topics, m.kp_entities]))
    .digest('hex');
}
