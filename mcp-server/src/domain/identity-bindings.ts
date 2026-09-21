/**
 * SC-1144 (fase 2): per-principal account bindings for the socialmedia MCP.
 *
 * Same shape and same fail-closed posture as k8s-agentgateway-pocharlies
 * `backends/workspace/identity-bindings.yaml` (SC-709): a table in GitOps maps
 * ONE verified Keycloak principal (`sub`, forwarded by the AgentGateway as the
 * `x-user-sub` header and exposed by
 * `@mcp-socialmedia/shared` session-store `getRequestActor()`) to the
 * social accounts it may touch, whatever the channel (WhatsApp / Telegram /
 * Instagram — the binding is per account, not per channel).
 *
 * Gated by `SOCIAL_IDENTITY_BINDING` (default OFF). With the flag off NOTHING
 * here reads anything: zero file stats, zero parses — the legacy routing is
 * byte-identical (hard no-regression rule). With the flag ON:
 *   - no verified `sub` on the call            → fail-closed (explicit error)
 *   - `sub` without an entry in the table      → fail-closed (explicit error)
 *   - requested account outside the entry      → explicit error naming the
 *     principal and its bound accounts
 *   - account omitted                          → FIRST account of the entry
 *     (never the global `personal` default)
 *
 * The bindings file is re-read when the mounted ConfigMap changes (stat
 * mtime_ns + size, like the workspace shim), so a binding edit applies without
 * a pod restart. A static ConfigMap name (disableNameSuffixHash) is what makes
 * that possible; a hashed one would roll the pod instead.
 */
import * as fs from 'node:fs';
import * as yaml from 'js-yaml';
import type { RequestActor } from '@mcp-socialmedia/shared';

export interface IdentityBindingEntry {
  /** Human name of the principal; appears in the fail-closed error messages. */
  label: string;
  /**
   * Accounts this principal may use, whatever the channel — WhatsApp/Telegram
   * ids (`personal`/`professional`/`leila`) and Instagram ids (`skirmshop`/
   * `barbelpapis`) alike. Plain strings on purpose: the binding is per
   * account, and whether the account exists on the requested channel is the
   * routing layer's check. Omitting the parameter serves the FIRST one.
   */
  accounts: string[];
}

/** Error with a canonical `forbidden` code so the MCP error envelope is explicit. */
export class IdentityBindingError extends Error {
  readonly canonicalCode = 'forbidden';
  constructor(message: string) {
    super(message);
    this.name = 'IdentityBindingError';
  }
}

/** Flag truthiness mirrors the workspace shim: 1|true|yes|on (case-insensitive). */
export function identityBindingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.SOCIAL_IDENTITY_BINDING ?? '').trim());
}

export function identityBindingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.SOCIAL_IDENTITY_BINDINGS_FILE || '/identity/social-identity-bindings.yaml';
}

// Cache keyed on (path, mtime_ns, size) — the shim's exact reload mechanism.
let bindingsCache: { key: string; data: Map<string, IdentityBindingEntry> } | null = null;

/**
 * Parse the bindings file into `{sub → entry}`. Fail-closed on any read/parse
 * problem: with the flag ON an unreadable table binds NOBODY. Entries whose
 * `sub` or `accounts` are empty (TODO placeholders) bind nothing by absence.
 */
export function loadIdentityBindings(
  filePath: string = identityBindingsFile()
): Map<string, IdentityBindingEntry> {
  let st: fs.BigIntStats;
  try {
    st = fs.statSync(filePath, { bigint: true });
  } catch (error) {
    throw new IdentityBindingError(
      `SOCIAL_IDENTITY_BINDING está ON pero ${filePath} no se puede leer (${String(error)}); ` +
        'ninguna cuenta social se sirve (fail-closed).'
    );
  }
  const cacheKey = `${filePath}:${st.mtimeNs.toString()}:${st.size.toString()}`;
  if (bindingsCache && bindingsCache.key === cacheKey) return bindingsCache.data;

  let raw: unknown;
  try {
    raw = yaml.load(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new IdentityBindingError(
      `SOCIAL_IDENTITY_BINDING está ON pero ${filePath} no se puede parsear (${String(error)}); ` +
        'ninguna cuenta social se sirve (fail-closed).'
    );
  }
  const entries = (raw as { bindings?: unknown })?.bindings ?? raw;
  if (!Array.isArray(entries)) {
    throw new IdentityBindingError(
      `El fichero de vínculos ${filePath} debe llevar una lista ` +
        '`bindings:`; ninguna cuenta social se sirve (fail-closed).'
    );
  }
  const data = new Map<string, IdentityBindingEntry>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue; // comment-only / empty item
    const record = entry as { sub?: unknown; label?: unknown; accounts?: unknown };
    const sub = typeof record.sub === 'string' ? record.sub.trim() : '';
    const accounts = (Array.isArray(record.accounts) ? record.accounts : [])
      .map(item =>
        String(item ?? '')
          .trim()
          .toLowerCase()
      )
      .filter(item => item.length > 0);
    if (!sub || !accounts.length) continue; // placeholder without real accounts binds nothing
    const label =
      typeof record.label === 'string' && record.label.trim() ? record.label.trim() : sub;
    data.set(sub, { label, accounts });
  }
  // Replace (never mutate) so a concurrent reader never sees a half-built map.
  bindingsCache = { key: cacheKey, data };
  return data;
}

/** Test seam: drop the mtime cache between cases. */
export function resetIdentityBindingsCache(): void {
  bindingsCache = null;
}

/**
 * The single decision point for one tool call. Returns the account to serve;
 * throws IdentityBindingError (fail-closed) otherwise. `requested` is the
 * tool's `accountId` argument (undefined when omitted).
 */
export function resolveBoundAccount(
  requested: string | undefined,
  actor: RequestActor,
  options: { env?: NodeJS.ProcessEnv; filePath?: string } = {}
): string {
  const filePath = options.filePath ?? identityBindingsFile(options.env);
  const sub = typeof actor.sub === 'string' ? actor.sub.trim() : '';
  if (!sub) {
    throw new IdentityBindingError(
      'SOCIAL_IDENTITY_BINDING está ON pero esta llamada no trae cabecera verificada ' +
        '`x-user-sub` (la estampa el AgentGateway en la ruta /social; por la LAN con el ' +
        'bearer compartido no hay principal verificado); ninguna cuenta social se sirve ' +
        '(fail-closed).'
    );
  }
  const entry = loadIdentityBindings(filePath).get(sub);
  if (!entry) {
    throw new IdentityBindingError(
      `El llamante verificado sub ${sub} no tiene entrada en ${filePath}; este principal ` +
        'no está ligado a ninguna cuenta social (fail-closed).'
    );
  }
  const wanted = typeof requested === 'string' ? requested.trim().toLowerCase() : '';
  if (!wanted) return entry.accounts[0];
  if (!(entry.accounts as readonly string[]).includes(wanted)) {
    throw new IdentityBindingError(
      `account '${requested}' no está ligado a este llamante. Principal: ${entry.label} ` +
        `(sub ${sub}). Cuentas ligadas: ${entry.accounts.join(', ')}.`
    );
  }
  return wanted;
}
