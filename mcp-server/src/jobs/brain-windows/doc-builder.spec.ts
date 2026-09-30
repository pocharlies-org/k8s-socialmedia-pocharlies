import { readFileSync } from 'fs';
import { join } from 'path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { MAX_CONCEPTS, packetDoc, packetHash, windowDocs } from './doc-builder';
import type { ExtractionResult } from './llm-extract';
import { buildWindows, type ConversationMeta } from './window-builder';
import { META, msg } from './test-support/helpers';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(join(__dirname, 'contract', 'conversation-window.schema.json'), 'utf8')));
const ok = (d: unknown) => {
  const v = validate(d);
  if (!v) throw new Error(JSON.stringify(validate.errors));
  return v;
};

const result: ExtractionResult = {
  summary: 'Ana y Luis acuerdan el pedido de mañana. Luis lo recibe.',
  topics: ['pedido', 'entrega-manana'],
  entities: [{ type: 'Person', name: 'Luis' }],
  patterns: ['recordar el pedido'],
};
const metas: ConversationMeta[] = [
  META,
  { ...META, platform: 'telegram', account: 'professional', conversationName: null, isGroup: false, kind: 'bot' },
  { ...META, account: 'leila', conversationName: 'Ñandú "y" <cía>' },
];
const windowFor = (meta: ConversationMeta) =>
  buildWindows(meta, [msg(11, 0, 'hablamos del pedido'), msg(12, 30, 'llega mañana', { sender: 'Luis', isVoice: true }), msg(13, 60, 'vale', { replyToId: '12' })])[0];

describe('doc-builder: every BrainDoc validates against the vendored schema', () => {
  it.each(metas.map((m) => [`${m.platform}/${m.account}`, m] as const))('window + chunks, pending and done, packet (%s)', (_n, meta) => {
    const w = windowFor(meta);
    for (const docs of [windowDocs(w, meta, 'pending', null), windowDocs(w, meta, 'done', result), windowDocs(w, meta, 'skipped', null)]) {
      expect(docs[0].source_id).toBe(w.windowId);
      expect(docs.slice(1).map((d) => d.source_id)).toEqual(docs.slice(1).map((_d, i) => `${w.windowId}#c${i}`));
      docs.forEach(ok);
    }
    const p = packetDoc(w, meta, result)!;
    expect(p.source_id).toBe(`${w.windowId}#kp`);
    ok(p);
  });

  it('window content: LLM summary when done; header + first <=1.500 chars otherwise', () => {
    const w = buildWindows(META, Array.from({ length: 60 }, (_, i) => msg(i + 1, i, `línea ${i} ${'x'.repeat(60)}`)))[0];
    expect(windowDocs(w, META, 'done', result)[0].content).toBe(result.summary);
    const pending = windowDocs(w, META, 'pending', null)[0];
    expect(pending.content.length).toBe(1_500);
    expect(pending.content.startsWith('[whatsapp · Grupo familia] 2026-09-28\n09:00 Ana: línea 0')).toBe(true);
    expect(pending.metadata).toMatchObject({ llm_status: 'pending', patterns: [], window_text: w.windowText, window_hash: w.windowHash });
    expect(windowDocs(w, META, 'done', result)[0].metadata.patterns).toEqual(['recordar el pedido']);
  });

  it('chunks share the window message_count and carry msg_id_first/last', () => {
    const w = windowFor(META);
    const [, c0] = windowDocs(w, META, 'pending', null);
    expect(c0.metadata).toMatchObject({ type: 'conversation_chunk', source: 'conversation', message_count: 3, msg_id_first: '11', msg_id_last: '13', chunk_index: 0, chunk_count: 1 });
  });

  it('packet: "Temas: … Entidades: …", distinct from the summary, ConvDay label, no assertions', () => {
    const p = packetDoc(windowFor(META), META, result)!;
    expect(p.content).toBe('Temas: pedido, entrega-manana. Entidades: Luis.');
    expect(p.content).not.toBe(result.summary);
    expect(p.metadata).toMatchObject({ source: 'knowledge_packet', kp_kind: 'summary', kp_source_label: 'ConvDay', kp_permalinks: [], kp_sensitivity: 'personal', kp_participant_count: 2 });
    expect(JSON.stringify(p.metadata)).not.toContain('assertion');
  });

  it('packet: topics + entities are capped at 12 jointly (topics first)', () => {
    const many: ExtractionResult = {
      summary: 'Resumen.',
      topics: Array.from({ length: 9 }, (_, i) => `tema-${i}`),
      entities: Array.from({ length: 9 }, (_, i) => ({ type: 'Person', name: `P${i}` })),
      patterns: [],
    };
    const p = packetDoc(windowFor(META), META, many)!;
    const m = p.metadata as { kp_topics: string[]; kp_entities: unknown[] };
    expect(m.kp_topics).toHaveLength(9);
    expect(m.kp_entities).toHaveLength(3);
    expect(m.kp_topics.length + m.kp_entities.length).toBe(MAX_CONCEPTS);
    ok(p);
    const tooManyTopics = packetDoc(windowFor(META), META, { ...many, topics: Array.from({ length: 20 }, (_, i) => `t${i}`) })!;
    const mt = tooManyTopics.metadata as { kp_topics: string[]; kp_entities: unknown[] };
    expect(mt.kp_topics.length + mt.kp_entities.length).toBe(MAX_CONCEPTS);
  });

  it('packet: none when there is nothing to learn; hash changes only with the extraction', () => {
    const w = windowFor(META);
    expect(packetDoc(w, META, { ...result, topics: [], entities: [] })).toBeNull();
    const a = packetDoc(w, META, result)!;
    expect(packetHash(a)).toBe(packetHash(packetDoc(w, META, { ...result, patterns: ['otro'] })!));
    expect(packetHash(a)).not.toBe(packetHash(packetDoc(w, META, { ...result, topics: ['otro-tema'] })!));
  });

  it('window ids keep colons of the conversation id (WhatsApp chat ids); first_msg_id stays numeric', () => {
    const meta = { ...META, conversationId: '34600111222:15@s.whatsapp.net' };
    const w = buildWindows(meta, [msg(4711, 0, 'hola')])[0];
    expect(w.windowId).toBe('cw:whatsapp:personal:34600111222:15@s.whatsapp.net:4711');
    const docs = windowDocs(w, meta, 'pending', null);
    expect(docs[1].source_id).toBe(`${w.windowId}#c0`);
    // schema validation of these ids waits for the P1a pattern change (window_id -> [^#\s]+:[0-9]+)
  });
});
