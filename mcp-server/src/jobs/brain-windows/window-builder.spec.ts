import { buildWindows, compareMessages, cutByParagraphs, MAX_LINES_CHARS, MAX_WINDOW_TEXT, WindowStream } from './window-builder';
import { META, msg } from './test-support/helpers';

describe('window-builder (contract §C rules 3 and 4)', () => {
  it('a gap of exactly 3600 s does not cut; 3601 s does', () => {
    const exact = buildWindows(META, [msg(1, 0, 'a'), msg(2, 3600, 'b')]);
    expect(exact).toHaveLength(1);
    const over = buildWindows(META, [msg(1, 0, 'a'), msg(2, 3601, 'b')]);
    expect(over.map((w) => w.messageCount)).toEqual([1, 1]);
  });

  it('measures the gap against the previous message, not the window start', () => {
    const ms = [0, 3000, 6000, 9000].map((s, i) => msg(i + 1, s, `m${i}`));
    expect(buildWindows(META, ms)).toHaveLength(1);
  });

  it('cuts by size before exceeding 16.000 chars of lines; header stays within 16.384', () => {
    const big = 'x'.repeat(1_000);
    const ms = Array.from({ length: 40 }, (_, i) => msg(i + 1, i * 10, big));
    const ws = buildWindows(META, ms);
    expect(ws.length).toBeGreaterThan(1);
    for (const w of ws) {
      expect(w.lines.map((l) => l.text).join('\n').length).toBeLessThanOrEqual(MAX_LINES_CHARS);
      expect(w.windowText.length).toBeLessThanOrEqual(MAX_WINDOW_TEXT);
      expect(w.truncatedBySize).toBe(false);
    }
    expect(ws.reduce((n, w) => n + w.messageCount, 0)).toBe(40);
  });

  it('a message over 16.000 chars gets its own window, cut by paragraphs, truncated_by_size=true', () => {
    const para = 'p'.repeat(5_000);
    const huge = [para, para, para, para].join('\n\n'); // 20.006 chars
    const ws = buildWindows(META, [msg(1, 0, 'antes'), msg(2, 10, huge), msg(3, 20, 'después')]);
    expect(ws.map((w) => [w.messageCount, w.truncatedBySize])).toEqual([[1, false], [1, true], [1, false]]);
    const t = ws[1];
    expect(t.lines[0].text.length).toBeLessThanOrEqual(MAX_LINES_CHARS);
    expect(t.windowText.length).toBeLessThanOrEqual(MAX_WINDOW_TEXT);
    expect(t.lines[0].text.endsWith(para)).toBe(true); // whole paragraphs only (3 of 4 fit)
    expect(t.windowId).toBe(`cw:whatsapp:personal:${META.conversationId}:2`);
  });

  it('cutByParagraphs hard-cuts a single paragraph longer than the limit', () => {
    expect(cutByParagraphs('y'.repeat(30), 10)).toHaveLength(10);
    expect(cutByParagraphs('ab\n\ncd\n\nef', 6)).toBe('ab\n\ncd');
  });

  it('no message in 0 or 2 windows; Σ message_count = counted messages; ids are disjoint', () => {
    const ms = [];
    let sec = 0;
    for (let i = 1; i <= 500; i++) {
      sec += i % 37 === 0 ? 4_000 : 30; // a cut every 37 messages
      ms.push(msg(i, sec, i % 50 === 0 ? '   ' : `mensaje ${i} ${'z'.repeat(i % 400)}`)); // blanks do not count
    }
    const counted = ms.filter((m) => m.content.trim()).length;
    const ws = buildWindows(META, ms);
    const all = ws.flatMap((w) => w.messageIds);
    expect(all).toHaveLength(counted);
    expect(new Set(all).size).toBe(counted);
    expect(ws.reduce((n, w) => n + w.messageCount, 0)).toBe(counted);
    for (const w of ws) expect(w.messageIds).toHaveLength(w.messageCount);
  });

  it('orders by (wa_timestamp, id); window_id uses the first message of that order', () => {
    const ws = buildWindows(META, [msg(20, 5, 'b'), msg(3, 5, 'a'), msg(100, 5, 'c')]);
    expect(ws[0].messageIds).toEqual(['3', '20', '100']); // numeric ids compare numerically
    expect(ws[0].firstMsgId).toBe('3');
    expect(compareMessages(msg('b', 1, ''), msg('a', 1, ''))).toBeGreaterThan(0);
  });

  it('formats lines: HH:MM Nombre: texto, voice 🎙, reply inside the window', () => {
    const [w] = buildWindows(META, [
      msg('a', 0, 'hola'),
      msg('b', 600, 'te paso el pedido', { sender: 'Luis', isVoice: true }),
      msg('c', 1200, 'vale', { replyToId: 'b' }),
      msg('d', 1300, 'ok', { replyToId: 'fuera-de-la-ventana' }),
    ]);
    expect(w.windowText).toBe(
      ['[whatsapp · Grupo familia] 2026-09-28', '09:00 Ana: hola', '09:10 Luis: 🎙 te paso el pedido', '09:20 Ana: vale (resp. a Luis)', '09:21 Ana: ok'].join('\n')
    );
    expect(w.participants).toEqual(['Ana', 'Luis']);
    expect(w.startTs).toBe(msg('a', 0, '').ts);
    expect(w.endTs).toBe(msg('d', 1300, '').ts);
  });

  it('window_hash depends on (id, content) and not on anything else', () => {
    const base = [msg(1, 0, 'hola'), msg(2, 10, 'adiós')];
    const h = buildWindows(META, base)[0].windowHash;
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(buildWindows(META, [...base])[0].windowHash).toBe(h);
    expect(buildWindows(META, [msg(1, 0, 'hola'), msg(2, 10, 'adiós!')])[0].windowHash).not.toBe(h);
    expect(buildWindows(META, [msg(1, 0, 'hola', { sender: 'Otro' }), msg(2, 10, 'adiós')])[0].windowHash).toBe(h);
  });

  it('streaming gives the same windows as the array form and rejects out-of-order input', () => {
    const ms = [msg(1, 0, 'a'), msg(2, 5000, 'b'), msg(3, 5010, 'c')];
    const s = new WindowStream(META);
    const out = ms.flatMap((m) => s.push(m)).concat(s.end());
    expect(out.map((w) => w.windowHash)).toEqual(buildWindows(META, ms).map((w) => w.windowHash));
    expect(() => new WindowStream(META).push(msg(2, 10, 'x')) && s.push(msg(1, 0, 'late'))).toThrow(/out of order/);
  });

  it('a conversation without a name still has a header', () => {
    const [w] = buildWindows({ ...META, conversationName: null }, [msg(1, 0, 'hola')]);
    expect(w.header).toBe('[whatsapp] 2026-09-28');
  });
});
