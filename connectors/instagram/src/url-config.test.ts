import test from 'node:test';
import assert from 'node:assert/strict';
import { graphBaseUrl, instagramMeUrl } from './url-config';
import { InstagramAPI, discoverFacebookInstagramAccount } from './instagram-api';

test('graph bases reject unsafe URLs and preserve configured API version', () => {
  assert.equal(graphBaseUrl('instagram', { INSTAGRAM_GRAPH_BASE_URL: 'http://graph.local/v99.0/' }), 'http://graph.local/v99.0');
  for (const value of ['ftp://example.com', 'https://user:pass@example.com', 'https://example.com?v=2', '/relative']) {
    assert.throws(() => graphBaseUrl('facebook', { FACEBOOK_GRAPH_BASE_URL: value }), /FACEBOOK_GRAPH_BASE_URL/);
  }
});

test('Instagram login, Facebook primary, discovery, and hashtag requests honor overrides', async () => {
  const previousIg = process.env.INSTAGRAM_GRAPH_BASE_URL;
  const previousFb = process.env.FACEBOOK_GRAPH_BASE_URL;
  const originalFetch = globalThis.fetch;
  const calls: URL[] = [];
  globalThis.fetch = async input => {
    calls.push(new URL(String(input)));
    return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    process.env.INSTAGRAM_GRAPH_BASE_URL = 'https://ig.example/proxy/v30.0/';
    process.env.FACEBOOK_GRAPH_BASE_URL = 'https://fb.example/proxy/v31.0/';
    const me = new URL(instagramMeUrl('token&encoded=true'));
    assert.equal(me.pathname, '/proxy/v30.0/me');
    assert.equal(me.origin, 'https://ig.example');
    assert.equal(me.searchParams.get('access_token'), 'token&encoded=true');
    const api = new InstagramAPI({ accessToken: 'ig-token', fbAccessToken: 'fb-token', businessAccountId: 'account' });
    await api.getProfile();
    await api.searchHashtag('topic');
    await discoverFacebookInstagramAccount('fb-token');
    api.setFacebookPrimary('ig-user');
    await api.getProfile();
    assert.deepEqual(calls.map(url => url.origin + url.pathname), [
      'https://ig.example/proxy/v30.0/account',
      'https://fb.example/proxy/v31.0/ig_hashtag_search',
      'https://fb.example/proxy/v31.0/me/accounts',
      'https://fb.example/proxy/v31.0/ig-user',
    ]);
    assert.deepEqual(calls.map(url => url.searchParams.get('access_token')), ['ig-token', 'fb-token', 'fb-token', 'fb-token']);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousIg === undefined) delete process.env.INSTAGRAM_GRAPH_BASE_URL; else process.env.INSTAGRAM_GRAPH_BASE_URL = previousIg;
    if (previousFb === undefined) delete process.env.FACEBOOK_GRAPH_BASE_URL; else process.env.FACEBOOK_GRAPH_BASE_URL = previousFb;
  }
});
