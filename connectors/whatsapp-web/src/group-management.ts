/**
 * WhatsApp group management (fase 3 / PR-6): create a group, change its
 * subject / description / settings, add / remove / promote / demote
 * participants. Ported from the NAS fork (createGroup, updateGroup,
 * updateGroupParticipants, toParticipantJid, the "group capabilities follow
 * the account participant admin role" rule) and adapted to prod.
 *
 * This module holds what does not need the socket:
 *  - input normalisation: group jids (`…@g.us` only, account prefix
 *    stripped) and participants (phone numbers, PN or LID jids);
 *  - what our account may do in a group, from its own participant row (PN or
 *    LID) in fresh metadata — admin / superadmin, `restrict`, `memberAddMode`;
 *  - WhatsApp's per-participant answers (200 / 403 / 408 / 409…) as results;
 *  - the DB side: the conversation row of a group, which the connector writes
 *    from groups.upsert (a group created by us or someone else) and
 *    groups.update (a new subject). Nothing else is stored: WhatsApp keeps the
 *    description, settings and admins; readers ask the connector.
 *
 * Rules (same as chat-state.ts): conversations are addressed by the
 * namespaced id + account_id, a subject lands on the canonical row (merged
 * tombstones followed), and only a client with `ingest` on calls the writers —
 * the per-sub pairing pool never writes.
 */
import { jidNormalizedUser, GroupMetadata, GroupParticipant } from '@whiskeysockets/baileys';
import { accountKey, connectorAccount, getPool, stripAccountKey } from './db-writer';
import { resolveCanonicalConversation } from './chat-state';
import { MessageMutationError, whatsappAccountId } from './message-mutations';
import { normalizePhoneForWhatsApp } from './contact-sync';

/** WhatsApp's own limits (WA Web): subject 100 characters, description 2048. */
export const GROUP_SUBJECT_MAX = 100;
export const GROUP_DESCRIPTION_MAX = 2048;
/**
 * Participants per request. Every add notifies a real person: a typo'd bulk
 * list is capped here, not discovered later. Repeat the call for more.
 */
export const GROUP_PARTICIPANTS_MAX = 50;

export type GroupParticipantAction = 'add' | 'remove' | 'promote' | 'demote';

const PARTICIPANT_ACTIONS: GroupParticipantAction[] = ['add', 'remove', 'promote', 'demote'];

/**
 * A group action refused or failed, with the details the caller needs
 * (per-participant results, what was already applied). Same status /
 * failureClass / code contract as the other mutations.
 */
export class GroupActionError extends MessageMutationError {
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    failureClass: string,
    options: { code?: string; details?: Record<string, unknown> } = {}
  ) {
    super(message, status, failureClass, options.code);
    this.name = 'GroupActionError';
    this.details = options.details;
  }
}

export function normalizeGroupParticipantAction(value: unknown): GroupParticipantAction | null {
  if (typeof value !== 'string') return null;
  const action = value.trim().toLowerCase();
  return (PARTICIPANT_ACTIONS as string[]).includes(action)
    ? (action as GroupParticipantAction)
    : null;
}

/**
 * Raw jid of a group (`123…@g.us`, legacy `123-456@g.us`), account prefix
 * stripped; null for anything else — a direct chat, a broadcast, a channel, a
 * prefix of another account.
 */
export function normalizeGroupJid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const bare = stripAccountKey(value.trim());
  return /^\d+(-\d+)?@g\.us$/.test(bare) ? bare : null;
}

const PHONE_INPUT = /^\+?[\d\s().-]+$/;

/**
 * Baileys jid of a participant given as a phone number (`+34 600 11 22 33`,
 * `0034…`, a 9-digit national number gets WA_DEFAULT_COUNTRY_CODE — as the
 * contact seed does) or as a jid: `@c.us` / `@s.whatsapp.net` → PN
 * (`…@s.whatsapp.net`, device suffix dropped), `@lid` kept. null for anything
 * else (groups, broadcasts, channels, text).
 */
