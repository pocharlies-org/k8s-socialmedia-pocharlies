import assert from 'node:assert/strict';
import test from 'node:test';
import { InstagramAPI } from './instagram-api';

const IG_TOKEN = 'ig-token-sentinel';
const FB_USER_TOKEN = 'fb-user-token-sentinel';
const PAGE_TOKEN = 'page-token-sentinel';
const PAGE_ID = '636065083683429';
const IG_ID = '17841444094675941';

type CapturedRequest = { url: URL; init?: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(responder: (request: CapturedRequest) => Response | Promise<Response>): {
  requests: CapturedRequest[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : input.toString();
    const request = { url: new URL(raw), init };
    requests.push(request);
    return responder(request);
  };
  return { requests, restore: () => (globalThis.fetch = original) };
}

function api(businessAccountId = IG_ID): InstagramAPI {
  return new InstagramAPI({
    accessToken: IG_TOKEN,
    fbAccessToken: FB_USER_TOKEN,
    businessAccountId,
  });
}

test('resolves the linked Page and uses its token only for Facebook Graph calls', async () => {
  const mocked = mockFetch(({ url }) => {
    if (url.pathname.endsWith('/me/accounts')) {
      return jsonResponse({
        data: [
          {
            id: PAGE_ID,
            name: 'Skirmshop ES',
            access_token: PAGE_TOKEN,
            instagram_business_account: { id: IG_ID, username: 'skirmshopes' },
          },
        ],
      });
    }
    return jsonResponse({ id: IG_ID, username: 'skirmshopes', followers_count: 7106 });
  });

  try {
    const client = api();
    assert.deepEqual(await client.configureFacebookPageContext(), {
      pageId: PAGE_ID,
      instagramUserId: IG_ID,
      username: 'skirmshopes',
    });
    await client.getProfile();

    assert.equal(mocked.requests.length, 2);
    assert.equal(mocked.requests[0].url.origin, 'https://graph.facebook.com');
    assert.equal(mocked.requests[0].url.pathname, '/v22.0/me/accounts');
    assert.equal(mocked.requests[0].url.searchParams.get('access_token'), FB_USER_TOKEN);
    assert.equal(mocked.requests[1].url.pathname, `/v22.0/${IG_ID}`);
    assert.equal(mocked.requests[1].url.searchParams.get('access_token'), PAGE_TOKEN);
    assert.equal(mocked.requests[1].url.toString().includes(IG_TOKEN), false);
    assert.equal(mocked.requests[1].url.toString().includes(FB_USER_TOKEN), false);
  } finally {
    mocked.restore();
  }
});

test('addresses Instagram conversations through the Page ID and Page token', async () => {
  const mocked = mockFetch(({ url }) => {
    if (url.pathname.endsWith('/me/accounts')) {
      return jsonResponse({
        data: [
          {
            id: PAGE_ID,
            access_token: PAGE_TOKEN,
            instagram_business_account: { id: IG_ID },
          },
        ],
      });
    }
    return jsonResponse({ data: [] });
  });

  try {
    const client = api();
    await client.configureFacebookPageContext();
    await client.getConversations(7);
    const request = mocked.requests[1].url;
    assert.equal(request.pathname, `/v22.0/${PAGE_ID}/conversations`);
    assert.equal(request.searchParams.get('access_token'), PAGE_TOKEN);
    assert.equal(request.searchParams.get('platform'), 'instagram');
    assert.equal(request.searchParams.get('limit'), '7');
  } finally {
    mocked.restore();
  }
});

test('sends a real nested JSON payload through the Page messaging endpoint', async () => {
  const mocked = mockFetch(({ url }) => {
    if (url.pathname.endsWith('/me/accounts')) {
      return jsonResponse({
        data: [
          {
            id: PAGE_ID,
            access_token: PAGE_TOKEN,
            instagram_business_account: { id: IG_ID },
          },
        ],
      });
    }
    return jsonResponse({ recipient_id: 'recipient-1', message_id: 'message-1' });
  });

  try {
    const client = api();
    await client.configureFacebookPageContext();
    await client.sendMessage('recipient-1', 'respuesta determinista');
    const request = mocked.requests[1];
    assert.equal(request.url.pathname, `/v22.0/${PAGE_ID}/messages`);
    assert.equal(request.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(request.init?.body)), {
      recipient: { id: 'recipient-1' },
      message: { text: 'respuesta determinista' },
    });
  } finally {
    mocked.restore();
  }
});

test('fails closed when multiple linked Pages exist and none matches configuration', async () => {
  const mocked = mockFetch(() =>
    jsonResponse({
      data: [
        {
          id: 'page-a',
          access_token: 'page-token-a',
          instagram_business_account: { id: 'ig-a' },
        },
        {
          id: 'page-b',
          access_token: 'page-token-b',
          instagram_business_account: { id: 'ig-b' },
        },
      ],
    })
  );

  try {
    assert.equal(await api('unknown-id').configureFacebookPageContext(), null);
  } finally {
    mocked.restore();
  }
});

test('keeps the Instagram Login fallback when no Facebook user token is configured', async () => {
  const mocked = mockFetch(() => jsonResponse({ id: IG_ID, username: 'skirmshopes' }));
  try {
    const client = new InstagramAPI({ accessToken: IG_TOKEN, businessAccountId: IG_ID });
    assert.equal(await client.configureFacebookPageContext(), null);
    await client.getProfile();
    assert.equal(mocked.requests.length, 1);
    assert.equal(mocked.requests[0].url.origin, 'https://graph.instagram.com');
    assert.equal(mocked.requests[0].url.searchParams.get('access_token'), IG_TOKEN);
  } finally {
    mocked.restore();
  }
});
