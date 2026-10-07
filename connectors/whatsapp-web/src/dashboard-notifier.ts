// Posts ephemeral events (typing, inbound reactions) directly to the dashboard.
// HMAC scheme matches the dashboard's `/api/messages/_connector/*` endpoints.

import { postDashboardEvent } from '@mcp-socialmedia/shared';
import { dashboardUrl } from './url-config';

const SECRET = process.env.CONNECTOR_SHARED_SECRET || 'dev-secret-change-in-production';

export async function notifyDashboard(
  path: string,
  payload: Record<string, unknown>
): Promise<void> {
  return postDashboardEvent(dashboardUrl(), SECRET, path, payload);
}
