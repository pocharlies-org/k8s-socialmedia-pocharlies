/**
 * Brain conversation WINDOWS (INFRA-364, ADR 0002) — pure builder + storage
 * helpers. Replaces the per-message brain-ingest surface: one hour of silence
 * closes a window; the window is pushed as a parent `conversation_window`
 * document plus `conversation_chunk` children (small-to-big retrieval, ADR
 * §3/§4). Everything that decides bytes (sessionizing, splitting, formatting,
 * hashing, chunking, diffing) lives here as pure functions; the DB and HTTP
 * plumbing sits below them and is exercised with fakes in the specs.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { Pool } from 'pg';
import {
  BrainDoc,
  BrainPushConfig,
  adapterForPlatform,
  instanceForAccount,
  pushToBrain,
} from './brain-ingest-lib';
import { unwrapAsrJson } from './voice-json-fix-lib';

// CONTRACT: http.brain.push-ingest.conversation-window.v1
// (the parent/child document shapes built here are the consumer contract;
// the push itself goes through pushToBrain in brain-ingest-lib.ts)

// ── types ───────────────────────────────────────────────────────────────────

export type ConvKind = 'chat' | 'group' | 'channel' | 'bot';
export type LlmStatus = 'pending' | 'done' | 'skipped' | 'failed';

/** One ingestable message as the builder needs it. */
export interface WindowMessage {
  id: string;
  wa_message_id: string;
  content: string;
  wa_timestamp: Date;
  direction: string; // INBOUND | OUTBOUND
  sender_wa_id: string | null;
  sender_name: string | null; // participants.name
  sender_push_name: string | null; // participants.push_name
  message_type: string; // TEXT | VOICE | ...
  is_forwarded: boolean | null;
}

export interface ChatRef {
  account: string; // DB namespace (personal | professional | leila)
  platform: string; // whatsapp | telegram (instagram is out of ADR 0002 scope)
  conversation_id: string; // canonical: COALESCE(conversations.merged_into, id)
  conversation_name: string | null;
  conv_kind: ConvKind;
}

/** A configured bot/monitoring or channel chat, matched by id and/or name. */
export interface NamedChat {
  name?: string;
  ids?: string[];
}

export interface WindowsConfig {
  gapSeconds: number; // window closes after this much silence (ADR §1: 3600)
  transcriptCapChars: number; // 16.000 (ADR §1)
  splitFloorChars: number; // a split part must keep >= this (ADR §1: 8.000)
  trivialMinMessages: number; // < 4 messages -> trivial (ADR §3)
  trivialMinChars: number; // < 160 useful chars -> trivial (ADR §3)
  /** Display name for OUTBOUND messages per DB namespace (ADR §2). */
  outboundNames: Record<string, string>;
  /** Bots/monitoring: windows are built but never go through the LLM (ADR §5). */
  botChats: NamedChat[];
  /** Known broadcast channels by name (type='channel' already covers them). */
  channelChats: NamedChat[];
}

export const DEFAULT_WINDOWS_CONFIG: WindowsConfig = {
  gapSeconds: 3600,
  transcriptCapChars: 16000,
  splitFloorChars: 8000,
  trivialMinMessages: 4,
  trivialMinChars: 160,
  outboundNames: { personal: 'Dani', professional: 'Skirmshop', leila: 'Leila' },
  botChats: [],
  channelChats: [],
};

/** A window part as the builder produced it (a parent document). */
export interface BuiltWindow {
  window_key: string; // {platform}:{account}:{conversation_id}:{epoch_s}
  source_id: string; // win:{window_key} | win:{window_key}:p{n}
  part: number; // 0 = unsplit, 1..N = part index
  chat: ChatRef;
  start_ts: Date;
  end_ts: Date;
  messages: WindowMessage[];
  participants: string[]; // display names, order of first appearance
  header: string;
  transcript: string;
  trivial: boolean;
  llm_eligible: boolean; // !trivial && kind chat|group (ADR §5)
  content_hash: string;
}

/** A child chunk of a window part (ADR §3: 3–8 messages, 200–400 tokens). */
export interface BuiltChunk {
  index: number; // 1-based: source_id = parent + '#c' + index
  source_id: string;
  message_ids: string[]; // wa_message_id
  content: string; // header + its lines
}

/** A brain_windows row as stored (the diff ledger). */
export interface StoredWindow {
  source_id: string;
  content_hash: string;
  chunk_count: number;
  llm_status: LlmStatus;
}

// ── config file ─────────────────────────────────────────────────────────────

function namedChats(value: unknown, field: string): NamedChat[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`brain-windows config: ${field} must be a list`);
  return value.map((item, i) => {
    if (typeof item === 'string') return { name: item };
    if (!item || typeof item !== 'object')
      throw new Error(`brain-windows config: ${field}[${i}] must be a string or {name, ids}`);
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name : undefined;
    const ids = Array.isArray(rec.ids) ? rec.ids.map(String) : undefined;
    if (!name && !ids?.length)
      throw new Error(`brain-windows config: ${field}[${i}] needs name and/or ids`);
    return { name, ids };
  });
}

/** Parse the YAML-loaded object (js-yaml at the call site keeps this pure). */
export function parseWindowsConfig(raw: Record<string, unknown>): WindowsConfig {
  const num = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d;
  const outbound = (raw.outboundNames ?? {}) as Record<string, unknown>;
  return {
    gapSeconds: num(raw.gapSeconds, DEFAULT_WINDOWS_CONFIG.gapSeconds),
    transcriptCapChars: num(raw.transcriptCapChars, DEFAULT_WINDOWS_CONFIG.transcriptCapChars),
    splitFloorChars: num(raw.splitFloorChars, DEFAULT_WINDOWS_CONFIG.splitFloorChars),
    trivialMinMessages: num(raw.trivialMinMessages, DEFAULT_WINDOWS_CONFIG.trivialMinMessages),
    trivialMinChars: num(raw.trivialMinChars, DEFAULT_WINDOWS_CONFIG.trivialMinChars),
    outboundNames: Object.fromEntries(
      Object.entries(outbound).filter(([, v]) => typeof v === 'string')
    ) as Record<string, string>,
    botChats: namedChats(raw.bots, 'bots'),
    channelChats: namedChats(raw.channels, 'channels'),
  };
}

/** Read the mounted ConfigMap file. Missing/invalid file throws (fail-closed). */
export function loadWindowsConfig(file: string): WindowsConfig {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const yaml = require('js-yaml');
  return parseWindowsConfig(yaml.load(readFileSync(file, 'utf8')) as Record<string, unknown>);
}

