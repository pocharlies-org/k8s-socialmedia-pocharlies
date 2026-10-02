import {pollDraft} from './poll-draft.mjs';

export function createPollComposer({documentRef = globalThis.document, submit, isCurrent = () => true, onSent = () => {}, createToken = () => crypto.randomUUID()}) {
  const node = (tag, className = '', text) => {
    const element = documentRef.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const button = (text, label = text) => {
    const element = node('button', 'feature-button', text);
    element.type = 'button'; element.setAttribute('aria-label', label);
    return element;
  };
  const form = node('form', 'poll-composer feature-form');
  const fields = node('fieldset', 'poll-fields');
  const questionLabel = node('label', 'feature-field', 'Pregunta');
  const question = node('textarea'); question.name = 'question'; question.rows = 2;
  question.maxLength = 255; question.required = true; question.placeholder = 'Haz una pregunta';
  questionLabel.append(question);
  const heading = node('h3', '', 'Opci\u00f3nes');
  const list = node('div', 'poll-option-list');
  const rows = [];
  const add = button('A\u00f1adir opci\u00f3n');
  const multipleLabel = node('label', 'poll-multiple');
  const multiple = node('input'); multiple.type = 'checkbox'; multiple.checked = true;
  multiple.setAttribute('role', 'switch');
  multipleLabel.append(multiple, node('span', '', 'Permitir varias respuestas'));
  const status = node('p', 'poll-composer-status'); status.setAttribute('role', 'alert'); status.hidden = true;
  const send = button('Enviar encuesta'); send.type = 'submit'; send.classList.add('primary');
  fields.append(questionLabel, heading, list, add, multipleLabel);
  form.append(fields, status, send);
  let pending = false;
  let signature = '';
  let token = '';
  form.oninput = () => {if (!pending) status.hidden = true;};

  function renderRows(focus) {
    list.replaceChildren();
    rows.forEach((row, index) => {
      row.label.textContent = `Opci\u00f3n ${index + 1}`;
      row.label.append(row.input);
      row.up.disabled = index === 0; row.down.disabled = index === rows.length - 1;
      row.remove.disabled = rows.length <= 2;
      row.up.setAttribute('aria-label', `Subir opci\u00f3n ${index + 1}`);
      row.down.setAttribute('aria-label', `Bajar opci\u00f3n ${index + 1}`);
      row.remove.setAttribute('aria-label', `Eliminar opci\u00f3n ${index + 1}`);
      list.append(row.element);
    });
    add.disabled = rows.length >= 12;
    focus?.focus();
  }
  function addRow() {
    if (pending || rows.length >= 12) return;
    const element = node('div', 'poll-option-row');
    const label = node('label', 'feature-field');
    const input = node('input'); input.type = 'text'; input.maxLength = 100; input.required = true; input.placeholder = 'A\u00f1ade texto';
    const up = button('\u2191'); const down = button('\u2193'); const remove = button('\u00d7');
    const controls = node('div', 'poll-option-controls'); controls.append(up, down, remove);
    const row = {element, label, input, up, down, remove};
    element.append(label, controls); rows.push(row);
    function move(delta) {
      if (pending) return;
      const index = rows.indexOf(row); const next = index + delta;
      if (next < 0 || next >= rows.length) return;
      [rows[index], rows[next]] = [rows[next], rows[index]];
      renderRows(input);
    }
    up.onclick = () => move(-1); down.onclick = () => move(1);
    remove.onclick = () => {
      if (pending || rows.length <= 2) return;
      const index = rows.indexOf(row); rows.splice(index, 1);
      renderRows(rows[Math.min(index, rows.length - 1)].input);
    };
    renderRows(input);
  }
  add.onclick = addRow;
  addRow(); addRow();
  form.onsubmit = async event => {
    event.preventDefault();
    if (pending || !isCurrent()) return;
    let payload;
    try {
      payload = pollDraft({question: question.value, options: rows.map(row => row.input.value), selectableCount: multiple.checked ? rows.length : 1});
    } catch (error) {
      status.textContent = error.message; status.hidden = false; return;
    }
    const nextSignature = JSON.stringify(payload);
    if (nextSignature !== signature) {token = createToken(); signature = nextSignature;}
    pending = true; fields.disabled = true; send.disabled = true;
    send.textContent = 'Enviando...'; form.setAttribute('aria-busy', 'true'); status.hidden = true;
    try {
      await submit(payload, token);
      if (isCurrent()) onSent();
    } catch (error) {
      if (isCurrent()) {status.textContent = error.message || 'No se ha podido enviar la encuesta.'; status.hidden = false;}
    } finally {
      pending = false; fields.disabled = false; send.disabled = false;
      send.textContent = 'Enviar encuesta'; form.setAttribute('aria-busy', 'false');
    }
  };
  return form;
}
