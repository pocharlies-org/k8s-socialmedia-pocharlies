# Integrated Hermes QA

The screenshots use synthetic contacts and mocked responses from the Playwright
fixture, not private WhatsApp conversations.

- `private-assistant.playwright.mjs` covers confirmed stop with the previous SSE
  connection still open, the next turn, failed stop, early cancellation, image
  attachment/paste and restored history, copy, audio playback, and chat isolation.
- `mobile-pwa.playwright.mjs` covers list, WhatsApp and Hermes controls in a canvas
  shorter than the physical screen, with two keyboard open/dismiss cycles.
- Fedora native run probes confirm the shared skills/MCP configuration, Omnivoice
  selection and cancellation of a running tool. No WhatsApp delivery is performed
  by these probes.

Headless Chromium/WebKit do not establish whether native iPhone WebKit recovers
its missing bottom canvas. The layout now bounds controls to the reported visible
area; physical-device confirmation remains necessary.
