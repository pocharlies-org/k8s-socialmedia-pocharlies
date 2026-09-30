/**
 * WhatsApp presence (fase 3 / PR-8): the "online / last seen / typing…" of a
 * contact, and our own typing indicator in a chat. Ported from the NAS fork
 * (presenceState with a TTL, getPresence answering "unknown" rather than a
 * stale status, updatePresence) and adapted to prod.
 *
 * Nothing of this is stored: presence is ephemeral. What WhatsApp tells us
 * (presence.update) lives here for a short while — 60 s for online / offline,
 * 8 s for typing / recording (WhatsApp re-sends those every few seconds while
 * they last) — and is forgotten on every reconnect. An expired entry is
 * dropped and the reader gets `unknown`, never an old "online".
 *
 * OUR presence. Being `available` ("online") on a linked device makes
 * WhatsApp stop the push notifications on the phone of the account (Dani's):
 * the phone thinks someone is reading on the desktop. So the connector never
 * says `available` on its own (markOnlineOnConnect stays false, nothing here
 * sends it implicitly). What a caller may send:
 *  - composing / recording / paused IN ONE CHAT: the chat-state node
 *    ("escribiendo…" while an operator writes). It does not change the
 *    account's availability;
 *  - unavailable, account-wide: always allowed (it is the safe direction);
 *  - available, account-wide: only when asked for explicitly AND the
 *    deployment opted in with WA_PRESENCE_ALLOW_AVAILABLE=true (default off).
 */
import { MessageMutationError } from './message-mutations';

/** What WhatsApp tells us about someone, as the API reports it. */
export type PresenceStatus = 'available' | 'unavailable' | 'composing' | 'recording' | 'unknown';

/** Chat-state we send inside one chat. */
export type ChatPresenceState = 'composing' | 'recording' | 'paused';
/** Account-wide availability. */
export type AccountPresenceState = 'available' | 'unavailable';
export type OutgoingPresenceState = ChatPresenceState | AccountPresenceState;

const CHAT_STATES: ChatPresenceState[] = ['composing', 'recording', 'paused'];
const ACCOUNT_STATES: AccountPresenceState[] = ['unavailable', 'available'];

/** Online / offline (and its last seen) is trusted this long. */
export const PRESENCE_TTL_MS = 60_000;
/** Typing / recording: WhatsApp re-emits every ~5 s while it lasts. */
export const TYPING_TTL_MS = 8_000;
/** The same chat-state to the same chat is not re-sent within this window. */
export const PRESENCE_SEND_THROTTLE_MS = 3_000;

/** WA_PRESENCE_ALLOW_AVAILABLE=true lets a caller mark the account online. Off by default. */
export function availablePresenceAllowed(): boolean {
  return process.env.WA_PRESENCE_ALLOW_AVAILABLE === 'true';
}

export function isChatPresenceState(state: string): state is ChatPresenceState {
  return (CHAT_STATES as string[]).includes(state);
}

export interface PresenceRequest {
  state: OutgoingPresenceState;
  /** Required for a chat-state; absent for an account-wide one. */
  conversationId?: string;
}

function invalid(message: string, code?: string): MessageMutationError {
  return new MessageMutationError(message, 400, 'invalid_request', code);
}

/**
 * {conversationId, state} of POST /chats/presence. A chat-state needs the
 * chat; unavailable / available are account-wide and refuse a chat, so a
 * caller cannot believe it went "offline in one chat".
 */
export function parsePresenceRequest(body: Record<string, unknown>): PresenceRequest {
  const raw = typeof body.state === 'string' ? body.state.trim().toLowerCase() : '';
  const conversationId =
    typeof (body.conversationId ?? body.chatId) === 'string'
      ? String(body.conversationId ?? body.chatId).trim()
      : '';
  if (isChatPresenceState(raw)) {
    if (!conversationId) throw invalid(`state ${raw} needs the conversationId of the chat`);
    return { state: raw, conversationId };
  }
  if ((ACCOUNT_STATES as string[]).includes(raw)) {
    if (conversationId) {
      throw invalid(
        `state ${raw} is account-wide (every chat sees it): omit conversationId`,
        'account_wide_state'
      );
    }
    return { state: raw as AccountPresenceState };
  }
  throw invalid('state must be one of composing, recording, paused (in a chat) or unavailable');
}

/** One participant's presence as the API reports it. */
export interface PresenceView {
  /** Legacy jid (`…@c.us`, `…@lid`) of whom it is about. */
  participantId: string;
  status: PresenceStatus;
  /** ISO time they were last online, when WhatsApp shares it (null otherwise). */
  lastSeen: string | null;
  /** When the connector heard it (ISO), null for unknown. */
  observedAt: string | null;
}

interface PresenceEntry {
  status: Exclude<PresenceStatus, 'unknown'>;
  lastSeenSec?: number;
  observedAt: number;
}

function ttlOf(status: PresenceStatus): number {
  return status === 'composing' || status === 'recording' ? TYPING_TTL_MS : PRESENCE_TTL_MS;
}

