/**
 * Image quality, play-once and the audio payload of a WhatsApp media send
 * (ported from the NAS fork's media-quality.ts and its sendFile options).
 *
 * - `quality`: `source` (default, what /messages/media/send always did: the
 *   fetched bytes go out untouched), `standard` (long edge 1600 px, JPEG 80)
 *   or `hd` (long edge 2560 px, JPEG 85). Images only; never enlarged; an
 *   image with alpha stays PNG. Re-encoding is sharp's (the same library
 *   Baileys uses for thumbnails and profile pictures).
 * - `viewOnce`: Baileys rc13 wraps the content in `viewOnceMessage` when the
 *   content carries a truthy `viewOnce`; WhatsApp only offers it for photos
 *   and videos, so every other kind is refused before the socket instead of
 *   going out as a normal, permanent message.
 */
import sharp from 'sharp';
import { MessageMutationError } from './message-mutations';

export type MediaQuality = 'source' | 'standard' | 'hd';
export const MEDIA_QUALITIES: readonly MediaQuality[] = ['source', 'standard', 'hd'];
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_TRANSFORMED_IMAGE_BYTES = 16 * 1024 * 1024;

/** What WhatsApp plays once; anything else would silently go out permanent. */
export const MEDIA_VIEW_ONCE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'video/mp4']);

function invalid(message: string, code: string): MessageMutationError {
  return new MessageMutationError(message, 400, 'invalid_request', code);
}

export function parseMediaQuality(value: unknown): MediaQuality {
  if (value === undefined || value === null) return 'source';
  if (MEDIA_QUALITIES.includes(value as MediaQuality)) return value as MediaQuality;
  throw invalid(`quality must be one of ${MEDIA_QUALITIES.join(', ')}`, 'invalid_quality');
}

export function parseViewOnce(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw invalid('viewOnce must be a boolean', 'invalid_view_once');
  return value;
}

/**
 * The media options of one send, checked against the fetched content type:
 * play-once only for JPEG/PNG photos and MP4 videos, a quality other than
 * source only for re-encodable still images, neither with a sticker.
 */
export function checkMediaOptions(
  contentType: string,
  options: { viewOnce: boolean; quality: MediaQuality; asSticker: boolean }
): void {
  const mime = contentType.split(';', 1)[0].trim().toLowerCase();
  if (options.viewOnce) {
    if (options.asSticker || !MEDIA_VIEW_ONCE_MIME_TYPES.has(mime)) {
      throw invalid(
        `viewOnce is only supported for ${Array.from(MEDIA_VIEW_ONCE_MIME_TYPES).join(', ')}; got ${options.asSticker ? 'a sticker' : mime || 'unknown'}`,
        'view_once_unsupported'
      );
    }
  }
  if (options.quality !== 'source') {
    if (options.asSticker || !mime.startsWith('image/') || mime === 'image/gif') {
      throw invalid(
        `quality ${options.quality} only applies to still images; got ${options.asSticker ? 'a sticker' : mime || 'unknown'}`,
        'quality_unsupported'
      );
    }
  }
}

/**
 * The Baileys payload for an audio attachment (INFRA-592).
 *
 * OGG/Opus is WhatsApp's voice note: it must go out with `ptt: true` and the
 * `audio/ogg; codecs=opus` mimetype. Sent as a plain audio message
 * (`ptt: false`) WhatsApp accepts it, stores it — status stops at `sent` and
 * it is NEVER delivered (measured 05-10: two AUDIO sends stuck at `sent`;
 * the same clip through `sendVoice` reached `read`). Other audio (mp3…)
 * keeps the audio-message form. No caption: WhatsApp's `AudioMessage` has no
 * caption field (baileys drops it via `fromObject`) — the text of a send
 * with attachments already goes out as its own message upstream.
 */
export function audioMessagePayload(
  contentType: string,
  buf: Buffer
): { audio: Buffer; mimetype: string; ptt: boolean } {
  const voice = /ogg|opus/.test(contentType.toLowerCase());
  return {
    audio: buf,
    mimetype: voice ? 'audio/ogg; codecs=opus' : contentType,
    ptt: voice,
  };
}

export async function prepareImageQuality(
  bytes: Buffer,
  mimeType: string,
  quality: MediaQuality
): Promise<{ bytes: Buffer; mimeType: string }> {
  if (quality === 'source') return { bytes, mimeType };
  let output: Buffer;
  let hasAlpha = false;
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS });
    const metadata = await image.metadata();
    // Never silently flatten an animated image into its first frame.
    if ((metadata.pages || 1) > 1) throw new Error('animated');
    hasAlpha = metadata.hasAlpha === true;
    const size = quality === 'hd' ? 2560 : 1600;
    const resized = image
      .autoOrient()
      .resize(size, size, { fit: 'inside', withoutEnlargement: true });
    output = hasAlpha
      ? await resized.png().toBuffer()
      : await resized.jpeg({ quality: quality === 'hd' ? 85 : 80 }).toBuffer();
  } catch {
    throw invalid(
      'Image cannot be re-encoded (invalid, animated or over 40 megapixels); send it with quality source',
      'image_unprocessable'
    );
  }
  if (output.length > MAX_TRANSFORMED_IMAGE_BYTES) {
    throw invalid(
      'Processed image exceeds 16 MiB; use quality source or send it as a document',
      'image_too_large'
    );
  }
  return { bytes: output, mimeType: hasAlpha ? 'image/png' : 'image/jpeg' };
}
