/**
 * SC-1227 (SC-1197 P1b): assembly of the `social-api` HTTP app.
 *
 * Gate order, one decision per layer (mirrors the pool's app.ts from P1a):
 *   1. SOCIAL_PAIRING_API=off  → 404 for everything but GET /health
 *   2. Origin outside the allowlist → 403
 *   3. no / bad JWT → 401 (WWW-Authenticate: Bearer); JWKS down → 503
 *   4. sub/sessionKey/jid ajeno en cuerpo o query → 403
 *   5. store off / no secret / no pool URL → 503 pairing_unavailable
 *   6. the route itself, proxying the pool over the connector HMAC
 *
 * A request rejected at 2-5 never reaches the pool: no signature is produced,
 * no credential row is written (criterio "sin JWT: cero llamadas al pool y
 * cero filas").
 */
import express, { NextFunction, Request, Response } from 'express';
import { identityGuard, jwtGuard, originGuard, storeGate } from '../api/guards';
import { SocialApiContext } from '../api/context';
import { ROUTES, RouteSpec } from '../api/router';

export function createSocialApiApp(ctx: SocialApiContext): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4kb' }));

  const mount = (app: express.Express, route: RouteSpec, ctx: SocialApiContext): void => {
    if (route.method === 'post') app.post(route.path, route.make(ctx));
    else app.get(route.path, route.make(ctx));
  };

  for (const route of ROUTES.filter(r => !r.auth)) mount(app, route, ctx);

  if (!ctx.apiEnabled) {
    app.use((_req, res) => {
      res.status(404).json({ error: 'not_found' });
    });
    return app;
  }

  app.use(originGuard(ctx));
  app.use(jwtGuard(ctx));
  app.use(identityGuard(ctx));
  app.use(storeGate(ctx));

  for (const route of ROUTES.filter(r => r.auth)) mount(app, route, ctx);

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // express.json() throws SyntaxError on a malformed body: answer JSON, not
  // the default HTML error page.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (
      err &&
      typeof err === 'object' &&
      (err as { type?: string }).type === 'entity.parse.failed'
    ) {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    if (res.headersSent) return next(err);
    ctx.logError(`social-api: unhandled error: ${(err as Error)?.message || err}`);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
