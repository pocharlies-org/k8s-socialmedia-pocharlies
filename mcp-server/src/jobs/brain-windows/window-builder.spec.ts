import { buildWindows, compareMessages, cutByParagraphs, MAX_LINES_CHARS, MAX_WINDOW_TEXT, windowHeader, WindowStream } from './window-builder';
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

  it('formats lines: HH:MM Nombre: texto, voice 🎙, reply inside the window (by wa_message_id)', () => {
    const [w] = buildWindows(META, [
      msg('a', 0, 'hola'),
      msg('b', 600, 'te paso el pedido', { sender: 'Luis', isVoice: true }),
      msg('c', 1200, 'vale', { replyToId: 'wa-b' }),
      msg('d', 1300, 'ok', { replyToId: 'fuera-de-la-ventana' }),
    ]);
    expect(w.lines.map((l) => l.text)).toEqual(['09:00 Ana: hola', '09:10 Luis: 🎙 te paso el pedido', '09:20 Ana: vale (resp. a Luis)', '09:21 Ana: ok']);
    expect(w.windowText).toBe(`${w.header}\n${w.lines.map((l) => l.text).join('\n')}`);
    expect(w.participants).toEqual(['Ana', 'Luis']);
    expect(w.startTs).toBe(msg('a', 0, '').ts);
    expect(w.endTs).toBe(msg('d', 1300, '').ts);
  });

  it('the reply key is the namespaced wa_message_id, never messages.id', () => {
    const ns = 'professional:3EB0ABC@s.whatsapp.net';
    const [w] = buildWindows(META, [msg(10, 0, 'pregunta', { sender: 'Luis', waId: ns }), msg(11, 60, 'respuesta', { replyToId: ns }), msg(12, 120, 'otra', { replyToId: '10' })]);
    expect(w.lines[1].text).toBe('09:01 Ana: respuesta (resp. a Luis)');
    expect(w.lines[2].text).toBe('09:02 Ana: otra'); // '10' is a messages.id: does not match
  });

  describe('header (P1b §2): chat · platform/account · date range · n · participants, in window and chunks', () => {
    it('same-day window', () => {
      const [w] = buildWindows(META, [msg(1, 0, 'a'), msg(2, 600, 'b', { sender: 'Luis' }), msg(3, 1200, 'c')]);
      expect(w.header).toBe('Grupo familia · whatsapp/personal · 2026-09-28 09:00–09:20 UTC · 3 mensajes · Ana, Luis');
      expect(w.windowText.split('\n')[0]).toBe(w.header);
    });

    it('a window crossing midnight UTC writes the end date; one message is singular', () => {
      const [w] = buildWindows(META, [msg(1, 14 * 3600 + 50 * 60, 'tarde'), msg(2, 15 * 3600 + 10 * 60, 'noche')]);
      expect(w.header).toContain('2026-09-28 23:50–2026-09-29 00:10 UTC · 2 mensajes');
      expect(buildWindows(META, [msg(1, 0, 'solo')])[0].header).toContain('09:00–09:00 UTC · 1 mensaje ·');
    });

    it('participants: at most 5 shown, +N for the rest, names cut and on one line', () => {
      const ms = Array.from({ length: 8 }, (_, i) => msg(i + 1, i, 'x', { sender: `P${i}\n${'n'.repeat(60)}` }));
      const [w] = buildWindows(META, ms);
      expect(w.header).not.toContain('\n');
      expect(w.header.endsWith(' +3')).toBe(true);
      const shown = w.header.split(' · ')[4].replace(/ \+3$/, '').split(', ');
      expect(shown.every((p) => p.length <= 30)).toBe(true); // each name is cut at 30 chars
      expect(w.header.split(' · ')[4].split(', ')).toHaveLength(5);
    });

    it('no name: a placeholder, never an empty slot', () => {
      const [w] = buildWindows({ ...META, conversationName: null }, [msg(1, 0, 'hola')]);
      expect(w.header.startsWith('(sin nombre) · whatsapp/personal')).toBe(true);
    });

    it('header at its cap keeps window_text <= 16.384 with 16.000 chars of lines', () => {
      const long = { ...META, conversationName: 'N'.repeat(500) };
      const senders = Array.from({ length: 50 }, (_, i) => `Participante-${i}-${'z'.repeat(80)}`);
      const ms = senders.map((s, i) => msg(i + 1, i, 'y'.repeat(300), { sender: s }));
      for (const w of buildWindows(long, ms)) {
        expect(w.header.length).toBeLessThanOrEqual(383);
        expect(w.windowText.length).toBeLessThanOrEqual(MAX_WINDOW_TEXT);
      }
      const big = buildWindows(long, Array.from({ length: 16 }, (_, i) => msg(i + 1, i, 'q'.repeat(985), { sender: senders[i] })));
      expect(big.length).toBeGreaterThanOrEqual(1);
      for (const w of big) expect(w.windowText.length).toBeLessThanOrEqual(MAX_WINDOW_TEXT);
      const direct = windowHeader(long, { startTs: msg(1, 0, '').ts, endTs: msg(1, 0, '').ts, messageCount: 99999, participants: senders });
      expect(direct.length).toBeLessThanOrEqual(383);
    });
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

});