export function toParticipantJid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const input = stripAccountKey(value.trim());
  if (!input) return null;
  if (!input.includes('@')) {
    if (!PHONE_INPUT.test(input)) return null;
    return normalizePhoneForWhatsApp(input)?.rawJid ?? null;
  }
  const [userPart, domain] = input.split('@');
  const user = (userPart || '').split(':')[0];
  if (domain === 'c.us' || domain === 's.whatsapp.net') {
    return /^\d{6,15}$/.test(user) ? `${user}@s.whatsapp.net` : null;
  }
  if (domain === 'lid') return /^\d+$/.test(user) ? `${user}@lid` : null;
  return null;
}

/** Legacy form of a participant jid (`@c.us` / `@lid`), what the DB and the API use. */
export function participantApiJid(jid: string): string {
  return jid.endsWith('@s.whatsapp.net') ? jid.replace(/@s\.whatsapp\.net$/, '@c.us') : jid;
}

function normalizedOrNull(jid: string | null | undefined): string | null {
  if (!jid) return null;
  try {
    return jidNormalizedUser(jid) || null;
  } catch {
    return null;
  }
}

/** Every id WhatsApp may use for this participant (id, PN, LID), normalised. */
export function participantIds(p: GroupParticipant): string[] {
  return [p.id, p.phoneNumber, p.lid]
    .map(id => normalizedOrNull(id))
    .filter((id): id is string => !!id);
}

/** The participant of `meta` a jid (PN or LID) stands for, if it is a member. */
export function findParticipant(
  meta: GroupMetadata,
  jid: string | null | undefined
): GroupParticipant | undefined {
  const wanted = normalizedOrNull(jid);
  if (!wanted) return undefined;
  return (meta.participants || []).find(p => participantIds(p).includes(wanted));
}

/**
 * Whether a group-participants.update names this account: its participants
 * (a jid, or {id, phoneNumber, lid}) matched against our PN / LID ids.
 */
export function participantsIncludeOwn(
  participants: ReadonlyArray<string | Partial<GroupParticipant> | null | undefined>,
  ownIds: Iterable<string>
): boolean {
  const own = new Set(
    Array.from(ownIds)
      .map(id => normalizedOrNull(id))
      .filter((id): id is string => !!id)
  );
  if (!own.size) return false;
  return (participants || []).some(p => {
    const ids = typeof p === 'string' ? [p] : p ? [p.id, p.phoneNumber, p.lid] : [];
    return ids.some(id => {
      const normalized = normalizedOrNull(id);
      return !!normalized && own.has(normalized);
    });
  });
}

/** Our own participant row in `meta` (matched by any of our PN / LID ids). */
export function ownParticipant(
  meta: GroupMetadata,
  ownIds: Iterable<string>
): GroupParticipant | undefined {
  const own = new Set(
    Array.from(ownIds)
      .map(id => normalizedOrNull(id))
      .filter((id): id is string => !!id)
  );
  if (!own.size) return undefined;
  return (meta.participants || []).find(p => participantIds(p).some(id => own.has(id)));
}

export function isAdminRole(admin: unknown): boolean {
  return admin === 'admin' || admin === 'superadmin';
}

export interface GroupCapabilities {
  /** Our account is a participant. */
  isMember: boolean;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  /** Subject and description: admins, or everyone when the group is not `restrict`ed. */
  editInfo: boolean;
  /** announce / restrict: admins only. */
  changeSettings: boolean;
  /** Add: admins, or every member when WhatsApp's member-add mode is on. */
  addParticipants: boolean;
  /** Remove / promote / demote: admins only. */
  manageParticipants: boolean;
}

/**
 * What our account may do in a group, from its participant row. Communities
 * (the parent and its announcement group) are managed through the community:
 * nothing here.
 */
export function groupCapabilities(
  meta: GroupMetadata,
  self: GroupParticipant | undefined
): GroupCapabilities {
  const isMember = !!self;
  const isAdmin = isMember && isAdminRole(self?.admin);
  const community = isCommunityGroup(meta);
  return {
    isMember,
    isAdmin,
    isSuperAdmin: isMember && self?.admin === 'superadmin',
    editInfo: !community && isMember && (isAdmin || meta.restrict !== true),
    changeSettings: !community && isAdmin,
    addParticipants: !community && isMember && (isAdmin || meta.memberAddMode === true),
    manageParticipants: !community && isAdmin,
  };
}

export function isCommunityGroup(meta: GroupMetadata): boolean {
  return meta.isCommunity === true || meta.isCommunityAnnounce === true;
}

