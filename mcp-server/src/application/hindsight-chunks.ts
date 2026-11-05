import type { Pool } from 'pg';
import { chunkWindow, loadWindowForLlm, type PendingLlmWindow } from '../jobs/brain-windows-lib';

/**
 * The boundary writer stores a retained chunk under `writer:` + sha256(identity NUL document_id),
 * and the document_id we write is the chunk's brain source_id (`win:…#cN`). A hit therefore
 * carries no account, conversation or message ids: they are recovered here from the
 * `brain_windows` ledger, never from anything the remote side says about itself.
 */
export interface ResolvedChunk {
  window: PendingLlmWindow;
  index: number;
}

/** Hindsight document ids → the ledger window and chunk number they were written from. */
export async function resolveChunks(
  pool: Pool,
  documentIds: string[],
  account: string,
  identities: string[]
): Promise<Map<string, ResolvedChunk>> {
  const resolved = new Map<string, ResolvedChunk>();
  if (!documentIds.length || !identities.length) return resolved;
  // Hashing in SQL (~250 ms over the whole personal ledger) keeps ~220k digests out of the
  // 512Mi heap; the writer-identity list is the only thing that decides which hashes can match.
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT w.source_id, w.account, w.platform, w.conversation_id, w.window_key, w.part,
              w.start_ts, w.end_ts, w.message_count, w.conv_kind, w.content_hash,
              w.llm_input_hash, c.n,
              'writer:' || encode(sha256(convert_to(i.id, 'UTF8') || decode('00', 'hex') ||
                convert_to(w.source_id || '#c' || c.n, 'UTF8')), 'hex') AS document_id
         FROM brain_windows w
         CROSS JOIN LATERAL generate_series(1, w.chunk_count) c(n)
         CROSS JOIN unnest($1::text[]) i(id)
        WHERE w.account = $2 AND w.chunk_count > 0
     ) r WHERE r.document_id = ANY($3::text[])`,
    [identities, account, documentIds]
  );
  for (const { n, document_id, ...window } of rows)
    resolved.set(document_id, { window: window as PendingLlmWindow, index: Number(n) });
  return resolved;
}

/** `wa_message_id`s of each resolved chunk, recomputed with the builder that wrote it. */
export async function chunkMessageIds(
  pool: Pool,
  resolved: Map<string, ResolvedChunk>
): Promise<Map<string, string[]>> {
  const chunksOf = new Map<string, ReturnType<typeof chunkWindow>>();
  for (const { window } of resolved.values()) {
    if (chunksOf.has(window.source_id)) continue;
    const built = await loadWindowForLlm(pool, window);
    chunksOf.set(window.source_id, built ? chunkWindow(built) : []);
  }
  return new Map(
    [...resolved].map(([documentId, { window, index }]) => [
      documentId,
      chunksOf.get(window.source_id)?.find(c => c.index === index)?.message_ids ?? [],
    ])
  );
}
