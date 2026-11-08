import { describe, it } from 'bun:test';
import should from 'should';
import { DisableExpiryWatch, earliestUntil, expiredBetween } from '../../../daemon/lib/service/disable-expiry.ts';

/** The longest timer a host may set (a 32-bit signed millisecond count), as the watch clamps to it. */
const MAX_TIMER_MS = 2_147_483_647;

/** A clock and timers the test moves by hand. */
function rig(next: () => Promise<number | undefined>) {
  let now = 1_000;
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const republished: number[] = [];
  const watch = new DisableExpiryWatch({
    next,
    now: () => now,
    republish: async () => {
      republished.push(now);
    },
    setTimer: (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  return {
    watch,
    timers,
    republished,
    advance: (to: number) => {
      now = to;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('DisableExpiryWatch', () => {
  it('should set no timer when nothing will fall due', async () => {
    const { watch, timers } = rig(async () => undefined);
    await watch.rearm();
    should(timers).be.empty();
  });

  it('should set no timer when the read fails', async () => {
    const { watch, timers } = rig(async () => {
      throw new Error('unreadable');
    });
    await watch.rearm();
    should(timers).be.empty();
  });

  it('should republish when the earliest until falls due, then look for the next one', async () => {
    const dues = [5_000, undefined];
    const { watch, timers, republished, advance } = rig(async () => dues.shift());
    await watch.rearm();
    should(timers.map(timer => timer.ms)).eql([4_000]);

    advance(5_000);
    timers[0]?.run();
    await flush();

    should(republished).eql([5_000]);
    should(timers).have.length(1);
  });

  it('should keep going when the republish fails', async () => {
    const dues = [2_000, 9_000];
    const timers: (() => void)[] = [];
    let now = 1_000;
    const watch = new DisableExpiryWatch({
      next: async () => dues.shift(),
      now: () => now,
      republish: async () => {
        throw new Error('disk full');
      },
      setTimer: run => {
        timers.push(run);
        return () => undefined;
      },
    });
    await watch.rearm();
    now = 2_000;
    timers[0]?.();
    await flush();
    should(timers).have.length(2);
  });

  it('should drop the earlier timer when it is re-armed or stopped', async () => {
    const dues = [5_000, 7_000];
    const { watch, timers } = rig(async () => dues.shift());
    await watch.rearm();
    await watch.rearm();
    should(timers.map(timer => timer.cancelled)).eql([true, false]);
    watch.stop();
    should(timers[1]?.cancelled).be.true();
  });

  it('should let the newer re-arm own the timer when two overlap', async () => {
    const resolvers: ((value: number | undefined) => void)[] = [];
    const { watch, timers } = rig(() => new Promise(resolve => resolvers.push(resolve)));
    const first = watch.rearm();
    const second = watch.rearm();
    resolvers[1]?.(8_000);
    await second;
    resolvers[0]?.(3_000);
    await first;
    should(timers.map(timer => timer.ms)).eql([7_000]);
  });

  it('should wait again when a timer clamped to the 32-bit limit fires early', async () => {
    const far = 1_000 + MAX_TIMER_MS * 2;
    const dues = [far, far];
    const { watch, timers, republished, advance } = rig(async () => dues.shift());
    await watch.rearm();
    should(timers[0]?.ms).equal(MAX_TIMER_MS);

    advance(1_000 + MAX_TIMER_MS);
    timers[0]?.run();
    await flush();

    should(republished).be.empty();
    should(timers).have.length(2);
  });

  it('should fire at once for an expiry already behind it', async () => {
    const { watch, timers } = rig(async () => 500);
    await watch.rearm();
    should(timers[0]?.ms).equal(0);
  });
});

describe('which runtime switches fall due', () => {
  const at = (iso: string) => Date.parse(iso);
  const files = new Map<string, { disabled?: { until?: string } }>([
    ['a', { disabled: { until: '2026-11-08T10:00:00Z' } }],
    ['b', { disabled: { until: '2026-11-09' } }],
    ['c', { disabled: {} }],
    ['d', {}],
    ['e', { disabled: { until: 'not a time' } }],
  ]);

  it('should name the earliest until still ahead, a calendar date meaning the start of that day in UTC', () => {
    should(earliestUntil(files, at('2026-11-08T09:00:00Z'))).equal(at('2026-11-08T10:00:00Z'));
    should(earliestUntil(files, at('2026-11-08T10:00:00Z'))).equal(at('2026-11-09T00:00:00Z'));
    should(earliestUntil(files, at('2026-11-09T00:00:00Z'))).be.undefined();
  });

  it('should name only the switches that fell due in the window, never one already announced', () => {
    should(expiredBetween(files, at('2026-11-08T09:00:00Z'), at('2026-11-08T10:00:00Z'))).eql(['a']);
    should(expiredBetween(files, at('2026-11-08T10:00:00Z'), at('2026-11-09T00:00:00Z'))).eql(['b']);
    should(expiredBetween(files, at('2026-11-08T09:00:00Z'), at('2026-11-09T01:00:00Z'))).eql(['a', 'b']);
    should(expiredBetween(files, at('2026-11-09T00:00:00Z'), at('2026-11-10T00:00:00Z'))).eql([]);
  });
});
