# Per-chat model and thinking selection

The Social Media Agent panel now offers compact Model and Thinking controls.
Authenticated GET/POST `/api/ai/settings` reads the configured Hermes provider's
real model inventory, validates selections, and persists them per account/chat.
No credentials or other authenticated provider routes enter the browser catalog.
Unsupported reasoning controls are disabled. Effort values are requests to
Hermes; model/provider-specific clamping remains owned by that runtime.

Selections affect new turns. Each owner attempt captures its model/effort;
retries preserve that snapshot. Older unresolved attempts without a snapshot
retain the pre-selector deployment defaults instead of adopting a new choice.
Settings writes serialize with the conversation's transcript writes. A turn
reserves its identity before asynchronous reads, preserving duplicate protection.

Native session lock and run/completion requests receive `model_options`.
Switching to default sends `{}`, clearing a previous explicit reasoning override.
Changing settings never invokes a model or sends a WhatsApp message by itself.
The composer/draft action waits for pending settings persistence.

Validation:

- 580 web tests pass; 40 focused settings/model-lock/run tests pass in the
  candidate Node 22 image, including active-save serialization, original retry
  selection, legacy snapshots, scope boundaries and duplicate request races.
- Compiled UI Playwright passes 16 fixture turns/16 history loads/no direct sends:
  model/thinking persistence, per-chat/account switching, reload, held-save before
  draft submission, failed-save recovery and disabled controls during execution.
- Actual Hermes inventory reports 11 configured provider models including
  `qwen3.8-flash-next`. Isolated app API calls select Qwen/high, execute a diagnostic
  `OK`, then select disabled reasoning and execute another `OK` in the resumed
  session. Observed native lock/run bodies contain the exact selected model and
  reasoning options. All owned diagnostic sessions and temporary state are removed.
- The provider's acknowledgment does not echo effective reasoning effort; the
  evidence proves request propagation and completed runs, not internal token use.
- Independent review's legacy-snapshot finding and the asynchronous identity
  reservation regression were corrected and retested. The pinned checker accepts
  107 contracts with its existing unrelated missing-marker note.

`desktop.png` and `mobile.png` are synthetic UI screenshots, not production
conversations. Published image digest and deployment readback are recorded in PR74.
