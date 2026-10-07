// Streaming helpers for the Hermes Chat Completions SSE contract.
//
// Live evidence (Hermes Agent v0.21.3, profile `socialmedia`, 2026-09-26) for one streamed turn that
// used one tool, captured against the running gateway with a throwaway session key:
//   data: {"object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}
//   : keepalive
//   event: hermes.tool.progress
//   data: {"tool":"read_file","emoji":"...","label":"hostname","toolCallId":"call_...","status":"running"}
//   event: hermes.tool.progress
//   data: {"tool":"read_file","toolCallId":"call_...","status":"completed"}
//   data: {"object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{...}}
//   data: [DONE]
// Response headers at stream start carry `X-Hermes-Session-Id` and `X-Hermes-Session-Key`, so the same
// session continuity works with stream:true. Answer text arrives in `delta.content`, reasoning (when the
// model produces it) in `delta.reasoning_content`, and an idle gateway emits a `: keepalive` comment every
// 10 seconds. The progress `label` is derived from tool arguments, so it is never forwarded: only the
// tool identifier is trusted, and it is mapped to a fixed display label here.

const TOOL_LABELS = {
  social_read_current_chat: 'Leyendo el chat actual',
  social_send_current_chat: 'Preparando una propuesta',
  social_deliver_current_chat: 'Enviando el mensaje a WhatsApp',
  web_search: 'Buscando en la web',
  web_extract: 'Leyendo una pagina web',
  terminal: 'Ejecutando un comando',
  process_manage: 'Revisando un proceso',
  read_file: 'Leyendo un archivo',
  write_file: 'Escribiendo un archivo',
  patch: 'Editando un archivo',
  search_files: 'Buscando archivos',
  browser_navigate: 'Navegando el navegador',
  browser_snapshot: 'Tomando un snapshot del navegador',
  memory: 'Consultando la memoria',
  memory_search: 'Consultando la memoria',
};

const SAFE_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const REDACTED_CAPABILITY = '[redacted capability]';
const DONE_SENTINEL = '[DONE]';

// The tool identifier comes from the gateway tool registry, never from call arguments.
function safeToolLabel(name) {
  if (typeof name !== 'string' || !SAFE_TOOL_NAME.test(name)) return 'Usando una herramienta';
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  if (name.startsWith('browser_')) return 'Usando el navegador';
  if (name.startsWith('social_')) return 'Usando una herramienta del chat';
  return `Usando ${name.replace(/_/g, ' ')}`;
}

