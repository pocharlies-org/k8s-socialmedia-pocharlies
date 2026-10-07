// Posts ephemeral events (typing, inbound reactions) directly to the dashboard.
// Uses the same HMAC scheme the dashboard uses to call back into the connectors.

import { postDashboardEvent } from '@mcp-socialmedia/shared';

const SECRET = process.env.CONNECTOR_SHARED_SECRET || 'dev-secret-change-in-production';

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
