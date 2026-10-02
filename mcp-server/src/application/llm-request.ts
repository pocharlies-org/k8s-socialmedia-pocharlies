/**
 * Extra body for the short chat completions this server makes through LiteLLM
 * (`tooling` = the resident reasoning model). With thinking on, the model spends
 * the small `max_tokens` budget (200-500) on reasoning and returns an EMPTY
 * content: social_summarize answered "Failed to generate summary" (measured
 * 02-10-2026, 200/200 completion tokens, 0 of content). Same switch the
 * brain-windows extractor sends (jobs/brain-window-llm.ts).
 *
 * Spread into the create() params: the OpenAI SDK types do not know the field,
 * and a spread skips the excess-property check while the body still carries it.
 */
export const NO_THINKING = { enable_thinking: false } as const;
