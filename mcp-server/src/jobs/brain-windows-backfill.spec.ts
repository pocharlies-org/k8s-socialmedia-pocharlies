import { createLimiter } from './brain-window-llm';
import { runLimitedBatch } from './brain-windows-backfill';

const tick = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('runLimitedBatch (LLM phase of the backfill)', () => {
  it('keeps exactly N windows in flight, not one by one', async () => {
    let active = 0;
    let peak = 0;
    const { results, processed } = await runLimitedBatch(
      Array.from({ length: 10 }, (_, i) => i),
      createLimiter(4),
      { out: () => false },
      async () => {
        active++;
        peak = Math.max(peak, active);
        await tick(10);
        active--;
        return 'done';
      }
    );
    expect(peak).toBe(4);
    expect(processed).toBe(10);
    expect(results.every(r => r === 'done')).toBe(true);
  });

  it('stops admitting once the budget is out and reports the processed prefix', async () => {
    let started = 0;
    const { results, processed } = await runLimitedBatch(
      Array.from({ length: 8 }, (_, i) => i),
      createLimiter(2),
      { out: () => started >= 3 },
      async () => {
        started++;
        await tick(5);
        return 'skipped';
      }
    );
    expect(processed).toBe(3);
    expect(results).toHaveLength(3);
  });

  it('a crashing window counts as failed and the rest go on', async () => {
    const { results } = await runLimitedBatch(
      [1, 2, 3],
      createLimiter(2),
      { out: () => false },
      async n => {
        if (n === 2) throw new Error('boom');
        return 'done';
      }
    );
    expect(results).toEqual(['done', 'failed', 'done']);
  });
});
