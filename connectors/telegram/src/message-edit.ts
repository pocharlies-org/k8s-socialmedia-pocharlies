/**
 * Edit of our own Telegram text messages — the Telegram twin of the WhatsApp
 * edit (connectors/whatsapp-web/src/message-mutations.ts, fase 3 / PR-3).
 *
 * The house Telegram connectors hold no database: every Telegram row is
 * written by telegram-sync from this connector's NATS events. So an edit — the
 * one POST /messages/edit performs and the ones Telegram tells us about (a
 * contact editing, our phone editing) — leaves here as a
 * `telegram.MessageEdited` event, and telegram-sync applies it to the row
 * exactly like the WhatsApp connector does (content = new text, is_edited =
 * true, the replaced text appended to metadata.edit_history, metadata.edited_at).
 * The pairing pool (src/pairing) never loads this module: it opens no update
 * loop and publishes nothing.
 */

/** An edit Telegram would not accept, or did not accept; the HTTP layer maps it. */
export class MessageMutationError extends Error {
  readonly status: number;
  readonly failureClass: string;
  readonly code?: string;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    status: number,
    failureClass: string,
    code?: string,
    retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'MessageMutationError';
    this.status = status;
    this.failureClass = failureClass;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Who told us: this connector's own HTTP action, or Telegram (contact / our phone). */
export type EditSource = 'connector' | 'telegram';

/** The slice of an mtcute Message the edit needs (structural, so specs can fake it). */
export interface EditableMessage {
  id: number;
  chat: { id: number | string };
  isOutgoing: boolean;
  isService: boolean;
  text: string;
  media: { type: string } | null;
  editDate: Date | null;
}

/** The slice of the mtcute client the edit needs. */
export interface TelegramEditApi {
  getMessages(chatId: string | number, messageIds: number[]): Promise<(EditableMessage | null)[]>;
  editMessage(params: {
    chatId: string | number;
    message: number;
    text: string;
  }): Promise<EditableMessage>;
}

export interface EditResult {
  /** Telegram message id (per chat). */
  messageId: number;
  /** Marked chat id of the message, as the NATS events carry it. */
  conversationId: string;
  editedAt: Date;
  /** Telegram answered MESSAGE_NOT_MODIFIED: the text already was that one. */
  unchanged: boolean;
}

/**
 * Text message = no media, or only a link preview (mtcute exposes a text with
 * a preview as media `webpage`; parseMessage classifies it TEXT too).
 */
export function isTextMessage(message: Pick<EditableMessage, 'isService' | 'media'>): boolean {
  if (message.isService) return false;
  return !message.media || message.media.type === 'webpage';
}

/**
 * The connector's sending gate. The Telegram connectors never had an
 * ENABLE_SENDING switch (their sends are not gated), so unset means on; an
 * explicit ENABLE_SENDING other than "true", or EMERGENCY_DISABLE_SENDING=true
 * (the same kill switch as WhatsApp), turns edits off. Null = allowed.
 */
export function sendingDisabledReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.EMERGENCY_DISABLE_SENDING === 'true') return 'Sending is emergency disabled';
  const flag = env.ENABLE_SENDING;
  if (flag !== undefined && flag !== '' && flag !== 'true') return 'Sending is disabled';
  return null;
}

// RPC errors that mean "this message is not yours to edit".
const NOT_OWN_ERRORS = new Set(['MESSAGE_ID_INVALID', 'MESSAGE_AUTHOR_REQUIRED']);

function rpcError(e: unknown): { code: number; text: string; seconds?: number } | null {
  const err = e as { code?: unknown; text?: unknown; seconds?: unknown } | null;
  if (!err || typeof err !== 'object') return null;
  if (typeof err.code !== 'number' || typeof err.text !== 'string') return null;
  return {
    code: err.code,
    text: err.text,
    seconds: typeof err.seconds === 'number' ? err.seconds : undefined,
  };
}

/** A failed messages.editMessage → status + failureClass (+ Telegram's code). */
export function classifyEditError(e: unknown): MessageMutationError {
  if (e instanceof MessageMutationError) return e;
  const rpc = rpcError(e);
  const detail = e instanceof Error ? e.message : String(e);
  if (!rpc) {
    if (/timed? ?out|timeout/i.test(detail)) {
      return new MessageMutationError(`editMessage timed out: ${detail}`, 504, 'timeout');
    }
    return new MessageMutationError(`editMessage failed: ${detail}`, 502, 'unknown');
  }
  if (NOT_OWN_ERRORS.has(rpc.text)) {
    return new MessageMutationError(
      `Telegram refused the edit (${rpc.text}): only the author can edit a message`,
      422,
      'not_own_message',
      rpc.text
    );
  }
  if (rpc.text === 'MESSAGE_EMPTY') {
    return new MessageMutationError('The new text is empty', 400, 'invalid_request', rpc.text);
  }
  if (rpc.code === 420 || rpc.text.startsWith('FLOOD_WAIT')) {
    return new MessageMutationError(
      `Telegram rate-limited the edit (${rpc.text})`,
      429,
      'rate_limited',
      rpc.text,
      rpc.seconds
    );
  }
  if (rpc.code === 401) {
    return new MessageMutationError(
      `Telegram session rejected (${rpc.text})`,
      401,
      'auth',
      rpc.text
    );
  }
  if (rpc.code === 400 || rpc.code === 403 || rpc.code === 406) {
    // MESSAGE_EDIT_TIME_EXPIRED, MESSAGE_TOO_LONG, CHAT_WRITE_FORBIDDEN,
    // CHAT_ADMIN_REQUIRED…: Telegram's own rules said no.
    return new MessageMutationError(
      `Telegram rejected the edit (${rpc.text})`,
      422,
      'rejected_by_telegram',
      rpc.text
    );
  }
  return new MessageMutationError(
    `editMessage failed (${rpc.code} ${rpc.text})`,
    502,
    'unknown',
    rpc.text
  );
}

