import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { useTestAccounts } from '../domain/test-accounts';
import {
  BuiltWindow,
  ChatRef,
  WindowMessage,
  WindowsConfig,
  DEFAULT_WINDOWS_CONFIG,
  buildWindows,
  upsertWindow,
  childDocs,
  chunkWindow,
  classifyConvKind,
  deleteFromBrain,
  diffWindows,
  initialLlmStatus,
  isProvisional,
  isTrivialWindow,
  llmInputHash,
  loadWindowsConfig,
  madridDate,
  madridTime,
  parentContent,
  parentDoc,
  parseWindowsConfig,
  pushWindowDocs,
  renderHeader,
  renderTranscript,
  sessionEndBound,
  sessionize,
  splitSessionByCap,
  truncateSentences,
  usefulTextLen,
  windowContentHash,
  windowKey,
  windowSourceId,
} from './brain-windows-lib';

useTestAccounts({ whatsapp: { personal: 'http://wa' } });

const CFG: WindowsConfig = DEFAULT_WINDOWS_CONFIG;

function chat(over: Partial<ChatRef> = {}): ChatRef {
  return {
    account: 'personal',
    platform: 'whatsapp',
    conversation_id: 'reforma@g.us',
    conversation_name: 'Reforma casa',
    conv_kind: 'group',
    ...over,
  };
}

function msg(over: Partial<WindowMessage> = {}): WindowMessage {
  return {
    id: '1',
    wa_message_id: 'w1',
    content: 'hola',
    wa_timestamp: new Date('2026-03-14T17:04:00Z'), // Madrid 18:04 (CET)
    direction: 'INBOUND',
    sender_wa_id: '34600000001@c.us',
    sender_name: 'Ana',
    sender_push_name: null,
    message_type: 'TEXT',
    is_forwarded: false,
    ...over,
  };
}

describe('classifyConvKind (ADR 0002 §3)', () => {
  it('bot list wins over type, matched by name or id', () => {
    const cfg: WindowsConfig = {
      ...CFG,
      botChats: [
        { name: 'Synapse monitor', ids: ['tg_-1003785136626'] },
        { name: 'Alertas Monitoring Skirmshop', ids: [] },
      ],
    };
    expect(
      classifyConvKind({ type: 'supergroup', is_group: true }, 'tg_-1003785136626', 'Synapse monitor', cfg)
    ).toBe('bot');
    expect(classifyConvKind({ type: 'private' }, 'tg_7934536267', 'ALERTAS MONITORING SKIRMSHOP', cfg)).toBe(
      'bot'
    );
  });

  it('channel by type or channel list; group by type/is_group; else chat', () => {
    const cfg: WindowsConfig = { ...CFG, channelChats: [{ name: 'Ofertas Chollos' }] };
    expect(classifyConvKind({ type: 'channel' }, 'tg_1', 'X', cfg)).toBe('channel');
    expect(classifyConvKind({ type: 'supergroup' }, 'tg_2', 'Ofertas Chollos', cfg)).toBe('channel');
    expect(classifyConvKind({ type: 'group' }, 'tg_3', 'G', cfg)).toBe('group');
    expect(classifyConvKind({ type: 'GROUP' }, 'tg_4', 'G', cfg)).toBe('group');
    expect(classifyConvKind({ type: 'private', is_group: true }, 'x@g.us', 'Reforma', cfg)).toBe('group');
    expect(classifyConvKind({ type: 'private' }, '34600@c.us', 'Ana', cfg)).toBe('chat');
    expect(classifyConvKind({ type: 'INDIVIDUAL' }, 'tg_5', 'Ana', cfg)).toBe('chat');
  });
});

describe('Madrid time (ADR 0002 §2)', () => {
  it('formats date and time in Europe/Madrid, not UTC', () => {
    const t = new Date('2026-03-14T23:10:00Z'); // 00:10 next day in Madrid (CET)
    expect(madridDate(t)).toBe('2026-03-15');
    expect(madridTime(t)).toBe('00:10');
    const summer = new Date('2026-06-01T22:00:00Z'); // CEST +2
    expect(madridDate(summer)).toBe('2026-06-02');
  });
});

