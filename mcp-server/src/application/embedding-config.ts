/** Shared writer/search defaults match the immutable initial database schema. */
export function embeddingConfig() {
  const model = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
  const dimensions = Number(
    process.env.EMBEDDING_DIMENSIONS || process.env.EMBEDDING_DIMENSION || '1536'
  );
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new Error('EMBEDDING_DIMENSIONS/EMBEDDING_DIMENSION must be a positive integer');
  }
  return { model, dimensions };
}
