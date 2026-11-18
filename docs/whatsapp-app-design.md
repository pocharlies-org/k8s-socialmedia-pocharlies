# WhatsApp app for Socialmedia

Source: apps/whatsapp. Deployment remains in the existing Socialmedia Compose stack.

## Approved scope

A responsive installable web app for configured WhatsApp accounts: conversation browsing,
media viewing/downloads, text and recorded audio, and a private AI conversation panel.
Accounts and all external endpoints come from configuration. Instagram is out of scope.
The existing Baileys sessions remain authoritative; no additional WhatsApp pairing.

## Boundaries

The server authenticates browser access, validates account/conversation scope, signs
connector requests, and proxies attachments without disclosing upstream credentials.
Manual WhatsApp actions do not require a model. AI conversations are persisted separately
and tied to the account and selected chat, with an explicit global context mode.
Hermes is an optional agent backend via its API; models are supplied by LiteLLM.
An unavailable agent must produce a clear error, never a simulated successful action.
The MCP global write gate remains separate from manual browser sending.

## Validation

Server tests cover auth, CSRF, account isolation, malformed uploads and provider errors.
Generator tests verify opt-in deployment and dynamic account secret forwarding.
Integration checks use existing accounts read-only. Browser checks exercise mobile and
desktop navigation and media controls. No unsolicited WhatsApp messages are sent by tests.
