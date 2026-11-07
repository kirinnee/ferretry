/**
 * Every multi-machine read bounds each machine on its own, so one that never answers fails its own read
 * instead of holding every other machine's.
 */
import { describe, expect, it } from 'bun:test';
import {
  type DeadlineSchedule,
  MachineDeadlineError,
  untilAborted,
  withDeadline,
} from '../../../src/client/machine-deadline.ts';

/** A clock a test fires by hand. */
const manualClock = () => {
  const timers = new Set<{ run: () => void; delayMs: number }>();
  const schedule: DeadlineSchedule = (run, delayMs) => {
    const timer = { run, delayMs };
    timers.add(timer);
    return () => timers.delete(timer);
  };
  const fire = (): void => {
    for (const timer of [...timers]) {
      timers.delete(timer);
      timer.run();
    }
  };
  return { schedule, fire, pending: () => timers.size };
};

const never = <T>(): Promise<T> => new Promise<T>(() => {});

describe('withDeadline', () => {
  it('passes an answer through and cancels its timer', async () => {
    const clock = manualClock();
    expect(await withDeadline(Promise.resolve('ok'), 10, clock.schedule)).toBe('ok');
    expect(clock.pending()).toBe(0);
  });

  it('passes a failure through untouched', async () => {
    const clock = manualClock();
    await expect(withDeadline(Promise.reject(new Error('refused')), 10, clock.schedule)).rejects.toThrow('refused');
    expect(clock.pending()).toBe(0);
  });

  it('gives up on a read that never answers, with a sentence a status line can show', async () => {
    const clock = manualClock();
    const waiting = withDeadline(never<string>(), 20_000, clock.schedule);
    clock.fire();
    const failure = await waiting.catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(MachineDeadlineError);
    expect((failure as Error).message).toBe('did not answer within 20s');
  });
});

describe('untilAborted', () => {
  it('is the wait itself with no signal, and the fallback for a signal already aborted', async () => {
    expect(await untilAborted(Promise.resolve(true), undefined, false)).toBe(true);
    const aborted = new AbortController();
    aborted.abort();
    expect(await untilAborted(never<boolean>(), aborted.signal, false)).toBe(false);
  });

  it('answers the fallback when the caller stops waiting on a wait that never ends', async () => {
    const caller = new AbortController();
    const waiting = untilAborted(never<boolean>(), caller.signal, false);
    caller.abort();
    expect(await waiting).toBe(false);
  });

  it('passes the wait’s answer and its failure through while the caller is still waiting', async () => {
    expect(await untilAborted(Promise.resolve(true), new AbortController().signal, false)).toBe(true);
    await expect(
      untilAborted(Promise.reject(new Error('ceremony failed')), new AbortController().signal, false),
    ).rejects.toThrow('ceremony failed');
  });
});
