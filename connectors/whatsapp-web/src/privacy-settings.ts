/**
 * WhatsApp privacy settings of the account (fase 3 / PR-8): who sees our last
 * seen, online, photo, status, read receipts, who may add us to groups, call
 * us or message us, and the default timer of new chats. Ported from the NAS
 * fork (getPrivacySettings, updatePrivacy, buildPrivacyUpdate) and adapted to
 * prod.
 *
 * A privacy write changes the ACCOUNT, for every contact and every device —
 * not one chat. So: setting names and values are exactly Baileys' (7.0.0-rc13
 * Types/Chat.d.ts), anything else is 400 before WhatsApp; the request must
 * carry `confirm: true` (400 otherwise); and it goes behind the same gate as
 * every send. Reads are not gated. Nothing is stored: WhatsApp keeps them.
 */
import { MessageMutationError } from './message-mutations';
import { DISAPPEARING_DURATIONS, parseDisappearingExpiration } from './disappearing';

type PrivacyMethod =
  | 'updateLastSeenPrivacy'
  | 'updateOnlinePrivacy'
  | 'updateProfilePicturePrivacy'
  | 'updateStatusPrivacy'
  | 'updateReadReceiptsPrivacy'
  | 'updateGroupsAddPrivacy'
  | 'updateCallPrivacy'
  | 'updateMessagesPrivacy';

interface PrivacySettingSpec {
  /** Category name in WhatsApp's privacy IQ (what fetchPrivacySettings keys by). */
  category: string;
  method: PrivacyMethod;
  values: readonly string[];
}

const EVERYONE_CONTACTS_EXCEPT_NOBODY = ['all', 'contacts', 'contact_blacklist', 'none'] as const;

/** API name → WhatsApp category, Baileys method and the values it accepts. */
export const PRIVACY_SETTINGS: Record<string, PrivacySettingSpec> = {
  lastSeen: {
    category: 'last',
    method: 'updateLastSeenPrivacy',
    values: EVERYONE_CONTACTS_EXCEPT_NOBODY,
  },
  online: { category: 'online', method: 'updateOnlinePrivacy', values: ['all', 'match_last_seen'] },
  profilePicture: {
    category: 'profile',
    method: 'updateProfilePicturePrivacy',
    values: EVERYONE_CONTACTS_EXCEPT_NOBODY,
  },
  status: {
    category: 'status',
    method: 'updateStatusPrivacy',
    values: EVERYONE_CONTACTS_EXCEPT_NOBODY,
  },
  readReceipts: {
    category: 'readreceipts',
    method: 'updateReadReceiptsPrivacy',
    values: ['all', 'none'],
  },
  groupsAdd: {
    category: 'groupadd',
    method: 'updateGroupsAddPrivacy',
    values: ['all', 'contacts', 'contact_blacklist'],
  },
  call: { category: 'calladd', method: 'updateCallPrivacy', values: ['all', 'known'] },
  messages: { category: 'messages', method: 'updateMessagesPrivacy', values: ['all', 'contacts'] },
};

/** Not a privacy IQ: the account's default timer for NEW chats (updateDefaultDisappearingMode). */
export const DEFAULT_DISAPPEARING_SETTING = 'defaultDisappearing';

export const PRIVACY_SETTING_NAMES = [
  ...Object.keys(PRIVACY_SETTINGS),
  DEFAULT_DISAPPEARING_SETTING,
];

export type PrivacyUpdate =
  | { setting: string; value: string; method: PrivacyMethod }
  | {
      setting: typeof DEFAULT_DISAPPEARING_SETTING;
      value: number;
      method: 'updateDefaultDisappearingMode';
    };

function invalid(message: string, code?: string): MessageMutationError {
  return new MessageMutationError(message, 400, 'invalid_request', code);
}

/** {setting, value} → the Baileys call, or 400. Values are exact (case matters to WhatsApp). */
export function buildPrivacyUpdate(setting: unknown, value: unknown): PrivacyUpdate {
  const name = typeof setting === 'string' ? setting.trim() : '';
  if (name === DEFAULT_DISAPPEARING_SETTING) {
    return {
      setting: DEFAULT_DISAPPEARING_SETTING,
      value: parseDisappearingExpiration(value),
      method: 'updateDefaultDisappearingMode',
    };
  }
  const spec = Object.prototype.hasOwnProperty.call(PRIVACY_SETTINGS, name)
    ? PRIVACY_SETTINGS[name]
    : undefined;
  if (!spec) {
    throw invalid(
      `Unknown privacy setting ${name.slice(0, 40) || '(none)'} (${PRIVACY_SETTING_NAMES.join(', ')})`
    );
  }
  const text = typeof value === 'string' ? value.trim() : '';
  if (!spec.values.includes(text)) {
    throw invalid(`${name} must be one of ${spec.values.join(', ')}`);
  }
  return { setting: name, value: text, method: spec.method };
}

/**
 * Body of POST /privacy: {setting, value, confirm: true}. The setting and value
 * are checked first (a typo is a 400 that says so), then the confirmation.
 */
export function parsePrivacyRequest(body: Record<string, unknown>): PrivacyUpdate {
  const update = buildPrivacyUpdate(body.setting ?? body.field, body.value);
  if (body.confirm !== true) {
    throw invalid(
      'Privacy settings change the account for every contact: pass confirm: true',
      'confirm_required'
    );
  }
  return update;
}

export interface PrivacyView {
  /** API name → current value; null when WhatsApp did not report it. */
  settings: Record<string, string | null>;
  /** Default timer of new chats in seconds (0 = off), null when unknown. */
  defaultDisappearing: number | null;
  /** Categories WhatsApp reported that this API does not name (read-only). */
  other: Record<string, string>;
  /** What each setting accepts. */
  allowed: Record<string, readonly (string | number)[]>;
}

/** fetchPrivacySettings' dictionary (category → value) as the API reports it. */
export function privacyView(raw: unknown, defaultDisappearing: unknown): PrivacyView {
  const categories: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const settings: Record<string, string | null> = {};
  const named = new Set<string>();
  for (const [name, spec] of Object.entries(PRIVACY_SETTINGS)) {
    const value = categories[spec.category];
    settings[name] = typeof value === 'string' ? value : null;
    named.add(spec.category);
  }
  const other: Record<string, string> = {};
  for (const [category, value] of Object.entries(categories)) {
    if (!named.has(category) && typeof value === 'string') other[category] = value;
  }
  const allowed: Record<string, readonly (string | number)[]> = {};
  for (const [name, spec] of Object.entries(PRIVACY_SETTINGS)) allowed[name] = spec.values;
  allowed[DEFAULT_DISAPPEARING_SETTING] = DISAPPEARING_DURATIONS;
  const seconds = Number(defaultDisappearing);
  return {
    settings,
    defaultDisappearing:
      defaultDisappearing === null || defaultDisappearing === undefined || !Number.isFinite(seconds)
        ? null
        : seconds,
    other,
    allowed,
  };
}

/** The current value of `setting` in a view (to skip a write that changes nothing). */
export function currentPrivacyValue(view: PrivacyView, setting: string): string | number | null {
  return setting === DEFAULT_DISAPPEARING_SETTING
    ? view.defaultDisappearing
    : (view.settings[setting] ?? null);
}
