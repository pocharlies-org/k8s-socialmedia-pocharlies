import {eventDraft, localEventTime} from './event-draft.mjs';

export function createEventComposer({documentRef = globalThis.document, submit, isCurrent = () => true, onSent = () => {}, createToken = () => crypto.randomUUID(), now = () => new Date()}) {
  const node = (tag, className = '', text) => {
    const element = documentRef.createElement(tag); element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const field = (label, type, maxLength) => {
    const wrapper = node('label', 'feature-field', label);
    const input = node(type === 'textarea' ? 'textarea' : 'input');
    if (type === 'textarea') input.rows = 3; else input.type = type;
    if (maxLength) input.maxLength = maxLength;
    wrapper.append(input); return {wrapper, input};
  };
  const form = node('form', 'event-composer feature-form');
  const fields = node('fieldset', 'poll-fields');
  const title = field('Nombre del evento', 'text', 2000); title.input.required = true;
  const description = field('Descripci\u00f3n (opcional)', 'textarea', 2048);
  const start = field('Fecha y hora de inicio', 'datetime-local'); start.input.required = true;
  const initial = now(); initial.setDate(initial.getDate() + 1); initial.setHours(18, 0, 0, 0);
  const pad = value => String(value).padStart(2, '0');
  start.input.value = `${initial.getFullYear()}-${pad(initial.getMonth() + 1)}-${pad(initial.getDate())}T18:00`;
  const end = field('Fecha y hora de finalizaci\u00f3n', 'datetime-local'); end.wrapper.hidden = true; end.input.disabled = true;
  const includeLabel = node('label', 'poll-multiple');
  const include = node('input'); include.type = 'checkbox'; include.setAttribute('role', 'switch');
  includeLabel.append(include, node('span', '', 'A\u00f1adir fecha de finalizaci\u00f3n'));
  include.onchange = () => {
    end.wrapper.hidden = !include.checked; end.input.disabled = !include.checked; end.input.required = include.checked;
    if (include.checked && !end.input.value) end.input.value = start.input.value;
  };
  const location = field('Ubicaci\u00f3n (opcional)', 'text', 2000);
  const status = node('p', 'poll-composer-status'); status.setAttribute('role', 'alert'); status.hidden = true;
  const send = node('button', 'feature-button primary', 'Crear evento'); send.type = 'submit';
  fields.append(title.wrapper, description.wrapper, start.wrapper, includeLabel, end.wrapper, location.wrapper);
  form.append(fields, status, send);
  let pending = false; let signature = ''; let token = '';
  form.oninput = () => {if (!pending) status.hidden = true;};
  form.onsubmit = async event => {
    event.preventDefault(); if (pending || !isCurrent()) return;
    let payload;
    try {
      payload = eventDraft({title: title.input.value, description: description.input.value,
        dateTime: localEventTime(start.input.value), endDateTime: include.checked ? localEventTime(end.input.value) : '', location: location.input.value});
    } catch (error) {status.textContent = error.message; status.hidden = false; return;}
    const next = JSON.stringify(payload);
    if (signature !== next) {signature = next; token = createToken();}
    pending = true; fields.disabled = true; send.disabled = true; send.textContent = 'Enviando...';
    status.hidden = true; form.setAttribute('aria-busy', 'true');
    try {await submit(payload, token); if (isCurrent()) onSent();}
    catch (error) {if (isCurrent()) {status.textContent = error.message || 'No se ha podido crear el evento.'; status.hidden = false;}}
    finally {pending = false; fields.disabled = false; send.disabled = false; send.textContent = 'Crear evento'; form.setAttribute('aria-busy', 'false');}
  };
  return form;
}
