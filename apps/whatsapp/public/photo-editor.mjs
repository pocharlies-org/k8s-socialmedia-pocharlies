// Pre-send photo editor for WhatsApp-style draft attachments.
// Pure Canvas transforms run locally; the original File is never mutated until
// the user explicitly applies, and the edited result is a fresh JPEG File.
// A normal edit keeps the source resolution: images are only downscaled above
// MAX_EDIT_DIM, a browser canvas-memory ceiling that is surfaced to the user.
export const MAX_EDIT_DIM = 4096;
// Each undo snapshot is a full cloned RGBA canvas (~4 bytes per pixel), so the
// retained count scales down with working area to bound peak memory. A 4096px
// square snapshot costs ~64 MiB, so at most a couple are kept for those.
const BYTES_PER_PIXEL = 4;
export const EDIT_MEMORY_BUDGET = 128 * 1024 * 1024;
export const MIN_SNAPSHOTS = 2;
const EDITABLE_MIME = /^image\/(jpeg|png|webp)$/;
const EXPORT_MIME = 'image/jpeg';
const EXPORT_QUALITY = 0.92;
const STICKER_SIZE = 512;
const STICKER_MAX_BYTES = 100 * 1024;
const MAX_HISTORY = 15;

export function historyLimitFor(width, height, budget = EDIT_MEMORY_BUDGET) {
  const snapshotBytes = Math.max(1, (width || 0) * (height || 0) * BYTES_PER_PIXEL);
  return Math.max(MIN_SNAPSHOTS, Math.min(MAX_HISTORY, Math.floor(budget / snapshotBytes)));
}

export function editCapNotice() {
  return `La imagen superaba ${MAX_EDIT_DIM} px y se redujo para poder editarla.`;
}

export function editableImage(file) {
  return EDITABLE_MIME.test(file?.type || '');
}

export function outputFileName(name) {
  const base = String(name || 'imagen').replace(/\.[^./\\]+$/, '') || 'imagen';
  return `${base}-editada.jpg`;
}

export function stickerFileName(name) {
  return outputFileName(name).replace(/-editada\.jpg$/, '-sticker.webp');
}

export function rotatedSize(width, height, quarterTurns) {
  const turns = ((Math.trunc(quarterTurns) % 4) + 4) % 4;
  return (turns % 2 === 1) ? {width: height, height: width} : {width, height};
}

export function clampCrop(rect, width, height, min = 16) {
  const w = Math.min(width, Math.max(min, rect.width));
  const h = Math.min(height, Math.max(min, rect.height));
  const x = Math.min(Math.max(0, rect.x), width - w);
  const y = Math.min(Math.max(0, rect.y), height - h);
  return {x, y, width: w, height: h};
}

export function isFullCrop(rect, width, height) {
  return rect.x <= 0.5 && rect.y <= 0.5 && rect.width >= width - 0.5 && rect.height >= height - 0.5;
}

// Undo/redo over opaque snapshot states. The editor stores cloned canvases; the
// unit tests exercise it with plain values.
export class History {
  constructor(limit = MAX_HISTORY) { this.limit = limit; this.states = []; this.index = -1; }
  reset(initial) { this.states = [initial]; this.index = 0; }
  clear() { this.states = []; this.index = -1; }
  setLimit(limit) {
    this.limit = limit;
    const excess = this.states.length - limit;
    if (excess > 0) { this.states = this.states.slice(excess); this.index -= excess; }
  }
  get current() { return this.index >= 0 ? this.states[this.index] : undefined; }
  canUndo() { return this.index > 0; }
  canRedo() { return this.index >= 0 && this.index < this.states.length - 1; }
  push(state) {
    this.states.splice(this.index + 1);
    this.states.push(state);
    if (this.states.length > this.limit) this.states.shift();
    this.index = this.states.length - 1;
  }
  undo() { if (this.canUndo()) { this.index -= 1; return this.current; } return undefined; }
  redo() { if (this.canRedo()) { this.index += 1; return this.current; } return undefined; }
}

function cloneCanvas(canvas) {
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  copy.getContext('2d').drawImage(canvas, 0, 0);
  return copy;
}

function paintCanvas(target, source) {
  target.width = source.width;
  target.height = source.height;
  const ctx = target.getContext('2d');
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.drawImage(source, 0, 0);
}

