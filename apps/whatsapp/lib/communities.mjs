import { fail } from './security.mjs';

export function communityJid(value, status = 400) {
  if (typeof value !== 'string' || value.length > 128 || !/^\d+(?:-\d+)?@g\.us$/.test(value)) {
    throw fail(status, 'Invalid community or group identifier');
  }
  return value;
}

function boundedText(value, name, max, { empty = false, status = 400 } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw fail(status, `Invalid ${name}`);
  return value.trim();
}

export function communityCreateBody(body) {
  return {
    subject: boundedText(body.subject, 'subject', 100),
    ...(body.description === undefined ? {} : { description: boundedText(body.description, 'description', 2048, { empty: true }) }),
  };
}

export function communityActionBody(body) {
  switch (body.action) {
    case 'subject': return { action: body.action, subject: boundedText(body.subject, 'subject', 100) };
    case 'description': return { action: body.action, description: boundedText(body.description, 'description', 2048, { empty: true }) };
    case 'link': case 'unlink': return { action: body.action, groupJid: communityJid(body.groupJid) };
    case 'leave': return { action: body.action };
    default: throw fail(400, 'Invalid community action');
  }
}

function optionalCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function publicGroup(value) {
  if (!value || typeof value !== 'object') throw fail(502, 'Invalid community response');
  return {
    id: communityJid(value.id, 502),
    name: boundedText(value.name, 'community name', 512, { status: 502 }),
    participantCount: optionalCount(value.participantCount),
    createdAt: optionalCount(value.createdAt),
  };
}

export function publicCommunity(value) {
  return {
    ...publicGroup(value),
    description: boundedText(value.description ?? '', 'community description', 8192, { status: 502, empty: true }),
    capabilities: {
      editInfo: value.capabilities?.editInfo === true,
      manageGroups: value.capabilities?.manageGroups === true,
      leave: value.capabilities?.leave === true,
    },
  };
}

export function publicCommunityList(value) {
  if (!Array.isArray(value)) throw fail(502, 'Invalid community list');
  return value.map(publicCommunity);
}

export function publicLinkedGroups(value) {
  if (!Array.isArray(value)) throw fail(502, 'Invalid linked groups');
  return value.map(publicGroup);
}
