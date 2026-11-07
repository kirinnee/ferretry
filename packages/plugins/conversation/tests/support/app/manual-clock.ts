/**
 * A clock a suite moves by hand, in JavaScript: the page's timers, `Date.now` and `performance.now`.
 *
 * WHY NOT `jest.useFakeTimers()`. Bun 1.3's mocked clock starts at 0, but the timers Bun keeps for
 * itself — JavaScriptCore's garbage-collection timers, the runner's own test timeout — stay on the real
 * heap, stamped in REAL time since the machine booted, and that heap is drained against the MOCKED
 * clock. Once a suite has moved its clock past the machine's uptime, one of those timers is always due:
 * it fires, re-arms itself a moment after the real now, is due again, and the event loop spins on it
 * natively, running no JavaScript, until real time catches the mocked clock up. A laptop has been up for
 * days and never gets there. A CI runner booted a minute ago gets there within a simulated minute: the
 * idle-request-budget suite, which simulates ten and a half, sat in that spin for 566 of the ~600
 * seconds `Unit Tests (pwa)` took. This clock never touches Bun's timer heap, so there is nothing for
 * Bun to compare against it.
 *
 * WHAT IT COVERS is what the shell schedules with: `setTimeout`/`setInterval` and their clears, read off
 * `globalThis` when they are called (happy-dom's `window` IS `globalThis`), and the two clocks pollers
 * read. `new Date()` is left real — nothing a mounted idle page decides reads it — and so are
 * `setImmediate`, microtasks and anything Bun times natively, such as `AbortSignal.timeout`: real turns
 * of the event loop are what a sealed session's WebCrypto settles on.
 */

/** A manual clock while it is installed. */
export interface ManualClock {
  /** Moves the clock by `milliseconds`, running every timer that comes due on the way, in order. */
  readonly advance: (milliseconds: number) => void;
  /** Puts the real timers and clocks back, dropping every pending timer. */
  readonly restore: () => void;
}

interface Scheduled {
  readonly id: number;
  /** When it next runs, in this clock's milliseconds. */
  at: number;
  /** Its period, for an interval; `null` for a timeout. */
  readonly every: number | null;
  readonly run: () => void;
}

/** Bun schedules a zero or negative delay one millisecond out, as the HTML spec does; so does this. */
const delayOf = (delay: unknown): number => {
  const value = Math.floor(Number(delay));
  return Number.isFinite(value) && value > 1 ? value : 1;
};

/** Replaces the timers and clocks on `globalThis` until {@link ManualClock.restore}. */
export const installManualClock = (): ManualClock => {
  const real = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    dateNow: Date.now,
    performanceNow: Object.getOwnPropertyDescriptor(performance, 'now'),
  };
  const dateOrigin = real.dateNow();
  const performanceOrigin = performance.now();
  const scheduled = new Map<number, Scheduled>();
  let now = 0;
  let nextId = 1;

  const schedule = (callback: unknown, delay: unknown, args: unknown[], repeat: boolean): number => {
    if (typeof callback !== 'function') throw new TypeError('the manual clock only schedules functions');
    const id = nextId;
    nextId += 1;
    const wait = delayOf(delay);
    scheduled.set(id, { id, at: now + wait, every: repeat ? wait : null, run: () => callback(...args) });
    return id;
  };
  const clear = (id: unknown): void => {
    if (typeof id === 'number') scheduled.delete(id);
  };

  globalThis.setTimeout = ((callback: unknown, delay?: unknown, ...args: unknown[]) =>
    schedule(callback, delay, args, false)) as unknown as typeof setTimeout;
  globalThis.setInterval = ((callback: unknown, delay?: unknown, ...args: unknown[]) =>
    schedule(callback, delay, args, true)) as unknown as typeof setInterval;
  globalThis.clearTimeout = clear as typeof clearTimeout;
  globalThis.clearInterval = clear as typeof clearInterval;
  Date.now = () => dateOrigin + now;
  Object.defineProperty(performance, 'now', {
    configurable: true,
    writable: true,
    value: () => performanceOrigin + now,
  });

  /** The earliest timer due by `until`, the first scheduled among those due at the same moment. */
  const nextDue = (until: number): Scheduled | undefined => {
    let earliest: Scheduled | undefined;
    for (const timer of scheduled.values())
      if (timer.at <= until && (earliest === undefined || timer.at < earliest.at)) earliest = timer;
    return earliest;
  };

  return {
    advance: milliseconds => {
      const until = now + milliseconds;
      for (let due = nextDue(until); due !== undefined; due = nextDue(until)) {
        now = due.at;
        if (due.every === null) scheduled.delete(due.id);
        else due.at += due.every;
        due.run();
      }
      now = until;
    },
    restore: () => {
      scheduled.clear();
      globalThis.setTimeout = real.setTimeout;
      globalThis.clearTimeout = real.clearTimeout;
      globalThis.setInterval = real.setInterval;
      globalThis.clearInterval = real.clearInterval;
      Date.now = real.dateNow;
      if (real.performanceNow === undefined) delete (performance as { now?: unknown }).now;
      else Object.defineProperty(performance, 'now', real.performanceNow);
    },
  };
};
