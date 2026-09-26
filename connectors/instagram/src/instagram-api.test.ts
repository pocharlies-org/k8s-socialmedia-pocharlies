import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discoverFacebookInstagramAccount,
  InstagramAPI,
} from './instagram-api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('discovers the only Instagram Business account assigned to a system user', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://graph.facebook.com');
    assert.equal(url.searchParams.get('access_token'), 'system-user-token');
    return jsonResponse({
      data: [
        {
          id: 'page-1',
          instagram_business_account: {
            id: '17841444094675941',
            username: 'skirmshopes',
          },
        },
      ],
    });
  };
  try {
    assert.deepEqual(
      await discoverFacebookInstagramAccount('system-user-token', 'legacy-scoped-id'),
      { id: '17841444094675941', username: 'skirmshopes' }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('uses Facebook Graph and the durable system-user token for publishing', async () => {
  const originalFetch = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    return jsonResponse({ id: requests.length === 1 ? 'container-1' : 'media-1' });
  };
  try {
    const api = new InstagramAPI({
      accessToken: 'expired-instagram-login-token',
      businessAccountId: 'legacy-scoped-id',
      fbAccessToken: 'system-user-token',
    });
    api.setFacebookPrimary('17841444094675941');
    const container = await api.createMediaContainer(
      'https://cdn.example.test/post.jpg',
      'caption'
    );
    const published = await api.publishMedia(container.id);

    assert.equal(published.id, 'media-1');
    assert.equal(requests[0].origin, 'https://graph.facebook.com');
    assert.equal(requests[0].pathname, '/v22.0/17841444094675941/media');
    assert.equal(requests[0].searchParams.get('access_token'), 'system-user-token');
    assert.equal(requests[0].searchParams.get('image_url'), 'https://cdn.example.test/post.jpg');
    assert.equal(requests[1].pathname, '/v22.0/17841444094675941/media_publish');
    assert.equal(requests[1].searchParams.get('creation_id'), 'container-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('waits for Meta to finish processing a reel before publishing it', async () => {
  const originalFetch = globalThis.fetch;
  const requests: URL[] = [];
  let statusChecks = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname.endsWith('/media')) return jsonResponse({ id: 'container-reel-1' });
    if (url.pathname.endsWith('/container-reel-1')) {
      statusChecks += 1;
      return jsonResponse({
        id: 'container-reel-1',
        status_code: statusChecks === 1 ? 'IN_PROGRESS' : 'FINISHED',
      });
    }
    if (url.pathname.endsWith('/media_publish')) return jsonResponse({ id: 'media-reel-1' });
    return jsonResponse({ error: 'unexpected request' }, 500);
  };
  try {
    const api = new InstagramAPI({
      accessToken: 'expired-instagram-login-token',
      businessAccountId: 'legacy-scoped-id',
      fbAccessToken: 'system-user-token',
      mediaProcessingPollIntervalMs: 0,
      mediaProcessingTimeoutMs: 1_000,
    });
    api.setFacebookPrimary('17841444094675941');

    const published = await api.publishReel('https://cdn.example.test/reel.mp4', 'caption');

    assert.deepEqual(published, {
      container_id: 'container-reel-1',
      media_id: 'media-reel-1',
    });
    assert.deepEqual(
      requests.map((request) => request.pathname),
      [
        '/v22.0/17841444094675941/media',
        '/v22.0/container-reel-1',
        '/v22.0/container-reel-1',
        '/v22.0/17841444094675941/media_publish',
      ]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
