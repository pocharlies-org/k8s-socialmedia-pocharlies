/** In-memory implementation of the `Store` (state.ts) for tests: same semantics, no SQL. */
import type { Store } from '../brain-windows';
import type { StateRow, DirtyChat } from '../state';
import type { ChatKind, ConversationMeta, WindowMessage } from '../window-builder';

export interface MemMessage extends WindowMessage {
  conversationId: string;
  seq: number; // insertion order (created_at, id)
  /** created_at younger than the 15-minute snapshot delay: not visible to the snapshot yet */
  young?: boolean;
}

export class Mem {
  messages: MemMessage[] = [];
  convs = new Map<string, { name: string | null; isGroup: boolean }>();
  windows = new Map<string, StateRow>();
  cursors = new Map<string, { lastCreatedAt: string; lastId: string }>();
  dirty: Array<{ account: string; conversationId: string; at: number }> = [];
  private seq = 0;

  add(conversationId: string, m: WindowMessage, opts: { young?: boolean } = {}): MemMessage {
    const row = { ...m, conversationId, seq: ++this.seq, young: opts.young };
    this.messages.push(row);
    if (!this.convs.has(conversationId))
      this.convs.set(conversationId, { name: 'Grupo familia', isGroup: true });
    return row;
  }
  counted = () => this.messages.filter(m => m.content.trim());
}

export function memoryStore(mem: Mem): Store {
  const seqOf = (c: { lastCreatedAt: string } | null) => (c ? Number(c.lastCreatedAt) : 0);
  return {
    getCursor: async (_db, a) => mem.cursors.get(a) ?? null,
    setCursor: async (_db, a, c) => void mem.cursors.set(a, c),
    snapshotCursor: async () => {
      const s = Math.max(
        0,
        ...mem
          .counted()
          .filter(m => !m.young)
          .map(m => m.seq)
      );
      return s ? { lastCreatedAt: String(s), lastId: '0' } : null;
    },
    changedChats: async (_db, _a, from, to) => {
      const by = new Map<string, number>();
      for (const m of mem.counted()) {
        if (m.seq <= seqOf(from) || m.seq > seqOf(to)) continue; // `to` is the delayed snapshot
        by.set(m.conversationId, Math.min(by.get(m.conversationId) ?? Infinity, m.ts));
      }
      return [...by].map(([conversationId, minTs]) => ({ conversationId, minTs }));
    },
    allChats: async () => [...new Set(mem.counted().map(m => m.conversationId))].sort(),
    listDirty: async (_db, a) => {
      const by = new Map<string, number>();
      for (const d of mem.dirty)
        if (d.account === a)
          by.set(d.conversationId, Math.max(by.get(d.conversationId) ?? 0, d.at));
      return [...by].map(([conversationId, at]) => ({ conversationId, seenUpTo: String(at) }));
    },
    clearDirty: async (_db, a, d: DirtyChat) => {
      mem.dirty = mem.dirty.filter(
        x =>
          !(x.account === a && x.conversationId === d.conversationId && x.at <= Number(d.seenUpTo))
      );
    },
    conversationMeta: async (
      _db,
      a,
      conversationId,
      kinds: Record<string, ChatKind>
    ): Promise<ConversationMeta | null> => {
      const c = mem.convs.get(conversationId);
      if (!c || !mem.counted().some(m => m.conversationId === conversationId)) return null;
      return {
        platform: 'whatsapp',
        account: a,
        conversationId,
        conversationName: c.name,
        isGroup: c.isGroup,
        kind: kinds[conversationId] ?? 'chat',
      };
    },
    streamChat: async function* (_db, _a, conversationId, fromTs, toTs = null) {
      const ms = mem
        .counted()
        .filter(
          m =>
            m.conversationId === conversationId &&
            (fromTs === null || m.ts >= fromTs) &&
            (toTs === null || m.ts <= toTs)
        )
        .sort((x, y) => x.ts - y.ts || Number(x.id) - Number(y.id));
      for (const m of ms) yield m;
    },
    anchorBefore: async (_db, a, cid, ts) => {
      const s = [...mem.windows.values()]
        .filter(w => w.account === a && w.conversationId === cid && w.startTs <= ts)
        .map(w => w.startTs);
      return s.length ? Math.max(...s) : null;
    },
    windowsFrom: async (_db, a, cid, fromTs) =>
      [...mem.windows.values()]
        .filter(
          w =>
            w.account === a && w.conversationId === cid && (fromTs === null || w.startTs >= fromTs)
        )
        .sort((x, y) => x.startTs - y.startTs),
    pendingLlm: async (_db, a, limit) => {
      if (limit === 0) return [];
      const p = [...mem.windows.values()]
        .filter(
          w =>
            w.account === a &&
            w.llmStatus === 'pending' &&
            !w.pushError &&
            w.pushedHash === w.windowHash
        )
        .sort((x, y) => y.endTs - x.endTs);
      return limit === null ? p : p.slice(0, limit);
    },
    upsertWindow: async (_db, s) => {
      const row: StateRow & { pushed?: boolean } = { ...s };
      delete row.pushed;
      mem.windows.set(row.windowId, row);
    },
    deleteWindows: async (_db, ids) => void ids.forEach(i => mem.windows.delete(i)),
  };
}
