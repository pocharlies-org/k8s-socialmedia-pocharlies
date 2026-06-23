/**
 * In-memory TTL dedup set keyed by waMessageId.
 *
 * NATS core (no JetStream) gives at-MOST-once delivery within a queue group, so
 * the same message is normally seen at most once. This guard is a cheap defence
 * against a connector re-publishing the same waMessageId (e.g. Baileys retries
 * or a restart-driven replay) within the TTL window, so the gateway never gets
 * a duplicate forward. It is process-local: it does NOT survive a restart and is
 * NOT shared across replicas. That is acceptable because the gateway itself is
 * expected to be idempotent on waMessageId; this only trims obvious local dupes.
 *
 * Fail-closed contract: `has()` only ever ADDS load to the drop decision. A
 * miss returns false (forward may proceed); a hit returns true (drop). We never
 * forward more because of dedup, only less.
 */
export class DedupCache {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Returns true if `key` was already seen within the TTL window. On a miss the
   * key is recorded (mark-on-first-sight) so the immediate next sighting hits.
   */
  has(key: string): boolean {
    if (!key) {
      // No id => cannot dedup. Caller (filter) treats an empty waMessageId as a
      // drop on its own, so we never reach forwarding with an unknown id.
      return false;
    }
    const t = this.now();
    this.evictExpired(t);

    const seenAt = this.entries.get(key);
    if (seenAt !== undefined && t - seenAt < this.ttlMs) {
      // refresh recency so a busy conversation keeps the entry warm
      this.entries.set(key, t);
      return true;
    }

    this.record(key, t);
    return false;
  }

  /** Current number of live (post-eviction) entries; for /status only. */
  size(): number {
    this.evictExpired(this.now());
    return this.entries.size;
  }

  private record(key: string, t: number): void {
    this.entries.set(key, t);
    if (this.entries.size > this.maxEntries) {
      // Map preserves insertion order: drop the oldest key.
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  private evictExpired(t: number): void {
    // Map iterates in insertion order; expired entries cluster at the front.
    for (const [key, seenAt] of this.entries) {
      if (t - seenAt < this.ttlMs) break;
      this.entries.delete(key);
    }
  }
}
