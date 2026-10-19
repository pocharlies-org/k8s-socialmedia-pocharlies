export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MEDIA_MIME = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime)|audio\/(ogg|webm|mpeg|mp4|wav|x-wav))(;\s*codecs=(?:[\w.-]+(?:,\s*[\w.-]+)*|"[\w.-]+(?:,\s*[\w.-]+)*"))?$/;
const DOCUMENT_EXTENSIONS = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'text/plain': '.txt',
};
export const UPLOAD_QUALITY_KEY = 'wa-media-upload-quality';

function savedUploadQualities(storage) {
  try {
    const saved = JSON.parse(storage?.getItem(UPLOAD_QUALITY_KEY) || '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch { return {}; }
}

export function readUploadQualityPreference(storage, accountId) {
  return savedUploadQualities(storage)[accountId] === 'hd' ? 'hd' : 'standard';
}

export function writeUploadQualityPreference(storage, accountId, quality) {
  if (!accountId || !['standard', 'hd'].includes(quality)) return false;
  const saved = {...savedUploadQualities(storage), [accountId]: quality};
  try { storage?.setItem(UPLOAD_QUALITY_KEY, JSON.stringify(saved)); return true; }
  catch { return false; }
}

export function readUploadQuality(storage, accountId, file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file?.type || '')) return 'source';
  return readUploadQualityPreference(storage, accountId);
}

export function canViewOnce(file) {
  return /^(image\/(jpeg|png|webp)|video\/(mp4|webm|quicktime))$/.test(file?.type || '');
}

function attachmentName(file) {
  if (file.name) return file.name;
  const imageExtension = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[file.type];
  return imageExtension ? `imagen${imageExtension}` : '';
}

export function filesFromClipboard(clipboardData) {
  const items = Array.from(clipboardData?.items || []);
  const files = items.filter(item => item.kind === 'file').map(item => item.getAsFile?.()).filter(Boolean);
  return files.length ? files : Array.from(clipboardData?.files || []);
}

export function attachmentError(file) {
  if (!file) return 'No se encontró ningún archivo.';
  const extension = DOCUMENT_EXTENSIONS[file.type];
  if (!MEDIA_MIME.test(file.type || '') && !extension) return 'Este tipo de archivo no se puede enviar.';
  const name = attachmentName(file);
  if (!name || name.length > 255 || /[\x00-\x1f/\\]/.test(name) || (extension && !name.toLowerCase().endsWith(extension))) return 'El nombre del archivo no coincide con su tipo.';
  if (!file.size) return 'El archivo está vacío.';
  if (file.size > MAX_ATTACHMENT_BYTES) return 'El archivo supera el límite de 10 MiB.';
  return '';
}

export function attachmentCaptionError(file, caption) {
  return file?.type?.startsWith('audio/') && caption.trim()
    ? 'WhatsApp no admite texto junto a un audio. Quita el texto o elige otro archivo.'
    : '';
}

export function uploadPayload(file, data, caption = '', replyToMessageId = '', quality = 'source', viewOnce = false) {
  return {
    name: attachmentName(file),
    mimeType: file.type || 'application/octet-stream',
    data,
    voice: false,
    caption: caption.trim(),
    ...(quality !== 'source' ? { quality } : {}),
    ...(viewOnce ? { viewOnce: true } : {}),
    ...(replyToMessageId ? { replyToMessageId } : {}),
  };
}
