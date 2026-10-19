const actionCapability = Object.freeze({
  subject: 'editInfo',
  description: 'editInfo',
  link: 'manageGroups',
  unlink: 'manageGroups',
  leave: 'leave',
});

export function canCommunityAction(community, action) {
  return community?.capabilities?.[actionCapability[action]] === true;
}

export function providerGroupJid(chat) {
  const value = chat?.waChatId ?? chat?.wa_chat_id ?? chat?.id;
  return typeof value === 'string' && /^\d+(?:-\d+)?@g\.us$/.test(value) ? value : null;
}

export function resolveLinkedGroupChat(group, chats) {
  const loaded = (chats || []).find(chat => chat.isGroup === true && providerGroupJid(chat) === group?.id);
  if (loaded) return loaded;
  if (typeof group?.chatId !== 'string' || !group.chatId.trim()) return null;
  return { id: group.chatId, waChatId: group.id, name: group.name || group.id, isGroup: true };
}

export function createCommunityClient({ api, getAccount }) {
  let generation = 0;
  const current = (account, token) => generation === token && getAccount() === account;
  const scope = () => ({ account: getAccount(), token: generation });
  const query = account => `?account=${encodeURIComponent(account)}`;

  async function list() {
    const { account, token } = scope();
    if (!account) return null;
    const result = await api(`/api/communities${query(account)}`);
    if (!current(account, token)) return null;
    if (result?.account !== account || !Array.isArray(result.communities)) throw new Error('Respuesta de comunidades no válida.');
    return result.communities;
  }

  async function detail(id) {
    const { account, token } = scope();
    if (!account || !id) return null;
    const result = await api(`/api/communities/${encodeURIComponent(id)}${query(account)}`);
    if (!current(account, token)) return null;
    if (result?.account !== account || result.community?.id !== id || !Array.isArray(result.linkedGroups)) throw new Error('Detalle de comunidad no válido.');
    return result;
  }

  async function create(subject, description) {
    const { account, token } = scope();
    if (!account || !subject?.trim()) throw new Error('Escribe un nombre para la comunidad.');
    const result = await api('/api/communities', { account, subject: subject.trim(), description: description?.trim() || '' });
    if (!current(account, token)) return null;
    if (result?.account !== account || result.confirmed !== true || !result.community?.id) throw new Error('El servidor no confirmó la creación de la comunidad.');
    return result.community;
  }

  async function action(community, name, fields = {}) {
    const { account, token } = scope();
    if (!account || !community?.id) throw new Error('Selecciona una comunidad.');
    if (!canCommunityAction(community, name)) throw new Error('No tienes permiso para esta acción.');
    const result = await api(`/api/communities/${encodeURIComponent(community.id)}/action`, { account, action: name, ...fields });
    if (!current(account, token)) return null;
    if (result?.account !== account || result.action !== name || result.communityId !== community.id || result.confirmed !== true) {
      throw new Error('El servidor no confirmó la acción sobre la comunidad.');
    }
    return result;
  }

  return { list, detail, create, action, accountChanged() { generation += 1; }, isCurrent: current, scope };
}