function scaledCanvas(source, width, height, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return {canvas, reduced: scale < 1};
}

function loadImage(file, maxDim) {
  if (globalThis.createImageBitmap) {
    return globalThis.createImageBitmap(file).then(bitmap => {
      try { return scaledCanvas(bitmap, bitmap.width, bitmap.height, maxDim); }
      finally { bitmap.close?.(); }
    });
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try { resolve(scaledCanvas(image, image.naturalWidth, image.naturalHeight, maxDim)); }
      catch (error) { reject(error); }
      finally { URL.revokeObjectURL(url); }
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen.')); };
    image.src = url;
  });
}

function exportJpeg(canvas) {
  const flat = document.createElement('canvas');
  flat.width = canvas.width;
  flat.height = canvas.height;
  const ctx = flat.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, flat.width, flat.height);
  ctx.drawImage(canvas, 0, 0);
  return new Promise((resolve, reject) => {
    flat.toBlob(blob => blob ? resolve(blob) : reject(new Error('No se pudo generar la imagen editada.')), EXPORT_MIME, EXPORT_QUALITY);
  });
}

export async function exportSticker(canvas) {
  const square = canvas.ownerDocument.createElement('canvas');
  square.width = STICKER_SIZE;
  square.height = STICKER_SIZE;
  const scale = Math.min(STICKER_SIZE / canvas.width, STICKER_SIZE / canvas.height);
  const width = canvas.width * scale;
  const height = canvas.height * scale;
  square.getContext('2d').drawImage(canvas, (STICKER_SIZE - width) / 2, (STICKER_SIZE - height) / 2, width, height);
  for (const quality of [0.9, 0.8, 0.68, 0.56, 0.44, 0.32, 0.2]) {
    const blob = await new Promise(resolve => square.toBlob(resolve, 'image/webp', quality));
    if (!blob || blob.type !== 'image/webp') throw new Error('Este navegador no puede crear stickers WebP.');
    if (blob.size <= STICKER_MAX_BYTES) return blob;
  }
  throw new Error('El sticker supera los 100 KiB. Prueba con una imagen más sencilla.');
}

