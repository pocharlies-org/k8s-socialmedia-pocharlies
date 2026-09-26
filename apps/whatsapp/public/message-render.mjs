const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const FORMAT_TYPES = { '*': 'strong', '_': 'em', '~': 'del' };
const TRAILING_LINK_PUNCTUATION = /[.,!?;:]+$/;
const GROUP_WINDOW_MS = 5 * 60 * 1000;
const mediaViewerStates = new WeakMap();
const MESSAGE_KINDS = {
  IMAGE: { label: 'Imagen', icon: 'image' },
  VIDEO: { label: 'Video', icon: 'video' },
  AUDIO: { label: 'Audio', icon: 'audio' },
  DOCUMENT: { label: 'Documento', icon: 'document' },
  STICKER: { label: 'Sticker', icon: 'sticker' },
  POLL: { label: 'Encuesta', icon: 'poll' },
  LOCATION: { label: 'Ubicacion', icon: 'location' },
};
const ICON_PATHS = {
  image: ['M4 4h16v16H4z', 'M8 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'm5 17 4-5 3 3 2-2 5 4'],
  video: ['M4 5h12v14H4z', 'm16 10 4-3v10l-4-3'],
  audio: ['M12 3v12', 'M9 7v8a3 3 0 0 0 6 0V7', 'M6 14a6 6 0 0 0 12 0', 'M12 20v2'],
  document: ['M6 2h8l4 4v16H6z', 'M14 2v5h4', 'M9 12h6', 'M9 16h6'],
  sticker: ['M4 3h16v11l-7 7H4z', 'M13 21v-7h7', 'M8 9h.01', 'M16 9h.01', 'M9 14c2 2 4 2 6 0'],
  poll: ['M5 18V9h3v9z', 'M11 18V4h3v14z', 'M17 18v-6h3v6z'],
  location: ['M19 10c0 5-7 12-7 12S5 15 5 10a7 7 0 1 1 14 0z', 'M12 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
  unavailable: ['M6 3h9l4 4v14H6z', 'M15 3v5h4', 'M9 12h6', 'M9 16h6', 'M4 4l16 16'],
};

/** Remove a draft only when it is still the exact value confirmed by the API. */
export function clearDraftIfUnchanged(drafts, key, originalValue) {
  if (!drafts?.has?.(key) || drafts.get(key) !== originalValue) return false;
  drafts.delete(key);
  return true;
}

/** A confirmed send clears its original draft even after navigation, without erasing newer text. */
export function clearConfirmedDraft(drafts, key, originalValue, activeKey, composer) {
  const cleared = clearDraftIfUnchanged(drafts, key, originalValue);
  if (cleared && activeKey === key && composer?.value === originalValue) composer.value = '';
  return cleared;
}

export function isLatestRequest(requestToken, currentToken) {
  return requestToken === currentToken;
}

export function stopMediaTracks(stream) {
  for (const track of stream?.getTracks?.() || []) {
    try { track.stop(); } catch {}
  }
}

function textValue(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function browserBaseUrl() {
  return typeof globalThis.location?.href === 'string' ? globalThis.location.href : 'http://localhost/';
}

/** Return an HTTP(S) URL suitable for a media source or anchor href. */
export function safeMessageUrl(value, base = browserBaseUrl()) {
  const raw = textValue(value).trim();
  if (!raw || raw.length > 4096) return null;
  try {
    const url = new URL(raw, base);
    if (!HTTP_PROTOCOLS.has(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function safeMailUrl(value) {
  const raw = textValue(value).trim();
  const address = raw.toLowerCase().startsWith('mailto:') ? raw.slice(7) : raw;
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) return null;
  return `mailto:${address}`;
}

function trimLink(value) {
  let result = value;
  while (TRAILING_LINK_PUNCTUATION.test(result)) result = result.slice(0, -1);
  while (result.endsWith(')') && (result.match(/\(/g) || []).length < (result.match(/\)/g) || []).length) result = result.slice(0, -1);
  while (result.endsWith(']') && (result.match(/\[/g) || []).length < (result.match(/\]/g) || []).length) result = result.slice(0, -1);
  return result;
}

function linkAt(input, index) {
  const previous = input[index - 1] || '';
  if (previous && /[\w@]/.test(previous)) return null;
  const match = input.slice(index).match(/^(?:https?:\/\/[^\s<>"'`]+|www\.[^\s<>"'`]+|mailto:[^\s<>"'`]+|[^\s<>"'`@]+@[^\s<>"'`@]+\.[^\s<>"'`@]+)/i);
  if (!match) return null;
  const raw = trimLink(match[0]);
  if (!raw) return null;
  const href = raw.toLowerCase().startsWith('www.')
    ? safeMessageUrl(`https://${raw}`)
    : raw.toLowerCase().startsWith('mailto:') || raw.includes('@') && !/^https?:\/\//i.test(raw)
      ? safeMailUrl(raw)
      : safeMessageUrl(raw);
  if (!href) return null;
  return { type: 'link', href, label: raw, length: raw.length };
}

function canOpenDelimiter(input, index, delimiter) {
  const next = input[index + delimiter.length] || '';
  const previous = input[index - 1] || '';
  if (!next || /\s/.test(next) || previous === delimiter) return false;
  if (delimiter === '_' && /[\p{L}\p{N}]/u.test(previous)) return false;
  return true;
}

function canCloseDelimiter(input, index, delimiter) {
  const previous = input[index - 1] || '';
  const next = input[index + delimiter.length] || '';
  if (!previous || /\s/.test(previous) || next === delimiter) return false;
  if (delimiter === '_' && /[\p{L}\p{N}]/u.test(next)) return false;
  return true;
}

function closingDelimiter(input, start, delimiter) {
  for (let index = start; index < input.length; index += 1) {
    if (input[index] === delimiter && canCloseDelimiter(input, index, delimiter)) return index;
  }
  return -1;
}

function pushText(tokens, value) {
  if (!value) return;
  const previous = tokens[tokens.length - 1];
  if (previous?.type === 'text') previous.value += value;
  else tokens.push({ type: 'text', value });
}

function parseRuns(input) {
  const tokens = [];
  let plainStart = 0;
  let index = 0;
  const flushText = end => {
    if (end > plainStart) pushText(tokens, input.slice(plainStart, end));
  };
  while (index < input.length) {
    if (input.startsWith('```', index)) {
      const end = input.indexOf('```', index + 3);
      if (end >= 0) {
        flushText(index);
        tokens.push({ type: 'code-block', value: input.slice(index + 3, end) });
        index = end + 3;
        plainStart = index;
        continue;
      }
    }
    if (input[index] === '`' && input[index - 1] !== '`' && input[index + 1] !== '`') {
      const end = input.indexOf('`', index + 1);
      if (end > index + 1) {
        flushText(index);
        tokens.push({ type: 'code', value: input.slice(index + 1, end) });
        index = end + 1;
        plainStart = index;
        continue;
      }
    }
    const link = linkAt(input, index);
    if (link) {
      flushText(index);
      tokens.push(link);
      index += link.length;
      plainStart = index;
      continue;
    }
    const delimiter = input[index];
    if (FORMAT_TYPES[delimiter] && input[index - 1] !== delimiter && input[index + 1] !== delimiter && canOpenDelimiter(input, index, delimiter)) {
      const end = closingDelimiter(input, index + 1, delimiter);
      if (end > index + 1) {
        flushText(index);
        tokens.push({ type: FORMAT_TYPES[delimiter], children: parseRuns(input.slice(index + 1, end)) });
        index = end + 1;
        plainStart = index;
        continue;
      }
    }
    index += 1;
  }
  flushText(input.length);
  return tokens;
}

/** Parse WhatsApp-style formatting into safe, DOM-independent render tokens. */
export function parseRichText(value) {
  return parseRuns(textValue(value));
}

function parseTimestamp(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const milliseconds = Math.abs(value) < 1e12 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Format a message timestamp using the user's local calendar. */
export function formatMessageTime(value) {
  const date = parseTimestamp(value);
  if (!date) return '';
  // Intl uses the browser's actual timezone instead of the server timezone.
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

/** Return Hoy, Ayer, or a compact Spanish date label. */
export function formatDateSeparator(value, now = new Date()) {
  const date = parseTimestamp(value);
  const reference = parseTimestamp(now);
  if (!date || !reference) return '';
  const difference = Math.round((dayStart(reference) - dayStart(date)) / 86400000);
  if (difference === 0) return 'Hoy';
  if (difference === 1) return 'Ayer';
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
}

/** Format a chat-list timestamp as WhatsApp does: time today, Ayer, or date. */
export function formatChatListTime(value, now = new Date()) {
  const date = parseTimestamp(value);
  if (!date) return '';
  const label = formatDateSeparator(date, now);
  return label === 'Hoy' ? formatMessageTime(date) : label;
}

function senderGroupKey(message) {
  if (message?.fromMe === true) return 'outgoing';
  const sender = textValue(message?.senderId || message?.senderName || message?.senderPushName).trim();
  return sender ? `incoming:${sender}` : 'incoming:unknown';
}

function sameGroup(previous, current) {
  if (!previous || !current || senderGroupKey(previous) !== senderGroupKey(current)) return false;
  if (previous.fromMe !== true && (!textValue(previous.senderId || previous.senderName || previous.senderPushName).trim() || !textValue(current.senderId || current.senderName || current.senderPushName).trim())) return false;
  const previousDate = parseTimestamp(previous.timestamp);
  const currentDate = parseTimestamp(current.timestamp);
  if (!previousDate || !currentDate) return false;
  return Math.abs(currentDate.getTime() - previousDate.getTime()) <= GROUP_WINDOW_MS;
}

/** Add stable grouping/date metadata without mutating API message objects. */
export function decorateMessages(messages, { now = new Date() } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  return list.map((message, index) => {
    const previous = list[index - 1];
    const next = list[index + 1];
    const timestamp = message?.timestamp;
    const dateLabel = formatDateSeparator(timestamp, now);
    const showDateSeparator = Boolean(dateLabel) && (index === 0 || formatDateSeparator(previous?.timestamp, now) !== dateLabel);
    return {
      ...(message && typeof message === 'object' ? message : {}),
      dateLabel,
      showDateSeparator,
      isFirstInGroup: !sameGroup(previous, message),
      isLastInGroup: !sameGroup(message, next),
    };
  });
}

/** Classify an attachment from either the current or persisted API field names. */
export function getAttachmentKind(attachment) {
  const mime = textValue(attachment?.mimeType || attachment?.mime_type).toLowerCase();
  const type = textValue(attachment?.type || attachment?.fileType || attachment?.file_type).toLowerCase();
  if (mime.startsWith('image/') || ['image', 'photo', 'sticker'].includes(type)) return 'image';
  if (mime.startsWith('audio/') || ['audio', 'voice', 'ptt'].includes(type)) return 'audio';
  if (mime.startsWith('video/') || ['video', 'clip'].includes(type)) return 'video';
  return 'document';
}

function makeElement(documentRef, tag, className, text) {
  const element = documentRef.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function appendToken(parent, token, documentRef) {
  if (token.type === 'text') {
    parent.append(documentRef.createTextNode(token.value));
    return;
  }
  if (token.type === 'link') {
    const link = makeElement(documentRef, 'a', 'message-link', token.label);
    link.href = token.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    parent.append(link);
    return;
  }
  if (token.type === 'code') {
    parent.append(makeElement(documentRef, 'code', 'message-inline-code', token.value));
    return;
  }
  if (token.type === 'code-block') {
    const pre = makeElement(documentRef, 'pre', 'message-code-block');
    pre.append(makeElement(documentRef, 'code', '', token.value));
    parent.append(pre);
    return;
  }
  const tag = token.type === 'strong' ? 'strong' : token.type === 'em' ? 'em' : 'del';
  const element = makeElement(documentRef, tag, `message-${token.type}`);
  for (const child of token.children || []) appendToken(element, child, documentRef);
  parent.append(element);
}

/** Append parsed message text using text nodes and allowlisted anchor URLs. */
export function appendRichText(parent, value, documentRef = globalThis.document) {
  if (!parent || !documentRef) return parent;
  const fragment = documentRef.createDocumentFragment();
  for (const token of parseRichText(value)) appendToken(fragment, token, documentRef);
  parent.append(fragment);
  return parent;
}

function formatDuration(value) {
  if (!Number.isFinite(value) || value < 0) return '--:--';
  const seconds = Math.floor(value);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function attachmentUrl(attachment) {
  return attachment?.url || attachment?.fileUrl || attachment?.file_url || attachment?.thumbnailUrl || attachment?.thumbnail_url || '';
}

function attachmentName(attachment) {
  return textValue(attachment?.name || attachment?.fileName || attachment?.file_name || 'Archivo adjunto').trim() || 'Archivo adjunto';
}

function appendDownload(parent, url, name, documentRef) {
  const link = makeElement(documentRef, 'a', 'attachment-link attachment-download', `Descargar ${name}`);
  link.href = url;
  link.download = name;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  parent.append(link);
}

function appendAttachmentError(parent, documentRef, message = 'No se pudo cargar el adjunto.') {
  let error = parent.querySelector?.('.attachment-error');
  if (!error) {
    error = makeElement(documentRef, 'p', 'attachment-error');
    parent.append(error);
  }
  error.textContent = message;
  error.hidden = false;
}

function addMediaError(media, parent, documentRef) {
  media.addEventListener?.('error', () => appendAttachmentError(parent, documentRef));
}

function closeImageViewer(documentRef, restoreFocus = true) {
  const state = mediaViewerStates.get(documentRef);
  if (!state) return;
  documentRef.removeEventListener?.('keydown', state.onKey);
  state.overlay.remove();
  mediaViewerStates.delete(documentRef);
  if (restoreFocus && state.opener && state.opener.isConnected !== false) state.opener.focus?.();
}

/** Close the current image viewer and restore focus to its opener. */
export function closeMediaViewer(documentRef = globalThis.document) {
  if (documentRef) closeImageViewer(documentRef);
}

function openImageViewer(url, name, documentRef, opener) {
  if (!documentRef?.body) return;
  closeImageViewer(documentRef, false);
  const overlay = makeElement(documentRef, 'div', 'media-viewer');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', name);
  const closeButton = makeElement(documentRef, 'button', 'media-viewer-close', 'Cerrar');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Cerrar imagen');
  const image = makeElement(documentRef, 'img', 'media-viewer-image');
  image.src = url;
  image.alt = name;
  const actions = makeElement(documentRef, 'div', 'media-viewer-actions');
  appendDownload(actions, url, name, documentRef);
  const close = () => closeImageViewer(documentRef);
  const onKey = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...overlay.querySelectorAll?.('button, a, [tabindex]:not([tabindex="-1"])') || []].filter(element => !element.disabled && element.getAttribute('aria-hidden') !== 'true');
    if (!focusable.length) {
      event.preventDefault();
      closeButton.focus?.();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!overlay.contains?.(documentRef.activeElement)) {
      event.preventDefault();
      first.focus?.();
      return;
    }
    if (event.shiftKey && documentRef.activeElement === first) {
      event.preventDefault();
      last.focus?.();
    } else if (!event.shiftKey && documentRef.activeElement === last) {
      event.preventDefault();
      first.focus?.();
    }
  };
  closeButton.onclick = close;
  overlay.addEventListener?.('click', event => { if (event.target === overlay) close(); });
  overlay.addEventListener?.('touchend', event => { if (event.target === overlay) close(); }, { passive: true });
  mediaViewerStates.set(documentRef, { overlay, onKey, opener });
  documentRef.addEventListener?.('keydown', onKey);
  overlay.append(closeButton, image, actions);
  documentRef.body.append(overlay);
  closeButton.focus?.();
}

function createAudioPlayer(url, name, parent, documentRef) {
  const player = makeElement(documentRef, 'div', 'message-audio audio-player');
  const audio = makeElement(documentRef, 'audio', 'audio-element');
  audio.preload = 'metadata';
  audio.src = url;
  audio.setAttribute('aria-hidden', 'true');
  audio.tabIndex = -1;
  const toggle = makeElement(documentRef, 'button', 'audio-toggle', 'Reproducir');
  toggle.type = 'button';
  toggle.setAttribute('aria-label', `Reproducir ${name}`);
  const progress = makeElement(documentRef, 'input', 'audio-progress');
  progress.type = 'range';
  progress.min = '0';
  progress.max = '100';
  progress.step = '0.1';
  progress.value = '0';
  progress.setAttribute('aria-label', 'Posicion del audio');
  const current = makeElement(documentRef, 'span', 'audio-current', '0:00');
  const duration = makeElement(documentRef, 'span', 'audio-duration', '--:--');
  const speed = makeElement(documentRef, 'select', 'audio-speed');
  speed.setAttribute('aria-label', 'Velocidad de reproduccion');
  for (const value of [0.5, 1, 1.5, 2]) {
    const option = makeElement(documentRef, 'option', '', `${value}x`);
    option.value = String(value);
    if (value === 1) option.selected = true;
    speed.append(option);
  }
  const time = makeElement(documentRef, 'span', 'audio-time');
  time.append(current, documentRef.createTextNode(' / '), duration);
  const controls = makeElement(documentRef, 'div', 'audio-controls');
  controls.append(toggle, progress, time, speed);
  player.append(audio, controls);
  const update = () => {
    const total = Number.isFinite(audio.duration) ? audio.duration : 0;
    const position = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    progress.value = total > 0 ? String(Math.min(100, position / total * 100)) : '0';
    current.textContent = formatDuration(position);
    duration.textContent = formatDuration(total);
  };
  const updateToggle = () => {
    const playing = !audio.paused && !audio.ended;
    toggle.textContent = playing ? 'Pausar' : 'Reproducir';
    toggle.setAttribute('aria-label', `${playing ? 'Pausar' : 'Reproducir'} ${name}`);
  };
  toggle.onclick = () => {
    if (audio.paused) {
      const result = audio.play();
      result?.catch?.(() => appendAttachmentError(parent, documentRef, 'No se pudo reproducir el audio.'));
    } else audio.pause();
  };
  progress.oninput = () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = Number(progress.value) / 100 * audio.duration;
  };
  speed.onchange = () => { audio.playbackRate = Number(speed.value) || 1; };
  for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'progress']) audio.addEventListener?.(event, update);
  for (const event of ['play', 'pause', 'ended']) audio.addEventListener?.(event, updateToggle);
  audio.addEventListener?.('error', () => appendAttachmentError(parent, documentRef, 'No se pudo cargar el audio.'));
  return player;
}

function createDocumentCard(attachment, url, name, documentRef) {
  const card = makeElement(documentRef, 'div', 'attachment-document');
  const icon = makeElement(documentRef, 'span', 'document-icon', 'DOC');
  icon.setAttribute('aria-hidden', 'true');
  const details = makeElement(documentRef, 'span', 'document-details');
  details.append(makeElement(documentRef, 'strong', 'document-name', name));
  const size = Number(attachment?.fileSize ?? attachment?.file_size);
  if (Number.isFinite(size) && size >= 0) details.append(makeElement(documentRef, 'span', 'document-size', `${Math.ceil(size / 1024)} KB`));
  card.append(icon, details);
  appendDownload(card, url, name, documentRef);
  return card;
}

/** Build a safe attachment element with native image/video and custom audio controls. */
export function createAttachmentElement(attachment, { document: documentRef = globalThis.document, baseUrl = browserBaseUrl(), onImageOpen } = {}) {
  const container = makeElement(documentRef, 'div', 'attachment message-attachment');
  const url = safeMessageUrl(attachmentUrl(attachment), baseUrl);
  const name = attachmentName(attachment);
  if (!url) {
    appendAttachmentError(container, documentRef, 'Adjunto no disponible.');
    return container;
  }
  const kind = getAttachmentKind(attachment);
  if (kind === 'image') {
    const button = makeElement(documentRef, 'button', 'media-image-button');
    button.type = 'button';
    button.setAttribute('aria-label', `Abrir imagen ${name}`);
    const image = makeElement(documentRef, 'img', 'attachment-image');
    image.src = url;
    image.alt = textValue(attachment?.alt || name);
    image.loading = 'lazy';
    image.decoding = 'async';
    addMediaError(image, container, documentRef);
    button.append(image);
    button.onclick = () => onImageOpen ? onImageOpen({ url, name, document: documentRef, opener: button }) : openImageViewer(url, name, documentRef, button);
    container.append(button);
  } else if (kind === 'video') {
    const video = makeElement(documentRef, 'video', 'attachment-video');
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.src = url;
    addMediaError(video, container, documentRef);
    container.append(video);
  } else if (kind === 'audio') {
    container.append(createAudioPlayer(url, name, container, documentRef));
  } else {
    container.append(createDocumentCard(attachment, url, name, documentRef));
  }
  const caption = textValue(attachment?.caption).trim();
  if (caption) {
    const captionElement = makeElement(documentRef, 'div', 'attachment-caption');
    appendRichText(captionElement, caption, documentRef);
    container.append(captionElement);
  }
  if (kind !== 'document') appendDownload(container, url, name, documentRef);
  return container;
}

function deliveryStatus(message) {
  const status = textValue(message?.status || message?.deliveryStatus).toLowerCase();
  if (status === 'sent') return { symbol: '\u2713', label: 'Enviado', className: 'status-sent' };
  if (status === 'delivered') return { symbol: '\u2713\u2713', label: 'Entregado', className: 'status-delivered' };
  if (['read', 'played'].includes(status)) return { symbol: '\u2713\u2713', label: status === 'played' ? 'Reproducido' : 'Leido', className: 'status-read' };
  return null;
}

function messageType(value) {
  return textValue(value).trim().toUpperCase();
}

function messageIcon(documentRef, kind) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = documentRef.createElementNS(namespace, 'svg');
  svg.setAttribute('class', 'message-kind-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const pathData of ICON_PATHS[kind]) {
    const path = documentRef.createElementNS(namespace, 'path');
    path.setAttribute('d', pathData);
    svg.append(path);
  }
  return svg;
}

function messageKindLine(documentRef, type, value, { unavailable = false } = {}) {
  const kind = MESSAGE_KINDS[messageType(type)];
  const line = makeElement(documentRef, 'span', 'message-kind-line');
  const label = unavailable ? 'Mensaje no disponible' : textValue(value).trim() || kind?.label || 'Mensaje no disponible';
  if (kind || unavailable || !textValue(value).trim()) line.append(messageIcon(documentRef, unavailable || !kind ? 'unavailable' : kind.icon));
  line.append(makeElement(documentRef, 'span', 'message-kind-label', label));
  return line;
}

function replyReference(message, documentRef) {
  const preview = message?.replyPreview;
  const available = preview?.available === true;
  const reference = makeElement(documentRef, 'div', 'message-reply-reference');
  const sender = textValue(preview?.senderName).trim();
  if (sender) reference.append(makeElement(documentRef, 'strong', 'message-reply-sender', sender));
  reference.append(messageKindLine(documentRef, available ? preview.type : null, available ? preview.text : '', { unavailable: !available }));
  return reference;
}

function messageRenderSignature(message) {
  const stable = {
    id: message?.id ?? null,
    text: message?.text ?? message?.content ?? '',
    fromMe: message?.fromMe === true,
    senderId: message?.senderId ?? null,
    senderName: message?.senderName ?? null,
    senderPushName: message?.senderPushName ?? null,
    timestamp: message?.timestamp ?? null,
    status: message?.status ?? message?.deliveryStatus ?? null,
    type: message?.type ?? null,
    metadata: message?.metadata ?? null,
    replyToMessageId: message?.replyToMessageId ?? null,
    replyPreview: message?.replyPreview ?? null,
    isEdited: message?.isEdited === true,
    reactions: message?.reactions ?? [],
    attachments: Array.isArray(message?.attachments) ? message.attachments : [],
    linkPreview: message?.linkPreview ?? null,
  };
  try { return JSON.stringify(stable); } catch { return ''; }
}

/** Render one message bubble; status ticks are omitted unless the API supplies a known status. */
function messageBubbleClass(message) {
  const classes = ['message', message?.fromMe === true ? 'from-me' : 'incoming'];
  if (message?.isFirstInGroup) classes.push('group-start');
  if (message?.isLastInGroup) classes.push('group-end');
  return classes.join(' ');
}

export function renderMessage(message, { document: documentRef = globalThis.document, showSenderNames = false } = {}) {
  const fromMe = message?.fromMe === true;
  const bubble = makeElement(documentRef, 'article', messageBubbleClass(message));
  if (message?.id != null) bubble.dataset.messageId = String(message.id);
  bubble.dataset.renderSignature = messageRenderSignature(message);
  bubble.setAttribute('aria-label', fromMe ? 'Mensaje enviado' : 'Mensaje recibido');
  if (!fromMe && showSenderNames && message?.senderName && message?.isFirstInGroup !== false) bubble.append(makeElement(documentRef, 'strong', 'message-sender', message.senderName));
  if (message?.replyToMessageId) bubble.append(replyReference(message, documentRef));
  const metadata = message?.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  if (metadata.kind === 'contact' && Array.isArray(metadata.contacts)) {
    const card = makeElement(documentRef, 'div', 'message-structured-card');
    card.append(makeElement(documentRef, 'strong', '', 'Contacto compartido'));
    for (const contact of metadata.contacts) card.append(makeElement(documentRef, 'span', '', [contact.displayName, contact.phone, contact.email].filter(Boolean).join(' · ')));
    bubble.append(card);
  } else if (metadata.kind === 'poll') {
    const card = makeElement(documentRef, 'div', 'message-poll-card');
    card.append(makeElement(documentRef, 'span', 'message-poll-label', 'Encuesta'));
    const question = textValue(message?.text ?? message?.content).trim();
    if (question) card.append(makeElement(documentRef, 'strong', 'message-poll-question', question));
    const results = metadata.results?.available === true ? metadata.results : null;
    const options = Array.isArray(metadata.options) ? metadata.options : [];
    for (const [index, answer] of options.entries()) {
      const option = makeElement(documentRef, results ? 'button' : 'span', 'message-poll-option');
      if (results) {
        option.type = 'button';
        option.dataset.pollOptionIndex = String(index);
        option.setAttribute('aria-pressed', 'false');
      }
      option.append(makeElement(documentRef, 'span', '', answer));
      const count = (Array.isArray(results?.options) ? results.options : []).find(item => item.name === answer)?.count;
      if (Number.isFinite(count)) option.append(makeElement(documentRef, 'span', 'message-poll-count', String(count)));
      card.append(option);
    }
    if (results) {
      const submit = makeElement(documentRef, 'button', 'message-poll-submit', 'Votar');
      submit.type = 'button';
      card.append(submit);
      card.append(makeElement(documentRef, 'small', 'message-poll-note', `${results.totalVoters || 0} votos registrados en esta copia`));
    } else card.append(makeElement(documentRef, 'small', 'message-poll-note', 'Votación no disponible en esta copia'));
    bubble.append(card);
  } else if (metadata.kind === 'event') {
    const card = makeElement(documentRef, 'div', 'message-structured-card');
    card.append(makeElement(documentRef, 'strong', '', metadata.isCancelled ? 'Evento cancelado' : 'Evento'));
    if (metadata.startTime) card.append(makeElement(documentRef, 'span', '', new Date(metadata.startTime < 1e12 ? metadata.startTime * 1000 : metadata.startTime).toLocaleString('es-ES')));
    if (metadata.description) card.append(makeElement(documentRef, 'span', '', metadata.description));
    if (metadata.location?.name) card.append(makeElement(documentRef, 'span', '', metadata.location.name));
    bubble.append(card);
  }
  const text = textValue(message?.text ?? message?.content);
  if (text && metadata.kind !== 'poll') {
    const textElement = makeElement(documentRef, 'div', 'message-text');
    appendRichText(textElement, text, documentRef);
    bubble.append(textElement);
  }
  const linkPreview = message?.linkPreview;
  const previewUrl = safeMessageUrl(linkPreview?.url);
  if (text && previewUrl) {
    const card = makeElement(documentRef, 'a', 'message-link-preview');
    card.href = previewUrl;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    if (typeof linkPreview.thumbnailUrl === 'string' && linkPreview.thumbnailUrl.startsWith('/api/media/link-thumb/')) {
      const image = makeElement(documentRef, 'img', 'message-link-preview-image');
      image.src = linkPreview.thumbnailUrl;
      image.alt = '';
      image.loading = 'lazy';
      card.append(image);
    }
    const details = makeElement(documentRef, 'span', 'message-link-preview-details');
    details.append(makeElement(documentRef, 'strong', 'message-link-preview-title', textValue(linkPreview.title).slice(0, 180)));
    if (linkPreview.description) details.append(makeElement(documentRef, 'span', 'message-link-preview-description', textValue(linkPreview.description).slice(0, 300)));
    details.append(makeElement(documentRef, 'span', 'message-link-preview-site', textValue(linkPreview.site).slice(0, 100)));
    card.append(details);
    bubble.insertBefore(card, bubble.querySelector('.message-text'));
  }
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  for (const attachment of attachments) {
    const shownAttachment = text.trim() && text.trim() === textValue(attachment?.caption).trim()
      ? { ...attachment, caption: '' }
      : attachment;
    bubble.append(createAttachmentElement(shownAttachment, { document: documentRef }));
  }
  if (!text && !attachments.length && !['contact', 'poll', 'event'].includes(metadata.kind)) bubble.append(messageKindLine(documentRef, message?.type, '', { unavailable: !MESSAGE_KINDS[messageType(message?.type)] }));
  const meta = makeElement(documentRef, 'div', 'message-meta');
  const time = formatMessageTime(message?.timestamp);
  if (time) {
    const timeElement = makeElement(documentRef, 'time', 'message-time', time);
    const date = parseTimestamp(message?.timestamp);
    if (date) timeElement.dateTime = date.toISOString();
    meta.append(timeElement);
  }
  if (message?.isEdited === true) meta.append(makeElement(documentRef, 'span', 'message-edited', 'Editado'));
  if (fromMe) {
    const status = deliveryStatus(message);
    if (status) {
      const statusElement = makeElement(documentRef, 'span', `message-status ${status.className}`, status.symbol);
      statusElement.setAttribute('aria-label', status.label);
      meta.append(statusElement);
    }
  }
  if (meta.childNodes?.length || meta.children?.length) bubble.append(meta);
  return bubble;
}

/** Render a complete message list, including date chips and grouping metadata. */
export function renderMessageList(messages, { document: documentRef = globalThis.document, now = new Date(), showSenderNames = false } = {}) {
  const fragment = documentRef.createDocumentFragment();
  const decorated = decorateMessages(messages, { now });
  for (const message of decorated) {
    if (message.showDateSeparator) {
      const separator = makeElement(documentRef, 'div', 'message-date');
      separator.append(makeElement(documentRef, 'span', 'message-date-label', message.dateLabel));
      fragment.append(separator);
    }
    fragment.append(renderMessage(message, { document: documentRef, showSenderNames }));
  }
  return { fragment, messages: decorated };
}

function hasClass(element, className) {
  return textValue(element?.className).split(/\s+/).includes(className);
}

function dateSeparator(documentRef, label) {
  const separator = makeElement(documentRef, 'div', 'message-date');
  separator.append(makeElement(documentRef, 'span', 'message-date-label', label));
  return separator;
}

function syncSenderHeader(bubble, message, showSenderNames, documentRef) {
  const sender = bubble.querySelector?.('.message-sender');
  const senderName = textValue(message?.senderName).trim();
  const shouldShow = message?.fromMe !== true && showSenderNames === true && senderName && message?.isFirstInGroup !== false;
  if (!shouldShow) {
    sender?.remove?.();
    return;
  }
  if (sender) {
    sender.textContent = senderName;
    return;
  }
  bubble.insertBefore(makeElement(documentRef, 'strong', 'message-sender', senderName), bubble.children?.[0] || null);
}

/** Reconcile message children in place so unchanged media never leaves its parent. */
export function reconcileMessageList(container, messages, options = {}) {
  const documentRef = options.document || container?.ownerDocument || globalThis.document;
  if (!container || !documentRef) return { fragment: null, messages: [] };
  const decorated = decorateMessages(messages, { now: options.now || new Date() });
  const desiredById = new Map();
  for (const message of decorated) {
    if (message.id != null) desiredById.set(String(message.id), message);
  }
  const existing = new Map();
  for (const child of [...container.children || []]) {
    const id = child.dataset?.messageId;
    const desiredMessage = hasClass(child, 'message') && id != null ? desiredById.get(String(id)) : null;
    if (!desiredMessage || existing.has(String(id)) || child.dataset?.renderSignature !== messageRenderSignature(desiredMessage)) {
      child.remove?.();
      continue;
    }
    existing.set(String(id), child);
  }
  const desired = [];
  for (const message of decorated) {
    if (message.showDateSeparator) desired.push({ type: 'date', label: message.dateLabel });
    desired.push({ type: 'message', message });
  }
  let cursor = 0;
  for (const entry of desired) {
    const reference = container.children?.[cursor] || null;
    if (entry.type === 'date') {
      if (reference && hasClass(reference, 'message-date') && reference.textContent === entry.label) cursor += 1;
      else {
        container.insertBefore(dateSeparator(documentRef, entry.label), reference);
        cursor += 1;
      }
      continue;
    }
    const message = entry.message;
    const previous = message.id == null ? null : existing.get(String(message.id));
    if (previous && previous.dataset.renderSignature === messageRenderSignature(message)) {
      previous.className = messageBubbleClass(message);
      previous.setAttribute('aria-label', message.fromMe === true ? 'Mensaje enviado' : 'Mensaje recibido');
      syncSenderHeader(previous, message, options.showSenderNames === true, documentRef);
      if (container.children?.[cursor] !== previous) container.insertBefore(previous, reference);
    } else {
      container.insertBefore(renderMessage(message, { document: documentRef, showSenderNames: options.showSenderNames === true }), reference);
    }
    cursor += 1;
  }
  while ((container.children?.length || 0) > cursor) container.children[cursor]?.remove?.();
  return { fragment: null, messages: decorated };
}
