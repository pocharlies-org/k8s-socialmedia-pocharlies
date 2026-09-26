import { createHash, timingSafeEqual, createHmac } from 'node:crypto';
export const fail = (status, message) => Object.assign(new Error(message), { status });
export function authenticate(header, env) {
  if (!env.UI_AUTH_USERNAME || !env.UI_AUTH_PASSWORD) return false;
  const expected = `Basic ${Buffer.from(`${env.UI_AUTH_USERNAME}:${env.UI_AUTH_PASSWORD}`).toString('base64')}`;
  const hash = value => createHash('sha256').update(value || '').digest();
  return timingSafeEqual(hash(header), hash(expected));
}
export function checkOrigin(req, env) {
  if (!env.APP_PUBLIC_URL || req.headers.origin !== new URL(env.APP_PUBLIC_URL).origin) throw fail(403, 'Invalid request origin');
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw fail(415, 'JSON required');
}
export const sendingEnabled = env => env.APP_ENABLE_SENDING === 'true' && env.EMERGENCY_DISABLE_SENDING !== 'true';
export function signedHeaders(body, secret) {
  if (!secret) throw fail(503, 'Connector credentials unavailable');
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { 'content-type': 'application/json', 'x-connector-timestamp': timestamp,
    'x-connector-signature': `sha256=${createHmac('sha256', secret).update(`${timestamp}:${JSON.stringify(body)}`).digest('hex')}` };
}
export function required(value, name, max = 1024) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(400, `Invalid ${name}`);
  return value;
}
export function uploadBytes(body) {
  required(body.name, 'filename', 255);
  if (/[\x00-\x1f/\\]/.test(body.name)) throw fail(400, 'Invalid filename');
  const mediaType = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime)|audio\/(ogg|webm|mpeg|mp4|wav|x-wav))(;\s*codecs=[\w-]+)?$/;
  const documents = {
    'application/pdf': '.pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'application/zip': '.zip',
    'application/x-zip-compressed': '.zip',
    'text/plain': '.txt',
  };
  const extension = documents[body.mimeType];
  if (!mediaType.test(body.mimeType || '') && !extension) throw fail(400, 'Unsupported media type');
  if (extension && !body.name.toLowerCase().endsWith(extension)) throw fail(400, 'Filename does not match media type');
  const data = required(body.data, 'base64 data', 16 * 1024 * 1024);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw fail(400, 'Invalid base64');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw fail(413, 'Upload too large');
  if (extension === '.pdf' && bytes.subarray(0, 5).toString() !== '%PDF-') throw fail(400, 'Invalid PDF');
  if (['.docx', '.xlsx', '.pptx', '.zip'].includes(extension) &&
      !['504b0304', '504b0506', '504b0708'].includes(bytes.subarray(0, 4).toString('hex'))) throw fail(400, 'Invalid ZIP document');
  if (extension === '.txt') {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0') || /^\s*(?:<!doctype\s+html|<html\b|<script\b|<svg\b)/i.test(text)) throw Error();
    } catch { throw fail(400, 'Invalid text document'); }
  }
  if (body.voice && !body.mimeType.startsWith('audio/')) throw fail(400, 'Voice requires audio');
  return bytes;
}
