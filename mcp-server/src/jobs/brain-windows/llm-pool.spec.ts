import { LlmPool } from './llm-pool';

describe('LlmPool', () => {
  it('never runs more than max tasks at once and runs them all', async () => {
    const pool = new LlmPool(2);
    let active = 0;
    let peak = 0;
    const task = async (i: number) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return i;
    };
    const out = await Promise.all(Array.from({ length: 12 }, (_, i) => pool.run(() => task(i))));
    expect(out).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(peak).toBe(2);
  });

  it('releases the slot when a task throws', async () => {
    const pool = new LlmPool(1);
    await expect(pool.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(pool.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('rejects a max below 1', () => {
    expect(() => new LlmPool(0)).toThrow();
  });
});