// Activity text is rendered directly by the browser, so strip control characters and bound its length.
function safeText(value, max = 120) {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

// Incremental SSE reader. `line` holds the current unterminated line, `block` the fields of the frame
// being assembled, and a single TextDecoder instance lives for the whole turn so a UTF-8 sequence split
// across chunks is never decoded into replacement characters. A trailing lone CR is held back because it
// may be the first half of a CRLF pair.
export class SseDecoder {
  constructor() {
    this.decoder = new TextDecoder();
    this.line = '';
    this.block = null;
    this.pendingCr = false;
  }
  push(chunk) {
    const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.#consume(text, false);
  }
  end() {
    const tail = this.decoder.decode();
    this.decoder = new TextDecoder();
    const frames = [];
    if (this.pendingCr) {
      this.pendingCr = false;
      this.#endLine(frames);
    }
    return [...frames, ...this.#consume(tail, true)];
  }
  #consume(text, flush) {
    const frames = [];
    // A CR held from the previous chunk terminates a line on its own (SSE allows CR, LF and CRLF). When
    // the next chunk starts with LF the pair is a single terminator, so that LF must not open a blank line.
    if (this.pendingCr) {
      this.pendingCr = false;
      if (text.startsWith('\n')) text = text.slice(1);
      this.#endLine(frames);
    }
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (char === '\r') {
        if (i + 1 === text.length) {
          if (!flush) { this.pendingCr = true; break; }
          this.#endLine(frames);
          continue;
        }
        if (text[i + 1] === '\n') i += 1;
        this.#endLine(frames);
        continue;
      }
      if (char === '\n') { this.#endLine(frames); continue; }
      this.line += char;
    }
    if (flush) {
      this.#endLine(frames);
      const frame = finalizeBlock(this.block);
      this.block = null;
      if (frame) frames.push(frame);
    }
    return frames;
  }
  #endLine(frames) {
    const line = this.line;
    this.line = '';
    if (line === '') {
      const frame = finalizeBlock(this.block);
      this.block = null;
      if (frame) frames.push(frame);
      return;
    }
    if (line.startsWith(':')) return;
    const index = line.indexOf(':');
    const field = index === -1 ? line : line.slice(0, index);
    let value = index === -1 ? '' : line.slice(index + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    this.block ??= { event: '', data: [] };
    if (field === 'event') this.block.event = value;
    else if (field === 'data') this.block.data.push(value);
  }
}

function finalizeBlock(block) {
  if (!block) return null;
  const data = block.data.join('\n');
  if (!block.event) {
    if (!data) return null;
    if (data === DONE_SENTINEL) return { event: 'done', data };
  }
  return { event: block.event || 'message', data };
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function redactAll(text, capability) {
  return capability ? text.split(capability).join(REDACTED_CAPABILITY) : text;
}

// Longest suffix of `text` that is a proper prefix of `capability`. Holding back exactly that many
// characters keeps a capability split across chunks from leaking while ordinary text, whose tail does
// not look like the start of the token, is emitted immediately.
function holdLength(text, capability) {
  const max = Math.min(text.length, capability.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (text.endsWith(capability.slice(0, length))) return length;
  }
  return 0;
}

export class CapabilityRedactor {
  constructor(capability) {
    this.capability = typeof capability === 'string' && capability ? capability : null;
    this.pending = '';
  }
  push(text) {
    if (typeof text !== 'string' || !text) return '';
    if (!this.capability) return text;
    this.pending = redactAll(this.pending + text, this.capability);
    const hold = holdLength(this.pending, this.capability);
    const emit = this.pending.slice(0, this.pending.length - hold);
    this.pending = this.pending.slice(this.pending.length - hold);
    return emit;
  }
  flush() {
    const rest = this.pending;
    this.pending = '';
    return rest;
  }
}

export function sseHeaders() {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  };
}

export function openSse(res) {
  res.writeHead(200, sseHeaders());
  return {
    event(name, value) { if (!res.destroyed && !res.writableEnded) res.write(`event: ${name}\ndata: ${JSON.stringify(value ?? {})}\n\n`); },
    comment() { if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n'); },
    end() { if (!res.writableEnded) res.end(); },
  };
}

// Consumes Hermes Chat Completions SSE frames and produces the browser contract: activity {phase,label}
// and delta {text}, plus the accumulated redacted answer used for the final result event.
export class HermesStreamAccumulator {
  constructor({ capability, onActivity = () => {}, onDelta = () => {} } = {}) {
    this.decoder = new SseDecoder();
    this.redactor = new CapabilityRedactor(capability);
    this.onActivity = onActivity;
    this.onDelta = onDelta;
    this.text = '';
    this.finishReason = null;
    this.sawDone = false;
    this.sawReasoning = false;
    this.streamError = null;
    this.tools = new Map();
  }
  push(chunk) { for (const frame of this.decoder.push(chunk)) this.handle(frame); }
  end() {
    for (const frame of this.decoder.end()) this.handle(frame);
    const rest = this.redactor.flush();
    if (rest) { this.text += rest; this.onDelta(rest); }
  }
  emitActivity(phase, label) { this.onActivity({ phase, label: safeText(label) }); }
  handle(frame) {
    if (frame.event === 'done') { this.sawDone = true; return; }
    if (frame.event === 'error') { this.#recordError(parseJson(frame.data)); return; }
    const payload = parseJson(frame.data);
    if (!payload || typeof payload !== 'object') return;
    if (frame.event === 'hermes.tool.progress') { this.#toolProgress(payload); return; }
    if (frame.event === 'message' || frame.event === 'chat.completion.chunk') {
      if (payload.error && !payload.choices) { this.#recordError(payload); return; }
      const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
      if (!choice) return;
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) this.finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
        : typeof delta.reasoning === 'string' ? delta.reasoning : '';
      if (reasoning && !this.sawReasoning) { this.sawReasoning = true; this.emitActivity('thinking', 'Razonando'); }
      const content = typeof delta.content === 'string' ? delta.content : '';
      if (!content) return;
      const safe = this.redactor.push(content);
      this.text += safe;
      if (safe) this.onDelta(safe);
      return;
    }
    // Unknown named events are ignored so a future gateway event cannot break the turn.
  }
  // Keep the upstream reason for the server log only: the browser gets a stable message so gateway and
  // provider internals are never reflected to the UI, and a partial answer plus an error frame is still
  // an incomplete turn.
  #recordError(payload) {
    if (this.streamError || !payload || typeof payload !== 'object') return;
    const source = payload.error && typeof payload.error === 'object' ? payload.error : payload;
    const reason = [source?.message, typeof payload.error === 'string' ? payload.error : null, source?.code, payload.message]
      .find(value => typeof value === 'string' && value.trim());
    const cleaned = safeText(reason, 300);
    if (cleaned) this.streamError = cleaned;
  }
  #toolProgress(payload) {
    const tool = typeof payload.tool === 'string' ? payload.tool : '';
    const callId = typeof payload.toolCallId === 'string' ? payload.toolCallId : tool;
    const status = typeof payload.status === 'string' ? payload.status.toLowerCase() : 'running';
    const key = `${tool}:${callId}`;
    const label = safeToolLabel(tool);
    if (status === 'running' || status === 'started') {
      if (this.tools.get(key) === 'running') return;
      this.tools.set(key, 'running');
      this.emitActivity('tool', label);
      return;
    }
    if (this.tools.get(key) === 'finished') return;
    this.tools.set(key, 'finished');
    this.emitActivity(status === 'error' || status === 'failed' ? 'tool_error' : 'tool_done', label);
  }
  // Same completion rules as the non-streaming adapter, plus protection against a truncated stream: an
  // explicit negative header, a non-stop finish reason, or an upstream error frame always fails, and a
  // stream that reported neither [DONE] nor a finish reason cannot be trusted as a complete turn.
  outcome(header) {
    const sessionId = header('x-hermes-session-id') || null;
    const responseId = header('x-hermes-response-id') || null;
    const conversation = header('x-hermes-conversation') || null;
    const incomplete = header('x-hermes-completed') === 'false'
      || Boolean(this.streamError)
      || (this.finishReason !== null && this.finishReason !== 'stop')
      || (!this.sawDone && this.finishReason === null);
    const usableAnswer = this.text.trim().length > 0;
    return {
      completed: !incomplete && usableAnswer && Boolean(sessionId || responseId || conversation),
      answer: this.text, sessionId, responseId, conversation,
      error: this.streamError || null,
    };
  }
}
