import { jidNormalizedUser, type GroupMetadata, type WASocket } from '@whiskeysockets/baileys';

export class CommunityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'CommunityError';
  }
}

export interface Community {
  id: string;
  name: string;
  description: string;
  participantCount: number;
  createdAt: number | null;
  capabilities: { editInfo: boolean; manageGroups: boolean; leave: boolean };
}

function invalid(message: string): never {
  throw new CommunityError('INVALID_COMMUNITY_INPUT', message, 400);
}

function groupJid(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+(?:-\d+)?@g\.us$/.test(value)) {
    invalid('A bare WhatsApp group JID is required');
  }
  return value;
}

function inputObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('An object is required');
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number, empty = false): string {
  if (typeof value !== 'string') invalid(`${field} must be a string`);
  const clean = value.trim();
  if ((!empty && !clean) || [...clean].length > max) invalid(`Invalid ${field}`);
  return clean;
}

function providerMetadata(meta: GroupMetadata | null, expectedId?: string): GroupMetadata {
  if (
    !meta ||
    typeof meta.id !== 'string' ||
    !/^\d+(?:-\d+)?@g\.us$/.test(meta.id) ||
    typeof meta.subject !== 'string' ||
    !Array.isArray(meta.participants) ||
    (expectedId && meta.id !== expectedId)
  ) {
    throw new CommunityError(
      'INVALID_PROVIDER_RESPONSE',
      'WhatsApp returned incomplete community metadata',
      502
    );
  }
  return meta;
}

/** Bound to one socket; no process-global account or membership cache. */
export class CommunityService {
  constructor(private readonly socket: WASocket) {}

  private async membership(meta: GroupMetadata) {
    const ownPn = this.socket.user?.id && jidNormalizedUser(this.socket.user.id);
    const ownLid =
      this.socket.user?.lid ||
      (ownPn ? await this.socket.signalRepository?.lidMapping?.getLIDForPN(ownPn) : undefined);
    const ids = new Set([ownPn, ownLid].filter((id): id is string => !!id).map(jidNormalizedUser));
    const self = meta.participants.find(p =>
      [p.id, p.phoneNumber].some(id => !!id && ids.has(jidNormalizedUser(id)))
    );
    return { member: !!self, admin: self?.admin === 'admin' || self?.admin === 'superadmin' };
  }

  private async publicMetadata(meta: GroupMetadata): Promise<Community> {
    const { member, admin } = await this.membership(meta);
    return {
      id: meta.id,
      name: meta.subject,
      description: meta.desc || '',
      participantCount: typeof meta.size === 'number' ? meta.size : meta.participants.length,
      createdAt: typeof meta.creation === 'number' ? meta.creation : null,
      capabilities: { editInfo: admin, manageGroups: admin, leave: member },
    };
  }

  private async metadata(jid: string): Promise<GroupMetadata> {
    // rc13 communityMetadata expects <community>, but WhatsApp returns <group>
    // with a <parent> marker, including the PN/LID participant fields.
    const meta = providerMetadata(await this.socket.groupMetadata(groupJid(jid)), jid);
    if (meta.isCommunity !== true) {
      throw new CommunityError('NOT_A_COMMUNITY', 'This group is not a community', 400);
    }
    return meta;
  }