/** Whether `capabilities` allow a participant action. */
export function allowsParticipantAction(
  capabilities: GroupCapabilities,
  action: GroupParticipantAction
): boolean {
  return action === 'add' ? capabilities.addParticipants : capabilities.manageParticipants;
}

/** One participant of a create / participants call, as reported to the caller. */
export interface GroupParticipantResult {
  /** What the caller sent. */
  participant: string;
  /** The jid it went to WhatsApp as (legacy `@c.us` / `@lid`). */
  jid: string;
  /** WhatsApp's per-participant code ('200', '403', '408', '409'…); null when it gave none. */
  status: string | null;
  ok: boolean;
  reason: string;
}

const DONE: Record<GroupParticipantAction, string> = {
  add: 'added',
  remove: 'removed',
  promote: 'promoted',
  demote: 'demoted',
};

/**
 * WhatsApp's per-participant code of groupParticipantsUpdate as a reason.
 * 403 on add = their privacy settings only allow an invite; 408 = they left
 * recently and cannot be re-added yet; 409 = already in (add) / conflict.
 */
export function participantOutcome(
  action: GroupParticipantAction,
  status: string | null | undefined
): { ok: boolean; reason: string } {
  const code = status === null || status === undefined ? '' : String(status);
  if (code === '200') return { ok: true, reason: DONE[action] };
  switch (code) {
    case '400':
      return { ok: false, reason: 'bad_request' };
    case '401':
      return { ok: false, reason: 'not_authorized' };
    case '403':
      return { ok: false, reason: action === 'add' ? 'invite_required' : 'forbidden' };
    case '404':
      return { ok: false, reason: action === 'add' ? 'not_on_whatsapp' : 'not_a_participant' };
    case '406':
      return { ok: false, reason: 'not_allowed' };
    case '408':
      return { ok: false, reason: 'recently_left' };
    case '409':
      return { ok: false, reason: action === 'add' ? 'already_participant' : 'conflict' };
    case '':
      return { ok: false, reason: 'no_answer' };
    default:
      return { ok: false, reason: 'failed' };
  }
}

// ---------------------------------------------------------------------------
// Invites: people WhatsApp would not add (403 = their privacy only allows an
// invite)
// ---------------------------------------------------------------------------

/**
 * People invited per POST /groups/invite. Each invite is a private message to
 * a real person who did not choose to be added: a smaller cap than the add.
 */
export const GROUP_INVITES_MAX = 20;
/** Caption of an invite card (WA Web shows about a paragraph). */
export const GROUP_INVITE_TEXT_MAX = 1024;
/** Card expiry of an invite built from the group link (WhatsApp's private ones last 3 days). */
export const LINK_INVITE_TTL_SECONDS = 3 * 24 * 60 * 60;

/**
 * The private invite WhatsApp hands back with a 403 on add: the participant
 * node carries `<add_request code=… expiration=…/>`, a code valid for that
 * person only (what WhatsApp's own "invite to group" sends them).
 */
export interface AddRequest {
  code: string;
  /** Unix seconds; null when WhatsApp gave none. */
  expiration: number | null;
}

/** The `<add_request>` of a groupParticipantsUpdate answer entry (its `content` node). */
export function addRequestOf(content: unknown): AddRequest | null {
  const children = (content as { content?: unknown } | null)?.content;
  if (!Array.isArray(children)) return null;
  const node = children.find(
    (child: unknown) => (child as { tag?: unknown } | null)?.tag === 'add_request'
  ) as { attrs?: Record<string, unknown> } | undefined;
  const code = node?.attrs?.code;
  if (typeof code !== 'string' || !code) return null;
  const expiration = Number(node?.attrs?.expiration);
  return {
    code,
    expiration: Number.isFinite(expiration) && expiration > 0 ? Math.floor(expiration) : null,
  };
}

/** One person of an add WhatsApp refused with 403: send them an invite instead. */
export interface InviteRequiredEntry {
  /** What the caller sent. */
  participant: string;
  /** Legacy jid (`…@c.us` / `…@lid`) the add went to. */
  jid: string;
  /** WhatsApp gave a private invite for them (POST /groups/invite uses it). */
  privateInvite: boolean;
  /** When that private invite expires (ISO); null without one. */
  inviteExpiresAt: string | null;
}

