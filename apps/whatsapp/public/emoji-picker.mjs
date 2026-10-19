const preferenceKey = account => `wa-emoji-picker:${encodeURIComponent(account)}`;
const normalize = value => String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function filterEmojis(items, query = '', group = null) {
  const words = normalize(query).trim().split(/\s+/).filter(Boolean);
  return items.filter(item => words.length
    ? words.every(word => normalize([item.emoji, item.label, ...(item.keywords || [])].join(' ')).includes(word))
    : group === null || item.group === group);
}

export function emojiVariant(item, tone) {
  return tone ? item.skins?.find(skin => (Array.isArray(skin.tone) ? skin.tone : [skin.tone]).every(value => value === tone)) || item : item;
}

export function readEmojiPreferences(storage, account) {
  try {
    const value = JSON.parse(storage?.getItem(preferenceKey(account)) || '{}');
    return {tone: [0, 1, 2, 3, 4, 5].includes(value.tone) ? value.tone : 0,
      recents: Array.isArray(value.recents) ? [...new Set(value.recents.filter(emoji => typeof emoji === 'string' && emoji.length <= 40))].slice(0, 48) : []};
  } catch { return {tone: 0, recents: []}; }
}

export function writeEmojiPreferences(storage, account, preferences) {
  try { storage?.setItem(preferenceKey(account), JSON.stringify(preferences)); } catch {}
}

export function rememberEmoji(preferences, emoji) {
  return {...preferences, recents: [emoji, ...preferences.recents.filter(value => value !== emoji)].slice(0, 48)};
}

let catalogPromise;
function loadCatalog() {
  catalogPromise ||= fetch('/emoji/catalog-es.json').then(response => {
    if (!response.ok) throw new Error('No se pudo cargar el cat\u00e1logo de emojis.');
    return response.json();
  }).catch(error => { catalogPromise = null; throw error; });
  return catalogPromise;
}

