/**
 * SC-1227 (SC-1197 P1b): the route table of social-api.
 *
 * One module per route under routes/, one line per route here (design,
 * 10-plan.md "cambios al corte" 3): P2 adds /social/status and P4b adds the
 * /pairing/telegram* and /me/telegram routes by appending a module and a line
 * — nothing else in the app changes.
 */
import { RequestHandler } from 'express';
import { SocialApiContext } from './context';
import { healthRoute } from './routes/health';
import { meWhatsappRoute } from './routes/me-whatsapp';
import { pairingWhatsappRoute } from './routes/pairing-whatsapp';
import { pairingWhatsappStartRoute } from './routes/pairing-whatsapp-start';
import { socialStatusRoute } from './routes/social-status';

export interface RouteSpec {
  method: 'get' | 'post';
  path: string;
  /** false = answers even with SOCIAL_PAIRING_API=off and without a JWT. */
  auth: boolean;
  /**
   * false = the storeGate does NOT run in front of this route (SC-1228,
   * design D7): /social/status answers 200 with everything `unavailable`
   * while the store is off, instead of the 503 the pairing routes give.
   * Default true.
   */
  storeRequired?: boolean;
  make: (ctx: SocialApiContext) => RequestHandler;
}

export const ROUTES: RouteSpec[] = [
  healthRoute,
  pairingWhatsappStartRoute,
  pairingWhatsappRoute,
  meWhatsappRoute,
  socialStatusRoute,
];
