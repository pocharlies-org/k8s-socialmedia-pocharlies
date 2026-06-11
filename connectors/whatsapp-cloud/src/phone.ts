export interface NormalizedWhatsAppPhone {
  phone: string;
  phoneE164: string;
  waJid: string;
}

export function normalizeWhatsAppPhone(value: unknown): NormalizedWhatsAppPhone | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;

  let raw = String(value).trim();
  if (!raw) return null;
  if (raw.includes(':')) raw = raw.split(':').pop() || raw;
  raw = raw.split('@')[0] || raw;

  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  if (digits.length === 9 && /^[6789]/.test(digits)) {
    digits = `34${digits}`;
  }

  if (digits.length < 8 || digits.length > 15) return null;

  return {
    phone: digits,
    phoneE164: `+${digits}`,
    waJid: `${digits}@s.whatsapp.net`,
  };
}