export function createPhotoEditor({getContext, isCurrent, onApply, showError, documentRef} = {}) {
  const doc = documentRef || document;
  const overlay = doc.createElement('div');
  overlay.className = 'photo-editor-overlay';
  overlay.id = 'photo-editor-overlay';
  overlay.hidden = true;

  const dialog = doc.createElement('div');
  dialog.className = 'photo-editor';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Editor de fotos');

  const header = doc.createElement('div');
  header.className = 'photo-editor-header';
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.id = 'photo-editor-cancel';
  cancel.className = 'photo-editor-close';
  cancel.textContent = 'Cancelar';
  cancel.setAttribute('aria-label', 'Cancelar edición sin guardar');
  const title = doc.createElement('h2');
  title.textContent = 'Editar foto';
  const undo = doc.createElement('button');
  undo.type = 'button';
  undo.id = 'photo-editor-undo';
  undo.textContent = 'Deshacer';
  undo.disabled = true;
  const redo = doc.createElement('button');
  redo.type = 'button';
  redo.id = 'photo-editor-redo';
  redo.textContent = 'Rehacer';
  redo.disabled = true;
  const apply = doc.createElement('button');
  apply.type = 'button';
  apply.id = 'photo-editor-apply';
  apply.className = 'photo-editor-apply';
  apply.textContent = 'Listo';
  header.append(cancel, title, undo, redo, apply);

  const notice = doc.createElement('p');
  notice.className = 'photo-editor-notice';
  notice.id = 'photo-editor-notice';
  notice.setAttribute('role', 'status');
  notice.hidden = true;

  const stage = doc.createElement('div');
  stage.className = 'photo-editor-stage';
  const box = doc.createElement('div');
  box.className = 'photo-editor-canvas-box';
  const canvas = doc.createElement('canvas');
  canvas.id = 'photo-editor-canvas';
  canvas.className = 'photo-editor-canvas';
  const crop = doc.createElement('div');
  crop.className = 'photo-editor-crop';
  crop.hidden = true;
  const cropMask = doc.createElement('div');
  cropMask.className = 'photo-editor-crop-mask';
  const cropFrame = doc.createElement('div');
  cropFrame.className = 'photo-editor-crop-frame';
  const handleDefs = [
    ['nw', 'corner'], ['ne', 'corner'], ['sw', 'corner'], ['se', 'corner'],
    ['n', 'edge'], ['s', 'edge'], ['w', 'edge'], ['e', 'edge'],
  ];
  const handles = {};
  for (const [key] of handleDefs) {
    const handle = doc.createElement('span');
    handle.className = `photo-editor-handle photo-editor-handle-${key}`;
    handle.dataset.handle = key;
    cropFrame.append(handle);
    handles[key] = handle;
  }
  crop.append(cropMask, cropFrame);
  box.append(canvas, crop);
  stage.append(box);

  const tools = doc.createElement('div');
  tools.className = 'photo-editor-tools';
  const toolTabs = doc.createElement('div');
  toolTabs.className = 'photo-editor-tool-tabs';
  toolTabs.setAttribute('role', 'tablist');
  const tabDefs = [['crop', 'Recortar'], ['draw', 'Dibujar'], ['text', 'Texto']];
  const tabs = {};
  for (const [key, label] of tabDefs) {
    const tab = doc.createElement('button');
    tab.type = 'button';
    tab.id = `photo-tab-${key}`;
    tab.className = 'photo-editor-tab';
    tab.textContent = label;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.dataset.tool = key;
    tab.onclick = () => selectTool(key);
    toolTabs.append(tab);
    tabs[key] = tab;
  }
  const rotateLeft = doc.createElement('button');
  rotateLeft.type = 'button';
  rotateLeft.id = 'photo-rotate-left';
  rotateLeft.textContent = '↺';
  rotateLeft.setAttribute('aria-label', 'Girar a la izquierda');
  rotateLeft.onclick = () => rotate(-1);
  const rotateRight = doc.createElement('button');
  rotateRight.type = 'button';
  rotateRight.id = 'photo-rotate-right';
  rotateRight.textContent = '↻';
  rotateRight.setAttribute('aria-label', 'Girar a la derecha');
  rotateRight.onclick = () => rotate(1);
  tools.append(toolTabs, rotateLeft, rotateRight);

  const panels = doc.createElement('div');
  panels.className = 'photo-editor-panels';
  const cropPanel = doc.createElement('div');
  cropPanel.className = 'photo-editor-panel';
  cropPanel.dataset.panel = 'crop';
  const cropDone = doc.createElement('button');
  cropDone.type = 'button';
  cropDone.id = 'photo-crop-apply';
  cropDone.textContent = 'Completar recorte';
  cropDone.onclick = () => commitCrop();
  cropPanel.append(cropDone);

  const drawPanel = doc.createElement('div');
  drawPanel.className = 'photo-editor-panel';
  drawPanel.dataset.panel = 'draw';
  drawPanel.hidden = true;
  const colors = ['#ff3b30', '#ffcc00', '#34c759', '#007aff', '#af52de', '#ffffff'];
  const colorRow = doc.createElement('div');
  colorRow.className = 'photo-editor-colors';
  colorRow.setAttribute('role', 'radiogroup');
  colorRow.setAttribute('aria-label', 'Color del trazo');
  colors.forEach((color, index) => {
    const swatch = doc.createElement('button');
    swatch.type = 'button';
    swatch.className = 'photo-editor-swatch';
    swatch.dataset.color = color;
    swatch.style.setProperty('--swatch', color);
    swatch.setAttribute('role', 'radio');
    swatch.setAttribute('aria-label', `Color ${color}`);
    swatch.setAttribute('aria-checked', index === 0 ? 'true' : 'false');
    swatch.onclick = () => setStrokeColor(color);
    colorRow.append(swatch);
  });
  const widthRow = doc.createElement('div');
  widthRow.className = 'photo-editor-widths';
  [['fine', 'Fino', 0.012], ['bold', 'Grueso', 0.05]].forEach(([key, label, ratio], index) => {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'photo-editor-width';
    btn.dataset.width = key;
    btn.dataset.ratio = String(ratio);
    btn.textContent = label;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', index === 1 ? 'true' : 'false');
    btn.onclick = () => setStrokeWidth(ratio, btn);
    widthRow.append(btn);
  });
  drawPanel.append(colorRow, widthRow);

  const textPanel = doc.createElement('div');
  textPanel.className = 'photo-editor-panel';
  textPanel.dataset.panel = 'text';
  textPanel.hidden = true;
  const textInput = doc.createElement('input');
  textInput.type = 'text';
  textInput.id = 'photo-text-input';
  textInput.className = 'photo-editor-text-input';
  textInput.placeholder = 'Escribe un texto';
  textInput.setAttribute('aria-label', 'Texto para la imagen');
  const textAdd = doc.createElement('button');
  textAdd.type = 'button';
  textAdd.id = 'photo-text-add';
  textAdd.textContent = 'Añadir texto';
  textAdd.onclick = () => addText();
  textInput.onkeydown = event => {
    if (event.key === 'Enter') { event.preventDefault(); addText(); }
    else event.stopPropagation();
  };
  textPanel.append(textInput, textAdd);

  panels.append(cropPanel, drawPanel, textPanel);
  dialog.append(header, notice, stage, tools, panels);
  overlay.append(dialog);
  doc.body.append(overlay);

  const history = new History();
  const ctx = canvas.getContext('2d');
  let tool = 'crop';
  let strokeColor = colors[0];
  let strokeRatio = 0.016;
  let selection = {x: 0, y: 0, width: 0, height: 0};
  let textAnchor = null;
  let opener = null;
  let generation = 0;
  let drawing = null;
  let cropDrag = null;
  let loaded = false;
  let applyHandler = onApply;
  let outputMode = 'photo';

  function toCanvasPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return {x: 0, y: 0};
    const x = (clientX - rect.left) / rect.width * canvas.width;
    const y = (clientY - rect.top) / rect.height * canvas.height;
    return {x, y};
  }
  function selectionToCss() {
    const {width: W, height: H} = canvas;
    cropFrame.style.left = `${selection.x / W * 100}%`;
    cropFrame.style.top = `${selection.y / H * 100}%`;
    cropFrame.style.width = `${selection.width / W * 100}%`;
    cropFrame.style.height = `${selection.height / H * 100}%`;
    cropMask.style.setProperty('--crop-left', `${selection.x / W * 100}%`);
    cropMask.style.setProperty('--crop-top', `${selection.y / H * 100}%`);
    cropMask.style.setProperty('--crop-width', `${selection.width / W * 100}%`);
    cropMask.style.setProperty('--crop-height', `${selection.height / H * 100}%`);
  }
  function updateHistoryButtons() {
    undo.disabled = !history.canUndo();
    redo.disabled = !history.canRedo();
  }
  function pushState() {
    history.push(cloneCanvas(canvas));
    updateHistoryButtons();
  }
  function restoreState(state) {
    paintCanvas(canvas, state);
    selection = {x: 0, y: 0, width: canvas.width, height: canvas.height};
    textAnchor = null;
    selectionToCss();
    updateHistoryButtons();
  }
  function selectTool(next) {
    if (tool === 'crop' && next !== 'crop') commitCrop({silent: true});
    tool = next;
    for (const [key, tab] of Object.entries(tabs)) {
      tab.setAttribute('aria-selected', String(key === next));
      tab.setAttribute('data-active', String(key === next));
    }
    crop.hidden = next !== 'crop';
    cropPanel.hidden = next !== 'crop';
    drawPanel.hidden = next !== 'draw';
    textPanel.hidden = next !== 'text';
    stage.dataset.tool = next;
    box.classList.toggle('drawing', next === 'draw');
    if (next === 'text') textInput.focus();
    if (next === 'crop') { selection = {x: 0, y: 0, width: canvas.width, height: canvas.height}; selectionToCss(); }
  }
  function setStrokeColor(color, node) {
    strokeColor = color;
    for (const swatch of colorRow.querySelectorAll('.photo-editor-swatch')) {
      swatch.setAttribute('aria-checked', String(swatch.dataset.color === color));
    }
    node?.focus?.();
  }
  function setStrokeWidth(ratio, node) {
    strokeRatio = ratio;
    for (const btn of widthRow.querySelectorAll('.photo-editor-width')) {
      btn.setAttribute('aria-checked', String(Number(btn.dataset.ratio) === Number(ratio)));
    }
    node?.focus?.();
  }
  function rotate(turns) {
    if (!loaded) return;
    if (tool === 'crop') commitCrop({silent: true});
    const size = rotatedSize(canvas.width, canvas.height, turns);
    const rotated = doc.createElement('canvas');
    rotated.width = size.width;
    rotated.height = size.height;
    const rctx = rotated.getContext('2d');
    rctx.translate(size.width / 2, size.height / 2);
    rctx.rotate((turns > 0 ? 90 : -90) * Math.PI / 180);
    rctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    paintCanvas(canvas, rotated);
    selection = {x: 0, y: 0, width: canvas.width, height: canvas.height};
    textAnchor = null;
    selectionToCss();
    pushState();
  }
  function commitCrop({silent = false} = {}) {
    if (!loaded) return false;
    const W = canvas.width;
    const H = canvas.height;
    if (isFullCrop(selection, W, H)) { selection = {x: 0, y: 0, width: W, height: H}; selectionToCss(); return false; }
    const rect = clampCrop(selection, W, H);
    const cropped = doc.createElement('canvas');
    cropped.width = Math.round(rect.width);
    cropped.height = Math.round(rect.height);
    cropped.getContext('2d').drawImage(canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, cropped.width, cropped.height);
    paintCanvas(canvas, cropped);
    selection = {x: 0, y: 0, width: canvas.width, height: canvas.height};
    selectionToCss();
    pushState();
    if (!silent) stage.dataset.justCropped = String(Date.now());
    return true;
  }
  function addText() {
    const value = textInput.value.trim();
    if (!value || !loaded) return;
    const anchor = textAnchor || {x: canvas.width / 2, y: canvas.height / 2};
    const size = Math.max(16, Math.round(Math.min(canvas.width, canvas.height) * 0.08));
    ctx.save();
    ctx.font = `700 ${size}px ${getComputedStyle(doc.body).getPropertyValue('--font') || 'system-ui, sans-serif'}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, size * 0.12);
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.fillStyle = '#ffffff';
    ctx.strokeText(value, anchor.x, anchor.y);
    ctx.fillText(value, anchor.x, anchor.y);
    ctx.restore();
    textInput.value = '';
    textAnchor = null;
    pushState();
  }
  function onPointerDown(event) {
    if (!loaded || event.button != null && event.button !== 0) return;
    const point = toCanvasPoint(event.clientX, event.clientY);
    if (tool === 'draw') {
      drawing = {x: point.x, y: point.y};
      ctx.save();
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = Math.max(2, Math.min(canvas.width, canvas.height) * strokeRatio);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(point.x, point.y);
      ctx.lineTo(point.x + 0.01, point.y + 0.01);
      ctx.stroke();
      canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    } else if (tool === 'text') {
      textAnchor = point;
      textInput.focus();
    }
  }
  function onPointerMove(event) {
    if (!drawing) return;
    const point = toCanvasPoint(event.clientX, event.clientY);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    drawing = {x: point.x, y: point.y};
    event.preventDefault();
  }
  function onPointerUp(event) {
    if (!drawing) return;
    ctx.restore();
    drawing = null;
    canvas.releasePointerCapture?.(event?.pointerId);
    pushState();
  }
  function beginCropDrag(event) {
    if (tool !== 'crop') return;
    const handle = event.target?.dataset?.handle || 'move';
    const start = toCanvasPoint(event.clientX, event.clientY);
    cropDrag = {handle, start: {...start}, base: {...selection}};
    event.preventDefault();
    cropFrame.setPointerCapture?.(event.pointerId);
  }
  function moveCropDrag(event) {
    if (!cropDrag) return;
    const point = toCanvasPoint(event.clientX, event.clientY);
    const dx = point.x - cropDrag.start.x;
    const dy = point.y - cropDrag.start.y;
    const W = canvas.width;
    const H = canvas.height;
    const base = cropDrag.base;
    let {x, y, width, height} = base;
    const key = cropDrag.handle;
    if (!key || key === 'move') {
      x = base.x + dx; y = base.y + dy;
    } else {
      if (key.includes('w')) { x = base.x + dx; width = base.width - dx; }
      if (key.includes('e')) { width = base.width + dx; }
      if (key.includes('n')) { y = base.y + dy; height = base.height - dy; }
      if (key.includes('s')) { height = base.height + dy; }
      if (width < 0) { x += width; width = Math.abs(width); }
      if (height < 0) { y += height; height = Math.abs(height); }
    }
    selection = clampCrop({x, y, width, height}, W, H, Math.max(24, Math.round(Math.min(W, H) * 0.08)));
    selectionToCss();
    event.preventDefault();
  }
  function endCropDrag(event) {
    if (!cropDrag) return;
    cropDrag = null;
    cropFrame.releasePointerCapture?.(event?.pointerId);
  }
  function close(restoreFocus = true) {
    generation++;
    overlay.hidden = true;
    loaded = false;
    drawing = null;
    cropDrag = null;
    history.clear();
    if (canvas.width || canvas.height) { canvas.width = 0; canvas.height = 0; }
    undo.disabled = true;
    redo.disabled = true;
    if (restoreFocus) opener?.focus?.();
    opener = null;
  }
  function focusables() {
    return [cancel, undo, redo, apply, tabs.crop, tabs.draw, tabs.text, rotateLeft, rotateRight,
      ...colorRow.querySelectorAll('button'), ...widthRow.querySelectorAll('button'), cropDone, textInput, textAdd]
      .filter(el => el && !el.disabled && el.offsetParent !== null);
  }
  overlay.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) return;
    const index = items.indexOf(doc.activeElement);
    const next = event.shiftKey ? (index <= 0 ? items.at(-1) : items[index - 1]) : items[(index + 1) % items.length];
    event.preventDefault();
    next.focus();
  });
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  cancel.onclick = () => close();
  apply.onclick = async () => {
    if (!loaded) return;
    const ctxNow = getContext?.();
    const token = generation;
    commitCrop({silent: true});
    apply.disabled = true;
    let file;
    try {
      const blob = outputMode === 'sticker' ? await exportSticker(canvas) : await exportJpeg(canvas);
      file = outputMode === 'sticker'
        ? new File([blob], stickerFileName(currentName), {type: 'image/webp'})
        : new File([blob], outputFileName(currentName), {type: EXPORT_MIME});
    } catch (err) {
      notice.textContent = err.message || 'No se pudo editar la imagen.';
      notice.hidden = false;
      showError?.(notice.textContent);
      apply.disabled = false;
      return;
    }
    apply.disabled = false;
    if (token !== generation) return;
    if (isCurrent && ctxNow && !isCurrent(ctxNow)) { close(false); return; }
    const accepted = applyHandler?.(file);
    if (accepted !== false) close();
  };
  undo.onclick = () => { const state = history.undo(); if (state) restoreState(state); };
  redo.onclick = () => { const state = history.redo(); if (state) restoreState(state); };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  cropFrame.addEventListener('pointerdown', beginCropDrag);
  cropFrame.addEventListener('pointermove', moveCropDrag);
  cropFrame.addEventListener('pointerup', endCropDrag);
  cropFrame.addEventListener('pointercancel', endCropDrag);

  let currentName = 'imagen';
  async function open(file, onApplyOverride, {mode = 'photo'} = {}) {
    close(false);
    const token = generation;
    opener = doc.activeElement;
    currentName = file?.name || 'imagen';
    outputMode = mode === 'sticker' ? 'sticker' : 'photo';
    title.textContent = outputMode === 'sticker' ? 'Crear sticker' : 'Editar foto';
    apply.textContent = outputMode === 'sticker' ? 'Usar sticker' : 'Listo';
    dialog.setAttribute('aria-label', title.textContent);
    applyHandler = onApplyOverride || onApply;
    overlay.hidden = false;
    stage.dataset.tool = 'crop';
    stage.dataset.loaded = '';
    notice.hidden = true;
    try {
      const maxDim = outputMode === 'sticker' ? STICKER_SIZE : MAX_EDIT_DIM;
      const source = await loadImage(file, maxDim);
      if (token !== generation) return;
      if (source.reduced) {
        notice.textContent = outputMode === 'sticker' ? 'El sticker se prepara a 512 × 512 px.' : editCapNotice();
        notice.hidden = false;
      }
      paintCanvas(canvas, source.canvas);
      loaded = true;
      textAnchor = null;
      textInput.value = '';
      history.setLimit(historyLimitFor(canvas.width, canvas.height));
      history.reset(cloneCanvas(canvas));
      selection = {x: 0, y: 0, width: canvas.width, height: canvas.height};
      selectionToCss();
      selectTool('crop');
      stage.dataset.loaded = '1';
      updateHistoryButtons();
      cancel.focus();
    } catch (err) {
      if (token === generation) { showError?.(err.message || 'No se pudo abrir el editor.'); close(true); }
    }
  }

  return {open, close, isEditing: () => !overlay.hidden};
}