describe('header and transcript (ADR 0002 §2)', () => {
  it('renders the ADR header verbatim', () => {
    const h = renderHeader(
      chat(),
      ['Ana', 'Luis', 'Dani'],
      new Date('2026-03-14T17:02:00Z'),
      new Date('2026-03-14T18:47:00Z')
    );
    expect(h).toBe('[WhatsApp · grupo «Reforma casa» · Ana, Luis, Dani · 2026-03-14 18:02–19:47]');
  });

  it('caps participants at 8 with +N and spans days in the range', () => {
    const names = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10'];
    const h = renderHeader(
      chat({ platform: 'telegram', conversation_name: 'Casa', conv_kind: 'chat' }),
      names,
      new Date('2026-03-14T17:02:00Z'),
      new Date('2026-03-16T18:47:00Z')
    );
    expect(h).toBe(
      '[Telegram · chat «Casa» · A1, A2, A3, A4, A5, A6, A7, A8 +2 · 2026-03-14 18:02–2026-03-16 19:47]'
    );
  });

  it('falls back to the conversation id when the chat has no name', () => {
    const h = renderHeader(chat({ conversation_name: null }), ['Ana'], new Date('2026-03-14T17:00:00Z'), new Date('2026-03-14T17:05:00Z'));
    expect(h).toContain('«reforma@g.us»');
  });

  it('names OUTBOUND by account and INBOUND by name > push_name > number', () => {
    const msgs = [
      msg({ id: '1', wa_message_id: 'a', direction: 'OUTBOUND' }),
      msg({ id: '2', wa_message_id: 'b', sender_name: null, sender_push_name: 'Lui', content: 'ok' }),
      msg({ id: '3', wa_message_id: 'c', sender_name: null, sender_push_name: null, sender_wa_id: '34600555666@c.us', content: 'vale' }),
    ];
    const t = renderTranscript(msgs, chat(), CFG);
    expect(t).toBe('18:04 Dani: hola\n18:04 Lui: ok\n18:04 34600555666: vale');
  });

  it('marks [voz] and [reenviado] and inserts day separators', () => {
    const msgs = [
      msg({ id: '1', wa_message_id: 'a', wa_timestamp: new Date('2026-03-14T22:50:00Z'), content: 'temprano' }),
      msg({
        id: '2', wa_message_id: 'b', wa_timestamp: new Date('2026-03-14T23:10:00Z'),
        message_type: 'VOICE', is_forwarded: true, direction: 'OUTBOUND', content: 'si, llevo muestras',
      }),
    ];
    const t = renderTranscript(msgs, chat(), CFG);
    expect(t).toBe('23:50 Ana: temprano\n— 2026-03-15 —\n00:10 Dani [voz] [reenviado]: si, llevo muestras');
  });

  it('collapses newlines so one message is one line', () => {
    const t = renderTranscript([msg({ content: 'una\ndos' })], chat(), CFG);
    expect(t).toBe('18:04 Ana: una dos');
  });

  it('unwraps an ASR echo body to prose (INFRA-364), never renders raw JSON', () => {
    const t = renderTranscript(
      [
        // Real row 1254112: bot echo with the raw STT body, still unfixed.
        msg({ id: '1', wa_message_id: 'a', content: '🎙️ "{"text":"La prueba de voz.","usage":null}"' }),
        // Prose that merely mentions the JSON shape stays verbatim.
        msg({ id: '2', wa_message_id: 'b', content: 'dice 🎙️ "{"text":"x"}" al final null' }),
      ],
      chat(),
      CFG
    );
    expect(t).toBe('18:04 Ana: 🎙️ La prueba de voz.\n18:04 Ana: dice 🎙️ "{"text":"x"}" al final null');
  });
});

describe('sessionize (ADR 0002 §1)', () => {
  it('cuts when the silence exceeds the gap, not at exactly it', () => {
    const base = Date.parse('2026-03-14T10:00:00Z');
    const s = (min: number) => new Date(base + min * 60_000);
    const msgs = [
      msg({ id: '1', wa_timestamp: s(0) }),
      msg({ id: '2', wa_timestamp: s(60) }), // exactly 3600 s: same window
      msg({ id: '3', wa_timestamp: s(121) }), // 61 min gap: new window
    ];
    const sessions = sessionize(msgs, 3600);
    expect(sessions.map(x => x.length)).toEqual([2, 1]);
  });

  it('orders nothing: input is assumed sorted by (wa_timestamp, id)', () => {
    expect(sessionize([], 3600)).toEqual([]);
  });
});