// ── classification ──────────────────────────────────────────────────────────

function chatMatches(list: NamedChat[], id: string, name: string | null): boolean {
  const norm = (name ?? '').trim().toLowerCase();
  return list.some(
    c =>
      (c.ids?.includes(id) ?? false) || (!!c.name && c.name.trim().toLowerCase() === norm && !!norm)
  );
}

/**
 * conv_kind (ADR §3): bot list wins, then conversations.type='channel' (or the
 * channel name list), then group (type group/GROUP/supergroup or is_group),
 * else chat. `type` arrives as stored: whatsapp uses private/GROUP, telegram
 * private/INDIVIDUAL/group/supergroup/channel.
 */
export function classifyConvKind(
  conv: { type?: string | null; is_group?: boolean | null },
  conversation_id: string,
  name: string | null,
  config: WindowsConfig
): ConvKind {
  if (chatMatches(config.botChats, conversation_id, name)) return 'bot';
  const type = (conv.type ?? '').toLowerCase();
  if (type === 'channel' || chatMatches(config.channelChats, conversation_id, name))
    return 'channel';
  if (type === 'group' || type === 'supergroup' || conv.is_group) return 'group';
  return 'chat';
}

// ── time in Europe/Madrid (ADR §2) ─────────────────────────────────────────

const MADRID_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const MADRID_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function madridDate(ts: Date): string {
  return MADRID_DATE.format(ts);
}
export function madridTime(ts: Date): string {
  return MADRID_TIME.format(ts);
}

// ── transcript rendering (ADR §2) ──────────────────────────────────────────

/** Bare human-readable number from a sender id: 34600111222@c.us -> 34600111222. */
function bareNumber(senderWaId: string | null): string {
  if (!senderWaId) return 'anon';
  let s = senderWaId;
  const at = s.indexOf('@');
  if (at > 0) s = s.slice(0, at);
  const colon = s.lastIndexOf(':');
  if (colon > 0) s = s.slice(0, colon);
  if (s.startsWith('tg_')) s = s.slice(3);
  if (s.startsWith('professional:')) s = s.slice('professional:'.length);
  if (s.startsWith('leila:')) s = s.slice('leila:'.length);
  return s || 'anon';
}

/** Display author of a message (ADR §2): OUTBOUND is the account's name. */
export function authorOf(msg: WindowMessage, chat: ChatRef, config: WindowsConfig): string {
  if ((msg.direction ?? '').toUpperCase() === 'OUTBOUND')
    return config.outboundNames[chat.account] ?? chat.account;
  const name = (msg.sender_name ?? '').trim();
  if (name) return name;
  const push = (msg.sender_push_name ?? '').trim();
  if (push) return push;
  return bareNumber(msg.sender_wa_id);
}

const VOICE_TYPES = new Set(['VOICE', 'AUDIO']);

/** One transcript line: `18:04 Ana [voz]: texto` — newlines collapsed.
 * Defensive unwrap (INFRA-364): a voice-note echo whose `content` still stores
 * the raw STT body (`🎙️ "{"text":"…"}"`) renders as prose, never as JSON —
 * ingest normalizes new rows and voice-json-fix heals history, but a window
 * built over an unfixed row must not carry the body into the brain. */
export function renderLine(msg: WindowMessage, author: string): string {
  const markers: string[] = [];
  if (VOICE_TYPES.has((msg.message_type ?? '').toUpperCase())) markers.push('voz');
  if (msg.is_forwarded) markers.push('reenviado');
  const suffix = markers.length ? ` ${markers.map(m => `[${m}]`).join(' ')}` : '';
  const raw = unwrapAsrJson(msg.content) ?? msg.content;
  const text = raw.replace(/\s*\n\s*/g, ' ').trim();
  return `${madridTime(msg.wa_timestamp)} ${author}${suffix}: ${text}`;
}

/** Full transcript with `— YYYY-MM-DD —` day separators (ADR §2). */
export function renderTranscript(
  msgs: WindowMessage[],
  chat: ChatRef,
  config: WindowsConfig
): string {
  const lines: string[] = [];
  let day = '';
  for (const m of msgs) {
    const d = madridDate(m.wa_timestamp);
    if (d !== day) {
      if (day) lines.push(`— ${d} —`);
      day = d;
    }
    lines.push(renderLine(m, authorOf(m, chat, config)));
  }
  return lines.join('\n');
}

const KIND_LABEL: Record<ConvKind, string> = {
  chat: 'chat',
  group: 'grupo',
  channel: 'canal',
  bot: 'bot',
};

/** `[WhatsApp · grupo «Name» · Ana, Luis, +3 · 2026-03-14 18:02–19:47]` (ADR §2). */
export function renderHeader(
  chat: ChatRef,
  participants: string[],
  start: Date,
  end: Date
): string {
  const platform = chat.platform === 'telegram' ? 'Telegram' : 'WhatsApp';
  const name = (chat.conversation_name ?? '').trim() || chat.conversation_id;
  const shown = participants.slice(0, 8);
  const rest = participants.length - shown.length;
  const people = shown.length ? ` · ${shown.join(', ')}${rest > 0 ? ` +${rest}` : ''}` : '';
  const endStr =
    madridDate(start) === madridDate(end)
      ? madridTime(end)
      : `${madridDate(end)} ${madridTime(end)}`;
  return `[${platform} · ${KIND_LABEL[chat.conv_kind]} «${name}»${people} · ${madridDate(start)} ${madridTime(start)}–${endStr}]`;
}

/** Order-of-first-appearance display names of who spoke in a window. */
export function participantsOf(
  msgs: WindowMessage[],
  chat: ChatRef,
  config: WindowsConfig
): string[] {
  const seen: string[] = [];
  const set = new Set<string>();
  for (const m of msgs) {
    const a = authorOf(m, chat, config);
    if (!set.has(a)) {
      set.add(a);
      seen.push(a);
    }
  }
  return seen;
}

// ── triviality (ADR §3) ────────────────────────────────────────────────────

// Emoji, flags, keycaps, ZWJ and variation selectors — anything pictographic.
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Component}️‍]/gu;
// Bare acknowledgements and laughter: words that carry no searchable content.
const FILLER_RE =
  /^(ok+|okay|okey|o\.?k\.?|k|q|vale|v|dale|va|listo|genial|perfecto|buen[oa]?|gracias+|merci|thanks?|jaja+|jeje+|jojo+|si+|sí|no+|oio+|oi+|holi+|hola+|ups+|uy+|buf+|m+m+|h+m+m+|am[eé]n|okeydoke|kien|k?o\?*)$/i;

