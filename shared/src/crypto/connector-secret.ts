/** The fallback every connector used to carry in its source: a public value, not a secret. */
export const CONNECTOR_SECRET_PLACEHOLDER = 'dev-secret-change-in-production';

/**
 * SKIRM-103 (F3-2): the HMAC key of the connector API must be set, non-empty
 * and not the placeholder published in this repository. Throws otherwise, so
 * the process that calls it at startup does not start. A valid value is
 * returned exactly as read: every other consumer of the variable uses it
 * untrimmed, and a trimmed copy would sign differently.
 */
export function requireConnectorSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.CONNECTOR_SHARED_SECRET ?? '';
  if (!secret.trim()) {
    throw new Error(
      'CONNECTOR_SHARED_SECRET is unset or empty: refusing to start without the connector HMAC key'
    );
  }
  if (secret.trim() === CONNECTOR_SECRET_PLACEHOLDER) {
    throw new Error(
      'CONNECTOR_SHARED_SECRET is the placeholder from the repository: refusing to start with a public HMAC key'
    );
  }
  return secret;
}
