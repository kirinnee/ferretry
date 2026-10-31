import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import {
  MemberSweepTimer,
  type SweepClock,
  systemSweepClock,
} from '../../../src/adapters/catalog-members/sweep-timer.ts';

/** A clock the test turns by hand. */
class ManualClock implements SweepClock {
  readonly intervals: number[] = [];
  stopped = 0;
  #callback: (() => void) | undefined;

  repeat(callback: () => void, ms: number): () => void {
    this.intervals.push(ms);
    this.#callback = callback;
    return () => {
      this.stopped += 1;
    };
  }

  tick(): void {
    this.#callback?.();
  }
}

const settle = async (): Promise<void> => {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
};

describe('MemberSweepTimer', () => {
  it('asks the clock for the interval it was started with', () => {
    const clock = new ManualClock();

    new MemberSweepTimer(
      clock,
      async () => undefined,
      () => undefined,
    ).start(60_000);

    should(clock.intervals).deepEqual([60_000]);
  });

  it('runs the sweep on each tick', async () => {
    const clock = new ManualClock();
    let sweeps = 0;
    new MemberSweepTimer(
      clock,
      async () => {
        sweeps += 1;
      },
      () => undefined,
    ).start(10);

    clock.tick();
    clock.tick();
    await settle();

    should(sweeps).equal(2);
  });

  it('reports a sweep that throws and still runs the next one', async () => {
    const clock = new ManualClock();
    const reported: unknown[] = [];
    let sweeps = 0;
    const boom = new Error('disk is read-only');
    new MemberSweepTimer(
      clock,
      async () => {
        sweeps += 1;
        if (sweeps === 1) throw boom;
      },
      error => reported.push(error),
    ).start(10);

    clock.tick();
    await settle();
    clock.tick();
    await settle();

    should(reported).deepEqual([boom]);
    should(sweeps).equal(2);
  });

  it('hands back the clock’s stop function', () => {
    const clock = new ManualClock();

    const stop = new MemberSweepTimer(
      clock,
      async () => undefined,
      () => undefined,
    ).start(10);
    stop();

    should(clock.stopped).equal(1);
  });
});

describe('systemSweepClock', () => {
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  it('fires repeatedly until it is stopped, and does not keep the process alive', async () => {
    let fired = 0;
    stop = systemSweepClock.repeat(() => {
      fired += 1;
    }, 5);

    await new Promise<void>(resolve => setTimeout(resolve, 40));
    should(fired).be.above(1);

    stop();
    stop = undefined;
    const after = fired;
    await new Promise<void>(resolve => setTimeout(resolve, 25));
    should(fired).equal(after);
  });
});
