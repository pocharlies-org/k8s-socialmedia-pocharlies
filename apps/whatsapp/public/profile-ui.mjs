export function createProfileClient({ api, getAccount }) {
  let generation = 0;
  const scope = () => ({ account: getAccount(), generation });
  const current = token => token.account === getAccount() && token.generation === generation;
  async function request(path = '/api/profile', body) {
    const token = scope();
    if (!token.account) return null;
    const result = await api(body ? path : `${path}?account=${encodeURIComponent(token.account)}`,
      body ? { ...body, account: token.account } : undefined);
    if (!current(token)) return null;
    if (result?.account !== token.account || !result.profile || typeof result.profile !== 'object' || Array.isArray(result.profile)) throw new Error('Respuesta de perfil no válida.');
    return result;
  }
  return { request, scope, current, invalidate() { generation++; } };
}

export function installProfileUI({ documentRef = document, api, getAccount, onOpen = () => {} }) {
  const section = documentRef.querySelector('.settings-section');
  if (!section) return null;
  const client = createProfileClient({ api, getAccount });
  const entry = documentRef.createElement('button');
  entry.type = 'button';
  entry.id = 'profile-toggle';
  entry.className = 'profile-entry';
  entry.textContent = 'Mi perfil';
  section.append(entry);
  const panel = documentRef.createElement('section');
  panel.id = 'profile-panel';
  panel.className = 'profile-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Mi perfil');
  panel.innerHTML = `<header class="profile-header"><h2>Mi perfil</h2><button class="settings-close" type="button" aria-label="Cerrar perfil">&times;</button></header>
    <div class="profile-scroll"><div class="profile-photo"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3Z"/></svg><img alt="Foto de perfil" hidden></div>
    <p class="profile-phone"></p><div class="profile-photo-actions"><button type="button" data-action="photo">Cambiar foto</button><button type="button" data-action="remove">Quitar foto</button></div>
    <input class="profile-file" type="file" accept="image/jpeg,image/png,image/webp" hidden>
    <form><label>Tu nombre<input name="name" maxlength="25" autocomplete="name" required></label>
    <label>Info.<textarea name="about" maxlength="139" rows="3"></textarea></label>
    <button class="profile-save" type="submit">Guardar</button></form>
    <p class="profile-notice" role="status" aria-live="polite"></p><button class="profile-reload" type="button" hidden>Volver a cargar</button></div>`;
  documentRef.body.append(panel);
  const $ = selector => panel.querySelector(selector);
  const form = $('form');
  const name = $('[name="name"]');
  const about = $('[name="about"]');
  const notice = $('.profile-notice');
  const reload = $('.profile-reload');
  const file = $('.profile-file');
  const photo = $('img');
  const controls = [...panel.querySelectorAll('form input, form textarea, form button, .profile-photo-actions button')];
  let snapshot = null;
  let busy = false;
  let photoVersion = 0;
  const showNotice = (text, failed = false) => {
    notice.textContent = text;
    notice.classList.toggle('is-error', failed);
  };
  function setBusy(value) {
    busy = value;
    panel.setAttribute('aria-busy', String(value));
    for (const control of controls) control.disabled = value || !snapshot?.sendingEnabled;
    if (!value && snapshot?.sendingEnabled) {
      name.disabled = snapshot.capabilities?.name !== true;
      about.disabled = snapshot.capabilities?.about !== true;
      $('[data-action="photo"]').disabled = snapshot.capabilities?.photo !== true;
      $('[data-action="remove"]').disabled = snapshot.capabilities?.photoRemove !== true || !snapshot.profile.photo?.available;
      $('.profile-save').disabled = name.disabled && about.disabled;
    }
  }
  function render(result) {
    snapshot = result;
    const profile = result.profile;
    name.value = profile.name ?? '';
    about.value = profile.about ?? '';
    $('.profile-phone').textContent = profile.phone ?? '';
    photo.hidden = !profile.photo?.available;
    if (profile.photo?.available) {
      photo.src = `/api/profile/photo?account=${encodeURIComponent(getAccount())}&v=${++photoVersion}`;
    } else photo.removeAttribute('src');
    setBusy(false);
  }
  photo.onerror = () => {
    photo.hidden = true;
    if (!panel.hidden && snapshot?.profile.photo?.available) {
      showNotice('No se pudo cargar la foto. Vuelve a cargar el perfil para intentarlo de nuevo.', true);
      reload.hidden = false;
    }
  };
  function close(restoreFocus = true) {
    client.invalidate();
    panel.hidden = true;
    file.value = '';
    if (restoreFocus) documentRef.querySelector('.rail-settings summary')?.focus();
  }
  async function load() {
    client.invalidate();
    const token = client.scope();
    snapshot = null;
    name.value = '';
    about.value = '';
    $('.profile-phone').textContent = '';
    photo.hidden = true;
    photo.removeAttribute('src');
    setBusy(true);
    reload.hidden = true;
    if (!token.account) {
      setBusy(false);
      showNotice('No hay una cuenta activa. Selecciona una cuenta de WhatsApp.', true);
      reload.hidden = false;
      return;
    }
    showNotice('Cargando perfil…');
    try {
      const result = await client.request();
      if (!result || !client.current(token)) return;
      render(result);
      showNotice(result.sendingEnabled ? '' : 'Los cambios de perfil están desactivados para esta cuenta.');
    } catch (error) {
      if (!client.current(token)) return;
      showNotice(error.message, true);
      reload.hidden = false;
      setBusy(false);
    }
  }
  async function mutate(path, body) {
    if (busy || !snapshot?.sendingEnabled) return;
    const token = client.scope();
    setBusy(true);
    showNotice('Guardando…');
    try {
      const result = await client.request(path, body);
      if (!result || !client.current(token)) return;
      // Mutation projections can omit capabilities; preserve only this account's snapshot.
      render({ ...snapshot, ...result, capabilities: result.capabilities ?? snapshot.capabilities,
        sendingEnabled: result.sendingEnabled ?? snapshot.sendingEnabled,
        profile: { ...snapshot.profile, ...result.profile } });
      showNotice(result.confirmed === true ? 'Perfil actualizado.' : 'WhatsApp todavía no ha confirmado todos los cambios. Vuelve a cargar el perfil para comprobarlo.', result.confirmed !== true);
      reload.hidden = result.confirmed === true;
    } catch (error) {
      if (client.current(token)) showNotice(error.message, true);
    } finally {
      if (client.current(token)) setBusy(false);
    }
  }
  entry.onclick = () => {
    documentRef.querySelector('.rail-settings').open = false;
    panel.hidden = false;
    onOpen();
    $('.settings-close').focus();
    void load();
  };
  $('.settings-close').onclick = () => close();
  reload.onclick = () => { void load(); };
  form.onsubmit = event => {
    event.preventDefault();
    if (!snapshot) return;
    const changes = {};
    if (!name.disabled && name.value.trim() !== snapshot.profile.name) changes.name = name.value.trim();
    if (!about.disabled && about.value.trim() !== (snapshot.profile.about ?? '')) changes.about = about.value.trim();
    if (!Object.keys(changes).length) { showNotice('No hay cambios pendientes.'); return; }
    void mutate('/api/profile', changes);
  };
  $('[data-action="photo"]').onclick = () => { file.value = ''; file.click(); };
  $('[data-action="remove"]').onclick = () => {
    if (globalThis.confirm('¿Quitar tu foto de perfil de WhatsApp?')) void mutate('/api/profile/photo/remove', {});
  };
  file.onchange = async () => {
    const selected = file.files?.[0];
    file.value = '';
    if (!selected || busy) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(selected.type) || !selected.size || selected.size > 8 * 1024 * 1024) {
      showNotice('Elige una imagen JPEG, PNG o WebP de hasta 8 MiB.', true);
      return;
    }
    const token = client.scope();
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('No se pudo leer la imagen.'));
        reader.readAsDataURL(selected);
      });
      if (client.current(token)) await mutate('/api/profile/photo', { name: selected.name, mimeType: selected.type, data });
    } catch (error) { if (client.current(token)) showNotice(error.message, true); }
  };
  documentRef.addEventListener('keydown', event => {
    if (!panel.hidden && event.key === 'Escape') { event.preventDefault(); close(); }
  });
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const focusable = [...panel.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled])')]
      .filter(element => !element.closest('[hidden]'));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && documentRef.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && documentRef.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  documentRef.addEventListener('pointerdown', event => {
    if (!panel.hidden && !panel.contains(event.target) && event.target !== entry) close(false);
  });
  return { accountChanged() { client.invalidate(); if (!panel.hidden) void load(); }, close };
}
