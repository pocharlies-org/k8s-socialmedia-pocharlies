export function installPinnedUI({messages, getContext, api, openMessage, documentRef = globalThis.document, now = Date.now, schedule = setTimeout, cancel = clearTimeout}) {
  const bar = documentRef.createElement('nav');
  bar.className = 'pinned-message-bar';
  bar.setAttribute('aria-label', 'Mensajes fijados');
  bar.hidden = true;
  messages.before(bar);
  let items = [];
  let selected = 0;
  let generation = 0;
  let scope = '';
  let pending = false;
  let lastRead = 0;
  let expiryTimer;
  const key = context => JSON.stringify([context.account, context.chat, context.version]);
  function render() {
    cancel(expiryTimer);
    items = items.filter(item => item.expiresAtMs > now());
    selected = Math.min(selected, Math.max(0, items.length - 1));
    bar.replaceChildren();
    bar.hidden = items.length === 0;
    if (!items.length) return;
    const item = items[selected];
    const link = documentRef.createElement('button');
    link.type = 'button'; link.className = 'pinned-message-link';
    const label = documentRef.createElement('strong'); label.textContent = 'Mensaje fijado';
    const preview = documentRef.createElement('span'); preview.textContent = item.text || ({IMAGE:'Foto',VIDEO:'Video',AUDIO:'Audio',POLL:'Encuesta',EVENT:'Evento',DOCUMENT:'Documento'}[item.type] || 'Mensaje');
    link.append(label, preview);
    const capturedScope = scope;
    link.onclick = async () => {
      if (capturedScope !== key(getContext()) || link.disabled) return;
      link.disabled = true;
      try { await openMessage(item.id); }
      finally { if (link.isConnected) link.disabled = false; }
    };
    bar.append(link);
    if (items.length > 1) {
      const next = documentRef.createElement('button'); next.type = 'button'; next.className = 'pinned-message-next';
      next.setAttribute('aria-label', 'Siguiente mensaje fijado');
      next.textContent = `${selected + 1} / ${items.length}`;
      next.onclick = () => { selected = (selected + 1) % items.length; render(); };
      bar.append(next);
    }
    expiryTimer = schedule(render, Math.min(2147483647, Math.max(1, Math.min(...items.map(pin => pin.expiresAtMs)) - now())));
  }
  async function refresh({force = false} = {}) {
    const context = {...getContext()};
    const nextScope = key(context);
    if (scope !== nextScope) {
      generation++; scope = nextScope; pending = false; lastRead = 0; items = []; selected = 0; render();
    }
    if (!context.account || !context.chat || pending && !force || !force && now() - lastRead < 30000) return;
    const requestGeneration = ++generation;
    pending = true;
    lastRead = now();
    try {
      const result = await api(`/api/messages/pins?${new URLSearchParams({account: context.account, chat: context.chat})}`);
      if (requestGeneration !== generation || nextScope !== key(getContext())) return;
      if (result.account !== context.account || result.chat !== context.chat || !Array.isArray(result.items)) throw new Error('Invalid pins');
      items = result.items.filter(item => item && typeof item.id === 'string' && Number.isSafeInteger(item.expiresAtMs)).slice(0, 3);
      render();
    } catch {
      if (requestGeneration === generation && nextScope === key(getContext())) {items = []; render();}
    } finally { if (requestGeneration === generation) pending = false; }
  }
  return {refresh, has(id) {return scope === key(getContext()) && items.some(item => item.id === id && item.expiresAtMs > now());}, destroy() {generation++; cancel(expiryTimer); bar.remove();}};
}
