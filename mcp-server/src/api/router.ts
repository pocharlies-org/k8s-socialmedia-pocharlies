/**
 * SC-1227 (SC-1197 P1b): the route table of social-api.
 *
 * One module per route under routes/, one line per route here (design,
 * 10-plan.md "cambios al corte" 3): P2 adds /social/status and P4b adds the
 * /pairing/telegram* and /me/telegram routes by appending a module and a line
 * — nothing else in the app changes.
 */
import { RequestHandler } from 'express';
import { PairingPoolName, SocialApiContext } from './context';
import { healthRoute } from './routes/health';
import { meTelegramRoute } from './routes/me-telegram';
import { meWhatsappRoute } from './routes/me-whatsapp';
import { pairingTelegramPasswordRoute } from './routes/pairing-telegram-password';
import { pairingTelegramStartRoute } from './routes/pairing-telegram-start';
import { pairingTelegramRoute } from './routes/pairing-telegram';
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
  /**
   * Which pool this route calls (SC-1229): the storeGate checks THIS client
   * (ctx.telegramPairing / ctx.whatsappPairing), never the other — a
   * missing telegram pool must not 503 the whatsapp routes and vice versa
   * (architect note on the SC-1228 per-route storeGate). Default 'whatsapp'
   * keeps every P1b/P2 route byte-identical.
   */
  pool?: PairingPoolName;
  make: (ctx: SocialApiContext) => RequestHandler;
}

export const ROUTES: RouteSpec[] = [
  healthRoute,
  pairingWhatsappStartRoute,
  pairingWhatsappRoute,
  meWhatsappRoute,
  pairingTelegramStartRoute,
  pairingTelegramRoute,
  pairingTelegramPasswordRoute,
  meTelegramRoute,
  socialStatusRoute,
];
