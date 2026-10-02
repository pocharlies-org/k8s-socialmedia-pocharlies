/** Publish pages as they arrive; retain old rows until a refresh completes. */
export async function loadChatPages({ fetchPage, isCurrent, onPage, previous = [] }) {
  const visible = new Map();
  const seen = new Set();
  const cursors = new Set();
  let cursor = null;
  do {
    const page = await fetchPage(cursor);
    if (!isCurrent()) return;
    if (!Array.isArray(page?.chats)) throw new Error('La lista de chats recibida no es válida.');
    for (const chat of page.chats) {
      if (typeof chat?.id !== 'string' || !chat.id) throw new Error('La lista de chats recibida no es válida.');
      visible.set(chat.id, chat);
      seen.add(chat.id);
    }
    cursor = page.nextCursor ?? null;
    if (cursor !== null && (typeof cursor !== 'string' || !cursor || cursors.has(cursor))) throw new Error('No se pudo continuar la lista de chats. Vuelve a intentarlo.');
    if (cursor) cursors.add(cursor);
    const chats = [...visible.values(), ...(cursor ? previous.filter(chat => !seen.has(chat.id)) : [])];
    onPage(chats, cursor !== null);
  } while (cursor && isCurrent());
}
