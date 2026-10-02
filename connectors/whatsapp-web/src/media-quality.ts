import sharp from 'sharp';
import { CapabilityError } from './whatsapp-capabilities';

export type MediaQuality = 'source' | 'standard' | 'hd';
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_TRANSFORMED_IMAGE_BYTES = 16 * 1024 * 1024;

export function parseMediaQuality(value: unknown): MediaQuality {
  if (value === undefined) return 'source';
  if (value === 'source' || value === 'standard' || value === 'hd') return value;
  throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'Invalid media quality');
}

export async function prepareImageQuality(bytes: Buffer, mimeType: string, quality: MediaQuality) {
  if (quality === 'source') return { bytes, mimeType };
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS });
    const metadata = await image.metadata();
    // Never silently flatten animated images into their first frame.
    if ((metadata.pages || 1) > 1) throw new Error('Animated images require source quality');
    const size = quality === 'hd' ? 2560 : 1600;
    const resized = image
      .autoOrient()
      .resize(size, size, { fit: 'inside', withoutEnlargement: true });
    const output = metadata.hasAlpha
      ? await resized.png().toBuffer()
      : await resized.jpeg({ quality: quality === 'hd' ? 85 : 80 }).toBuffer();
    if (output.length > MAX_TRANSFORMED_IMAGE_BYTES) {
      throw new CapabilityError(
        'INVALID_CAPABILITY_INPUT',
        'Processed image exceeds 16 MiB; use source quality or send as a document'
      );
    }
    return { bytes: output, mimeType: metadata.hasAlpha ? 'image/png' : 'image/jpeg' };
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw new CapabilityError(
      'INVALID_CAPABILITY_INPUT',
      'Image cannot be processed (invalid, animated, or over 40 megapixels)'
    );
  }
}
