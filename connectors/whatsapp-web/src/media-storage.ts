/**
 * S3-compatible uploader for WhatsApp media. New writes go to the shared
 * skirmshop-drive bucket; raw legacy keys are still read from the old MinIO.
 * Object keys follow `socialmedia/attachments/{messageId}/{ts}.{ext}`.
 *
 * On startup the connector calls `ensureMediaBucket()` to make idempotent the bucket
 * existence check (cheap — single statObject call).
 */
import * as MinIO from 'minio';
import * as fs from 'fs';
import * as https from 'https';

const MINIO_ENDPOINT = process.env.S3_ENDPOINT || process.env.MINIO_ENDPOINT || 'minio:9000';
const MINIO_ACCESS_KEY =
  process.env.AWS_ACCESS_KEY_ID || process.env.MINIO_ACCESS_KEY || 'minioadmin';
const MINIO_SECRET_KEY =
  process.env.AWS_SECRET_ACCESS_KEY || process.env.MINIO_SECRET_KEY || 'minioadmin';
const MINIO_USE_SSL =
  (process.env.S3_USE_SSL || process.env.MINIO_USE_SSL || 'true').toLowerCase() === 'true';
const MINIO_CA_CERT = process.env.MINIO_CA_CERT;
const BUCKET = process.env.S3_BUCKET || process.env.MINIO_BUCKET || 'socialmedia-media';
const PREFIX = (process.env.S3_PREFIX || '').replace(/^\/+|\/+$/g, '');
const LEGACY_MINIO_ENDPOINT =
  process.env.LEGACY_MINIO_ENDPOINT || process.env.MINIO_ENDPOINT || MINIO_ENDPOINT;
const LEGACY_MINIO_ACCESS_KEY =
  process.env.LEGACY_MINIO_ACCESS_KEY || process.env.MINIO_ACCESS_KEY || MINIO_ACCESS_KEY;
const LEGACY_MINIO_SECRET_KEY =
  process.env.LEGACY_MINIO_SECRET_KEY || process.env.MINIO_SECRET_KEY || MINIO_SECRET_KEY;
const LEGACY_MINIO_USE_SSL =
  (process.env.LEGACY_MINIO_USE_SSL || process.env.MINIO_USE_SSL || 'true').toLowerCase() ===
  'true';
const LEGACY_BUCKET =
  process.env.LEGACY_MINIO_BUCKET || process.env.MINIO_BUCKET || 'socialmedia-media';
// Out-of-cluster S3 endpoint (e.g. the Traefik LAN IngressRoute
// https://skirmshop-s3.lan.e-dani.com). Used ONLY to presign GET URLs that
// consumers outside the cluster (synapse adapters on sauvage) can fetch —
// presigned URLs embed the signed host, so the in-cluster svc endpoint would
// produce URLs that never resolve out there. Unset ⇒ presigning disabled.
const S3_PUBLIC_ENDPOINT = process.env.S3_PUBLIC_ENDPOINT || '';
const S3_PRESIGN_EXPIRY_SECONDS = parseInt(process.env.S3_PRESIGN_EXPIRY_SECONDS || '3600', 10);

function endpointParts(
  endpoint: string,
  fallbackSsl: boolean
): { host: string; port: number; useSSL: boolean } {
  const withScheme = /^https?:\/\//i.test(endpoint)
    ? endpoint
    : `${fallbackSsl ? 'https' : 'http'}://${endpoint}`;
  const parsed = new URL(withScheme);
  return {
    host: parsed.hostname,
    port: parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 9000,
    useSSL: parsed.protocol === 'https:',
  };
}

function clientFor(
  endpoint: string,
  accessKey: string,
  secretKey: string,
  useSSL: boolean
): MinIO.Client {
  const parts = endpointParts(endpoint, useSSL);
  const opts: MinIO.ClientOptions = {
    endPoint: parts.host,
    port: parts.port,
    useSSL: parts.useSSL,
    accessKey,
    secretKey,
  };
  if (parts.useSSL && MINIO_CA_CERT && fs.existsSync(MINIO_CA_CERT)) {
    const ca = fs.readFileSync(MINIO_CA_CERT, 'utf-8');
    opts.transportAgent = new https.Agent({ ca, rejectUnauthorized: true });
  }
  return new MinIO.Client(opts);
}

