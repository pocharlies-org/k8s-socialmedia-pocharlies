# Hermes failed-run reconciliation

The reported web turn failed in the existing Fedora Hermes profile before any
model/tool execution. The app requested provider `openclaw-litellm`, while the
live profile now defines `litellm`; the run returned a typed unknown-provider
error after 17 ms. The web ledger retained its run ID but no answer, so retry
treated the confirmed failure as an indefinitely uncertain execution.

The app now reads the existing run before retrying or stopping. Completed runs
restore their output without resubmission. Failed runs show a sanitized error
and clear thinking state. Only the exact provider-resolution failure with no
execution evidence offers an explicit safe retry; running/unknown/submission-
pending states never authorize another run. Retry keeps the owner turn and
delivery request ID while using a separate persisted run-submission key.

Stop can find a run in the durable ledger after active cleanup. Identity checks
under the session lock prevent a delayed stop or previous cleanup from replacing
a newer attempt. Observed tool/partial-output evidence survives stream errors.
The UI keeps Stop available for uncertain outcomes and can restore completed
history without sending the instruction again. Image retries after reload keep
original names and bytes; legacy images without names cannot be replayed.

Validation: 572 web tests pass, including scoped endpoint, run/stream/model-lock,
concurrency and retry regressions. Playwright using the compiled UI passed 13
fixture turns, nine history reads, failure/reload/manual retry, named images,
uncertain Stop and completed-result recovery, with no WhatsApp writes. The
existing private-assistant browser fixture also passed 15 turns. Candidate
Node 22 checks and runtime evidence are recorded in PR74 after rollout.

The deployment changes only the web image and `HERMES_PROVIDER=litellm`, keeping
the existing Fedora Hermes instance and `gpt-6-luna`. A protected copy of the
affected app session is retained before reconciliation. Its original owner
instruction is never executed automatically by this repair.

Independent review findings (completed Stop, stale stop settlement, active-map
cleanup, reloaded image names) were corrected and retested. Existing streaming
redaction covers the current capability; generic redaction of older capabilities
in streamed deltas remains a separate, pre-existing follow-up. Final and restored
outputs redact captured capability tokens.
