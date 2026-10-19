import { fail, required, signedHeaders } from './security.mjs';

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const ERROR_STATUSES = [400, 403, 404, 409, 413, 429, 501, 502, 503, 504];
const KINDS = new Set(['text', 'image', 'video', 'audio', 'sticker', 'document', 'poll', 'event', 'unknown']);
const authorPattern = /^\d+(?::\d+)?@(?:s\.whatsapp\.net|c\.us|lid)$/;
const channelPattern = /^\d+@newsletter$/;
const invalid = () => fail(502, 'Invalid WhatsApp Novedades response');
const string = (value, max = 4096) => typeof value === 'string' ? value.slice(0, max) : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const boolean = value => typeof value === 'boolean' ? value : null;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
// Status identity watermarks arrive as microsecond UTC strings and are forwarded
// verbatim: `date()` would rebuild them through a millisecond Date, collapsing
// the microseconds a client needs to tell two statuses posted in the same second
// apart when their provider ids sort backwards. Anything but a canonical UTC
// timestamp (including a pre-watermark connector) projects as null.
const watermark = value =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)
    ? value
    : null;

function jid(value, pattern) {
  if (typeof value !== 'string' || value.length > 256 || !pattern.test(value)) throw fail(400, 'Invalid Novedades identity');
  return value;
}

export function novedadesRequest(path, params) {
  const target = new URLSearchParams();
  let kind;
  let scope = null;
  let endpoint;
  const allowed = new Set(['account']);
  if (path === '/api/novedades/status/authors') {
    kind = 'authors'; endpoint = '/novedades/status/authors';
  } else if (path === '/api/novedades/status') {
    kind = 'status'; endpoint = '/novedades/status'; allowed.add('author');
    scope = jid(params.get('author'), authorPattern); target.set('author', scope);
  } else if (path === '/api/novedades/channels') {
    kind = 'channels'; endpoint = '/novedades/channels';
  } else if (path === '/api/novedades/channels/lookup') {
    kind = 'lookup'; endpoint = '/novedades/channels/lookup'; allowed.add('query');
    const query = required(params.get('query'), 'query', 512).trim();
    if (!query || /[\x00-\x1f]/.test(query)) throw fail(400, 'Invalid channel query');
    target.set('query', query);
  } else if (/^\/api\/novedades\/channels\/[^/]+\/posts$/.test(path)) {
    kind = 'posts';
    try { scope = jid(decodeURIComponent(path.split('/')[4]), channelPattern); } catch { throw fail(400, 'Invalid channel'); }
    endpoint = `/novedades/channels/${encodeURIComponent(scope)}/posts`;
  } else if (path === '/api/novedades/media') {
    kind = 'media'; endpoint = '/novedades/media';
    for (const key of ['kind', 'jid', 'messageId']) allowed.add(key);
    const mediaKind = params.get('kind');
    if (!['channel', 'status', 'avatar'].includes(mediaKind)) throw fail(400, 'Invalid media kind');
    scope = jid(params.get('jid'), mediaKind === 'status' ? authorPattern : channelPattern);
    target.set('kind', mediaKind); target.set('jid', scope);
    if (mediaKind === 'avatar') {
      allowed.delete('messageId');
    } else {
      const id = required(params.get('messageId'), 'messageId', 512);
      if (/[\x00-\x1f]/.test(id)) throw fail(400, 'Invalid messageId');
      target.set('messageId', id);
    }
  } else throw fail(404, 'Novedades route not found');
  if (['channels', 'posts', 'status'].includes(kind)) {
    allowed.add('limit'); allowed.add('cursor');
    if (params.has('limit')) {
      const value = params.get('limit');
      if (!/^[1-9]\d*$/.test(value) || Number(value) > 100) throw fail(400, 'Invalid page limit');
      target.set('limit', value);
    }
    if (params.has('cursor')) {
      const value = params.get('cursor');
      if (!value || value.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(value)) throw fail(400, 'Invalid cursor');
      target.set('cursor', value);
    }
  }
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) throw fail(400, 'Invalid Novedades parameter');
  }
  return { kind, scope, endpoint: endpoint + (target.size ? `?${target}` : '') };
}

