/**
 * WhatsApp communities (fase 3 follow-up): list the account's communities
 * with their linked groups and announcement group, read one, create one, link
 * / unlink a group, leave. Ported from the NAS fork (novedades-communities.ts,
 * 3f4103f "leer comunidades con el parser de grupos de Baileys": its
 * read-back confirmation of every write) and adapted to prod (ids in the
 * signed body, the sending gate, `{error, failureClass}`, the admin checks of
 * group-management.ts against fresh metadata).
 *
 * What Baileys 7.0.0-rc13 does (Socket/communities.js, Socket/groups.js):
 *  - A community is a parent group (`<parent>` → `isCommunity`) whose linked
 *    groups carry `<linked_parent jid=…>` (`linkedParent`); its announcement
 *    group also carries `<default_sub_group>` (`isCommunityAnnounce`).
 *  - `communityMetadata` / `communityFetchAllParticipating` parse a
 *    `<community>` node, but WhatsApp answers `<group>` (with `<parent>`): they
 *    come back empty or throw. So reads go through the group parser:
 *    `groupFetchAllParticipating()` (every group we are in, communities and
 *    their groups included) and `groupMetadata(jid)`.
 *  - `communityFetchLinkedGroups(jid)` (`<sub_groups>`) lists every group of
 *    the community, also those this account is not in (id, subject, size,
 *    creation; no announcement marker).
 *  - `communityCreate(subject, body)` creates the parent (members ask to join,
 *    a "general" group is created with it) and answers its metadata, or null
 *    when its own re-read failed. `communityLinkGroup` / `communityUnlinkGroup`
 *    / `communityLeave` answer nothing: every write is proven by reading back.
 *  - Leaving a community also leaves its announcement group (WhatsApp).
 *
 * Nothing is stored: the parent of a community has no chat, and the groups
 * keep the conversation rows group-management.ts already writes.
 */
import type { GroupMetadata, GroupParticipant } from '@whiskeysockets/baileys';
import { stripAccountKey } from './db-writer';
import {
  GROUP_DESCRIPTION_MAX,
  GROUP_SUBJECT_MAX,
  GroupActionError,
  isAdminRole,
  normalizeGroupJid,
  participantApiJid,
} from './group-management';

export type CommunityGroupAction = 'link' | 'unlink';

/**
 * A community request refused or failed, in the house shape (status +
 * failureClass, details spread into the answer like a group action's).
 */
export class CommunityActionError extends GroupActionError {
  constructor(
    message: string,
    status: number,
    failureClass: string,
    options: { code?: string; details?: Record<string, unknown> } = {}
  ) {
    super(message, status, failureClass, options);
    this.name = 'CommunityActionError';
  }
}

function invalid(message: string): CommunityActionError {
  return new CommunityActionError(message, 400, 'invalid_request');
}

// ---------------------------------------------------------------------------
// Request bodies → values (400 invalid_request before anything goes out)
// ---------------------------------------------------------------------------

/** Raw jid of a community (its parent group, `…@g.us`), or 400. */
export function parseCommunityJid(value: unknown, field = 'communityId'): string {
  const raw = normalizeGroupJid(value);
  if (!raw) {
    const given = typeof value === 'string' ? stripAccountKey(value.trim()).slice(0, 80) : '';
    throw invalid(
      `${field} must be a community jid (…@g.us)${given ? `; ${given} is not one` : ''}`
    );
  }
  return raw;
}

/** Subject of a new community: 1–100 characters once trimmed. */
export function parseCommunitySubject(value: unknown): string {
  const subject = typeof value === 'string' ? value.trim() : '';
  if (!subject) throw invalid('subject must be a non-empty string');
  if (Array.from(subject).length > GROUP_SUBJECT_MAX) {
    throw invalid(`subject is at most ${GROUP_SUBJECT_MAX} characters`);
  }
  return subject;
}

/** Optional description of a new community: at most 2048 characters. */
export function parseCommunityDescription(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw invalid('description must be a string');
  const description = value.trim();
  if (Array.from(description).length > GROUP_DESCRIPTION_MAX) {
    throw invalid(`description is at most ${GROUP_DESCRIPTION_MAX} characters`);
  }
  return description;
}

export function parseCommunityGroupAction(value: unknown): CommunityGroupAction {
  const action = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (action !== 'link' && action !== 'unlink') throw invalid('action must be link or unlink');
  return action;
}

export interface CommunityGroupRequest {
  communityId: string;
  groupId: string;
  action: CommunityGroupAction;
}

/** {communityId, groupId, action: link|unlink}; a community never links itself. */
export function parseCommunityGroupRequest(body: Record<string, unknown>): CommunityGroupRequest {
  const communityId = parseCommunityJid(body.communityId);
  const groupId = parseCommunityJid(body.groupId, 'groupId');
  const action = parseCommunityGroupAction(body.action);
  if (groupId === communityId) throw invalid('A community cannot be linked to itself');
  return { communityId, groupId, action };
}

/** Leaving is irreversible from here (WhatsApp asks to be re-invited): confirm: true. */
export function requireLeaveConfirmation(body: Record<string, unknown>): void {
  if (body.confirm !== true) {
    throw invalid('confirm must be true: leaving a community also leaves its announcement group');
  }
}

// ---------------------------------------------------------------------------
// What the API returns about a community
// ---------------------------------------------------------------------------

/** One group of a community (`<sub_groups>` entry or a participating group). */
export interface CommunityGroupView {
  /** `…@g.us`. */
  groupId: string;
  subject: string;
  size: number | null;
  createdAt: string | null;
  /** This account is a participant (it is among the groups it is in). */
  joined: boolean;
  /** Our admin role there; false when not joined. */
  isAdmin: boolean;
}

