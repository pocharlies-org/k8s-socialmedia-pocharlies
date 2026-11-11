import type {
  AnyMessageContent,
  ChatModification,
  LastMessageList,
  PresenceData,
  WAMessageKey,
  WAPresence,
} from '@whiskeysockets/baileys';

export type CapabilityErrorCode =
  | 'CAPABILITY_UNSUPPORTED'
  | 'INVALID_CAPABILITY_INPUT'
  | 'POLL_NOT_FOUND'
  | 'POLL_ENCRYPTION_KEY_UNAVAILABLE';

export class CapabilityError extends Error {
  readonly status: number;

  constructor(
    readonly code: CapabilityErrorCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'CapabilityError';
    this.status =
      code === 'CAPABILITY_UNSUPPORTED'
        ? 501
        : code === 'POLL_NOT_FOUND'
          ? 404
          : code === 'POLL_ENCRYPTION_KEY_UNAVAILABLE'
            ? 409
            : 400;
  }
}

export type ChatCapabilityAction =
  | 'archive'
  | 'unarchive'
  | 'unread'
  | 'read'
  | 'pin'
  | 'unpin'
  | 'mute'
  | 'unmute'
  | 'star'
  | 'unstar';

/** Map UI spellings to the small, explicit connector action vocabulary. */
export function normalizeCapabilityAction(value: unknown): ChatCapabilityAction | null {
  if (typeof value !== 'string') return null;
  const action = value.trim().toLowerCase().replace(/_/g, '-');
  if (action === 'mark-unread' || action === 'unread') return 'unread';
  if (action === 'mark-read' || action === 'read') return 'read';
  if (action === 'archive' || action === 'unarchive') return action;
  if (['pin', 'unpin', 'mute', 'unmute', 'star', 'unstar'].includes(action)) {
    return action as ChatCapabilityAction;
  }
  return null;
}

function unsupported(action: unknown): never {
  throw new CapabilityError(
    'CAPABILITY_UNSUPPORTED',
    `WhatsApp connector does not support chat action: ${String(action)}`,
    { action }
  );
}

/** Build only the documented Baileys chatModify shapes. */
export function buildChatModification(
  action: string,
  value: unknown,
  lastMessages: LastMessageList,
  messageRefs?: Array<{ id: string; fromMe?: boolean }>
): ChatModification {
  const normalized = normalizeCapabilityAction(action);
  if (!normalized) return unsupported(action);
  if (
    (normalized === 'archive' ||
      normalized === 'unarchive' ||
      normalized === 'read' ||
      normalized === 'unread') &&
    (!Array.isArray(lastMessages) || !lastMessages.length)
  ) {
    throw new CapabilityError(
      'INVALID_CAPABILITY_INPUT',
      `Chat action ${normalized} requires at least one last message key`,
      { action: normalized }
    );
  }

  if (normalized === 'archive' || normalized === 'unarchive') {
    return { archive: normalized === 'archive', lastMessages };
  }
  if (normalized === 'read' || normalized === 'unread') {
    return { markRead: normalized === 'read', lastMessages };
  }
  if (normalized === 'pin' || normalized === 'unpin') {
    return { pin: normalized === 'pin' ? true : false };
  }
  if (normalized === 'mute' || normalized === 'unmute') {
    if (normalized === 'unmute') return { mute: null };
    const duration = Number(value);
    if (!Number.isFinite(duration) || duration < 0) {
      throw new CapabilityError(
        'INVALID_CAPABILITY_INPUT',
        'Mute duration must be a non-negative number'
      );
    }
    return { mute: duration };
  }
  if (normalized === 'star' || normalized === 'unstar') {
    if (!messageRefs?.length) {
      throw new CapabilityError(
        'INVALID_CAPABILITY_INPUT',
        'Star action requires message references'
      );
    }
    return { star: { messages: messageRefs, star: normalized === 'star' } };
  }
  return unsupported(action);
}

export interface ContactMessageInput {
  displayName: string;
  phone: string;
  organization?: string;
  email?: string;
}

function vcardEscape(value: string): string {
  return value.replace(/[\\;,\n]/g, match => (match === '\n' ? '\\n' : `\\${match}`));
}

