import type { Duration, Instant } from '@ferretry/std';
import { epochMs, instantFromEpochMs } from '@ferretry/std';
import type { Cancel, Clock } from '../contract/ports.ts';

/** A clock the test drives: time moves only on `advance`, and timers due by then run in order. */
export interface DrivenClock extends Clock {
  advance(by: Duration | number): Promise<void>;
  /** Timers still waiting. */
  pending(): number;
}

interface Timer {
  readonly id: number;
  due: number;
  readonly every?: number;
  readonly fn: () => void;
}

/** `fixedClock('2026-11-06T09:00:00Z')`: starts there and never moves by itself. */
export function fixedClock(start: string | Instant = '2026-11-06T09:00:00.000Z'): DrivenClock {
  let now = epochMs(start as Instant);
  if (!Number.isFinite(now)) now = Date.parse(start);
  let next = 1;
  const timers = new Map<number, Timer>();
  const schedule = (delay: number, fn: () => void, every?: number): Cancel => {
    const id = next++;
    timers.set(id, { id, due: now + Math.max(0, delay), ...(every === undefined ? {} : { every }), fn });
    return () => {
      timers.delete(id);
    };
  };
  const clock: DrivenClock = {
    now: () => instantFromEpochMs(now),
    nowMs: () => now,
    after: (delay, fn) => schedule(delay, fn),
    every: (interval, fn) => schedule(interval, fn, Math.max(1, interval)),
    sleep: (delay, signal) =>
      new Promise<void>((resolve, reject) => {
        const cancel = schedule(delay, resolve);
        signal?.addEventListener('abort', () => {
          cancel();
          reject(signal.reason);
        });
      }),
    async advance(by) {
      const until = now + by;
      for (;;) {
        const due = [...timers.values()].filter(t => t.due <= until).sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (due === undefined) break;
        now = Math.max(now, due.due);
        if (due.every === undefined) timers.delete(due.id);
        else due.due += due.every;
        due.fn();
        await Promise.resolve();
      }
      now = until;
      await Promise.resolve();
    },
    pending: () => timers.size,
  };
  return clock;
}

