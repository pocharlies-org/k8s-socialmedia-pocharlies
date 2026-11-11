/**
 * Stickers and GIFs (fase 3 / PR-9), ported from the NAS fork's sendFile
 * `asSticker` / `asGif` (gifPlayback) and its gif-send.test.ts.
 *
 * What WhatsApp takes and what this connector does NOT do:
 *  - a sticker is a WebP (static or animated). Nothing is converted here: the
 *    image carries no converter (no sharp / ffmpeg at runtime) and none is
 *    added. A PNG / JPEG / GIF sticker is refused 400 — the caller (the
 *    browser) converts first;
 *  - a GIF is an MP4 sent as a video with `gifPlayback: true` (WhatsApp's
 *    GIFs are looping muted videos; a raw .gif would arrive as a still image).
 *    A `.gif` file is refused 400: transcode it to MP4 first.
 *
 * The bytes are checked by their magic (RIFF…WEBP, …ftyp), not only by the
 * declared type, and by size, before anything reaches the socket.
 */
import { MessageMutationError } from './message-mutations';

/** WhatsApp's own sticker ceilings are ~100 KB static / ~500 KB animated; 1 MiB leaves room. */
export const STICKER_MAX_BYTES = 1024 * 1024;
/** GIFs are short clips; WhatsApp keeps GIF playback for small videos. */
export const GIF_MAX_BYTES = 16 * 1024 * 1024;
export const GIF_CAPTION_MAX = 1024;

export type StickerGifKind = 'sticker' | 'gif';

function invalid(message: string, code?: string): MessageMutationError {
  return new MessageMutationError(message, 400, 'invalid_request', code);
}

function mimeOf(contentType: string | null | undefined): string {
  return String(contentType || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
}

export function isWebp(bytes: Buffer): boolean {
  return (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  );
}

/** ISO-BMFF (MP4) — `ftyp` box right after the first size field. */
export function isMp4(bytes: Buffer): boolean {
  return bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
}

export function isGifBytes(bytes: Buffer): boolean {
  return bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6));
}

/** Animated WebP: the VP8X header's animation flag (bit 1 of byte 20). */
export function isAnimatedWebp(bytes: Buffer): boolean {
  return (
    isWebp(bytes) &&
    bytes.length >= 21 &&
    bytes.toString('ascii', 12, 16) === 'VP8X' &&
    (bytes[20] & 0x02) === 0x02
  );
}

/** The MIME a data: URL declares ('' for http(s) URLs: known only after the fetch). */
export function dataUrlMime(fileUrl: string): string {
  const match = /^data:([^,;]*)/i.exec(fileUrl);
  return match ? mimeOf(match[1]) : '';
}

export interface StickerGifRequest {
  conversationId: string;
  fileUrl: string;
  caption?: string;
  replyToMessageId?: string;
}

/**
 * Body of POST /messages/sticker | /messages/gif: {conversationId, fileUrl,
 * caption? (gif only), replyTo?}. A data: URL whose declared type cannot be
 * the kind is refused here, before the gate; an http(s) URL is checked after
 * the fetch (still before the socket).
 */
export function parseStickerGifRequest(
  kind: StickerGifKind,
  body: Record<string, unknown>
): StickerGifRequest {
  const conversationId =
    typeof (body.conversationId ?? body.chatId) === 'string'
      ? String(body.conversationId ?? body.chatId).trim()
      : '';
  const fileUrl = typeof body.fileUrl === 'string' ? body.fileUrl.trim() : '';
  if (!conversationId || !fileUrl) throw invalid('Missing conversationId or fileUrl');
  if (!/^(https?:|data:)/i.test(fileUrl)) throw invalid('fileUrl must be an http(s) or data: URL');
  if (body.viewOnce === true) {
    throw invalid('viewOnce is only supported for image and video messages');
  }
  if (body.caption !== undefined && body.caption !== null && typeof body.caption !== 'string') {
    throw invalid('caption must be a string');
  }
  const caption = typeof body.caption === 'string' ? body.caption.trim() : '';
  if (kind === 'sticker' && caption) throw invalid('A sticker has no caption');
  if (caption.length > GIF_CAPTION_MAX)
    throw invalid(`caption is at most ${GIF_CAPTION_MAX} characters`);
  const replyRaw = body.replyTo ?? body.replyToMessageId;
  const replyToMessageId =
    typeof replyRaw === 'string' && replyRaw.trim() ? replyRaw.trim() : undefined;
  const declared = dataUrlMime(fileUrl);
  if (declared) checkDeclaredMime(kind, declared);
  return {
    conversationId,
    fileUrl,
    ...(caption ? { caption } : {}),
    ...(replyToMessageId ? { replyToMessageId } : {}),
  };
}

