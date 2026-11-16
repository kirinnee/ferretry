import { describe, it } from 'bun:test';
import type { Cancel } from '@ferretry/kernel/contract';
import should from 'should';
import { CancellableTimers } from '../../../daemon/adapters/cancellable-timers.ts';

/** A clock that runs a wait only when told: `fire(at)` runs it, and a cancelled one is gone. */
function clock() {
  const waiting = new Map<number, () => void>();
  let next = 0;
  return {
    waiting,
    clock: {
      after: (_delay: unknown, run: () => void): Cancel => {
        next += 1;
        const mine = next;
        waiting.set(mine, run);
        return () => void waiting.delete(mine);
      },
    },
    fire: () => {
      for (const [key, run] of [...waiting]) {
        waiting.delete(key);
        run();
      }
    },
  };
}

describe('CancellableTimers', () => {
  it('should resolve a wait when its time comes, and keep none pending after it', async () => {
    const world = clock();
    const timers = new CancellableTimers(world.clock);

    const wait = timers.after(50);
    should(world.waiting.size).equal(1);
    world.fire();
    await wait.done;

    should(world.waiting.size).equal(0);
  });

  it('should give a wait up on cancel, leaving no timer running', () => {
    const world = clock();
    const timers = new CancellableTimers(world.clock);

    timers.after(50).cancel();

    should(world.waiting.size).equal(0);
  });

  it('should give every pending wait up at once when the daemon stops', () => {
    const world = clock();
    const timers = new CancellableTimers(world.clock);

    timers.after(10);
    timers.after(20);
    should(world.waiting.size).equal(2);
    timers.cancelAll();

    should(world.waiting.size).equal(0);
  });
});