describe('splitSessionByCap (ADR 0002 §1)', () => {
  const big = (n: number) => 'x'.repeat(n);

  it('splits at the largest temporal gap that keeps the part in [floor, cap]', () => {
    const base = Date.parse('2026-03-14T09:00:00Z');
    const msgs = Array.from({ length: 20 }, (_, i) =>
      msg({
        id: String(i + 1),
        wa_message_id: `w${i + 1}`,
        content: big(1000),
        wa_timestamp: new Date(base + i * 60_000 + (i >= 10 ? 2 * 3600_000 : 0)),
      })
    );
    const parts = splitSessionByCap(msgs, chat(), CFG);
    expect(parts.length).toBe(2);
    expect(parts[0].length).toBe(10); // cut right before the 2 h gap
  });

  it('falls back to the message boundary nearest the cap when there is no gap', () => {
    const base = Date.parse('2026-03-14T09:00:00Z');
    const msgs = Array.from({ length: 20 }, (_, i) =>
      msg({
        id: String(i + 1),
        wa_message_id: `w${i + 1}`,
        content: big(1000),
        wa_timestamp: new Date(base + i * 60_000),
      })
    );
    const parts = splitSessionByCap(msgs, chat(), CFG);
    expect(parts[0].length).toBeGreaterThanOrEqual(8);
    expect(parts[0].length).toBeLessThanOrEqual(15);
    expect(parts.flatMap(p => p).length).toBe(20);
  });

  it('splits a huge bot session into thousands of parts without a runaway guard', () => {
    // Synapse monitor: one 24-day session, ~57M chars -> ~3.5k parts. 20k x 1000 chars here.
    const base = Date.parse('2026-03-14T09:00:00Z');
    const msgs = Array.from({ length: 20000 }, (_, i) =>
      msg({
        id: String(i + 1),
        wa_message_id: `w${i + 1}`,
        content: big(1000),
        wa_timestamp: new Date(base + i * 60_000),
      })
    );
    const parts = splitSessionByCap(msgs, chat(), CFG);
    expect(parts.length).toBeGreaterThan(1000);
    expect(parts.flatMap(p => p).length).toBe(20000);
    for (const p of parts) expect(p.length).toBeGreaterThan(0);
  });

  it('truncates a single message over the cap by sentences', () => {
    const text = 'frase de prueba. '.repeat(1100); // 17 600 > 16000
    const parts = splitSessionByCap([msg({ content: text })], chat(), CFG);
    expect(parts.length).toBe(1);
    expect(parts[0][0].content.length).toBeLessThanOrEqual(16000);
    expect(parts[0][0].content.endsWith(' …')).toBe(true);
  });

  it('truncateSentences cuts on a sentence boundary', () => {
    const t = truncateSentences('uno. dos. tres. cuatro. cinco.', 12);
    expect(t.length).toBeLessThanOrEqual(14);
    expect(t.endsWith(' …')).toBe(true);
  });
});

describe('trivial detection (ADR 0002 §3)', () => {
  it('is trivial under 4 messages', () => {
    expect(isTrivialWindow([msg(), msg({ id: '2' }), msg({ id: '3' })], CFG)).toBe(true);
  });

  it('is trivial when the useful text is under 160 chars (filler and emoji do not count)', () => {
    const msgs = ['ok', 'vale', '👍🎉❤️', 'gracias!!', 'jajaja'].map((c, i) =>
      msg({ id: String(i), content: c })
    );
    expect(usefulTextLen(msgs)).toBeLessThan(160);
    expect(isTrivialWindow(msgs, CFG)).toBe(true);
  });

  it('is not trivial with real content', () => {
    const msgs = Array.from({ length: 4 }, (_, i) =>
      msg({ id: String(i), content: `pues mira, el presupuesto del azulejo sube un quince por ciento respecto al ${i}` })
    );
    expect(isTrivialWindow(msgs, CFG)).toBe(false);
  });
});

