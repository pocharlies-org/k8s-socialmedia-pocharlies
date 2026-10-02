const string = (value, max = 4096) => typeof value === 'string' ? value.slice(0, max) : null;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

export function publicMessageMetadata(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const kind = string(source.kind, 32);
  if (kind === 'poll') return {
    kind,
    options: Array.isArray(source.options) ? source.options.slice(0, 100).map(item => string(item, 500)).filter(Boolean) : [],
    selectableCount: number(source.selectableCount),
  };
  if (kind === 'event') {
    const location = source.location && typeof source.location === 'object' && !Array.isArray(source.location) ? source.location : {};
    return { kind, description: string(source.description), startTime: number(source.startTime), endTime: number(source.endTime),
      location: { name: string(location.name, 500), degreesLatitude: number(location.degreesLatitude), degreesLongitude: number(location.degreesLongitude) },
      isCancelled: source.isCancelled === true, extraGuestsAllowed: source.extraGuestsAllowed === true };
  }
  if (kind === 'contact') return { kind, contacts: Array.isArray(source.contacts) ? source.contacts.slice(0, 100).map(contact => ({
    displayName: string(contact?.displayName, 500), phone: string(contact?.phone, 100), email: string(contact?.email, 500), organization: string(contact?.organization, 500),
  })) : [] };
  if (kind === 'reaction') return { kind, emoji: string(source.emoji, 32), targetMessageId: string(source.targetMessageId, 512) };
  if (kind === 'poll_vote' || kind === 'poll_result') return { kind, ...(kind === 'poll_vote' ? { pollMessageId: string(source.pollMessageId, 512) } : {}) };
  if (kind === 'sticker') return { kind, isAnimated: source.isAnimated === true };
  return {};
}

export function publicPollResults(value) {
  if (!value || typeof value !== 'object') return null;
  const options = Array.isArray(value.options) ? value.options.slice(0, 100).map(option => ({
    name: string(option?.name, 500),
    count: Math.max(0, Math.floor(number(option?.count) ?? 0)),
    selectedByMe: option?.selectedByMe === true,
  })).filter(option => option.name) : [];
  return {
    available: value.available === true,
    availability: ['local_full', 'local_partial', 'unavailable'].includes(value.availability) ? value.availability : 'unavailable',
    totalVoters: Math.max(0, Math.floor(number(value.totalVoters) ?? 0)),
    options,
  };
}

export function publicEventResults(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const counts = Object.fromEntries(['going', 'not_going', 'maybe'].map(key => [key, count(value.counts?.[key])]));
  if (Object.values(counts).some(value => value === null)) return null;
  const available = value.available === true;
  return {
    available, availability: available ? 'local_partial' : 'unavailable', counts,
    extraGuests: count(value.extraGuests), capturedResponders: count(value.capturedResponders),
    selectedExtraGuestCount: count(value.selectedExtraGuestCount),
    selectedByMe: ['going', 'not_going', 'maybe', 'unknown'].includes(value.selectedByMe) ? value.selectedByMe : null,
    reason: ['EVENT_NOT_FOUND', 'ENCRYPTION_KEY_UNAVAILABLE', 'IDENTITY_UNAVAILABLE'].includes(value.reason) ? value.reason : null,
  };
}
