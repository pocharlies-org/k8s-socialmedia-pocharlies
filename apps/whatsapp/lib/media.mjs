import { createHash, createHmac } from 'node:crypto';
import { fail } from './security.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');
const hmac = (key, text) => createHmac('sha256', key).update(text).digest();
export function mediaRequest(ref, env) {
  if (!ref) throw fail(404, 'Media unavailable');
  if (/^https?:\/\//.test(ref)) {
    const url = new URL(ref);
    const origins = (env.MEDIA_ALLOWED_ORIGINS || '').split(',').filter(Boolean).map(x => new URL(x.trim()).origin);
    if (url.username || url.password || !origins.includes(url.origin)) throw fail(403, 'Media origin is not allowed');
    return { url: url.href, headers: {} };
  }
  const endpoint = env.S3_ENDPOINT || env.MINIO_ENDPOINT;
  const access = env.AWS_ACCESS_KEY_ID || env.MINIO_ACCESS_KEY;
  const secret = env.AWS_SECRET_ACCESS_KEY || env.MINIO_SECRET_KEY;
  if (!endpoint || !access || !secret) throw fail(503, 'Media storage is not configured');
  const s3 = ref.startsWith('s3://') ? new URL(ref) : null;
  const bucket = s3?.hostname || env.MINIO_BUCKET || 'socialmedia-media';
  const allowed = (env.MEDIA_ALLOWED_BUCKETS || env.S3_BUCKET || env.MINIO_BUCKET || 'socialmedia-media').split(',');
  if (!allowed.includes(bucket)) throw fail(403, 'Media bucket is not allowed');
  const key = s3 ? decodeURIComponent(s3.pathname.slice(1)) : ref;
  if (key.split('/').some(p => p === '..' || p === '.') || /[\x00-\x1f\\]/.test(key)) throw fail(403, 'Invalid media reference');
  const base = endpoint.includes('://') ? endpoint : `${(env.S3_USE_SSL || env.MINIO_USE_SSL) === 'false' ? 'http' : 'https'}://${endpoint}`;
  const url = new URL(base);
  url.pathname = `/${[bucket, ...key.split('/')].map(p => encodeURIComponent(p).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')}`;
  url.search = '';
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const region = env.AWS_REGION || 'us-east-1'; const scope = `${date.slice(0, 8)}/${region}/s3/aws4_request`;
  const payload = hash('');
  const canonical = `GET\n${url.pathname}\n\nhost:${url.host}\nx-amz-content-sha256:${payload}\nx-amz-date:${date}\n\nhost;x-amz-content-sha256;x-amz-date\n${payload}`;
  const signing = hmac(hmac(hmac(hmac(`AWS4${secret}`, date.slice(0, 8)), region), 's3'), 'aws4_request');
  return { url: url.href, headers: { 'x-amz-date': date, 'x-amz-content-sha256': payload,
    authorization: `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${createHmac('sha256', signing).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).digest('hex')}` } };
}