describe('ids and hashes (ADR 0002 §1/§5)', () => {
  it('window_key carries the epoch seconds of the first message', () => {
    const k = windowKey(chat(), new Date('2026-03-14T17:02:00Z'));
    expect(k).toBe(`whatsapp:personal:reforma@g.us:${Math.floor(Date.parse('2026-03-14T17:02:00Z') / 1000)}`);
    expect(windowSourceId(k, 0)).toBe(`win:${k}`);
    expect(windowSourceId(k, 2)).toBe(`win:${k}:p2`);
  });

  it('content_hash is stable and reacts to edits', () => {
    const a = {
      window_key: 'k', part: 0, transcript: 'hola', message_ids: ['w1'],
      conversation_name: 'n', conv_kind: 'chat' as const,
    };
    expect(windowContentHash(a)).toBe(windowContentHash({ ...a }));
    expect(windowContentHash(a)).not.toBe(windowContentHash({ ...a, transcript: 'hola editado' }));
    expect(windowContentHash(a)).not.toBe(windowContentHash({ ...a, message_ids: ['w1', 'w2'] }));
  });

  it('llm_input_hash changes with the previous summary or the model', () => {
    const h = llmInputHash('tooling', 'hdr', 'trans', null);
    expect(h).toBe(llmInputHash('tooling', 'hdr', 'trans', null));
    expect(h).not.toBe(llmInputHash('tooling', 'hdr', 'trans', 'previo'));
    expect(h).not.toBe(llmInputHash('otro', 'hdr', 'trans', null));
  });
});

describe('buildWindows (ADR 0002 §1-§3)', () => {
  it('produces stable parts with p1..pN ids over the cap', () => {
    const base = Date.parse('2026-03-14T09:00:00Z');
    const msgs = Array.from({ length: 20 }, (_, i) =>
      msg({
        id: String(i + 1), wa_message_id: `w${i + 1}`, content: 'x'.repeat(1000),
        wa_timestamp: new Date(base + i * 60_000),
      })
    );
    const ws = buildWindows(chat(), msgs, CFG);
    expect(ws.length).toBe(2);
    expect(ws[0].part).toBe(1);
    expect(ws[1].part).toBe(2);
    expect(ws[0].source_id).toMatch(/:p1$/);
    expect(ws[1].source_id).toMatch(/:p2$/);
    expect(ws[0].window_key).toBe(ws[1].window_key); // parts share the session key
  });

  it('a single window has part 0 and no suffix', () => {
    const ws = buildWindows(chat(), [msg(), msg({ id: '2' }), msg({ id: '3' }), msg({ id: '4', content: 'texto suficiente para no ser trivial en absoluto, con contenido real y todo' })], CFG);
    expect(ws.length).toBe(1);
    expect(ws[0].part).toBe(0);
    expect(ws[0].source_id).toMatch(/^win:whatsapp:personal:reforma@g\.us:\d+$/);
  });

  it('marks trivial and llm-eligibility per kind', () => {
    const trivial = buildWindows(chat(), [msg(), msg({ id: '2' })], CFG)[0];
    expect(trivial.trivial).toBe(true);
    expect(trivial.llm_eligible).toBe(false);
    expect(initialLlmStatus(trivial)).toBe('skipped');

    const real = Array.from({ length: 4 }, (_, i) =>
      msg({ id: String(i), content: `hablemos del pedido de azulejos para la reforma del bano numero ${i}` })
    );
    const w = buildWindows(chat({ conv_kind: 'channel' }), real, CFG)[0];
    expect(w.trivial).toBe(false);
    expect(w.llm_eligible).toBe(false); // channel never goes through the LLM
    expect(initialLlmStatus(w)).toBe('skipped');
    const w2 = buildWindows(chat({ conv_kind: 'chat' }), real, CFG)[0];
    expect(w2.llm_eligible).toBe(true);
    expect(initialLlmStatus(w2)).toBe('pending');
  });

  it('provisional only while the last message is younger than the gap', () => {
    const ws = buildWindows(chat(), [msg()], CFG);
    const now = new Date(ws[0].end_ts.getTime() + 60_000);
    expect(isProvisional(ws[0], CFG, now)).toBe(true);
    expect(isProvisional(ws[0], CFG, new Date(ws[0].end_ts.getTime() + 3700_000))).toBe(false);
  });
});