/** Useful characters: content minus emoji, filler tokens and punctuation. */
export function usefulTextLen(msgs: WindowMessage[]): number {
  let total = 0;
  for (const m of msgs) {
    const stripped = m.content.replace(EMOJI_RE, ' ');
    for (const token of stripped.split(/[\s,.;:!?"'`()[\]{}<>~/\\|@#$%^&*_+=-]+/)) {
      if (!token) continue;
      if (FILLER_RE.test(token)) continue;
      if (/^\d+$/.test(token) && token.length <= 3) continue; // lone small numbers ("2")
      total += token.length;
    }
  }
  return total;
}

export function isTrivialWindow(msgs: WindowMessage[], config: WindowsConfig): boolean {
  if (msgs.length < config.trivialMinMessages) return true;
  return usefulTextLen(msgs) < config.trivialMinChars;
}

// ── sessionizing and splitting (ADR §1) ────────────────────────────────────

/** Group messages into sessions: new session when the silence gap exceeds it. */
export function sessionize(msgs: WindowMessage[], gapSeconds: number): WindowMessage[][] {
  const sessions: WindowMessage[][] = [];
  let current: WindowMessage[] = [];
  for (const m of msgs) {
    if (
      current.length &&
      (m.wa_timestamp.getTime() - current[current.length - 1].wa_timestamp.getTime()) / 1000 >
        gapSeconds
    ) {
      sessions.push(current);
      current = [];
    }
    current.push(m);
  }
  if (current.length) sessions.push(current);
  return sessions;
}

/** Split text over `cap` at sentence boundaries, appending an ellipsis. */
export function truncateSentences(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const cut = text.slice(0, cap);
  const last = Math.max(
    cut.lastIndexOf('. '),
    cut.lastIndexOf('! '),
    cut.lastIndexOf('? '),
    cut.lastIndexOf('\n')
  );
  const head = last > cap * 0.5 ? cut.slice(0, last + 1) : cut;
  return `${head.trimEnd()} …`;
}

/**
 * Split one session into parts of at most `cap` transcript characters
 * (ADR §1): prefer the temporal gap that keeps the part between `floor` and
 * `cap`; with no such gap, split at the message boundary nearest the cap. A
 * single message over the cap is truncated by sentences.
 */
export function splitSessionByCap(
  msgs: WindowMessage[],
  chat: ChatRef,
  config: WindowsConfig
): WindowMessage[][] {
  // Line lengths and prefix sums once: a bot session can be tens of thousands
  // of messages and thousands of parts (Synapse monitor: one 24-day session).
  const lens = msgs.map(m => renderLine(m, authorOf(m, chat, config)).length + 1);
  const prefix: number[] = [0];
  for (const l of lens) prefix.push(prefix[prefix.length - 1] + l);
  const n = msgs.length;
  const parts: WindowMessage[][] = [];
  let start = 0;
  // Every pass consumes at least one message, so the loop ends in <= n passes.
  while (start < n) {
    if (prefix[n] - prefix[start] <= config.transcriptCapChars) {
      parts.push(msgs.slice(start));
      break;
    }
    // Candidate part = msgs[start .. start+i); its length only grows with i.
    let best = -1;
    let bestGap = -1;
    let nearest = 1;
    let nearestDiff = Infinity;
    for (let i = 1; start + i < n; i++) {
      const len = prefix[start + i] - prefix[start];
      const diff = Math.abs(len - config.transcriptCapChars);
      if (diff < nearestDiff) {
        nearestDiff = diff;
        nearest = i;
      }
      if (len > config.transcriptCapChars) break; // nothing further fits
      if (len < config.splitFloorChars) continue;
      const gapSec =
        (msgs[start + i].wa_timestamp.getTime() - msgs[start + i - 1].wa_timestamp.getTime()) /
        1000;
      if (gapSec > bestGap) {
        bestGap = gapSec;
        best = i;
      }
    }
    // No boundary inside [floor, cap]: cut at the message boundary closest to
    // the cap (ADR §1 "en el límite de mensaje").
    if (best < 0) best = nearest;
    if (best === 1 && lens[start] > config.transcriptCapChars) {
      // A single message over the cap: truncate it by sentences (ADR §1).
      parts.push([truncatedMessage(msgs[start], config.transcriptCapChars)]);
      start += 1;
      continue;
    }
    parts.push(msgs.slice(start, start + best));
    start += best;
  }
  return parts;
}

/** Copy of a message with its content truncated to fit the transcript cap. */
function truncatedMessage(m: WindowMessage, cap: number): WindowMessage {
  // Leave room for "HH:MM author [markers]: " — approximate with 64 chars.
  return { ...m, content: truncateSentences(m.content, Math.max(200, cap - 64)) };
}

// ── ids and hashes ─────────────────────────────────────────────────────────

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function windowKey(chat: ChatRef, firstTs: Date): string {
  return `${chat.platform}:${chat.account}:${chat.conversation_id}:${Math.floor(
    firstTs.getTime() / 1000
  )}`;
}

export function windowSourceId(key: string, part: number): string {
  return part === 0 ? `win:${key}` : `win:${key}:p${part}`;
}

/** Stable identity of the rendered window: what the brain doc carries. */
export function windowContentHash(w: {
  window_key: string;
  part: number;
  transcript: string;
  message_ids: string[];
  conversation_name: string | null;
  conv_kind: ConvKind;
}): string {
  return sha256(
    JSON.stringify({
      v: 1,
      window_key: w.window_key,
      part: w.part,
      message_ids: w.message_ids,
      transcript: w.transcript,
      conversation_name: w.conversation_name,
      conv_kind: w.conv_kind,
    })
  );
}

/**
 * Checkpoint of the LLM call (ADR §5): same input hash -> never call again.
 * Includes the model so a resident-model swap re-extracts.
 */
export function llmInputHash(
  model: string,
  header: string,
  transcript: string,
  prevSummary: string | null
): string {
  return sha256(JSON.stringify({ v: 1, model, header, transcript, prevSummary }));
}

// ── window building ────────────────────────────────────────────────────────

/**
 * Messages (sorted by (wa_timestamp, id), ingestable filter already applied)
 * -> window parts. Pure: no clock, no DB. `now` only marks provisional
 * windows (ADR §7.4): a window whose last message is younger than the gap.
 */
export function buildWindows(
  chat: ChatRef,
  msgs: WindowMessage[],
  config: WindowsConfig
): BuiltWindow[] {
  const out: BuiltWindow[] = [];
  for (const session of sessionize(msgs, config.gapSeconds)) {
    const parts = splitSessionByCap(session, chat, config);
    const multi = parts.length > 1;
    parts.forEach((partMsgs, i) => {
      const part = multi ? i + 1 : 0;
      // ADR §1: the key anchors on the FIRST message of the SESSION, shared by
      // all parts (the part number is the :pN suffix) — so a shift in the split
      // point never renames the session.
      const key = windowKey(chat, session[0].wa_timestamp);
      const transcript = renderTranscript(partMsgs, chat, config);
      const participants = participantsOf(partMsgs, chat, config);
      const header = renderHeader(
        chat,
        participants,
        partMsgs[0].wa_timestamp,
        partMsgs[partMsgs.length - 1].wa_timestamp
      );
      const message_ids = partMsgs.map(m => m.wa_message_id);
      out.push({
        window_key: key,
        source_id: windowSourceId(key, part),
        part,
        chat,
        start_ts: partMsgs[0].wa_timestamp,
        end_ts: partMsgs[partMsgs.length - 1].wa_timestamp,
        messages: partMsgs,
        participants,
        header,
        transcript,
        trivial: isTrivialWindow(partMsgs, config),
        llm_eligible: false, // filled below (needs trivial + kind)
        content_hash: windowContentHash({
          window_key: key,
          part,
          transcript,
          message_ids,
          conversation_name: chat.conversation_name,
          conv_kind: chat.conv_kind,
        }),
      });
    });
  }
  for (const w of out) {
    w.llm_eligible = !w.trivial && (w.chat.conv_kind === 'chat' || w.chat.conv_kind === 'group');
  }
  return out;
}

/** True when the window may still change: its last message is inside the gap. */
export function isProvisional(w: BuiltWindow, config: WindowsConfig, now: Date): boolean {
  return now.getTime() - w.end_ts.getTime() < config.gapSeconds * 1000;
}

// ── child chunks (ADR §3) ─────────────────────────────────────────────────

export const CHUNK_MIN_MSGS = 3;
export const CHUNK_MAX_MSGS = 8;
export const CHUNK_TARGET_CHARS = 800; // ≈ 200 tokens
export const CHUNK_MAX_CHARS = 1600; // ≈ 400 tokens

/**
 * Children of a non-trivial window part: 3–8 consecutive messages, ~800–1600
 * chars, ONE message of overlap between consecutive children; a message over
 * 1600 chars is itself split by sentences (ADR §3). Content = header + lines.
 */
export function chunkWindow(
  w: BuiltWindow,
  config: WindowsConfig = DEFAULT_WINDOWS_CONFIG
): BuiltChunk[] {
  // Flatten to lines, expanding oversized messages into sentence slices that
  // stay attributed to the same message id.
  interface Line {
    text: string;
    wa_message_id: string;
  }
  const lines: Line[] = [];
  let day = '';
  for (const m of w.messages) {
    const d = madridDate(m.wa_timestamp);
    if (d !== day) {
      if (day) lines.push({ text: `— ${d} —`, wa_message_id: '' });
      day = d;
    }
    const line = renderLine(m, authorOf(m, w.chat, config));
    if (line.length <= CHUNK_MAX_CHARS) {
      lines.push({ text: line, wa_message_id: m.wa_message_id });
    } else {
      const prefix = line.slice(0, line.indexOf(': ', 6) + 2);
      const body = line.slice(prefix.length);
      let rest = body;
      while (rest.length > CHUNK_MAX_CHARS - prefix.length) {
        const cut = truncateSentences(rest, CHUNK_MAX_CHARS - prefix.length - 1);
        const head = cut.endsWith(' …') ? cut.slice(0, -2) : cut;
        lines.push({ text: prefix + head + ' …', wa_message_id: m.wa_message_id });
        const consumed = head.length + 1;
        rest = rest.slice(consumed).trimStart();
      }
      if (rest) lines.push({ text: prefix + rest, wa_message_id: m.wa_message_id });
    }
  }

  const chunks: BuiltChunk[] = [];
  let i = 0;
  let first = true;
  while (i < lines.length) {
    let j = i;
    let len = 0;
    let realMsgs = 0;
    while (j < lines.length) {
      const add = lines[j].text.length + 1;
      if (j > i && len + add > CHUNK_MAX_CHARS) break;
      if (j > i && realMsgs >= CHUNK_MAX_MSGS && lines[j].wa_message_id) break;
      len += add;
      if (lines[j].wa_message_id) realMsgs++;
      j++;
      if (len >= CHUNK_TARGET_CHARS && realMsgs >= CHUNK_MIN_MSGS && j < lines.length) {
        // reached the target with enough messages: close here
        break;
      }
    }
    const slice = lines.slice(i, j);
    const ids = [...new Set(slice.map(l => l.wa_message_id).filter(Boolean))];
    if (ids.length) {
      chunks.push({
        index: chunks.length + 1,
        source_id: `${w.source_id}#c${chunks.length + 1}`,
        message_ids: ids,
        content: `${w.header}\n${slice.map(l => l.text).join('\n')}`,
      });
    }
    if (j >= lines.length) break;
    // 1-message overlap: rewind to the line that starts the last real message
    if (first) first = false;
    let next = j;
    for (let k = j - 1; k > i; k--) {
      if (
        lines[k].wa_message_id &&
        (!lines[k - 1] || lines[k - 1].wa_message_id !== lines[k].wa_message_id)
      ) {
        next = k;
        break;
      }
    }
    i = next;
  }
  return chunks;
}

// ── brain documents (ADR §3) ──────────────────────────────────────────────

/** Parent content: header + summary when extracted, else header + ~1500 chars. */
export function parentContent(w: BuiltWindow, summary?: string | null): string {
  return summary ? `${w.header}\n${summary}` : `${w.header}\n${w.transcript.slice(0, 1500)}`;
}

export interface ParentExtras {
  llm_status: LlmStatus;
  summary?: string | null;
  extraction?: Record<string, unknown> | null;
}

export function parentDoc(w: BuiltWindow, extras: ParentExtras): BrainDoc {
  const metadata: Record<string, unknown> = {
    type: 'conversation_window',
    platform: w.chat.platform,
    account: w.chat.account,
    conversation_id: w.chat.conversation_id,
    conversation_name: w.chat.conversation_name,
    conv_kind: w.chat.conv_kind,
    window_key: w.window_key,
    part: w.part,
    start_ts: w.start_ts.toISOString(),
    end_ts: w.end_ts.toISOString(),
    observed_at: w.end_ts.toISOString(), // ADR §3: observed_at = end_ts
    message_count: w.messages.length,
    participants: w.participants,
    message_ids: w.messages.map(m => m.wa_message_id),
    transcript: w.transcript,
    content_hash: w.content_hash,
    llm_status: extras.llm_status,
  };
  if (extras.summary) metadata.summary = extras.summary;
  if (extras.extraction) metadata.extraction = extras.extraction;
  return {
    source_id: w.source_id,
    content: parentContent(w, extras.summary),
    metadata,
  };
}

export function childDocs(w: BuiltWindow, chunks: BuiltChunk[]): BrainDoc[] {
  return chunks.map(c => ({
    source_id: c.source_id,
    content: c.content,
    metadata: {
      type: 'conversation_chunk',
      window_source_id: w.source_id,
      chunk_index: c.index,
      platform: w.chat.platform,
      account: w.chat.account,
      conversation_id: w.chat.conversation_id,
      conversation_name: w.chat.conversation_name,
      conv_kind: w.chat.conv_kind,
      observed_at: w.end_ts.toISOString(),
      message_ids: c.message_ids,
    },
  }));
}

/**
 * llm_status a freshly pushed window starts with (ADR §5/§7.4): trivial,
 * channel and bot windows are 'skipped' forever; everything else is 'pending'
 * (provisional windows too — the LLM pass only picks CLOSED ones).
 */
export function initialLlmStatus(w: BuiltWindow): LlmStatus {
  return w.trivial || !w.llm_eligible ? 'skipped' : 'pending';
}

// ── diff against the ledger (ADR §7.3) ────────────────────────────────────

export interface WindowDiff {
  toPush: BuiltWindow[]; // new or content_hash changed
  toDelete: StoredWindow[]; // stored rows the builder no longer produces
}

export function diffWindows(existing: StoredWindow[], built: BuiltWindow[]): WindowDiff {
  const builtById = new Map(built.map(w => [w.source_id, w]));
  const toPush = built.filter(w => {
    const e = existing.find(x => x.source_id === w.source_id);
    return !e || e.content_hash !== w.content_hash;
  });
  const toDelete = existing.filter(e => !builtById.has(e.source_id));
  return { toPush, toDelete };
}

// ── push / delete (ADR §3; push reuses brain-ingest-lib's budget) ─────────

export function instanceForNamespace(account: string): string {
  return instanceForAccount(account);
}

// A JS slice() counts UTF-16 units and can cut an emoji in half, leaving a lone
// surrogate. The brain's embedder client cannot UTF-8-encode it, counts it as an
// endpoint failure and opens the TEI circuit breaker for EVERY caller (01-10-2026).
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Replace lone UTF-16 surrogates with U+FFFD (String.prototype.toWellFormed). */
export function wellFormed(s: string): string {
  return s.replace(LONE_SURROGATE, '\uFFFD');
}

/** wellFormed applied to every string inside a JSON-like value. */
export function wellFormedDeep<T>(v: T): T {
  if (typeof v === 'string') return wellFormed(v) as unknown as T;
  if (Array.isArray(v)) return v.map(x => wellFormedDeep(x)) as unknown as T;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = wellFormedDeep(x);
    return out as T;
  }
  return v;
}

/** Push parents + children in batches of `batch` docs through pushToBrain. */
export async function pushWindowDocs(
  config: BrainPushConfig,
  account: string,
  docs: BrainDoc[],
  batch = 25
): Promise<number> {
  let chunks = 0;
  const adapter = adapterForPlatform(docsAdapterKey(docs));
  const instance = instanceForNamespace(account);
  for (let i = 0; i < docs.length; i += batch) {
    chunks += await pushToBrain(
      config,
      instance,
      adapter,
      wellFormedDeep(docs.slice(i, i + batch))
    );
  }
  return chunks;
}

function docsAdapterKey(docs: BrainDoc[]): string {
  const p = docs[0]?.metadata?.platform;
  return typeof p === 'string' ? p : 'whatsapp';
}

/**
 * Delete one document (parent or child) from the brain:
 * POST /instances/{instance}/delete-document {adapter, source_id}.
 * 404 counts as success (nothing there). Retries 5xx/network with the same
 * small budget as the push.
 */
export async function deleteFromBrain(
  config: BrainPushConfig,
  instance: string,
  adapter: string,
  sourceId: string,
  sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))
): Promise<void> {
  const url = `${config.brainUrl.replace(/\/$/, '')}/instances/${instance}/delete-document`;
  let lastError = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { 'X-API-Key': config.apiKey } : {}),
        },
        body: JSON.stringify({ adapter, source_id: sourceId }),
        signal: AbortSignal.timeout(30000),
      });
      if (resp.ok || resp.status === 404) return;
      lastError = `${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`;
      if (resp.status < 500) break; // 4xx other than 404: no retry
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    if (attempt < 4) await sleep(1000 * 2 ** (attempt - 1));
  }
  throw new Error(`brain delete-document ${sourceId} failed: ${lastError}`);
}

