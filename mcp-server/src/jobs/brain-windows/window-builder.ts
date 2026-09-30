/**
 * Pure: messages of ONE conversation -> windows (contract v1 §C, rules 3 and 4).
 * No I/O. `WindowStream` is the incremental form (the job feeds it by keyset
 * pages); `buildWindows` is the same thing over an array.
 */
import { createHash } from 'crypto';

export const GAP_MS = 3_600_000; // a gap > 3600 s cuts; exactly 3600 s does not
export const MAX_LINES_CHARS = 16_000; // size cut: lines of a window, header aside
export const MAX_WINDOW_TEXT = 16_384; // header + lines, the contract's hard limit
export const MAX_PARTICIPANTS = 50;
const MAX_NAME_IN_HEADER = 120;

export type Platform = 'whatsapp' | 'telegram';
export type ChatKind = 'chat' | 'bot' | 'broadcast';

export interface WindowMessage {
  id: string;
  /** wa_timestamp in epoch ms (UTC) */
  ts: number;
  sender: string;
  content: string;
  isVoice: boolean;
  replyToId: string | null;
}

export interface ConversationMeta {
  platform: Platform;
  account: string;
  conversationId: string;
  conversationName: string | null;
  isGroup: boolean;
  kind: ChatKind;
}

export interface WindowLine {
  msgId: string;
  text: string; // "HH:MM Nombre: texto" (may span several lines if the message does)
}

export interface Window {
  windowId: string;
  firstMsgId: string;
  lastMsgId: string;
  startTs: number;
  endTs: number;
  messageCount: number;
  messageIds: string[];
  lines: WindowLine[];
  header: string; // "[platform · name] YYYY-MM-DD"
  windowText: string; // header + "\n" + lines, <= MAX_WINDOW_TEXT
  participants: string[];
  windowHash: string;
  truncatedBySize: boolean;
  /** chars of raw message content (for the LLM eligibility rule) */
  contentChars: number;
  /** content length of each message (for the "all lines <= 12 chars" rule) */
  maxContentLen: number;
}