/** One person of POST /groups/invite, as reported to the caller. */
export interface GroupInviteResult {
  participant: string;
  /** Legacy jid of the chat the invite went to. */
  jid: string;
  ok: boolean;
  /** invited | already_participant | send_failed | invite_link_unavailable */
  reason: string;
  /** private = WhatsApp's per-person code from the refused add; link = the group's link. */
  invite: 'private' | 'link' | null;
  messageId: string | null;
}

/** Optional caption of an invite card: a string up to GROUP_INVITE_TEXT_MAX, else 400. */
export function parseGroupInviteText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > GROUP_INVITE_TEXT_MAX) {
    throw new GroupActionError(
      `text must be a string of at most ${GROUP_INVITE_TEXT_MAX} characters`,
      400,
      'invalid_request'
    );
  }
  return value.trim() || undefined;
}

/** Participants of an invite: as for an add (phones, PN / LID jids), at most GROUP_INVITES_MAX. */
export function parseGroupInviteParticipants(value: unknown): ParticipantInput[] {
  if (Array.isArray(value) && value.length > GROUP_INVITES_MAX) {
    throw new GroupActionError(
      `At most ${GROUP_INVITES_MAX} people per invite request`,
      400,
      'invalid_request'
    );
  }
  return parseGroupParticipants(value);
}

// ---------------------------------------------------------------------------
// Request bodies → values (400 invalid_request before anything goes out)
// ---------------------------------------------------------------------------

function invalid(message: string, details?: Record<string, unknown>): GroupActionError {
  return new GroupActionError(message, 400, 'invalid_request', { details });
}

/** Raw group jid of a request, or 400 (a direct chat is not a group). */
export function parseGroupJid(value: unknown): string {
  const raw = normalizeGroupJid(value);
  if (!raw) {
    throw invalid(
      `A group jid (…@g.us) is required${typeof value === 'string' && value.trim() ? `; ${value.trim().slice(0, 80)} is not one` : ''}`
    );
  }
  return raw;
}

/** Subject: 1–100 characters once trimmed. */
export function parseGroupSubject(value: unknown): string {
  const subject = typeof value === 'string' ? value.trim() : '';
  if (!subject) throw invalid('subject must be a non-empty string');
  if (Array.from(subject).length > GROUP_SUBJECT_MAX) {
    throw invalid(`subject is at most ${GROUP_SUBJECT_MAX} characters`);
  }
  return subject;
}

/** Description: at most 2048 characters; '' (or only spaces) removes it. */
export function parseGroupDescription(value: unknown): string {
  if (typeof value !== 'string') throw invalid('description must be a string ("" removes it)');
  const description = value.trim();
  if (Array.from(description).length > GROUP_DESCRIPTION_MAX) {
    throw invalid(`description is at most ${GROUP_DESCRIPTION_MAX} characters`);
  }
  return description;
}

export interface GroupSettings {
  /** Only admins send messages. */
  announce?: boolean;
  /** Only admins edit the subject, description and picture. */
  restrict?: boolean;
}

export function parseGroupSettings(value: unknown): GroupSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('settings must be an object {announce?: boolean, restrict?: boolean}');
  }
  const settings: GroupSettings = {};
  for (const [name, flag] of Object.entries(value as Record<string, unknown>)) {
    if (name !== 'announce' && name !== 'restrict') {
      throw invalid(`Unknown group setting ${name.slice(0, 40)} (announce, restrict)`);
    }
    if (typeof flag !== 'boolean') throw invalid(`settings.${name} must be a boolean`);
    settings[name] = flag;
  }
  return settings;
}

export interface GroupUpdate {
  subject?: string;
  description?: string;
  settings?: GroupSettings;
}

/** {subject?, description?, settings?} with at least one change asked for. */
export function parseGroupUpdate(body: Record<string, unknown>): GroupUpdate {
  const update: GroupUpdate = {};
  if (body.subject !== undefined && body.subject !== null) {
    update.subject = parseGroupSubject(body.subject);
  }
  if (body.description !== undefined && body.description !== null) {
    update.description = parseGroupDescription(body.description);
  }
  if (body.settings !== undefined && body.settings !== null) {
    const settings = parseGroupSettings(body.settings);
    if (Object.keys(settings).length) update.settings = settings;
  }
  if (!Object.keys(update).length) {
    throw invalid('Nothing to update: pass subject, description and / or settings');
  }
  return update;
}