/** Delete a window and its children from the brain (best effort per doc). */
export async function deleteWindowFromBrain(
  config: BrainPushConfig,
  account: string,
  platform: string,
  sourceId: string,
  chunkCount: number,
  log: (msg: string, err?: unknown) => void
): Promise<void> {
  const instance = instanceForNamespace(account);
  const adapter = adapterForPlatform(platform);
  const ids = [sourceId, ...Array.from({ length: chunkCount }, (_, i) => `${sourceId}#c${i + 1}`)];
  for (const id of ids) {
    // A window whose delete fails propagates: the caller keeps the ledger row,
    // so the next pass re-diffs and retries the delete.
    log(`brain delete ${instance}/${adapter} ${id}`);
    await deleteFromBrain(config, instance, adapter, id);
  }
}

// ── Postgres plumbing ─────────────────────────────────────────────────────

export async function ensureBrainWindowsTables(pool: Pool): Promise<void> {
  // Mirrors 016_brain_windows.sql so a job can run before the PreSync migrate
  // Job lands (same posture as ensureLiveCursorTable in brain-ingest-lib).
  await pool.query(`CREATE TABLE IF NOT EXISTS brain_windows (
    source_id        TEXT PRIMARY KEY,
    account          TEXT NOT NULL,
    platform         TEXT NOT NULL,
    conversation_id  TEXT NOT NULL,
    window_key       TEXT NOT NULL,
    part             INTEGER NOT NULL DEFAULT 0,
    start_ts         TIMESTAMPTZ NOT NULL,
    end_ts           TIMESTAMPTZ NOT NULL,
    message_count    INTEGER NOT NULL,
    first_message_id BIGINT NOT NULL,
    last_message_id  BIGINT NOT NULL,
    conv_kind        TEXT NOT NULL,
    content_hash     TEXT NOT NULL,
    pushed_hash      TEXT,
    pushed_at        TIMESTAMPTZ,
    chunk_count      INTEGER NOT NULL DEFAULT 0,
    llm_status       TEXT NOT NULL DEFAULT 'pending',
    llm_input_hash   TEXT,
    llm_done_at      TIMESTAMPTZ,
    llm_error        TEXT,
    llm_summary      TEXT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS brain_windows_cursor (
    account         TEXT PRIMARY KEY,
    last_updated_at TIMESTAMPTZ NOT NULL,
    last_id         BIGINT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS brain_windows_backfill_cursor (
    run_id               TEXT NOT NULL,
    phase                TEXT NOT NULL,
    last_account         TEXT,
    last_platform        TEXT,
    last_conversation_id TEXT,
    last_end_ts          TIMESTAMPTZ,
    last_source_id       TEXT,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (run_id, phase)
  )`);
}

