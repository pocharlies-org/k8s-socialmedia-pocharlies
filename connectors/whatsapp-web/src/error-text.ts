/** Render provider/database failures without depending on their thrown type. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
