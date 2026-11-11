# Large image uploads

The deployed Node 22 web app reproduced HTTP 500 `Internal server error` for
a 4 MiB image upload before any connector request. `uploadBytes` used a grouped
Base64 regex which overflowed V8's stack on multi-MiB strings. The declared
decoded upload limit remained 10 MiB, but normal files below that limit failed.

Base64 validation now scans the standard alphabet and terminal padding with
constant stack usage. Filename, MIME, decoded-size checks, caption/quality,
source digest and sendToken/idempotency propagation remain unchanged. The same
validator protects the two provider avatar read paths, which had the same issue.

Validation:

- Before: deployed app HTTP 500 for 4 MiB, zero connector calls; direct validation
  overflow at 4 and 8 MiB.
- After: 550 web unit/integration tests passed. The candidate Node 22 image
  passed 57 upload/security/avatar tests, including 4/10 MiB uploads, malformed
  Base64 (400), oversized files (413), and 4 MiB avatar reads.
- Independent review found no blocking defect; pinned contract checker accepts
  106 entries with its existing unrelated missing-marker note.
- `large-upload.playwright.mjs` uses the actual app HTTP route and UI with fixture
  database rows and an external connector stub. A valid PNG larger than 4 MiB
  is decoded, uploaded, and reconciled in the same optimistic bubble. A repeated
  request preserves its send token. The stub models one provider effect; this
  does not prove real WhatsApp delivery or retry deduplication.

`large-upload-confirmed.png` is a synthetic QA screenshot. No test image is sent
to a production chat. Published digest and live Node 22 verification are recorded
in PR74 after rollout. The failed browser draft must be retried by its owner;
the server does not invent or automatically resend the original image.