/** The message to edit, checked the way Telegram would (exists, ours, text). */
export async function loadEditableMessage(
  api: TelegramEditApi,
  chatId: string | number,
  messageId: number
): Promise<EditableMessage> {
  let found: EditableMessage | null | undefined;
  try {
    [found] = await api.getMessages(chatId, [messageId]);
  } catch (e) {
    const rpc = rpcError(e);
    // An unknown/inaccessible chat is "we cannot see that message".
    if (rpc && rpc.code === 400) {
      throw new MessageMutationError(
        `Message ${messageId} is not available in chat ${chatId} (${rpc.text})`,
        404,
        'message_unavailable',
        rpc.text
      );
    }
    throw classifyEditError(e);
  }
  if (!found) {
    throw new MessageMutationError(
      `Message ${messageId} is not available in chat ${chatId}`,
      404,
      'message_unavailable'
    );
  }
  if (!found.isOutgoing) {
    throw new MessageMutationError(
      `Message ${messageId} was not sent by this account; Telegram only lets the author edit`,
      422,
      'not_own_message'
    );
  }
  if (!isTextMessage(found)) {
    throw new MessageMutationError(
      `Message ${messageId} is not a text message (only text can be edited here)`,
      422,
      'not_editable'
    );
  }
  return found;
}

/**
 * Edit one of our own text messages. MESSAGE_NOT_MODIFIED (same text) is an
 * idempotent success: `unchanged: true`, nothing to record.
 */
export async function editOwnTextMessage(
  api: TelegramEditApi,
  chatId: string | number,
  messageId: number,
  text: string,
  options: { beforeEdit?: (message: EditableMessage) => void; now?: () => Date } = {}
): Promise<EditResult> {
  if (!text.trim()) {
    throw new MessageMutationError('content is required', 400, 'invalid_request');
  }
  const target = await loadEditableMessage(api, chatId, messageId);
  const conversationId = String(target.chat.id);
  const now = options.now || (() => new Date());
  if (target.text === text) {
    return { messageId, conversationId, editedAt: target.editDate || now(), unchanged: true };
  }
  options.beforeEdit?.(target);
  try {
    const edited = await api.editMessage({ chatId, message: messageId, text });
    return { messageId, conversationId, editedAt: edited?.editDate || now(), unchanged: false };
  } catch (e) {
    if (rpcError(e)?.text === 'MESSAGE_NOT_MODIFIED') {
      return { messageId, conversationId, editedAt: target.editDate || now(), unchanged: true };
    }
    throw classifyEditError(e);
  }
}

/**
 * An edit Telegram dispatched (onEditMessage) → the edit to publish, or null:
 * not a text message, never edited (a reaction change on an unedited
 * message), or a text we already know (our own edit's echo, a reaction on an
 * edited one).
 */
export function inboundTextEdit(
  message: EditableMessage,
  deduper: EditDeduper
): {
  conversationId: string;
  telegramMessageId: string;
  content: string;
  editedAt: Date;
  isOutbound: boolean;
} | null {
  if (!message.editDate || !isTextMessage(message)) return null;
  const content = message.text || '';
  if (!content) return null;
  const conversationId = String(message.chat.id);
  const key = EditDeduper.key(conversationId, message.id);
  if (deduper.isKnown(key, content)) return null;
  deduper.remember(key, content);
  return {
    conversationId,
    telegramMessageId: String(message.id),
    content,
    editedAt: message.editDate,
    isOutbound: message.isOutgoing,
  };
}

/**
 * Last text we know per message, so an edit is published once: our own edit
 * is recorded by the HTTP route (with its actor) and the echo Telegram
 * dispatches back is skipped; reaction updates (Telegram delivers them as
 * edits of the same text) are skipped too. Bounded: oldest keys go first.
 */
export class EditDeduper {
  private readonly last = new Map<string, string>();

  constructor(private readonly max = 5000) {}

  static key(conversationId: string, messageId: number | string): string {
    return `${conversationId}:${messageId}`;
  }

  /** True when `text` is already the known text of the message. */
  isKnown(key: string, text: string): boolean {
    return this.last.get(key) === text;
  }

  /** Record `text`; returns the text it replaced (to restore after a failed edit). */
  remember(key: string, text: string): string | undefined {
    const previous = this.last.get(key);
    this.last.delete(key);
    this.last.set(key, text);
    if (this.last.size > this.max) {
      const oldest = this.last.keys().next();
      if (!oldest.done) this.last.delete(oldest.value);
    }
    return previous;
  }

  /** Undo a remember() whose edit failed. */
  restore(key: string, text: string, previous: string | undefined): void {
    if (this.last.get(key) !== text) return;
    if (previous === undefined) this.last.delete(key);
    else this.last.set(key, previous);
  }
}
