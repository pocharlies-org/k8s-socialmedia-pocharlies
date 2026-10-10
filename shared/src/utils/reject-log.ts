/** One rejection line per reason per this many ms; the rest are counted, not printed. */
const REJECT_LOG_INTERVAL_MS = 10_000;

/** What an Express request offers; kept structural so `shared` does not depend on Express. */
interface RejectedRequest {
  method: string;
  baseUrl: string;
  path: string;
  ip?: string;
}

/**
 * The rejection log of a connector's /api/public gate (SKIRM-103 F3-4): every
 * rejection leaves one line (method, route, origin IP, reason) so a consumer
 * nobody listed shows up in minutes. Never headers, body, signature or query;
 * the route stops at its first segment so a chat id is not logged either.
 * One line per reason per 10 s; the next one counts what was kept quiet.
 */
export function createRejectLogger<R extends string>(
  log: (line: string) => void = console.warn,
  now: () => number = Date.now
): (req: RejectedRequest, reason: R) => void {
  const lastLogged = new Map<R, { at: number; suppressed: number }>();
  return (req, reason) => {
    const entry = lastLogged.get(reason);
    if (entry && now() - entry.at < REJECT_LOG_INTERVAL_MS) {
      entry.suppressed += 1;
      return;
    }
    const route = `${req.baseUrl}/${req.path.split('/')[1] ?? ''}`;
    log(
      `[public-api] rejected ${req.method} ${route} ip=${req.ip} reason=${reason} suppressed=${entry?.suppressed ?? 0}`
    );
    lastLogged.set(reason, { at: now(), suppressed: 0 });
  };
}