export function createEmojiPicker({documentRef = document, account, onSelect, isCurrent = () => true, storage, load = loadCatalog}) {
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch {} }
  const make = (tag, className, label) => {
    const element = documentRef.createElement(tag); element.className = className;
    if (label) element.textContent = label;
    return element;
  };
  const button = (label, action, className = '') => {
    const element = make('button', className, label); element.type = 'button'; element.onclick = action; return element;
  };
  const root = make('section', 'emoji-picker'); root.setAttribute('aria-label', 'Selector de emojis');
  const toolbar = make('div', 'emoji-picker-toolbar');
  const search = make('input', 'emoji-picker-search'); search.type = 'search'; search.placeholder = 'Buscar emoji'; search.setAttribute('aria-label', 'Buscar emoji');
  const tone = make('select', 'emoji-picker-tone'); tone.setAttribute('aria-label', 'Tono de piel');
  ['Predeterminado', 'Claro', 'Claro medio', 'Medio', 'Oscuro medio', 'Oscuro'].forEach((label, index) => {
    const option = make('option', '', label); option.value = String(index); tone.append(option);
  });
  let preferences = readEmojiPreferences(storage, account); tone.value = String(preferences.tone);
  const categories = make('nav', 'emoji-picker-categories'); categories.setAttribute('aria-label', 'Categor\u00edas de emoji');
  const status = make('p', 'emoji-picker-status', 'Cargando emojis...'); status.setAttribute('role', 'status');
  const grid = make('div', 'emoji-picker-grid'); grid.setAttribute('aria-label', 'Emojis');
  const variants = make('div', 'emoji-picker-variants'); variants.hidden = true;
  toolbar.append(search, tone); root.append(toolbar, categories, status, variants, grid);
  let catalog; let selectedGroup = preferences.recents.length ? 'recent' : 0; let pending = false;
  const allVariants = new Map();
  const active = () => isCurrent() && root.isConnected;
  const choose = async (item, opener) => {
    if (pending || !active()) return;
    pending = true; root.setAttribute('aria-busy', 'true');
    try {
      const accepted = await onSelect(item.emoji);
      if (accepted !== false) {
        preferences = rememberEmoji(preferences, item.emoji);
        writeEmojiPreferences(storage, account, preferences);
      }
      if (active()) { variants.hidden = true; opener?.focus(); }
    } catch (error) { if (active()) status.textContent = error.message || 'No se pudo seleccionar el emoji.'; }
    finally {pending = false; root.removeAttribute('aria-busy');}
  };
  const emojiButton = (item, opener) => {
    const element = button(item.emoji, () => choose(item, opener || element), 'emoji-picker-item');
    element.setAttribute('aria-label', item.label); element.title = item.label; return element;
  };
  const showVariants = (item, opener) => {
    variants.replaceChildren(make('strong', '', item.label)); variants.hidden = false;
    const close = button('Cerrar variantes', () => {variants.hidden = true; opener.focus();});
    variants.append(close, ...[item, ...item.skins].map(variant => emojiButton(variant, opener)));
    close.focus();
  };
  const render = () => {
    if (!catalog || !active()) return;
    variants.hidden = true; grid.replaceChildren();
    const query = search.value.trim();
    const items = query ? filterEmojis(catalog.items, query)
      : selectedGroup === 'recent' ? preferences.recents.map(emoji => allVariants.get(emoji)).filter(Boolean)
      : filterEmojis(catalog.items, '', selectedGroup);
    for (const category of categories.children) category.setAttribute('aria-pressed', String(!query && category.dataset.group === String(selectedGroup)));
    status.textContent = items.length ? `${items.length} emojis` : query ? 'No se encontraron emojis.' : 'Todav\u00eda no has usado emojis en esta cuenta.';
    for (const item of items) {
      const displayed = selectedGroup === 'recent' && !query ? item : emojiVariant(item, preferences.tone);
      const element = emojiButton(displayed);
      if (item.skins?.length) {
        element.classList.add('emoji-picker-has-variants');
        element.title += ' (clic derecho para variantes)';
        element.oncontextmenu = event => {event.preventDefault(); showVariants(item, element);};
        element.onkeydown = event => {
          if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {event.preventDefault(); showVariants(item, element);}
        };
      }
      grid.append(element);
    }
  };
  grid.onkeydown = event => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const buttons = [...grid.children]; const index = buttons.indexOf(documentRef.activeElement);
    if (index < 0) return;
    const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : index + ({ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns}[event.key]);
    event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
  };
  variants.onkeydown = event => {
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); variants.hidden = true; grid.querySelector('button')?.focus();}
  };
  search.oninput = render;
  tone.onchange = () => { preferences.tone = Number(tone.value); writeEmojiPreferences(storage, account, preferences); render(); };
  const initialize = async () => {
    try {
      catalog = await load(); if (!active()) return;
      for (const item of catalog.items) { allVariants.set(item.emoji, item); for (const skin of item.skins || []) allVariants.set(skin.emoji, skin); }
      categories.replaceChildren();
      const icons = {recent: '\ud83d\udd58', 0: '\ud83d\ude00', 1: '\ud83d\udc4b', 3: '\ud83d\udc3b', 4: '\ud83c\udf54', 5: '\ud83d\ude97', 6: '\u26bd', 7: '\ud83d\udca1', 8: '\u2764\ufe0f', 9: '\ud83c\udfc1'};
      for (const group of [{order: 'recent', message: 'Recientes'}, ...catalog.groups]) {
        const category = button(icons[group.order], () => {selectedGroup = group.order; search.value = ''; render();}, 'emoji-picker-category');
        category.setAttribute('aria-label', group.message); category.title = group.message;
        category.dataset.group = String(group.order); categories.append(category);
      }
      render();
    } catch {
      if (!active()) return;
      status.textContent = 'No se pudieron cargar los emojis.';
      const retry = button('Reintentar', () => {retry.remove(); status.textContent = 'Cargando emojis...'; void initialize();});
      status.append(retry);
    }
  };
  void initialize();
  return root;
}
