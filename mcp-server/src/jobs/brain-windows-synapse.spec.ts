import { BrainDoc } from './brain-ingest-lib';
import {
  EventPublisher,
  SynapseEvent,
  UPSERT_BATCH,
  deleteEvents,
  synapseSink,
  tenantForAccount,
  upsertEvents,
  uuidFromHex,
} from './brain-windows-synapse';

const doc = (id: string, platform = 'telegram', content = 'hola'): BrainDoc => ({
  source_id: id,
  content,
  metadata: { platform, type: 'conversation_window' },
});

describe('brain-windows-synapse', () => {
  it('maps accounts to Synapse tenants', () => {
    expect(tenantForAccount('personal')).toBe('family');
    expect(tenantForAccount('professional')).toBe('skirmshop');
  });

  it('derives a stable UUID-shaped message id', () => {
    const id = uuidFromHex('a'.repeat(64));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidFromHex('a'.repeat(64))).toBe(id);
  });

  it('builds one upsert event per batch with adapter, hash and the documents', () => {
    const docs = Array.from({ length: UPSERT_BATCH + 1 }, (_, i) => doc(`win:t:${i}`));
    const evs = upsertEvents('personal', docs);
    expect(evs).toHaveLength(2);
    expect(evs[0].routingKey).toBe('brain_window.family.upserted');
    expect(evs[0].tenant).toBe('family');
    expect(evs[0].body.data.adapter).toBe('telegram');
    expect(evs[0].body.data.source_id).toBe('win:t:0');
    expect(evs[0].body.data.documents).toHaveLength(UPSERT_BATCH);
    expect(evs[1].body.data.documents).toHaveLength(1);
    expect(evs[0].body.data.payload_hash).not.toBe(evs[1].body.data.payload_hash);
    // Same documents → same id, so the engine's inbox dedups a re-publish.
    expect(upsertEvents('personal', docs)[0].messageId).toBe(evs[0].messageId);
  });

  it('changes the message id when the content changes (e.g. the LLM summary)', () => {
    const a = upsertEvents('professional', [doc('win:w:1', 'whatsapp', 'v1')])[0];
    const b = upsertEvents('professional', [doc('win:w:1', 'whatsapp', 'v2')])[0];
    expect(a.routingKey).toBe('brain_window.skirmshop.upserted');
    expect(a.body.data.adapter).toBe('whatsapp');
    expect(a.messageId).not.toBe(b.messageId);
  });

  it('replaces lone surrogates before publishing', () => {
    const ev = upsertEvents('personal', [doc('win:t:x', 'telegram', 'a\uD83Db')])[0];
    const docs = ev.body.data.documents as BrainDoc[];
    expect(docs[0].content).toBe('a�b');
  });

  it('publishes nothing for an empty push', () => {
    expect(upsertEvents('personal', [])).toEqual([]);
  });

  it('deletes the parent and every #c child, one event each', () => {
    const evs = deleteEvents('personal', 'whatsapp', 'win:w:p', 2);
    expect(evs.map(e => e.body.data.source_id)).toEqual(['win:w:p', 'win:w:p#c1', 'win:w:p#c2']);
    expect(evs.every(e => e.routingKey === 'brain_window.family.deleted')).toBe(true);
    expect(new Set(evs.map(e => e.messageId)).size).toBe(3);
  });

  it('routes the sink through the publisher', async () => {
    const sent: SynapseEvent[] = [];
    const pub: EventPublisher = {
      publish: async evs => {
        sent.push(...evs);
      },
      close: async () => undefined,
    };
    const sink = synapseSink(pub);
    await sink.push('personal', [doc('win:t:1')]);
    await sink.remove('professional', 'telegram', 'win:t:2', 1);
    expect(sent.map(e => e.routingKey)).toEqual([
      'brain_window.family.upserted',
      'brain_window.skirmshop.deleted',
      'brain_window.skirmshop.deleted',
    ]);
  });

  it('propagates a publish failure so the ledger is not written', async () => {
    const sink = synapseSink({
      publish: async () => {
        throw new Error('broker down');
      },
      close: async () => undefined,
    });
    await expect(sink.push('personal', [doc('win:t:1')])).rejects.toThrow('broker down');
  });
});