/**
 * The heavy index on messages is created here, CONCURRENTLY, outside any
 * transaction (pool.query autocommits): migrate.ts runs each file inside a
 * transaction, where CONCURRENTLY is impossible (see the header of
 * 016_brain_windows.sql). Every brain-windows job calls this before scanning.
 */
export async function ensureBrainWindowsIndexes(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_brain_windows_cursor
       ON messages (account, updated_at, id)`
  );
}

const INGESTABLE = `m.is_deleted = false AND m.content IS NOT NULL AND btrim(m.content) <> ''`;
const WINDOW_PLATFORMS = `m.platform IN ('whatsapp','telegram')`;

export interface CursorRow {
  last_updated_at: string;
  last_id: string | null;
}

export async function getWindowsCursor(pool: Pool, account: string): Promise<CursorRow | null> {
  const r = await pool.query(
    `SELECT last_updated_at, last_id FROM brain_windows_cursor WHERE account = $1`,
    [account]
  );
  if (!r.rows.length) return null;
  return { last_updated_at: r.rows[0].last_updated_at, last_id: r.rows[0].last_id };
}

export async function setWindowsCursor(
  pool: Pool,
  account: string,
  updatedAt: Date | string,
  id: string | null
): Promise<void> {
  await pool.query(
    `INSERT INTO brain_windows_cursor (account, last_updated_at, last_id, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (account) DO UPDATE
       SET last_updated_at = EXCLUDED.last_updated_at,
           last_id = EXCLUDED.last_id,
           updated_at = now()`,
    [account, updatedAt, id]
  );
}

/** Changed rows after the cursor, keyset order (uses idx_messages_brain_windows_cursor). */
export interface ChangedRow {
  id: string;
  updated_at: Date;
  platform: string;
  conversation_id: string; // canonical
  wa_timestamp: Date;
}

export async function fetchChangedRows(
  pool: Pool,
  account: string,
  cursor: CursorRow,
  limit: number
): Promise<ChangedRow[]> {
  const r = await pool.query(
    `SELECT m.id, m.updated_at, m.platform, m.wa_timestamp,
            COALESCE(c.merged_into, m.conversation_id) AS conversation_id
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.account = $1
        AND ${WINDOW_PLATFORMS}
        AND (m.updated_at, m.id) > ($2::timestamptz, COALESCE($3::bigint, 0::bigint))
      ORDER BY m.updated_at ASC, m.id ASC
      LIMIT $4`,
    [account, cursor.last_updated_at, cursor.last_id, limit]
  );
  return r.rows as ChangedRow[];
}

/** Canonical chat metadata for a set of conversation ids. */
export interface ChatMeta {
  conversation_id: string;
  name: string | null;
  type: string | null;
  is_group: boolean | null;
}

export async function fetchChatMeta(
  pool: Pool,
  account: string,
  ids: string[]
): Promise<Map<string, ChatMeta>> {
  if (!ids.length) return new Map();
  const r = await pool.query(
    `SELECT id, name, type, is_group FROM conversations
      WHERE account = $1 AND id = ANY ($2::text[])`,
    [account, ids]
  );
  const map = new Map<string, ChatMeta>();
  for (const row of r.rows)
    map.set(row.id, {
      conversation_id: row.id,
      name: row.name,
      type: row.type,
      is_group: row.is_group,
    });
  return map;
}

/** All ingestable messages of a chat inside [from, to], builder order. */
export async function fetchChatMessages(
  pool: Pool,
  chat: ChatRef,
  from: Date,
  to: Date,
  limit = 50000
): Promise<WindowMessage[]> {
  const r = await pool.query(
    `SELECT m.id, m.wa_message_id, m.content, m.wa_timestamp, m.direction,
            m.sender_wa_id, m.message_type, m.is_forwarded,
            p.name AS sender_name, p.push_name AS sender_push_name
       FROM messages m
       LEFT JOIN participants p ON p.id = m.sender_wa_id
      WHERE m.conversation_id = $1
        AND m.account = $2
        AND ${INGESTABLE}
        AND ${WINDOW_PLATFORMS}
        AND m.wa_timestamp >= $3 AND m.wa_timestamp <= $4
      ORDER BY m.wa_timestamp ASC, m.id ASC
      LIMIT $5`,
    [chat.conversation_id, chat.account, from, to, limit]
  );
  return (r.rows as WindowMessage[]).map(row => ({
    ...row,
    wa_timestamp: new Date(row.wa_timestamp),
  }));
}

/**
 * Walk back from `ts` to the start of its session (ADR §7.2 "ampliado a
 * ventanas completas"): fetch up to `lookback` preceding messages and stop at
 * the first silence > gap. Returns the extended lower bound and whether the
 * walk was truncated (session longer than lookback — monster bot chats).
 */
export async function sessionStartBound(
  pool: Pool,
  chat: ChatRef,
  ts: Date,
  gapSeconds: number,
  lookback = 5000
): Promise<{ bound: Date; truncated: boolean }> {
  const r = await pool.query(
    `SELECT m.wa_timestamp FROM messages m
      WHERE m.conversation_id = $1 AND m.account = $2
        AND ${INGESTABLE}
        AND ${WINDOW_PLATFORMS}
        AND m.wa_timestamp < $3
      ORDER BY m.wa_timestamp DESC, m.id DESC
      LIMIT $4`,
    [chat.conversation_id, chat.account, ts, lookback]
  );
  const prev = (r.rows as { wa_timestamp: Date }[]).map(x => new Date(x.wa_timestamp)).reverse();
  let bound = ts;
  for (let i = prev.length - 1; i >= 0; i--) {
    if ((bound.getTime() - prev[i].getTime()) / 1000 > gapSeconds) break;
    bound = prev[i];
  }
  const truncated =
    prev.length === lookback &&
    prev.length > 0 &&
    (bound.getTime() - prev[0].getTime()) / 1000 <= gapSeconds;
  return { bound, truncated };
}

/** Forward twin of sessionStartBound. */
export async function sessionEndBound(
  pool: Pool,
  chat: ChatRef,
  ts: Date,
  gapSeconds: number,
  lookahead = 5000
): Promise<{ bound: Date; truncated: boolean }> {
  const r = await pool.query(
    `SELECT m.wa_timestamp FROM messages m
      WHERE m.conversation_id = $1 AND m.account = $2
        AND ${INGESTABLE}
        AND ${WINDOW_PLATFORMS}
        AND m.wa_timestamp > $3
      ORDER BY m.wa_timestamp ASC, m.id ASC
      LIMIT $4`,
    [chat.conversation_id, chat.account, ts, lookahead]
  );
  const next = (r.rows as { wa_timestamp: Date }[]).map(x => new Date(x.wa_timestamp));
  let bound = ts;
  for (const t of next) {
    if ((t.getTime() - bound.getTime()) / 1000 > gapSeconds) break;
    bound = t;
  }
  const truncated =
    next.length === lookahead &&
    next.length > 0 &&
    (next[next.length - 1].getTime() - bound.getTime()) / 1000 <= gapSeconds;
  return { bound, truncated };
}

export async function loadStoredWindows(pool: Pool, chat: ChatRef): Promise<StoredWindow[]> {
  const r = await pool.query(
    `SELECT source_id, content_hash, chunk_count, llm_status
       FROM brain_windows
      WHERE account = $1 AND platform = $2 AND conversation_id = $3`,
    [chat.account, chat.platform, chat.conversation_id]
  );
  return r.rows as StoredWindow[];
}

export interface UpsertWindowInput {
  w: BuiltWindow;
  pushed_hash: string | null;
  chunk_count: number;
  llm_status: LlmStatus;
}

/** Record a window part after (or, in DRY_RUN, without) pushing it. */
export async function upsertWindow(pool: Pool, input: UpsertWindowInput): Promise<void> {
  const { w } = input;
  await pool.query(
    `INSERT INTO brain_windows (
       source_id, account, platform, conversation_id, window_key, part,
       start_ts, end_ts, message_count, first_message_id, last_message_id,
       conv_kind, content_hash, pushed_hash, pushed_at, chunk_count,
       llm_status, llm_input_hash, llm_done_at, llm_error, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
             CASE WHEN $14::text IS NULL THEN NULL ELSE now() END,$15,$16,NULL,NULL,NULL,now())
     ON CONFLICT (source_id) DO UPDATE SET
       account = EXCLUDED.account,
       platform = EXCLUDED.platform,
       conversation_id = EXCLUDED.conversation_id,
       window_key = EXCLUDED.window_key,
       part = EXCLUDED.part,
       start_ts = EXCLUDED.start_ts,
       end_ts = EXCLUDED.end_ts,
       message_count = EXCLUDED.message_count,
       first_message_id = EXCLUDED.first_message_id,
       last_message_id = EXCLUDED.last_message_id,
       conv_kind = EXCLUDED.conv_kind,
       content_hash = EXCLUDED.content_hash,
       pushed_hash = COALESCE(EXCLUDED.pushed_hash, brain_windows.pushed_hash),
       pushed_at = CASE WHEN EXCLUDED.pushed_hash IS NULL
                        THEN brain_windows.pushed_at ELSE now() END,
       chunk_count = EXCLUDED.chunk_count,
       llm_status = CASE WHEN EXCLUDED.content_hash = brain_windows.content_hash
                         THEN brain_windows.llm_status
                         ELSE EXCLUDED.llm_status END,
       llm_input_hash = CASE WHEN EXCLUDED.content_hash <> brain_windows.content_hash
                             THEN NULL ELSE brain_windows.llm_input_hash END,
       llm_done_at = CASE WHEN EXCLUDED.content_hash <> brain_windows.content_hash
                          THEN NULL ELSE brain_windows.llm_done_at END,
       llm_error = CASE WHEN EXCLUDED.content_hash <> brain_windows.content_hash
                        THEN NULL ELSE brain_windows.llm_error END,
       updated_at = now()`,
    [
      w.source_id,
      w.chat.account,
      w.chat.platform,
      w.chat.conversation_id,
      w.window_key,
      w.part,
      w.start_ts,
      w.end_ts,
      w.messages.length,
      w.messages[0].id,
      w.messages[w.messages.length - 1].id,
      w.chat.conv_kind,
      w.content_hash,
      input.pushed_hash,
      input.chunk_count,
      input.llm_status,
    ]
  );
}

/** Forget a window row after its brain documents were deleted. */
export async function deleteWindowRow(pool: Pool, sourceId: string): Promise<void> {
  await pool.query(`DELETE FROM brain_windows WHERE source_id = $1`, [sourceId]);
}

/** Mark the LLM outcome of a window (checkpoint fields). */
export async function setWindowLlmResult(
  pool: Pool,
  sourceId: string,
  status: LlmStatus,
  inputHash: string | null,
  error: string | null
): Promise<void> {
  await pool.query(
    `UPDATE brain_windows
        SET llm_status = $2,
            llm_input_hash = COALESCE($3, llm_input_hash),
            llm_done_at = CASE WHEN $2 = 'done' THEN now() ELSE llm_done_at END,
            llm_error = CASE WHEN $2 = 'failed' THEN left($4, 2000) ELSE NULL END,
            updated_at = now()
      WHERE source_id = $1`,
    [sourceId, status, inputHash, error]
  );
}

export interface PendingLlmWindow {
  source_id: string;
  account: string;
  platform: string;
  conversation_id: string;
  window_key: string;
  part: number;
  start_ts: Date;
  end_ts: Date;
  message_count: number;
  conv_kind: ConvKind;
  content_hash: string;
  llm_input_hash: string | null;
}

/**
 * Closed windows waiting for the LLM, newest first (ADR §7.5 / §9 fase 3).
 * Provisional windows are excluded by the end_ts bound.
 */
export async function fetchPendingLlmWindows(
  pool: Pool,
  opts: {
    accounts: string[];
    closedBefore: Date;
    limit: number;
    after?: { end_ts: Date; source_id: string } | null;
  }
): Promise<PendingLlmWindow[]> {
  const params: unknown[] = [opts.accounts, opts.closedBefore, opts.limit];
  let keyset = '';
  if (opts.after) {
    params.push(opts.after.end_ts, opts.after.source_id);
    keyset = `AND (w.end_ts, w.source_id) < ($4::timestamptz, $5::text)`;
  }
  const r = await pool.query(
    `SELECT w.source_id, w.account, w.platform, w.conversation_id, w.window_key, w.part,
            w.start_ts, w.end_ts, w.message_count, w.conv_kind, w.content_hash, w.llm_input_hash
       FROM brain_windows w
      WHERE w.account = ANY ($1::text[])
        AND w.llm_status IN ('pending','failed')
        AND w.end_ts <= $2::timestamptz
        ${keyset}
      ORDER BY w.end_ts DESC, w.source_id DESC
      LIMIT $3`,
    params
  );
  return r.rows as PendingLlmWindow[];
}

/**
 * Summary of the previous window of the same chat (ADR §5 context, for
 * resolving references). The summary is kept on the ledger row (`llm_summary`,
 * see 016_brain_windows.sql) because re-reading it from the brain would need
 * a read API the ingest surface does not have.
 */
export async function previousSummary(
  pool: Pool,
  account: string,
  platform: string,
  conversationId: string,
  beforeStart: Date
): Promise<string | null> {
  const r = await pool.query(
    `SELECT llm_summary
       FROM brain_windows
      WHERE account = $1 AND platform = $2 AND conversation_id = $3
        AND start_ts < $4 AND llm_status = 'done' AND llm_summary IS NOT NULL
      ORDER BY end_ts DESC, source_id DESC
      LIMIT 1`,
    [account, platform, conversationId, beforeStart]
  );
  return r.rows.length ? (r.rows[0].llm_summary as string) : null;
}

/** Rebuild a BuiltWindow skeleton from a ledger row for the LLM pass. */
export async function loadWindowForLlm(
  pool: Pool,
  row: PendingLlmWindow
): Promise<BuiltWindow | null> {
  const chat: ChatRef = {
    account: row.account,
    platform: row.platform,
    conversation_id: row.conversation_id,
    conversation_name: null,
    conv_kind: row.conv_kind,
  };
  const meta = await pool.query(`SELECT name FROM conversations WHERE id = $1`, [
    row.conversation_id,
  ]);
  chat.conversation_name = meta.rows.length ? meta.rows[0].name : null;
  const msgs = await fetchChatMessages(pool, chat, row.start_ts, row.end_ts);
  if (!msgs.length) return null;
  const config = DEFAULT_WINDOWS_CONFIG;
  const transcript = renderTranscript(msgs, chat, config);
  const participants = participantsOf(msgs, chat, config);
  const header = renderHeader(
    chat,
    participants,
    msgs[0].wa_timestamp,
    msgs[msgs.length - 1].wa_timestamp
  );
  return {
    window_key: row.window_key,
    source_id: row.source_id,
    part: row.part,
    chat,
    start_ts: row.start_ts,
    end_ts: row.end_ts,
    messages: msgs,
    participants,
    header,
    transcript,
    trivial: isTrivialWindow(msgs, config),
    llm_eligible: row.conv_kind === 'chat' || row.conv_kind === 'group',
    content_hash: row.content_hash,
  };
}

// ── backfill plumbing ─────────────────────────────────────────────────────

/** Every (account, platform, canonical conversation) with ingestable messages. */
export interface ChatListItem {
  account: string;
  platform: string;
  conversation_id: string;
}

export async function listChats(
  pool: Pool,
  opts: {
    accounts: string[];
    platform?: string;
    after?: ChatListItem | null;
    limit: number;
  }
): Promise<ChatListItem[]> {
  const params: unknown[] = [opts.accounts];
  let platformFilter = '';
  if (opts.platform) {
    params.push(opts.platform);
    platformFilter = `AND m.platform = $${params.length}`;
  }
  let keyset = '';
  if (opts.after) {
    params.push(opts.after.account, opts.after.conversation_id);
    const n = params.length;
    keyset = `AND (m.account, COALESCE(c.merged_into, m.conversation_id)) >
              (($${n - 1})::text, ($${n})::text)`;
  }
  params.push(opts.limit);
  const r = await pool.query(
    `SELECT DISTINCT m.account, m.platform, COALESCE(c.merged_into, m.conversation_id) AS conversation_id
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.account = ANY ($1::text[])
        AND ${INGESTABLE}
        AND ${WINDOW_PLATFORMS}
        ${platformFilter}
        ${keyset}
      ORDER BY 1, 3
      LIMIT $${params.length}`,
    params
  );
  return r.rows as ChatListItem[];
}

export interface BackfillCursor {
  last_account: string | null;
  last_platform: string | null;
  last_conversation_id: string | null;
  last_end_ts: Date | null;
  last_source_id: string | null;
}

export async function getBackfillCursor(
  pool: Pool,
  runId: string,
  phase: string
): Promise<BackfillCursor | null> {
  const r = await pool.query(
    `SELECT last_account, last_platform, last_conversation_id, last_end_ts, last_source_id
       FROM brain_windows_backfill_cursor WHERE run_id = $1 AND phase = $2`,
    [runId, phase]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return {
    last_account: row.last_account,
    last_platform: row.last_platform,
    last_conversation_id: row.last_conversation_id,
    last_end_ts: row.last_end_ts ? new Date(row.last_end_ts) : null,
    last_source_id: row.last_source_id,
  };
}

export async function setBackfillCursor(
  pool: Pool,
  runId: string,
  phase: string,
  c: Partial<BackfillCursor>
): Promise<void> {
  await pool.query(
    `INSERT INTO brain_windows_backfill_cursor
       (run_id, phase, last_account, last_platform, last_conversation_id, last_end_ts, last_source_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now())
     ON CONFLICT (run_id, phase) DO UPDATE SET
       last_account = EXCLUDED.last_account,
       last_platform = EXCLUDED.last_platform,
       last_conversation_id = EXCLUDED.last_conversation_id,
       last_end_ts = EXCLUDED.last_end_ts,
       last_source_id = EXCLUDED.last_source_id,
       updated_at = now()`,
    [
      runId,
      phase,
      c.last_account ?? null,
      c.last_platform ?? null,
      c.last_conversation_id ?? null,
      c.last_end_ts ?? null,
      c.last_source_id ?? null,
    ]
  );
}

/** Store the LLM summary on the ledger row (previous-window context). */
export async function setWindowSummary(
  pool: Pool,
  sourceId: string,
  summary: string
): Promise<void> {
  await pool.query(
    `UPDATE brain_windows SET llm_summary = $2, updated_at = now() WHERE source_id = $1`,
    [sourceId, summary]
  );
}
