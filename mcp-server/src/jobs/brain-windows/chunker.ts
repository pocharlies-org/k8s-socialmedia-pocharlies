/**
 * Pure: a window -> sub-chunks for small-to-big retrieval (contract §C).
 * Target 200–400 tokens per chunk = 800–1.600 chars. Token estimator: chars / 4
 * (rough, language-agnostic; good enough to size embedding inputs, never used
 * for billing or limits). Boundaries fall between messages; the overlap is the
 * last message of the previous chunk, cut to 200 chars.
 */
import type { Window, WindowLine } from './window-builder';

export const CHUNK_MAX_CHARS = 1_600; // ~400 tokens
export const CHUNK_MIN_CHARS = 800; // ~200 tokens
export const OVERLAP_MAX_CHARS = 200;
const TAIL_MERGE_BELOW = 200;
const TAIL_MERGE_MAX = 2_000;

export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

export interface Chunk {
  index: number;
  count: number;
  /** One-line header + lines, what gets embedded. */
  text: string;
  /** First / last message that belongs to the chunk (overlap line excluded). */
  msgIdFirst: string;
  msgIdLast: string;
}

/** A line longer than the chunk limit is cut at whitespace (or hard) so no piece exceeds it. */
function splitLongLine(l: WindowLine, max: number): WindowLine[] {
  if (l.text.length <= max) return [l];
  const out: WindowLine[] = [];
  let rest = l.text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push({ msgId: l.msgId, text: rest.slice(0, cut).trimEnd() });
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push({ msgId: l.msgId, text: rest });
  return out;
}

interface Group {
  lines: WindowLine[];
  chars: number;
}

export function chunkWindow(w: Window, headerLine: string): Chunk[] {
  const lines = w.lines.flatMap(l => splitLongLine(l, CHUNK_MAX_CHARS - OVERLAP_MAX_CHARS - 1));
  const groups: Group[] = [];
  let g: Group = { lines: [], chars: 0 };
  for (const l of lines) {
    const add = l.text.length + (g.lines.length ? 1 : 0);
    if (g.lines.length && g.chars + add > CHUNK_MAX_CHARS - OVERLAP_MAX_CHARS - 1) {
      groups.push(g);
      g = { lines: [], chars: 0 };
    }
    g.chars += l.text.length + (g.lines.length ? 1 : 0);
    g.lines.push(l);
  }
  if (g.lines.length) groups.push(g);

  // A tiny last chunk is folded into the previous one.
  if (groups.length > 1) {
    const tail = groups[groups.length - 1];
    const prev = groups[groups.length - 2];
    if (tail.chars < TAIL_MERGE_BELOW && prev.chars + 1 + tail.chars <= TAIL_MERGE_MAX) {
      prev.lines.push(...tail.lines);
      prev.chars += 1 + tail.chars;
      groups.pop();
    }
  }

  return groups.map((grp, i) => {
    const body: string[] = [];
    if (i > 0) {
      const prevLines = groups[i - 1].lines;
      body.push(prevLines[prevLines.length - 1].text.slice(0, OVERLAP_MAX_CHARS));
    }
    body.push(...grp.lines.map(l => l.text));
    return {
      index: i,
      count: groups.length,
      text: `${headerLine} ${body.join('\n')}`,
      msgIdFirst: grp.lines[0].msgId,
      msgIdLast: grp.lines[grp.lines.length - 1].msgId,
    };
  });
}
