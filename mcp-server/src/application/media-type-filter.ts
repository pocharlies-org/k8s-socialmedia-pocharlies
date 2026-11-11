/**
 * `mediaType` filter of social_search_messages, shared by every channel's
 * local-index search. Maps the canonical kinds onto the `messages.message_type`
 * values each ingester writes (WhatsApp IMAGE/PTT/…, Telegram PHOTO/VOICE/…,
 * Instagram IMAGE/VIDEO/CAROUSEL_ALBUM). Albums and carousels count as image.
 * Instagram webhook `media` events are stored as message_type MEDIA with the
 * kind as the content's first segment ("VIDEO | caption | permalink"), so that
 * prefix is matched too.
 */
export const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker', 'any'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

const MESSAGE_TYPES: Record<Exclude<MediaType, 'any'>, string[]> = {
  image: ['IMAGE', 'PHOTO', 'ALBUM', 'ALBUMMESSAGE', 'CAROUSEL_ALBUM'],
  video: ['VIDEO', 'VIDEO_NOTE'],
  audio: ['AUDIO', 'PTT', 'VOICE'],
  document: ['DOCUMENT', 'DOCUMENTWITHCAPTIONMESSAGE'],
  sticker: ['STICKER'],
};

export function isMediaType(value: unknown): value is MediaType {
  return typeof value === 'string' && (MEDIA_TYPES as readonly string[]).includes(value);
}

/** message_type values for a kind; undefined = no filter ('any' or absent). */
export function messageTypesFor(mediaType?: MediaType): string[] | undefined {
  if (!mediaType || mediaType === 'any') return undefined;
  return MESSAGE_TYPES[mediaType];
}

/**
 * SQL predicate over `<alias>.message_type` / `<alias>.content` bound to one
 * text[] parameter at `$<paramIndex>` (see messageTypesFor).
 */
export function mediaTypePredicate(alias: string, paramIndex: number): string {
  const col = alias ? `${alias}.` : '';
  return (
    ` AND (upper(${col}message_type) = ANY($${paramIndex}::text[])` +
    ` OR (upper(${col}message_type) = 'MEDIA'` +
    ` AND upper(split_part(${col}content, ' |', 1)) = ANY($${paramIndex}::text[])))`
  );
}
