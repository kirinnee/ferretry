/**
 * Every multi-machine read bounds each machine on its own, so one that never answers fails its own read
 * instead of holding every other machine's.
 */
import { describe, expect, it } from 'bun:test';
import {
  boundedReads,
  type DeadlineSchedule,
  MachineDeadlineError,
  untilAborted,
  withDeadline,
} from '../../../src/lib/machine-deadline.ts';

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

describe('boundedReads', () => {
  const seen: RequestInit[] = [];
  const send = async (_input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    seen.push(init);
    return new Response('ok');
  };
  const marker = new AbortController().signal;
  const timeout = (): AbortSignal => marker;

  it('gives a plain GET or HEAD with no signal the deadline signal', async () => {
    seen.length = 0;
    const read = boundedReads(send, 20_000, timeout);
    await read('https://m.invalid/v1/projects');
    await read('https://m.invalid/v1/usage', { method: 'head' });
    expect(seen.map(init => init.signal)).toEqual([marker, marker]);
  });

  it('leaves writes, a caller’s own signal and a Request alone', async () => {
    seen.length = 0;
    const own = new AbortController().signal;
    const read = boundedReads(send, 20_000, timeout);
    await read('https://m.invalid/v1/attention/x', { method: 'POST', body: '{}' });
    await read('https://m.invalid/v1/projects', { signal: own });
    await read(new Request('https://m.invalid/v1/projects'));
    expect(seen.map(init => init.signal ?? null)).toEqual([null, own, null]);
  });

  it('really aborts a read that outlives the deadline', async () => {
    const hanging = async (_input: string | URL | Request, init: RequestInit = {}): Promise<Response> =>
      await new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
      );
    const failure = await boundedReads(hanging, 5)('https://m.invalid/v1/projects').catch((cause: unknown) => cause);
    expect((failure as DOMException).name).toBe('TimeoutError');
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
