/**
 * ref -> hilo_ref of the messages this process forwarded, so GET /mensajes/{ref}
 * knows which conversation to read: neither connector can fetch a message by
 * its id alone (WhatsApp has no such route, Telegram needs the chat).
 *
 * shortcut: in memory, so after a restart an older ref gives 404 (the core's
 * case view reads /hilos, which does not need this); upgrade to a connector
 * route by message id if the core starts reading /mensajes for old refs.
 */
export class IndiceRefs {
  private readonly entries = new Map<string, { hilo: string; t: number }>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now()
  ) {}

  guardar(ref: string, hilo: string): void {
    this.entries.delete(ref);
    this.entries.set(ref, { hilo, t: this.now() });
    if (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  hilo(ref: string): string | undefined {
    const e = this.entries.get(ref);
    if (!e) return undefined;
    if (this.now() - e.t >= this.ttlMs) {
      this.entries.delete(ref);
      return undefined;
    }
    return e.hilo;
  }

  size(): number {
    return this.entries.size;
  }
}
