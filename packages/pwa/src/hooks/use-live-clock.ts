import { useEffect, useState } from 'react';

/**
 * A wall-clock timestamp that advances about once a second, for the transcript's
 * live labels (a running tool's elapsed time, the thinking indicator).
 *
 * THE CALLER CONTRACT MATTERS MORE THAN THE TICK: render a pure function of the
 * value this returns, and never call `Date.now()` inside render. kteam's
 * `useLiveTick.ts` learned it the hard way — the store coalesces stream events
 * at ~4/second, so a label that reads the clock itself mutates on every one of
 * those re-renders no matter how the tick behaves. A pure function of a stable
 * value produces byte-identical output, and React then writes nothing.
 *
 * That contract is also what makes the missing half cheap to add: kteam FREEZES
 * this value while the reader holds a text selection, because on WebKit a React
 * text write inside the selected element collapses the selection. The hold gate
 * (pointer + selection + a 20s cap) is a subsystem of its own and is NOT ported
 * yet; when it lands, it replaces the `hold` default below and every caller
 * already renders from the frozen value.
 */
export interface LiveClockOptions {
  /** Injectable so a test can drive the value instead of waiting on the wall. */
  readonly now?: () => number;
  readonly intervalMs?: number;
  /** While true the value stops advancing. Reserved for the transcript hold
   *  gate; callers do not pass it yet. */
  readonly hold?: boolean;
}

/** One second: fast enough that an elapsed counter looks live, slow enough that
 *  it is not a render budget. */
const TICK_MS = 1000;

export const useLiveClock = ({ now = Date.now, intervalMs = TICK_MS, hold = false }: LiveClockOptions = {}): number => {
  const [timestamp, setTimestamp] = useState(now);

  useEffect(() => {
    if (hold) return undefined;
    // Catch up immediately on release, then keep ticking. The effect is
    // re-created when the hold flips, so no interval fires while frozen.
    setTimestamp(now());
    const timer = setInterval(() => setTimestamp(now()), intervalMs);
    return () => clearInterval(timer);
  }, [hold, intervalMs, now]);

  return timestamp;
};
