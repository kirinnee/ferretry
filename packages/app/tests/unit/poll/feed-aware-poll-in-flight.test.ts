import { describe, it } from 'bun:test';

import should from 'should';
import { type FeedAwarePollEnvironment, startFeedAwarePoll } from '../../../src/poll/feed-aware-poll.ts';

/**
 * A READ STILL IN FLIGHT IS NOT STARTED AGAIN. A background read on a locked machine is parked by the shell until the
 * person confirms the unlock (G95), with no way to abort it; a poll that fired on every tick regardless would pile one
 * parked read per tick behind it and release them all at once on the confirm.
 */

/** Timers the test moves by hand: `advance` fires every timer due, in order. */
const handTimers = () => {
  let time = 0;
  const timers: { id: number; at: number; callback: () => void }[] = [];
  let next = 0;
  const environment: FeedAwarePollEnvironment = {
    setTimeout: (callback, milliseconds) => {
      next += 1;
      timers.push({ id: next, at: time + milliseconds, callback });
      return next;
    },
    clearTimeout: handle => {
      const index = timers.findIndex(timer => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    hidden: () => false,
    onVisible: () => () => undefined,
  };
  return {
    environment,
    advance: (milliseconds: number) => {
      const until = time + milliseconds;
      for (;;) {
        const due = timers.filter(timer => timer.at <= until).sort((left, right) => left.at - right.at)[0];
        if (due === undefined) break;
        timers.splice(timers.indexOf(due), 1);
        time = due.at;
        due.callback();
      }
      time = until;
    },
  };
};

/** A read the test releases by hand, like one parked behind an unlock prompt. */
const parkedReads = () => {
  const releases: (() => void)[] = [];
  return {
    read: () =>
      new Promise<void>(resolve => {
        releases.push(resolve);
      }),
    /** How many reads are started and not yet released. */
    pending: () => releases.length,
    releaseAll: async () => {
      for (const release of releases.splice(0)) release();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
};

describe('a feed-aware poll over a read that is still in flight', () => {
  it('skips every tick while the previous read is pending, and reads again on the next tick after it settles', async () => {
    const hand = handTimers();
    const reads = parkedReads();
    const stop = startFeedAwarePoll({
      read: reads.read,
      everyMs: 10_000,
      liveEveryMs: 120_000,
      environment: hand.environment,
    });

    hand.advance(60_000);
    // Six ticks passed while the first read was parked: none started another.
    should(reads.pending()).equal(1);

    await reads.releaseAll();
    hand.advance(10_000);
    should(reads.pending()).equal(1);
    stop();
  });

  it('keeps feed events that arrive during a pending read as ONE trailing read once it settles', async () => {
    const hand = handTimers();
    const reads = parkedReads();
    const listeners = new Set<(event: unknown) => void>();
    const stop = startFeedAwarePoll({
      read: reads.read,
      everyMs: 10_000,
      liveEveryMs: 120_000,
      relevant: () => true,
      feed: {
        subscribe: listener => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      environment: hand.environment,
      settleMs: 250,
    });
    for (let burst = 0; burst < 3; burst += 1) {
      for (const listener of listeners) listener({ burst });
      hand.advance(300);
    }
    should(reads.pending()).equal(1);

    await reads.releaseAll();

    // One read for everything the feed said while the first was parked: no burst.
    should(reads.pending()).equal(1);
    await reads.releaseAll();
    stop();
  });

  it('keeps no guard for a read that returns nothing, exactly as before', () => {
    const hand = handTimers();
    let reads = 0;
    const stop = startFeedAwarePoll({
      read: () => {
        reads += 1;
      },
      everyMs: 10_000,
      liveEveryMs: 120_000,
      environment: hand.environment,
    });
    hand.advance(30_000);
    should(reads).equal(4);
    stop();
  });
});
