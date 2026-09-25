/**
 * SC-1227 (SC-1197 P1b): GET /health — the one route without auth (spec
 * point 2), also what the k8s readiness/liveness probes hit. Answers even
 * with SOCIAL_PAIRING_API=off.
 */
import { SocialApiContext } from '../context';
import { RouteSpec } from '../router';

export const healthRoute: RouteSpec = {
  method: 'get',
  path: '/health',
  auth: false,
  make: (ctx: SocialApiContext) => (_req, res) => {
    res.json({
      status: 'ok',
      service: 'social-api',
      pairingApi: ctx.apiEnabled ? 'on' : 'off',
      store: ctx.storeAvailable ? 'available' : 'unavailable',
    });
  },
};
