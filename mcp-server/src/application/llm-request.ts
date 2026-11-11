/**
 * Extra body for the short chat completions this server makes through LiteLLM
 * (`tooling` = the resident reasoning model). With thinking on, the model spends
 * the small `max_tokens` budget (200-500) on reasoning and returns an EMPTY
 * content: social_summarize answered "Failed to generate summary" (measured
 * 02-10-2026: 200/200 completion tokens, all of them reasoning_tokens).
 *
 * The knob is `reasoning_effort: "none"`, the client tier LiteLLM's hook
 * honours (contract litellm.reasoning-effort.v1). A bare top-level
 * `enable_thinking: false` is NOT honoured: measured on a 50k-token prompt,
 * max_tokens 200 -> enable_thinking:false = 200 reasoning tokens, 0 content;
 * reasoning_effort:"none" = 0 reasoning, 685 chars of content.
 *
 * Typed as an empty object on purpose: the OpenAI SDK types do not list "none"
 * as an effort, while the body must still carry it. Spread it into create().
 */
export const NO_THINKING = { reasoning_effort: 'none' } as unknown as Record<never, never>;
