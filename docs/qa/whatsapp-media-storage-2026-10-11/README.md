# Sent photo storage and refresh

An accepted WhatsApp image could appear as caption only: MinIO rejected the
upload with `SignatureDoesNotMatch` when its original filename contained
non-ASCII characters in the signed `x-amz-meta-filename` header.

The redundant object header is omitted. The original filename remains in
`attachments.file_name`, alongside the caption and MIME type. After attachment
commit, the connector publishes the existing account-scoped message hint, so
the browser reads the completed message without waiting for another message or
reload. A hint failure cannot invalidate the committed upload. The notification
uses the same database connection, avoiding pool exhaustion during concurrent
uploads. This does not resend messages or change the HTTP send response.

Validation:

- Reproduced the production error with an accented filename; an ASCII filename
  succeeded using the same endpoint and credentials.
- Candidate image: actual MinIO write/read with ASCII, accented and emoji names
  passed; all owned storage probe objects were removed.
- 47 connector media tests passed, including six new storage/notification
  regressions. The final notification connection fix was retested: six passed.
- 58 browser rendering/change-bus/live-update tests passed.
- Connector TypeScript compilation and the official pinned contract checker
  passed (106 entries; pre-existing missing-marker note).
- Independent review caught and verified the fix for pool exhaustion; no
  blocking finding remains.

`media-attachment-refresh.playwright.mjs` exercises a delayed image attachment
on the real app frontend with fixture APIs and SSE. Any screenshot here is a
QA fixture, not a production account capture.

The reported image's original provider bytes were still downloadable from its
durable payload (303,463 bytes, JPEG). Recovery attaches them to the existing
message; it does not send another WhatsApp message. Live restoration and image
pins are recorded in the PR deployment note after rollout.
