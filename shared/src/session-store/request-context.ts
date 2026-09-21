/**
 * SC-552: per-request actor context.
 *
 * The AgentGateway (main @ 95e472d, SC-600) verifies the Keycloak JWT on the
 * /social route and forwards the real user's identity to this backend as the
 * `x-user-sub` / `x-user-name` headers. The MCP SDK owns the tool-call
 * dispatch inside `transport.handleRequest(req, res, body)`, so the reliable
 * per-request hook is an AsyncLocalStorage established AROUND that call in
 * sse-server.ts: everything the SDK awaits below it (including the
 * CallToolRequestSchema handler) sees the actor via getRequestActor().
 *
 * No header → empty actor → every consumer must take the exact legacy path
 * (hard no-regression rule for the current single-user deployment).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { IncomingHttpHeaders } from 'node:http';

export interface RequestActor {
  /** Keycloak JWT `sub`, forwarded by the gateway as `x-user-sub`. */
  sub?: string;
  /** Display name forwarded by the gateway as `x-user-name`. */
  name?: string;
}

const actorStorage = new AsyncLocalStorage<RequestActor>();

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

/** Extract the actor from raw HTTP headers. Missing/blank headers → {}. */
export function actorFromHeaders(headers: IncomingHttpHeaders): RequestActor {
  const actor: RequestActor = {};
  const sub = firstHeaderValue(headers['x-user-sub']);
  const name = firstHeaderValue(headers['x-user-name']);
  if (sub) actor.sub = sub;
  if (name) actor.name = name;
  return actor;
}

/** Run `fn` with `actor` visible to getRequestActor() down the await chain. */
export function runWithRequestActor<T>(actor: RequestActor, fn: () => Promise<T>): Promise<T> {
  return actorStorage.run(actor, fn);
}

/** The actor for the current request, or {} outside any request context. */
export function getRequestActor(): RequestActor {
  return actorStorage.getStore() ?? {};
}

/**
 * SC-705 phase 1.5: the actor as outbound HTTP headers. The mcp-server calls
 * its connectors (whatsapp/telegram/instagram) over HMAC-signed HTTP; those
 * calls must carry the same identity the gateway handed us, so a connector
 * (phase-2 per-sub pool) can resolve the caller's own session. Empty actor →
 * no headers → connectors keep the exact legacy behaviour (no-regression rule).
 */
export function actorRequestHeaders(
  actor: RequestActor = getRequestActor()
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (actor.sub) headers['x-user-sub'] = actor.sub;
  if (actor.name) headers['x-user-name'] = actor.name;
  return headers;
}