describe('chunkWindow (ADR 0002 §3)', () => {
  const windowOf = (msgs: WindowMessage[], over: Partial<ChatRef> = {}): BuiltWindow =>
    buildWindows(chat(over), msgs, CFG)[0];

  it('makes children of 3-8 messages with a one-message overlap', () => {
    const base = Date.parse('2026-03-14T09:00:00Z');
    const msgs = Array.from({ length: 12 }, (_, i) =>
      msg({
        id: String(i + 1), wa_message_id: `w${i + 1}`,
        content: `mensaje numero ${i + 1} con algo de texto util para que pese lo suyo en el trozo`,
        wa_timestamp: new Date(base + i * 60_000),
      })
    );
    const w = windowOf(msgs);
    const chunks = chunkWindow(w, CFG);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i + 1);
      expect(c.source_id).toBe(`${w.source_id}#c${i + 1}`);
      expect(c.content.startsWith(w.header)).toBe(true);
      expect(c.message_ids.length).toBeGreaterThanOrEqual(3);
      expect(c.message_ids.length).toBeLessThanOrEqual(8);
    });
    // consecutive children share exactly one message id (the overlap)
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1].message_ids;
      const cur = chunks[i].message_ids;
      expect(cur[0]).toBe(prev[prev.length - 1]);
    }
    // every message of the window is covered
    const covered = new Set(chunks.flatMap(c => c.message_ids));
    expect(covered.size).toBe(12);
  });

  it('splits a single message over 1600 chars by sentences', () => {
    const msgs = [
      msg({ id: '1', wa_message_id: 'w1', content: 'frase larga de relleno. '.repeat(120) }),
      msg({ id: '2', wa_message_id: 'w2', content: 'y aqui Ana responde con algo de sustancia real' }),
      msg({ id: '3', wa_message_id: 'w3', content: 'y Luis tercia con mas texto util del tema' }),
      msg({ id: '4', wa_message_id: 'w4', content: 'y cierra Dani la idea con un poco mas de rollo' }),
    ];
    const w = windowOf(msgs);
    const chunks = chunkWindow(w, CFG);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach(c => expect(c.content.length).toBeLessThanOrEqual(1600 + w.header.length + 1));
    expect(chunks.flatMap(c => c.message_ids).filter(x => x === 'w1').length).toBeGreaterThan(1);
  });

  it('a small window becomes a single child', () => {
    const msgs = Array.from({ length: 4 }, (_, i) =>
      msg({ id: String(i), wa_message_id: `w${i}`, content: `cuatro mensajes con algo de texto cada uno ${i}` })
    );
    const w = windowOf(msgs);
    const chunks = chunkWindow(w, CFG);
    expect(chunks.length).toBe(1);
    expect(chunks[0].message_ids).toEqual(['w0', 'w1', 'w2', 'w3']);
  });
});

