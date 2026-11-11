# WhatsApp app authentication

The web app supports OIDC with a confidential Keycloak client. The browser uses
the authorization code flow with PKCE. Use the existing application realm; do
not use the administrative realm for app users.

Configure these variables in the private deployment `.env`:

- `APP_AUTH_MODE=oidc`
- `WHATSAPP_APP_PUBLIC_URL`: public HTTPS origin of the app.
- `OIDC_ISSUER_URL`: Keycloak HTTPS realm URL.
- `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`: the app's dedicated client.
- `OIDC_ALLOWED_SUBJECTS`: comma-separated Keycloak user IDs permitted to access
  all configured WhatsApp accounts. This is an authorization boundary, not a
  list of email domains.
- `OIDC_SESSION_TTL_SECONDS=2592000`: 30-day local session lifetime. Sessions
  survive app restarts in the mounted `/data/auth/oidc-sessions.json` store.
- `WHATSAPP_APP_UID=1000` and `WHATSAPP_APP_GID=10`: non-root identity matching
  the NAS ACLs for the mounted registry, CA certificate and app data directory.

Register only `<WHATSAPP_APP_PUBLIC_URL>/auth/callback` as the client's redirect
URI. Enable standard authorization code flow and require PKCE `S256`. Disable
implicit flow, direct password grants, and service accounts.

Render with `scripts/render-compose.py` using the same `.env` used by Compose.
In OIDC mode the app receives no Basic Auth credentials. The independent
connector QR/admin endpoints continue using their existing credentials, and
the Socialmedia MCP retains its bearer authentication.

For the NAS deployment, the source is `/home/staticduo/git/socialmedia` and the
active Compose and private `.env` are in `/volume2/docker/social-media`.
The app origin is `https://whatsapp.staticduo.com`; the issuer is
`https://auth.staticduo.com/realms/apps`. The client is `whatsapp-socialmedia`.
No user IDs or client secrets belong in this document or the template.
