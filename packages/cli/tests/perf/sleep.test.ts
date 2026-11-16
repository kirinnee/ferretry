import { describe, expect, it } from 'bun:test';
import { sleepUnlessAborted } from '../../src/adapters/daemon/sleep.ts';

/** The real restart backoff pause: how fast it ends (G95). The behaviour itself is proven in tests/unit/sleep.test.ts. */
describe('sleepUnlessAborted speed', () => {
  it('G95 an abort ends a 30 s pause within 2 s', async () => {
    const caller = new AbortController();
    const started = performance.now();
    const pause = sleepUnlessAborted(30_000, caller.signal);
    setTimeout(() => caller.abort(new Error('gave up')), 5);
    await pause;
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('G95 an already-aborted signal resolves within 2 s', async () => {
    const caller = new AbortController();
    caller.abort();
    const started = performance.now();
    await sleepUnlessAborted(30_000, caller.signal);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('G95 with no signal it sleeps at least the time asked', async () => {
    const started = performance.now();
    await sleepUnlessAborted(20);
    expect(performance.now() - started).toBeGreaterThanOrEqual(15);
  });
});