/** Baileys' lastKnownPresence → ours (anything unexpected is unknown and not kept). */
export function presenceStatusOf(value: unknown): Exclude<PresenceStatus, 'unknown'> | null {
  return value === 'available' ||
    value === 'unavailable' ||
    value === 'composing' ||
    value === 'recording'
    ? value
    : null;
}

/**
 * In-memory presence of the chats this socket watches, keyed by chat then
 * participant (legacy jids). Cleared on reconnect: a snapshot of the old
 * socket says nothing about now.
 */
export class PresenceCache {
  private chats = new Map<string, Map<string, PresenceEntry>>();

  record(chatId: string, participantId: string, data: unknown, now = Date.now()): boolean {
    const status = presenceStatusOf((data as { lastKnownPresence?: unknown })?.lastKnownPresence);
    if (!chatId || !participantId || !status) return false;
    const lastSeen = Number((data as { lastSeen?: unknown })?.lastSeen);
    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = new Map();
      this.chats.set(chatId, chat);
    }
    const previous = chat.get(participantId);
    chat.set(participantId, {
      status,
      // "last seen" comes with the offline presence; typing keeps what we knew.
      lastSeenSec:
        Number.isFinite(lastSeen) && lastSeen > 0
          ? lastSeen
          : status === 'unavailable'
            ? undefined
            : previous?.lastSeenSec,
      observedAt: now,
    });
    return true;
  }

  /** Fresh entries of a chat (expired ones are dropped on the way). */
  private fresh(chatId: string, now: number): Array<[string, PresenceEntry]> {
    const chat = this.chats.get(chatId);
    if (!chat) return [];
    const out: Array<[string, PresenceEntry]> = [];
    for (const [participant, entry] of Array.from(chat.entries())) {
      if (now - entry.observedAt > ttlOf(entry.status)) chat.delete(participant);
      else out.push([participant, entry]);
    }
    if (!chat.size) this.chats.delete(chatId);
    return out;
  }

  /**
   * Freshest presence among the ids a chat may be keyed under (its PN and LID
   * forms), optionally of one participant (groups). Typing wins over
   * online: it is what the header shows. Each fresh participant is listed.
   */
  read(
    chatIds: string[],
    participantIds: string[] = [],
    now = Date.now()
  ): { presence: PresenceView; participants: PresenceView[] } {
    const wanted = new Set(participantIds);
    const byParticipant = new Map<string, PresenceEntry>();
    for (const chatId of Array.from(new Set(chatIds))) {
      for (const [participant, entry] of this.fresh(chatId, now)) {
        if (wanted.size && !wanted.has(participant)) continue;
        const known = byParticipant.get(participant);
        if (!known || entry.observedAt > known.observedAt) byParticipant.set(participant, entry);
      }
    }
    const views = Array.from(byParticipant.entries())
      .map(([participant, entry]) => viewOf(participant, entry))
      .sort((a, b) => rank(b) - rank(a) || (b.observedAt || '').localeCompare(a.observedAt || ''));
    const subject = participantIds[0] || chatIds[0] || '';
    return {
      presence: views[0] || {
        participantId: subject,
        status: 'unknown',
        lastSeen: null,
        observedAt: null,
      },
      participants: views,
    };
  }

  clear(): void {
    this.chats.clear();
  }

  get size(): number {
    let n = 0;
    for (const chat of Array.from(this.chats.values())) n += chat.size;
    return n;
  }
}

function rank(view: PresenceView): number {
  if (view.status === 'composing' || view.status === 'recording') return 3;
  if (view.status === 'available') return 2;
  return 1;
}

function viewOf(participantId: string, entry: PresenceEntry): PresenceView {
  return {
    participantId,
    status: entry.status,
    lastSeen: entry.lastSeenSec ? new Date(entry.lastSeenSec * 1000).toISOString() : null,
    observedAt: new Date(entry.observedAt).toISOString(),
  };
}

/**
 * What we last sent to each chat, so an operator's keystrokes do not become
 * one WhatsApp node each: the same state to the same chat within
 * PRESENCE_SEND_THROTTLE_MS is answered without going out.
 */
export class PresenceSendThrottle {
  private last = new Map<string, { state: OutgoingPresenceState; at: number }>();

  shouldSend(target: string, state: OutgoingPresenceState, now = Date.now()): boolean {
    const previous = this.last.get(target);
    return !(previous && previous.state === state && now - previous.at < PRESENCE_SEND_THROTTLE_MS);
  }

  sent(target: string, state: OutgoingPresenceState, now = Date.now()): void {
    this.last.set(target, { state, at: now });
    if (this.last.size > 2000) {
      for (const [key, value] of Array.from(this.last.entries())) {
        if (now - value.at > PRESENCE_SEND_THROTTLE_MS) this.last.delete(key);
      }
    }
  }

  clear(): void {
    this.last.clear();
  }
}
