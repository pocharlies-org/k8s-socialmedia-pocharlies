/** Shared assertion of the specs that drive canonical MCP errors: the
 * rejection must carry the canonical code (and, when given, a message part).
 * Runs inside jest (the specs import it), so `expect` is the global one. */
export async function expectCanonical(
  promise: Promise<unknown>,
  code: string,
  message?: string
): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error(`expected a rejection with code ${code}`);
    },
    (e: unknown) => e
  );
  expect((error as { canonicalCode?: string }).canonicalCode).toBe(code);
  if (message) expect((error as Error).message).toContain(message);
}
