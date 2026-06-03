export type WhatsAppCustomerAllowlistStatus =
  | 'ready'
  | 'seeded_missing_token'
  | 'not_on_whatsapp'
  | 'invalid_phone'
  | 'probe_failed';

export type WhatsAppCustomerTokenStatus =
  | 'unknown'
  | 'has_token'
  | 'missing_token'
  | 'not_on_whatsapp'
  | 'error';

export interface NormalizedWhatsAppPhone {
  phoneE164: string;
  digits: string;
  waJid: string;
  rawJid: string;
}

export interface WhatsAppContactSeedInput {
  phone: string;
  displayName?: string;
  email?: string;
  shopifyCustomerId?: string;
  shop?: string;
  sourceTopic?: string;
}

export interface WhatsAppContactSeedResult {
  phoneE164: string;
  waJid: string;
  rawJid: string;
  existsOnWhatsApp: boolean | null;
  contactSeeded: boolean;
  status: WhatsAppCustomerAllowlistStatus;
  tokenStatus: WhatsAppCustomerTokenStatus;
  elapsedMs: number;
  error?: string;
  actionable?: string;
}

export function buildManualWhatsAppOpenUrl(phoneE164: string, text?: string | null): string {
  const digits = phoneE164.replace(/\D/g, '');
  const suffix = text && text.length > 0 ? `?text=${encodeURIComponent(text)}` : '';
  return `https://wa.me/${digits}${suffix}`;
}

function defaultCountryCode(): string {
  return (process.env.WA_DEFAULT_COUNTRY_CODE || '34').replace(/\D/g, '') || '34';
}

export function normalizePhoneForWhatsApp(
  value: unknown,
  countryCode: string = defaultCountryCode()
): NormalizedWhatsAppPhone | null {
  if (typeof value !== 'string') return null;
  let raw = value.trim();
  if (!raw) return null;

  if (raw.includes('@')) {
    raw = raw.split('@')[0] || '';
  }
  raw = raw.replace(/^00/, '+');

  const hasPlus = raw.startsWith('+');
  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  const normalizedCountry = countryCode.replace(/\D/g, '');
  if (!hasPlus && digits.length === 9 && normalizedCountry) {
    digits = `${normalizedCountry}${digits}`;
  }

  if (digits.length < 8 || digits.length > 15) return null;
  return {
    phoneE164: `+${digits}`,
    digits,
    waJid: `${digits}@c.us`,
    rawJid: `${digits}@s.whatsapp.net`,
  };
}

export function displayNameOrPhone(displayName: unknown, phoneE164: string): string {
  if (typeof displayName === 'string' && displayName.trim()) {
    return displayName.trim().slice(0, 500);
  }
  return phoneE164;
}