function page(source) {
  if (typeof source.hasMore !== 'boolean' || (source.hasMore && (typeof source.nextCursor !== 'string' || !source.nextCursor))) throw invalid();
  if (source.hasMore && (source.nextCursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(source.nextCursor))) throw invalid();
  return { limit: number(source.limit), hasMore: source.hasMore, nextCursor: source.hasMore ? source.nextCursor : null, overlapPossible: source.overlapPossible === true };
}

export function projectNovedadesChannel(source, account) {
  if (!source || typeof source.id !== 'string' || source.id.length > 256 || !channelPattern.test(source.id)) throw invalid();
  return {
    id: source.id, name: string(source.name, 1024), description: string(source.description, 16384),
    role: string(source.role, 64), subscribed: boolean(source.subscribed), verification: string(source.verification, 64),
    subscribers: number(source.subscribers), createdAt: date(source.createdAt), muted: boolean(source.muted),
    avatarAvailable: source.avatarAvailable === true, latestTimestamp: date(source.latestTimestamp),
    avatarUrl: source.avatarAvailable === true ? `/api/novedades/media?${new URLSearchParams({ account, kind: 'avatar', jid: source.id })}` : null,
  };
}

function item(source, request, account) {
  if (!source || typeof source.id !== 'string' || !source.id || source.id.length > 512) throw invalid();
  if (request.kind === 'status' && source.author !== request.scope) throw invalid();
  const result = {
    id: source.id, text: string(source.text, 65536), kind: KINDS.has(source.kind) ? source.kind : 'unknown',
    timestamp: date(source.timestamp), timestampMs: number(source.timestampMs),
    mimeType: string(source.mimeType, 128), mediaKind: string(source.mediaKind, 32),
    mediaSizeBytes: number(source.mediaSizeBytes), mediaFileName: string(source.mediaFileName, 255),
    mediaDurationSeconds: number(source.mediaDurationSeconds), deleted: source.deleted === true,
    mediaUrl: null,
  };
  // Rebuild the authenticated URL from this request's scope; never forward a
  // connector-supplied URL, even if it happens to look like a local path.
  if (typeof source.mediaUrl === 'string' && source.mediaUrl) {
    result.mediaUrl = `/api/novedades/media?${new URLSearchParams({ account, kind: request.kind === 'status' ? 'status' : 'channel', jid: request.scope, messageId: source.id })}`;
  }
  if (request.kind === 'status') Object.assign(result, {
    author: request.scope, expiresAt: date(source.expiresAt), remainingMs: number(source.remainingMs),
    active: source.active === true, freshnessUnknown: source.freshnessUnknown === true, seenAt: date(source.seenAt),
  });
  return result;
}

function project(source, request, account) {
  if (request.kind === 'lookup') {
    return { account, channel: source.channel ? projectNovedadesChannel(source.channel, account) : null };
  }
  const coverage = source.coverage || {};
  const base = { account, ...page(source), coverage: {
    source: 'local-store', remoteListing: false, backfilled: false, syncedAt: date(coverage.syncedAt),
    mediaDownloadsWired: coverage.mediaDownloadsWired === true,
  } };
  if (request.kind === 'authors') {
    if (!Array.isArray(source.authors)) throw invalid();
    return { ...base, authors: source.authors.map(author => {
      if (!author || typeof author.id !== 'string' || author.id.length > 256 || !authorPattern.test(author.id)) throw invalid();
      return { id: author.id, name: string(author.name, 1024), own: author.own === true, count: number(author.count), total: number(author.total), unseen: number(author.unseen), latestTimestamp: date(author.latestTimestamp), latestStatusId: string(author.latestStatusId, 512), latestReceivedAt: watermark(author.latestReceivedAt) };
    }) };
  }
  if (request.kind === 'channels') {
    if (!Array.isArray(source.channels)) throw invalid();
    return { ...base, channels: source.channels.map(value => projectNovedadesChannel(value, account)) };
  }
  if (!Array.isArray(source.items)) throw invalid();
  const result = { ...base, items: source.items.map(value => item(value, request, account)), serverTime: date(source.serverTime) };
  if (request.kind === 'posts') {
    result.channel = source.channel ? projectNovedadesChannel(source.channel, account) : null;
    if (result.channel && result.channel.id !== request.scope) throw invalid();
  }
  return result;
}

