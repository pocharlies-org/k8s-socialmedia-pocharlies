import { createUiPath } from './ui-path';

export function validateUrl(value: string, name: string, protocols = ['http:', 'https:']): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(
      `${name} must use ${protocols.join('/')} without credentials, query or fragment`
    );
  }
  return url.toString().replace(/\/$/, '');
}

export function qrPageUrl(env = process.env): string {
  return validateUrl(
    env.QR_PAGE_URL?.trim() ||
      env.WA_QR_PUBLIC_URL?.trim() ||
      `http://localhost:${env.PORT || '3001'}${createUiPath(env.UI_BASE_PATH || '')('/qr/page')}`,
    'QR_PAGE_URL'
  );
}

export function dashboardUrl(env = process.env): string | undefined {
  const value = env.DASHBOARD_URL?.trim();
  return value ? validateUrl(value, 'DASHBOARD_URL') : undefined;
}

export function whatsappSocketOptions(env = process.env): { waWebSocketUrl?: string } {
  if (env.WHATSAPP_ORIGIN?.trim()) {
    const origin = validateUrl(env.WHATSAPP_ORIGIN.trim(), 'WHATSAPP_ORIGIN');
    if (origin !== 'https://web.whatsapp.com') {
      throw new Error(
        'Installed Baileys fixes WHATSAPP_ORIGIN to https://web.whatsapp.com; custom origins are unsupported'
      );
    }
  }
  return env.WHATSAPP_WEBSOCKET_URL?.trim()
    ? {
        waWebSocketUrl: validateUrl(env.WHATSAPP_WEBSOCKET_URL.trim(), 'WHATSAPP_WEBSOCKET_URL', [
          'ws:',
          'wss:',
        ]),
      }
    : {};
}
