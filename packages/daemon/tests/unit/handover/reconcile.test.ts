import { describe, it } from 'bun:test';
import should from 'should';
import {
  DEFAULT_HANDOVER_RECONCILE_INTERVAL_MS,
  type HandoverAdvancer,
  HandoverReconcileLoop,
  type HandoverRoster,
  type HandoverScheduler,
} from '../../../src/lib/handover/reconcile.ts';

class FakeRoster implements HandoverRoster {
  pending: readonly string[] = [];
  failure: string | null = null;

  async pendingSourceSessionIds(): Promise<readonly string[]> {
    if (this.failure !== null) throw new Error(this.failure);
    return this.pending;
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
  cancelled = 0;
  private tick: (() => void) | null = null;

  every(intervalMs: number, tick: () => void): () => void {
    this.armed.push(intervalMs);
    this.tick = tick;
    return () => {
      this.cancelled += 1;
    };
  }

  fire(): void {
    this.tick?.();
  }
}

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

  it('sweeps at boot, keeps sweeping on the timer, and hands back the disarm', async () => {
    const roster = new FakeRoster();
    const advancer = new FakeAdvancer();
    const scheduler = new FakeScheduler();
    roster.pending = ['a'];
    const loop = new HandoverReconcileLoop(advancer, roster, scheduler, 500);
    const disarm = loop.arm();
    should(scheduler.armed).deepEqual([500]);
    scheduler.fire();
    await loop.run();
    should(advancer.advanced.length).be.greaterThanOrEqual(2);
    disarm();
    should(scheduler.cancelled).equal(1);
  });

  it('swallows a background failure rather than taking the daemon down with it', async () => {
    const roster = new FakeRoster();
    const scheduler = new FakeScheduler();
    roster.failure = 'unreadable';
    const loop = new HandoverReconcileLoop(new FakeAdvancer(), roster, scheduler);
    loop.arm();
    scheduler.fire();
    should(scheduler.armed).deepEqual([DEFAULT_HANDOVER_RECONCILE_INTERVAL_MS]);
    roster.failure = null;
    should((await loop.run()).considered).equal(0);
  });
});