export function installCommunitiesUI({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  getAccount,
  api,
  selectChat = () => {},
  getChats = () => [],
  showError = () => {},
  onOpen = () => {},
} = {}) {
  if (!documentRef?.body || typeof getAccount !== 'function' || typeof api !== 'function') return null;
  const rail = documentRef.querySelector('.rail-bottom');
  const shell = documentRef.querySelector('.app-shell');
  if (!rail || !shell) return null;

  const client = createCommunityClient({ api, getAccount });
  const make = (tag, className = '', text) => {
    const element = documentRef.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const button = (label, className = '') => {
    const element = make('button', className, label);
    element.type = 'button';
    return element;
  };
  const entry = button('', 'communities-rail rail-icon');
  entry.id = 'communities-toggle';
  entry.setAttribute('aria-label', 'Comunidades');
  entry.setAttribute('aria-controls', 'communities-panel');
  entry.setAttribute('aria-expanded', 'false');
  entry.title = 'Comunidades';
  const icon = documentRef.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  for (const d of ['M8 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M2.5 19v-2a5.5 5.5 0 0 1 11 0v2H2.5Zm10.5 0v-2a5.5 5.5 0 0 0-1.2-3.4A5.5 5.5 0 0 1 21.5 17v2H13Z']) {
    const path = documentRef.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    icon.append(path);
  }
  entry.append(icon);
  rail.prepend(entry);

  const shade = make('div', 'communities-shade');
  shade.hidden = true;
  const panel = make('section', 'communities-panel');
  panel.id = 'communities-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Comunidades');
  const master = make('div', 'communities-master');
  const header = make('header', 'communities-header');
  const title = make('h2', '', 'Comunidades');
  const createButton = button('Nueva', 'communities-new');
  createButton.setAttribute('aria-label', 'Crear comunidad');
  header.append(title, createButton);
  const status = make('p', 'communities-status');
  status.setAttribute('role', 'status');
  const listRoot = make('div', 'communities-list');
  const detailRoot = make('div', 'communities-detail');
  master.append(header, status, listRoot);
  panel.append(master, detailRoot);
  shade.append(panel);
  shell.append(shade);

  let communities = [];
  let previews = new Map();
  let selected = null;
  let selectedDetail = null;
  let detailGeneration = 0;
  let listGeneration = 0;
  let dialog = null;
  let opener = null;
  let busy = false;

  function error(message) {
    status.textContent = message;
    status.dataset.kind = 'error';
    showError(message);
  }
  function clearError() { status.textContent = ''; status.dataset.kind = ''; }
  function setBusy(value) { busy = value; createButton.disabled = value; }
  function currentDetail(id, token, scoped) {
    return !shade.hidden && selected === id && detailGeneration === token && client.isCurrent(scoped.account, scoped.token);
  }
  function closeDialog(restoreFocus = true) {
    if (!dialog) return;
    const { root, trigger } = dialog;
    root.remove();
    dialog = null;
    if (restoreFocus && trigger?.isConnected !== false) trigger?.focus?.();
  }
  function close() {
    if (shade.hidden) return;
    client.accountChanged();
    listGeneration += 1;
    closeDialog(false);
    detailGeneration += 1;
    shade.hidden = true;
    entry.setAttribute('aria-expanded', 'false');
    opener?.focus?.();
  }
  function displayCount(count) {
    return count !== null && count !== undefined && Number.isSafeInteger(Number(count)) && Number(count) >= 0
      ? `${Number(count)} participantes` : 'Comunidad';
  }
  function renderList() {
    const focusedCommunity = documentRef.activeElement?.dataset?.communityId;
    listRoot.replaceChildren();
    if (!communities.length) {
      listRoot.append(make('p', 'communities-empty', 'Aún no hay comunidades en esta cuenta.'));
      return;
    }
    for (const community of communities) {
      const card = make('section', 'communities-card');
      const row = button('', 'communities-row');
      row.dataset.communityId = community.id;
      row.setAttribute('aria-label', community.name || community.id);
      row.setAttribute('aria-current', String(selected === community.id));
      row.append(make('span', 'communities-avatar', (community.name || 'C').slice(0, 1).toLocaleUpperCase()));
      const copy = make('span', 'communities-row-copy');
      copy.append(make('strong', '', community.name || community.id), make('small', '', displayCount(community.participantCount)));
      row.append(copy);
      row.onclick = () => { void selectCommunity(community.id); };
      card.append(row);
      const preview = previews.get(community.id);
      if (preview) {
        for (const group of preview.linkedGroups.slice(0, 2)) {
          const subrow = button('', 'communities-preview-group');
          subrow.append(make('span', 'communities-preview-icon', (group.name || 'G').slice(0, 1).toLocaleUpperCase()));
          const subcopy = make('span', 'communities-row-copy');
          subcopy.append(make('strong', '', group.name || group.id), make('small', '', displayCount(group.participantCount)));
          subrow.append(subcopy);
          subrow.onclick = () => { void selectCommunity(community.id); };
          card.append(subrow);
        }
        const more = button(`Ver todos los grupos (${preview.linkedGroups.length})`, 'communities-see-all');
        more.onclick = () => { void selectCommunity(community.id); };
        card.append(more);
      }
      listRoot.append(card);
    }
    if (focusedCommunity) [...listRoot.querySelectorAll('[data-community-id]')].find(item => item.dataset.communityId === focusedCommunity)?.focus();
  }
  function renderDetail() {
    detailRoot.replaceChildren();
    detailRoot.dataset.selected = String(Boolean(selected));
    if (!selectedDetail) {
      detailRoot.append(make('p', 'communities-placeholder', 'Selecciona una comunidad para ver sus grupos.'));
      return;
    }
    const { community, linkedGroups } = selectedDetail;
    const top = make('header', 'communities-detail-header');
    const back = button('←', 'communities-back');
    back.setAttribute('aria-label', 'Volver a comunidades');
    back.onclick = () => { selected = null; selectedDetail = null; detailGeneration += 1; renderList(); renderDetail(); };
    const copy = make('div', 'communities-detail-copy');
    copy.append(make('h3', '', community.name || community.id), make('p', '', displayCount(community.participantCount)));
    top.append(back, copy);
    detailRoot.append(top);
    if (community.description) detailRoot.append(make('p', 'communities-description', community.description));
    const tools = make('div', 'communities-tools');
    if (canCommunityAction(community, 'subject')) {
      const edit = button('Editar nombre', 'communities-tool');
      edit.onclick = () => openTextDialog('Editar nombre', 'subject', community.name || '', edit);
      const editDescription = button('Editar descripción', 'communities-tool');
      editDescription.onclick = () => openTextDialog('Editar descripción', 'description', community.description || '', editDescription);
      tools.append(edit, editDescription);
    }
    if (canCommunityAction(community, 'link')) {
      const link = button('Añadir grupo existente', 'communities-tool');
      link.onclick = () => openGroupDialog(link);
      tools.append(link);
    }
    if (tools.childNodes.length) detailRoot.append(tools);
    detailRoot.append(make('h4', 'communities-section-title', 'Grupos de la comunidad'));
    const groupsRoot = make('div', 'communities-groups');
    if (!linkedGroups.length) groupsRoot.append(make('p', 'communities-empty', 'Todavía no hay grupos vinculados.'));
    for (const group of linkedGroups) {
      const row = make('div', 'communities-group');
      const open = button('', 'communities-group-open');
      open.append(make('span', 'communities-group-avatar', (group.name || 'G').slice(0, 1).toLocaleUpperCase()));
      const groupCopy = make('span', 'communities-row-copy');
      groupCopy.append(make('strong', '', group.name || group.id), make('small', '', displayCount(group.participantCount)));
      open.append(groupCopy);
      open.onclick = () => {
        const chat = resolveLinkedGroupChat(group, getChats());
        if (!chat) { error('Este grupo aún no está sincronizado en esta cuenta. Sincroniza los chats y vuelve a intentarlo.'); return; }
        close();
        selectChat(chat);
      };
      row.append(open);
      if (canCommunityAction(community, 'unlink')) {
        const unlink = button('Desvincular', 'communities-unlink');
        unlink.setAttribute('aria-label', `Desvincular ${group.name || group.id}`);
        unlink.onclick = () => openConfirmation(`¿Desvincular ${group.name || 'este grupo'}?`, 'El grupo seguirá existiendo fuera de la comunidad.', 'Desvincular grupo', () => mutate('unlink', { groupJid: group.id }), unlink);
        row.append(unlink);
      }
      groupsRoot.append(row);
    }
    detailRoot.append(groupsRoot);
    if (canCommunityAction(community, 'leave')) {
      const leave = button('Salir de la comunidad', 'communities-leave');
      leave.onclick = () => openConfirmation('¿Salir de esta comunidad?', 'Dejarás de verla en esta cuenta.', 'Salir de la comunidad', () => mutate('leave'), leave);
      detailRoot.append(leave);
    }
  }

  async function loadList() {
    const request = ++listGeneration;
    const scoped = client.scope();
    if (!scoped.account) { communities = []; status.textContent = 'No hay una cuenta seleccionada.'; renderList(); return; }
    status.dataset.kind = '';
    status.textContent = 'Cargando comunidades…';
    try {
      const result = await client.list();
      if (!result || shade.hidden || request !== listGeneration || !client.isCurrent(scoped.account, scoped.token)) return;
      communities = result;
      previews = new Map();
      clearError();
      renderList();
      void Promise.allSettled(result.map(async community => {
        const preview = await client.detail(community.id);
        if (!preview || shade.hidden || request !== listGeneration || !client.isCurrent(scoped.account, scoped.token)) return;
        previews.set(community.id, preview);
        renderList();
      }));
    } catch (cause) {
      if (request === listGeneration && client.isCurrent(scoped.account, scoped.token) && !shade.hidden) {
        communities = [];
        listRoot.replaceChildren();
        error(cause.message || 'No se pudieron cargar las comunidades.');
      }
    }
  }

  async function selectCommunity(id) {
    selected = id;
    selectedDetail = null;
    const token = ++detailGeneration;
    const scoped = client.scope();
    renderList();
    detailRoot.dataset.selected = 'true';
    detailRoot.replaceChildren(make('p', 'communities-placeholder', 'Cargando comunidad…'));
    try {
      const result = await client.detail(id);
      if (!result || !currentDetail(id, token, scoped)) return;
      selectedDetail = result;
      clearError();
      renderDetail();
    } catch (cause) {
      if (!currentDetail(id, token, scoped)) return;
      detailRoot.replaceChildren(make('p', 'communities-placeholder', 'No se pudo cargar esta comunidad.'));
      error(cause.message || 'No se pudo cargar esta comunidad.');
    }
  }

  function openDialog(titleText, trigger) {
    closeDialog(false);
    const root = make('div', 'communities-modal');
    const card = make('section', 'communities-dialog');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    const heading = make('h3', '', titleText);
    card.append(heading);
    root.append(card);
    panel.append(root);
    dialog = { root, card, trigger };
    return card;
  }
  function dialogActions(card, submitLabel, onSubmit) {
    const message = make('p', 'communities-dialog-error');
    message.setAttribute('role', 'alert');
    const actions = make('div', 'communities-dialog-actions');
    const cancel = button('Cancelar', 'communities-cancel');
    const submit = button(submitLabel, 'communities-submit');
    cancel.onclick = () => closeDialog();
    submit.onclick = async () => {
      if (submit.disabled || busy) return;
      submit.disabled = true;
      message.textContent = '';
      try { await onSubmit(); }
      catch (cause) { if (dialog?.card === card) message.textContent = cause.message || 'No se pudo completar la acción.'; }
      finally { submit.disabled = false; }
    };
    actions.append(cancel, submit);
    card.append(message, actions);
    return submit;
  }
  function openConfirmation(titleText, explanation, submitLabel, onSubmit, trigger) {
    const card = openDialog(titleText, trigger);
    card.append(make('p', 'communities-dialog-hint', explanation));
    const submit = dialogActions(card, submitLabel, onSubmit);
    submit.classList.add('is-danger');
    submit.focus();
  }
  function openTextDialog(titleText, field, initial, trigger) {
    const card = openDialog(titleText, trigger);
    const input = make(field === 'description' ? 'textarea' : 'input', 'communities-input');
    input.value = initial;
    input.setAttribute('aria-label', titleText);
    input.maxLength = field === 'description' ? 2048 : 100;
    card.append(input);
    dialogActions(card, 'Guardar', async () => {
      const value = input.value.trim();
      if (field === 'subject' && !value) throw new Error('Escribe un nombre.');
      await mutate(field, { [field]: value });
    });
    input.focus();
  }
  function openGroupDialog(trigger) {
    const card = openDialog('Añadir grupo existente', trigger);
    const linked = new Set(selectedDetail?.linkedGroups.map(group => group.id) || []);
    const groups = (getChats() || []).filter(chat => chat.isGroup === true && providerGroupJid(chat) && !linked.has(providerGroupJid(chat)));
    if (!groups.length) {
      card.append(make('p', 'communities-dialog-hint', 'No hay grupos disponibles en los chats de esta cuenta.'));
      const closeButton = button('Cerrar', 'communities-cancel');
      closeButton.onclick = () => closeDialog();
      card.append(closeButton);
      closeButton.focus();
      return;
    }
    const label = make('label', 'communities-field-label', 'Grupo');
    const select = make('select', 'communities-input');
    for (const group of groups) {
      const option = make('option', '', group.name || group.id);
      option.value = providerGroupJid(group);
      select.append(option);
    }
    label.append(select);
    card.append(label);
    dialogActions(card, 'Añadir grupo', () => mutate('link', { groupJid: select.value }));
    select.focus();
  }
  async function mutate(name, fields = {}) {
    const community = selectedDetail?.community;
    const id = selected;
    const token = detailGeneration;
    const scoped = client.scope();
    setBusy(true);
    try {
      const result = await client.action(community, name, fields);
      if (!result || !currentDetail(id, token, scoped)) return;
      closeDialog(false);
      if (name === 'leave') { selected = null; selectedDetail = null; detailGeneration += 1; renderDetail(); }
      await loadList();
      if (name !== 'leave' && selected === id) await selectCommunity(id);
    } finally { setBusy(false); }
  }
  async function create() {
    const card = openDialog('Nueva comunidad', createButton);
    const name = make('input', 'communities-input');
    name.placeholder = 'Nombre de la comunidad';
    name.maxLength = 100;
    name.setAttribute('aria-label', 'Nombre de la comunidad');
    const description = make('textarea', 'communities-input');
    description.placeholder = 'Descripción opcional';
    description.maxLength = 2048;
    description.setAttribute('aria-label', 'Descripción de la comunidad');
    card.append(name, description);
    dialogActions(card, 'Crear comunidad', async () => {
      const scoped = client.scope();
      setBusy(true);
      try {
        const community = await client.create(name.value, description.value);
        if (!community || !client.isCurrent(scoped.account, scoped.token) || shade.hidden) return;
        closeDialog(false);
        await loadList();
        if (client.isCurrent(scoped.account, scoped.token) && !shade.hidden) await selectCommunity(community.id);
      } finally { setBusy(false); }
    });
    name.focus();
  }

  entry.onclick = () => {
    if (!shade.hidden) { close(); return; }
    opener = documentRef.activeElement || entry;
    shade.hidden = false;
    entry.setAttribute('aria-expanded', 'true');
    onOpen();
    selected = null;
    selectedDetail = null;
    renderDetail();
    void loadList();
    createButton.focus();
  };
  createButton.onclick = () => { void create(); };
  shade.addEventListener('pointerdown', event => { if (event.target === shade) close(); });
  documentRef.addEventListener('keydown', event => {
    if (shade.hidden || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (dialog) closeDialog(); else close();
    } else if (event.key === 'Tab') {
      const focusRoot = dialog?.root || panel;
      const focusable = [...focusRoot.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])')]
        .filter(element => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && documentRef.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && documentRef.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  function accountChanged() {
    client.accountChanged();
    listGeneration += 1;
    detailGeneration += 1;
    communities = [];
    previews = new Map();
    selected = null;
    selectedDetail = null;
    closeDialog(false);
    shade.hidden = true;
    entry.setAttribute('aria-expanded', 'false');
    clearError();
    listRoot.replaceChildren();
    renderDetail();
  }
  return { accountChanged, close, open: () => entry.click() };
}
