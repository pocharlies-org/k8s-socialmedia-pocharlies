// Posts ephemeral events (typing, inbound reactions) to the messaging service
// (dgx-messages, DASHBOARD_URL env — DGX-291). The HMAC scheme is the one the
// service verifies with CONNECTOR_SHARED_SECRET from vault; there is no dev
// fallback — an unset secret signs empty and the service answers 401.

import { postDashboardEvent } from '@mcp-socialmedia/shared';

const SECRET = process.env.CONNECTOR_SHARED_SECRET ?? '';

export function dashboardUrl(): string | undefined {
  const value = process.env.DASHBOARD_URL?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DASHBOARD_URL must be an absolute HTTP(S) URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('DASHBOARD_URL must use HTTP(S) without credentials, query or fragment');
  }
  return url.toString().replace(/\/$/, '');
}

export async function notifyDashboard(
  path: string,
  payload: Record<string, unknown>
): Promise<void> {
  return postDashboardEvent(dashboardUrl(), SECRET, path, payload);
}