export interface CommunityCapabilities {
  isMember: boolean;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  /** Link a group: community admins (and admins of that group). */
  linkGroups: boolean;
  /** Unlink a group: community admins. */
  unlinkGroups: boolean;
  /** Any member may leave. */
  leave: boolean;
}

export interface CommunityView {
  /** `…@g.us` of the parent group. */
  communityId: string;
  subject: string;
  description: string;
  /** Members of the community (WhatsApp's size, else its participant count). */
  size: number;
  createdAt: string | null;
  owner: string | null;
  capabilities: CommunityCapabilities;
  /** The group only admins post to; every member is in it. */
  announcementGroup: CommunityGroupView | null;
  linkedGroups: CommunityGroupView[];
  /**
   * true = linkedGroups is WhatsApp's full list (`<sub_groups>`); false = it
   * could not be read and only the groups this account is in are listed.
   */
  linkedGroupsComplete: boolean;
}

/** What WhatsApp's `<sub_groups>` gives for one group. */
export interface LinkedGroupEntry {
  id?: string;
  subject?: string;
  creation?: number;
  size?: number;
}

function creationIso(creation: unknown): string | null {
  const seconds = Number(creation);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function sizeOf(meta: Partial<GroupMetadata>): number {
  const size = Number(meta.size);
  if (Number.isFinite(size) && size > 0) return size;
  return Array.isArray(meta.participants) ? meta.participants.length : 0;
}

export function isCommunityParent(meta: Partial<GroupMetadata> | null | undefined): boolean {
  return meta?.isCommunity === true;
}

export function communityCapabilities(self: GroupParticipant | undefined): CommunityCapabilities {
  const isMember = !!self;
  const isAdmin = isMember && isAdminRole(self?.admin);
  return {
    isMember,
    isAdmin,
    isSuperAdmin: isMember && self?.admin === 'superadmin',
    linkGroups: isAdmin,
    unlinkGroups: isAdmin,
    leave: isMember,
  };
}

/**
 * The groups of `communityId` among `participating` (every group this account
 * is in): its announcement group and the rest, by `linkedParent`.
 */
export function joinedGroupsOf(
  communityId: string,
  participating: Iterable<GroupMetadata>
): { announcement: GroupMetadata | null; groups: GroupMetadata[] } {
  let announcement: GroupMetadata | null = null;
  const groups: GroupMetadata[] = [];
  for (const meta of participating) {
    if (meta.linkedParent !== communityId || meta.id === communityId) continue;
    if (meta.isCommunityAnnounce === true) announcement = meta;
    else groups.push(meta);
  }
  return { announcement, groups };
}

/**
 * The view of one community. `ownParticipantOf` finds our participant row in
 * a group's metadata (PN or LID); `linked` is WhatsApp's `<sub_groups>` list,
 * null when it could not be read (then only the joined groups are listed).
 */
export function communityView(
  meta: GroupMetadata,
  participating: Iterable<GroupMetadata>,
  linked: LinkedGroupEntry[] | null,
  ownParticipantOf: (meta: GroupMetadata) => GroupParticipant | undefined
): CommunityView {
  const communityId = meta.id;
  const joined = joinedGroupsOf(communityId, participating);
  const joinedById = new Map<string, GroupMetadata>();
  for (const group of [...joined.groups, ...(joined.announcement ? [joined.announcement] : [])]) {
    joinedById.set(group.id, group);
  }
  const groupView = (
    id: string,
    fallback: { subject?: string; size?: number; creation?: number }
  ): CommunityGroupView => {
    const mine = joinedById.get(id);
    const self = mine ? ownParticipantOf(mine) : undefined;
    const size = mine ? sizeOf(mine) : Number(fallback.size);
    return {
      groupId: id,
      subject: mine?.subject || fallback.subject || '',
      size: Number.isFinite(size) && size > 0 ? size : null,
      createdAt: creationIso(mine?.creation ?? fallback.creation),
      joined: !!self,
      isAdmin: !!self && isAdminRole(self.admin),
    };
  };
  const announcementId = joined.announcement?.id ?? null;
  const linkedGroups: CommunityGroupView[] = [];
  const seen = new Set<string>();
  if (linked) {
    for (const entry of linked) {
      const id = normalizeGroupJid(entry.id);
      if (!id || id === communityId || id === announcementId || seen.has(id)) continue;
      seen.add(id);
      linkedGroups.push(groupView(id, entry));
    }
  }
  for (const group of joined.groups) {
    if (seen.has(group.id)) continue;
    seen.add(group.id);
    linkedGroups.push(groupView(group.id, group));
  }
  return {
    communityId,
    subject: meta.subject || '',
    description: meta.desc || '',
    size: sizeOf(meta),
    createdAt: creationIso(meta.creation),
    owner: meta.owner ? participantApiJid(meta.owner) : null,
    capabilities: communityCapabilities(ownParticipantOf(meta)),
    announcementGroup: joined.announcement
      ? groupView(joined.announcement.id, joined.announcement)
      : null,
    linkedGroups,
    linkedGroupsComplete: !!linked,
  };
}

/**
 * Whether a link / unlink is in place, from fresh metadata of the group
 * (linkedParent) or, without it, from the community's `<sub_groups>` list.
 */
export function isLinkedTo(
  communityId: string,
  groupId: string,
  evidence: { group?: Partial<GroupMetadata> | null; linked?: LinkedGroupEntry[] | null }
): boolean | null {
  if (evidence.group) return evidence.group.linkedParent === communityId;
  if (evidence.linked) {
    return evidence.linked.some(entry => normalizeGroupJid(entry.id) === groupId);
  }
  return null;
}
