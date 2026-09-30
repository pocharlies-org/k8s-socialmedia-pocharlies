/**
 * Counting semaphore (max 2 by default). Own ~15 lines on purpose: p-limit v4+
 * is ESM-only and breaks jest/tsx CJS. A slot is held for the WHOLE task, so the
 * retries the task performs inside `run` never raise the in-flight count.
 */
export class LlmPool {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly max = 2) {
    if (!Number.isInteger(max) || max < 1) throw new Error(`LlmPool max must be >= 1, got ${max}`);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>(resolve => this.waiters.push(resolve));
    else this.active++;
    try {
      return await task();
    } finally {
      const next = this.waiters.shift();
      if (next)
        next(); // hand the slot over: `active` stays the same
      else this.active--;
    }
  }
}