export interface ParticipantInput {
  /** What the caller sent (trimmed). */
  input: string;
  /** Baileys jid (`…@s.whatsapp.net` or `…@lid`). */
  jid: string;
}

/**
 * 1–50 participants, each a phone number or a PN / LID jid, deduplicated by
 * jid. Any entry that is none of those rejects the whole request (400), so a
 * half-understood list never reaches WhatsApp.
 */
export function parseGroupParticipants(value: unknown): ParticipantInput[] {
  if (!Array.isArray(value) || !value.length) {
    throw invalid('participants must be a non-empty array of phone numbers or jids');
  }
  if (value.length > GROUP_PARTICIPANTS_MAX) {
    throw invalid(`At most ${GROUP_PARTICIPANTS_MAX} participants per request`);
  }
  const seen = new Set<string>();
  const participants: ParticipantInput[] = [];
  const rejected: string[] = [];
  for (const entry of value) {
    const jid = toParticipantJid(entry);
    if (!jid) {
      rejected.push(String(entry ?? '').slice(0, 80));
      continue;
    }
    if (seen.has(jid)) continue;
    seen.add(jid);
    participants.push({ input: String(entry).trim(), jid });
  }
  if (rejected.length) {
    throw invalid(
      `Not a phone number or a user jid (…@c.us, …@s.whatsapp.net, …@lid): ${rejected.slice(0, 5).join(', ')}`,
      { invalid: rejected.slice(0, 10) }
    );
  }
  return participants;
}

// ---------------------------------------------------------------------------
// What the API returns about a group
// ---------------------------------------------------------------------------

export interface GroupParticipantView {
  /** Legacy jid (`…@c.us` or `…@lid`) WhatsApp addresses them by in this group. */
  jid: string;
  /** E.164 when WhatsApp shares it, else null. */
  phone: string | null;
  lid: string | null;
  /** In-memory name (push name / contact), null when unknown; readers add theirs. */
  name: string | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  isSelf: boolean;
}

export interface GroupStateView {
  /** Legacy group jid (`…@g.us`). */
  groupId: string;
  subject: string;
  description: string;
  announce: boolean;
  restrict: boolean;
  memberAddMode: boolean;
  community: boolean;
  size: number;
  createdAt: string | null;
  owner: string | null;
  capabilities: GroupCapabilities;
  participants: GroupParticipantView[];
}

function phoneOf(p: GroupParticipant): string | null {
  for (const id of [p.phoneNumber, p.id]) {
    const jid = normalizedOrNull(id);
    if (jid && jid.endsWith('@s.whatsapp.net')) return `+${jid.split('@')[0]}`;
  }
  return null;
}

function lidOf(p: GroupParticipant): string | null {
  for (const id of [p.lid, p.id]) {
    const jid = normalizedOrNull(id);
    if (jid && jid.endsWith('@lid')) return jid;
  }
  return null;
}

export function groupStateView(
  meta: GroupMetadata,
  self: GroupParticipant | undefined,
  nameOf: (p: GroupParticipant) => string | null = (): null => null
): GroupStateView {
  const participants = meta.participants || [];
  return {
    groupId: meta.id,
    subject: meta.subject || '',
    description: meta.desc || '',
    announce: meta.announce === true,
    restrict: meta.restrict === true,
    memberAddMode: meta.memberAddMode === true,
    community: isCommunityGroup(meta),
    size: participants.length || Number(meta.size) || 0,
    createdAt: creationDate(meta.creation)?.toISOString() ?? null,
    owner: meta.owner ? participantApiJid(normalizedOrNull(meta.owner) || meta.owner) : null,
    capabilities: groupCapabilities(meta, self),
    participants: participants.map(p => ({
      jid: participantApiJid(normalizedOrNull(p.id) || p.id),
      phone: phoneOf(p),
      lid: lidOf(p),
      name: nameOf(p) || p.notify || p.name || null,
      isAdmin: isAdminRole(p.admin),
      isSuperAdmin: p.admin === 'superadmin',
      isSelf: p === self,
    })),
  };
}

export function countResults(results: GroupParticipantResult[]): {
  succeeded: number;
  failed: number;
} {
  const succeeded = results.filter(r => r.ok).length;
  return { succeeded, failed: results.length - succeeded };
}

