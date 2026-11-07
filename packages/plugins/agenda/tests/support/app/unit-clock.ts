/**
 * A hand-cranked timer clock for a hook suite: `hold()` takes over `setTimeout`/`clearTimeout`, `advance(ms)` runs
 * every timer that falls due in order, and `release()` gives the real ones back.
 */

interface Pending {
  readonly id: number;
  readonly at: number;
  readonly run: () => void;
}

const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
let now = 0;
let next = 1;
let pending: Pending[] = [];
let held = false;

export const unitClock = {
  hold(): void {
    now = 0;
    pending = [];
    held = true;
    globalThis.setTimeout = ((run: () => void, ms = 0) => {
      const id = next++;
      pending.push({ id, at: now + Number(ms), run });
      return id;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      pending = pending.filter(timer => timer.id !== id);
    }) as unknown as typeof clearTimeout;
  },
  advance(ms: number): void {
    const until = now + ms;
    for (;;) {
      const due = pending.filter(timer => timer.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      pending = pending.filter(timer => timer !== due);
      now = due.at;
      due.run();
    }
    now = until;
  },
  release(): void {
    if (!held) return;
    held = false;
    pending = [];
    globalThis.setTimeout = real.setTimeout;
    globalThis.clearTimeout = real.clearTimeout;
  },
};