describe('brain documents (ADR 0002 §3)', () => {
  const built = (): BuiltWindow => {
    const msgs = Array.from({ length: 5 }, (_, i) =>
      msg({
        id: String(i), wa_message_id: `w${i}`,
        content: `contenido real de la conversacion sobre la reforma, mensaje ${i}`,
        wa_timestamp: new Date(Date.parse('2026-03-14T09:00:00Z') + i * 60_000),
      })
    );
    return buildWindows(chat(), msgs, CFG)[0];
  };

  it('parent carries the ADR metadata and content', () => {
    const w = built();
    const doc = parentDoc(w, { llm_status: 'pending' });
    expect(doc.source_id).toBe(w.source_id);
    expect(doc.content.startsWith(w.header)).toBe(true);
    expect(doc.metadata.type).toBe('conversation_window');
    expect(doc.metadata.conv_kind).toBe('group');
    expect(doc.metadata.observed_at).toBe(w.end_ts.toISOString());
    expect(doc.metadata.message_ids).toEqual(['w0', 'w1', 'w2', 'w3', 'w4']);
    expect(doc.metadata.transcript).toBe(w.transcript);
    expect(doc.metadata.content_hash).toBe(w.content_hash);
    expect(doc.metadata.llm_status).toBe('pending');
    expect(doc.metadata.summary).toBeUndefined();
  });

  it('parent content switches to header + summary when extracted', () => {
    const w = built();
    const doc = parentDoc(w, { llm_status: 'done', summary: 'Resumen: la reforma sube.', extraction: { topics: ['reforma'] } });
    expect(doc.content).toBe(`${w.header}\nResumen: la reforma sube.`);
    expect((doc.metadata as Record<string, unknown>).extraction).toEqual({ topics: ['reforma'] });
  });

  it('parent without summary keeps ~1500 chars of transcript', () => {
    const w = built();
    const long = { ...w, transcript: 'a'.repeat(5000) };
    expect(parentContent(long)).toBe(`${long.header}\n${'a'.repeat(1500)}`);
  });

  it('children carry window_source_id and chunk_index', () => {
    const w = built();
    const chunks = chunkWindow(w, CFG);
    const docs = childDocs(w, chunks);
    expect(docs[0].source_id).toBe(`${w.source_id}#c1`);
    expect((docs[0].metadata as Record<string, unknown>).type).toBe('conversation_chunk');
    expect((docs[0].metadata as Record<string, unknown>).window_source_id).toBe(w.source_id);
    expect((docs[0].metadata as Record<string, unknown>).chunk_index).toBe(1);
  });
});

describe('diffWindows (ADR 0002 §7.3)', () => {
  const w = (source_id: string, content_hash: string): BuiltWindow =>
    ({ source_id, content_hash } as BuiltWindow);

  it('pushes new and changed, deletes vanished, leaves equal alone', () => {
    const d = diffWindows(
      [
        { source_id: 'a', content_hash: 'h1', chunk_count: 2, llm_status: 'done' },
        { source_id: 'b', content_hash: 'h2', chunk_count: 0, llm_status: 'skipped' },
        { source_id: 'c', content_hash: 'h3', chunk_count: 1, llm_status: 'done' },
      ],
      [w('a', 'h1'), w('a2', 'h9'), w('b', 'CHANGED')]
    );
    expect(d.toPush.map(x => x.source_id).sort()).toEqual(['a2', 'b']);
    expect(d.toDelete.map(x => x.source_id)).toEqual(['c']);
  });

  it('an empty ledger pushes everything', () => {
    expect(diffWindows([], [w('a', 'h')]).toPush.length).toBe(1);
  });
});

describe('config file (ADR 0002 §5)', () => {
  it('parses defaults and the seeded lists', () => {
    const cfg = parseWindowsConfig({
      bots: ['Synapse monitor', { name: 'Alertas', ids: ['tg_1'] }],
      channels: [{ name: 'Ofertas Chollos' }],
      outboundNames: { personal: 'Dani' },
      gapSeconds: 3600,
    });
    expect(cfg.gapSeconds).toBe(3600);
    expect(cfg.transcriptCapChars).toBe(16000);
    expect(cfg.botChats).toEqual([{ name: 'Synapse monitor' }, { name: 'Alertas', ids: ['tg_1'] }]);
    expect(cfg.outboundNames.personal).toBe('Dani');
  });

  it('loads the checked-in k8s/base/brain-windows-config.yaml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bw-cfg-'));
    const file = join(dir, 'c.yaml');
    writeFileSync(
      file,
      require('fs').readFileSync(join(__dirname, '../../../k8s/base/brain-windows-config.yaml'), 'utf8')
    );
    const cfg = loadWindowsConfig(file);
    expect(cfg.botChats.map(b => b.name)).toEqual(
      expect.arrayContaining([
        'Synapse monitor',
        'Alertas Monitoring Skirmshop',
        'Skirmshop ES OP',
        'github pocharlies-org',
        'Pocharlies Operations',
      ])
    );
    // Skirmshop Spain Hermes is Dani talking to Hermes: a normal chat, LLM-eligible.
    expect(cfg.botChats.map(b => b.name)).not.toContain('Skirmshop Spain Hermes');
    expect(cfg.channelChats.map(c => c.name)).toEqual(
      expect.arrayContaining(['Ofertas Chollos', 'Anonymous Catalonia', 'Airsoft4Tiesos'])
    );
    expect(cfg.outboundNames).toEqual({ personal: 'Dani', professional: 'Skirmshop', leila: 'Leila' });
  });

  it('rejects malformed entries', () => {
    expect(() => parseWindowsConfig({ bots: 'nope' })).toThrow(/must be a list/);
    expect(() => parseWindowsConfig({ bots: [{}] })).toThrow(/needs name and\/or ids/);
  });
});

