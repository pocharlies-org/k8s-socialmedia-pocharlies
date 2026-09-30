import { chunkWindow, CHUNK_MAX_CHARS, OVERLAP_MAX_CHARS, estimateTokens } from './chunker';
import { buildWindows } from './window-builder';
import { META, msg } from './test-support/helpers';

const windowOf = (ms: ReturnType<typeof msg>[]) => buildWindows(META, ms)[0];
const HEADER = 'Grupo familia · whatsapp/personal · 2026-09-28 09:00–09:01 UTC · 2 mensajes · Ana';

describe('chunker', () => {
  it('a short window is one chunk: header + lines', () => {
    const cs = chunkWindow(windowOf([msg(1, 0, 'hola'), msg(2, 60, 'qué tal')]), windowOf([msg(1, 0, 'hola'), msg(2, 60, 'qué tal')]).header);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ index: 0, count: 1, msgIdFirst: '1', msgIdLast: '2' });
    expect(cs[0].text).toBe(`${HEADER} 09:00 Ana: hola\n09:01 Ana: qué tal`);
    expect(cs[0].text.split('\n')[0]).toContain('2026-09-28 09:00–09:01 UTC · 2 mensajes · Ana'); // date range, count, participants in EVERY chunk
  });

  it('splits at message boundaries, within ~400 tokens, overlapping the last previous message (<=200 chars)', () => {
    const ms = Array.from({ length: 30 }, (_, i) => msg(i + 1, i * 10, `${i}: ${'palabra '.repeat(40)}`));
    const w = windowOf(ms);
    const cs = chunkWindow(w, w.header);
    const header = w.header;
    expect(cs.length).toBeGreaterThan(3);
    cs.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.count).toBe(cs.length);
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS + header.length + 1);
      expect(estimateTokens(c.text.length)).toBeLessThanOrEqual(430);
    });
    // own messages are disjoint and cover everything in order
    const firsts = cs.map((c) => Number(c.msgIdFirst));
    expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
    expect(cs[cs.length - 1].msgIdLast).toBe('30');
    // the second chunk starts with the overlap: the (cut) last line of chunk 0
    const lastOfFirst = cs[0].text.split('\n').pop()!.slice(0, OVERLAP_MAX_CHARS);
    expect(cs[1].text.startsWith(`${header} ${lastOfFirst}`)).toBe(true);
  });

  it('a single huge line is cut so no chunk exceeds the limit, all pieces keep their message id', () => {
    const w = windowOf([msg(1, 0, 'w '.repeat(3_000))]);
    const header = w.header;
    const cs = chunkWindow(w, header);
    expect(cs.length).toBeGreaterThan(2);
    for (const c of cs) {
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS + header.length + 1);
      expect(c.msgIdFirst).toBe('1');
    }
  });

  it('a tiny tail is folded into the previous chunk', () => {
    const ms = [...Array.from({ length: 8 }, (_, i) => msg(i + 1, i, 'k'.repeat(170))), msg(9, 20, 'ok')];
    const w = windowOf(ms);
    const cs = chunkWindow(w, w.header);
    const header = w.header;
    expect(cs[cs.length - 1].msgIdLast).toBe('9');
    expect(cs.every((c) => c.text.length > 300)).toBe(true);
  });
});
