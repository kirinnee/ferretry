import type { ShellClock } from '../../../app/ui.ts';

/** A clock that reads `now` and runs `after`/`every` on the real timers of the test process. */
export const clockAt = (now: number): ShellClock => ({
  now: () => now,
  after: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
  every: (ms, run) => {
    const timer = setInterval(run, ms);
    return () => clearInterval(timer);
  },
});

export interface SteeredClock extends ShellClock {
  /** Move time forward, running what falls due in order. */
  advance(ms: number): void;
}

/** A clock the test steers: nothing runs until `advance`. */
export function steeredClock(start = 0): SteeredClock {
  let now = start;
  let next = 0;
  const due = new Map<number, { at: number; every?: number; run: () => void }>();
  const schedule = (ms: number, run: () => void, every?: number): (() => void) => {
    const id = next++;
    due.set(id, { at: now + ms, ...(every === undefined ? {} : { every }), run });
    return () => {
      due.delete(id);
    };
  };
  return {
    now: () => now,
    after: (ms, run) => schedule(ms, run),
    every: (ms, run) => schedule(ms, run, ms),
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const soonest = [...due.entries()].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (soonest === undefined) break;
        const [id, job] = soonest;
        now = job.at;
        if (job.every === undefined) due.delete(id);
        else job.at += job.every;
        job.run();
      }
      now = target;
    },
  };
}
