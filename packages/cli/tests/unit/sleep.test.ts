import { describe, expect, it } from 'bun:test';
import { sleepUnlessAborted } from '../../src/adapters/daemon/sleep.ts';

/** The real restart backoff pause: a caller that leaves must not be kept waiting out the backoff (G95). */
describe('sleepUnlessAborted', () => {
  it('G95 an abort ends the pause (a hang would time the test out)', async () => {
    const caller = new AbortController();
    const pause = sleepUnlessAborted(30_000, caller.signal);
    setTimeout(() => caller.abort(new Error('gave up')), 5);
    expect(await pause).toBeUndefined();
  });

  it('G95 an already-aborted signal resolves at once', async () => {
    const caller = new AbortController();
    caller.abort();
    expect(await sleepUnlessAborted(30_000, caller.signal)).toBeUndefined();
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

  it('G95 with no signal it simply resolves after the time asked', async () => {
    expect(await sleepUnlessAborted(20)).toBeUndefined();
  });
});
