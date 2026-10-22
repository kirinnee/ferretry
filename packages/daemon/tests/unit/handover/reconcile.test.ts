import { describe, it } from 'bun:test';
import should from 'should';
import {
  DEFAULT_HANDOVER_RECONCILE_INTERVAL_MS,
  HANDOVER_RESCAN_INTERVAL_MS,
  type HandoverAdvancer,
  HandoverReconcileLoop,
  type HandoverScheduler,
  type RememberedHandoverRoster,
} from '../../../src/lib/handover/reconcile.ts';

class FakeRoster implements RememberedHandoverRoster {
  pending: readonly string[] = [];
  failure: string | null = null;
  forgotten = 0;
  private readonly listeners = new Set<() => void>();

  async pendingSourceSessionIds(): Promise<readonly string[]> {
    if (this.failure !== null) throw new Error(this.failure);
    return this.pending;
  }

  anyOpen(): boolean {
    return this.pending.length > 0;
  }

  onOpened(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  forget(): void {
    this.forgotten += 1;
  }

  open(id: string): void {
    this.pending = [...this.pending, id];
    for (const listener of this.listeners) listener();
  }
}

class FakeAdvancer implements HandoverAdvancer {
  readonly advanced: string[] = [];
  readonly failures = new Set<string>();
  gate: (() => Promise<void>) | null = null;

  async advance(sourceSessionId: string): Promise<unknown> {
    if (this.gate !== null) await this.gate();
    if (this.failures.has(sourceSessionId)) throw new Error(`${sourceSessionId} is wedged`);
    this.advanced.push(sourceSessionId);
    return undefined;
  }
}

class FakeScheduler implements HandoverScheduler {
  readonly armed: number[] = [];
  cancelled: number[] = [];
  private readonly ticks = new Map<number, () => void>();

  every(intervalMs: number, tick: () => void): () => void {
    this.armed.push(intervalMs);
    this.ticks.set(intervalMs, tick);
    return () => {
      this.cancelled.push(intervalMs);
      this.ticks.delete(intervalMs);
    };
  }

  /** Whether a timer of this interval is armed now. */
  live(intervalMs: number): boolean {
    return this.ticks.has(intervalMs);
  }

