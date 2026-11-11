# WhatsApp send idempotency

`/messages/send`, `/messages/media/send`, and `/messages/audio` accept `sendToken`.
The web app supplies a UUID once per user send action and reuses it for retries.
The connector reserves `(account, SHA-256(sendToken))` in PostgreSQL before calling
Baileys. The row contains a request hash, a stable WhatsApp message ID, and a
`prepared`, `pending`, or `sent` status; it stores neither the token nor message
contents. `prepared` covers local fetch, recipient/session checks, and quoted
message lookup. An atomic transition to `pending` occurs immediately before
Baileys' send call, so a preflight failure can retry with the same token. If
concurrent requests finish preflight, only one can claim `pending` and call
Baileys.

For voice and converted GIF/sticker uploads, the app also sends SHA-256 and MIME
type of the original uploaded bytes. The request hash uses that digest, the
original and outgoing media types, and send metadata
so conversion output differences do not turn an identical retry into a conflict.
The connector requires the original MIME type whenever a source digest is sent.

An identical retry after `sent` returns the original message ID. A changed
payload with the same token returns HTTP 409. A retry while `pending` also
returns HTTP 409 with `send_outcome_uncertain` and the reserved message ID;
it never calls Baileys again. A timeout does not cancel Baileys' in-flight
send, and a process crash can leave a row `pending` even when WhatsApp accepted
the message. Inspect message history using the returned ID before starting a
new send with a new token. `sent` means Baileys returned that ID; recipient
delivery is a separate state.

Media and voice endpoints still permit callers without a token for existing
MCP tool compatibility. Those legacy requests have no durable deduplication.
The web app sends tokens on all three endpoints.
