/** Timers and visibility the test moves by hand, in place of the page's: `advance` fires every timer due, in order. */

import type { FeedAwarePollEnvironment } from '@ferretry/app';

export const handPoll = () => {
  let time = 0;
  let hidden = false;
  let next = 0;
  const timers: { id: number; at: number; callback: () => void }[] = [];
  const visible = new Set<() => void>();
  const environment: FeedAwarePollEnvironment = {
    setTimeout: (callback, milliseconds) => {
      next += 1;
      timers.push({ id: next, at: time + milliseconds, callback });
      return next;
    },
    clearTimeout: handle => {
      const index = timers.findIndex(timer => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    hidden: () => hidden,
    onVisible: listener => {
      visible.add(listener);
      return () => visible.delete(listener);
    },
  };
  return {
    environment,
    /** The delays of the timers still waiting. */
    pending: () => timers.map(timer => timer.at - time).sort((left, right) => left - right),
    advance: (milliseconds: number) => {
      const until = time + milliseconds;
      for (;;) {
        const due = timers.filter(timer => timer.at <= until).sort((left, right) => left.at - right.at)[0];
        if (due === undefined) break;
        timers.splice(timers.indexOf(due), 1);
        time = due.at;
        due.callback();
      }
      time = until;
    },
    hide: () => {
      hidden = true;
    },
    show: () => {
      hidden = false;
      for (const listener of [...visible]) listener();
    },
  };
};
