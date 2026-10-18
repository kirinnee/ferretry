import type { LiveScheduler } from '../../src/hooks/use-live-counter.ts';
import { run } from './react.ts';

/** A clock a test moves by hand: `advance` fires every due timer in order, inside `act`. */
export const manualScheduler = (start: number): LiveScheduler & { advance: (ms: number) => void } => {
  let time = start;
  const pending: Array<{ at: number; action: () => void }> = [];
  return {
    now: () => time,
    after: (ms, action) => {
      const entry = { at: time + ms, action };
      pending.push(entry);
      return () => {
        const index = pending.indexOf(entry);
        if (index >= 0) pending.splice(index, 1);
      };
    },
    advance: ms => {
      const until = time + ms;
      run(() => {
        for (;;) {
          const due = pending.filter(entry => entry.at <= until).sort((a, b) => a.at - b.at)[0];
          if (due === undefined) break;
          pending.splice(pending.indexOf(due), 1);
          time = due.at;
          due.action();
        }
        time = until;
      });
    },
  };
};