const client = clientFor(MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_USE_SSL);
const legacyClient = clientFor(
  LEGACY_MINIO_ENDPOINT,
  LEGACY_MINIO_ACCESS_KEY,
  LEGACY_MINIO_SECRET_KEY,
  LEGACY_MINIO_USE_SSL
);
// Same credentials as `client`, different (publicly reachable) signed host.
const publicClient = S3_PUBLIC_ENDPOINT
  ? clientFor(S3_PUBLIC_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_USE_SSL)
  : null;

function withPrefix(key: string): string {
  const clean = key.replace(/^\/+/, '');
  return PREFIX ? `${PREFIX}/${clean}` : clean;
}

export function parseStorageRef(ref: string): { bucket: string; key: string; legacy: boolean } {
  if (ref.startsWith('s3://')) {
    const parsed = new URL(ref);
    return { bucket: parsed.hostname, key: parsed.pathname.slice(1), legacy: false };
  }
  return { bucket: LEGACY_BUCKET, key: ref, legacy: true };
}

function s3Uri(key: string): string {
  return `s3://${BUCKET}/${key}`;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
};

function pickExt(mimeType: string | undefined, fileName: string | undefined): string {
  if (fileName && fileName.includes('.')) {
    return fileName.split('.').pop()!.slice(0, 6);
  }
  if (mimeType && EXT_BY_MIME[mimeType]) return EXT_BY_MIME[mimeType];
  if (mimeType?.startsWith('image/')) return 'bin';
  return 'bin';
}

export async function ensureMediaBucket(): Promise<void> {
  const exists = await client.bucketExists(BUCKET).catch(() => false);
  if (!exists) {
    await client.makeBucket(BUCKET, 'us-east-1');
  }
}

export interface UploadedMedia {
  storageKey: string;
  fileSize: number;
}

export async function uploadMedia(
  messageId: bigint | number,
  data: Buffer,
  mimeType: string | undefined,
  fileName: string | undefined
): Promise<UploadedMedia> {
  const ts = Date.now();
  const ext = pickExt(mimeType, fileName);
  const storageKey = withPrefix(`attachments/${messageId}/${ts}.${ext}`);
  const meta: Record<string, string> = {};
  if (mimeType) meta['Content-Type'] = mimeType;
  if (fileName) meta['x-amz-meta-filename'] = fileName;
  await client.putObject(BUCKET, storageKey, data, data.length, meta);
  return { storageKey: s3Uri(storageKey), fileSize: data.length };
}

/** Configured presign expiry (seconds); ridden as attachment metadata. */
export function presignExpirySeconds(): number {
  return S3_PRESIGN_EXPIRY_SECONDS;
}

/**
 * Presigned GET URL for a stored object, signed against S3_PUBLIC_ENDPOINT so
 * consumers OUTSIDE the cluster (synapse adapters on sauvage) can fetch it
 * without credentials or headers (auth rides in the query string).
 *
 * Returns null when presigning is unavailable: no public endpoint configured,
 * or the ref points at the legacy MinIO (which has no out-of-cluster
 * exposure). Presigning is a local signature computation — no network call.
 */
export async function presignMediaUrl(
  storageKey: string,
  expirySeconds: number = S3_PRESIGN_EXPIRY_SECONDS
): Promise<string | null> {
  if (!publicClient) return null;
  const ref = parseStorageRef(storageKey);
  if (ref.legacy) return null;
  return publicClient.presignedGetObject(ref.bucket, ref.key, expirySeconds);
}

/** Fetch a stored object from MinIO by its storage key, as a Buffer. */
export async function fetchMedia(storageKey: string): Promise<Buffer> {
  const ref = parseStorageRef(storageKey);
  const source = ref.legacy ? legacyClient : client;
  const stream = await source.getObject(ref.bucket, ref.key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Upload a profile picture under avatars/{kind}/{base64url(id)}.jpg.
 * Returns the storage key so the caller can save it into
 * conversations.avatar_url / participants.profile_pic_url.
 */
export async function uploadAvatar(
  kind: 'conversations' | 'participants',
  ident: string,
  data: Buffer
): Promise<string> {
  await ensureMediaBucket();
  const safe = Buffer.from(ident).toString('base64url');
  const storageKey = withPrefix(`avatars/${kind}/${safe}.jpg`);
  await client.putObject(BUCKET, storageKey, data, data.length, {
    'Content-Type': 'image/jpeg',
  });
  return s3Uri(storageKey);
}
