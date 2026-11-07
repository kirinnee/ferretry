/**
 * THE CLOCK OF A LIVE READOUT — a tick on the turn's own seconds, and a number that counts up to each new reading
 * instead of jumping to it. Pure and total; the hooks (`use-live-counter.ts`) drive them.
 *
 * WHY ALIGN THE TICK. A one-second interval started at mount is out of phase with the turn: a turn
 * that began 0.9s before the page opened would print each new second 0.9s late, and a store update
 * landing in between would print it early — the "jumps in chunks" the reader saw. Scheduling each tick
 * for the instant the elapsed time crosses its next whole second keeps every label exactly on time.
 */

/** Milliseconds from `now` until the time since `start` next crosses a whole second (1–1000). */
export const msToNextSecond = (start: number, now: number): number => {
  const elapsed = now - start;
  if (elapsed < 0) return Math.min(1000, -elapsed);
  return 1000 - (elapsed % 1000);
};

/** Whole seconds since `start`, never negative — a clock skewed ahead of the daemon reads `0s`. */
export const wholeSecondsSince = (start: number, now: number): number => Math.max(0, Math.floor((now - start) / 1000));

/** How long one count-up takes: long enough to read as motion, short enough to finish before a 4 Hz update. */
export const COUNT_UP_MS = 240;

/** Ease-out: fast at first, settling onto the reading. */
const easeOut = (progress: number): number => 1 - (1 - progress) ** 3;

/**
 * The number to show `elapsed` ms into a count-up from `from` to `to`.
 *
 * NEVER BACKWARDS. A reading lower than what is already shown is not animated down: within one turn a
 * token count only grows, so a lower report is a stale or partial one and the shown value holds.
 * Whole numbers only — a token count has no fractions to flicker through.
 */
export const countUpValue = (from: number, to: number, elapsed: number, duration: number = COUNT_UP_MS): number => {
  if (to <= from) return from;
  if (duration <= 0 || elapsed >= duration) return to;
  const progress = Math.max(0, elapsed) / duration;
  return Math.min(to, Math.max(from, Math.round(from + (to - from) * easeOut(progress))));
};
