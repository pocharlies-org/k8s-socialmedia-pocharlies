export function graphBaseUrl(provider: 'instagram' | 'facebook', env = process.env): string {
  const name = provider === 'instagram' ? 'INSTAGRAM_GRAPH_BASE_URL' : 'FACEBOOK_GRAPH_BASE_URL';
  const fallback = provider === 'instagram' ? 'https://graph.instagram.com/v21.0' : 'https://graph.facebook.com/v22.0';
  let url: URL;
  try { url = new URL(env[name]?.trim() || fallback); } catch { throw new Error(`${name} must be an absolute URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must use HTTP(S) without credentials, query or fragment`);
  }
  return url.toString().replace(/\/$/, '');
}

export function instagramMeUrl(accessToken: string): string {
  const url = new URL(`${graphBaseUrl('instagram')}/me`);
  url.searchParams.set('fields', 'id,user_id');
  url.searchParams.set('access_token', accessToken);
  return url.toString();
}
