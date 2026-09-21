/**
 * SC-705: the session_key convention for per-user credential-store rows.
 *
 * Fixed by the tech-lead (nota-tech-lead-almacen-gaps, SC-1144):
 *   session_key = <sub>           — one session per user+channel
 *   session_key = <sub>:<cuenta>  — when one user has two accounts of the
 *                                   channel (e.g. '<uuid>:professional')
 * The PK (session_key, channel) already supports both without a schema
 * change. Lives in `shared/` because every channel connector (baileys,
 * mtcute, …) keys its rows by the SAME convention — two copies of the
 * validation rule would be two places where it could drift.
 *
 * CREDENTIAL_SESSION_KEY carries that key for THIS connector process (one
 * process per paired session is the CTO's phase-2 posture; phase 1.5 wires
 * single per-sub connectors, e.g. Daniel's). The house accounts do NOT set
 * it: no key → exact legacy path, and the house session is never adopted
 * into the store (binding decision 2 of SC-705: no two sources of truth).
 */
import { credentialStoreEnabled } from './credential-store';

/**
 * session_key charset: UUID subs and `<sub>:<account>` fit; path separators
 * and traversal are rejected so the key can never escape a sessionPath root
 * when used as a directory name.
 */
export const CREDENTIAL_SESSION_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/**
 * The session_key this process should key its session by, or null when it
 * must run the legacy path (flag off, or no key set — the house accounts).
 * Throws on a malformed key: a typo'd key would silently create a second
 * source of truth.
 */
export function credentialSessionKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!credentialStoreEnabled(env)) return null;
  const raw = (env.CREDENTIAL_SESSION_KEY || '').trim();
  if (!raw) return null;
  if (!CREDENTIAL_SESSION_KEY_RE.test(raw)) {
    throw new Error(
      `CREDENTIAL_SESSION_KEY must match ${CREDENTIAL_SESSION_KEY_RE} (a Keycloak sub, optionally '<sub>:<account>')`
    );
  }
  return raw;
}
