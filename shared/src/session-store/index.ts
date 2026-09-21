/**
 * SC-552 / SC-705: the single per-user credential store, its encryption
 * envelope, the per-request actor context and the channel adapters.
 *
 * Lives in `shared/` because two runtimes speak to it: the mcp-server (tool
 * dispatch + resolver path) and the whatsapp-web connector (session load at
 * start + saveCreds write-back). One implementation, one place credentials
 * could leak. Its regression specs run under the mcp-server jest harness
 * (`mcp-server/src/infrastructure/session-store/*.spec.ts`), which builds
 * this package before running.
 */
export * from './credential-store';
export * from './payload-crypto';
export * from './credential-resolver';
export * from './credential-session-key';
export * from './request-context';
export * from './adapters/baileys-auth';
export * from './adapters/mtcute-session';
export * from './adapters/instagram-graph-token';
