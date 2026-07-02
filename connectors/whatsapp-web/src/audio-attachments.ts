/**
 * F1.7 "honest voice": build the audio attachment payload for the NATS
 * MessageReceivedEvent BEFORE it is emitted.
 *
 * Why: historically media upload ran fire-and-forget AFTER the event emit, so
 * the event never carried attachments and synapse's conversation adapter
 * (audio.py) raised PermanentError("no downloadable audio attachment") for
 * EVERY voice note → blind handoff. For AUDIO we now await the MinIO upload
 * (bounded) and ride a presigned, out-of-cluster-reachable URL on the event.
 *
 * Contract consumed by synapse audio.py (_audio_from_attachment):
 *   - att.url        http(s) URL it GETs (presigned; auth in query params)
 *   - att.metadata.{mimeType,fileName} fallbacks for content-type/filename
 * Extra metadata (fileSize/seconds/objectKey/urlExpiresInSeconds) is
 * informational and ignored by consumers that don't know it.
 *
 * Failure semantics (MUST degrade to pre-F1.7 behavior, never block ingest):
 *   - store timeout    → undefined (event emits without attachments); the
 *                        underlying download+persist keeps running so the DB
 *                        attachment row still lands.
 *   - store failure    → undefined (already logged by the store fn).
 *   - presign null/err → undefined (no public endpoint configured, legacy
 *                        ref, or signer error).
 * The helper NEVER throws and never leaves an unhandled rejection behind.
 */

export interface StoredMediaInfo {
  /** Canonical storage ref, e.g. s3://skirmshop-drive/socialmedia/attachments/... */
  storageKey: string;
  fileSize: number;
  mimeType?: string;
  fileName?: string;
}

export interface AudioAttachment {
  type: string;
  url: string;
  metadata: Record<string, unknown>;
}

export interface BuildAudioAttachmentsOptions {
  /**
   * Kicks the download+upload+DB-persist pipeline. Long-running; resolves to
   * the stored object info or null on failure. Invoked exactly once — the
   * returned promise keeps running past the timeout race on purpose.
   */
  store: () => Promise<StoredMediaInfo | null>;
  /** Presigned GET URL reachable from OUTSIDE the cluster, or null when unavailable. */
  presign: (storageKey: string) => Promise<string | null>;
  /** Upper bound on how long the event emit may wait for the upload. */
  timeoutMs: number;
  /** Voice note duration (Baileys audioMessage.seconds), when known. */
  seconds?: number;
  /** Presign expiry ridden as metadata so consumers can reason about staleness. */
  presignExpirySeconds: number;
  logger: { info(msg: string): void; warn(msg: string): void };
  /** PII-free id for log lines (wa message id). */
  logRef: string;
}

export async function buildAudioAttachmentsBeforeEmit(
  opts: BuildAudioAttachmentsOptions
): Promise<AudioAttachment[] | undefined> {
  const { timeoutMs, logger, logRef } = opts;

  // Kick the pipeline ONCE and shield it: on timeout we abandon the wait but
  // the promise keeps running (DB persist still lands) and a late rejection
  // must never surface as an unhandled rejection.
  const stored = opts.store().catch((e: unknown) => {
    logger.warn(`audio pre-emit store failed for ${logRef}: ${(e as Error)?.message || String(e)}`);
    return null;
  });

  // NOTE: deliberately NOT unref'd — this is a short, bounded race and the
  // timer must be guaranteed to fire (an unref'd timer can be skipped when the
  // event loop drains, leaving the race pending forever). It is cleared as
  // soon as the race settles.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol('timeout');
  const result = await Promise.race([
    stored,
    new Promise<typeof timedOut>(resolve => {
      timer = setTimeout(() => resolve(timedOut), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (result === timedOut) {
    logger.warn(
      `audio pre-emit upload exceeded ${timeoutMs}ms for ${logRef}; ` +
        'emitting without attachments (persist continues in background)'
    );
    return undefined;
  }
  if (!result) return undefined; // store failed; already logged above/inside.

  let url: string | null = null;
  try {
    url = await opts.presign(result.storageKey);
  } catch (e: unknown) {
    logger.warn(`audio presign failed for ${logRef}: ${(e as Error)?.message || String(e)}`);
    return undefined;
  }
  if (!url) {
    logger.warn(
      `audio presign unavailable for ${logRef} (no S3_PUBLIC_ENDPOINT or legacy ref); ` +
        'emitting without attachments'
    );
    return undefined;
  }

  logger.info(`audio attachment ready pre-emit for ${logRef} (${result.fileSize} bytes)`);
  return [
    {
      type: 'audio',
      url,
      metadata: {
        mimeType: result.mimeType,
        fileName: result.fileName,
        fileSize: result.fileSize,
        ...(typeof opts.seconds === 'number' && opts.seconds > 0 ? { seconds: opts.seconds } : {}),
        objectKey: result.storageKey,
        urlExpiresInSeconds: opts.presignExpirySeconds,
      },
    },
  ];
}
