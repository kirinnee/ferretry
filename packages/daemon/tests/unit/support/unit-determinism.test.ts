import { describe, expect, it } from 'bun:test';
import { UNIT_CLOCK_ORIGIN, unitClock } from '../../support/unit-clock.ts';
import { UnitDeterminismError } from '../../support/unit-determinism.ts';

/** The page's animation frames, which this package's TypeScript library (no DOM) does not name. */
const { requestAnimationFrame } = globalThis as unknown as {
  readonly requestAnimationFrame: (callback: (time: number) => void) => number;
};

/** Set by a timer one test leaves for the next. */
let leftoverFiredAt: number | undefined;

/** A real turn the clock does not count as work in hand, so it may advance while this waits. */
const idle = async (turns = 10) => {
  for (let turn = 0; turn < turns; turn += 1) await unitClock.turn();
};

describe('the unit tier clock', () => {
  it('should start every test at the same instant, in UTC', () => {
    expect(Date.now()).toBe(UNIT_CLOCK_ORIGIN);
    expect(new Date().toISOString()).toBe('2026-10-30T12:00:00.000Z');
    expect(new Date(0).toISOString()).toBe('1970-01-01T00:00:00.000Z');
    expect(new Date().getTimezoneOffset()).toBe(0);
    expect(unitClock.elapsed).toBe(0);
  });

  it('should start the next test at that instant again', () => {
    setTimeout(() => {
      leftoverFiredAt = unitClock.elapsed;
    }, 1_000);
    unitClock.hold();
    unitClock.advance(400);
    expect(unitClock.elapsed).toBe(400);
  });

  it('should keep a timer an earlier test left, due as far ahead of the new start as it was', () => {
    expect(unitClock.elapsed).toBe(0);
    expect(Date.now()).toBe(UNIT_CLOCK_ORIGIN);
    unitClock.hold();
    unitClock.advance(599);
    expect(leftoverFiredAt).toBeUndefined();
    unitClock.advance(1);
    expect(leftoverFiredAt).toBe(600);
  });

  it('should read every clock off the one virtual time', () => {
    const performanceAtStart = performance.now();
    const hrtimeAtStart = process.hrtime.bigint();
    unitClock.advance(250);
    expect(Date.now() - UNIT_CLOCK_ORIGIN).toBe(250);
    expect(performance.now() - performanceAtStart).toBe(250);
    expect(process.hrtime.bigint() - hrtimeAtStart).toBe(250_000_000n);
  });

  it('should finish a long sleep at once, having moved exactly as far as it slept', async () => {
    await new Promise(resolve => setTimeout(resolve, 5_000));
    await Bun.sleep(1_000);
    expect(unitClock.elapsed).toBe(6_000);
  });

  it('should run timers in the order they are due, and those due together in the order they were set', async () => {
    const seen: string[] = [];
    const interval = setInterval(() => seen.push(`tick@${unitClock.elapsed}`), 100);
    setTimeout(() => seen.push('a@250'), 250);
    setTimeout(() => seen.push('b@250'), 250);
    await new Promise(resolve => setTimeout(resolve, 300));
    clearInterval(interval);
    expect(seen).toEqual(['tick@100', 'tick@200', 'a@250', 'b@250', 'tick@300']);
  });

  it('should never let a deadline beat off-thread work still in flight', async () => {
    let expired = false;
    const deadline = setTimeout(() => {
      expired = true;
    }, 1);
    await crypto.subtle.digest('SHA-256', new Uint8Array(1 << 20));
    clearTimeout(deadline);
    expect(expired).toBe(false);
  });

  it('should abort an AbortSignal.timeout in virtual time', async () => {
    const signal = AbortSignal.timeout(30_000);
    expect(signal.aborted).toBe(false);
    await idle();
    expect(signal.aborted).toBe(true);
    expect((signal.reason as DOMException).name).toBe('TimeoutError');
    // 30,001 once happy-dom is loaded: its own AbortSignal (on this clock too) dispatches the abort a tick later.
    expect(unitClock.elapsed).toBeGreaterThanOrEqual(30_000);
    expect(unitClock.elapsed).toBeLessThanOrEqual(30_001);
  });

  it('should move only when told while held', async () => {
    unitClock.hold();
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 100);
    await idle(5);
    expect(fired).toBe(false);
    unitClock.advance(99);
    expect(fired).toBe(false);
    unitClock.advance(1);
    expect(fired).toBe(true);
    expect(unitClock.next()).toBe(false);
  });

  it('should refuse to move backwards', () => {
    expect(() => unitClock.advance(-1)).toThrow(RangeError);
  });

  it('should keep a zero delay a real task boundary', async () => {
    let ran = false;
    setTimeout(() => {
      ran = true;
    }, 0);
    expect(ran).toBe(false);
    await unitClock.turn();
    await unitClock.turn();
    expect(ran).toBe(true);
    expect(unitClock.elapsed).toBe(0);
  });

  it('should hand a timer handle Node and the browser both accept', () => {
    const handle = setTimeout(() => {}, 10);
    expect(typeof handle.unref).toBe('function');
    expect(handle.hasRef()).toBe(true);
    expect(Number(handle)).toBeGreaterThan(0);
    clearTimeout(Number(handle));
    expect(unitClock.pending).toBe(0);
  });

  it('should run on real time only for a test that asks, with a reason', () => {
    expect(() => unitClock.useRealTime(' ')).toThrow('needs a reason');
    unitClock.useRealTime('this test proves the escape hatch itself');
    expect(unitClock.mode).toBe('real');
    const before = Date.now();
    expect(Date.now()).not.toBe(UNIT_CLOCK_ORIGIN);
    expect(Date.now()).toBeGreaterThanOrEqual(before);
  });

  it('should be back on virtual time for the test after one that used real time', () => {
    expect(unitClock.mode).toBe('auto');
    expect(Date.now()).toBe(UNIT_CLOCK_ORIGIN);
  });
});

describe('the unit tier refusals', () => {
  const refusal = (run: () => unknown): UnitDeterminismError => {
    try {
      run();
    } catch (error) {
      if (error instanceof UnitDeterminismError) return error;
      throw error;
    }
    throw new Error('expected a refusal');
  };

  it('should refuse a real program and say what to inject instead', () => {
    const error = refusal(() => Bun.spawnSync(['true']));
    expect(error.rule).toBe('process');
    expect(error.message).toContain('Bun.spawnSync()');
    expect(error.message).toContain('unit-determinism.test.ts');
    expect(error.message).toContain('inject the spawn port');
  });

  it('should refuse a real socket', () => {
    expect(refusal(() => require('node:net').connect(9, '127.0.0.1')).rule).toBe('socket');
    expect(refusal(() => Bun.serve({ port: 0, fetch: () => new Response() })).rule).toBe('socket');
  });

  it('should animate in frames of virtual time', async () => {
    const frames: number[] = [];
    const draw = (at: number) => {
      frames.push(at);
      if (frames.length < 3) requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(frames.map(at => at - frames[0]!)).toEqual([0, 16, 32]);
    expect(frames[0]).toBe(1_000);
  });

  it('should let a data: URL through, since it never leaves the process', async () => {
    expect(await (await fetch('data:text/plain,hello')).text()).toBe('hello');
  });

  it('should refuse a synchronous full collection, but not an asynchronous one', () => {
    expect(refusal(() => Bun.gc(true)).rule).toBe('gc');
    expect(() => Bun.gc(false)).not.toThrow();
  });

  it('should refuse a synchronous sleep, which no virtual clock can wait on', () => {
    expect(refusal(() => Bun.sleepSync(1)).rule).toBe('timer');
  });
});