  fire(intervalMs: number): void {
    this.ticks.get(intervalMs)?.();
  }
}

/** Lets every queued pass and its follow-up run. */
const flush = async (): Promise<void> => {
  for (let round = 0; round < 20; round += 1) await Promise.resolve();
};

describe('the handover reconcile loop', () => {
  it('advances every pending source and reports the pass', async () => {
    const roster = new FakeRoster();
    const advancer = new FakeAdvancer();
    roster.pending = ['a', 'b'];
    const pass = await new HandoverReconcileLoop(advancer, roster, new FakeScheduler()).run();
    should(pass).deepEqual({ considered: 2, advanced: 2, failures: [] });
    should(advancer.advanced).deepEqual(['a', 'b']);
  });

  it('carries on past one wedged handover and names it', async () => {
    const roster = new FakeRoster();
    const advancer = new FakeAdvancer();
    roster.pending = ['a', 'b', 'c'];
    advancer.failures.add('b');
    const pass = await new HandoverReconcileLoop(advancer, roster, new FakeScheduler()).run();
    should(pass.advanced).equal(2);
    should(pass.failures).match([{ sessionId: 'b', reason: /wedged/u }]);
    should(advancer.advanced).deepEqual(['a', 'c']);
  });

  it('tells the caller when the roster itself could not be read', async () => {
    const roster = new FakeRoster();
    roster.failure = 'the sessions directory is unreadable';
    const loop = new HandoverReconcileLoop(new FakeAdvancer(), roster, new FakeScheduler());
    await should(loop.run()).be.rejectedWith(/unreadable/u);
    // The chain survives it: the next pass still happens.
    roster.failure = null;
    should((await loop.run()).considered).equal(0);
  });

  it('serializes overlapping passes rather than letting two read one document', async () => {
    const roster = new FakeRoster();
    const advancer = new FakeAdvancer();
    roster.pending = ['a'];
    let release = (): void => undefined;
    advancer.gate = async () => {
      await new Promise<void>(resolve => {
        release = resolve;
      });
    };
    const loop = new HandoverReconcileLoop(advancer, roster, new FakeScheduler());
    const first = loop.run();
    const second = loop.run();
    should(advancer.advanced).be.empty();
    advancer.gate = null;
    release();
    await first;
    await second;
    should(advancer.advanced).deepEqual(['a', 'a']);
  });

  it('sweeps at boot, ticks while a handover is open, and hands back the disarm', async () => {
    // Arrange
    const roster = new FakeRoster();
    const advancer = new FakeAdvancer();
    const scheduler = new FakeScheduler();
    roster.pending = ['a'];
    const loop = new HandoverReconcileLoop(advancer, roster, scheduler, 500, 9_000);

    // Act
    const disarm = loop.arm();
    await flush();
    scheduler.fire(500);
    await flush();

    // Assert — the boot sweep, then the tick it armed because a handover was open.
    should(scheduler.armed).deepEqual([9_000, 500]);
    should(advancer.advanced).deepEqual(['a', 'a']);
    disarm();
    should(scheduler.cancelled).deepEqual([9_000, 500]);
  });

  it('arms no tick while nothing is open, and drops it once the last handover finishes', async () => {
    // Arrange
    const roster = new FakeRoster();
    const scheduler = new FakeScheduler();
    const loop = new HandoverReconcileLoop(new FakeAdvancer(), roster, scheduler, 500, 9_000);
    loop.arm();
    await flush();
    should(scheduler.live(500)).be.false();

    // Act — a write opens one, then a pass finds it finished.
    roster.open('a');
    should(scheduler.live(500)).be.true();
    roster.pending = [];
    scheduler.fire(500);
    await flush();

    // Assert
    should(scheduler.live(500)).be.false();
  });

  it('reads every receipt again on the backstop', async () => {
    // Arrange
    const roster = new FakeRoster();
    const advancer = new FakeAdvancer();
    const scheduler = new FakeScheduler();
    const loop = new HandoverReconcileLoop(advancer, roster, scheduler);
    loop.arm();
    await flush();

    // Act — a receipt the daemon never wrote, found by the rescan.
    roster.pending = ['restored'];
    scheduler.fire(HANDOVER_RESCAN_INTERVAL_MS);
    await flush();

    // Assert
    should(roster.forgotten).equal(1);
    should(advancer.advanced).deepEqual(['restored']);
    should(scheduler.live(DEFAULT_HANDOVER_RECONCILE_INTERVAL_MS)).be.true();
  });

  it('hears nothing more once disarmed', async () => {
    // Arrange
    const roster = new FakeRoster();
    const scheduler = new FakeScheduler();
    const disarm = new HandoverReconcileLoop(new FakeAdvancer(), roster, scheduler).arm();
    await flush();

    // Act
    disarm();
    roster.open('late');
    await flush();

    // Assert
    should(scheduler.live(DEFAULT_HANDOVER_RECONCILE_INTERVAL_MS)).be.false();
  });

  it('swallows a background failure rather than taking the daemon down with it', async () => {
    const roster = new FakeRoster();
    const scheduler = new FakeScheduler();
    roster.failure = 'unreadable';
    const loop = new HandoverReconcileLoop(new FakeAdvancer(), roster, scheduler);
    loop.arm();
    await flush();
    scheduler.fire(HANDOVER_RESCAN_INTERVAL_MS);
    await flush();
    should(scheduler.armed).deepEqual([HANDOVER_RESCAN_INTERVAL_MS]);
    roster.failure = null;
    should((await loop.run()).considered).equal(0);
  });
});
