/** Bound repeated probes while a migration is missing, logging each outage once. */
export class MissingTableBackoff {
  private until = 0;
  private logged = false;

  constructor(
    private readonly delayMs: number,
    private readonly missingMessage: string,
    private readonly readyMessage: string
  ) {}

  reset(): void {
    this.until = 0;
    this.logged = false;
  }

  isMissing(): boolean {
    return this.until > Date.now();
  }

  markMissing(): void {
    this.until = Date.now() + this.delayMs;
    if (!this.logged) console.warn(this.missingMessage);
    this.logged = true;
  }

  markPresent(): void {
    if (this.logged) console.info(this.readyMessage);
    this.reset();
  }
}
