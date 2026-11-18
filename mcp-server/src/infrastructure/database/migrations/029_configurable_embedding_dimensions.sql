-- Keep prod 001 byte-identical. Changing embedding models on a populated table
-- requires an explicit re-embedding plan; this function never discards vectors.
CREATE OR REPLACE FUNCTION social_configure_embedding_dimensions(requested integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE current_dimensions integer;
BEGIN
  IF requested IS NULL OR requested < 1 OR requested > 16000 THEN
    RAISE EXCEPTION 'Embedding dimensions must be between 1 and 16000';
  END IF;
  LOCK TABLE message_embeddings IN ACCESS EXCLUSIVE MODE;
  SELECT atttypmod INTO current_dimensions FROM pg_attribute
  WHERE attrelid = 'message_embeddings'::regclass AND attname = 'embedding';
  IF current_dimensions = requested THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM message_embeddings WHERE embedding IS NOT NULL) THEN
    RAISE EXCEPTION 'Embedding dimension mismatch: stored %, requested %. Preserve vectors and plan a separate re-embedding migration.', current_dimensions, requested;
  END IF;
  -- The prod ANN index supports vector dimensions only up to 2000.
  IF requested > 2000 THEN
    DROP INDEX IF EXISTS idx_message_embeddings_vector;
  END IF;
  EXECUTE format('ALTER TABLE message_embeddings ALTER COLUMN embedding TYPE vector(%s)', requested);
END $$;