function checkDeclaredMime(kind: StickerGifKind, mime: string): void {
  if (kind === 'sticker' && mime !== 'image/webp') {
    throw invalid(
      `A sticker must be image/webp, got ${mime || 'unknown'}: convert it first (the connector does not convert images)`,
      'sticker_not_webp'
    );
  }
  if (kind === 'gif' && mime === 'image/gif') {
    throw invalid(
      'Animated GIFs must be transcoded to MP4 before sending; the connector does not transcode GIF files',
      'gif_not_mp4'
    );
  }
  if (kind === 'gif' && mime !== 'video/mp4') {
    throw invalid(`A GIF is sent as video/mp4, got ${mime || 'unknown'}`, 'gif_not_mp4');
  }
}

/**
 * The fetched bytes of a sticker / GIF: size first, then the declared type,
 * then the magic. Returns the Baileys content.
 */
export function stickerGifContent(
  kind: StickerGifKind,
  bytes: Buffer,
  contentType: string,
  caption?: string
):
  | { sticker: Buffer; mimetype: 'image/webp'; isAnimated: boolean }
  | { video: Buffer; mimetype: 'video/mp4'; gifPlayback: true; caption?: string } {
  const max = kind === 'sticker' ? STICKER_MAX_BYTES : GIF_MAX_BYTES;
  if (!bytes.length) throw invalid('The file is empty');
  if (bytes.length > max) {
    throw invalid(
      `A ${kind} is at most ${Math.round(max / 1024)} KiB (got ${Math.ceil(bytes.length / 1024)} KiB)`,
      `${kind}_too_large`
    );
  }
  const mime = mimeOf(contentType);
  if (kind === 'sticker') {
    // Object stores often answer application/octet-stream: the magic decides then.
    if (mime && mime !== 'image/webp' && mime !== 'application/octet-stream')
      checkDeclaredMime(kind, mime);
    if (!isWebp(bytes)) {
      throw invalid('A sticker must be a WebP image (the bytes are not WebP)', 'sticker_not_webp');
    }
    return { sticker: bytes, mimetype: 'image/webp', isAnimated: isAnimatedWebp(bytes) };
  }
  if (isGifBytes(bytes) || mime === 'image/gif') checkDeclaredMime(kind, 'image/gif');
  if (mime && mime !== 'video/mp4' && mime !== 'application/octet-stream')
    checkDeclaredMime(kind, mime);
  if (!isMp4(bytes))
    throw invalid('A GIF must be an MP4 video (the bytes are not MP4)', 'gif_not_mp4');
  return {
    video: bytes,
    mimetype: 'video/mp4',
    gifPlayback: true,
    ...(caption ? { caption } : {}),
  };
}

/**
 * Fetch a sticker / GIF with its ceiling enforced while reading (a lying or
 * missing Content-Length cannot make the connector buffer more than max + 1
 * bytes). A fetch failure is a 400: the URL is the caller's.
 */
export async function fetchLimited(
  fileUrl: string,
  maxBytes: number,
  fetchImpl: typeof fetch = fetch
): Promise<{ bytes: Buffer; contentType: string }> {
  let res: Response;
  try {
    res = await fetchImpl(fileUrl);
  } catch (error) {
    throw invalid(
      `Could not fetch fileUrl: ${error instanceof Error ? error.message : String(error)}`,
      'file_unavailable'
    );
  }
  if (!res.ok) throw invalid(`Could not fetch fileUrl: HTTP ${res.status}`, 'file_unavailable');
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw invalid(`The file is larger than ${Math.round(maxBytes / 1024)} KiB`, 'file_too_large');
  }
  const contentType = res.headers.get('content-type') || '';
  if (!res.body) return { bytes: Buffer.from(await res.arrayBuffer()), contentType };
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw invalid(`The file is larger than ${Math.round(maxBytes / 1024)} KiB`, 'file_too_large');
    }
    chunks.push(Buffer.from(value));
  }
  return { bytes: Buffer.concat(chunks), contentType };
}

/** Idempotency hash input of a sticker / GIF send (kind-tagged, never shared with /media/send). */
export function stickerGifHashInput(kind: StickerGifKind, request: StickerGifRequest): unknown {
  return {
    kind,
    fileUrl: request.fileUrl,
    caption: request.caption || null,
    replyTo: request.replyToMessageId || null,
  };
}