function media(source) {
  const data = source.data;
  if (!data || typeof data.base64 !== 'string' || !data.base64) throw invalid();
  if (data.base64.length > 4 * Math.ceil(MAX_MEDIA_BYTES / 3)) throw fail(413, 'Novedades media is too large');
  const bytes = Buffer.from(data.base64, 'base64');
  if (!bytes.length || bytes.length !== data.size || bytes.length > MAX_MEDIA_BYTES || bytes.toString('base64') !== data.base64) throw invalid();
  const mimeType = string(data.mimeType, 128)?.split(';')[0].trim().toLowerCase();
  const inline = /^(?:image\/(?:jpeg|png|webp|gif)|video\/(?:mp4|webm|quicktime)|audio\/(?:ogg|mpeg|mp4|webm|wav))$/.test(mimeType || '');
  return { bytes, mimeType: inline ? mimeType : 'application/octet-stream', inline, fileName: string(data.fileName, 255) || 'attachment' };
}

async function boundedJson(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw fail(502, 'WhatsApp Novedades response is too large');
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body || []) {
      size += chunk.byteLength;
      if (size > maxBytes) throw fail(502, 'WhatsApp Novedades response is too large');
      chunks.push(Buffer.from(chunk));
    }
    try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
    catch { if (!response.ok) return null; throw invalid(); }
  } catch (error) {
    if (error.status) throw error;
    throw invalid();
  }
}

export async function readNovedades({ account, path, params, remote, secret }) {
  const request = novedadesRequest(path, params);
  const response = await remote(`${account.connectorUrl.replace(/\/$/, '')}/api/v1${request.endpoint}`, {
    method: 'GET', headers: signedHeaders({}, secret),
  }, 30000, ERROR_STATUSES);
  const source = await boundedJson(response, request.kind === 'media' ? 36 * 1024 * 1024 : 16 * 1024 * 1024);
  if (!response.ok) {
    const error = fail(ERROR_STATUSES.includes(response.status) ? response.status : 502, 'No se pudieron cargar las novedades de WhatsApp');
    error.code = string(source?.error?.code, 64) || 'NOVEDADES_UNAVAILABLE';
    throw error;
  }
  if (source?.ok !== true || source.account !== account.accountId) throw invalid();
  return request.kind === 'media' ? { media: media(source) } : { data: project(source, request, account.accountId) };
}

export function novedadesMediaResponse(media, range) {
  const size = media.bytes.length;
  const headers = {
    'content-type': media.mimeType, 'accept-ranges': 'bytes',
    'content-disposition': `${media.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(Buffer.from(media.fileName).toString('utf8')).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
  };
  if (!range) return { status: 200, headers: { ...headers, 'content-length': size }, bytes: media.bytes };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) throw fail(400, 'Invalid byte range');
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ([first, last].some(value => value !== null && !Number.isSafeInteger(value))) throw fail(400, 'Invalid byte range');
  const start = first === null ? Math.max(0, size - last) : first;
  const end = first === null || last === null ? size - 1 : Math.min(last, size - 1);
  if (start >= size || end < start) return { status: 416, headers: { ...headers, 'content-range': `bytes */${size}`, 'content-length': 0 }, bytes: Buffer.alloc(0) };
  const bytes = media.bytes.subarray(start, end + 1);
  return { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': bytes.length }, bytes };
}
