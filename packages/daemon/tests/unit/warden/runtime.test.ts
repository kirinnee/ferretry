import { describe, it } from 'bun:test';
import should from 'should';
import { WardenSweepLoop, type WardenScheduler, type WardenSweepRunner } from '../../../src/lib/warden/index.ts';

/** A scheduler that never fires on its own: the test decides when a tick happens. */
class ManualScheduler implements WardenScheduler {
  intervals: number[] = [];
  cancels = 0;
  private tick: (() => void) | undefined;

  every(intervalMs: number, tick: () => void): () => void {
    this.intervals.push(intervalMs);
    this.tick = tick;
    return () => {
      this.cancels += 1;
    };
  }

  fire(): void {
    this.tick?.();
  }
}

/** A runner that records its calls and resolves when the test says so. */
class RecordingRunner implements WardenSweepRunner<string> {
  readonly calls: boolean[] = [];
  readonly order: string[] = [];
  private readonly gates: Array<() => void> = [];

  constructor(
    private readonly interval = 300_000,
    private readonly outcome: (call: number) => Promise<string> = async () => 'swept',
  ) {}

  async run(options: { readonly force: boolean }): Promise<string> {
    const call = this.calls.length;
    this.calls.push(options.force);
    this.order.push(`start:${call}`);
    const result = await this.outcome(call);
    this.order.push(`end:${call}`);
    return result;
  }

  async intervalMs(): Promise<number> {
    return this.interval;
  }

  release(): void {
    this.gates.pop()?.();
  }
}

/** Drain the microtask queue: the boot sweep and every tick are fired rather than
 *  awaited, so a test has to let the chain run before it can assert on it. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

describe('running a sweep through the loop', () => {
  it('should pass the force flag straight through', async () => {
    // Arrange
    const runner = new RecordingRunner();
    const loop = new WardenSweepLoop(runner, new ManualScheduler());

    // Act
    await loop.run(true);

    // Assert
    should(runner.calls).deepEqual([true]);
  });

  it('should answer with what the sweep returned', async () => {
    // Arrange
    const loop = new WardenSweepLoop(new RecordingRunner(), new ManualScheduler());

    // Act / Assert
    should(await loop.run(false)).equal('swept');
  });

  it('should never overlap two sweeps', async () => {
    // Arrange: the first sweep only finishes after the second has been asked for.
    let releaseFirst: (() => void) | undefined;
    const runner = new RecordingRunner(300_000, async call =>
      call === 0 ? await new Promise<string>(resolve => (releaseFirst = () => resolve('first'))) : 'second',
    );
    const loop = new WardenSweepLoop(runner, new ManualScheduler());

    // Act
    const first = loop.run(false);
    const second = loop.run(true);
    await settle();
    releaseFirst?.();
    await Promise.all([first, second]);

    // Assert: the second sweep did not start until the first had ended.
    should(runner.order).deepEqual(['start:0', 'end:0', 'start:1', 'end:1']);
  });

  it('should still run the next sweep after one failed', async () => {
    // Arrange: chaining only on success would wedge supervision permanently on the first throw.
    const runner = new RecordingRunner(300_000, async call => {
      if (call === 0) throw new Error('the fleet read failed');
      return 'recovered';
    });
    const loop = new WardenSweepLoop(runner, new ManualScheduler());

    // Act
    await loop.run(false).catch(() => undefined);

    // Assert
    should(await loop.run(false)).equal('recovered');
  });

  it('should deliver the failure to the caller who asked for the sweep', async () => {
    // Arrange
    const runner = new RecordingRunner(300_000, async () => {
      throw new Error('the fleet read failed');
    });
    const loop = new WardenSweepLoop(runner, new ManualScheduler());

    // Act / Assert
    await should(loop.run(true)).be.rejectedWith('the fleet read failed');
  });
});

describe('arming the sweep timer', () => {
  it('should schedule on the cadence the runner reports', async () => {
    // Arrange
    const scheduler = new ManualScheduler();
    const loop = new WardenSweepLoop(new RecordingRunner(90_000), scheduler);

    // Act
    await loop.arm();

    // Assert
    should(scheduler.intervals).deepEqual([90_000]);
  });

  it('should sweep once at boot so the status is not blank for a whole interval', async () => {
    // Arrange
    const runner = new RecordingRunner();
    const loop = new WardenSweepLoop(runner, new ManualScheduler());

    // Act
    await loop.arm();
    await settle();

    // Assert
    should(runner.calls).deepEqual([false]);
  });

  it('should sweep unforced on every tick', async () => {
    // Arrange
    const runner = new RecordingRunner();
    const scheduler = new ManualScheduler();
    const loop = new WardenSweepLoop(runner, scheduler);
    await loop.arm();
    await settle();

    // Act
    scheduler.fire();
    await settle();

    // Assert: a timer must never bypass the gates an operator's --spawn bypasses.
    should(runner.calls).deepEqual([false, false]);
  });

  it('should swallow a periodic failure rather than taking the daemon down', async () => {
    // Arrange
    const runner = new RecordingRunner(300_000, async () => {
      throw new Error('the fleet read failed');
    });
    const scheduler = new ManualScheduler();
    const loop = new WardenSweepLoop(runner, scheduler);

    // Act
    await loop.arm();
    scheduler.fire();
    await settle();

    // Assert
    should(runner.calls).have.length(2);
  });

  it('should return a disarm that cancels the timer', async () => {
    // Arrange
    const scheduler = new ManualScheduler();
    const loop = new WardenSweepLoop(new RecordingRunner(), scheduler);

    // Act
    (await loop.arm())();

    // Assert
    should(scheduler.cancels).equal(1);
  });
});
