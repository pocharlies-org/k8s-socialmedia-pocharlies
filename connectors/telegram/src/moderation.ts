/**
 * Telegram member moderation (INFRA-218 / INFRA-344): the closed `restriction`
 * enum, the numeric-target check and the canonical error table that the
 * moderation routes answer with. Pure functions: the mtcute calls live in
 * TelegramClientWrapper, the HTTP shape in api/controller.ts.
 */

/** Rights mtcute takes in `restrictChatMember` (true = forbidden). */
export type BannedRights = Partial<
  Record<
    | 'sendMessages'
    | 'sendMedia'
    | 'sendStickers'
    | 'sendGifs'
    | 'sendGames'
    | 'sendInline'
    | 'sendPolls'
    | 'embedLinks'
    | 'inviteUsers'
    | 'pinMessages'
    | 'changeInfo',
    true
  >
>;

const MUTE: BannedRights = {
  sendMessages: true,
  sendMedia: true,
  sendStickers: true,
  sendGifs: true,
  sendGames: true,
  sendInline: true,
  sendPolls: true,
  embedLinks: true,
};

// `no_media` = `mute` without `sendMessages`; `read_only` = `mute` + three more.
const NO_MEDIA: BannedRights = { ...MUTE };
delete NO_MEDIA.sendMessages;

/** The closed set of restrictions the MCP may ask for (INFRA-218 dictamen §2). */
export const RESTRICTIONS = {
  mute: MUTE,
  no_media: NO_MEDIA,
  no_invite: { inviteUsers: true },
  read_only: { ...MUTE, inviteUsers: true, pinMessages: true, changeInfo: true },
} as const satisfies Record<string, BannedRights>;

export type Restriction = keyof typeof RESTRICTIONS;

export function isRestriction(value: unknown): value is Restriction {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RESTRICTIONS, value);
}

/** Admin right names `getChatMember` reports, in the order the route returns them. */
export const ADMIN_RIGHT_NAMES = [
  'changeInfo',
  'postMessages',
  'editMessages',
  'deleteMessages',
  'banUsers',
  'inviteUsers',
  'pinMessages',
  'addAdmins',
  'anonymous',
  'manageCall',
  'other',
  'manageTopics',
  'postStories',
  'editStories',
  'deleteStories',
  'manageDirectMessages',
] as const;

/** Numeric Telegram id (marked ids like -1001234567890 included); never a @username. */
export const NUMERIC_TARGET_RE = /^-?\d{1,20}$/;

export type ModerationErrorClass =
  | 'invalid_target'
  | 'invalid_request'
  | 'not_admin'
  | 'rate_limited'
  | 'user_not_participant'
  | 'unsupported_chat_type'
  | 'telegram_error';

const STATUS: Record<ModerationErrorClass, number> = {
  invalid_target: 400,
  invalid_request: 400,
  not_admin: 403,
  rate_limited: 429,
  user_not_participant: 404,
  unsupported_chat_type: 422,
  telegram_error: 502,
};

/** A moderation refusal already in its canonical shape; `outcome_unknown` is not a value. */
export class ModerationError extends Error {
  readonly status: number;

  constructor(
    readonly failureClass: ModerationErrorClass,
    message: string,
    /** The original TL error text (FOO_BAR), when Telegram said one. */
    readonly code?: string,
    readonly retryAfterSeconds?: number,
    /** not_admin: the admin right the account lacks. */
    readonly missingRight?: string
  ) {
    super(message);
    this.name = 'ModerationError';
    this.status = STATUS[failureClass];
  }
}

export function invalidTarget(name: string): ModerationError {
  return new ModerationError(
    'invalid_target',
    `${name} debe ser id numérico de Telegram (no @nombre)`
  );
}

/** `value` as a numeric Telegram id, or throw invalid_target. */
export function requireNumericTarget(name: string, value: unknown): string {
  const text = typeof value === 'number' && Number.isInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !NUMERIC_TARGET_RE.test(text)) throw invalidTarget(name);
  return text;
}

const NOT_ADMIN_ERRORS = new Set(['CHAT_ADMIN_REQUIRED', 'RIGHT_FORBIDDEN', 'USER_ADMIN_INVALID']);
const INVALID_TARGET_ERRORS = new Set([
  'PEER_ID_INVALID',
  'USER_ID_INVALID',
  'CHANNEL_INVALID',
  'CHAT_ID_INVALID',
  'USER_NOT_FOUND',
]);

function rpcOf(e: unknown): { code?: number; text: string; seconds?: number } | null {
  const err = e as { code?: unknown; text?: unknown; seconds?: unknown } | null;
  if (!err || typeof err !== 'object' || typeof err.text !== 'string') return null;
  return {
    code: typeof err.code === 'number' ? err.code : undefined,
    text: err.text,
    seconds: typeof err.seconds === 'number' ? err.seconds : undefined,
  };
}

function typeName(e: unknown): string | undefined {
  return (e as { constructor?: { name?: string } } | null)?.constructor?.name;
}

/**
 * Any failure of a moderation call → its canonical ModerationError. `action`
 * only feeds the not_admin message (which right is missing); everything not
 * recognised is `telegram_error` carrying the original TL code.
 */
export function classifyModerationError(e: unknown, action: string): ModerationError {
  if (e instanceof ModerationError) return e;
  const rpc = rpcOf(e);
  if (rpc) {
    if (NOT_ADMIN_ERRORS.has(rpc.text)) {
      const detail =
        rpc.text === 'USER_ADMIN_INVALID'
          ? 'el objetivo es administrador y esta cuenta no puede moderarlo'
          : 'esta cuenta no es administradora del chat o le falta el derecho banUsers';
      return new ModerationError(
        'not_admin',
        `Telegram rechazó ${action} (${rpc.text}): ${detail}`,
        rpc.text,
        undefined,
        'banUsers'
      );
    }
    const flood = /^FLOOD_WAIT_(\d+)$/.exec(rpc.text);
    if (flood || rpc.text === 'FLOOD_WAIT' || rpc.code === 420) {
      const seconds = rpc.seconds ?? (flood ? Number(flood[1]) : undefined);
      return new ModerationError(
        'rate_limited',
        `Telegram limitó ${action} (${rpc.text})`,
        rpc.text,
        seconds
      );
    }
    if (rpc.text === 'USER_NOT_PARTICIPANT') {
      return new ModerationError(
        'user_not_participant',
        `El usuario no es miembro del chat (${rpc.text})`,
        rpc.text
      );
    }
    if (INVALID_TARGET_ERRORS.has(rpc.text)) {
      return new ModerationError(
        'invalid_target',
        `Telegram no reconoce el chat o el usuario (${rpc.text})`,
        rpc.text
      );
    }
    return new ModerationError(
      'telegram_error',
      `Telegram rechazó ${action} (${rpc.text})`,
      rpc.text
    );
  }
  // mtcute's own errors keep the class name (their `name` stays "Error").
  if (typeName(e) === 'MtPeerNotFoundError') {
    return new ModerationError('invalid_target', 'Telegram no encuentra ese chat o usuario');
  }
  if (typeName(e) === 'MtInvalidPeerTypeError') {
    return new ModerationError(
      'unsupported_chat_type',
      `${action} solo existe en supergrupos y canales`
    );
  }
  return new ModerationError(
    'telegram_error',
    `${action} falló: ${e instanceof Error ? e.message : String(e)}`
  );
}
