import { describe, expect, it } from 'bun:test';
import { sleepUnlessAborted } from '../../src/adapters/daemon/sleep.ts';

/** The real restart backoff pause: a caller that leaves must not be kept waiting out the backoff (G95). */
describe('sleepUnlessAborted', () => {
  it('G95 an abort ends the pause at once', async () => {
    const caller = new AbortController();
    const started = performance.now();
    const pause = sleepUnlessAborted(30_000, caller.signal);
    setTimeout(() => caller.abort(new Error('gave up')), 5);
    await pause;
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('G95 an already-aborted signal resolves at once', async () => {
    const caller = new AbortController();
    caller.abort();
    const started = performance.now();
    await sleepUnlessAborted(30_000, caller.signal);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('G95 the timer ending first leaves no abort listener behind', async () => {
    const caller = new AbortController();
    let added = 0;
    let removed = 0;
    const signal = caller.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<typeof add>) => {
      added += 1;
      add(...args);
    }) as typeof add;
    signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      removed += 1;
      remove(...args);
    }) as typeof remove;
    await sleepUnlessAborted(5, signal);
    expect(added).toBe(1);
    expect(removed).toBe(1);
  });

  it('G95 with no signal it simply sleeps the time asked', async () => {
    const started = performance.now();
    await sleepUnlessAborted(20);
    expect(performance.now() - started).toBeGreaterThanOrEqual(15);
  });
});
