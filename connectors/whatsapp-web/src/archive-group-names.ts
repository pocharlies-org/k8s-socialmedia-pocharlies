export interface NamedArchiveChat {
  jid: string;
  archived: boolean;
  name?: string;
}

export function hasUsefulArchiveName(name: string | undefined): boolean {
  const value = name?.trim();
  return !!value && !/@(?:g\.us|c\.us|s\.whatsapp\.net|lid)$/.test(value);
}

/** Query only unnamed archived groups, pacing starts to avoid metadata bursts. */
export async function enrichArchiveGroupNames<T extends NamedArchiveChat>(
  chats: T[],
  lookup: (jid: string) => Promise<string | undefined>,
  options: { spacingMs?: number; concurrency?: number; isCurrent?: () => boolean } = {}
): Promise<void> {
  const { spacingMs = 300, concurrency = 2, isCurrent = () => true } = options;
  const pending = chats.filter(
    chat => chat.archived && chat.jid.endsWith('@g.us') && !hasUsefulArchiveName(chat.name)
  );
  let cursor = 0;
  let nextStart = 0;
  let pace = Promise.resolve();
  async function takeNext(): Promise<T | undefined> {
    let selected: T | undefined;
    const turn = pace.then(async () => {
      selected = isCurrent() ? pending[cursor++] : undefined;
      if (!selected) return;
      const delay = Math.max(0, nextStart - Date.now());
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      nextStart = Date.now() + spacingMs;
    });
    pace = turn;
    await turn;
    return selected;
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
      for (;;) {
        const chat = await takeNext();
        if (!chat) return;
        if (!isCurrent()) return;
        try {
          const name = await lookup(chat.jid);
          if (isCurrent() && hasUsefulArchiveName(name)) chat.name = name!.trim();
        } catch {
          // A group can be unavailable without invalidating its archive state.
        }
      }
    })
  );
}