  async list(): Promise<Community[]> {
    // Both rc13 methods send the same IQ; only the group parser reads <groups>.
    const result = await this.socket.groupFetchAllParticipating();
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new CommunityError(
        'INVALID_PROVIDER_RESPONSE',
        'WhatsApp returned an invalid community list',
        502
      );
    }
    const communities: Community[] = [];
    for (const item of Object.values(result)) {
      const meta = providerMetadata(item);
      if (meta.isCommunity === true) communities.push(await this.publicMetadata(meta));
    }
    return communities;
  }

  async detail(jid: string) {
    const meta = await this.metadata(jid);
    const result = await this.socket.communityFetchLinkedGroups(jid);
    if (!result || result.communityJid !== jid || !Array.isArray(result.linkedGroups)) {
      throw new CommunityError(
        'INVALID_PROVIDER_RESPONSE',
        'WhatsApp returned incomplete linked groups',
        502
      );
    }
    const linkedGroups = result.linkedGroups.map(item => {
      if (!item.id || !/^\d+(?:-\d+)?@g\.us$/.test(item.id) || typeof item.subject !== 'string') {
        throw new CommunityError(
          'INVALID_PROVIDER_RESPONSE',
          'WhatsApp returned an invalid linked group',
          502
        );
      }
      return {
        id: item.id,
        name: item.subject,
        participantCount: typeof item.size === 'number' ? item.size : null,
        createdAt: typeof item.creation === 'number' ? item.creation : null,
      };
    });
    return { community: await this.publicMetadata(meta), linkedGroups };
  }

  async create(input: unknown): Promise<Community> {
    const body = inputObject(input);
    const subject = text(body.subject, 'subject', 100);
    const description =
      body.description === undefined ? '' : text(body.description, 'description', 2048, true);
    const result = providerMetadata(await this.socket.communityCreate(subject, description));
    if (result.isCommunity !== true) {
      throw new CommunityError(
        'INVALID_PROVIDER_RESPONSE',
        'WhatsApp did not return a community',
        502
      );
    }
    return this.publicMetadata(result);
  }

  async action(jid: string, input: unknown): Promise<{ action: string; communityId: string }> {
    groupJid(jid);
    const body = inputObject(input);
    const action = body.action;
    if (!['subject', 'description', 'link', 'unlink', 'leave'].includes(String(action)))
      invalid('Invalid community action');
    const subject = action === 'subject' ? text(body.subject, 'subject', 100) : undefined;
    const description =
      action === 'description' ? text(body.description, 'description', 2048, true) : undefined;
    const target = action === 'link' || action === 'unlink' ? groupJid(body.groupJid) : undefined;
    const meta = await this.metadata(jid);
    const membership = await this.membership(meta);
    if (action === 'leave' ? !membership.member : !membership.admin) {
      throw new CommunityError(
        'COMMUNITY_FORBIDDEN',
        'Your WhatsApp account lacks permission for this action',
        403
      );
    }
    if (target) {
      const group = providerMetadata(await this.socket.groupMetadata(target), target);
      if (target === jid || group.isCommunity || group.isCommunityAnnounce)
        invalid('Only ordinary groups can be linked or unlinked');
      if (!(await this.membership(group)).admin) {
        throw new CommunityError(
          'COMMUNITY_FORBIDDEN',
          'Your WhatsApp account must administer the linked group',
          403
        );
      }
      if (action === 'link' ? !!group.linkedParent : group.linkedParent !== jid) {
        throw new CommunityError(
          'COMMUNITY_LINK_CONFLICT',
          'The group has an incompatible community link',
          409
        );
      }
    }
    if (action === 'subject') await this.socket.communityUpdateSubject(jid, subject!);
    else if (action === 'description') await this.socket.groupUpdateDescription(jid, description);
    else if (action === 'link') await this.socket.communityLinkGroup(target!, jid);
    else if (action === 'unlink') await this.socket.communityUnlinkGroup(target!, jid);
    else await this.socket.communityLeave(jid);
    // rc13 discards per-operation response bodies. Verify the observable result
    // before claiming success; an unconfirmed mutation must not be retried blindly.
    {
      let confirmed = false;
      try {
        if (action === 'leave') {
          const remaining = await this.list();
          confirmed = !remaining.some(item => item.id === jid && item.capabilities.leave);
        } else if (target) {
          const after = providerMetadata(await this.socket.groupMetadata(target), target);
          confirmed = action === 'link' ? after.linkedParent === jid : !after.linkedParent;
        } else {
          const after = await this.metadata(jid);
          confirmed =
            action === 'subject' ? after.subject === subject : (after.desc || '') === description;
        }
      } catch {
        // The write may already have reached WhatsApp even if its readback fails.
      }
      if (!confirmed) {
        throw new CommunityError(
          'COMMUNITY_CHANGE_UNCONFIRMED',
          'WhatsApp accepted the request but its result could not be confirmed; refresh before retrying',
          502
        );
      }
    }
    return { action: String(action), communityId: jid };
  }
}
