import { readUploadQualityPreference, writeUploadQualityPreference } from './composer-attachment.mjs';

export function installUploadQualityUI(documentRef = document, storage = globalThis.localStorage) {
  const account = documentRef.getElementById('account');
  const downloadSection = documentRef.getElementById('settings-download-title')?.parentElement;
  if (!account || !downloadSection) return null;

  const section = documentRef.createElement('section');
  section.className = 'settings-section';
  section.setAttribute('aria-labelledby', 'settings-upload-quality-title');
  const heading = documentRef.createElement('h3');
  heading.id = 'settings-upload-quality-title';
  heading.textContent = 'Calidad de subida';
  const label = documentRef.createElement('label');
  label.className = 'settings-field';
  label.textContent = 'Fotos';
  const select = documentRef.createElement('select');
  select.id = 'settings-upload-quality';
  select.setAttribute('aria-label', 'Calidad de subida de fotos');
  for (const [value, text] of [['standard', 'Estándar'], ['hd', 'HD']]) {
    const option = documentRef.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  const hint = documentRef.createElement('small');
  hint.textContent = 'Las fotos se preparan con esta calidad antes de enviarlas. Vídeos y documentos conservan su archivo original.';
  label.append(select, hint);
  section.append(heading, label);
  downloadSection.before(section);

  const accountChanged = () => { select.value = readUploadQualityPreference(storage, account.value); };
  select.addEventListener('change', () => {
    if (!writeUploadQualityPreference(storage, account.value, select.value)) accountChanged();
  });
  account.addEventListener('change', accountChanged);
  accountChanged();
  return {accountChanged};
}