// ---------------------------------------------------------------------------
// DB side (ingest only)
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function creationDate(creation: unknown): Date | null {
  const seconds = Number(creation);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

function participantCountOf(meta: Partial<GroupMetadata>): number | null {
  if (Array.isArray(meta.participants) && meta.participants.length) {
    return meta.participants.length;
  }
  const size = Number(meta.size);
  return Number.isFinite(size) && size > 0 ? size : null;
}

/**
 * The conversation row of a group WhatsApp told us about (groups.upsert: we
 * created it, or someone created it with us in it; group-participants.update:
 * someone added us to an existing group). Inserted under the namespaced id
 * with account_id / external_id; an existing live row only gets the subject
 * and size — never last_message_at, never a tombstone. A new row's
 * last_message_at is `activityAt` (when we joined), else the group's creation
 * (else now). Returns the conversations.id written, undefined when nothing was.
 */
export async function recordGroupConversation(
  meta: Partial<GroupMetadata>,
  options: { activityAt?: Date } = {}
): Promise<string | undefined> {
  const groupJid = normalizeGroupJid(meta.id);
  if (!groupJid) return undefined;
  const subject = typeof meta.subject === 'string' && meta.subject.trim() ? meta.subject : null;
  const result = await getPool().query(
    `INSERT INTO conversations
       (id, name, is_group, participant_count, last_message_at, account, account_id, external_id)
     VALUES ($1, $2, TRUE, COALESCE($3, 0), COALESCE($4::timestamptz, now()), $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, conversations.name),
       participant_count = COALESCE($3, conversations.participant_count),
       updated_at = now()
     WHERE conversations.merged_into IS NULL
     RETURNING id`,
    [
      accountKey(groupJid),
      subject,
      participantCountOf(meta),
      options.activityAt || creationDate(meta.creation),
      connectorAccount(),
      whatsappAccountId(),
      groupJid,
    ]
  );
  const id = result.rows[0]?.id;
  return id ? String(id) : undefined;
}

/**
 * A group's new subject and / or size on its canonical conversation
 * (groups.update, or our own POST /groups/update | /groups/participants once
 * WhatsApp accepted it). Only when it differs; a group without a row is left
 * alone (the first message or groups.upsert creates it). Returns whether a row
 * changed.
 */
export async function recordGroupChange(
  groupId: string,
  change: { subject?: string | null; participantCount?: number | null }
): Promise<boolean> {
  const groupJid = normalizeGroupJid(groupId);
  if (!groupJid) return false;
  const subject =
    typeof change.subject === 'string' && change.subject.trim() ? change.subject : undefined;
  const size =
    typeof change.participantCount === 'number' && change.participantCount > 0
      ? change.participantCount
      : undefined;
  if (subject === undefined && size === undefined) return false;
  const conversation = await resolveCanonicalConversation(groupJid);
  if (!conversation) return false;
  const params: unknown[] = [conversation.id, whatsappAccountId()];
  const sets: string[] = [];
  const differs: string[] = [];
  if (subject !== undefined) {
    params.push(subject);
    sets.push(`name = $${params.length}`);
    differs.push(`name IS DISTINCT FROM $${params.length}`);
  }
  if (size !== undefined) {
    params.push(size);
    sets.push(`participant_count = $${params.length}`);
    differs.push(`participant_count IS DISTINCT FROM $${params.length}`);
  }
  const result = await getPool().query(
    `UPDATE conversations SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $1 AND account_id = $2 AND merged_into IS NULL
        AND (${differs.join(' OR ')})`,
    params
  );
  return (result.rowCount || 0) > 0;
}

/** groups.upsert / groups.update of the socket: record, never throw. */
export async function recordInboundGroup(
  kind: 'upsert' | 'update',
  meta: Partial<GroupMetadata>
): Promise<void> {
  try {
    if (kind === 'upsert') {
      await recordGroupConversation(meta);
    } else if (meta.id) {
      // A stub-driven update carries one field; a groupFetchAllParticipating
      // refresh carries the whole metadata, participants included.
      await recordGroupChange(meta.id, {
        subject: meta.subject,
        participantCount: Array.isArray(meta.participants) ? meta.participants.length : undefined,
      });
    }
  } catch (error) {
    console.warn(`group ${kind} persist failed for ${meta.id}: ${describeError(error)}`);
  }
}
