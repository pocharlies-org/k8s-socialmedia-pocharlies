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

function reelTestApi(): InstagramAPI {
  const api = new InstagramAPI({
    accessToken: 'expired-instagram-login-token',
    businessAccountId: 'legacy-scoped-id',
    fbAccessToken: 'system-user-token',
    mediaProcessingPollIntervalMs: 0,
    mediaProcessingTimeoutMs: 1_000,
  });
  api.setFacebookPrimary('17841444094675941');
  return api;
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
    if (url.pathname.endsWith('/container-1')) return jsonResponse({ id: 'container-1', status_code: 'FINISHED' });
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
    assert.equal(requests[2].pathname, '/v22.0/17841444094675941/media_publish');
    assert.equal(requests[2].searchParams.get('creation_id'), 'container-1');
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
    const api = reelTestApi();
    const published = await api.publishReel({
      videoUrl: 'https://cdn.example.test/reel.mp4',
      caption: 'caption',
    });

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

test('waits for every carousel container to finish before publishing', async () => {
  const originalFetch = globalThis.fetch;
  const requests: URL[] = [];
  let childCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname.endsWith('/media')) {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (body.media_type === 'CAROUSEL') return jsonResponse({ id: 'container-carousel-1' });
      childCount += 1;
      return jsonResponse({ id: `container-child-${childCount}` });
    }
    const child = url.pathname.match(/\/(container-child-\d)$/);
    if (child) return jsonResponse({ id: child[1], status_code: 'FINISHED' });
    if (url.pathname.endsWith('/container-carousel-1')) {
      return jsonResponse({ id: 'container-carousel-1', status_code: 'FINISHED' });
    }
    if (url.pathname.endsWith('/media_publish')) return jsonResponse({ id: 'media-carousel-1' });
    return jsonResponse({ error: 'unexpected request' }, 500);
  };
  try {
    const api = reelTestApi();
    const published = await api.publishCarousel([
      'https://cdn.example.test/a.jpg',
      'https://cdn.example.test/b.jpg',
    ]);

    assert.equal(published.media_id, 'media-carousel-1');
    assert.deepEqual(
      requests.map((request) => request.pathname),
      [
        '/v22.0/17841444094675941/media',
        '/v22.0/container-child-1',
        '/v22.0/17841444094675941/media',
        '/v22.0/container-child-2',
        '/v22.0/17841444094675941/media',
        '/v22.0/container-carousel-1',
        '/v22.0/17841444094675941/media_publish',
      ]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sends cover_url, thumb_offset and collaborators on the reel container', async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body));
    if (url.pathname.endsWith('/media')) return jsonResponse({ id: 'container-reel-2' });
    if (url.pathname.endsWith('/container-reel-2')) {
      return jsonResponse({ id: 'container-reel-2', status_code: 'FINISHED' });
    }
    if (url.pathname.endsWith('/media_publish')) return jsonResponse({ id: 'media-reel-2' });
    return jsonResponse({ error: 'unexpected request' }, 500);
  };
  try {
    const api = reelTestApi();
    await api.publishReel({
      videoUrl: 'https://cdn.example.test/reel.mp4',
      caption: 'caption',
      coverUrl: 'https://cdn.example.test/portada.jpg',
      thumbOffsetMs: 1500,
      collaborators: ['skirmshopusa', 'skirmshopuk'],
    });

    assert.deepEqual(bodies[0], {
      media_type: 'REELS',
      video_url: 'https://cdn.example.test/reel.mp4',
      share_to_feed: 'true',
      caption: 'caption',
      cover_url: 'https://cdn.example.test/portada.jpg',
      thumb_offset: '1500',
      collaborators: ['skirmshopusa', 'skirmshopuk'],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('never returns Graph API paging URLs, which carry access_token in plaintext (SC-4613)', async () => {
  const originalFetch = globalThis.fetch;
  const paged = (path: string) =>
    `https://graph.facebook.com/v22.0/${path}?after=CURSOR&access_token=IGAAsecret`;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/media')) {
      return jsonResponse({
        data: [{ id: 'media-1', caption: 'hola' }],
        paging: { next: paged('media'), previous: paged('media') },
      });
    }
    if (url.pathname.endsWith('/conversations')) {
      return jsonResponse({
        data: [
          {
            id: 'conv-1',
            messages: {
              data: [{ id: 'msg-1', message: 'hola' }],
              paging: { next: paged('conv-1/messages') },
            },
          },
        ],
        paging: { next: paged('conversations') },
      });
    }
    if (url.pathname.endsWith('/me/accounts')) {
      return jsonResponse({
        data: [{ id: 'page-1' }],
        paging: { next: paged('me/accounts') },
      });
    }
    return jsonResponse({ error: 'unexpected request' }, 500);
  };
  try {
    const api = new InstagramAPI({
      accessToken: 'IGAAsecret',
      businessAccountId: 'legacy-scoped-id',
      fbAccessToken: 'EAAsecret',
    });
    for (const result of [
      await api.getRecentMedia(),
      await api.getConversations(),
      await api.getAccountPages(),
    ]) {
      assert.equal(JSON.stringify(result).includes('access_token'), false);
      assert.equal('paging' in (result as object), false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('updates a published media caption via POST /{ig-media-id}', async () => {
  const originalFetch = globalThis.fetch;
  let seen: { url: URL; init?: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => {
    seen = { url: new URL(String(input)), init };
    return jsonResponse({ success: true });
  };
  try {
    const api = reelTestApi();
    assert.deepEqual(await api.updateMediaCaption('17900000000000001', 'caption nuevo'), {
      success: true,
    });
    assert.equal(seen!.init?.method, 'POST');
    assert.ok(seen!.url.pathname.endsWith('/17900000000000001'));
    assert.equal(seen!.url.searchParams.get('access_token'), 'system-user-token');
    assert.deepEqual(JSON.parse(String(seen!.init!.body)), { caption: 'caption nuevo', comment_enabled: 'true' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