describe('brain http surface', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('deleteFromBrain: 200 and 404 succeed, 5xx retries, 4xx fails fast', async () => {
    const calls: { url: string; body: unknown }[] = [];
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      if (calls.length === 1) return new Response('', { status: 404 });
      if (calls.length === 2) return new Response('boom', { status: 502 });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = { brainUrl: 'http://brain' };
    await deleteFromBrain(cfg, 'personal', 'whatsapp', 'win:k', async () => {});
    await deleteFromBrain(cfg, 'personal', 'whatsapp', 'win:k2', async () => {}); // 502 -> retry -> 200
    expect(calls[0].url).toBe('http://brain/instances/personal/delete-document');
    expect(calls[0].body).toEqual({ adapter: 'whatsapp', source_id: 'win:k' });
    expect(calls.length).toBe(3);
    await expect(
      (async () => {
        global.fetch = jest.fn(async () => new Response('nope', { status: 400 })) as unknown as typeof fetch;
        return deleteFromBrain(cfg, 'personal', 'whatsapp', 'win:k3', async () => {});
      })()
    ).rejects.toThrow(/400/);
  });

  it('pushWindowDocs batches docs and routes by account registry', async () => {
    const bodies: { documents: { source_id: string }[] }[] = [];
    global.fetch = jest.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ chunks_ingested: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const docs = Array.from({ length: 60 }, (_, i) => ({
      source_id: `win:k#c${i}`,
      content: 'x',
      metadata: { platform: 'telegram' },
    }));
    const n = await pushWindowDocs({ brainUrl: 'http://brain' }, 'personal', docs, 25);
    expect(n).toBe(3); // 3 push-ingest calls of 25/25/10
    expect(bodies[0].documents.length).toBe(25);
    expect(bodies[2].documents.length).toBe(10);
  });
});

describe('session boundary helpers', () => {
  it('sessionEndBound walks forward through small gaps (fake pool)', async () => {
    const pool = {
      query: jest.fn(async () => ({
        rows: [
          { wa_timestamp: new Date('2026-03-14T10:30:00Z') },
          { wa_timestamp: new Date('2026-03-14T11:00:00Z') }, // 30 min later: same session
          { wa_timestamp: new Date('2026-03-14T13:00:00Z') }, // 2 h later: new session
        ],
      })),
    } as unknown as import('pg').Pool;
    const r = await sessionEndBound(pool, chat(), new Date('2026-03-14T10:00:00Z'), 3600);
    expect(r.bound.toISOString()).toBe(new Date('2026-03-14T11:00:00Z').toISOString());
    expect(r.truncated).toBe(false);
  });
});

describe('upsertWindow SQL', () => {
  it('has as many VALUES expressions as target columns', async () => {
    const calls: string[] = [];
    const pool = { query: async (sql: string) => { calls.push(sql); return { rows: [] }; } };
    const base = Date.parse('2026-03-14T09:00:00Z');
    const ms = [msg({ id: '1', wa_message_id: 'w1', content: 'hola', wa_timestamp: new Date(base) })];
    const w = buildWindows(chat(), ms, CFG)[0];
    await upsertWindow(pool as any, { w, pushed_hash: 'h', chunk_count: 0, llm_status: 'skipped' });
    const sql = calls[0];
    const splitTop = (s: string) => {
      const out: string[] = [];
      let depth = 0, cur = '';
      for (const ch of s) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
      }
      out.push(cur);
      return out.map(x => x.trim()).filter(Boolean);
    };
    const m = /INSERT INTO brain_windows \(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*)\)\s*ON CONFLICT/.exec(sql);
    expect(m).not.toBeNull();
    const cols = splitTop(m![1]);
    const vals = splitTop(m![2]);
    expect(cols.length).toBe(21);
    expect(vals.length).toBe(cols.length);
  });
});
