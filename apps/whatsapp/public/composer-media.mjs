export function planAttachmentSends(files, text = '', replyTo = '') {
  const caption = text.trim();
  const captionIndex = files.findIndex(file => !file.type?.startsWith('audio/'));
  const plans = files.map((file, index) => ({
    file,
    caption: index === captionIndex ? caption : '',
    replyTo: !(caption && captionIndex < 0) && index === (captionIndex >= 0 && caption ? captionIndex : 0) ? replyTo : '',
  }));
  if (caption && captionIndex < 0) plans.unshift({text: caption, replyTo});
  return plans;
}

export function stopCameraTracks(stream) {
  stream?.getTracks?.().forEach(track => track.stop());
}

export function createCameraController({documentRef, mediaDevices, getContext, isCurrent, onCapture, showError}) {
  const overlay = documentRef.createElement('div');
  overlay.className = 'camera-overlay';
  overlay.id = 'camera-overlay';
  overlay.hidden = true;
  const dialog = documentRef.createElement('div');
  dialog.className = 'camera-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Camara');
  const title = documentRef.createElement('h2');
  title.textContent = 'Camara';
  const video = documentRef.createElement('video');
  video.id = 'camera-preview';
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  const actions = documentRef.createElement('div');
  actions.className = 'camera-actions';
  const capture = documentRef.createElement('button');
  capture.type = 'button';
  capture.id = 'camera-capture';
  capture.textContent = 'Capturar foto';
  capture.disabled = true;
  const cancel = documentRef.createElement('button');
  cancel.type = 'button';
  cancel.id = 'camera-cancel';
  cancel.textContent = 'Cancelar';
  actions.append(capture, cancel);
  dialog.append(title, video, actions);
  overlay.append(dialog);
  documentRef.body.append(overlay);

  let stream = null;
  let generation = 0;
  let opener = null;
  function close(restoreFocus = false) {
    generation++;
    stopCameraTracks(stream);
    stream = null;
    video.srcObject = null;
    overlay.hidden = true;
    capture.disabled = true;
    if (restoreFocus) opener?.focus?.();
    opener = null;
  }
  async function open() {
    close();
    const token = generation;
    const ctx = getContext();
    opener = documentRef.activeElement;
    if (!ctx.chat || !mediaDevices?.getUserMedia) {
      showError('La camara no esta disponible en este navegador o chat.');
      return;
    }
    overlay.hidden = false;
    cancel.focus();
    try {
      const acquired = await mediaDevices.getUserMedia({video:true, audio:false});
      if (token !== generation || !isCurrent(ctx)) { stopCameraTracks(acquired); return; }
      stream = acquired;
      video.srcObject = stream;
      await video.play();
      if (token === generation && isCurrent(ctx)) capture.disabled = false;
    } catch (err) {
      if (token === generation && isCurrent(ctx)) {
        close(true);
        showError(`No se pudo abrir la camara: ${err.message}`);
      }
    }
  }
  capture.onclick = async () => {
    if (!stream || capture.disabled) return;
    const token = generation;
    const ctx = getContext();
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) { showError('La camara todavia no muestra una imagen.'); return; }
    const scale = Math.min(1, 1920 / Math.max(width, height));
    const canvas = documentRef.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.88));
      if (token !== generation || !isCurrent(ctx)) return;
      if (!blob) throw new Error('No se pudo crear la foto.');
      const file = new File([blob], `camara-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`, {type:'image/jpeg'});
      if (onCapture(file) !== false) close(true);
    } catch (err) { if (token === generation && isCurrent(ctx)) showError(err.message); }
  };
  cancel.onclick = () => close(true);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(true); });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (event.key !== 'Tab') return;
    const focusable = [capture, cancel].filter(button => !button.disabled);
    const index = focusable.indexOf(documentRef.activeElement);
    const next = event.shiftKey ? (index <= 0 ? focusable.at(-1) : focusable[index - 1])
      : focusable[(index + 1) % focusable.length];
    event.preventDefault();
    next.focus();
  });
  return {open, close};
}
