import type { ListRefreshEnvironment } from '../../src/client/list-refresh.ts';

const flushListReads = async (): Promise<void> => {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
};

/** One hand-driven clock for the API budget, feed, and safety poll. */
export const listClock = () => {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const schedule = (run: () => void, delay: number) => {
    const key = ++id;
    timers.set(key, { at: now + delay, run });
    return () => {
      timers.delete(key);
    };
  };
  const environment: ListRefreshEnvironment = { now: () => now, schedule };
  return {
    environment,
    pending: () => timers.size,
    setTimeout: (run: () => void, delay: number) => schedule(run, delay),
    clearTimeout: (cancel: unknown) => (cancel as () => void)(),
    advance: async (ms: number) => {
      const until = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
        await flushListReads();
      }
      now = until;
      await flushListReads();
    },
  };
};

export const listDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
