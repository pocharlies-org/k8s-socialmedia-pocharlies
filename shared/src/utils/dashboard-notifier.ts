import { createHmac } from 'crypto';

function sign(body: string, secret: string): { ts: string; sig: string } {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
  return { ts, sig: `sha256=${sig}` };
}

export async function postDashboardEvent(
  baseUrl: string | undefined,
  secret: string,
  path: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (!baseUrl) return;
  const body = JSON.stringify(payload);
  const { ts, sig } = sign(body, secret);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ac = new AbortController();
    // Dashboard's asyncpg pool cold-starts can take 5-8s after a restart;
    // 4s was firing the abort before fetch had a chance. 12s leaves headroom
    // without holding the typing handler for too long.
    timer = setTimeout(() => ac.abort(), 12000);
    const res = await fetch(`${baseUrl}/api/messages${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-connector-signature': sig,
        'x-connector-timestamp': ts,
      },
      body,
      signal: ac.signal,
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[dashboard-notifier] ${path} ${res.status}`);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[dashboard-notifier] ${path} failed: ${(e as Error).message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