/** Order by (wa_timestamp, id); ids are bigint-like in prod, free strings in fixtures. */
export function compareMessages(a: WindowMessage, b: WindowMessage): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (/^\d+$/.test(a.id) && /^\d+$/.test(b.id)) {
    const x = BigInt(a.id);
    const y = BigInt(b.id);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function isoUtc(ts: number): string {
  return new Date(ts).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function dayUtc(ts: number): string {
  return isoUtc(ts).slice(0, 10);
}

export function makeWindowId(meta: ConversationMeta, firstMsgId: string): string {
  return `cw:${meta.platform}:${meta.account}:${meta.conversationId}:${firstMsgId}`;
}

export function conversationHeader(meta: ConversationMeta): string {
  const name = (meta.conversationName ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_IN_HEADER);
  return name ? `[${meta.platform} · ${name}]` : `[${meta.platform}]`;
}

/** Paragraphs first, then a hard cut, so a piece never exceeds `max` chars. */
export function cutByParagraphs(text: string, max: number): string {
  if (text.length <= max) return text;
  const out: string[] = [];
  let used = 0;
  for (const para of text.split(/\n{2,}/)) {
    const add = (out.length ? 2 : 0) + para.length;
    if (used + add > max) break;
    out.push(para);
    used += add;
  }
  if (out.length) return out.join('\n\n');
  return text.slice(0, max); // a single paragraph longer than max
}

function formatLine(m: WindowMessage, body: string, replySender: string | null): string {
  const d = new Date(m.ts);
  const hhmm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  const voice = m.isVoice ? '🎙 ' : '';
  const reply = replySender ? ` (resp. a ${replySender})` : '';
  return `${hhmm} ${m.sender}: ${voice}${body}${reply}`;
}

/** sha256 over (id, content) in window order. */
export function hashMessages(msgs: Array<{ id: string; content: string }>): string {
  const h = createHash('sha256');
  for (const m of msgs) h.update(`${m.id}\u0000${m.content}\u0001`);
  return h.digest('hex');
}

interface Open {
  msgs: WindowMessage[];
  lines: WindowLine[];
  chars: number; // chars of joined lines
  senderById: Map<string, string>;
  truncated: boolean;
}

export class WindowStream {
  private cur: Open | null = null;
  private last: WindowMessage | null = null;
  private readonly out: Window[] = [];
  private readonly headerBase: string;

  constructor(private readonly meta: ConversationMeta) {
    this.headerBase = conversationHeader(meta);
  }

  /** Messages must arrive ordered by (wa_timestamp, id). Returns the windows this push closed. */
  push(m: WindowMessage): Window[] {
    if (this.last && compareMessages(this.last, m) > 0) {
      throw new Error(`messages out of order: ${this.last.id} before ${m.id}`);
    }
    const closed: Window[] = [];
    const content = m.content.trim();
    if (!content) return closed; // rule 4: btrim(content) <> ''
    const flush = () => {
      const w = this.close();
      if (w) closed.push(w);
    };

    if (this.cur && this.last && m.ts - this.last.ts > GAP_MS) flush();

    const replySender =
      this.cur && m.replyToId ? (this.cur.senderById.get(m.replyToId) ?? null) : null;
    let line = formatLine(m, content, replySender);
    let truncated = false;

    if (line.length > MAX_LINES_CHARS) {
      // One message alone over the limit: it gets a window of its own, cut by paragraphs.
      flush();
      const overhead = line.length - content.length;
      line = formatLine(m, cutByParagraphs(content, MAX_LINES_CHARS - overhead), replySender);
      truncated = true;
    } else if (this.cur && this.cur.chars + 1 + line.length > MAX_LINES_CHARS) {
      flush(); // size cut before exceeding 16.000 chars of lines
    }

    if (!this.cur) {
      this.cur = { msgs: [], lines: [], chars: 0, senderById: new Map(), truncated: false };
    }
    const cur = this.cur;
    cur.chars += (cur.lines.length ? 1 : 0) + line.length;
    cur.msgs.push(m);
    cur.lines.push({ msgId: m.id, text: line });
    cur.senderById.set(m.id, m.sender);
    cur.truncated = cur.truncated || truncated;
    this.last = m;
    if (truncated) flush(); // the oversized message closes its own window
    return closed;
  }

  /** Close the open window (end of the conversation). */
  end(): Window[] {
    const w = this.close();
    return w ? [w] : [];
  }

  private close(): Window | null {
    const cur = this.cur;
    this.cur = null;
    if (!cur || !cur.msgs.length) return null;
    const first = cur.msgs[0];
    const lastMsg = cur.msgs[cur.msgs.length - 1];
    const header = `${this.headerBase} ${dayUtc(first.ts)}`;
    const windowText = `${header}\n${cur.lines.map(l => l.text).join('\n')}`;
    const participants: string[] = [];
    for (const m of cur.msgs) {
      if (participants.length >= MAX_PARTICIPANTS) break;
      if (!participants.includes(m.sender)) participants.push(m.sender);
    }
    return {
      windowId: makeWindowId(this.meta, first.id),
      firstMsgId: first.id,
      lastMsgId: lastMsg.id,
      startTs: first.ts,
      endTs: lastMsg.ts,
      messageCount: cur.msgs.length,
      messageIds: cur.msgs.map(m => m.id),
      lines: cur.lines,
      header,
      windowText,
      participants,
      windowHash: hashMessages(cur.msgs),
      truncatedBySize: cur.truncated,
      contentChars: cur.msgs.reduce((n, m) => n + m.content.trim().length, 0),
      maxContentLen: cur.msgs.reduce((n, m) => Math.max(n, m.content.trim().length), 0),
    };
  }
}

/** Convenience: a whole (unsorted) conversation in memory. */
export function buildWindows(meta: ConversationMeta, messages: WindowMessage[]): Window[] {
  const s = new WindowStream(meta);
  const out: Window[] = [];
  for (const m of [...messages].sort(compareMessages)) out.push(...s.push(m));
  out.push(...s.end());
  return out;
}
