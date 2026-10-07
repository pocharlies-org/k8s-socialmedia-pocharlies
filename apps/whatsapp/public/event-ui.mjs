export function installEventUI({container, getContext, api, canSend, documentRef = globalThis.document, newToken = () => crypto.randomUUID()}) {
  const pending = new Set();
  const unresolved = new Map();
  const storageKey = 'socialmedia:event-rsvp-unresolved:v1';
  const saveUnresolved = () => {
    try { globalThis.sessionStorage?.setItem(storageKey, JSON.stringify([...unresolved])); } catch {}
  };
  const markUnresolved = (scope, value) => {
    unresolved.set(scope, value);
    saveUnresolved();
  };
  const clearUnresolved = scope => {
    unresolved.delete(scope);
    saveUnresolved();
  };
  try {
    const stored = JSON.parse(globalThis.sessionStorage?.getItem(storageKey) || '[]');
    if (Array.isArray(stored)) {
      for (const [scope, value] of stored) {
        if (typeof scope === 'string' && value && ['going', 'not_going', 'maybe'].includes(value.attendance))
          unresolved.set(scope, value);
      }
    }
  } catch {}
  const contextKey = ctx => JSON.stringify([ctx.account, ctx.chat, ctx.version]);
  const element = (tag, text, className = '') => {
    const node = documentRef.createElement(tag);
    node.textContent = text;
    node.className = className;
    return node;
  };
  const choiceLabels = [['going', 'Asistiré'], ['not_going', 'No asistiré'], ['maybe', 'Quizá']];
  async function open(button) {
    const bubble = button.closest('[data-message-id]');
    if (!bubble || button.disabled) return;
    const ctx = {...getContext()};
    const id = bubble.dataset.messageId;
    const scope = JSON.stringify([ctx.account, ctx.chat, id]);
    if (pending.has(scope)) return;
    const card = button.closest('.message-structured-card');
    card.querySelector('.event-response-panel')?.remove();
    const panel = element('div', '', 'event-response-panel');
    const status = element('p', 'Cargando respuestas…', 'event-response-status');
    status.setAttribute('role', 'status');
    panel.append(status);
    card.append(panel);
    const current = () => panel.isConnected && contextKey(ctx) === contextKey(getContext());
    button.disabled = true;
    const choices = new Map();
    let guests = null;
    let unconfirmed = null;
    let selectedBeforeSend = null;
    const clearUnconfirmed = () => {
      for (const node of Object.values(unconfirmed)) node.remove();
      unconfirmed = null;
    };
    const setBusy = busy => {
      const locked = busy || !!unconfirmed || !canSend() || button.dataset.cancelled === 'true';
      for (const choice of choices.values()) choice.disabled = locked;
      if (guests) guests.disabled = busy || !!unconfirmed;
      if (unconfirmed) unconfirmed.button.disabled = busy || !canSend() || button.dataset.cancelled === 'true';
    };
    const setPressed = selectedByMe => {
      for (const [attendance, choice] of choices)
        choice.setAttribute('aria-pressed', String(attendance === selectedByMe));
    };
    const fetchResults = async () => {
      const data = await api(`/api/messages/event/results?${new URLSearchParams({account: ctx.account, chat: ctx.chat, messageId: id})}`);
      if (data.account !== ctx.account || data.chat !== ctx.chat) throw new Error('No se pudieron verificar las respuestas.');
      return data.results;
    };
    const offerResend = (attendance, extraGuestCount) => {
      status.textContent = 'No se pudo confirmar la entrega anterior.';
      const buttonAgain = element('button', 'Enviar de nuevo', 'event-response-retry');
      buttonAgain.type = 'button';
      buttonAgain.disabled = !canSend() || button.dataset.cancelled === 'true';
      const note = element('small', 'Tu respuesta anterior quedó sin confirmar y puede no haberse enviado. «Enviar de nuevo» inicia un envío deliberado con un identificador nuevo; el recuento muestra solo lo que ya está confirmado.', 'event-response-note');
      buttonAgain.addEventListener('click', () => void sendResponse(attendance, extraGuestCount, {retry: true}));
      panel.append(buttonAgain, note);
      unconfirmed = {button: buttonAgain, note};
      button.disabled = true;
      setBusy(pending.has(scope));
    };
    const sendResponse = async (attendance, extraGuestCount, {retry = false} = {}) => {
      if (!current() || !canSend() || pending.has(scope) || (unresolved.has(scope) && !retry)) return;
      const sendToken = newToken();
      const previousSelection = unresolved.get(scope)?.previousSelection || selectedBeforeSend;
      // Persist before the request so a reload during an in-flight send keeps its recovery path.
      markUnresolved(scope, {attendance, extraGuestCount, previousSelection});
      pending.add(scope);
      if (unconfirmed) clearUnconfirmed();
      setBusy(true);
      status.textContent = 'Enviando respuesta…';
      try {
        const sent = await api('/api/messages/event/respond', {account: ctx.account, chat: ctx.chat, messageId: id, attendance, extraGuestCount, sendToken});
        if (sent?.confirmed !== true || sent.account !== ctx.account || sent.chat !== ctx.chat) throw new Error('Entrega no confirmada');
        if (!current()) return;
        status.textContent = 'Respuesta enviada';
        clearUnresolved(scope);
        setPressed(attendance);
        selectedBeforeSend = {attendance, extraGuestCount};
        button.disabled = false;
      } catch {
        if (!current()) {
          markUnresolved(scope, {attendance, extraGuestCount, previousSelection});
          return;
        }
        // The claim outcome is uncertain: verify it against fresh server
        // results instead of promising a same-token retry can still land.
        status.textContent = 'Entrega no confirmada. Comprobando el resultado…';
        let result = null;
        try { result = await fetchResults(); } catch {}
        if (!current()) {
          markUnresolved(scope, {attendance, extraGuestCount, previousSelection});
          return;
        }
        const alreadySelected = previousSelection?.attendance === attendance
          && (attendance !== 'going' || previousSelection.extraGuestCount === extraGuestCount);
        const confirmed = !alreadySelected && result?.available === true && result.selectedByMe === attendance
          && (attendance !== 'going' || result.selectedExtraGuestCount === extraGuestCount);
        if (confirmed) {
          status.textContent = 'Respuesta confirmada al actualizar';
          clearUnresolved(scope);
          setPressed(attendance);
          selectedBeforeSend = {attendance, extraGuestCount};
          button.disabled = false;
        } else {
          // No automatic replay with a new token: the user decides.
          markUnresolved(scope, {attendance, extraGuestCount, previousSelection});
          offerResend(attendance, extraGuestCount);
        }
      } finally {
        pending.delete(scope);
        if (current()) setBusy(false);
      }
    };
    try {
      const result = await fetchResults();
      if (!current()) return;
      if (!result?.available) {
        status.textContent = 'Las respuestas no están disponibles en esta copia del evento.';
        return;
      }
      selectedBeforeSend = {attendance: result.selectedByMe, extraGuestCount: result.selectedExtraGuestCount};
      status.textContent = `${result.counts.going} asistirán · ${result.counts.not_going} no asistirán · ${result.counts.maybe} quizá`;
      panel.append(element('small', 'Respuestas sincronizadas; puede faltar historial.', 'event-response-note'));
      const controls = element('div', '', 'event-response-choices');
      guests = element('input', '');
      guests.type = 'number'; guests.min = '0'; guests.step = '1';
      guests.value = String(Number.isSafeInteger(result.selectedExtraGuestCount) && result.selectedExtraGuestCount >= 0 ? result.selectedExtraGuestCount : 0);
      guests.setAttribute('aria-label', 'Acompañantes');
      if (button.dataset.extraGuests === 'true') {
        const label = element('label', 'Acompañantes');
        label.append(guests); panel.append(label);
      }
      for (const [attendance, label] of choiceLabels) {
        const choice = element('button', label);
        choice.type = 'button';
        choice.setAttribute('aria-pressed', String(result.selectedByMe === attendance));
        choice.disabled = !canSend() || button.dataset.cancelled === 'true';
        choice.addEventListener('click', () => {
          const extraGuestCount = attendance === 'going' && button.dataset.extraGuests === 'true' ? Number(guests.value) : 0;
          if (!Number.isSafeInteger(extraGuestCount) || extraGuestCount < 0) {status.textContent = 'Introduce un número válido de acompañantes.'; return;}
          void sendResponse(attendance, extraGuestCount);
        });
        choices.set(attendance, choice);
        controls.append(choice);
      }
      panel.append(controls);
      const uncertain = unresolved.get(scope);
      if (uncertain) {
        const alreadySelected = uncertain.previousSelection?.attendance === uncertain.attendance
          && (uncertain.attendance !== 'going' || uncertain.previousSelection.extraGuestCount === uncertain.extraGuestCount);
        const confirmed = !alreadySelected && result.selectedByMe === uncertain.attendance
          && (uncertain.attendance !== 'going' || result.selectedExtraGuestCount === uncertain.extraGuestCount);
        if (confirmed) {
          clearUnresolved(scope);
          status.textContent = 'Respuesta confirmada al actualizar';
        } else {
          offerResend(uncertain.attendance, uncertain.extraGuestCount);
        }
      }
    } catch {
      if (current()) status.textContent = 'No se pudieron cargar las respuestas. Vuelve a intentarlo.';
    } finally {
      if (current()) {button.disabled = !!unconfirmed; button.textContent = 'Actualizar respuestas';}
    }
  }
  container.addEventListener('click', event => {
    const button = event.target.closest?.('.message-event-open');
    if (button && container.contains(button)) void open(button);
  });
}
