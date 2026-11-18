# Business message content and history recovery

Production inspection identified two separate causes:

- Full templates, buttons and selected replies were stored without visible text,
  although their original provider payload remained available.
- A genuine `placeholderMessage` was considered locally restored, omitted from
  the resend scan, and the UI displayed its waiting notice indefinitely.

The connector extracts only visible allowlisted fields from business templates,
buttons, lists and native-flow replies, including quoted wrappers. Empty business
rows are filled locally; placeholders remain eligible for provider resend.
Existing text, edits, captured payloads and account/platform isolation are kept.

The app uses the established flat quote metadata contract. Unknown LIDs are
not display names and locally hidden targets cannot be revived through a quote.
History waiting notices expire after 30 seconds with manual retry. Older replies
cannot replace the state of a newer attempt.

Validation: 61 connector parser/history/durable/quote tests passed; the final
forwarded-context fix passed 33 focused tests and TypeScript. Disposable
PostgreSQL verified eight business types and placeholder replacement while
preserving edited/nonempty/foreign-account rows. 98 focused web API/rendering/
quote/chat-scope tests passed. Playwright checked readable business text and
quotes, no unnecessary recovery, scope isolation and a deterministic timeout.
The official pinned contract checker accepted 106 entries with its existing
unrelated missing-marker note. Independent review found no blocking defect.

`business-messages.png`, `history-recovery.png` and `trace.zip` are synthetic QA
artifacts, not production captures or proof of provider delivery. Live repair
results and published image digests are recorded in PR74 after rollout.
Recovery does not send any new chat messages.
