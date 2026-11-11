const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const MAP_HOSTS = new Set(['maps.app.goo.gl', 'maps.google.com', 'www.google.com', 'google.com']);

function cleanUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value.replace(/[.,!?;:]+$/, ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch { return null; }
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

export function linkPreviewFromPayload(text, payload) {
  const urls = [...String(text || '').matchAll(URL_PATTERN)].map(match => cleanUrl(match[0])).filter(Boolean);
  if (!urls.length) return null;
  const ext = payload?.extendedTextMessage;
  const matched = cleanUrl(ext?.matchedText);
  const providerUrl = cleanUrl(ext?.canonicalUrl);
  // The saved preview must describe a URL actually present in the message.
  const providerMatch = urls.find(url => url.href === matched?.href) || urls.find(url => url.href === providerUrl?.href);
  const url = providerMatch || urls[0];
  const trusted = Boolean(providerMatch);
  const isMaps = MAP_HOSTS.has(url.hostname.toLowerCase()) &&
    (url.hostname.toLowerCase() === 'maps.app.goo.gl' || /\/maps(?:\/|$)/.test(url.pathname));
  const title = trusted ? cleanText(ext?.title, 180) : '';
  const description = trusted ? cleanText(ext?.description, 300) : '';
  return {
    url: url.href,
    site: isMaps ? 'Google Maps' : url.hostname.replace(/^www\./, ''),
    title: title || (isMaps ? 'Google Maps' : url.hostname.replace(/^www\./, '')),
    description,
    hasThumbnail: trusted && ext?.jpegThumbnail != null,
  };
}
