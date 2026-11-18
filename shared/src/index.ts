import { requireConnectorSecret } from './crypto/connector-secret';
import { postDashboardEvent } from './utils/dashboard-notifier';

export * from './crypto/encryption';
export * from './crypto/connector-auth';
export * from './crypto/connector-secret';
export * from './crypto/meta-signature';
export * from './utils/dashboard-notifier';
export * from './utils/log-redaction';
export * from './utils/with-timeout';
export * from './utils/idempotency-key';
export * from './types/events';
export * from './session-store';
export * from './utils/account-key';
export * from './utils/dashboard-notifier';

/** Compatibility facade used by connectors that publish ephemeral dashboard events. */
export async function notifyDashboard(
  path: string,
  payload: Record<string, unknown>
): Promise<void> {
  const baseUrl = process.env.DASHBOARD_URL?.trim().replace(/\/$/, '');
  if (!baseUrl) return;
  try {
    const secret = requireConnectorSecret();
    await postDashboardEvent(baseUrl, secret, path, payload);
  } catch (error) {
    // Dashboard notifications are best effort and must not break ingestion.
    console.warn(`[dashboard-notifier] ${path} failed: ${(error as Error).message}`);
  }
}
export * from './bridge';
