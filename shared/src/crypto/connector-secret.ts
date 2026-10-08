/** The fallback every connector used to carry in its source: a public value, not a secret. */
export const CONNECTOR_SECRET_PLACEHOLDER = 'dev-secret-change-in-production';

let placeholderWarned = false;

/**
 * SKIRM-103 (F3-2): the HMAC key of the connector API.
 *
 * - Missing or blank: throws, always. No process starts without a key, and no
 *   caller signs with `''`.
 * - The placeholder above: fatal when the Deployment sets
 *   CONNECTOR_SECRET_STRICT=true; otherwise it logs one error per process and
 *   goes on, so a release of this code never depends on the order in which the
 *   key is replaced. SC-2149 makes strict the default and removes the switch.
 *   (Once per process because the dashboard notifier asks on every signature.)
 *
 * A valid value is returned exactly as read: every other consumer of the
 * variable uses it untrimmed, and a trimmed copy would sign differently.
 */
export function requireConnectorSecret(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.error
): string {
  const secret = env.CONNECTOR_SHARED_SECRET ?? '';
  if (!secret.trim()) {
    throw new Error(
      'CONNECTOR_SHARED_SECRET is unset or empty: refusing to start without the connector HMAC key'
    );
  }
  if (secret.trim() === CONNECTOR_SECRET_PLACEHOLDER) {
    if (env.CONNECTOR_SECRET_STRICT === 'true') {
      throw new Error(
        'CONNECTOR_SHARED_SECRET is the placeholder from the repository: refusing to start with a public HMAC key (CONNECTOR_SECRET_STRICT=true)'
      );
    }
    if (!placeholderWarned) {
      placeholderWarned = true;
      warn(
        'CONNECTOR_SHARED_SECRET is the placeholder from the repository, a public value: set a key of your own (SC-2092). CONNECTOR_SECRET_STRICT=true makes this fatal.'
      );
    }
  }
  return secret;
}