export function buildContactMessage(
  input: ContactMessageInput
): Extract<AnyMessageContent, { contacts: unknown }> {
  const displayName = input.displayName.trim();
  const phone = input.phone.trim();
  if (!displayName || !phone) {
    throw new CapabilityError(
      'INVALID_CAPABILITY_INPUT',
      'Contact displayName and phone are required'
    );
  }
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${vcardEscape(displayName)}`,
    `TEL;type=CELL;type=VOICE:${vcardEscape(phone)}`,
  ];
  if (input.organization?.trim()) lines.push(`ORG:${vcardEscape(input.organization.trim())}`);
  if (input.email?.trim()) lines.push(`EMAIL:${vcardEscape(input.email.trim())}`);
  lines.push('END:VCARD');
  return {
    contacts: {
      displayName,
      contacts: [{ displayName, vcard: lines.join('\n') }],
    },
  } as Extract<AnyMessageContent, { contacts: unknown }>;
}

export interface PollMessageInput {
  name: string;
  values: string[];
  selectableCount?: number;
  messageSecret?: Uint8Array;
}

export const POLL_QUESTION_MAX_LENGTH = 255;
export const POLL_OPTION_MAX_LENGTH = 100;
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 12;

export interface ValidatedPollInput {
  name: string;
  values: string[];
  selectableCount?: number;
}

/**
 * The limits the official client enforces, counted the way the provider counts
 * them: trimmed JavaScript string length. An empty or repeated option is
 * refused rather than dropped, because otherwise voters would see a list that
 * is not the one the creator wrote.
 */
export function validatePollInput(input: {
  name: unknown;
  values: unknown;
  selectableCount?: unknown;
}): ValidatedPollInput {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'A poll needs a question', {
      field: 'name',
    });
  }
  if (name.length > POLL_QUESTION_MAX_LENGTH) {
    throw new CapabilityError(
      'INVALID_CAPABILITY_INPUT',
      `The question cannot be longer than ${POLL_QUESTION_MAX_LENGTH} characters`,
      { field: 'name', maxLength: POLL_QUESTION_MAX_LENGTH, length: name.length }
    );
  }
  if (!Array.isArray(input.values)) {
    throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'Poll options must be a list', {
      field: 'values',
    });
  }
  if (input.values.length < POLL_MIN_OPTIONS || input.values.length > POLL_MAX_OPTIONS) {
    throw new CapabilityError(
      'INVALID_CAPABILITY_INPUT',
      `A poll needs between ${POLL_MIN_OPTIONS} and ${POLL_MAX_OPTIONS} options`,
      { field: 'values', min: POLL_MIN_OPTIONS, max: POLL_MAX_OPTIONS, given: input.values.length }
    );
  }
  const values = input.values.map((value: unknown, index: number) => {
    if (typeof value !== 'string') {
      throw new CapabilityError('INVALID_CAPABILITY_INPUT', `Option ${index + 1} must be text`, {
        field: 'values',
        index,
      });
    }
    const option = value.trim();
    if (!option) {
      throw new CapabilityError('INVALID_CAPABILITY_INPUT', `Option ${index + 1} is empty`, {
        field: 'values',
        index,
      });
    }
    if (option.length > POLL_OPTION_MAX_LENGTH) {
      throw new CapabilityError(
        'INVALID_CAPABILITY_INPUT',
        `No option can be longer than ${POLL_OPTION_MAX_LENGTH} characters`,
        { field: 'values', index, maxLength: POLL_OPTION_MAX_LENGTH, length: option.length }
      );
    }
    return option;
  });
  if (new Set(values).size !== values.length) {
    throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'Poll options cannot repeat', {
      field: 'values',
    });
  }
  if (input.selectableCount === undefined || input.selectableCount === null) {
    return { name, values };
  }
  const selectableCount = Number(input.selectableCount);
  if (
    !Number.isInteger(selectableCount) ||
    selectableCount < 1 ||
    selectableCount > values.length
  ) {
    throw new CapabilityError(
      'INVALID_CAPABILITY_INPUT',
      `selectableCount must be between 1 and the number of options (${values.length})`,
      { field: 'selectableCount', max: values.length, given: input.selectableCount }
    );
  }
  return { name, values, selectableCount };
}

export function buildPollMessage(
  input: PollMessageInput
): Extract<AnyMessageContent, { poll: unknown }> {
  const { name, values, selectableCount } = validatePollInput(input);
  return {
    poll: {
      name,
      values,
      ...(selectableCount === undefined ? {} : { selectableCount }),
      ...(input.messageSecret ? { messageSecret: input.messageSecret } : {}),
    },
  } as Extract<AnyMessageContent, { poll: unknown }>;
}

export interface EventMessageInput {
  name: string;
  description?: string;
  startDate: Date;
  endDate?: Date;
  location?: EventLocationInput;
  call?: 'audio' | 'video';
  isCancelled?: boolean;
  extraGuestsAllowed?: boolean;
}

export interface EventLocationInput {
  degreesLatitude?: number;
  degreesLongitude?: number;
  name?: string;
}

/**
 * The official event form offers a free-text place, and rc13 copies
 * `eventMessage.location` straight into the proto, whose coordinates are
 * optional. So a name alone is a complete place, a coordinate pair alone is a
 * map pin, and a blank location means the creator left the field empty.
 * Coordinates are never invented for a name-only place.
 */
export function validateEventLocation(location: unknown): EventLocationInput | undefined {
  if (location === undefined || location === null) return undefined;
  if (typeof location !== 'object' || Array.isArray(location)) {
    throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'Event location must be an object', {
      field: 'location',
    });
  }
  const raw = location as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const hasLatitude = raw.degreesLatitude !== undefined && raw.degreesLatitude !== null;
  const hasLongitude = raw.degreesLongitude !== undefined && raw.degreesLongitude !== null;
  if (!hasLatitude && !hasLongitude) {
    if (!name) return undefined;
    return { name };
  }
  if (hasLatitude !== hasLongitude) {
    throw new CapabilityError(
      'INVALID_CAPABILITY_INPUT',
      'Event location needs both coordinates or neither',
      { field: 'location' }
    );
  }
  const coordinate = (value: unknown): number =>
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  const degreesLatitude = coordinate(raw.degreesLatitude);
  const degreesLongitude = coordinate(raw.degreesLongitude);
  if (!Number.isFinite(degreesLatitude) || degreesLatitude < -90 || degreesLatitude > 90) {
    throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'Event latitude must be -90 to 90', {
      field: 'location',
    });
  }
  if (!Number.isFinite(degreesLongitude) || degreesLongitude < -180 || degreesLongitude > 180) {
    throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'Event longitude must be -180 to 180', {
      field: 'location',
    });
  }
  return { degreesLatitude, degreesLongitude, ...(name ? { name } : {}) };
}

export function buildEventMessage(
  input: EventMessageInput
): Extract<AnyMessageContent, { event: unknown }> {
  const name = input.name.trim();
  if (!name || !(input.startDate instanceof Date) || Number.isNaN(input.startDate.getTime())) {
    throw new CapabilityError(
      'INVALID_CAPABILITY_INPUT',
      'Event name and valid startDate are required'
    );
  }
  if (input.endDate && Number.isNaN(input.endDate.getTime())) {
    throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'Event endDate must be valid');
  }
  if (input.endDate && input.endDate.getTime() < input.startDate.getTime()) {
    throw new CapabilityError(
      'INVALID_CAPABILITY_INPUT',
      'Event endDate cannot be before startDate'
    );
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    throw new CapabilityError('INVALID_CAPABILITY_INPUT', 'Event description must be text', {
      field: 'description',
    });
  }
  const description = input.description?.trim();
  const location = validateEventLocation(input.location);
  return {
    event: {
      name,
      ...(description ? { description } : {}),
      startDate: input.startDate,
      ...(input.endDate ? { endDate: input.endDate } : {}),
      ...(location ? { location } : {}),
      ...(input.call ? { call: input.call } : {}),
      ...(input.isCancelled === undefined ? {} : { isCancelled: input.isCancelled }),
      ...(input.extraGuestsAllowed === undefined
        ? {}
        : { extraGuestsAllowed: input.extraGuestsAllowed }),
    },
  } as Extract<AnyMessageContent, { event: unknown }>;
}

export interface PresenceSnapshot {
  chatId: string;
  participantId?: string;
  status: WAPresence | 'unknown';
  lastSeen?: number;
}

export function buildPresenceSnapshot(
  chatId: string,
  data: PresenceData | undefined,
  participantId?: string
): PresenceSnapshot {
  const status = data?.lastKnownPresence;
  return {
    chatId,
    ...(participantId ? { participantId } : {}),
    status: status || 'unknown',
    ...(typeof data?.lastSeen === 'number' ? { lastSeen: data.lastSeen } : {}),
  };
}

type PrivacyMethod =
  | 'updateLastSeenPrivacy'
  | 'updateOnlinePrivacy'
  | 'updateProfilePicturePrivacy'
  | 'updateStatusPrivacy'
  | 'updateReadReceiptsPrivacy'
  | 'updateGroupsAddPrivacy'
  | 'updateCallPrivacy'
  | 'updateMessagesPrivacy';

const privacyMethods: Record<string, { method: PrivacyMethod; values: readonly string[] }> = {
  lastSeen: {
    method: 'updateLastSeenPrivacy',
    values: ['all', 'contacts', 'contact_blacklist', 'none'],
  },
  online: { method: 'updateOnlinePrivacy', values: ['all', 'match_last_seen'] },
  profilePicture: {
    method: 'updateProfilePicturePrivacy',
    values: ['all', 'contacts', 'contact_blacklist', 'none'],
  },
  status: {
    method: 'updateStatusPrivacy',
    values: ['all', 'contacts', 'contact_blacklist', 'none'],
  },
  readReceipts: { method: 'updateReadReceiptsPrivacy', values: ['all', 'none'] },
  groupsAdd: { method: 'updateGroupsAddPrivacy', values: ['all', 'contacts', 'contact_blacklist'] },
  call: { method: 'updateCallPrivacy', values: ['all', 'known'] },
  messages: { method: 'updateMessagesPrivacy', values: ['all', 'contacts'] },
};

export function buildPrivacyUpdate(
  field: string,
  value: string
): { method: PrivacyMethod; value: string } {
  const entry = privacyMethods[field];
  if (!entry || !entry.values.includes(value)) {
    throw new CapabilityError(
      'INVALID_CAPABILITY_INPUT',
      `Unsupported privacy value for ${field}`,
      { field, value }
    );
  }
  return { method: entry.method, value };
}

function durableReplacer(_key: string, value: unknown): unknown {
  if (Buffer.isBuffer(value))
    return { __socialmedia_type: 'Buffer', value: value.toString('base64') };
  if (value instanceof Uint8Array)
    return { __socialmedia_type: 'Uint8Array', value: Buffer.from(value).toString('base64') };
  if (value instanceof Date) return { __socialmedia_type: 'Date', value: value.toISOString() };
  if (typeof value === 'bigint') return { __socialmedia_type: 'BigInt', value: value.toString() };
  return value;
}

function reviveDurableValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Date || Buffer.isBuffer(value) || value instanceof Uint8Array) return value;

  // Buffer.toJSON() runs before JSON.stringify's replacer, so buffers stored
  // in JSONB arrive as { type: 'Buffer', data: [...] } rather than a custom
  // marker. Handle both shapes when values come back through pg.
  const tagged = value as {
    __socialmedia_type?: string;
    value?: string;
    type?: string;
    data?: unknown;
  };
  if (tagged.type === 'Buffer' && Array.isArray(tagged.data)) {
    return Buffer.from(tagged.data as number[]);
  }
  if (tagged.__socialmedia_type === 'Buffer') return Buffer.from(tagged.value || '', 'base64');
  if (tagged.__socialmedia_type === 'Uint8Array')
    return new Uint8Array(Buffer.from(tagged.value || '', 'base64'));
  if (tagged.__socialmedia_type === 'Date') return new Date(tagged.value || '');
  if (tagged.__socialmedia_type === 'BigInt') return BigInt(tagged.value || '0');
  if (Array.isArray(value)) return value.map(reviveDurableValue);

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, reviveDurableValue(child)])
  );
}

function durableReviver(_key: string, value: unknown): unknown {
  return reviveDurableValue(value);
}

export function serializeDurableValue(value: unknown): string {
  return JSON.stringify(value, durableReplacer);
}

export function deserializeDurableValue(value: unknown): unknown {
  if (typeof value === 'string') return JSON.parse(value, durableReviver);
  return reviveDurableValue(value);
}

export function durableKeyFor(messageId: string, key: WAMessageKey): string {
  return `${messageId}:${key.remoteJid || ''}:${key.fromMe ? 'me' : 'peer'}`;
}
