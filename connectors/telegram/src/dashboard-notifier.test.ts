import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardUrl, notifyDashboard } from './dashboard-notifier';

test('dashboard notifications require an explicit HTTP(S) destination', async () => {
  const previous = process.env.DASHBOARD_URL;
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async input => { calls.push(String(input)); return new Response(null, { status: 204 }); };
  try {
    delete process.env.DASHBOARD_URL;
    await notifyDashboard('/_connector/typing', {});
    process.env.DASHBOARD_URL = ' ';
    await notifyDashboard('/_connector/typing', {});
    assert.deepEqual(calls, []);
    process.env.DASHBOARD_URL = 'https://dashboard.example/prefix/';
    await notifyDashboard('/_connector/typing', {});
    assert.deepEqual(calls, ['https://dashboard.example/prefix/api/messages/_connector/typing']);
    for (const value of ['javascript:alert(1)', 'https://user:secret@example.com', 'https://example.com?secret=1']) {
      process.env.DASHBOARD_URL = value;
      assert.throws(dashboardUrl, /DASHBOARD_URL/);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.DASHBOARD_URL; else process.env.DASHBOARD_URL = previous;
  }
});
