// UX #45.2: la inicial de un avatar es un grapheme completo. Una bandera son dos
// indicadores regionales (dos code points): cortar por code point deja huérfanos.
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('es', {granularity: 'grapheme'}) : null;

export function graphemesOf(value) {
  const text = String(value ?? '');
  return segmenter ? [...segmenter.segment(text)].map(grapheme => grapheme.segment) : [...text];
}

export function firstGrapheme(value) {
  return graphemesOf(String(value ?? '').trim())[0] || '';
}

export function initialsOf(label, fallback = '') {
  const parts = String(label ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return fallback;
  if (parts.length > 1) return (graphemesOf(parts[0])[0] + graphemesOf(parts[1])[0]).toLocaleUpperCase();
  return graphemesOf(parts[0]).slice(0, 2).join('').toLocaleUpperCase();
}
